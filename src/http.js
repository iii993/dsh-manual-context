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
import { listHistoryMessages, applyEdit, forgetEdit, clearEdits, loadEdits, appendMessage, deleteMessages, deletePart, reorderMessages, enqueueOperation, listQueuedSessions, loadQueue, saveQueue, openCoordinates, sessionEvents } from './history.js'
import { historyIndex, isPresent, syncManualContext } from './inject.js'

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
        json(response, 200, handleGet(ctx, url))
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
        json(response, 200, handlePost(ctx, payload))
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

function handleGet(ctx, url) {
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
      return { ok: true, ...listHistoryMessages(ctx, sessionId), cwd: cwd ?? null }
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
    case 'repair-sessions': {
      // 一键修复：扫描所有会话，把旧版插件写坏的「非法遮蔽事件」修好（带备份）。
      const running = new Set()
      for (const agent of agentList(ctx)) if (typeof agent?.id === 'string') running.add(agent.id)
      return { ok: true, ...repairSessions({ apply: payload.apply !== false, running }) }
    }
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
function handlePost(ctx, payload) {
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
 * 应用排队中的操作（由 agent/request 钩子调用：此时 step/start 已写入，坐标合法）。
 *
 * 只处理当前确实开着 step 的会话；仍无法写入的操作留在队列里，
 * 其余失败（目标已被压缩、内容已变化等）直接丢弃并记一条警告。
 */
export function applyQueuedOperations(ctx) {
  const applied = []
  for (const sessionId of listQueuedSessions()) {
    const session = ctx.sessions?.get?.(sessionId)
    if (session === undefined) continue
    const open = openCoordinates(session)
    if (open.turn === null || open.step === null) continue
    const remaining = []
    for (const operation of loadQueue(sessionId)) {
      try {
        // 队列里的 op / sessionId 才是权威：注入类操作排队时只带了 payload 正文。
        runOperation(ctx, Object.assign({}, operation.payload, { op: operation.op, sessionId }))
        applied.push(sessionId)
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'session-write-pending') {
          remaining.push(operation)
          continue
        }
        ctx.logger?.warn?.('[manual-context] 排队操作应用失败: ' + (error instanceof Error ? error.message : String(error)))
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
