/**
 * 对话历史编辑。
 *
 * Harness 的会话日志是只追加的，模型可见历史由 session surface 折叠得到。
 * 编辑一条历史消息的做法与内置压缩完全一致：追加一个同/surface 可替换的事件，
 * 用 `surfaceOp: { op: 'replace', startSeq, endSeq }` 遮蔽原节点：
 *
 *   - 普通节点（用户输入 / 模型输出 / 工具输出）用 `user/message` 替换
 *   - surface 第 0 个节点若是系统提示词，则必须用 `system/message` 替换，且恰好 1 个节点
 *
 * 每次编辑同时按会话落盘到 $DSH_HOME/manual-context-edits/<sessionId>.json，
 * 因此修改状态独立于上下文压缩而保留，压缩后仍可查看与再次应用。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { freezeMessage, messageText, messageReasoning, hasReasoning, messageToolCalls, toolResultText } from './freeze.js'
import { dshHome } from './store.js'

const EDIT_DIR_NAME = 'manual-context-edits'
const MAX_TEXT = 400000

/**
 * 当前生产者归属。
 *
 * v4 会话格式不接受裸 `kind: 'plugin'`（`assertV4SourceRowAdmission` 直接拒绝），
 * 而 v3→v4 迁移会把 v3 的 `{kind:'plugin', plugin:'<name>'}` 提升成 `plugin:<name>`。
 * 所以两种格式下都直接写这个「已提升」的 kind。
 */
export const PRODUCER_KIND = 'plugin:@dsh-external/manual-context'

/**
 * 会话当前没有开放的 turn/step：这次写入必须排队，等下一轮请求（step 已开）再执行。
 * HTTP 层据此把操作入队而不是报错，见 `loadQueue` / `enqueueOperation`。
 */
export class SessionWritePendingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SessionWritePendingError'
    this.code = 'session-write-pending'
  }
}

/** 编辑记录落盘目录。 */
export function editsDir() {
  return join(dshHome(), EDIT_DIR_NAME)
}

/**
 * 把排队操作的应用结果追加到队列目录旁的 apply.log。
 *
 * 「一直显示排队中、对话里却没注入」这类问题只看队列文件看不出原因，
 * 有了这份流水就能直接看到每次尝试的结果与失败原因。
 */
export function appendApplyLog(sessionId, text) {
  try {
    const dir = editsDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'apply.log'), new Date().toISOString() + ' [' + sessionId + '] ' + text + '\n', 'utf8')
  } catch {
    // 记日志失败不影响主流程
  }
}

function editsFile(sessionId) {
  return join(editsDir(), encodeURIComponent(sessionId) + '.json')
}

/** 读取某会话已保存的编辑记录。 */
export function loadEdits(sessionId) {
  try {
    const path = editsFile(sessionId)
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed?.edits) ? parsed.edits : []
  } catch {
    return []
  }
}

/** 覆盖写入某会话的编辑记录。 */
export function saveEdits(sessionId, edits) {
  const dir = editsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(editsFile(sessionId), JSON.stringify({ sessionId, edits, updatedAt: Date.now() }, null, 2), 'utf8')
}

/** 排队操作文件名（与编辑记录同目录的独立文件，互不影响）。 */
function queueFile(sessionId) {
  return join(editsDir(), encodeURIComponent(sessionId) + '.queue.json')
}

/** 读取某会话排队中的操作（空闲时的编辑 / 注入，等下一轮请求组装时应用）。 */
export function loadQueue(sessionId) {
  try {
    const path = queueFile(sessionId)
    if (!existsSync(path)) return []
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed?.operations) ? parsed.operations : []
  } catch {
    return []
  }
}

/** 覆盖写入某会话的排队操作；空队列直接删文件。 */
export function saveQueue(sessionId, operations) {
  const path = queueFile(sessionId)
  if (!Array.isArray(operations) || operations.length === 0) {
    try {
      if (existsSync(path)) rmSync(path)
    } catch {
      // 删不掉就留个空队列，不影响正确性
    }
    return
  }
  const dir = editsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify({ sessionId, operations, updatedAt: Date.now() }, null, 2), 'utf8')
}

/** 把一次空闲操作排进队列。 */
export function enqueueOperation(sessionId, operation) {
  const next = loadQueue(sessionId)
  next.push({ ...operation, requestedAt: Date.now() })
  saveQueue(sessionId, next)
  return next
}

/** 列出有排队操作的会话 id。 */
export function listQueuedSessions() {
  try {
    const dir = editsDir()
    if (!existsSync(dir)) return []
    const suffix = '.queue.json'
    return readdirSync(dir).filter(name => name.endsWith(suffix))
      .map(name => decodeURIComponent(name.slice(0, -suffix.length)))
  } catch {
    return []
  }
}

/** 统计落盘了编辑记录的会话。 */
export function listEditedSessions() {
  try {
    const dir = editsDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => decodeURIComponent(name.slice(0, -5)))
  } catch {
    return []
  }
}

function labelOf(kind) {
  switch (kind) {
    case 'system': return '系统提示词'
    case 'user': return '用户输入'
    case 'assistant': return '模型输出'
    case 'tool': return '工具输出'
    case 'reasoning': return '思维链'
    case 'tool-call': return '工具调用'
    case 'tool-result': return '工具返回'
    default: return kind
  }
}

function kindOf(type) {
  switch (type) {
    case 'system/message': return 'system'
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'tool/result': return 'tool'
    default: return 'other'
  }
}

/**
 * 按消息本身判断类型。
 *
 * 编辑历史消息时会用一个新事件承载原角色的消息（例如用 user/message 承载
 * role=assistant 的消息），此时事件类型不再等于消息角色，所以必须以消息为准，
 * 否则面板会把编辑过的模型输出标成「用户输入」。
 */
function kindFromMessage(message, eventType) {
  const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-result') return 'tool'
  }
  const role = message !== null && typeof message === 'object' ? message.role : undefined
  if (role === 'system') return 'system'
  if (role === 'assistant') return 'assistant'
  if (role === 'user') return 'user'
  return kindOf(eventType)
}

