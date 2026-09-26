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
 *        | 'forget-edit' | 'clear-edits' | 'append-message'
 *        | 'import-session' | 'import-entries' }
 */
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { readFileSync } from 'node:fs'
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

/**
 * 所有已知工作区。
 *
 * 两处来源：dsh 的工作区索引（$DSH_HOME/storages/workspace.json）与当前活跃会话的 cwd。
 * 导入条目其实只需要一个目录，「必须先开着那个工作区的会话才能导入」是不必要的限制。
 */
function listWorkspaces(ctx) {
  const found = new Map()
  const put = function (cwd, extra) {
    if (typeof cwd !== 'string' || cwd === '') return
    const current = found.get(cwd)
    found.set(cwd, Object.assign({ cwd: cwd, title: null, active: false }, current ?? {}, extra ?? {}))
  }
  for (const agent of agentList(ctx)) {
    const header = agent?.session?.header
    put(header?.cwd, { active: true, title: typeof header?.title === 'string' ? header.title : null })
  }
  try {
    const raw = readFileSync(join(dshHome(), 'storages', 'workspace.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const projects = parsed !== null && typeof parsed === 'object' && parsed.projects !== null && typeof parsed.projects === 'object' ? parsed.projects : {}
    for (const project of Object.values(projects)) {
      if (project === null || typeof project !== 'object') continue
      put(project.path, { title: typeof project.title === 'string' ? project.title : null })
    }
  } catch {
    // 索引读不到就只列活跃会话
  }
  return [...found.values()]
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
    case 'workspaces': {
      // 导入条目要的是「目录」，不是「会话」—— 这里把 dsh 索引里的工作区都列出来，
      // 没有正在进行的对话也能选。
      return { ok: true, workspaces: listWorkspaces(ctx), cwd: cwd ?? null }
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
    case 'import-entries': {
      // 把 JSON 里的消息写成手动上下文条目（.md），落到调用方指定的根目录。
      const entries = Array.isArray(payload?.entries) ? payload.entries : []
      if (entries.length === 0) throw new Error('没有可导入的条目')
      // 目标目录优先取调用方直接给的工作区路径：导入条目只需要一个目录，
      // 不该逼用户先开着那个工作区的会话。
      const targetCwd = typeof payload?.cwd === 'string' && payload.cwd !== '' ? payload.cwd : cwd
      if (targetCwd === undefined || targetCwd === null || targetCwd === '') {
        throw new Error('缺少工作区目录：请先选一个工作区（或打开该工作区的会话）')
      }
      return { ok: true, cwd: targetCwd, ...importEntries(targetCwd, entries, payload.rootIndex, payload.format) }
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
      // v4 的一等 tool/result 把配对 id 放在 message.toolCallId 上（content 里没有 tool-result 块）。
      // 不导出它，导回去的工具返回就成了孤儿，appendMessage 会自动配对失败并抛错。
      toolCallId: message.toolCallId ?? null,
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

/**
 * 导出项本来就是系统提示词时给出可读的跳过原因。
 *
 * 系统提示词由 Harness 每轮重新渲染，导入它只会造成重复，所以**不导入** ——
 * 但必须让用户看到「跳过了、以及为什么」，不能像以前那样静默吞掉。
 */
function systemSkipReason(item) {
  const kind = typeof item?.kind === 'string' ? item.kind.trim().toLowerCase() : ''
  const type = typeof item?.type === 'string' ? item.type.trim().toLowerCase() : ''
  const role = typeof item?.role === 'string' ? item.role.trim().toLowerCase() : ''
  const isSystem = kind === 'system' || kind === 'system/message' || type === 'system/message' || role === 'system'
  if (!isSystem) return null
  return '系统提示词不导入：它每轮由 Harness 重新渲染，导进来只会造成重复'
}

/**
 * 导出项 → appendMessage 的 blocks：保留「思维链 + 正文 + 工具调用」的原始组合。
 *
 * 一条 assistant 消息在真实日志里常常同时带正文和工具调用。只取 text 的话，
 * 工具调用（连同 callId）就丢了，导回去只剩半条模型输出，后面的工具返回成孤儿。
 * 优先用原始的 blocks（导出文件里的 content），没有时退回归一化过的 parts。
 */
function importedBlocks(item) {
  const blocks = []
  const pushText = function (type, text) {
    const value = typeof text === 'string' ? text : ''
    if (value === '') return
    blocks.push(type === 'reasoning' ? { type: 'reasoning', text: value } : { type: 'text', text: value })
  }
  const pushCall = function (name, args, callId) {
    blocks.push({
      type: 'tool-call',
      // 没有 callId 就现生成一个：否则后面的工具返回永远配不上对。
      callId: typeof callId === 'string' && callId !== '' ? callId : 'manual-call-' + randomUUID(),
      name: typeof name === 'string' && name !== '' ? name : 'manual_tool',
      args,
    })
  }
  const raw = Array.isArray(item?.blocks) ? item.blocks : []
  const parts = Array.isArray(item?.parts) ? item.parts : []
  if (raw.length > 0) {
    for (const block of raw) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text') { pushText('text', block.text); continue }
      if (block.type === 'reasoning') { pushText('reasoning', block.text); continue }
      if (block.type === 'tool-call') {
        pushCall(block.name ?? block.toolName, block.args ?? block.arguments ?? block.input, block.callId ?? block.id ?? block.toolCallId)
      }
    }
  } else {
    for (const part of parts) {
      if (part === null || typeof part !== 'object') continue
      const type = typeof part.type === 'string' ? part.type : part.kind
      if (type === 'text') { pushText('text', part.text); continue }
      if (type === 'reasoning') { pushText('reasoning', part.text); continue }
      if (type === 'tool-call') pushCall(part.toolName ?? part.name, part.toolInput ?? part.args, part.callId)
    }
  }
  if (blocks.length === 0 && typeof item?.reasoning === 'string' && item.reasoning.trim() !== '') {
    // 只有思维链、正文为空的模型输出也要能导进来
    blocks.push({ type: 'reasoning', text: item.reasoning })
  }
  return blocks
}

/**
 * 导出项 → appendMessage 的参数。
 *
 * callId 有三个可能的来源，缺一不可：parts（v3 的 tool-result 块里带着）、
 * 条目顶层的 callId、以及 v4 一等 tool/result 的 toolCallId。
 * 任何一处漏读都会让工具返回变成孤儿，appendMessage 直接抛错、整次导入中断。
 */
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
    spec.callId = part.callId ?? item?.callId ?? item?.toolCallId
  }
  if (kind === 'tool-result') {
    const part = findPart('tool-result')
    spec.callId = part.callId ?? item?.callId ?? item?.toolCallId
    spec.isError = part.isError === true || item?.isError === true
  }
  if (kind === 'assistant') {
    const blocks = importedBlocks(item)
    if (blocks.length > 0) spec.blocks = blocks
  }
  if (kind === 'reasoning' && spec.text.trim() === '' && typeof item?.reasoning === 'string') spec.text = item.reasoning
  return spec
}

/**
 * 导入消息：按顺序追加到当前会话末尾。
 *
 * 三条铁律（用户反馈的「导入后只进来一条」就是前两条没做到）：
 *   1. 逐条容错：一条坏数据（配不上对的工具返回、形状不合法…）只跳过它自己，
 *      绝不中断整次导入 —— 以前任意一条抛错，后面的消息全部无声丢失；
 *   2. 如实反馈：跳过多少、为什么跳过都写进 skippedReasons，面板才能给用户交代；
 *   3. 成对导入：同一批里工具调用先落、工具返回后落，callId 不会配丢。
 *
 * 已存在同样 message.id 的条目仍然跳过（幂等），导入的节点照常参与 surface 与守卫。
 *
 * @returns imported / skipped / seqs / skippedReasons / warnings
 */
export function importMessages(ctx, sessionId, items) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('会话当前不在运行中: ' + sessionId)
  const existing = new Set()
  for (const event of sessionEvents(session)) {
    const message = event.type === 'user/message' ? event.data : event?.data?.message
    if (message !== null && typeof message === 'object' && typeof message.id === 'string') existing.add(message.id)
  }
  const list = Array.isArray(items) ? items : []
  const seqs = []
  const skippedReasons = []
  const warnings = []
  let imported = 0

  const skip = function (index, id, reason) {
    skippedReasons.push({ index, id: typeof id === 'string' && id !== '' ? id : null, reason })
  }

  // 工具返回必须排在对应的工具调用之后（显式 callId 校验与自动配对都依赖这个顺序）。
  // 先收齐本批次里出现过的 callId：返回排在调用前面的，押后到所有调用都落完再补。
  const batchCallIds = new Set()
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    if (systemSkipReason(item) !== null) continue
    const spec = importedSpec(item)
    if (spec !== null && spec.kind === 'tool-call' && typeof spec.callId === 'string' && spec.callId !== '') batchCallIds.add(spec.callId)
  }
  const deferred = []
  const seenCallIds = new Set()

  const appendOne = function (index, spec) {
    if (typeof spec.id === 'string' && existing.has(spec.id)) {
      skip(index, spec.id, '这条消息已经在会话里了（按 message.id 去重）')
      return
    }
    try {
      const result = appendMessage(ctx, sessionId, spec)
      // 只有在真的接上了之后才提示，免得「配不上对、已跳过」时还给用户报成功。
      if (spec.kind === 'tool-result' && (typeof spec.callId !== 'string' || spec.callId === '')) {
        warnings.push('第 ' + String(index + 1) + ' 条工具返回没有 callId，已自动接上最近一条还没返回的工具调用')
      }
      seqs.push(result.seq)
      if (typeof spec.id === 'string') existing.add(spec.id)
      imported += 1
    } catch (error) {
      // 单条失败只记原因，绝不抛出：抛出去整批后面的消息就全丢了（用户看到的「只进来一条」）。
      skip(index, spec.id, error instanceof Error ? error.message : String(error))
    }
  }

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (item === null || typeof item !== 'object') {
      skip(index, null, '不是有效的消息对象（应为 JSON 对象）')
      continue
    }
    const systemReason = systemSkipReason(item)
    if (systemReason !== null) {
      skip(index, item.id, systemReason)
      continue
    }
    const spec = importedSpec(item)
    if (spec === null) {
      const raw = typeof item.kind === 'string' && item.kind !== '' ? item.kind : (typeof item.role === 'string' ? item.role : '')
      skip(index, item.id, '不支持的消息类型' + (raw === '' ? '' : '：' + raw)
        + '（只能导入 user / assistant / reasoning / tool-call / tool-result）')
      continue
    }
    if (spec.kind === 'tool-call' && typeof spec.callId === 'string' && spec.callId !== '') seenCallIds.add(spec.callId)
    if (spec.kind === 'tool-result' && typeof spec.callId === 'string' && spec.callId !== ''
      && !seenCallIds.has(spec.callId) && batchCallIds.has(spec.callId)) {
      deferred.push({ index, spec })
      continue
    }
    appendOne(index, spec)
  }
  if (deferred.length > 0) {
    warnings.push('有 ' + String(deferred.length) + ' 条工具返回排在了对应工具调用的前面，已自动调整顺序后追加')
    for (const pending of deferred) appendOne(pending.index, pending.spec)
  }
  return { imported, skipped: skippedReasons.length, seqs, skippedReasons, warnings }
}

