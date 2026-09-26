/**
 * 浏览器端与宿主之间的同源 HTTP 接口。
 *
 * 单一路由 /manual-context，用 op 区分操作：
 *   GET  ?op=status&sessionId=…            目录 + 条目 + 注入状态
 *   GET  ?op=file&sessionId=…&id=…         读取单个条目
 *   GET  ?op=history&sessionId=…           当前模型可见的历史消息
 *   GET  ?op=sessions                      宿主里可用的会话（侧边栏入口用来挑一个）
 *   POST { op:'save-file' | 'create-file' | 'delete-file' | 'refresh'
 *        | 'save-edit' | 'delete-part' | 'reorder-messages' | 'delete-messages'
 *        | 'forget-edit' | 'clear-edits' | 'append-message' }
 */
import { ensureRoots, listEntries, listRoots, readEntry, writeEntry, writeEntryMeta, createEntry, deleteEntry, contextRoots, dshHome, segmentsToBody, readSettings, writeSettings, injectionEnabled } from './store.js'
import { repairSessions, zstdAvailable } from './repair.js'
import { listHistoryMessages, applyEdit, forgetEdit, clearEdits, loadEdits, appendMessage, deleteMessages, deletePart, reorderMessages, enqueueOperation, listQueuedSessions, loadQueue, saveQueue, openCoordinates, sessionEvents, appendApplyLog } from './history.js'
import { historyIndex, isPresent, syncManualContext, planTargets, manualContextNodes } from './inject.js'

export const HTTP_PATH = '/manual-context'
const BODY_LIMIT = 4 * 1024 * 1024

/** 安装路由。 */
export function installHttp(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: HTTP_PATH,
    handler: createHandler(ctx),
  }), 'manual-context.http')
}

/** 构造可测试的处理器。 */
export function createHandler(ctx) {
  return async (request, response) => {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url ?? HTTP_PATH, 'http://dsh.local')
        json(response, 200, await handleGet(ctx, url))
        return
      }
      if (request.method === 'POST') {
        const raw = await readBody(request)
        let payload
        try {
          payload = raw === '' ? {} : JSON.parse(raw)
        } catch {
          json(response, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        json(response, 200, await handlePost(ctx, payload))
        return
      }
      json(response, 405, { ok: false, error: '不支持的请求方法' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      json(response, 200, { ok: false, error: message })
    }
  }
}

/** 读取活跃 agent 列表；cordis 在未声明 inject 时会抛错，这里兜底成空列表。 */
function agentList(ctx) {
  try {
    return ctx.agents?.list?.() ?? []
  } catch {
    return []
  }
}

function currentAgent(ctx, sessionId) {
  for (const agent of agentList(ctx)) {
    if (agent.id === sessionId) return agent
  }
  return undefined
}

function cwdOf(ctx, sessionId) {
  const agent = currentAgent(ctx, sessionId)
  if (agent?.session?.header?.cwd !== undefined) return agent.session.header.cwd
  const session = ctx.sessions.get(sessionId)
  return session?.header?.cwd
}

async function handleGet(ctx, url) {
  const op = url.searchParams.get('op') ?? 'status'
  const sessionId = url.searchParams.get('sessionId') ?? undefined
  const cwd = sessionId === undefined ? undefined : cwdOf(ctx, sessionId)
  switch (op) {
    case 'status': {
      const entries = listEntries(cwd)
      const index = historyIndex(currentAgent(ctx, sessionId))
      const injected = entries.map(meta => ({
        id: meta.id,
        name: meta.name,
        role: meta.role,
        inContext: isPresent(meta, index),
      }))
      // 队列与「现在能不能立即写」都如实告诉面板：v4 会话空闲也能写，旧格式要等下一轮。
      const session = sessionId === undefined || sessionId === '' ? undefined : ctx.sessions?.get?.(sessionId)
      const coordinates = session === undefined ? { turn: null, step: null } : openCoordinates(session)
      const queue = sessionId === undefined || sessionId === '' ? [] : loadQueue(sessionId)
      return {
        ok: true,
        dirs: contextRoots(cwd),
        roots: listRoots(cwd),
        home: dshHome(),
        cwd: cwd ?? null,
        entries,
        injected,
        edits: sessionId === undefined ? [] : loadEdits(sessionId),
        queued: queue.length,
        queue: queue.map(function (operation) {
          return { op: operation?.op ?? '', payload: operation?.payload ?? null }
        }),
        canWrite: coordinates.turn !== null && coordinates.step !== null,
        version: session === undefined ? null : (session.sessionVersion ?? session.header?.version ?? null),
        // 注入总开关：关掉之后同步会把已注入的节点全部遮蔽掉，并且不再注入。
        inject: injectionEnabled(),
        settings: readSettings(),
      }
    }
    case 'file': {
      const id = url.searchParams.get('id')
      if (id === null || id === '') throw new Error('缺少 id')
      return { ok: true, entry: readEntry(cwd, id) }
    }
    case 'history': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      // 顺带把「排队中、还没机会写进去」的东西也列出来 —— 否则它们在面板上完全隐形，
      // 用户既看不到自己排上的改动，也没法改。
      return {
        ok: true,
        ...listHistoryMessages(ctx, sessionId),
        pendingAdds: listPendingAdds(ctx, sessionId, cwd),
        cwd: cwd ?? null,
      }
    }
    case 'export-session': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      return { ok: true, ...exportSession(ctx, sessionId) }
    }
    case 'sessions': {
      // 侧边栏入口拿不到 slot 的 sessionId，这里让面板自己挑一个会话
      const items = agentList(ctx).map(function (agent) {
        const session = agent.session !== undefined && agent.session !== null ? agent.session : undefined
        const header = session !== undefined && session.header !== undefined && session.header !== null ? session.header : undefined
        const cwdValue = header !== undefined && typeof header.cwd === 'string' ? header.cwd : null
        const title = header !== undefined && typeof header.title === 'string' ? header.title : null
        return {
          id: agent.id,
          status: typeof agent.status === 'string' ? agent.status : '',
          cwd: cwdValue,
          title,
        }
      })
      return { ok: true, sessions: items, current: sessionId ?? null }
    }
    default:
      throw new Error('未知操作: ' + op)
  }
}