/**
 * 把一条消息拆成可独立操作的片段。
 *
 * 真实的模型输出常常是「思维链 + 正文 + 一个或多个工具调用」压在**同一条**
 * assistant 消息里（日志实测 content = [reasoning, text, tool-call, tool-call]）。
 * 面板需要把它们拆开显示、分开编辑与删除，否则工具调用会被埋在模型输出里。
 *
 * @returns 片段数组，每项带 `index`（在 content 里的下标）与展示信息。
 */
export function messageParts(message, kind) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === null || typeof block !== 'object') continue
    const type = typeof block.type === 'string' ? block.type : 'block'
    if (type === 'text') {
      // v4 的一等 tool/result：content 里只有普通 text 块，配对 id 在 message.toolCallId 上。
      // 首个片段补上 callId，导出/导入才不会把工具返回变成孤儿。
      const carried = typeof message?.toolCallId === 'string' && message.toolCallId !== '' ? message.toolCallId : ''
      const part = { index, type, kind, label: labelOf(kind), text: typeof block.text === 'string' ? block.text : '' }
      if (carried !== '' && parts.length === 0) part.callId = carried
      parts.push(part)
      continue
    }
    if (type === 'reasoning') {
      parts.push({ index, type, kind: 'reasoning', label: '思维链', text: typeof block.text === 'string' ? block.text : '' })
      continue
    }
    if (type === 'tool-call') {
      const raw = block.arguments !== undefined ? block.arguments : block.input
      parts.push({
        index,
        type,
        kind: 'tool-call',
        label: '工具调用',
        text: '',
        toolName: String(block.name ?? block.toolName ?? ''),
        toolInput: typeof raw === 'string' ? raw : (raw === undefined || raw === null ? '' : JSON.stringify(raw)),
        callId: String(block.id ?? block.toolCallId ?? ''),
      })
      continue
    }
    if (type === 'tool-result') {
      parts.push({
        index,
        type,
        kind: 'tool-result',
        label: '工具返回',
        text: toolResultText(block),
        callId: String(block.toolCallId ?? ''),
        isError: block.isError === true,
      })
      continue
    }
    parts.push({ index, type, kind, label: type, text: '' })
  }
  return parts
}

/** 取会话日志快照（兼容 deprecated 读取 API 与替代 getter）。 */
export function sessionEvents(session) {
  if (typeof session.snapshotEvents === 'function') return [...session.snapshotEvents()]
  if (Array.isArray(session.events)) return [...session.events]
  if (typeof session.eventAt === 'function') {
    const out = []
    for (let seq = 0; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq)
      if (event !== undefined) out.push(event)
    }
    return out
  }
  throw new Error('无法读取会话事件日志')
}

/**
 * 列出当前模型可见的全部历史消息（surface 顺序）。
 * @returns 每条消息的 seq、类型、当前文本、工具调用与编辑状态。
 */
export function listHistoryMessages(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  const events = sessionEvents(session)
  const nodes = [...session.surface.nodes]
  const edits = loadEdits(sessionId)
  const editedSeqs = new Set(edits.map(edit => edit.replacedSeq))
  // 排队中的删除：这些节点还在 surface 上，但下一次请求组装时会被摘掉。
  // 面板要如实标出来，否则用户分不清「删掉了」和「排着队还没删」。
  const queued = loadQueue(sessionId)
  const pendingDeletes = new Set()
  for (const operation of queued) {
    if (operation?.op !== 'delete-messages') continue
    for (const target of operation?.payload?.seqs ?? []) if (Number.isSafeInteger(target)) pendingDeletes.add(target)
  }
  const messages = []
  for (const seq of nodes) {
    const event = events[seq]
    if (event === undefined) continue
    let message = null
    try {
      message = session.deriveEventMessage(event)
    } catch {
      message = null
    }
    if (message === null) continue
    const kind = kindFromMessage(message, event.type)
    messages.push({
      seq,
      type: event.type,
      kind,
      label: labelOf(kind),
      role: message.role,
      time: event.time,
      text: messageText(message),
      reasoning: messageReasoning(message),
      hasReasoning: hasReasoning(message),
      blocks: message.content,
      parts: messageParts(message, kind),
      toolCalls: messageToolCalls(message),
      // v4 的一等 tool/result 把配对 id 放在 message.toolCallId 上（content 里没有 tool-result 块），
      // 不单独带出来的话导出文件就丢了配对信息，导回去时工具返回会变成孤儿。
      toolCallId: typeof message?.toolCallId === 'string' && message.toolCallId !== '' ? message.toolCallId : null,
      edited: editedSeqs.has(seq),
      editedAt: edits.find(edit => edit.replacedSeq === seq)?.updatedAt ?? null,
      pendingDelete: pendingDeletes.has(seq),
      protected: nodes[0] === seq && event.type === 'system/message',
    })
  }
  return { sessionId, nodes, messages, edits, queued }
}

/** 保留原有块结构，只把文本内容换成新值。 */
function rewriteContent(original, text) {
  const blocks = Array.isArray(original?.content) ? original.content : []
  // tool/result 的文本藏在块的 content 里
  if (blocks.length === 1 && blocks[0] !== null && typeof blocks[0] === 'object' && blocks[0].type === 'tool-result') {
    return [{ ...blocks[0], content: text === '' ? [] : [{ type: 'text', text }] }]
  }
  const kept = blocks.filter(function (block) {
    return block !== null && typeof block === 'object' && block.type !== 'text'
  })
  if (text === '') return kept.length > 0 ? kept : [{ type: 'text', text: '' }]
  return [{ type: 'text', text }, ...kept]
}

/** 把思维链写进内容块：替换已有的 reasoning 块，没有就插到最前面。 */
function withReasoning(content, reasoning) {
  const blocks = Array.isArray(content) ? content : []
  const at = blocks.findIndex(function (block) {
    return block !== null && typeof block === 'object' && block.type === 'reasoning'
  })
  if (at >= 0) {
    const next = [...blocks]
    next[at] = { ...blocks[at], text: reasoning }
    return next
  }
  if (reasoning === '') return blocks
  return [{ type: 'reasoning', text: reasoning }, ...blocks]
}