/** import-entries 支持的文件格式 → 扩展名。 */
const ENTRY_FORMAT_EXTENSIONS = { md: '.md', markdown: '.md', txt: '.txt', text: '.txt' }

/** 条目文件已经带上的文本扩展名（与 store.js 的 TEXT_EXTENSIONS 一致）。 */
const ENTRY_TEXT_EXTENSIONS = ['.md', '.markdown', '.txt', '.text']

/**
 * 净化导入文件名：JSON 里的名字可能带目录前缀、Windows 非法字符、结尾的点与空格。
 * 这里先收拾成一个能安全落到目标目录里的普通文件名，剩下的（重名、长度）交给 store 校验。
 */
function sanitizeEntryName(name) {
  const raw = typeof name === 'string' ? name.trim() : ''
  if (raw === '') return ''
  // 只取最后一段路径，绝不允许写到目标根目录之外
  const parts = raw.split(/[\\/]+/).filter(function (part) { return part !== '' })
  const base = parts.length === 0 ? '' : parts[parts.length - 1]
  return base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
}

/** 文件名没写扩展名（或写了不认识的扩展名）时，补上 format 对应的扩展名。 */
function withEntryExtension(name, extension) {
  const current = extname(name).toLowerCase()
  return ENTRY_TEXT_EXTENSIONS.includes(current) ? name : name + extension
}

