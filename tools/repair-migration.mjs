/**
 * 修复被 v4 会话格式拒绝、导致「会话打不开」的历史日志（v0–v3）。
 *
 * DSH 0.1.7 起会话格式为 v4，旧日志在加载时先跑 v0→…→v4 迁移，迁移器会在两处拒绝
 * 上下文编辑插件历史版本留下的日志：
 *
 *   1. turn 外的表面事件
 *      表面事件必须落在**开放的 turn/step** 内：
 *        - system/message、developer/message、assistant/attempt、assistant/message、tool/call
 *          必须匹配开放 turn + step
 *        - 追加（append）的 tool/result 匹配开放 step；替换（replace）的 tool/result 只要求开放 turn
 *      插件在「上一次 turn 已经 turn/end」之后继续追加编辑事件（借用原节点的 turn/step 坐标），
 *      v3 不检查这一点，v4 迁移直接拒绝：
 *        Session migration from v3 to v4 refuses the transformed artifact:
 *        system/message does not match an open turn and step
 *      修法：把这类事件降级为**不透明可忽略事件** `{ type: 'manual-context-orphan', ignorable: true }`，
 *      迁移会把它命名成 `plugin:manual-context-orphan` 并保留载荷与坐标，从而不再参与关系校验。
 *      事件序号与日志帧结构完全不变（无需重编号），代价是这次编辑不再生效（节点回到编辑前的表面状态）。
 *
 *   2. 事件类型与消息角色不匹配
 *      老版本插件曾用 `user/message` 承载 role 为 assistant 的消息，v4 存储校验要求
 *      user/message 的消息 role 必须是 user：
 *        session event at seq N message must have role "user"
 *      修法：把这些节点换成**空内容的合法消息**（表面位置不变、不投影任何内容），
 *      与插件现在的「空 system/user 消息遮蔽」做法一致。
 *
 * 用法：
 *   node tools/repair-migration.mjs              # 只扫描（dry-run，不写盘）
 *   node tools/repair-migration.mjs --apply      # 落盘修复，并留下 .corrupt-bak 备份
 *   node tools/repair-migration.mjs --apply <sessions 根目录或单个 .jsonl.zstd 文件>
 *   node tools/repair-migration.mjs --debug      # 打印每一轮修复细节
 *
 * 落盘前先备份为 `<文件>.corrupt-bak`（已存在则不覆盖）；写盘后立刻重新读取校验，
 * 失败会从备份还原。DSH 包位置可用 DSH_MODULES 指定。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ORPHAN_TYPE = 'manual-context-orphan'
const PLUGIN_ID = '@dsh-external/manual-context'
const ACTIVE_WINDOW_MS = 45 * 1000
const MAX_ROUNDS = 40

/** 需要「开放 turn + step」的表面事件类型。 */
const NEEDS_TURN_AND_STEP = new Set([
  'system/message',
  'developer/message',
  'assistant/attempt',
  'assistant/message',
  'tool/call',
])

/** 事件类型要求的消息角色（data 就是消息本体的类型）。 */
const ROLE_BY_TYPE = {
  'user/message': 'user',
  'system/message': 'system',
}

function sessionsRoot() {
  const arg = process.argv.slice(2).find(function (value) {
    return !value.startsWith('-')
  })
  if (typeof arg === 'string' && arg !== '') return path.resolve(arg)
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return path.join(home, 'sessions')
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/** DSH 自己的包可能不在 profile 的 node_modules 下，所以挨个常见位置找。 */
function candidateModuleRoots() {
  const out = []
  const explicit = process.env.DSH_MODULES
  if (typeof explicit === 'string' && explicit !== '') out.push(explicit)
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    let names = []
    try {
      names = fs.readdirSync(path.join(home, 'profiles'))
    } catch {
      names = []
    }
    for (const name of names) out.push(path.join(home, 'profiles', name, 'node_modules'))
  }
  const caches = []
  const npmCache = process.env.npm_config_cache
  if (typeof npmCache === 'string' && npmCache !== '') caches.push(npmCache)
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData !== '') caches.push(path.join(localAppData, 'npm-cache'))
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') caches.push(path.join(appData, 'npm-cache'))
  for (const drive of ['H:', 'C:', 'D:', 'E:', 'F:']) {
    for (const name of ['npm-cache', 'npm', 'node_cache', 'npx-cache', '.npm']) {
      caches.push(drive + '\\' + name)
    }
  }
  for (const cache of caches) {
    let entries = []
    try {
      entries = fs.readdirSync(path.join(cache, '_npx'))
    } catch {
      continue
    }
    for (const entry of entries) out.push(path.join(cache, '_npx', entry, 'node_modules'))
  }
  out.push(path.join(path.dirname(process.execPath), 'node_modules'))
  for (const drive of ['H:', 'C:', 'D:']) {
    out.push(drive + '\\npm-global\\node_modules\\@deepseek-ai\\dsh\\node_modules')
    out.push(drive + '\\npm-global\\node_modules')
    out.push(drive + '\\node_modules')
  }
  return out
}