/**
 * 执行一次面板操作。
 *
 * 导出是为了让「排队应用」复用同一套逻辑：空闲时（上一次 turn/end 之后）写日志会抛
 * SessionWritePendingError，操作被排队，等下一轮 agent/request（step 已经打开）再执行。
 */
export function runOperation(ctx, payload) {
  const op = typeof payload?.op === 'string' ? payload.op : ''
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
  const cwd = sessionId === undefined ? undefined : cwdOf(ctx, sessionId)
  switch (op) {
    case 'refresh':
      ensureRoots(cwd)
      return { ok: true, dirs: contextRoots(cwd) }
    case 'save-file': {
      if (typeof payload.id !== 'string') throw new Error('缺少 id')
      // JSON 编辑模式：直接给结构化的 meta + body，由宿主组装 frontmatter
      if (payload.meta !== null && typeof payload.meta === 'object') {
        const body = typeof payload.body === 'string' ? payload.body : ''
        return { ok: true, entry: writeEntryMeta(cwd, payload.id, payload.meta, body) }
      }
      const role = typeof payload.role === 'string' ? payload.role : undefined
      const saved = writeEntry(cwd, payload.id, String(payload.content ?? ''), role)
      return { ok: true, entry: saved }
    }
    case 'create-file': {
      const rootIndex = typeof payload.root === 'number' ? payload.root : 0
      const role = typeof payload.role === 'string' ? payload.role : undefined
      const created = createEntry(cwd, String(payload.name ?? ''), String(payload.content ?? ''), rootIndex, role)
      return { ok: true, entry: created }
    }
    case 'save-segments': {
      // 片段级编辑：前端把整个片段数组发回来，宿主负责重组成正文并写盘，
      // 这样「解析 / 重组」的格式规则只存在 store.js 一处。
      if (typeof payload.id !== 'string') throw new Error('缺少 id')
      const current = readEntry(cwd, payload.id)
      const meta = payload.meta !== null && typeof payload.meta === 'object' ? payload.meta : current.meta
      const segments = Array.isArray(payload.segments) ? payload.segments : []
      return { ok: true, entry: writeEntryMeta(cwd, payload.id, meta, segmentsToBody(segments)) }
    }
    case 'delete-file': {
      if (typeof payload.id !== 'string') throw new Error('缺少 id')
      deleteEntry(cwd, payload.id)
      return { ok: true }
    }
    case 'save-edit': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      if (typeof payload.seq !== 'number') throw new Error('缺少 seq')
      const blocks = Array.isArray(payload.content) ? payload.content : undefined
      const result = applyEdit(
        ctx,
        sessionId,
        payload.seq,
        typeof payload.text === 'string' ? payload.text : undefined,
        typeof payload.expectedText === 'string' ? payload.expectedText : undefined,
        blocks,
        typeof payload.reasoning === 'string' ? payload.reasoning : undefined,
      )
      return { ok: true, ...result }
    }
    case 'delete-messages': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      const seqs = Array.isArray(payload.seqs) ? payload.seqs : []
      return { ok: true, ...deleteMessages(ctx, sessionId, seqs) }
    }
    case 'delete-part': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      if (typeof payload.seq !== 'number') throw new Error('缺少 seq')
      if (typeof payload.index !== 'number') throw new Error('缺少 index')
      return { ok: true, ...deletePart(ctx, sessionId, payload.seq, payload.index) }
    }
    case 'reorder-messages': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      const order = Array.isArray(payload.order) ? payload.order : []
      return { ok: true, ...reorderMessages(ctx, sessionId, order) }
    }
    case 'delete-files': {
      const ids = Array.isArray(payload.ids) ? payload.ids : []
      if (ids.length === 0) throw new Error('缺少 ids')
      const removed = []
      const failed = []
      for (const id of ids) {
        try {
          deleteEntry(cwd, String(id))
          removed.push(id)
        } catch (error) {
          failed.push({ id, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return { ok: true, removed, failed }
    }
    case 'append-message': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      const result = appendMessage(ctx, sessionId, {
        kind: payload.kind,
        text: payload.text,
        blocks: Array.isArray(payload.blocks) ? payload.blocks : undefined,
        toolName: payload.toolName,
        toolInput: payload.toolInput,
        callId: payload.callId,
        isError: payload.isError === true,
      })
      return { ok: true, ...result }
    }
    case 'forget-edit': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      if (typeof payload.seq !== 'number') throw new Error('缺少 seq')
      return { ok: true, ...forgetEdit(ctx, sessionId, payload.seq) }
    }
    case 'clear-edits': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      return { ok: true, ...clearEdits(sessionId) }
    }
    case 'sync-context': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      const result = syncManualContext(ctx, sessionId)
      // 还有写不进去的部分（v4 之前的旧格式会话在空闲时写不了表面事件）：
      // 显式排队让下一轮请求组装时自动补上，面板据此显示「排队中 N 项」。
      if (result.deferred > 0) {
        const already = loadQueue(sessionId).some(function (operation) { return operation?.op === 'sync-context' })
        if (!already) enqueueOperation(sessionId, { op: 'sync-context' })
      }
      return { ok: true, ...result }
    }
    case 'drop-pending': {
      // 丢弃一条「排着队、还没写进去」的改动（目前只用于面板追加的消息）。
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      const queueIndex = payload.queueIndex
      if (!Number.isSafeInteger(queueIndex)) throw new Error('缺少 queueIndex')
      const queued = loadQueue(sessionId)
      if (queueIndex < 0 || queueIndex >= queued.length) throw new Error('这条排队改动已经不存在了（可能刚被应用）')
      const droppedOperation = queued[queueIndex]
      queued.splice(queueIndex, 1)
      saveQueue(sessionId, queued)
      return { ok: true, dropped: 1, op: droppedOperation?.op ?? null, remaining: queued.length }
    }
    case 'edit-pending': {
      // 改写一条「排着队、还没写进去」的消息正文 —— 这正是「将要添加的内容改不了」的补丁。
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      const queueIndex = payload.queueIndex
      if (!Number.isSafeInteger(queueIndex)) throw new Error('缺少 queueIndex')
      const queued = loadQueue(sessionId)
      const target = queued[queueIndex]
      if (target === undefined) throw new Error('这条排队改动已经不存在了（可能刚被应用）')
      if (target.op !== 'append-message') {
        throw new Error('手动上下文的正文来自条目文件，请到「手动上下文」页改条目本身')
      }
      const text = typeof payload.text === 'string' ? payload.text : ''
      // 思维链与工具调用只属于模型输出（含工具调用消息）；用户输入、工具返回是单块消息，
      // 即使前端多传了这些字段也一律忽略 —— 免得造出「用户消息带思维链」这种怪东西。
      const carriedKind = typeof target.payload?.kind === 'string' ? target.payload.kind : 'user'
      const canReason = carriedKind === 'assistant' || carriedKind === 'tool-call'
      const reasoning = canReason && typeof payload.reasoning === 'string' ? payload.reasoning : ''
      const toolName = canReason && typeof payload.toolName === 'string' ? payload.toolName : ''
      const toolInput = canReason && typeof payload.toolInput === 'string' ? payload.toolInput : ''
      // 思维链 / 模型输出 / 工具调用本来就是同一条 assistant 消息里的三个内容块，
      // 这里按这个形状组装 —— appendMessage 会把它们写成一整条消息（相邻的自动合并）。
      const blocks = []
      if (reasoning.trim() !== '') blocks.push({ type: 'reasoning', text: reasoning })
      if (text.trim() !== '') blocks.push({ type: 'text', text: text })
      if (toolName.trim() !== '') blocks.push({ type: 'tool-call', name: toolName, args: toolInput })
      const kind = blocks.some(function (block) { return block.type !== 'text' })
        ? 'assistant'
        : (typeof target.payload?.kind === 'string' ? target.payload.kind : 'user')
      queued[queueIndex] = Object.assign({}, target, {
        payload: Object.assign({}, target.payload, {
          kind,
          text,
          blocks: blocks.length > 0 ? blocks : undefined,
          toolName: toolName !== '' ? toolName : undefined,
          toolInput: toolInput !== '' ? toolInput : undefined,
        }),
      })
      saveQueue(sessionId, queued)
      return { ok: true, updated: 1, queueIndex, kind, blockCount: blocks.length }
    }
    case 'set-inject': {
      // 注入总开关。关掉之后不写入新内容，并且把已经注入的节点遮蔽掉 ——
      // 关掉时顺手同步一次，面板不用再点一次「同步到会话」。
      const saved = writeSettings({ inject: payload.enabled !== false })
      let sync = null
      if (sessionId !== undefined && sessionId !== '' && ctx.sessions?.get?.(sessionId) !== undefined) {
        try {
          sync = syncManualContext(ctx, sessionId)
        } catch (error) {
          sync = { error: error instanceof Error ? error.message : String(error) }
        }
      }
      return { ok: true, ...saved, sync }
    }
    // repair-sessions 需要等 dsh 自己的加载校验（异步），放在 handlePost 里单独处理。
    case 'repair-capability':
      return { ok: true, supported: zstdAvailable() }
    case 'import-session': {
      if (sessionId === undefined || sessionId === '') throw new Error('缺少 sessionId')
      const messages = Array.isArray(payload?.messages) ? payload.messages : []
      if (messages.length === 0) throw new Error('没有可导入的消息')
      return { ok: true, ...importMessages(ctx, sessionId, messages) }
    }
    default:
      throw new Error('未知操作: ' + op)
  }
}

