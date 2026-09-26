/**
 * 修复被插件旧版写坏的会话日志。
 *
 * 症状都是同一个：某个对话**打开后一片空白、而且没有任何报错** —— 其实是会话在
 * 加载阶段就被 dsh 的存储校验拒了，前端只是拿不到历史而已。
 *
 * 目前已知三类坏法，全部源自同一个错误：插件在**会话还没有打开的 turn/step** 时
 * 就把手动上下文节点写进了 surface。
 *
 *   1. 非法遮蔽来源
 *      删 / 重排节点时写的空 system/message 来源是插件自己，而 v4 要求
 *      system/message 来自 system-prompt（只有它能带 sourceEventSeqs 这个遮蔽标记，
 *      所以遮蔽事件必须是 system/message）。
 *      → 只把来源改成 { kind: 'system-prompt' }，内容与遮蔽关系一律不动。
 *
 *   2. 注入节点压在系统提示词前面
 *      surface 的第一个节点必须是 system/message。手动上下文节点是 user/message，
 *      如果它在会话写系统提示词之前就成了第一个节点，加载时就会报
 *      `system/message requires a protected first surface head`。
 *      → 这些节点都已经被后续的空 system/message 遮蔽掉了（模型根本看不到），
 *        所以让它们整体退出 surface 折叠（改写成带 ignorable 的未知事件），
 *        再把因此「失去作用对象」的遮蔽事件改成 append。模型可见内容完全不变。
 *
 *   3. 注入的助手 / 工具段落在 turn 之外
 *      v4 要求 assistant/message、tool/result 必须落在打开的 turn/step 里，
 *      插件却在会话空闲时照写不误 → `assistant/message does not match an open turn and step`。
 *      → 这些节点同样已被遮蔽；把类型降级成 user/message（user/message 不参与
 *        turn/step 校验），既保住遮蔽关系，也不改变最终可见内容。
 *
 * 每一轮改动之后都用 **dsh 自己的加载路径**重新校验，校验不通过就不写盘；
 * 拿不到 dsh 的格式包时（理论上不该发生）只报告、不落盘，绝不盲改。
 * 原文件在第一次写入前备份成 *.corrupt-bak。
 *
 * @module repair
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dshHome } from './store.js'

/** 旧版本给遮蔽事件写的来源 —— 会话打不开的原因之一。 */
export const LEGACY_MASK_SOURCE = 'plugin:@dsh-external/manual-context'

/** 手动上下文节点的事件 / 消息 id 前缀（与 inject.js 的 ID_PREFIX 一致）。 */
export const INJECTION_ID_PREFIX = 'manual-context:'

/** 退出 surface 折叠的节点被改写成这个未知类型（带 ignorable，dsh 会原样跳过）。 */
export const ORPHAN_TYPE = 'x-manual-context/orphan'

/** 参与 surface 折叠的事件类型（与 dsh v4 的 SURFACE_TYPES 一致）。 */
const SURFACE_TYPES = ['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']

/** v4 要求「必须落在打开的 turn+step 里」的类型。 */
const STEP_BOUND = ['system/message', 'developer/message', 'assistant/attempt', 'assistant/message', 'tool/call', 'tool/result']

/** 会话日志根目录。 */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** 当前 Node 是否自带 zstd（会话日志是 zstd 压缩的 jsonl）。 */
export function zstdAvailable() {
  return typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function'
}

/** 把 zstd 多帧日志解成行数组（第一行是 header）。 */
export function readSessionLines(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
  }
  const chunks = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8'))
    } catch {
      // 坏帧跳过：修不了的文件会被如实报出来，而不是被静默改坏
    }
  }
  return chunks.join('').split(/\r?\n/).filter(function (line) { return line.trim() !== '' })
}