const PLUGIN_ID = '@dsh-external/manual-context'

/**
 * 会话日志的形状规则 —— 与 dsh-session 的 `assertMessageEventShape` 一一对应。
 *
 * 这些规则**只在重启加载会话时**执行。运行时写一条不合规的事件不会立刻报错，
 * 但下次打开这个会话就是：
 *   stored session "…" is corrupt: … message must have role "user"
 * 所以每次写日志前先自检，宁可不写。
 *
 *   user/message      → role 必须 'user'（**不能**用它承载 assistant 消息）
 *   assistant/message → role 必须 'assistant'，source 必须 model + provider/model，
 *                       data 要有 turn/step/stream，且**不能携带 sourceEventSeqs**
 *                       —— 也就是说 assistant 消息做不了 surface 替换
 *   tool/result       → role 必须 'user'，source 必须 tool + callId，
 *                       content 恰好一个 tool-result 块且 toolCallId 与 callId 一致
 *   system/message    → role 必须 'system'，source 必须 plugin
 */
const ROLE_BY_TYPE = {
  'system/message': 'system',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'user',
}

/** 写日志前自检；不合规直接抛错，绝不落盘。 */
function assertWritableEvent(type, data, version = 3) {
  // v4 的 tool/result 是 role:'tool' 的一等消息（v3 用 user + tool-result 包装块）
  const expected = type === 'tool/result' && version >= 4 ? 'tool' : ROLE_BY_TYPE[type]
  if (expected === undefined) throw new Error('内部错误：不支持写入 ' + type)
  const record = data !== null && typeof data === 'object' ? data : {}
  const message = type === 'user/message' ? record : record.message
  if (message === null || typeof message !== 'object') throw new Error('内部错误：' + type + ' 缺少消息实体')
  if (message.role !== expected) {
    throw new Error('内部错误：' + type + ' 的消息角色必须是 ' + expected
      + '（实际 ' + String(message.role) + '）；写下去会让会话在重启后判定为损坏')
  }
  if (typeof message.id !== 'string' || message.id === '') throw new Error('内部错误：' + type + ' 的消息缺少 id')
  const source = message.source
  if (source === null || typeof source !== 'object' || typeof source.kind !== 'string' || source.kind === '') {
    throw new Error('内部错误：' + type + ' 的消息缺少 source.kind')
  }
  if (!Array.isArray(message.content)) throw new Error('内部错误：' + type + ' 的消息缺少 content 数组')
  // v4 会拒绝裸 kind:'plugin'（assertV4SourceRowAdmission），统一写提升后的生产者 kind。
  if (source.kind === 'plugin') throw new Error('内部错误：' + type + ' 的 source 不能是裸 plugin（v4 会拒绝），请用 ' + PRODUCER_KIND)
  if (type === 'assistant/message') {
    if (source.kind !== 'model' || typeof source.provider !== 'string' || source.provider === ''
      || typeof source.model !== 'string' || source.model === '') {
      throw new Error('内部错误：assistant/message 的 source 必须是 model + provider/model')
    }
    if (!Number.isSafeInteger(record.turn) || !Number.isSafeInteger(record.step) || !Array.isArray(record.stream)) {
      throw new Error('内部错误：assistant/message 缺少 turn/step/stream')
    }
  }
  if (type === 'tool/result') {
    if (source.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') {
      throw new Error('内部错误：tool/result 的 source 必须是 tool + callId')
    }
    if (version >= 4) {
      if (typeof message.toolCallId !== 'string' || message.toolCallId === '' || message.toolCallId !== source.callId) {
        throw new Error('内部错误：v4 的 tool/result 需要 toolCallId 且与 source.callId 一致')
      }
      if (message.content.some(function (block) {
        return block !== null && typeof block === 'object' && block.type === 'tool-result'
      })) {
        throw new Error('内部错误：v4 的 tool/result 不能再嵌 tool-result 块')
      }
      return
    }
    const block = message.content[0]
    if (message.content.length !== 1 || block === null || typeof block !== 'object'
      || block.type !== 'tool-result' || !Array.isArray(block.content)) {
      throw new Error('内部错误：tool/result 必须只含一个 tool-result 块')
    }
    if (block.toolCallId !== source.callId) throw new Error('内部错误：tool/result 的 toolCallId 与 source.callId 不一致')
  }
}

/** 按事件类型把消息补成合法形状（老日志可能缺 role / provider / plugin）。 */
function normalizeForWrite(type, message, identity, version) {
  const next = { ...message }

  // v4 的 tool/result 是 role:'tool' 的一等消息，content 直接是内容块；
  // v3 才是 role:'user' + 一个 tool-result 包装块。这里必须按会话版本转换，
  // 否则在 v4 会话里重放工具返回会写出 role:'user' 的 tool/result，
  // 被自己的 assertWritableEvent 拦下（"角色必须是 tool（实际 user）"）。
  if (type === 'tool/result' && Number.isSafeInteger(version) && version >= 4) {
    const raw = next.source !== null && typeof next.source === 'object' ? next.source : {}
    const callId = typeof next.toolCallId === 'string' && next.toolCallId !== ''
      ? next.toolCallId
      : (typeof raw.callId === 'string' && raw.callId !== '' ? raw.callId : '')
    const content = []
    let isError = next.isError === true
    for (const block of Array.isArray(next.content) ? next.content : []) {
      if (block !== null && typeof block === 'object' && block.type === 'tool-result') {
        // 老形状的包装块：把里面的内容摊平出来
        for (const inner of Array.isArray(block.content) ? block.content : []) content.push(inner)
        if (block.isError === true) isError = true
        continue
      }
      content.push(block)
    }
    next.role = 'tool'
    next.toolCallId = callId
    next.content = content
    next.source = { kind: 'tool', callId }
    if (isError) next.isError = true
    else delete next.isError
    return next
  }

  const expected = ROLE_BY_TYPE[type]
  if (next.role !== expected) next.role = expected
  const raw = next.source
  const source = raw !== null && typeof raw === 'object' ? { ...raw } : {}
  if (type === 'assistant/message') {
    source.kind = 'model'
    if (typeof source.provider !== 'string' || source.provider === '') source.provider = identity.provider
    if (typeof source.model !== 'string' || source.model === '') source.model = identity.model
  } else if (type === 'tool/result') {
    source.kind = 'tool'
  } else if (type === 'system/message') {
    source.kind = PRODUCER_KIND
    delete source.plugin
  }
  next.source = source
  if (!Array.isArray(next.content)) next.content = []
  return next
}