/** HTTP POST 入口：空闲时的写操作改为排队，并如实告诉面板。 */
async function handlePost(ctx, payload) {
  // 修复会话日志：内部要用 dsh 自己的加载路径重新校验，所以是异步的。
  // 带 sessionId 时只处理那一个会话 —— 面板的「修复此对话」走的就是这条路，
  // 不必每次都把上百个会话全扫一遍。
  if (payload?.op === 'repair-sessions') {
    const running = new Set()
    for (const agent of agentList(ctx)) if (typeof agent?.id === 'string') running.add(agent.id)
    const target = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    return { ok: true, ...(await repairSessions({ apply: payload.apply !== false, running, sessionId: target })) }
  }
  try {
    return runOperation(ctx, payload)
  } catch (error) {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    if (error !== null && typeof error === 'object' && error.code === 'session-write-pending' && sessionId !== '') {
      enqueueOperation(sessionId, { op: typeof payload?.op === 'string' ? payload.op : '', payload })
      return { ok: true, queued: true, message: error.message }
    }
    throw error
  }
}

/**
 * 排队中「将要添加」的条目。
 *
 * 两类来源：
 *   1. `append-message`：面板上手动追加的消息（正文就在队列里，可以直接改）；
 *   2. `sync-context`：还没注入进去的手动上下文段（正文在条目文件里，改要去条目页）。
 *
 * queueIndex 是队列数组下标 —— 编辑 / 丢弃都靠它定位。
 */