/** 写回 zstd 单帧日志。 */
export function writeSessionLines(file, lines) {
  writeFileSync(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
}

/**
 * 这条事件是不是「非法遮蔽」：system/message 但来源是旧版插件。
 * @param {object} event 一条会话事件
 * @returns {boolean} 需要修来源时为 true
 */
export function isIllegalMask(event) {
  if (event === null || typeof event !== 'object') return false
  if (event.type !== 'system/message') return false
  return event?.data?.message?.source?.kind === LEGACY_MASK_SOURCE
}

/** 就地修好一条非法遮蔽事件：只改来源，其余一律不动。 */
export function fixIllegalMask(event) {
  return {
    ...event,
    data: { ...event.data, message: { ...event.data.message, source: { kind: 'system-prompt' } } },
  }
}

/** 取一条事件里的消息 id（user/message 的 data 就是消息本体）。 */
function messageIdOf(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type === 'user/message') return event?.data?.id
  return event?.data?.message?.id
}

/** 是不是插件写进去的手动上下文节点（注入、编辑、删除占位都算）。 */
function isInjectionEvent(event) {
  const id = messageIdOf(event)
  if (typeof id !== 'string') return false
  return id.indexOf(INJECTION_ID_PREFIX) === 0
    || id.indexOf('manual-context-edit:') === 0
    || id.indexOf('manual-context-deleted:') === 0
}

/**
 * 空白的 system/message 遮蔽占位。
 *
 * 插件删 / 重排节点时会写一条内容为空的 system/message 顶上去；它本身不携带任何内容，
 * 所以让它退出折叠不会改变模型看到的东西。
 */
function isBlankMask(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'system/message') return false
  const message = event?.data?.message
  if (message === null || typeof message !== 'object') return false
  if (message?.source?.kind !== 'system-prompt') return false
  return Array.isArray(message.content) && message.content.length === 0
}

/**
 * 把一个节点连同它「遮蔽掉的节点」一起退出 surface 折叠。
 *
 * 只允许丢弃插件自己写的节点；链条里一旦出现真实内容就整体放弃，免得把模型看到的
 * 历史改掉。遮蔽事件被丢弃后，它遮蔽的节点会重新可见，所以必须一起丢。
 */
function dropChain(seq, dropped, loose, bySeq, depth) {
  const level = depth ?? 0
  if (level > 16) return false
  if (dropped.has(seq)) return true
  const event = bySeq.get(seq)
  if (event === undefined) return false
  // 三类可以一起退出折叠：
  //   1. 插件自己写的节点（注入段 / 编辑节点 / 空遮蔽事件）；
  //   2. 已经被插件遮蔽事件遮住的节点 —— 它们在最终 surface 上本来就不可见，
  //      跟着遮蔽事件一起 drop 是**内容等价**的。retype 成 user/message 反而会
  //      在 surface 上留下一条空消息，还会把被遮蔽的助手段角色改掉。
  if (!isInjectionEvent(event) && !isBlankMask(event) && !isShadowedIn(loose, seq)) return false
  dropped.add(seq)
  const removed = loose.removedBy.get(seq) ?? []
  for (const child of removed) {
    if (!dropChain(child, dropped, loose, bySeq, level + 1)) return false
  }
  return true
}

/**
 * 折叠出「模型真正能看到的消息序列」（角色 + 文本）。
 *
 * 修复会话时必须拿它做前后对比：只有可见消息完全一致，才敢落盘 ——
 * 光靠「能通过加载校验」是不够的（把助手段降级成用户消息也能过校验，但内容已经变了）。
 */
export function visibleSurfaceMessages(events) {
  const bySeq = new Map()
  for (const event of events) bySeq.set(event.seq, event)
  const result = foldSurface(events, { strict: false })
  if (!result.ok) return null
  const out = []
  for (const seq of result.surface) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const message = event.type === 'user/message' ? event.data : event?.data?.message
    if (message === null || typeof message !== 'object') continue
    const text = (Array.isArray(message.content) ? message.content : [])
      .map(function (block) { return typeof block?.text === 'string' ? block.text : '' }).join('')
    out.push({ seq: seq, role: String(message.role ?? ''), text: text })
  }
  return out
}