/** 按原事件类型构造一条可追加 / 可替换的消息事件（不自检，交给调用方）。 */
function buildCopy(target, message, fallback, identity, version) {
  const type = target.type
  // 坐标必须用**当前**开放坐标：抄原节点的 turn/step 会让同一批事件坐标互相矛盾
  // （实测同一批里 blankOut 带 20/53、tool/result 副本带 20/52），加载期直接判非法。
  const turn = fallback.turn
  const step = fallback.step
  const base = normalizeForWrite(type, message, identity, version)
  let payload
  if (type === 'user/message') payload = base
  else if (type === 'assistant/message') payload = { turn, step, message: base, stream: [] }
  else payload = { turn, step, message: base }
  assertWritableEvent(type, payload, version)
  return { type, payload }
}

/**
 * 重放 / 重排这些节点会不会写出 v4 无法接受的事件。
 *
 * 工具轨迹必须**整组**写：assistant/message（声明 tool-call）→ tool/call → tool/result。
 * 而 tool/call 不是表面事件、不在 surface 上，重放表面节点时天然缺它，
 * 于是 tool/result 副本没有对应的生命周期（迁移报 tool/result … has no advertised tool lifecycle）。
 * 与其写出打不开的日志，不如在这里拒绝。
 */
function assertReplayable(items, version) {
  // v4 的加载校验不检查工具生命周期（实测：遮蔽之后照原 callId 整组重放 tool-call / tool/result 都能通过），
  // 所以 v4 会话允许重放含工具轨迹的历史；v0–v3 加载时要跑迁移器，仍必须拒绝。
  if (Number.isSafeInteger(version) && version >= 4) return
  for (const item of items) {
    const target = item.target
    const message = item.message
    if (target.type === 'tool/result') {
      throw new Error('这段历史包含工具输出（tool/result）：重放它会写出 v4 无法接受的日志（缺配套的 tool/call）。请改用「删除」，或只操作不含工具轨迹的消息。')
    }
    const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (block !== null && typeof block === 'object' && block.type === 'tool-call') {
        throw new Error('这条模型输出里含工具调用（tool-call）：重放它会写出 v4 无法接受的日志（缺配套的 tool/call 与 tool/result）。请改用「删除」，或只操作不含工具轨迹的消息。')
      }
    }
  }
}

/**
 * 用一条空内容的 system/message 遮蔽节点：不投影任何消息（`deriveEventMessage` 对空 content
 * 返回 null），位置保持不变。
 *
 * 为什么必须是 system/message：遮蔽要带 `sourceEventSeqs`，而只有它能带 ——
 * `assistant/message` 带上去会被 v4 拒绝（"embeds its source stream and cannot carry
 * sourceEventSeqs"）。
 *
 * 为什么来源必须是 system-prompt：v4 的存储校验要求 system/message 来自 system-prompt。
 * 以前这里写的是插件来源，于是日志校验失败：
 *   stored session "…" failed validation:
 *   Error: session event at seq N message must have system-prompt source
 * 症状是**会话打不开、界面一片空白而且不报错**。
 */