function listPendingAdds(ctx, sessionId, cwd) {
  const queued = loadQueue(sessionId)
  const out = []
  for (let queueIndex = 0; queueIndex < queued.length; queueIndex += 1) {
    const operation = queued[queueIndex]
    if (operation?.op === 'append-message') {
      const queuedPayload = operation.payload ?? {}
      const carried = Array.isArray(queuedPayload.blocks) ? queuedPayload.blocks : []
      const pick = function (type) {
        return carried.find(function (block) { return block !== null && typeof block === 'object' && block.type === type }) ?? null
      }
      const reasoningBlock = pick('reasoning')
      const textBlock = pick('text')
      const callBlock = pick('tool-call')
      out.push({
        queueIndex,
        source: 'append',
        kind: typeof queuedPayload.kind === 'string' ? queuedPayload.kind : 'user',
        // blocks 是权威；没有 blocks 时回落到单段 text（兼容更早排上的队列）
        text: textBlock !== null
          ? String(textBlock.text ?? '')
          : (typeof queuedPayload.text === 'string' ? queuedPayload.text : ''),
        reasoning: reasoningBlock === null ? '' : String(reasoningBlock.text ?? ''),
        toolName: callBlock !== null
          ? String(callBlock.name ?? '')
          : (typeof queuedPayload.toolName === 'string' ? queuedPayload.toolName : ''),
        toolInput: callBlock !== null
          ? String(callBlock.arguments ?? callBlock.args ?? '')
          : (typeof queuedPayload.toolInput === 'string' ? queuedPayload.toolInput : ''),
        editable: true,
      })
      continue
    }
    if (operation?.op !== 'sync-context') continue
    if (typeof cwd !== 'string' || cwd === '') continue
    const session = ctx.sessions?.get?.(sessionId)
    if (session === undefined) continue
    const present = manualContextNodes(session)
    for (const target of planTargets(cwd)) {
      if (present.has(target.id)) continue
      const text = typeof target.text === 'string' && target.text !== ''
        ? target.text
        : (Array.isArray(target.blocks) ? target.blocks.map(function (block) { return String(block?.text ?? '') }).join('') : '')
      out.push({
        queueIndex,
        source: 'manual-context',
        kind: target.role === 'assistant' ? 'assistant' : (target.role === 'tool-result' ? 'tool-result' : 'user'),
        text,
        entryId: target.entryId ?? null,
        entryName: target.name ?? null,
        editable: false,
      })
    }
  }
  return out
}