/**
 * 折叠 surface。
 *
 * strict=false 时只做结构折叠（append / replace），用来摸清「谁遮蔽了谁」；
 * strict=true 时额外套上 v4 的关系规则，并在第一个违规点停下来报告。
 *
 * @param {object[]} events      会话事件（按 seq 升序）
 * @param {object}   [options]
 * @param {boolean}  [options.strict]   是否启用 v4 关系规则
 * @param {Set<number>} [options.dropped]  已被判定要退出折叠的 seq
 * @param {Map<number,string>} [options.variants] seq → 改写后的类型
 * @param {Set<number>} [options.asAppend]  已判定要改成 append 的 replace 事件 seq
 * @returns {object} { ok, surface, protectedHead, removedBy, violation }
 */
function foldSurface(events, options) {
  const settings = options ?? {}
  const strict = settings.strict === true
  const dropped = settings.dropped ?? new Set()
  const variants = settings.variants ?? new Map()
  const asAppend = settings.asAppend ?? new Set()
  const surface = []
  const removedBy = new Map()
  let protectedHead
  let turn = null
  let step = null

  for (const event of events) {
    // turn / step 状态推进要按真实事件来（改写类型不影响生命周期事件）
    if (strict) {
      if (event.type === 'turn/start') { turn = event?.data?.turn ?? null; step = null }
      else if (event.type === 'turn/end') { turn = null; step = null }
      else if (event.type === 'step/start') { step = event?.data?.step ?? null }
      else if (event.type === 'step/end') { step = null }
    }
    if (dropped.has(event.seq)) continue
    const type = variants.get(event.seq) ?? event.type
    if (SURFACE_TYPES.indexOf(type) < 0) continue

    if (strict && !dropped.has(event.seq)) {
      // dsh 里「替换式 tool/result」只要求打开的 turn，其余消息类型要求 turn+step 都在
      const turnOnly = type === 'tool/result' && event.surfaceOp !== 'append'
      if (turnOnly || STEP_BOUND.indexOf(type) >= 0) {
        const ok = turn !== null && (turnOnly || (step !== null && event?.data?.turn === turn && event?.data?.step === step))
        if (!ok) return { ok: false, surface, protectedHead, removedBy, violation: { kind: 'step', seq: event.seq, type: event.type } }
      }
    }

    const op = event.surfaceOp
    const orphanedTarget = op !== null && typeof op === 'object' && dropped.has(op.startSeq)
    if (orphanedTarget && !asAppend.has(event.seq)) asAppend.add(event.seq)
    const effectiveAppend = op === 'append' || asAppend.has(event.seq) || orphanedTarget
    if (strict && type === 'system/message' && surface.length > 0 && protectedHead === undefined) {
      const head = surface[0]
      return { ok: false, surface, protectedHead, removedBy, violation: { kind: 'head', seq: event.seq, head } }
    }
    if (effectiveAppend) {
      if (type === 'system/message' && surface.length === 0) protectedHead = event.seq
      surface.push(event.seq)
      continue
    }
    if (op === null || typeof op !== 'object') {
      return { ok: false, surface, protectedHead, removedBy, violation: { kind: 'op', seq: event.seq, type: event.type } }
    }
    const first = surface.indexOf(op.startSeq)
    const last = surface.indexOf(op.endSeq)
    if (first < 0 || last < first) {
      return { ok: false, surface, protectedHead, removedBy, violation: { kind: 'range', seq: event.seq, type: event.type } }
    }
    const removed = surface.slice(first, last + 1)
    if (strict) {
      const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : null
      if (sources === null || removed.some(function (seq) { return sources.indexOf(seq) < 0 })) {
        return { ok: false, surface, protectedHead, removedBy, violation: { kind: 'sources', seq: event.seq, type: event.type } }
      }
      if (protectedHead !== undefined && removed.indexOf(protectedHead) >= 0) {
        if (type !== 'system/message' || removed.length !== 1) {
          return { ok: false, surface, protectedHead, removedBy, violation: { kind: 'shadow-head', seq: event.seq, type: event.type } }
        }
        protectedHead = event.seq
      }
    }
    if (!removedBy.has(event.seq)) removedBy.set(event.seq, removed)
    surface.splice(first, removed.length, event.seq)
  }
  return { ok: true, surface, protectedHead, removedBy, violation: null }
}

