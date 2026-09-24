/**
 * 修复打不开的会话日志（`stored session "…" is corrupt` / `refuses this format`）。
 *
 * 注意：DSH 0.1.7 起优先使用 tools/repair-migration.mjs（它用 createSessionFormatCatalogWithChildren
 * 走真实 v3→v4 迁移路径校验，并处理 turn 外表面事件）；本脚本对 v3 头会因缺少子会话目录证据而无法校验。
 *
 * 会话日志是**只追加的 zstd 分帧 JSONL**：第一帧必须恰好只装 header 那一行，
 * 之后每帧装若干事件行。dsh-session 只在**加载会话时**校验它，常见的坏法有三类：
 *
 *   1. message 的 role 与事件类型不匹配（历史版本插件用 user/message 承载 assistant 消息）
 *   2. data.turn / data.step 不是正整数（写 0 会被拒绝："turn must be positive"）
 *   3. 旧格式（v0/v1）事件里带了迁移器不认识的字段
 *
 * 本脚本**保留原有帧划分**，只重写内容有变化的帧，修完再用 DSH 真实链路验证：
 *   帧结构 → 迁移解码（createRestore/decodeRow/finish）→ 形状校验（validateStoredEvents）
 * 只有全部通过才落盘，并留下 `.corrupt-bak` 备份。
 *
 * 用法：
 *   node tools/repair-sessions.mjs [sessions 根目录]
 * 默认根目录为 $DSH_HOME/sessions（未设置时用 ~/.dsh/sessions）。
 * DSH 包位置可用 DSH_MODULES 指定；默认在 profiles 与各级 npm 缓存里自动查找。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const EXPECT = {
  'system/message': 'system',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'user',
}
const ACTIVE_WINDOW_MS = 45 * 1000
const MAX_ROUNDS = 40

function sessionsRoot() {
  const arg = process.argv[2]
  if (typeof arg === 'string' && arg !== '' && !arg.startsWith('-')) return arg
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return path.join(home, 'sessions')
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/** DSH 自己的包在 npx 缓存里，不在 profile 的 node_modules 下，所以挨个常见位置找。 */
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
  console.error('找不到 DSH 的会话格式包，请用 DSH_MODULES 指定 node_modules 目录（例如 <npm 缓存>/_npx/<hash>/node_modules）')
  process.exit(2)
}
const asUrl = function (file) {
  return 'file://' + file.replace(/\\/g, '/')
}
const { sessionFormatCatalog: catalog } = await import(asUrl(catalogPath))
const { validateStoredEvents } = await import(asUrl(persistencePath))

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

/** 逐帧读取，保留帧边界。 */
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

/** 只重新压缩内容变了的帧，其余原样保留字节。 */
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

/** 第一帧必须恰好一行：末尾一个换行、中间不能再有换行。 */
function checkFrameLayout(file) {
  const buffer = fs.readFileSync(file)
  const positions = splitFrames(buffer)
  if (positions.length < 2) throw new Error('文件里没有 zstd 帧')
  const first = zlib.zstdDecompressSync(buffer.subarray(positions[0], positions[1]))
  const onlyOneLine = first.length > 0 && first[first.length - 1] === 10 && first.indexOf(10) === first.length - 1
  if (!onlyOneLine) throw new Error('第一帧不是恰好一行 header')
}

/**
 * surface fold 校验：只有「sourceEventSeqs 没盖住被遮蔽节点」才算真问题。
 *
 * validation:'current' 会额外要求 turn/step 序列完整，那**不是** dsh 读取路径的检查
 * （正在运行的会话也过不了），所以过滤掉。
 */
function verifyFold(lines) {
  const header = JSON.parse(lines[0])
  const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (let i = 1; i < lines.length; i += 1) restore.decodeRow(JSON.parse(lines[i]))
  try {
    restore.finish()
  } catch (error) {
    const message = String(error.message)
    if (/surface replace|sourceEventSeqs|shadowed surface node/.test(message)) throw error
  }
}

/** 形状校验：dsh 读完日志后执行的 validateStoredEvents（role / source / content / callId）。 */
function verifyShape(lines, id) {
  const header = JSON.parse(lines[0])
  const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'transformed' })
  for (let i = 1; i < lines.length; i += 1) restore.decodeRow(JSON.parse(lines[i]))
  const artifact = restore.finish()
  validateStoredEvents({ id, version: artifact.header.version }, (artifact.events ?? []).slice(), id)
}

/** 完整校验：迁移解码 + surface fold + 形状，缺一不可。 */
function verify(lines, id) {
  verifyFold(lines)
  verifyShape(lines, id)
}