/**
 * 应用排队中的操作（由 agent/request 钩子调用：此时 step/start 已写入，坐标合法）。
 *
 * 只处理当前确实开着 step 的会话；仍无法写入的操作留在队列里，
 * 其余失败（目标已被压缩、内容已变化等）直接丢弃并记一条警告。
 */
export function applyQueuedOperations(ctx) {
  const applied = []
  for (const sessionId of listQueuedSessions()) {
    const session = ctx.sessions?.get?.(sessionId)
    if (session === undefined) {
      appendApplyLog(sessionId, '跳过：会话不在内存里')
      continue
    }
    const open = openCoordinates(session)
    if (open.turn === null || open.step === null) {
      appendApplyLog(sessionId, '跳过：还没有开放的 turn/step')
      continue
    }
    const remaining = []
    for (const operation of loadQueue(sessionId)) {
      const op = typeof operation?.op === 'string' ? operation.op : ''
      try {
        // 队列里的 op / sessionId 才是权威：注入类操作排队时只带了 payload 正文。
        const result = runOperation(ctx, Object.assign({}, operation.payload, { op, sessionId }))
        appendApplyLog(sessionId, '完成 ' + op + ' -> ' + JSON.stringify(result ?? null))
        applied.push(sessionId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 写不进去的操作**一律留在队列里**。以前这里会把非 pending 的错误直接丢掉，
        // 用户看到的就是「排队中」消失、对话里却什么都没注入，且无迹可查。
        const attempts = (Number.isSafeInteger(operation?.attempts) ? operation.attempts : 0) + 1
        if (attempts > 5) {
          appendApplyLog(sessionId, '放弃 ' + op + '（已试 ' + String(attempts) + ' 次）：' + message)
        } else {
          remaining.push(Object.assign({}, operation, { attempts }))
          appendApplyLog(sessionId, '重试 ' + op + '（第 ' + String(attempts) + ' 次）：' + message)
        }
      }
    }
    saveQueue(sessionId, remaining)
  }
  return applied
}

/** 导出文件格式标识。 */
export const EXPORT_FORMAT = 'dsh-manual-context/session-export'

/** 取某个 seq 上事件的 message.id。 */
function messageIdAt(session, seq) {
  const event = sessionEvents(session)[seq]
  if (event === undefined) return null
  const message = event.type === 'user/message' ? event.data : event?.data?.message
  return message !== null && typeof message === 'object' && typeof message.id === 'string' ? message.id : null
}

/**
 * 导出会话：把当前模型可见历史（含手动上下文节点）序列化成一份可移植的 JSON。
 * 导入时以 message.id 去重，因此同一份文件重复导入不会翻倍。
 */
export function exportSession(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  const list = listHistoryMessages(ctx, sessionId)
  const messages = list.messages.map(function (message) {
    const id = messageIdAt(session, message.seq)
    return {
      id,
      seq: message.seq,
      type: message.type,
      kind: message.kind,
      role: message.role,
      time: message.time,
      text: message.text,
      reasoning: message.reasoning,
      blocks: message.blocks,
      parts: message.parts,
      manual: typeof id === 'string' && id.startsWith('manual-context:'),
      protected: message.protected,
    }
  })
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    session: { id: sessionId, cwd: session?.header?.cwd ?? null },
    messages,
  }
}