function blankOut(session, seq, position, tag) {
  const payload = {
    turn: position.turn,
    step: position.step,
    message: {
      id: 'manual-context-' + tag + ':' + String(seq),
      role: 'system',
      content: [],
      source: { kind: 'system-prompt' },
    },
  }
  assertWritableEvent('system/message', payload)
  return session.append('system/message', freezeMessage(payload), {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
}

/** 原位替换：user / tool / system 消息直接写一条同类型事件。 */
function replaceInPlace(session, seq, target, original, content, identity) {
  const type = target.type
  const version = sessionFormatVersion(session)
  const data = target.data !== null && typeof target.data === 'object' ? target.data : {}
  const carried = data.message !== null && typeof data.message === 'object' ? data.message : null
  let message
  if (type === 'tool/result') {
    // dsh 的硬规则：tool/result 的 surface 替换**只允许改 content**。
    // 所以这里直接拿原事件的 message 做底（保住 id / role / source / toolCallId / isError），
    // 既不换 id，也不走 normalizeForWrite 重建 —— 重建会把 isError 之类的字段抹掉，
    // 一样算「改了 content 以外的东西」。
    const base = carried !== null ? carried : (original !== null && typeof original === 'object' ? original : {})
    message = { ...base, content }
  } else {
    // 其余类型可以被替换成新节点，用新 id 标记成「编辑产物」。
    // version 必须一起传：v4 的 tool/result 是 role:'tool' 的一等消息，少了它就会按 v3
    // 老形状补成 role:'user'，然后被自己的 assertWritableEvent 拦下。
    message = normalizeForWrite(type, {
      ...(original !== null && typeof original === 'object' ? original : {}),
      id: 'manual-context-edit:' + randomUUID(),
      content,
    }, identity, version)
  }
  const payload = type === 'user/message' ? message : { ...data, message }
  assertWritableEvent(type, payload, version)
  return session.append(type, freezeMessage(payload), {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
}

/**
 * 当前可见历史里最后一个「声明了、但还没有返回」的工具调用 id。
 *
 * 面板手动追加工具返回时，如果用户没指定 callId，就自动接上它 —— 否则工具返回会拿到一个
 * 随机 callId，和前面的工具调用配不上对，模型侧直接拒（tool result has no matching call）。
 */
function lastUnansweredCallId(session) {
  const events = sessionEvents(session)
  const declared = []
  const answered = new Set()
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (event === undefined) continue
    let message = null
    try { message = session.deriveEventMessage(event) } catch { continue }
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'tool-call' && typeof block.id === 'string' && block.id !== '') declared.push(block.id)
      if (block.type === 'tool-result' && typeof block.toolCallId === 'string' && block.toolCallId !== '') answered.add(block.toolCallId)
    }
  }
  for (let index = declared.length - 1; index >= 0; index -= 1) {
    if (!answered.has(declared[index])) return declared[index]
  }
  return null
}

/**
 * 一次重放最多允许改写的尾部长度。
 *
 * 模型输出（assistant/message）在 dsh 里**无条件**不允许携带 sourceEventSeqs
 * （dsh-session 的 assertSourceEventReferences），而那是 surface 替换的必需标记 ——
 * 所以改写它只有「遮蔽原节点 + 按原顺序重新追加」这一条合法路径，尾部多长就得重放多长。
 *
 * 这个上限只是防止一次操作把日志撑爆的护栏，不是 dsh 的限制：放宽到 2000，
 * 真超了也照实说明要重放多少条，让用户自己决定。
 */
const REPLAY_LIMIT = 2000

/**
 * 改写一条 **assistant** 消息。
 *
 * assistant/message 不允许携带 sourceEventSeqs，所以它做不了 surface 替换 —— 唯一合法的
 * 做法是「遮蔽原节点 + 把这一段按原顺序重新追加」，编辑过的那条换成新内容。
 * 可见顺序与原顺序完全一致，只是这些节点都换成了新的 seq。
 *
 * @returns 编辑后那条消息的新 seq。
 */
function replayTail(session, nodes, seq, content, identity) {
  const at = nodes.indexOf(seq)
  if (at < 0) throw new Error('该消息已不在当前模型可见上下文中（可能已被压缩），无法直接替换')
  const tail = nodes.slice(at)
  if (tail.length > REPLAY_LIMIT) {
    // 只在这条真的长到会拖垮日志时才拒绝，并把「为什么要重放、重放多少条」说清楚。
    throw new Error('这条消息后面还有 ' + String(tail.length - 1) + ' 条，改写模型输出必须把它们整段重放'
      + '（dsh 规定 assistant/message 不能做原位替换，只能遮蔽后按原顺序重新追加）。'
      + '单次上限是 ' + String(REPLAY_LIMIT) + ' 条，超过了。'
      + '可以先把靠后的历史删掉一些，或者改更靠后的消息。')
  }
  const events = sessionEvents(session)
  const position = writablePosition(session, 'system')
  const version = sessionFormatVersion(session)
  const plans = tail.map(function (nodeSeq) {
    const target = events[nodeSeq]
    if (target === undefined) throw new Error('消息 seq ' + String(nodeSeq) + ' 不存在')
    const message = session.deriveEventMessage(target)
    if (message === null || typeof message !== 'object') throw new Error('seq ' + String(nodeSeq) + ' 没有可重放的消息内容')
    return { seq: nodeSeq, target, message }
  })
  assertReplayable(plans.map(function (plan) {
    return { target: plan.target, message: plan.message }
  }), version)
  // 构造阶段全部走完再动日志：任何一条不合法都不会留下半截改动
  const built = plans.map(function (plan) {
    const body = plan.seq === seq ? content : (Array.isArray(plan.message.content) ? plan.message.content : [])
    return buildCopy(plan.target, {
      ...plan.message,
      // 保留原 message.id：节点身份是同步/去重与「已编辑」标记的依据，换了 id 就认不出来了
      id: typeof plan.message.id === 'string' && plan.message.id !== '' ? plan.message.id : 'manual-context-edit:' + randomUUID(),
      content: body,
    }, position, identity, version)
  })
  for (const plan of plans) blankOut(session, plan.seq, position, 'replay')
  let replacedSeq = null
  plans.forEach(function (plan, index) {
    const created = session.append(built[index].type, freezeMessage(built[index].payload), { surfaceOp: 'append' })
    if (plan.seq === seq) replacedSeq = created.seq
  })
  return replacedSeq
}

/** 取会话对应 agent 的模型身份，用于补齐 assistant 消息的 source。 */
function identityFor(ctx, sessionId) {
  try {
    const list = ctx.agents?.list?.() ?? []
    return modelIdentity(list.find(function (item) { return item.id === sessionId }))
  } catch {
    return modelIdentity(undefined)
  }
}

/**
 * 用新内容替换一条历史消息（追加 surface replace 事件）。
 * @returns 新的替换节点 seq。
 */
export function applyEdit(ctx, sessionId, seq, text, expectedText, blocks, reasoning) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  const asBlocks = Array.isArray(blocks)
  if (!asBlocks && typeof text !== 'string' && typeof reasoning !== 'string') {
    throw new Error('text 必须是字符串')
  }
  if (typeof text === 'string' && text.length > MAX_TEXT) throw new Error('内容过长')
  const events = sessionEvents(session)
  const target = events[seq]
  if (target === undefined) throw new Error('消息 seq ' + String(seq) + ' 不存在')
  const nodes = [...session.surface.nodes]
  if (!nodes.includes(seq)) throw new Error('该消息已不在当前模型可见上下文中（可能已被压缩），无法直接替换')
  if (expectedText !== undefined && typeof expectedText === 'string') {
    let current = ''
    try {
      current = messageText(session.deriveEventMessage(target))
    } catch {
      current = ''
    }
    if (current !== expectedText) throw new Error('该消息内容已变化，请刷新后重试')
  }
  // 系统提示词每轮由 Harness 重新渲染（agent-loop 的 SystemPromptProjection
  // 会在请求组装时把 surface 头节点写回渲染结果），替换无法存活，直接拒绝并给出出路。
  if (nodes[0] === seq && target.type === 'system/message') {
    throw new Error('系统提示词由 Harness 在每轮请求前重新渲染，无法被替换改写。想让它每轮生效，请写进手动上下文（role: user）。')
  }
  const original = session.deriveEventMessage(target)
  let content
  if (asBlocks) content = blocks
  else if (typeof text === 'string') content = rewriteContent(original, text)
  else content = Array.isArray(original?.content) ? [...original.content] : []
  if (typeof reasoning === 'string') content = withReasoning(content, reasoning)
  const identity = identityFor(ctx, sessionId)
  // assistant/message 不能携带 sourceEventSeqs、做不了替换，只能「遮蔽 + 尾部重放」
  const replacedSeq = target.type === 'assistant/message'
    ? replayTail(session, nodes, seq, content, identity)
    : replaceInPlace(session, seq, target, original, content, identity).seq
  const edits = loadEdits(sessionId)
  const next = edits.filter(edit => edit.replacedSeq !== seq)
  next.push({
    seq,
    replacedSeq,
    targetType: target.type,
    targetText: text,
    protected: false,
    updatedAt: Date.now(),
  })
  saveEdits(sessionId, next)
  return { seq, replacedSeq, edits: next }
}