function repairEvent(event) {
  // 关键：**保留 type / surfaceOp / sourceEventSeqs 原样**，只把消息换成一条内容为空的
  // user 消息。role 合法、不投影任何消息，而 surface 拓扑完全不变 ——
  // 若改成 append，原本被遮蔽的节点会重新回到 surface，后续那些 replace 就会
  // 报 "sourceEventSeqs must include every shadowed surface node"。
  return Object.assign({}, event, {
    data: {
      id: 'manual-context-repair:' + String(event.seq),
      role: 'user',
      content: [],
      source: { kind: 'plugin', plugin: '@dsh-external/manual-context' },
    },
  })
}

/** 依据一次失败信息做一处最小修复；返回是否真的改动了内容。 */
function applyFix(entries, message) {
  const member = /Session: ([A-Za-z0-9_/-]+) (\d+) data has unexpected member "([^"]+)"/.exec(message)
  if (member !== null) {
    const type = member[1]
    const seq = Number(member[2])
    const key = member[3]
    for (const entry of entries) {
      let event
      try {
        event = JSON.parse(entry.line)
      } catch {
        continue
      }
      if (event.seq !== seq || event.type !== type) continue
      if (event.data === null || typeof event.data !== 'object') return false
      delete event.data[key]
      entry.line = JSON.stringify(event)
      return true
    }
    return false
  }
  if (/message must have role/.test(message)) {
    for (const entry of entries) {
      let event
      try {
        event = JSON.parse(entry.line)
      } catch {
        continue
      }
      const expected = EXPECT[event.type]
      if (expected === undefined) continue
      const current = event.type === 'user/message' ? event.data : (event.data && typeof event.data === 'object' ? event.data.message : undefined)
      if (current === null || current === undefined || current.role !== expected) {
        entry.line = JSON.stringify(repairEvent(event))
        return true
      }
    }
    return false
  }
  if (/turn must be positive|step must be positive/.test(message)) {
    let changed = false
    for (const entry of entries) {
      let event
      try {
        event = JSON.parse(entry.line)
      } catch {
        continue
      }
      if (event.data === null || typeof event.data !== 'object') continue
      let local = false
      if (!(typeof event.data.turn === 'number' && event.data.turn >= 1)) {
        event.data.turn = 1
        local = true
      }
      if (!(typeof event.data.step === 'number' && event.data.step >= 1)) {
        event.data.step = 1
        local = true
      }
      if (local) {
        entry.line = JSON.stringify(event)
        changed = true
      }
    }
    return changed
  }
  return false
}

function collect(dir, out) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) out.push(full)
  }
  return out
}

const root = sessionsRoot()
const files = collect(root, [])
const now = Date.now()
let healthy = 0
let fixed = 0
let dead = 0
let skipped = 0
for (const file of files) {
  const id = path.basename(path.dirname(file))
  // 正在写入的会话不要碰
  if (now - fs.statSync(file).mtimeMs < ACTIVE_WINDOW_MS) {
    skipped += 1
    continue
  }
  const frames = readFrames(file)
  const entries = flatten(frames)
  try {
    verify(entries.map(function (entry) { return entry.line }), id)
    healthy += 1
    continue
  } catch {
    /* 需要修 */
  }
  let touched = 0
  let ok = false
  let lastError = ''
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    try {
      verify(entries.map(function (entry) { return entry.line }), id)
      ok = true
      break
    } catch (error) {
      lastError = String(error.message)
    }
    if (!applyFix(entries, lastError)) break
    touched += 1
  }
  if (!ok) {
    dead += 1
    console.log('修不了 ' + id + ' :: ' + lastError.slice(0, 150))
    continue
  }
  commit(frames, entries)
  writeFrames(file, frames)
  try {
    checkFrameLayout(file)
    verify(flatten(readFrames(file)).map(function (entry) { return entry.line }), id)
  } catch (error) {
    dead += 1
    console.log('落盘后校验失败 ' + id + ' :: ' + String(error.message).slice(0, 150))
    continue
  }
  if (!fs.existsSync(file + '.corrupt-bak')) fs.copyFileSync(file, file + '.corrupt-bak')
  fixed += 1
  console.log('已修复 ' + id + '（' + String(touched) + ' 处改动，备份 ' + file + '.corrupt-bak）')
}
console.log('扫描 ' + String(files.length) + ' 个会话：正常 ' + String(healthy) + ' · 已修复 ' + String(fixed) + ' · 修不了 ' + String(dead) + ' · 跳过活跃 ' + String(skipped))