/** 导出项 → appendMessage 的 kind。 */
function importedKind(item) {
  const kind = typeof item?.kind === 'string' ? item.kind : ''
  if (kind === 'user' || kind === 'assistant' || kind === 'reasoning' || kind === 'tool-call' || kind === 'tool-result') return kind
  if (kind === 'tool') return 'tool-result'
  const role = typeof item?.role === 'string' ? item.role : ''
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'tool') return 'tool-result'
  return null
}

/** 导出项 → appendMessage 的参数。 */
function importedSpec(item) {
  const kind = importedKind(item)
  if (kind === null) return null
  const spec = { kind, text: typeof item?.text === 'string' ? item.text : '' }
  if (typeof item?.id === 'string' && item.id !== '') spec.id = item.id
  const parts = Array.isArray(item?.parts) ? item.parts : []
  const findPart = function (wanted) {
    return parts.find(function (part) { return part !== null && typeof part === 'object' && part.kind === wanted }) ?? {}
  }
  if (kind === 'tool-call') {
    const part = findPart('tool-call')
    spec.toolName = part.toolName ?? item?.toolName
    spec.toolInput = part.toolInput ?? item?.toolInput
    spec.callId = part.callId ?? item?.callId
  }
  if (kind === 'tool-result') {
    const part = findPart('tool-result')
    spec.callId = part.callId ?? item?.callId
    spec.isError = item?.isError === true
  }
  return spec
}

/**
 * 导入消息：按顺序追加到当前会话末尾。
 * 已存在同样 message.id 的条目会被跳过（幂等），导入的节点照常参与 surface 与守卫。
 */
export function importMessages(ctx, sessionId, items) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  const existing = new Set()
  for (const event of sessionEvents(session)) {
    const message = event.type === 'user/message' ? event.data : event?.data?.message
    if (message !== null && typeof message === 'object' && typeof message.id === 'string') existing.add(message.id)
  }
  let imported = 0
  let skipped = 0
  const seqs = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      skipped += 1
      continue
    }
    const spec = importedSpec(item)
    if (spec === null) {
      skipped += 1
      continue
    }
    if (typeof spec.id === 'string' && existing.has(spec.id)) {
      skipped += 1
      continue
    }
    const result = appendMessage(ctx, sessionId, spec)
    seqs.push(result.seq)
    if (typeof spec.id === 'string') existing.add(spec.id)
    imported += 1
  }
  return { imported, skipped, seqs }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    request.on('data', (chunk) => {
      if (done) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > BODY_LIMIT) {
        done = true
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', (error) => {
      if (done) return
      done = true
      reject(error)
    })
  })
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  })
  response.end(body)
}