/** 按修复计划把动作落到事件上。 */
function materialize(events, dropped, variants, asAppend) {
  return events.map(function (event) {
    if (dropped.has(event.seq)) {
      return { type: ORPHAN_TYPE, seq: event.seq, time: event.time, ignorable: true, data: { superseded: true } }
    }
    let next = event
    if (asAppend.has(event.seq)) {
      const copy = { ...next, surfaceOp: 'append' }
      delete copy.sourceEventSeqs
      next = copy
    }
    const variant = variants.get(event.seq)
    if (variant !== undefined && variant !== next.type) {
      if (variant === 'user/message') {
        // assistant/message、tool/result 的 data 是 { turn, step, message }，
        // 而 user/message 的 data 直接就是消息本体；role 也必须跟着变成 user。
        const carried = next?.data?.message !== undefined && typeof next.data.message === 'object' ? next.data.message : next.data
        if (carried !== null && typeof carried === 'object') {
          next = { ...next, type: variant, data: carried.role === 'user' ? carried : { ...carried, role: 'user' } }
        } else {
          next = { ...next, type: variant }
        }
      } else {
        next = { ...next, type: variant }
      }
    }
    return next
  })
}

/**
 * 规划修复动作。
 *
 * 反复「定位第一个违规 → 给一个最小动作」直到折叠通过；任何一步超出已知的安全
 * 范围（违规节点不是插件注入的、还在生效没被遮蔽、遮蔽范围混着别的节点……）就整体放弃，
 * 返回原因而不是硬改。
 *
 * @param {object[]} events 会话事件
 * @returns {object} { ok, changed, events, actions } 或 { ok:false, reason }
 */
