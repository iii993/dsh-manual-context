/**
 * 手动上下文的「同步」。
 *
 * 条目不再靠 pre-step 合成消息，而是和「编辑历史上下文」完全一样：
 * 每个条目段都会变成会话 surface 上的一个真实消息节点（`manual-context:<hash>[:<段号>]`），
 * 于是它可以被编辑、删除、拖动重排，写入也走同一套生命周期守卫与排队机制。
 *
 * 位置由条目的 `weight` 决定（见 store.js）：
 *   - weight <= 0：排在系统提示词正下方
 *   - weight > 0 ：排在正常对话的最后面，权重越大越靠前
 *
 * 同步是**幂等**的：条目内容变了（hash 变）就等于旧节点不再需要、新节点追加；
 * 条目被禁用或删除，对应节点会被空 system 消息遮蔽掉。
 */
import { listEntries, readEntry, renderEntryBlock, entryMarker, parseSegments, normalizeRole, injectionEnabled } from './store.js'
import { appendMessage, deleteMessages, reorderMessages, enqueueOperation, loadQueue, sessionEvents } from './history.js'

export const MARKER = 'dsh-manual-context'
/** 手动上下文节点的消息 id 前缀。 */
export const ID_PREFIX = 'manual-context:'

/**
 * 注入文本的渲染版本。
 *
 * 消息 id = `manual-context:r<版本>:<条目 hash>[:<段号>]`。文件内容一变 hash 就变，
 * 而**渲染形态**变了（例如去掉文件名包装）hash 不会变 —— 靠这个版本号让旧节点
 * 在下一次同步时被判为「已作废」并自动替换，不用手工删。
 */
// 注入内容版本号。改动注入内容/顺序时升一级：所有会话会重新注入一次，
// 旧节点被遮蔽（空 system/message），新节点落在系统提示词之后 —— 顺序问题因此自愈。
export const CONTEXT_REVISION = 3

/**
 * 整篇（或某一段）对应的消息 id —— 同时是「是否已同步进会话」的判断依据。
 * 不带 segmentIndex（或第 0 段）时是整条目的 id。
 */
export function entryMessageId(entry, segmentIndex) {
  const base = ID_PREFIX + 'r' + String(CONTEXT_REVISION) + ':' + entry.hash
  if (segmentIndex === undefined || segmentIndex === 0) return base
  return base + ':' + segmentIndex
}

/**
 * 把一个条目展开成待同步的段列表。
 *
 * 正文里没有段标记时就是"一段"（继承文件级 role），因此老写法完全兼容；
 * 有 <!-- role: xxx --> 标记时，一个文件里可以混排用户输入、模型输出与工具轨迹。
 */
export function entrySegments(entry) {
  const fallback = normalizeRoleOf(entry.role)
  const fileMeta = entry.meta !== null && typeof entry.meta === 'object' ? entry.meta : {}
  const specs = []
  parseSegmentsOf(entry.body).forEach(function (segment, index) {
    const text = String(segment.text ?? '').trim()
    if (text === '') return
    const pick = function (key) {
      return segment.meta[key] !== undefined ? segment.meta[key] : fileMeta[key]
    }
    specs.push({
      id: entryMessageId(entry, index),
      index,
      role: segment.meta.role !== undefined ? normalizeRoleOf(segment.meta.role) : fallback,
      text,
      tool: pick('tool'),
      args: pick('args'),
      callId: pick('callId'),
      isError: String(pick('isError') ?? '').toLowerCase() === 'true',
    })
  })
  return specs
}

const parseSegmentsOf = parseSegments
const normalizeRoleOf = normalizeRole

/**
 * 把当前所有**启用**的条目展开成会话里应有的目标节点列表（已按权重排好序）。
 */