function findModule(relative) {
  for (const base of candidateModuleRoots()) {
    const file = path.join(base, ...relative.split('/'))
    if (fs.existsSync(file)) return file
  }
  return null
}

const catalogPath = findModule('@deepseek-ai/dsh-session-format-catalog/lib/index.js')
const persistencePath = findModule('@deepseek-ai/dsh-session-persistence/lib/index.js')
if (catalogPath === null || persistencePath === null) {
  console.error('找不到 DSH 的会话格式包，请用 DSH_MODULES 指定 node_modules 目录（例如 H:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\node_modules）')
  process.exit(2)
}
const asUrl = function (file) {
  return 'file://' + file.replace(/\\/g, '/')
}
const catalogModule = await import(asUrl(catalogPath))
const persistenceModule = await import(asUrl(persistencePath))
const withChildren = catalogModule.createSessionFormatCatalogWithChildren
const validateStoredEvents = persistenceModule.validateStoredEvents

/** 按 zstd 魔数切帧并逐帧解压；保留帧边界，落盘时只重写内容变化的帧。 */
function splitFrames(buffer) {
  const positions = []
  let at = buffer.indexOf(MAGIC)
  while (at >= 0) {
    positions.push(at)
    at = buffer.indexOf(MAGIC, at + 4)
  }
  positions.push(buffer.length)
  return positions
}

function readFrames(file) {
  const buffer = fs.readFileSync(file)
  const positions = splitFrames(buffer)
  const frames = []
  for (let i = 0; i < positions.length - 1; i += 1) {
    const raw = buffer.subarray(positions[i], positions[i + 1])
    let text = null
    try {
      text = zlib.zstdDecompressSync(raw).toString('utf8')
    } catch {
      text = null
    }
    frames.push({ raw, text })
  }
  return frames
}

function writeFrames(file, frames) {
  const parts = frames.map(function (frame) {
    if (frame.text === null) return frame.raw
    return frame.changed === true ? zlib.zstdCompressSync(Buffer.from(frame.text, 'utf8')) : frame.raw
  })
  fs.writeFileSync(file, Buffer.concat(parts))
}

/** 把帧里的行摊平成带归属的条目，改完能原样落回各自的帧。 */
function flatten(frames) {
  const entries = []
  for (const frame of frames) {
    if (frame.text === null) continue
    const parts = frame.text.split('\n')
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    for (const line of parts) entries.push({ frame, line })
  }
  return entries
}

function commit(frames, entries) {
  for (const frame of frames) {
    const own = entries.filter(function (entry) {
      return entry.frame === frame
    }).map(function (entry) {
      return entry.line
    })
    if (own.length === 0) continue
    const next = own.join('\n') + '\n'
    if (next !== frame.text) {
      frame.text = next
      frame.changed = true
    }
  }
}

/** 第一帧必须恰好一行 header。 */
function checkFrameLayout(file) {
  const buffer = fs.readFileSync(file)
  const positions = splitFrames(buffer)
  if (positions.length < 2) throw new Error('文件里没有 zstd 帧')
  const first = zlib.zstdDecompressSync(buffer.subarray(positions[0], positions[1]))
  const onlyOneLine = first.length > 0 && first[first.length - 1] === 10 && first.indexOf(10) === first.length - 1
  if (!onlyOneLine) throw new Error('第一帧不是恰好一行 header')
}