/**
 * 会话当前**开放**的 turn/step，以及下一个可用编号。
 *
 * 加载期（v3→v4 迁移与 v4 原生恢复）强制：system/message、assistant/message、
 * assistant/attempt、developer/message、tool/call 与追加的 tool/result 必须匹配开放的
 * turn+step；替换形式的 tool/result 只要求开放 turn；user/message 无要求。
 * 上一次 turn/end 之后这些都为 null —— 此时写进去的东西会让会话下次直接打不开。
 */
export function openCoordinates(session) {
  let turn = null
  let step = null
  let nextTurn = 1
  let nextStep = 1
  for (const event of sessionEvents(session)) {
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'turn/start') {
      turn = Number.isSafeInteger(data.turn) ? data.turn : null
      step = null
      if (turn !== null) nextTurn = turn + 1
      nextStep = 1
      continue
    }
    if (event.type === 'turn/end') {
      turn = null
      step = null
      continue
    }
    if (event.type === 'step/start') {
      step = Number.isSafeInteger(data.step) ? data.step : null
      if (step !== null) nextStep = step + 1
      continue
    }
    if (event.type === 'step/end') step = null
  }
  return { turn, step, nextTurn, nextStep }
}

/** 会话的会话格式版本（拿不到就按旧格式 3 处理，保持既有形状）。 */
export function sessionFormatVersion(session) {
  const version = session?.header?.version
  return Number.isSafeInteger(version) ? version : 3
}

/**
 * 本次写入要用的坐标。
 *
 * 空闲时（上一次 turn/end 之后）没有开放 turn/step：写入必须**推迟**，
 * 于是这里抛 SessionWritePendingError，由 HTTP 层把操作排队，
 * 等下一轮 agent/request（step 已经打开）再执行。
 */
function writePosition(session, options) {
  const needStep = options?.needStep !== false
  const open = openCoordinates(session)
  if (needStep ? (open.turn === null || open.step === null) : open.turn === null) {
    throw new SessionWritePendingError('会话当前不在进行中（上一次对话已结束）：这次改动已排队，将在下一次请求组装时自动应用。')
  }
  if (needStep) return { turn: open.turn, step: open.step }
  return { turn: open.turn, step: open.step === null ? 1 : open.step }
}

/**
 * 取本次写入要用的 turn/step 坐标 —— 和历史编辑**完全同一条路**。
 *
 * 会话空闲（上一次 turn/end 之后、或新建对话还没开始）时没有开放的 turn/step，
 * 写进去的表面事件会落在 turn 之外，会话下次就打不开（本轮坏掉的那几个会话
 * 就是这么来的）。所以这里一律抛 SessionWritePendingError，由 HTTP 层排队、
 * 等下一轮 agent/request（step 已经打开）再写。
 *
 * 曾经这里对 v4 做过「坐标回退到日志里最后一次出现的 turn/step」的放行，
 * 那是错的：v4 一样会校验 turn 关系，放行只会写出打不开的日志。
 */
function writablePosition(session) {
  // 注意：user/message 在 v4 里确实不要求 turn/step 关系，空闲时也写得进去 ——
  // 但它会成为 surface 的第一个节点，等系统提示词随后写进来，整份日志就通不过
  // 「system/message requires a protected first surface head」。所以这里**所有**类型
  // 一视同仁：没有开放的 turn/step 就抛 SessionWritePendingError，交给上层排队。
  const open = writePosition(session)
  return { turn: open.turn, step: open.step }
}

function modelIdentity(agent) {
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  return {
    provider: typeof provider === 'string' && provider !== '' ? provider : 'manual',
    model: typeof model === 'string' && model !== '' ? model : 'manual',
  }
}

/**
 * 手动向模型可见上下文末尾追加一条消息。
 *
 * 追加使用 surfaceOp: 'append'，不遮蔽任何已有节点，因此不影响历史编辑。
 * @param spec.kind - 'user' | 'assistant' | 'tool-call' | 'tool-result'
 * @returns 新节点的 seq。
 */