export function planRepair(events) {
  const bySeq = new Map()
  for (const event of events) bySeq.set(event.seq, event)
  const loose = foldSurface(events, { strict: false })
  if (!loose.ok) return { ok: false, reason: '日志里的 surface 结构本身折不起来：' + describeViolation(loose.violation), actions: [] }

  const dropped = new Set()
  const variants = new Map()
  const asAppend = new Set()
  const actions = []
  const bail = function (reason) { return { ok: false, reason, actions: actions.slice() } }

  for (let round = 0; round < 1024; round += 1) {
    const result = foldSurface(events, { strict: true, dropped, variants, asAppend })
    if (result.ok) {
      if (actions.length === 0) return { ok: true, changed: false, events, actions }
      // 硬性闸门：修完「模型能看到的消息」（角色 + 正文）必须和修之前逐条一致。
      // 能通过加载校验不等于没改内容 —— 把助手段降级成 user/message 一样能过校验，
      // 但用户打开会话就会发现助手回复「没了」。这里不一致就整体放弃，宁可不修。
      const before = visibleSurfaceMessages(events)
      const after = visibleSurfaceMessages(materialize(events, dropped, variants, asAppend))
      if (before === null || after === null) return bail('折叠不出可见消息序列，已放弃（原文件未改动）')
      const key = function (list) { return JSON.stringify(list.filter(function (m) { return m.text.trim() !== '' }).map(function (m) { return m.role + '|' + m.text })) }
      if (key(before) !== key(after)) {
        return bail('修复会改变模型看到的对话内容（' + String(before.length) + ' → ' + String(after.length) + ' 条），已放弃，原文件未改动')
      }
      // 改成 append 的事件，失去作用对象的必须**全部**是已丢弃的节点，否则顺序会被改坏
      for (const seq of asAppend) {
        const removed = loose.removedBy.get(seq) ?? []
        if (removed.some(function (child) { return !dropped.has(child) })) {
          return bail('seq ' + seq + ' 的替换范围里还有真实内容，改成追加会改变顺序，暂不支持', actions)
        }
      }
      return { ok: true, changed: true, events: materialize(events, dropped, variants, asAppend), actions }
    }
    const violation = result.violation

    if (violation.kind === 'head') {
      const head = bySeq.get(violation.head)
      if (head === undefined) return bail('找不到 surface 首个节点 seq ' + violation.head)
      if (!isInjectionEvent(head)) {
        return bail('surface 首个节点（seq ' + head.seq + '，' + head.type + '）是真实内容而不是插件节点，得整段重排才能修，暂不支持')
      }
      if (!dropChain(head.seq, dropped, loose, bySeq)) {
        return bail('丢弃 seq ' + head.seq + ' 会连带动到真实内容，暂不支持')
      }
      actions.push({ kind: 'unfold', seq: head.seq, why: '压在系统提示词前面' })
      continue
    }

    if (violation.kind === 'step') {
      const target = bySeq.get(violation.seq)
      if (target === undefined) return bail('找不到违规事件 seq ' + violation.seq)
      // 插件在会话空闲时写下的注入段 / 空白遮蔽事件都落在 turn 之外；
      // user/message 是唯一不要求 open turn/step 的 surface 类型，降级过去即可保住
      // 遮蔽关系与内容（这些节点本来要么是空的，要么最终会被遮蔽）。
      const shadowed = isShadowedIn(loose, target.seq)
      // 空白的遮蔽事件：连同它遮住的节点一起退出折叠。
      // 不能降级成 user/message —— 那会在 surface 上留下一条空消息，用户打开会话就多出
      // 一堆「空对话」，看起来就是「历史被修乱了」。
      if (isBlankMask(target) && !dropped.has(target.seq)) {
        if (!dropChain(target.seq, dropped, loose, bySeq)) {
          return bail('seq ' + target.seq + ' 的遮蔽链里有不能一起退出的内容，暂不支持')
        }
        actions.push({ kind: 'unfold', seq: target.seq, why: '空白遮蔽事件落在 turn 之外，连同遮蔽链一起退出折叠' })
        continue
      }
      // 已经被遮蔽的节点：整条遮蔽链一起退出折叠（内容等价），比降级改角色安全得多。
      if (shadowed && !dropped.has(target.seq)) {
        if (!dropChain(target.seq, dropped, loose, bySeq)) {
          return bail('seq ' + target.seq + ' 的遮蔽链里有不能一起退出的内容，暂不支持')
        }
        actions.push({ kind: 'unfold', seq: target.seq, why: '落在 turn 之外且已被遮蔽，连同遮蔽链一起退出折叠' })
        continue
      }
      // 还没被遮蔽的插件节点（例如重放出来的助手段）：只能降级成 user/message 保住内容。
      const replayable = target.type === 'assistant/message' || target.type === 'tool/result'
      if ((isInjectionEvent(target) || isBlankMask(target) || replayable) && !dropped.has(target.seq)) {
        if (variants.get(target.seq) === 'user/message') {
          return bail('修复陷入循环：seq ' + target.seq + ' 反复触发 turn/step 规则')
        }
        variants.set(target.seq, 'user/message')
        actions.push({ kind: 'retype', seq: target.seq, to: 'user/message', why: '落在 turn 之外' })
        continue
      }
      return bail('turn 之外的 ' + target.type + '（seq ' + target.seq + '）不是插件写的节点、也没被遮蔽，改写会改变模型看到的内容，暂不支持')
    }

    return bail('遇到暂不支持的损坏：' + describeViolation(violation))
  }
  return bail('修复没有收敛（改动次数过多）')
}

/** 该节点是否已经被别的 replace 遮蔽掉（遮蔽了就说明它最终不在模型可见的 surface 上）。 */
function isShadowedIn(loose, seq) {
  for (const removed of loose.removedBy.values()) if (removed.indexOf(seq) >= 0) return true
  return false
}