/**
 * 把 JSON 里的消息写成手动上下文条目，落到调用方指定的 root 目录。
 *
 * 逐条容错：文件名净化不了、重名、内容超限都只跳过这一条并给出可读原因，
 * 不会因为一条坏数据把整批导入丢掉。
 *
 * @returns written：[条目 id…]；skipped：[{ name, index, reason }]
 */
function importEntries(cwd, entries, rootIndex, format) {
  const key = typeof format === 'string' && format.trim() !== '' ? format.trim().toLowerCase().replace(/^\./, '') : 'md'
  const extension = ENTRY_FORMAT_EXTENSIONS[key]
  if (extension === undefined) {
    throw new Error('不支持的文件格式：' + String(format) + '（仅支持 md / markdown / txt / text）')
  }
  const root = Number.isSafeInteger(rootIndex) && rootIndex >= 0 ? rootIndex : 0
  ensureRoots(cwd)
  const written = []
  const skipped = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === null || typeof entry !== 'object') {
      skipped.push({ name: '', index, reason: '不是有效的条目对象（应为 JSON 对象）' })
      continue
    }
    const name = sanitizeEntryName(entry.name)
    if (name === '') {
      skipped.push({ name: typeof entry.name === 'string' ? entry.name : '', index, reason: '文件名不能为空（或净化后为空）' })
      continue
    }
    let created = null
    try {
      const body = typeof entry.body === 'string' ? entry.body : (entry.body === undefined || entry.body === null ? '' : String(entry.body))
      created = createEntry(cwd, withEntryExtension(name, extension), body, root)
      // 带了结构化元数据（role / callId / isError…）时用 frontmatter 重写一次，保证配对信息不丢。
      const meta = entry.meta !== null && typeof entry.meta === 'object' ? entry.meta : null
      written.push(meta === null ? created.id : writeEntryMeta(cwd, created.id, meta, body).id)
    } catch (error) {
      // 元数据这一步失败时把刚建出来的空壳删掉，保证「跳过」就是真的没落盘。
      if (created !== null) {
        try { deleteEntry(cwd, created.id) } catch { /* 删不掉就算了，不影响本次导入结果 */ }
      }
      skipped.push({ name, index, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { written, skipped }
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