export function appendMessage(ctx, sessionId, spec) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  const kind = typeof spec?.kind === 'string' ? spec.kind : ''
  const text = typeof spec?.text === 'string' ? spec.text : ''
  // 合并消息可以只有 reasoning / tool-call 块而没有纯文本，所以空文本检查要看有没有块。
  const blocks = Array.isArray(spec?.blocks) ? spec.blocks : []
  if (kind !== 'tool-call' && blocks.length === 0 && text.trim() === '') throw new Error('内容不能为空')
  // user/message 随时可写；其余表面事件必须在**当前开放**的 turn/step 内。
  // 不再采纳调用方传入的 turn/step —— 那些坐标正是空闲注入写出坏日志的原因。
  const position = writablePosition(session)
  const agent = spec?.agent ?? (ctx.agents?.list?.() ?? []).find(item => item.id === sessionId)
  const identity = modelIdentity(agent)
  // 消息 id 可由调用方指定：手动上下文用它承载条目 hash，从而无需污染正文即可去重。
  const messageId = typeof spec?.id === 'string' && spec.id !== '' ? spec.id : randomUUID()

  if (kind === 'user') {
    const appended = session.append('user/message', freezeMessage({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: PRODUCER_KIND, form: 'instructions' },
    }), { surfaceOp: 'append' })
    return { seq: appended.seq, kind }
  }

  // 多块合并：把「思维链 / 正文 / 工具调用」写成**一条** assistant/message，
  // 与真实回复的形状一致（模型看到的就是这种消息）。
  if (kind === 'assistant' && blocks.length > 0) {
    const content = []
    const stream = []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      const at = content.length
      if (block.type === 'reasoning') {
        const value = String(block.text ?? '')
        content.push({ type: 'reasoning', text: value })
        stream.push({ type: 'reasoning-chunks', time0: Date.now(), index: at, dt: [0], texts: [value] })
        continue
      }
      if (block.type === 'tool-call') {
        let args = '{}'
        const raw = block.args
        if (typeof raw === 'string' && raw.trim() !== '') {
          try {
            args = JSON.stringify(JSON.parse(raw))
          } catch {
            args = JSON.stringify({ input: raw })
          }
        } else if (raw !== undefined && raw !== null && typeof raw === 'object') {
          args = JSON.stringify(raw)
        }
        content.push({ type: 'tool-call', id: block.callId, name: block.name, arguments: args })
        stream.push({ type: 'tool-call-chunks', time0: Date.now(), index: at, dt: [0], id: block.callId, name: block.name, args: [args] })
        continue
      }
      const value = String(block.text ?? '')
      content.push({ type: 'text', text: value })
      stream.push({ type: 'text-chunks', time0: Date.now(), index: at, dt: [0], texts: [value] })
    }
    if (content.length === 0) throw new Error('内容不能为空')
    const appended = session.append('assistant/message', {
      turn: position.turn,
      step: position.step,
      message: freezeMessage({
        id: messageId,
        role: 'assistant',
        content,
        source: { kind: 'model', ...identity },
      }),
      stream,
    }, { surfaceOp: 'append' })
    return { seq: appended.seq, kind: 'assistant' }
  }

  if (kind === 'reasoning') {
    const appended = session.append('assistant/message', {
      turn: position.turn,
      step: position.step,
      message: freezeMessage({
        id: messageId,
        role: 'assistant',
        content: [{ type: 'reasoning', text }],
        source: { kind: 'model', ...identity },
      }),
      stream: [{ type: 'reasoning-chunks', time0: Date.now(), index: 0, dt: [0], texts: [text] }],
    }, { surfaceOp: 'append' })
    return { seq: appended.seq, kind }
  }

  if (kind === 'assistant') {
    const appended = session.append('assistant/message', {
      turn: position.turn,
      step: position.step,
      message: freezeMessage({
        id: messageId,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', ...identity },
      }),
      stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [0], texts: [text] }],
    }, { surfaceOp: 'append' })
    return { seq: appended.seq, kind }
  }

  if (kind === 'tool-call') {
    const name = typeof spec?.toolName === 'string' && spec.toolName.trim() !== '' ? spec.toolName.trim() : 'manual_tool'
    let args = '{}'
    const raw = spec?.toolInput
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        args = JSON.stringify(JSON.parse(raw))
      } catch {
        args = JSON.stringify({ input: raw })
      }
    } else if (raw !== undefined && raw !== null && typeof raw === 'object') {
      args = JSON.stringify(raw)
    }
    const callId = typeof spec?.callId === 'string' && spec.callId.trim() !== '' ? spec.callId.trim() : 'manual-call-' + randomUUID()
    const content = []
    if (text.trim() !== '') content.push({ type: 'text', text })
    content.push({ type: 'tool-call', id: callId, name, arguments: args })
    const appended = session.append('assistant/message', {
      turn: position.turn,
      step: position.step,
      message: freezeMessage({
        id: messageId,
        role: 'assistant',
        content,
        source: { kind: 'model', ...identity },
      }),
      stream: [{ type: 'tool-call-chunks', time0: Date.now(), index: 0, dt: [0], id: callId, name, args: [args] }],
    }, { surfaceOp: 'append' })
    return { seq: appended.seq, kind, callId }
  }

  if (kind === 'tool-result') {
    const explicit = typeof spec?.callId === 'string' && spec.callId.trim() !== '' ? spec.callId.trim() : ''
    // 没指定 callId 时自动接上「最近一条声明了、但还没有返回」的工具调用。
    // 以前这里会现生成一个随机 callId，结果工具返回和工具调用配不上对，
    // 模型侧直接拒：DeepSeek Messages tool result has no matching call。
    const callId = explicit !== '' ? explicit : lastUnansweredCallId(session)
    if (callId === null) {
      throw new Error('当前上下文里没有「已经声明、还没返回」的工具调用。'
        + '请先追加一条工具调用，工具返回会自动接上它的 callId。')
    }
    const isError = spec?.isError === true
    let message
    if (sessionFormatVersion(session) >= 4) {
      // v4：role:'tool' 的一等消息，content 直接是内容块（不再包 tool-result 包装）
      message = { id: messageId, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], source: { kind: 'tool', callId } }
      if (isError) message.isError = true
    } else {
      const block = { type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }
      if (isError) block.isError = true
      message = { id: messageId, role: 'user', content: [block], source: { kind: 'tool', callId } }
    }
    const appended = session.append('tool/result', {
      turn: position.turn,
      step: position.step,
      message: freezeMessage(message),
    }, { surfaceOp: 'append' })
    return { seq: appended.seq, kind, callId }
  }

  throw new Error('不支持的消息类型: ' + kind)
}

/**
 * 从模型可见上下文里移除若干条消息。
 *
 * surface 无法真正"删节点"，但一条 **空内容** 的 system/message 节点投影不出任何消息
 * （deriveEventMessage 对空 content 返回 null），因此用它遮蔽目标节点即可达到删除效果，
 * 且节点位置保持不变。surface 第 0 个系统提示词不允许删除。
 * @returns 实际删除成功的 seq 列表。
 */
export function deleteMessages(ctx, sessionId, seqs) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  if (!Array.isArray(seqs) || seqs.length === 0) throw new Error('seqs 必须是非空数组')
  const position = writablePosition(session, 'system')
  const deleted = []
  const skipped = []
  for (const seq of seqs) {
    if (!Number.isSafeInteger(seq) || seq < 0) { skipped.push(seq); continue }
    const events = sessionEvents(session)
    const target = events[seq]
    const nodes = [...session.surface.nodes]
    if (target === undefined || !nodes.includes(seq)) { skipped.push(seq); continue }
    if (nodes[0] === seq && target.type === 'system/message') { skipped.push(seq); continue }
    blankOut(session, seq, position, 'deleted')
    deleted.push(seq)
  }
  return { deleted, skipped }
}