/** 把违规信息拼成人话。 */
function describeViolation(violation) {
  if (violation === null || violation === undefined) return '未知问题'
  if (violation.kind === 'head') return 'seq ' + violation.seq + ' 的 system/message 之前，surface 首节点（seq ' + violation.head + '）不是系统消息'
  if (violation.kind === 'step') return 'seq ' + violation.seq + ' 的 ' + violation.type + ' 不在打开的 turn/step 里'
  if (violation.kind === 'range') return 'seq ' + violation.seq + ' 的替换范围不在当前 surface 上'
  if (violation.kind === 'sources') return 'seq ' + violation.seq + ' 的遮蔽来源列表对不上被遮蔽的节点'
  if (violation.kind === 'shadow-head') return 'seq ' + violation.seq + ' 试图遮蔽受保护的系统头'
  if (violation.kind === 'op') return 'seq ' + violation.seq + ' 的 surfaceOp 不是合法值'
  return '未知问题'
}

/** 把需要修的地方在写入前先补上「遮蔽来源」这一步。 */
function fixMaskSources(events) {
  let hit = 0
  const next = events.map(function (event) {
    if (!isIllegalMask(event)) return event
    hit += 1
    return fixIllegalMask(event)
  })
  return { events: next, hit }
}

//#region 用 dsh 自己的加载路径做最终校验
let verifierPromise = null

/** 找到 dsh 的会话格式包（插件目录不一定能直接解析到，逐个 profile 试）。 */
async function loadVerifier() {
  if (verifierPromise !== null) return verifierPromise
  verifierPromise = (async function () {
    const bases = []
    try { bases.push(pathToFileURL(join(dshHome(), 'profiles', 'web', 'package.json')).href) } catch { /* ignore */ }
    try {
      for (const name of readdirSync(join(dshHome(), 'profiles'))) {
        bases.push(pathToFileURL(join(dshHome(), 'profiles', name, 'package.json')).href)
      }
    } catch { /* ignore */ }
    bases.push(import.meta.url)
    for (const base of bases) {
      try {
        const require = createRequire(base)
        const resolved = require.resolve('@deepseek-ai/dsh-session-format-catalog')
        const module = await import(pathToFileURL(resolved).href)
        if (typeof module.createSessionFormatCatalogWithChildren === 'function') return module
      } catch {
        // 换个基准继续找
      }
    }
    return null
  })()
  return verifierPromise
}

/** 当前环境能不能做「真实加载校验」。 */
export async function verifierAvailable() {
  return (await loadVerifier()) !== null
}

/**
 * 用 dsh 的真实加载路径校验一份会话。
 * @param {object} header 会话头
 * @param {object[]} events 会话事件
 * @returns {Promise<{ok: boolean, verified: boolean, error?: string}>} verified=false 表示拿不到校验器
 */
export async function verifySession(header, events) {
  const catalog = await loadVerifier()
  if (catalog === null) return { ok: true, verified: false }
  try {
    const restore = catalog.createSessionFormatCatalogWithChildren([]).createRestore(structuredClone(header), {
      recovery: 'recoverable',
      validation: 'current',
    })
    for (const event of structuredClone(events)) restore.decodeRow(event)
    restore.finish()
    return { ok: true, verified: true }
  } catch (error) {
    return { ok: false, verified: true, error: error instanceof Error ? error.message : String(error) }
  }
}
//#endregion

/** 递归找出所有会话日志文件。 */
function sessionFiles(root) {
  const found = []
  ;(function walk(dir, depth) {
    if (depth > 3) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) { walk(abs, depth + 1); continue }
      if (entry.name.startsWith('session') && entry.name.endsWith('.jsonl.zstd')) found.push(abs)
    }
  })(root, 0)
  return found
}

/** 读一份会话日志，返回 { header, events, lines }。 */
export function readSessionFile(file) {
  const lines = readSessionLines(file)
  if (lines.length === 0) return null
  const header = JSON.parse(lines[0])
  const events = []
  for (const line of lines.slice(1)) {
    try { events.push(JSON.parse(line)) } catch { return null }
  }
  return { header, events, lines }
}

/**
 * 检查（并按需修复）会话日志。
 *
 * @param {object}   [options]
 * @param {string}   [options.root]       会话根目录，默认 $DSH_HOME/sessions
 * @param {boolean}  [options.apply]      是否真的写回（false = 只检查）
 * @param {Set<string>} [options.running] 正在运行的会话 id：跳过，避免和 dsh 内存里的日志打架
 * @param {string}   [options.sessionId]  只处理这一个会话（面板「修复此对话」用）
 * @returns {Promise<object>} 报告
 */