export function planTargets(cwd) {
  const targets = []
  // tool 轨迹的 callId 跨条目配对：result 段要能接上前面 call 段的 callId
  const pendingCalls = []
  for (const meta of listEntries(cwd)) {
    let entry
    try {
      entry = readEntry(cwd, meta.id)
    } catch {
      continue
    }
    if (entry.enabled === false) continue
    const weight = Number.isFinite(entry.weight) ? entry.weight : 0
    const base = { weight, name: entry.name, hash: entry.hash, entryId: entry.id }
    // 连续的「思维链 / 模型输出 / 工具调用」段合成**一条** assistant 消息（多个内容块）——
    // 这正是真实回复的形状：一段 reasoning + 一段正文 + 一个 tool-call 属于同一条消息。
    // user 段与 tool-result 段是天然的分界线（它们必须各自独立成消息）。
    let group = null
    const flushGroup = function () {
      if (group === null) return
      const blocks = []
      for (const spec of group) {
        if (spec.role === 'reasoning') {
          blocks.push({ type: 'reasoning', text: spec.text })
          continue
        }
        if (spec.role === 'tool-call') {
          if (spec.text !== '') blocks.push({ type: 'text', text: spec.text })
          // callId 必须稳定：同一份内容重复同步要落到同一个节点上
          const callId = spec.callId !== undefined && spec.callId !== ''
            ? spec.callId
            : 'manual-call-' + entry.hash + '-' + String(spec.index)
          pendingCalls.push(callId)
          blocks.push({ type: 'tool-call', callId, name: spec.tool, args: spec.args })
          continue
        }
        blocks.push({ type: 'text', text: spec.text })
      }
      const first = group[0]
      targets.push({ ...base, id: entryMessageId(entry, first.index), index: first.index, role: 'assistant', blocks })
      group = null
    }
    for (const spec of entrySegments(entry)) {
      if (spec.role === 'reasoning' || spec.role === 'assistant' || spec.role === 'tool-call') {
        if (group === null) group = []
        group.push(spec)
        continue
      }
      flushGroup()
      if (spec.role === 'user') {
        targets.push({ ...base, id: spec.id, index: spec.index, role: 'user', text: renderEntryBlock(entry, spec) })
        continue
      }
      if (spec.role === 'tool-result') {
        const callId = spec.callId !== undefined && spec.callId !== ''
          ? spec.callId
          : (pendingCalls.length > 0 ? pendingCalls.shift() : 'manual-call-' + entry.hash + '-r' + String(spec.index))
        targets.push({ ...base, id: spec.id, index: spec.index, role: 'tool-result', text: spec.text, callId, isError: spec.isError === true })
      }
    }
    flushGroup()
  }
  const head = targets.filter(function (item) { return item.weight <= 0 })
  const tail = targets.filter(function (item) { return item.weight > 0 })
  const compare = function (a, b) {
    if (b.weight !== a.weight) return b.weight - a.weight
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return a.index - b.index
  }
  head.sort(compare)
  tail.sort(compare)
  return head.concat(tail)
}

/** 会话 surface 上属于手动上下文的节点：消息 id → seq。 */
export function manualContextNodes(session) {
  const events = sessionEvents(session)
  const byId = new Map()
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (event === undefined) continue
    const message = messageOf(session, event)
    const id = message !== null && typeof message === 'object' ? message.id : undefined
    if (typeof id === 'string' && id.startsWith(ID_PREFIX)) byId.set(id, seq)
  }
  return byId
}

/** 取事件对应的消息实体（user/message 的 data 就是消息本体）。 */
function messageOf(session, event) {
  try {
    if (event.type === 'user/message') return event.data
    const message = session.deriveEventMessage(event)
    return message === undefined ? null : message
  } catch {
    return null
  }
}

/** 目标节点 → appendMessage 的参数。 */
function specOf(target) {
  // 合并组：一条 assistant 消息带多个内容块
  if (Array.isArray(target.blocks) && target.blocks.length > 0) {
    return { kind: 'assistant', blocks: target.blocks, text: '', id: target.id }
  }
  const spec = { kind: target.role, text: target.text, id: target.id }
  if (target.role === 'tool-call') {
    spec.toolName = target.tool
    spec.toolInput = target.args
    spec.callId = target.callId
  }
  if (target.role === 'tool-result') {
    spec.callId = target.callId
    spec.isError = target.isError === true
  }
  return spec
}