/**
 * 删掉一条历史消息里的 **单个片段**（一个 content 块）。
 *
 * 模型输出常常把思维链 / 正文 / 工具调用压在同一条消息里，只想扔掉工具调用时
 * 不该连正文一起删。删完 content 为空的话整条消息就没有意义了，转成整条删除。
 * @returns { mode: 'part' | 'message', seq, replacedSeq?, blocks? }
 */
export function deletePart(ctx, sessionId, seq, index) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('seq 非法')
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('片段下标非法')
  const events = sessionEvents(session)
  const target = events[seq]
  if (target === undefined) throw new Error('消息 seq ' + String(seq) + ' 不存在')
  const nodes = [...session.surface.nodes]
  if (!nodes.includes(seq)) throw new Error('该消息已不在当前模型可见上下文中（可能已被压缩），无法直接替换')
  const original = session.deriveEventMessage(target)
  const blocks = Array.isArray(original?.content) ? original.content : []
  if (index >= blocks.length) throw new Error('片段下标越界')
  const next = blocks.filter(function (_, at) { return at !== index })
  if (next.length === 0) {
    const removed = deleteMessages(ctx, sessionId, [seq])
    return { mode: 'message', seq, ...removed }
  }
  const identity = identityFor(ctx, sessionId)
  const replacedSeq = target.type === 'assistant/message'
    ? replayTail(session, nodes, seq, next, identity)
    : replaceInPlace(session, seq, target, original, next, identity).seq
  const edits = loadEdits(sessionId).filter(function (edit) { return edit.replacedSeq !== seq })
  edits.push({ seq, replacedSeq, targetType: target.type, targetText: '', protected: false, updatedAt: Date.now() })
  saveEdits(sessionId, edits)
  return { mode: 'part', seq, replacedSeq, blocks: next, edits }
}

/**
 * 重排模型可见历史里消息的顺序。
 *
 * surface 的节点顺序是日志顺序、改不了，但可以「遮蔽 + 重新追加」：
 *   1. 求 target 与原顺序的最长公共前缀，这一段原地不动
 *   2. 其余消息先把节点用空 system/message 遮蔽掉（位置留空，不再投影消息）
 *   3. 再按目标顺序把它们的副本 append 到末尾
 * 于是最终可见顺序 = 公共前缀（原位）+ 其余（目标顺序）。
 *
 * 所有事件都在伸手改日志之前构建完毕，构建失败就整体放弃，不会擦一半留一半。
 * @param order - 目标顺序的 seq 列表（只含当前可移动的消息，缺的按原顺序补在末尾）
 */
export function reorderMessages(ctx, sessionId, order) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  if (!Array.isArray(order) || order.length === 0) throw new Error('order 必须是非空数组')
  const list = listHistoryMessages(ctx, sessionId)
  const movable = list.messages.filter(function (item) { return !item.protected }).map(function (item) { return item.seq })
  if (movable.length < 2) return { moved: 0, order: movable }
  const wanted = []
  for (const raw of order) {
    const seq = Number(raw)
    if (!Number.isSafeInteger(seq)) continue
    if (movable.indexOf(seq) < 0) continue
    if (wanted.indexOf(seq) >= 0) continue
    wanted.push(seq)
  }
  for (const seq of movable) if (wanted.indexOf(seq) < 0) wanted.push(seq)
  // 最长公共前缀：这一段的相对位置本来就没变，不用动它们
  let keep = 0
  while (keep < wanted.length && wanted[keep] === movable[keep]) keep += 1
  const moving = wanted.slice(keep)
  if (moving.length === 0) return { moved: 0, order: wanted }
  const events = sessionEvents(session)
  const position = writablePosition(session, 'system')
  const version = sessionFormatVersion(session)
  const identity = identityFor(ctx, sessionId)
  const plans = []
  for (const seq of moving) {
    const target = events[seq]
    if (target === undefined) throw new Error('消息 seq ' + String(seq) + ' 不存在')
    const original = session.deriveEventMessage(target)
    if (original === null || typeof original !== 'object') throw new Error('seq ' + String(seq) + ' 没有可移动的消息内容')
    plans.push({ seq, target, original })
  }
  assertReplayable(plans.map(function (plan) {
    return { target: plan.target, message: plan.original }
  }), version)
  for (const plan of plans) blankOut(session, plan.seq, position, 'moved')
  const replaced = new Map()
  for (const plan of plans) {
    const built = buildCopy(plan.target, {
      ...plan.original,
      // 同样保留原 message.id：重排只是换位置，不该换身份
      id: typeof plan.original.id === 'string' && plan.original.id !== '' ? plan.original.id : 'manual-context-move:' + randomUUID(),
    }, position, identity, version)
    replaced.set(plan.seq, session.append(built.type, freezeMessage(built.payload), { surfaceOp: 'append' }).seq)
  }
  // 被移动的消息如果之前编辑过，把编辑记录改挂到新节点上，标记别丢
  let touched = false
  const edits = loadEdits(sessionId).map(function (edit) {
    const at = replaced.get(edit.replacedSeq)
    if (at === undefined) return edit
    touched = true
    return { ...edit, replacedSeq: at, updatedAt: Date.now() }
  })
  if (touched) saveEdits(sessionId, edits)
  return { moved: plans.length, order: wanted, replaced: Object.fromEntries(replaced) }
}

/** 丢弃一条编辑记录（不撤销已经写入日志的替换节点）。 */
export function forgetEdit(ctx, sessionId, seq) {
  const edits = loadEdits(sessionId)
  const next = edits.filter(edit => edit.replacedSeq !== seq && edit.seq !== seq)
  saveEdits(sessionId, next)
  return { edits: next }
}

/** 清空某会话的全部编辑记录。 */
export function clearEdits(sessionId) {
  saveEdits(sessionId, [])
  return { edits: [] }
}