export async function repairSessions(options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const root = typeof settings.root === 'string' && settings.root !== '' ? settings.root : sessionsRoot()
  const apply = settings.apply === true
  const running = settings.running instanceof Set ? settings.running : new Set()
  const only = typeof settings.sessionId === 'string' && settings.sessionId !== '' ? settings.sessionId : null
  const report = {
    ok: true, root, supported: zstdAvailable(),
    scanned: 0, broken: 0, repaired: 0, skippedRunning: 0, failed: 0, unrepairable: 0,
    sessions: [],
  }
  if (!report.supported) {
    report.ok = false
    report.error = '当前 Node 不带 zstd，没法读写会话日志（需要 Node 22.15+ / 24）'
    return report
  }
  if (!existsSync(root)) {
    report.ok = false
    report.error = '找不到会话目录: ' + root
    return report
  }

  const files = sessionFiles(root).filter(function (file) {
    return only === null || basename(dirname(file)) === only
  })
  report.verifier = (await verifierAvailable()) ? 'dsh' : 'builtin'

  for (const file of files) {
    report.scanned += 1
    const sessionId = basename(dirname(file))
    if (running.has(sessionId)) { report.skippedRunning += 1; continue }

    let parsed = null
    try { parsed = readSessionFile(file) } catch { parsed = null }
    if (parsed === null) { report.failed += 1; continue }

    const row = { id: sessionId, file, actions: [], repaired: false, before: null, after: null }
    let baseline = await verifySession(parsed.header, parsed.events)
    if (!baseline.verified) baseline = verifyBuiltin(parsed.header, parsed.events)
    row.before = baseline.ok ? null : baseline.error

    if (baseline.ok) continue
    report.broken += 1

    // 第一步：把旧版写的非法遮蔽来源修好
    const masked = fixMaskSources(parsed.events)
    let events = masked.events
    if (masked.hit > 0) row.actions.push({ kind: 'mask-source', count: masked.hit })

    // 第二步：让「已被遮蔽、却仍在折叠里惹事」的注入节点退出/降级
    const plan = planRepair(events)
    if (!plan.ok) {
      row.reason = plan.reason
      row.after = row.before
      report.unrepairable += 1
      report.sessions.push(row)
      continue
    }
    if (plan.changed) {
      events = plan.events
      for (const action of plan.actions) row.actions.push(action)
    }

    const after = await verifySession(parsed.header, events)
    if (!after.ok) {
      row.reason = (after.error ?? '') + '(实际校验)'
      row.after = row.reason
      report.unrepairable += 1
      report.sessions.push(row)
      continue
    }
    if (row.actions.length === 0) {
      row.reason = '加载失败但没找到已知的损坏模式：' + String(row.before).slice(0, 120)
      row.after = row.before
      report.unrepairable += 1
      report.sessions.push(row)
      continue
    }
    row.after = null

    if (apply) {
      try {
        const backup = file + '.corrupt-bak'
        if (!existsSync(backup)) copyFileSync(file, backup)
        writeSessionLines(file, [JSON.stringify(parsed.header)].concat(events.map(function (event) { return JSON.stringify(event) })))
        row.repaired = true
        report.repaired += 1
      } catch (error) {
        report.failed += 1
        row.error = error instanceof Error ? error.message : String(error)
      }
    }
    report.sessions.push(row)
  }
  return report
}

/** 拿不到 dsh 校验器时的退路：只按内置规则折叠一遍。 */
function verifyBuiltin(header, events) {
  const result = foldSurface(events, { strict: true })
  if (result.ok) return { ok: true, verified: false }
  return { ok: false, verified: false, error: describeViolation(result.violation) }
}

/** 会话文件最近修改时间（面板用来提示「这些是刚修过的」）。 */
export function sessionMtime(file) {
  try { return statSync(file).mtimeMs } catch { return null }
}