/** 当前条目对应的行列表（条目是唯一事实来源，每次都要重新取）。 */
function lineList(entries) {
  return entries.map(function (entry) {
    return entry.line
  })
}

/**
 * 完整校验：v3→v4 迁移（含表面折叠与关系检查）+ 存储形状校验。
 * DSH 真实加载路径使用 recovery: 'recoverable'、validation: 'transformed'，之后还会跑 validateStoredEvents。
 */
function verify(lines, id) {
  try {
    const header = JSON.parse(lines[0])
    const restore = withChildren([]).createRestore(header, { recovery: 'recoverable', validation: 'transformed' })
    for (let i = 1; i < lines.length; i += 1) restore.decodeRow(JSON.parse(lines[i]))
    const artifact = restore.finish()
    validateStoredEvents({ id, version: artifact.header.version, kind: 'jsonl', path: '' }, (artifact.events ?? []).slice(), id)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error.message) }
  }
}

/** 逐事件模拟 v4 的 turn/step 状态机，返回每个序号对应的开放坐标。 */
function openStates(lines) {
  const states = []
  let turn = null
  let step = null
  for (let i = 0; i < lines.length; i += 1) {
    let event = null
    try {
      event = JSON.parse(lines[i])
    } catch {
      event = null
    }
    if (event !== null && i > 0) {
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      if (event.type === 'turn/start') {
        turn = Number.isSafeInteger(data.turn) ? data.turn : null
        step = null
      } else if (event.type === 'turn/end') {
        turn = null
        step = null
      } else if (event.type === 'step/start') {
        step = Number.isSafeInteger(data.step) ? data.step : null
      } else if (event.type === 'step/end') {
        step = null
      }
    }
    states.push({ turn, step })
  }
  return states
}

/** 这个事件是否违反了「开放 turn/step」要求。 */
function violatesTurnStep(event, state) {
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  if (event.type === 'tool/result') {
    // 替换形式的 tool/result 只要求「有开放 turn」，不复核对原始调用生命周期，也不比对坐标。
    if (event.surfaceOp !== 'append') return state.turn === null
    return state.turn === null || state.step === null || data.turn !== state.turn || data.step !== state.step
  }
  if (!NEEDS_TURN_AND_STEP.has(event.type)) return false
  return state.turn === null || state.step === null || data.turn !== state.turn || data.step !== state.step
}

/**
 * 一轮 turn/step 修复：把**所有**违反开放 turn/step 的表面事件降级为不透明可忽略事件。
 * 必须一次降级全部（只降级报错里那一种类型会改变表面折叠结果，反而让
 * compaction/summary 的 shadowedSeqs 对不上当前表面）。
 */
function repairTurnStep(entries) {
  const states = openStates(lineList(entries))
  const changedSeqs = []
  for (let i = 1; i < entries.length; i += 1) {
    let event
    try {
      event = JSON.parse(entries[i].line)
    } catch {
      continue
    }
    if (!violatesTurnStep(event, states[i])) continue
    entries[i].line = JSON.stringify(Object.assign({}, event, { type: ORPHAN_TYPE, ignorable: true }))
    changedSeqs.push(event.seq)
  }
  return changedSeqs
}

/**
 * 一轮消息角色修复：把类型与消息角色不匹配的事件**就地改正 role 字段**。
 *
 * 老版本插件曾用 user/message 承载 role 为 assistant 的消息（内容确实是模型输出）。
 * v3 时代事件类型才是决定投影角色的字段，这些节点当年就是按「用户消息」呈现的，
 * 所以把 role 改成 user 是当年显示与模型上下文的最小改动，内容一字不丢。
 * 只改这一个字段，surface 拓扑、坐标与其它字段完全不变。
 */
function repairMessageRoles(entries) {
  const changedSeqs = []
  for (let i = 1; i < entries.length; i += 1) {
    let event
    try {
      event = JSON.parse(entries[i].line)
    } catch {
      continue
    }
    const expected = ROLE_BY_TYPE[event.type]
    if (expected === undefined) continue
    const data = event.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    if (event.type === 'user/message') {
      if (data.role === expected) continue
      entries[i].line = JSON.stringify(Object.assign({}, event, { data: Object.assign({}, data, { role: expected }) }))
      changedSeqs.push(event.seq)
      continue
    }
    // system/message 的 data 是 { turn, step, message }，坐标必须保留，只改正 message.role。
    const message = data.message
    if (message === null || typeof message !== 'object' || message.role === expected) continue
    entries[i].line = JSON.stringify(Object.assign({}, event, {
      data: Object.assign({}, data, { message: Object.assign({}, message, { role: expected }) }),
    }))
    changedSeqs.push(event.seq)
  }
  return changedSeqs
}