/** 期望的 surface 顺序：系统头 → 负权重条目 → 其余历史 → 正权重条目。 */
function desiredOrder(session, targets) {
  const nodes = [...session.surface.nodes]
  const events = sessionEvents(session)
  const manualSeqs = new Set()
  const byId = new Map()
  for (const seq of nodes) {
    const event = events[seq]
    if (event === undefined) continue
    const message = messageOf(session, event)
    const id = message !== null && typeof message === 'object' ? message.id : undefined
    if (typeof id === 'string' && id.startsWith(ID_PREFIX)) {
      manualSeqs.add(seq)
      byId.set(id, seq)
    }
  }
  const others = nodes.filter(function (seq) { return !manualSeqs.has(seq) })
  const head = targets.filter(function (item) { return item.weight <= 0 })
    .map(function (item) { return byId.get(item.id) })
    .filter(function (seq) { return seq !== undefined })
  const tail = targets.filter(function (item) { return item.weight > 0 })
    .map(function (item) { return byId.get(item.id) })
    .filter(function (seq) { return seq !== undefined })
  // surface 的第 0 个节点**如果就是**系统提示词，它必须留在原位（替换系统头会被校验拦下）。
  // 真实会话里系统提示词走 request/header 事件、不是 surface 节点，此时手动上下文直接排到最前，
  // 于是「新建对话、还没发第一句话」时注入的上下文就天然排在用户消息之前。
  // 只决定「手动上下文插在哪」：第一个**有内容的** system/message 之后；没有就插最前。
  // 其余节点（含我们写的空遮蔽节点与对话历史）保持原有相对顺序 ——
  // 绝不能把 system 节点搬来搬去：它的来源是 system-prompt，重放会改写来源，
  // 系统提示词就废了（reorderIfNeeded 会二次确认并放弃这种重排）。
  let insertAt = 0
  for (let index = 0; index < others.length; index += 1) {
    const event = events[others[index]]
    if (event === undefined || event.type !== 'system/message') continue
    if (messageOf(session, event) === null) continue
    insertAt = index + 1
    break
  }
  return others.slice(0, insertAt).concat(head, others.slice(insertAt), tail)
}

/** 顺序不对才重排（重排要遮蔽+重放，代价不低）。 */
function reorderIfNeeded(ctx, sessionId, session, targets) {
  const nodes = [...session.surface.nodes]
  const order = desiredOrder(session, targets)
  if (order.length !== nodes.length) {
    ctx.logger?.warn?.('[manual-context] 跳过重排：期望顺序覆盖不全部节点，重排会丢节点')
    return false
  }
  // 系统提示词（system/message）绝不能移动：重放会改写它的来源（v4 要求 system-prompt），
  // 写出来的日志下次加载会直接失败 —— 表现就是「会话打不开、界面空白且不报错」。
  // 只要它的相对位置会变，就放弃这次重排（手动上下文留在原地，不影响读写）。
  const systemBefore = nodes.filter(function (seq) { return isSystemNode(session, seq) })
  const systemAfter = order.filter(function (seq) { return isSystemNode(session, seq) })
  if (systemBefore.length !== systemAfter.length || systemBefore.some(function (seq, index) { return seq !== systemAfter[index] })) {
    ctx.logger?.warn?.('[manual-context] 跳过重排：这次排序会移动系统提示词节点')
    return false
  }
  if (order.every(function (seq, index) { return seq === nodes[index] })) return false
  reorderMessages(ctx, sessionId, order)
  return true
}

/** 该 surface 节点是不是系统提示词。 */
function isSystemNode(session, seq) {
  const event = sessionEvents(session)[seq]
  return event !== undefined && event.type === 'system/message'
}

/**
 * 把会话里的手动上下文节点同步成「当前条目应有的样子」。
 *
 * **逐条容错**：老格式会话（v4 之前）空闲时写不了，会抛 SessionWritePendingError；
 * 这时不让整次同步失败，而是把写不进去的部分记进 deferred 交给上层排队，
 * 能写的（user 段等）先写下去 —— 于是「新建对话还没开始」也能先把上下文注入好。
 */