/** 反复修复，直到完整校验通过（或遇到不认识的损坏类型）。 */
function repairSession(entries, id) {
  let touched = 0
  let lastError = ''
  const debug = process.argv.includes('--debug')
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const result = verify(lineList(entries), id)
    if (result.ok) return { ok: true, touched, lastError: '' }
    lastError = result.error
    let changed = []
    let kind = ''
    if (/does not match an open turn and step|is outside an open turn/.test(lastError)) {
      changed = repairTurnStep(entries)
      kind = 'turn 外表面事件'
    } else if (/message must have role/.test(lastError)) {
      changed = repairMessageRoles(entries)
      kind = '消息角色不合法'
    } else {
      return { ok: false, touched, lastError, reason: '未支持的损坏类型' }
    }
    if (changed.length === 0) return { ok: false, touched, lastError, reason: '找不到可修复的 ' + kind + '事件' }
    touched += changed.length
    if (debug) console.log('  [debug] 第 ' + String(round + 1) + ' 轮：降级/修正 ' + String(changed.length) + ' 个' + kind + '：' + changed.join(','))
  }
  return { ok: false, touched, lastError, reason: '超过最大轮次' }
}

function collect(target, out) {
  let stats
  try {
    stats = fs.statSync(target)
  } catch {
    return out
  }
  if (stats.isFile()) {
    if (target.endsWith('.jsonl.zstd')) out.push(target)
    return out
  }
  let entries = []
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) out.push(full)
  }
  return out
}

const apply = process.argv.includes('--apply')
const root = sessionsRoot()
const files = collect(root, [])
const now = Date.now()
let healthy = 0
let repairable = 0
let fixed = 0
let dead = 0
let skipped = 0
for (const file of files) {
  const id = path.basename(path.dirname(file))
  let stats
  try {
    stats = fs.statSync(file)
  } catch {
    continue
  }
  if (now - stats.mtimeMs < ACTIVE_WINDOW_MS) {
    skipped += 1
    continue
  }
  const frames = readFrames(file)
  const entries = flatten(frames)
  if (entries.length === 0) continue
  const first = verify(lineList(entries), id)
  if (first.ok) {
    healthy += 1
    continue
  }
  if (/historical child facts/.test(first.error)) {
    skipped += 1
    console.log('跳过 ' + id + ' :: 需要子会话目录证据（本脚本不收集）')
    continue
  }
  const repaired = repairSession(entries, id)
  if (!repaired.ok) {
    dead += 1
    console.log('修不了 ' + id + ' :: ' + String(repaired.lastError).slice(0, 160))
    continue
  }
  repairable += 1
  if (!apply) {
    console.log('可修复 ' + id + '（修正 ' + String(repaired.touched) + ' 处，未落盘）')
    continue
  }
  const backup = file + '.corrupt-bak'
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
  commit(frames, entries)
  writeFrames(file, frames)
  try {
    checkFrameLayout(file)
    const after = verify(flatten(readFrames(file)).map(function (entry) {
      return entry.line
    }), id)
    if (!after.ok) throw new Error(String(after.error))
  } catch (error) {
    fs.copyFileSync(backup, file)
    dead += 1
    console.log('落盘后校验失败 ' + id + ' :: ' + String(error.message).slice(0, 160) + '（已还原）')
    continue
  }
  fixed += 1
  console.log('已修复 ' + id + '（修正 ' + String(repaired.touched) + ' 处，备份 ' + backup + '）')
}
console.log((apply ? '已落盘：' : '预览：') + '扫描 ' + String(files.length) + ' 个会话：正常 ' + String(healthy)
  + ' · 可修复 ' + String(repairable) + ' · 已修复 ' + String(fixed) + ' · 修不了 ' + String(dead)
  + ' · 跳过 ' + String(skipped))