export function syncManualContext(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  const cwd = session?.header?.cwd

  // 写入时机不在这里判断 —— 和历史编辑一样：空闲时 appendMessage/deleteMessages
  // 自己会抛 SessionWritePendingError，下面逐条容错把它们记进 deferred，
  // HTTP 层据此排队，等下一轮 agent/request（step 已打开）再应用。

  // 总开关关掉：不再注入，并且把已经注入的节点全部遮蔽掉 ——
  // 否则「关了开关」只是不再新增，旧内容还留在模型的上下文里。
  if (!injectionEnabled()) {
    const injected = manualContextNodes(session)
    if (injected.size === 0) {
      return { added: 0, removed: 0, reordered: false, total: 0, deferred: 0, disabled: true }
    }
    try {
      deleteMessages(ctx, sessionId, [...injected.values()])
      return { added: 0, removed: injected.size, reordered: false, total: 0, deferred: 0, disabled: true }
    } catch (error) {
      // 旧格式会话空闲时写不了：交给上层排队，下一次对话开始时再清。
      if (error !== null && typeof error === 'object' && error.code === 'session-write-pending') {
        return { added: 0, removed: 0, reordered: false, total: 0, deferred: 1, disabled: true }
      }
      throw error
    }
  }

  const targets = planTargets(cwd)
  const present = manualContextNodes(session)
  const wanted = new Set(targets.map(function (item) { return item.id }))
  const removed = []
  for (const [id, seq] of present) if (!wanted.has(id)) removed.push(seq)
  const added = targets.filter(function (item) { return !present.has(item.id) })

  const deferred = []
  const isPending = function (error) {
    return error !== null && typeof error === 'object' && error.code === 'session-write-pending'
  }
  let addedCount = 0
  let removedCount = 0
  let reordered = false

  if (removed.length > 0) {
    try {
      deleteMessages(ctx, sessionId, removed)
      removedCount = removed.length
    } catch (error) {
      if (!isPending(error)) throw error
      deferred.push('remove:' + String(removed.length))
    }
  }
  for (const target of added) {
    try {
      appendMessage(ctx, sessionId, specOf(target))
      addedCount += 1
    } catch (error) {
      if (!isPending(error)) throw error
      deferred.push(target.id)
    }
  }
  try {
    reordered = reorderIfNeeded(ctx, sessionId, session, targets)
  } catch (error) {
    if (!isPending(error)) throw error
    deferred.push('reorder')
  }
  return {
    added: addedCount,
    removed: removedCount,
    reordered,
    total: targets.length,
    deferred: deferred.length,
  }
}

/** 当前模型可见历史的消息 id 集合与拼接文本。 */
export function historyIndex(agent) {
  const ids = new Set()
  const parts = []
  try {
    for (const message of agent.session.deriveMessages()) {
      if (message !== null && typeof message.id === 'string') ids.add(message.id)
      for (const block of message?.content ?? []) {
        if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
      }
    }
  } catch {
    // 读不到历史时按空处理
  }
  // 已经排队、但还没写进日志的节点也算「已在上下文中」，否则每轮都会重复排队。
  try {
    for (const operation of loadQueue(agent?.id)) {
      const id = operation?.payload?.id
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
  } catch {
    // 队列读不到就按空处理
  }
  return { ids, text: parts.join('\n') }
}

/** 该条目此刻是否已经同步进模型可见上下文（至少一段在）。 */
export function isPresent(meta, index) {
  const base = entryMessageId(meta, 0)
  for (const id of index.ids) {
    if (id === base || id.indexOf(base + ':') === 0) return true
  }
  // 兼容早期版本：user 类型靠正文里的标记去重
  return meta.role === 'user' && index.text.includes(entryMarker(meta))
}

/** 当前还缺哪些条目的哪些段（供状态接口展示「未注入」）。 */
export function missingEntries(cwd, agent) {
  const index = historyIndex(agent)
  const missing = []
  for (const meta of listEntries(cwd)) {
    let entry
    try {
      entry = readEntry(cwd, meta.id)
    } catch {
      continue
    }
    if (entry.enabled === false) continue
    const pending = entrySegments(entry).filter(function (spec) {
      if (spec.role === 'user' && index.ids.has(entryMessageId(entry))) return false
      return !index.ids.has(spec.id)
    })
    if (pending.length > 0) missing.push({ entry, specs: pending })
  }
  return missing
}

/** 安装 agent/pre-step 钩子：把「同步手动上下文」排进下一轮请求的合法窗口。 */
export function installInjection(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision === null || decision === undefined || decision.kind !== 'enter') return decision
    try {
      if (payload.step !== 1) return decision
      const sessionId = payload.agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') return decision
      // pre-step 发生在 step/start 之前：那时写日志必然非法，所以只排队。
      const queued = loadQueue(sessionId)
      if (!queued.some(function (item) { return item.op === 'sync-context' })) {
        enqueueOperation(sessionId, { op: 'sync-context' })
      }
    } catch {
      // 排队失败不该影响这一轮对话
    }
    return decision
  })
}
export default { installInjection, syncManualContext, planTargets, entryMessageId, entrySegments, historyIndex, isPresent, missingEntries, MARKER, ID_PREFIX }
