/** 注入钩子、历史编辑与 HTTP 接口的单元测试。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'mc-host-'))
const workspace = join(sandbox, 'ws')
process.env.DSH_HOME = join(sandbox, 'home')
process.env.DSH_MANUAL_CONTEXT_DIRS = ''

const store = await import('../src/store.js')
const inject = await import('../src/inject.js')
const history = await import('../src/history.js')
const http = await import('../src/http.js')
const freeze = await import('../src/freeze.js')

function fakeAgent(cwd, messages) {
  return {
    id: 'session-test',
    status: 'idle',
    options: { provider: 'deepseek', model: 'v3' },
    session: {
      header: { cwd },
      deriveMessages: () => messages,
    },
  }
}

function userMessage(text, id) {
  return { id: id ?? ('m-' + text), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/**
 * 假会话：append / replace 都会维护 surface.nodes，用来验证「手动上下文 = surface 节点」。
 * open=false 模拟面板空闲（上一次对话已结束），此时写日志必须被守卫拦下。
 */
function contextSession(cwd, options) {
  const open = !(options !== undefined && options.open === false)
  const version = options !== undefined && Number.isSafeInteger(options.version) ? options.version : undefined
  const log = []
  if (open) {
    log.push({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
    log.push({ type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } })
  }
  const surfaceNodes = []
  const appended = []
  const session = {
    id: 'session-context',
    get seq() { return log.length },
    header: version === undefined ? { cwd } : { cwd, version },
    surface: { nodes: surfaceNodes },
    snapshotEvents: function () { return [...log] },
    deriveEventMessage: function (event) {
      if (event === undefined || event === null) return null
      const message = event.type === 'user/message' ? event.data : (event.data ? event.data.message : null)
      if (message === null || message === undefined) return null
      const content = Array.isArray(message.content) ? message.content : []
      return content.length === 0 ? null : message
    },
    deriveMessages: function () { return [] },
    append: function (type, data, intent) {
      const event = Object.assign({ type, seq: log.length, time: Date.now(), data }, intent)
      log.push(event)
      appended.push(event)
      if (intent !== undefined && intent.surfaceOp === 'append') surfaceNodes.push(event.seq)
      else if (intent !== undefined && intent.surfaceOp !== undefined && intent.surfaceOp.op === 'replace') {
        const at = surfaceNodes.indexOf(intent.surfaceOp.startSeq)
        if (at >= 0) surfaceNodes[at] = event.seq
      }
      return event
    },
  }
  const agent = { id: 'session-context', status: 'idle', options: { provider: 'deepseek', model: 'v3' }, session: session }
  const ctx = { sessions: { get: function () { return session } }, agents: { list: function () { return [agent] } } }
  return { ctx: ctx, session: session, agent: agent, appended: appended, log: log, surfaceNodes: surfaceNodes }
}

/** 放一条受保护的系统提示词（surface 第 0 个节点）。 */
function seedSystem(built, text) {
  const event = { type: 'system/message', seq: built.log.length, time: 0, data: { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: text }], source: { kind: 'server' } } } }
  built.log.push(event)
  built.surfaceNodes.push(event.seq)
  return event
}

/** surface 上**真正投影出消息**的节点 id（遮蔽节点不投影，会被跳过）。 */
function surfaceIds(built) {
  const out = []
  for (const seq of built.surfaceNodes) {
    const event = built.log[seq]
    if (event === undefined) continue
    const message = built.session.deriveEventMessage(event)
    if (message === null || message === undefined) continue
    out.push(message.id)
  }
  return out
}

test('注入总开关关闭后移除已注入的节点，重新打开再注入', () => {
  const cwd = join(sandbox, 'switch-off')
  store.createEntry(cwd, 'rules', '关掉开关也要能移除')
  const built = contextSession(cwd)
  seedSystem(built, '系统提示词')

  const on = inject.syncManualContext(built.ctx, 'session-context')
  assert.ok(on.added > 0, '默认开启：正常注入')
  assert.equal(on.disabled, undefined)

  store.writeSettings({ inject: false })
  try {
    assert.equal(store.injectionEnabled(), false)
    const off = inject.syncManualContext(built.ctx, 'session-context')
    assert.equal(off.disabled, true)
    assert.ok(off.removed > 0, '关掉之后要把已经注入的节点遮蔽掉')
    const left = surfaceIds(built).filter(function (id) { return String(id).indexOf('manual-context:') === 0 })
    assert.deepEqual(left, [], '模型可见的节点里不再有手动上下文')
  } finally {
    store.writeSettings({ inject: true })
  }

  const again = inject.syncManualContext(built.ctx, 'session-context')
  assert.ok(again.added > 0, '重新打开后能再注入')
  assert.equal(again.disabled, undefined)
})

test('注入开关的默认值与读写', () => {
  store.writeSettings({ inject: true })
  assert.deepEqual(store.readSettings(), { inject: true })
  assert.equal(store.injectionEnabled(), true)
  store.writeSettings({ inject: false })
  assert.deepEqual(store.readSettings(), { inject: false })
  assert.equal(store.injectionEnabled(), false)
  store.writeSettings({ inject: true })
})

test('条目的 user 段同步成会话 surface 节点', () => {
  const cwd = join(sandbox, 'sync-basic')
  const entry = store.createEntry(cwd, 'rules', '必须使用中文')
  const built = contextSession(cwd)
  seedSystem(built, '系统提示词')
  const result = inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(result.added, 1)
  assert.equal(built.appended.length, 1)
  const event = built.appended[0]
  assert.equal(event.type, 'user/message')
  assert.equal(event.surfaceOp, 'append')
  assert.equal(event.data.role, 'user')
  assert.equal(event.data.id, inject.entryMessageId(entry, 0))
  assert.equal(event.data.source.kind, history.PRODUCER_KIND)
  assert.equal(event.data.content[0].text, '必须使用中文', '注入的是正文本身，不带文件名与包装标记')
  assert.equal(built.surfaceNodes.length, 2)
})

test('渲染版本升级后，旧的注入节点会被自动替换', () => {
  const cwd = join(sandbox, 'sync-revision')
  const entry = store.createEntry(cwd, 'rules', '内容')
  const built = contextSession(cwd)
  seedSystem(built, 'sys')
  // 手工塞一个「升级前注入」的节点：id 是旧格式，正文还带着文件名包装
  const legacy = {
    type: 'user/message', seq: built.log.length, time: 0, surfaceOp: 'append',
    data: { id: 'manual-context:' + entry.hash, role: 'user', source: { kind: history.PRODUCER_KIND, form: 'instructions' },
      content: [{ type: 'text', text: '<dsh-manual-context file="rules.md">旧格式</dsh-manual-context>' }] },
  }
  built.log.push(legacy)
  built.surfaceNodes.push(legacy.seq)
  const result = inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(result.removed, 1, '旧 id 的节点被遮蔽')
  assert.equal(result.added, 1, '按新 id 重新注入')
  const added = built.appended[built.appended.length - 1]
  assert.equal(added.data.id, inject.entryMessageId(entry, 0))
  assert.equal(added.data.content[0].text, '内容')
})

test('同步是幂等的：没有变化就不写任何事件', () => {
  const cwd = join(sandbox, 'sync-idem')
  store.createEntry(cwd, 'rules', '内容')
  const built = contextSession(cwd)
  seedSystem(built, 'sys')
  inject.syncManualContext(built.ctx, 'session-context')
  const written = built.appended.length
  const again = inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(again.added, 0)
  assert.equal(again.removed, 0)
  assert.equal(built.appended.length, written)
})

test('停用的条目不写入，已有节点会被遮蔽掉', () => {
  const cwd = join(sandbox, 'sync-off')
  store.createEntry(cwd, 'rule', '内容')
  const built = contextSession(cwd)
  seedSystem(built, 'sys')
  inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(built.surfaceNodes.length, 2, '系统提示词 + 条目')
  const id = store.listEntries(cwd)[0].id
  store.writeEntryMeta(cwd, id, { role: 'user', enabled: false }, '内容')
  const second = inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(second.removed, 1)
  // 遮蔽是 surface replace：节点位置还在，但已经不再投影任何手动上下文消息
  const manual = surfaceIds(built).filter(function (id) { return String(id).indexOf('manual-context:') === 0 })
  assert.equal(manual.length, 0, '不再有手动上下文节点')
})

test('权重决定位置：<=0 紧跟系统提示词，>0 排在对话末尾', () => {
  const cwd = join(sandbox, 'sync-weight')
  const NL = String.fromCharCode(10)
  store.createEntry(cwd, 'head', ['---', 'weight: -1', '---', '头部条目'].join(NL))
  store.createEntry(cwd, 'tail', ['---', 'weight: 3', '---', '尾部条目'].join(NL))
  const built = contextSession(cwd)
  seedSystem(built, '系统提示词')
  const chat = { type: 'user/message', seq: built.log.length, time: 1, data: { id: 'chat-1', role: 'user', content: [{ type: 'text', text: '真实提问' }], source: { kind: 'human' } } }
  built.log.push(chat)
  built.surfaceNodes.push(chat.seq)
  inject.syncManualContext(built.ctx, 'session-context')
  const ids = surfaceIds(built)
  assert.equal(ids[0], 'sys')
  assert.ok(String(ids[1]).indexOf('manual-context:') === 0, '头部条目紧跟系统提示词')
  assert.equal(ids[2], 'chat-1')
  assert.ok(String(ids[ids.length - 1]).indexOf('manual-context:') === 0, '尾部条目在最后')
})

test('tool-call 与 tool-result 同步成一对（callId 稳定）', () => {
  const cwd = join(sandbox, 'sync-tool')
  const NL = String.fromCharCode(10)
  store.createEntry(cwd, 'call', ['---', 'role: tool-call', 'tool: read_file', 'args: {"path":"a.md"}', '---', '准备读取'].join(NL))
  store.createEntry(cwd, 'result', ['---', 'role: tool-result', '---', '文件内容 ABC'].join(NL))
  const built = contextSession(cwd)
  seedSystem(built, 'sys')
  const result = inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(result.added, 2)
  const call = built.appended[0]
  const toolResult = built.appended[1]
  assert.equal(call.type, 'assistant/message')
  assert.equal(toolResult.type, 'tool/result')
  assert.equal(toolResult.data.message.content[0].toolCallId, call.data.message.content[1].id)
  assert.equal(toolResult.data.message.source.callId, call.data.message.content[1].id)
})

test('连续的思维链 / 模型输出 / 工具调用合并成一条 assistant 消息', () => {
  const cwd = join(sandbox, 'sync-merge')
  const NL = String.fromCharCode(10)
  store.createEntry(cwd, 'reply', [
    '---', 'role: assistant', '---',
    '<!-- role: reasoning -->', '先想一下',
    '<!-- role: assistant -->', '好的，我来看',
    '<!-- role: tool-call -->', '<!-- tool: read_file -->', '<!-- args: {"path":"a.md"} -->', '读取中',
  ].join(NL))
  const built = contextSession(cwd)
  seedSystem(built, 'sys')
  const result = inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(result.added, 1, '三段合成一条消息')
  assert.equal(built.appended.length, 1)
  const event = built.appended[0]
  assert.equal(event.type, 'assistant/message')
  const content = event.data.message.content
  assert.deepEqual(content.map(block => block.type), ['reasoning', 'text', 'text', 'tool-call'])
  assert.equal(content[0].text, '先想一下')
  assert.equal(content[1].text, '好的，我来看')
  assert.equal(content[2].text, '读取中')
  assert.equal(content[3].name, 'read_file')
  assert.equal(content[3].arguments, '{"path":"a.md"}')
  assert.equal(event.data.stream.length, 4, '每个内容块一条流记录')
})

test('user 段与 tool-result 段会打断合并', () => {
  const cwd = join(sandbox, 'sync-merge-break')
  const NL = String.fromCharCode(10)
  store.createEntry(cwd, 'mixed', [
    '---', 'role: assistant', '---',
    '<!-- role: reasoning -->', 'A',
    '<!-- role: user -->', '问题在这里',
    '<!-- role: assistant -->', 'B',
  ].join(NL))
  const built = contextSession(cwd)
  seedSystem(built, 'sys')
  const result = inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(result.added, 3, '合并组 / user / 合并组 各一条')
  assert.deepEqual(built.appended.map(event => event.type), ['assistant/message', 'user/message', 'assistant/message'])
  assert.deepEqual(built.appended[0].data.message.content.map(block => block.type), ['reasoning'])
  assert.equal(built.appended[2].data.message.content[0].text, 'B')
})

test('会话空闲时一律排队，不直接写日志', () => {
  // 空闲时写进去的节点会成为 surface 的第一个节点，等系统提示词随后写进来，
  // 日志就通不过 v4 的关系校验（对话重开一片空白）—— 所以空闲只排队。
  const cwd = join(sandbox, 'sync-idle')
  const NL = String.fromCharCode(10)
  store.createEntry(cwd, 'rule', ['---', 'role: assistant', '---', '模型输出类'].join(NL))
  store.createEntry(cwd, 'note', ['---', 'role: user', '---', '用户输入类'].join(NL))
  const built = contextSession(cwd, { open: false })
  seedSystem(built, 'sys')
  const result = inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(result.added, 0, '空闲时不写日志')
  assert.equal(result.deferred, 2, '两段都排队等下一轮')
  assert.equal(built.appended.length, 0)
})

test('v4 会话空闲时也只排队（空闲写进去的节点会压在系统提示词前面）', () => {
  const cwd = join(sandbox, 'sync-idle-v4')
  const NL = String.fromCharCode(10)
  store.createEntry(cwd, 'rule', ['---', 'role: assistant', '---', '模型输出类'].join(NL))
  const built = contextSession(cwd, { open: false, version: 4 })
  seedSystem(built, 'sys')
  const result = inject.syncManualContext(built.ctx, 'session-context')
  assert.equal(result.deferred, 1, '空闲写进去会落在 turn 之外，必须排队')
  assert.equal(result.added, 0)
  assert.equal(built.appended.length, 0)
})

test('pre-step 只排队同步，不直接写日志', async () => {
  const cwd = join(sandbox, 'sync-pre')
  store.createEntry(cwd, 'rules', '规则')
  const built = contextSession(cwd)
  const handlers = {}
  const ctx = Object.assign({}, built.ctx, { on: function (name, handler) { handlers[name] = handler } })
  inject.installInjection(ctx)
  const decision = await handlers['agent/pre-step']({ agent: built.agent, turn: 1, step: 1, signal: {} }, async function () { return { kind: 'enter', messages: [] } })
  assert.equal(decision.kind, 'enter')
  assert.equal(built.appended.length, 0, 'pre-step 时 step 未开，不能直接写日志')
  const queued = history.loadQueue('session-context')
  assert.equal(queued.length, 1)
  assert.equal(queued[0].op, 'sync-context')
  history.saveQueue('session-context', [])
  await handlers['agent/pre-step']({ agent: built.agent, turn: 1, step: 2, signal: {} }, async function () { return { kind: 'enter', messages: [] } })
  assert.equal(history.loadQueue('session-context').length, 0, '非首步不再排队')
})

test('applyEdit 生成合法的 surface replace 意图', () => {
  // 贴近真实的事件结构：system/assistant 的 message 包在 data.message 里
  const sysMsg = { id: 's', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'plugin', plugin: 'x' } }
  const asstMsg = { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'world' }], source: { kind: 'model', provider: 'p', model: 'm' } }
  const events = [
    { type: 'system/message', seq: 0, time: 1, data: { turn: 1, step: 1, message: sysMsg } },
    { type: 'user/message', seq: 1, time: 2, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: asstMsg, stream: [] } },
    // 对话进行中：有开放的 turn/step，写入才被允许
    { type: 'turn/start', seq: 3, time: 4, data: { turn: 1 } },
    { type: 'step/start', seq: 4, time: 5, data: { turn: 1, step: 1 } },
  ]
  const appended = []
  const session = {
    id: 'session-edit',
    seq: 3,
    header: { cwd: join(sandbox, 'ws3') },
    surface: { nodes: [0, 1, 2] },
    snapshotEvents: () => events,
    deriveEventMessage: event => {
      if (event.type === 'user/message') return event.data
      if (event.data && event.data.message) return event.data.message
      return null
    },
    append: (type, data, intent) => {
      const event = { type, seq: 5 + appended.length, time: Date.now(), data, ...intent }
      appended.push(event)
      return event
    },
  }
  const ctx = { sessions: { get: id => (id === 'session-edit' ? session : undefined) } }

  const result = history.applyEdit(ctx, 'session-edit', 1, 'hello edited', 'hello')
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'user/message')
  assert.deepEqual(appended[0].surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assert.deepEqual(appended[0].sourceEventSeqs, [1])
  assert.equal(appended[0].data.role, 'user')
  assert.equal(appended[0].data.content[0].text, 'hello edited')
  assert.equal(result.replacedSeq, 5)
  assert.equal(history.loadEdits('session-edit').length, 1)

  // 模型输出：assistant/message 不能做 surface 替换（不能带 sourceEventSeqs），
  // 只能「遮蔽原节点 + 尾部重放」，重放出来的仍是一条 assistant/message
  history.applyEdit(ctx, 'session-edit', 2, 'world edited')
  assertEventShape(appended[1])
  assert.equal(appended[1].type, 'system/message')
  assert.deepEqual(appended[1].data.message.content, [], '遮蔽节点不投影消息')
  assert.deepEqual(appended[1].surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
  assertEventShape(appended[2])
  assert.equal(appended[2].type, 'assistant/message')
  assert.equal(appended[2].surfaceOp, 'append')
  assert.equal(appended[2].data.message.role, 'assistant')
  assert.equal(appended[2].data.message.content[0].text, 'world edited')
  assert.ok(Array.isArray(appended[2].data.stream))

  // 系统头无法替换：每轮会被 Harness 重新渲染
  assert.throws(() => history.applyEdit(ctx, 'session-edit', 0, 'new system'), /系统提示词/)
})

test('applyEdit 拒绝已不在 surface 上的节点与过期内容', () => {
  const events = [
    { type: 'user/message', seq: 0, time: 1, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 1, time: 2, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'compacted away' }], source: { kind: 'user' } } },
  ]
  const session = {
    id: 's2', seq: 2, header: {}, surface: { nodes: [0] }, snapshotEvents: () => events,
    deriveEventMessage: event => event.data, append: () => ({ seq: 5 }),
  }
  const ctx = { sessions: { get: () => session } }
  assert.throws(() => history.applyEdit(ctx, 's2', 1, 'y'), /不在当前模型可见上下文/)
  assert.throws(() => history.applyEdit(ctx, 's2', 9, 'y'), /不存在/)
  assert.throws(() => history.applyEdit(ctx, 's2', 0, 'y', 'stale'), /内容已变化/)
})

test('installHttp 注册到 webServer 服务（而不是不存在的 httpServer）', () => {
  const registered = []
  const ctx = {
    effect: fn => fn(),
    webServer: { register: route => { registered.push(route); return () => {} } },
  }
  http.installHttp(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'exact')
  assert.equal(registered[0].path, '/manual-context')
  assert.equal(typeof registered[0].handler, 'function')
})

test('插件 apply 请求的依赖是 webServer + sessions + agents', async () => {
  const mod = await import('../src/index.js')
  const requested = []
  const ctx = {
    on: () => {},
    inject: (deps, callback) => {
      requested.push(deps)
      callback({ effect: fn => fn(), webServer: { register: () => () => {} }, sessions: {} })
    },
    effect: fn => fn(),
    logger: { info: () => {}, warn: () => {} },
  }
  mod.apply(ctx)
  assert.deepEqual(requested, [['webServer', 'sessions', 'agents']])
})

test('HTTP 接口完成条目读写与历史查询', async () => {
  const cwd = join(sandbox, 'ws4')
  store.createEntry(cwd, 'seed', 'seed body')
  const agent = fakeAgent(cwd, [])
  const session = {
    id: 'session-http', header: { cwd }, seq: 1, surface: { nodes: [0] },
    snapshotEvents: () => [{ type: 'user/message', seq: 0, time: 1, data: userMessage('hi') }],
    deriveEventMessage: event => event.data,
    append: (type, data, intent) => ({ type, seq: 1, time: Date.now(), data, ...intent }),
  }
  const ctx = {
    sessions: { get: id => (id === 'session-http' ? session : undefined) },
    agents: { list: () => [{ id: 'session-http', session, status: 'idle' }] },
    effect: fn => fn(),
    webServer: { register: () => () => {} },
  }
  const handler = http.createHandler(ctx)

  const call = async (method, url, body) => {
    const listeners = {}
    const request = {
      method, url,
      on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return request },
    }
    const response = {
      status: 0, body: '',
      writeHead(status) { this.status = status },
      end(text) { this.body = text || '' },
    }
    const promise = handler(request, response)
    if (body !== undefined) for (const fn of listeners.data || []) fn(Buffer.from(body, 'utf8'))
    for (const fn of listeners.end || []) fn()
    await promise
    return { status: response.status, value: JSON.parse(response.body) }
  }

  const status = await call('GET', '/manual-context?op=status&sessionId=session-http')
  assert.equal(status.value.ok, true)
  assert.equal(status.value.entries.length, 1)
  assert.equal(status.value.entries[0].name, 'seed.md')

  const file = await call('GET', '/manual-context?op=file&sessionId=session-http&id=' + encodeURIComponent(status.value.entries[0].id))
  assert.equal(file.value.entry.content, 'seed body')

  const saved = await call('POST', '/manual-context', JSON.stringify({ op: 'save-file', sessionId: 'session-http', id: status.value.entries[0].id, content: 'updated' }))
  assert.equal(saved.value.ok, true)
  assert.equal(store.readEntry(cwd, status.value.entries[0].id).content, 'updated')

  const created = await call('POST', '/manual-context', JSON.stringify({ op: 'create-file', sessionId: 'session-http', name: 'fresh', content: 'x' }))
  assert.equal(created.value.ok, true)

  const hist = await call('GET', '/manual-context?op=history&sessionId=session-http')
  assert.equal(hist.value.messages.length, 1)
  assert.equal(hist.value.messages[0].text, 'hi')
  assert.equal(hist.value.messages[0].kind, 'user')

  const edit = await call('POST', '/manual-context', JSON.stringify({ op: 'save-edit', sessionId: 'session-http', seq: 0, text: 'edited' }))
  assert.equal(edit.value.ok, true)

  const bad = await call('POST', '/manual-context', JSON.stringify({ op: 'nope' }))
  assert.equal(bad.value.ok, false)

  const brokenJson = await call('POST', '/manual-context', '{not json')
  assert.equal(brokenJson.value.ok, false)
})

test('createEntry 支持指定根目录（全局 / 项目）', () => {
  const cwd = join(sandbox, 'ws-root')
  const roots = store.listRoots(cwd)
  assert.equal(roots.length, 2)
  assert.equal(roots[0].label, '项目（当前工作区）')
  assert.equal(roots[1].label, '全局（DSH 根目录）')

  const inProject = store.createEntry(cwd, 'only-project', 'x', 0)
  const inHome = store.createEntry(cwd, 'only-home', 'x', 1)
  assert.ok(inProject.path.startsWith(join(cwd, 'manual-context')))
  assert.ok(inHome.path.startsWith(join(sandbox, 'home', 'manual-context')))
  assert.notEqual(inProject.id, inHome.id)

  // 越界或非法下标回落到第一个根目录
  const fallback = store.createEntry(cwd, 'fallback', 'x', 99)
  assert.ok(fallback.path.startsWith(join(cwd, 'manual-context')))
})

function appendHarness() {
  const appended = []
  const session = {
    id: 'session-append',
    seq: 10,
    header: { cwd: join(sandbox, 'ws-append') },
    surface: { nodes: [0, 1] },
    snapshotEvents: () => [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 3 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 3, step: 2 } },
    ],
    deriveEventMessage: event => event.data,
    append: (type, data, intent) => {
      const event = { type, seq: 10 + appended.length, time: Date.now(), data, ...intent }
      appended.push(event)
      return event
    },
  }
  const ctx = {
    sessions: { get: id => (id === 'session-append' ? session : undefined) },
    agents: { list: () => [{ id: 'session-append', options: { provider: 'deepseek', model: 'v3' } }] },
  }
  return { ctx, appended }
}

test('appendMessage: 用户输入走 user/message append', () => {
  const { ctx, appended } = appendHarness()
  const result = history.appendMessage(ctx, 'session-append', { kind: 'user', text: '手动加的输入' })
  assert.equal(result.kind, 'user')
  assert.equal(appended[0].type, 'user/message')
  assert.equal(appended[0].surfaceOp, 'append')
  assert.equal(appended[0].data.role, 'user')
  assert.equal(appended[0].data.content[0].text, '手动加的输入')
  assert.equal(appended[0].sourceEventSeqs, undefined)
})

test('appendMessage: 模型输出构造真实 assistant/message 与最小 stream', () => {
  const { ctx, appended } = appendHarness()
  history.appendMessage(ctx, 'session-append', { kind: 'assistant', text: '手动加的模型输出' })
  const event = appended[0]
  assert.equal(event.type, 'assistant/message')
  assert.equal(event.surfaceOp, 'append')
  assert.equal(event.data.message.role, 'assistant')
  assert.equal(event.data.message.content[0].text, '手动加的模型输出')
  assert.equal(event.data.message.source.provider, 'deepseek')
  assert.equal(event.data.turn, 3)
  assert.equal(event.data.step, 2)
  assert.equal(event.data.stream.length, 1)
  assert.equal(event.data.stream[0].type, 'text-chunks')
  assert.deepEqual(event.data.stream[0].texts, ['手动加的模型输出'])
})

test('appendMessage: 工具调用生成 tool-call 块与 JSON 字符串参数', () => {
  const { ctx, appended } = appendHarness()
  const result = history.appendMessage(ctx, 'session-append', {
    kind: 'tool-call', text: '准备读取文件', toolName: 'read_file', toolInput: '{"path":"a.md"}',
  })
  const block = appended[0].data.message.content[1]
  assert.equal(appended[0].type, 'assistant/message')
  assert.equal(block.type, 'tool-call')
  assert.equal(block.name, 'read_file')
  assert.equal(block.arguments, '{"path":"a.md"}')
  assert.equal(block.id, result.callId)
  assert.equal(appended[0].data.stream[0].type, 'tool-call-chunks')
})

test('编辑 v4 会话的工具返回：必须写成 role:tool，不能退回 role:user', () => {
  // 回归：replaceInPlace 曾经漏传 version，导致 v4 的 tool/result 按 v3 老形状补成 user，
  // 然后被自己的守卫拦下（"tool/result 的消息角色必须是 tool（实际 user）"）。
  const cwd = join(sandbox, 'edit-tool-result-v4')
  const built = contextSession(cwd, { version: 4 })
  const event = {
    type: 'tool/result', seq: built.log.length, time: 0,
    data: {
      turn: 1, step: 1,
      message: {
        id: 'tool-1', role: 'tool',
        content: [{ type: 'text', text: '原来的文件内容' }],
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1',
      },
    },
    surfaceOp: 'append',
  }
  built.log.push(event)
  built.surfaceNodes.push(event.seq)
  history.applyEdit(built.ctx, 'session-context', event.seq, '改过的文件内容')
  const written = built.appended[built.appended.length - 1]
  assert.equal(written.type, 'tool/result')
  assert.equal(written.data.message.role, 'tool', 'v4 的 tool/result 必须 role:tool')
  assert.equal(written.data.message.source.kind, 'tool')
  assert.equal(written.data.message.content[0].text, '改过的文件内容')
  // dsh 的硬规则：tool/result 的 surface 替换只允许改 content，
  // 其余字段（id / toolCallId / source）必须与被替换的节点逐字一致。
  assert.equal(written.data.message.id, 'tool-1', '替换不得更换 id')
  assert.equal(written.data.message.toolCallId, 'call-1')
  assert.deepEqual(written.data.message.source, { kind: 'tool', callId: 'call-1' })
})

test('appendMessage: 工具返回构造 tool/result 且 callId 自洽', () => {
  const { ctx, appended } = appendHarness()
  const result = history.appendMessage(ctx, 'session-append', { kind: 'tool-result', text: '文件内容', callId: 'call-1' })
  const message = appended[0].data.message
  assert.equal(appended[0].type, 'tool/result')
  assert.equal(appended[0].surfaceOp, 'append')
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].type, 'tool-result')
  assert.equal(message.content[0].toolCallId, 'call-1')
  assert.equal(message.content[0].isError, undefined)
  assert.equal(message.source.callId, 'call-1')
  assert.equal(result.callId, 'call-1')
})

test('appendMessage: 失败标记落在 tool-result 块上', () => {
  const { ctx, appended } = appendHarness()
  history.appendMessage(ctx, 'session-append', { kind: 'tool-result', text: '出错了', isError: true })
  assert.equal(appended[0].data.message.content[0].isError, true)
})

test('appendMessage: 拒绝空内容与未知类型', () => {
  const { ctx } = appendHarness()
  assert.throws(() => history.appendMessage(ctx, 'session-append', { kind: 'user', text: '   ' }), /内容不能为空/)
  assert.throws(() => history.appendMessage(ctx, 'session-append', { kind: 'nope', text: 'x' }), /不支持的消息类型/)
  assert.throws(
    () => history.appendMessage({ sessions: { get: () => undefined } }, 'missing', { kind: 'user', text: 'x' }),
    /不在运行中/,
  )
})

test.after(() => { rmSync(sandbox, { recursive: true, force: true }) })

/** 构造一个用于删除/JSON 编辑测试的会话桩（含 turn/step 事件，便于 tailPosition 取位）。 */
function sessionStub(id, nodes = [2, 3, 4]) {
  const appended = []
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 2, time: 1, data: { turn: 1, step: 1, message: { id: 's', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'plugin', plugin: 'x' } } } },
    { type: 'user/message', seq: 3, time: 2, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 4, time: 3, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'world' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] } },
  ]
  const session = {
    id,
    seq: 10,
    header: { cwd: sandbox },
    surface: { nodes: [...nodes] },
    snapshotEvents: () => events,
    deriveEventMessage: event => {
      if (event.type === 'user/message') return event.data
      if (event.data && event.data.message) return event.data.message
      return null
    },
    append: (type, data, intent) => {
      const event = { type, seq: events.length, time: Date.now(), data, ...intent }
      appended.push(event)
      events.push(event)
      return event
    },
  }
  return { session, appended, events }
}

/**
 * 复刻 dsh-session 的 `assertMessageEventShape`。
 *
 * 这些规则**只在重启加载会话时**执行：写坏了当时不报错，下一次打开会话就是
 * `stored session "…" is corrupt: … message must have role "user"`。
 * 所以每个测试都拿它过一遍插件写出去的事件。
 */
const ROLE_BY_TYPE = {
  'system/message': 'system',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'user',
}

function assertEventShape(event) {
  const expected = ROLE_BY_TYPE[event.type]
  if (expected === undefined) return
  const data = event.data ?? {}
  const message = event.type === 'user/message' ? data : data.message
  assert.ok(message !== null && typeof message === 'object', event.type + ' 缺少消息实体')
  assert.equal(typeof message.id, 'string', event.type + ' 缺少 id')
  assert.notEqual(message.id, '', event.type + ' 的 id 不能为空')
  assert.equal(message.role, expected, event.type + ' 的消息角色必须是 ' + expected)
  assert.ok(message.source !== null && typeof message.source === 'object', event.type + ' 缺少 source')
  assert.equal(typeof message.source.kind, 'string', event.type + ' 缺少 source.kind')
  assert.notEqual(message.source.kind, '')
  assert.ok(Array.isArray(message.content), event.type + ' 缺少 content 数组')
  if (event.type === 'system/message') {
    assert.notEqual(message.source.kind, 'plugin', 'system/message 的 source 不能是裸 plugin（v4 会拒绝）')
    assert.equal(message.source.plugin, undefined)
  }
  if (event.type === 'assistant/message') {
    assert.equal(message.source.kind, 'model')
    assert.equal(typeof message.source.provider, 'string')
    assert.notEqual(message.source.provider, '')
    assert.equal(typeof message.source.model, 'string')
    assert.notEqual(message.source.model, '')
    assert.ok(Number.isSafeInteger(data.turn) && data.turn >= 0, 'assistant/message 需要 turn')
    assert.ok(Number.isSafeInteger(data.step) && data.step >= 0, 'assistant/message 需要 step')
    assert.ok(Array.isArray(data.stream), 'assistant/message 需要 stream 数组')
  }
  if (event.type === 'tool/result') {
    assert.equal(message.source.kind, 'tool')
    assert.equal(typeof message.source.callId, 'string')
    assert.notEqual(message.source.callId, '')
    assert.equal(message.content.length, 1, 'tool/result 只能有一个块')
    assert.equal(message.content[0].type, 'tool-result')
    assert.ok(Array.isArray(message.content[0].content))
    assert.equal(message.content[0].toolCallId, message.source.callId, 'callId 必须一致')
  }
}

test('deleteMessages 用空内容 system/message 遮蔽目标节点', () => {
  const { session, appended } = sessionStub('session-del')
  const result = history.deleteMessages({ sessions: { get: () => session } }, 'session-del', [4])
  assert.deepEqual(result.deleted, [4])
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'system/message')
  // 遮蔽必须能带 sourceEventSeqs（只有 system/message 可以），且来源必须是 system-prompt，
  // 否则整份日志校验失败 —— 表现是会话打不开、界面空白且不报错。
  assert.deepEqual(appended[0].data.message.source, { kind: 'system-prompt' })
  assert.equal(appended[0].data.message.content.length, 0, '空内容才不会投影出消息')
  assert.deepEqual(appended[0].surfaceOp, { op: 'replace', startSeq: 4, endSeq: 4 })
  assert.deepEqual(appended[0].sourceEventSeqs, [4])
})

test('deleteMessages 跳过系统提示词与已下线的节点', () => {
  const { session, appended } = sessionStub('session-del2')
  const result = history.deleteMessages({ sessions: { get: () => session } }, 'session-del2', [2, 99, 3])
  assert.deepEqual(result.deleted, [3])
  assert.deepEqual(result.skipped, [2, 99])
  assert.equal(appended.length, 1)
})

test('applyEdit 支持直接传入 content blocks（JSON 模式）', () => {
  const { session, appended } = sessionStub('session-json')
  history.applyEdit({ sessions: { get: () => session } }, 'session-json', 4, '', undefined, [
    { type: 'text', text: '手写的块' },
    { type: 'tool-call', id: 'c9', name: 'x_tool', arguments: '{}' },
  ])
  // seq 4 是模型输出 → 遮蔽 + 重放
  assertEventShape(appended[0])
  assert.equal(appended[0].type, 'system/message')
  assertEventShape(appended[1])
  assert.equal(appended[1].type, 'assistant/message')
  assert.equal(appended[1].data.message.role, 'assistant', 'JSON 模式下角色依然保持')
  assert.equal(appended[1].data.message.content.length, 2)
  assert.equal(appended[1].data.message.content[1].name, 'x_tool')
})

test('编辑过的模型输出仍标为 assistant（类型要看消息，不能只看事件类型）', () => {
  const { session } = sessionStub('session-kind')
  // 模拟一次编辑：用 user/message 事件承载 role=assistant 的消息
  const edited = {
    type: 'user/message',
    seq: 5,
    time: 9,
    data: { id: 'e1', role: 'assistant', content: [{ type: 'text', text: '改过的回答' }], source: { kind: 'model', provider: 'p', model: 'm' } },
  }
  const originalSnapshot = session.snapshotEvents
  session.snapshotEvents = () => [...originalSnapshot(), edited]
  session.surface.nodes = [2, 3, 5]
  const result = history.listHistoryMessages({ sessions: { get: () => session } }, 'session-kind')
  const row = result.messages.find(message => message.seq === 5)
  assert.equal(row.kind, 'assistant', '事件是 user/message，但消息角色是 assistant')
  assert.equal(row.label, '模型输出')
  assert.equal(row.role, 'assistant')
  assert.equal(row.text, '改过的回答')
})

test('编辑正文时思维链保留；也可以单独改写思维链', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 2, time: 3,
      data: {
        turn: 1, step: 1,
        message: { id: 'a', role: 'assistant', content: [{ type: 'reasoning', text: '原始思考' }, { type: 'text', text: '原始回答' }], source: { kind: 'model', provider: 'p', model: 'm' } },
        stream: [],
      },
    },
  ]
  const appended = []
  const session = {
    id: 'session-coc', seq: 10, header: { cwd: sandbox },
    surface: { nodes: [2] },
    snapshotEvents: () => events,
    deriveEventMessage: event => (event.data && event.data.message ? event.data.message : event.data),
    append: (type, data, intent) => {
      const event = { type, seq: events.length, time: Date.now(), data, ...intent }
      appended.push(event)
      events.push(event)
      return event
    },
  }
  const ctx = { sessions: { get: () => session } }

  history.applyEdit(ctx, 'session-coc', 2, '改过的回答')
  // 模型输出走重放：appended[0] 是遮蔽，appended[1] 才是编辑后的消息
  assert.equal(appended[0].type, 'system/message')
  const replayed = appended[1]
  assertEventShape(replayed)
  assert.deepEqual(replayed.data.message.content.map(b => b.type), ['text', 'reasoning'], '只改正文时思维链必须保留')
  assert.equal(replayed.data.message.content[1].text, '原始思考')

  // 第一次编辑后 surface 指向重放出来的新节点，第二次要对它操作
  session.surface.nodes = [replayed.seq]
  history.applyEdit(ctx, 'session-coc', replayed.seq, undefined, undefined, undefined, '改过的思考')
  const kept = appended[3].data.message.content
  assert.equal(kept.find(b => b.type === 'reasoning').text, '改过的思考')
  assert.equal(kept.find(b => b.type === 'text').text, '改过的回答', '正文不受影响')
})

// ---------- 生命周期守卫与排队（v4 迁移只接受开放 turn/step 内的表面事件） ----------

/** 打开一个夹具会话的生命周期（模拟下一轮请求开始）。 */
function openLifecycle(built) {
  built.log.push({ type: 'turn/start', seq: built.log.length, time: 0, data: { turn: 1 } })
  built.log.push({ type: 'step/start', seq: built.log.length, time: 0, data: { turn: 1, step: 1 } })
}

/** 直接调用 HTTP 处理器。 */
function httpCall(ctx, payload) {
  const handler = http.createHandler(ctx)
  return async function call(body) {
    const listeners = {}
    const request = { method: 'POST', url: '/manual-context', on(name, fn) { listeners[name] = fn; return this } }
    const response = { status: 0, writeHead(status) { this.status = status }, end(text) { this.body = text } }
    const pending = handler(request, response)
    listeners.data(Buffer.from(JSON.stringify(body), 'utf8'))
    listeners.end()
    await pending
    return JSON.parse(response.body)
  }(payload)
}

test('空闲时写入被拦下并排队，重新开始对话后自动应用', async () => {
  history.saveQueue('session-move', [])
  const built = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A'), userEvent(2, 'B')], [0, 1, 2], false)
  const ctx = {
    sessions: { get: id => (id === 'session-move' ? built.session : undefined) },
    agents: { list: () => [] },
    webServer: { register: () => () => {} },
    effect: null,
  }
  const call = (payload) => httpCall(ctx, payload)
  const queued = await call({ op: 'reorder-messages', sessionId: 'session-move', order: [2, 1] })
  assert.equal(queued.ok, true, queued.error)
  assert.equal(queued.queued, true, '空闲时不能直接写日志，必须排队')
  assert.equal(built.appended.length, 0, '空闲时一个事件都不该写出去')
  assert.equal(history.loadQueue('session-move').length, 1)

  // 下一轮请求开始：step 已经打开，排队操作自动应用
  openLifecycle(built)
  const applied = http.applyQueuedOperations(ctx)
  assert.ok(applied.includes('session-move'))
  assert.ok(built.appended.length > 0, '重新开始对话后排队操作才落盘')
  assert.equal(history.loadQueue('session-move').length, 0, '应用后队列被清空')
  history.clearEdits('session-move')
})


// ---------- 工具输出内容 · 片段拆分 · 拖动重排 ----------

/** 一个会按 surfaceOp 维护 surface.nodes 的假会话，语义尽量贴近真实 Host。 */
function movableSession(events, nodes, open = true) {
  const log = [...events]
  // 真实会话在对话进行中总有开放的 turn/step；open=false 模拟「面板空闲」（已 turn/end）。
  if (open) {
    log.push({ type: 'turn/start', seq: log.length, time: 0, data: { turn: 1 } })
    log.push({ type: 'step/start', seq: log.length, time: 0, data: { turn: 1, step: 1 } })
  }
  const surfaceNodes = [...nodes]
  const appendedEvents = []
  const session = {
    id: 'session-move',
    header: { cwd: join(sandbox, 'ws-move') },
    // 真实 Host 里 snapshotEvents() 的数组下标就是 seq，mock 必须一致
    get seq() { return log.length },
    surface: { nodes: surfaceNodes },
    snapshotEvents: () => [...log],
    deriveEventMessage: event => {
      let message = null
      if (event.type === 'user/message') message = event.data
      else if (event.data !== null && typeof event.data === 'object' && event.data.message !== undefined) message = event.data.message
      if (message === null || message === undefined) return null
      const content = Array.isArray(message.content) ? message.content : []
      return content.length === 0 ? null : message
    },
    append: (type, data, intent) => {
      const event = { type, seq: log.length, time: Date.now(), data, ...intent }
      log.push(event)
      if (intent !== undefined && intent.surfaceOp === 'append') surfaceNodes.push(event.seq)
      else if (intent !== undefined && intent.surfaceOp !== undefined && intent.surfaceOp.op === 'replace') {
        const at = surfaceNodes.indexOf(intent.surfaceOp.startSeq)
        if (at >= 0) surfaceNodes[at] = event.seq
      }
      appendedEvents.push(event)
      return event
    },
  }
  return { session, appended: appendedEvents, log, surfaceNodes }
}

/** 当前 surface 上真正可见的消息文本（按顺序）。 */
function visibleTexts(built) {
  const bySeq = new Map(built.log.map(event => [event.seq, event]))
  const out = []
  for (const seq of built.surfaceNodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const message = built.session.deriveEventMessage(event)
    if (message === null || message === undefined) continue
    out.push(freeze.messageText(message))
  }
  return out
}

function sysEvent(seq, text) {
  return { type: 'system/message', seq, time: seq, data: { turn: 1, step: 1, message: { id: 's', role: 'system', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'x' } } } }
}

function userEvent(seq, text) {
  return { type: 'user/message', seq, time: seq, data: { id: 'u' + String(seq), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
}

function assistantEvent(seq, text, callId, name) {
  // 不传 callId 就是「纯文本模型输出」；传了才带工具调用轨迹
  const content = [{ type: 'text', text }]
  if (typeof callId === 'string' && callId !== '') content.push({ type: 'tool-call', id: callId, name, arguments: '{"path":"a.md"}' })
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'a' + String(seq),
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    },
  }
}

function toolEvent(seq, callId, text) {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 't' + String(seq),
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      },
    },
  }
}

test('工具结果的文本从嵌套 content 里取出来（真实结构）', () => {
  const block = { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '文件内容 ABC' }] }
  assert.equal(freeze.toolResultText(block), '文件内容 ABC')
  assert.equal(freeze.messageText({ role: 'user', content: [block] }), '文件内容 ABC')
  assert.equal(freeze.messageText({ role: 'user', content: [{ type: 'tool-result', content: 'plain' }] }), 'plain')
  assert.equal(freeze.messageText({ role: 'user', content: [{ type: 'tool-result', content: [{ type: 'image' }] }] }), '[图片]')
})

test('历史列表把模型输出与工具调用拆成独立片段，并显示工具输出内容', () => {
  const built = movableSession(
    [sysEvent(0, 'sys'), userEvent(1, '问题'), assistantEvent(2, '我来读文件', 'c1', 'read_file'), toolEvent(3, 'c1', '文件内容 ABC')],
    [0, 1, 2, 3],
  )
  const ctx = { sessions: { get: () => built.session } }
  const list = history.listHistoryMessages(ctx, 'session-move')
  assert.equal(list.messages.length, 4)
  const asst = list.messages[2]
  assert.deepEqual(asst.parts.map(part => part.kind), ['assistant', 'tool-call'], '正文与工具调用必须分开')
  assert.equal(asst.parts[0].text, '我来读文件')
  assert.equal(asst.parts[1].toolName, 'read_file')
  assert.equal(asst.parts[1].toolInput, '{"path":"a.md"}')
  const result = list.messages[3]
  assert.equal(result.kind, 'tool')
  assert.equal(result.parts.length, 1)
  assert.equal(result.parts[0].kind, 'tool-result')
  assert.equal(result.parts[0].text, '文件内容 ABC')
  assert.equal(result.text, '文件内容 ABC', '整条文本也要含工具输出')
  assert.equal(result.parts[0].callId, 'c1')
})

test('deletePart 只删指定片段，同一条消息里的其他块保留', () => {
  // 多块模型输出（正文 + 思维链）：删掉第 1 块后只该剩下正文
  const multi = {
    type: 'assistant/message', seq: 1, time: 1,
    data: {
      turn: 1, step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '我来读文件' }, { type: 'reasoning', text: '先想一下' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    },
  }
  const built = movableSession([sysEvent(0, 'sys'), multi], [0, 1])
  const ctx = { sessions: { get: () => built.session } }
  const outcome = history.deletePart(ctx, 'session-move', 1, 1)
  assert.equal(outcome.mode, 'part')
  // 模型输出走重放：最后两个事件是「遮蔽」与「只留正文的新消息」
  const blank = built.appended[built.appended.length - 2]
  const written = built.appended[built.appended.length - 1]
  assert.equal(blank.type, 'system/message')
  assert.deepEqual(blank.data.message.content, [])
  assert.deepEqual(blank.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assertEventShape(written)
  assert.equal(written.type, 'assistant/message')
  assert.deepEqual(written.data.message.content, [{ type: 'text', text: '我来读文件' }])
  assert.equal(written.surfaceOp, 'append')
})

test('deletePart 删到没有块时整条消息被遮蔽掉', () => {
  const built = movableSession([sysEvent(0, 'sys'), toolEvent(1, 'c1', '结果')], [0, 1])
  const ctx = { sessions: { get: () => built.session } }
  const outcome = history.deletePart(ctx, 'session-move', 1, 0)
  assert.equal(outcome.mode, 'message')
  const written = built.appended[built.appended.length - 1]
  assert.equal(written.type, 'system/message')
  assert.deepEqual(written.data.message.content, [])
  assert.deepEqual(visibleTexts(built), ['sys'], '遮蔽后不再投影出消息')
})

test('编辑工具输出仍写回 tool/result 事件（消息结构不残缺）', () => {
  const built = movableSession([sysEvent(0, 'sys'), toolEvent(1, 'c1', '旧结果')], [0, 1])
  const ctx = { sessions: { get: () => built.session } }
  history.applyEdit(ctx, 'session-move', 1, '新结果')
  const written = built.appended[0]
  assert.equal(written.type, 'tool/result', '不能退化成没有 role 的 user/message')
  assert.equal(written.data.message.content[0].content[0].text, '新结果')
  assert.equal(written.data.message.source.callId, 'c1', '工具的 source 保留')
  assert.equal(written.data.turn, 1)
  assert.equal(built.session.deriveEventMessage(written).content[0].type, 'tool-result')
})

test('v4 会话里重放工具返回会写成 role:tool 的一等消息', () => {
  const built = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A'), toolEvent(2, 'c1', '结果')], [0, 1, 2])
  // 会话是 v4，但这条工具返回还是老形状（role:'user' + tool-result 包装块）——
  // 重放时必须转成 v4 的 role:'tool'，否则会被自己的自检拦下
  // （"tool/result 的消息角色必须是 tool（实际 user）"）。
  built.session.header.version = 4
  const ctx = { sessions: { get: () => built.session } }
  const outcome = history.reorderMessages(ctx, 'session-move', [2, 1])
  assert.equal(outcome.moved, 2)
  const copies = built.appended.filter(function (event) { return event.type === 'tool/result' })
  assert.equal(copies.length, 1, '工具返回被重放')
  const message = copies[0].data.message
  assert.equal(message.role, 'tool', 'v4 必须是 role:tool 的一等消息')
  assert.equal(message.toolCallId, 'c1')
  assert.deepEqual(message.source, { kind: 'tool', callId: 'c1' })
  assert.deepEqual(message.content.map(function (block) { return block.type }), ['text'], '包装块摊平成内容块')
  assert.ok(visibleTexts(built).includes('结果'), '内容没丢')
})

test('reorderMessages 把最后一条拖到最前，surface 顺序随之改变', () => {
  const built = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A'), userEvent(2, 'B'), userEvent(3, 'C')], [0, 1, 2, 3])
  const ctx = { sessions: { get: () => built.session } }
  const outcome = history.reorderMessages(ctx, 'session-move', [3, 1, 2])
  assert.equal(outcome.moved, 3)
  assert.deepEqual(visibleTexts(built), ['sys', 'C', 'A', 'B'], '系统头留在原位，其余按目标顺序追加')
  assert.equal(outcome.order.join(','), '3,1,2')
})

test('reorderMessages 只动变化的那一段，公共前缀原地不动', () => {
  const built = movableSession(
    [sysEvent(0, 'sys'), userEvent(1, 'A'), userEvent(2, 'B'), userEvent(3, 'C'), userEvent(4, 'D')],
    [0, 1, 2, 3, 4],
  )
  const ctx = { sessions: { get: () => built.session } }
  const outcome = history.reorderMessages(ctx, 'session-move', [1, 2, 4, 3])
  assert.equal(outcome.moved, 2, '只移动 C 与 D')
  const replacedSeqs = built.appended.filter(event => event.surfaceOp !== 'append').map(event => event.surfaceOp.startSeq)
  assert.deepEqual(replacedSeqs, [4, 3], '按目标顺序遮蔽，再按目标顺序追加')
  assert.deepEqual(visibleTexts(built), ['sys', 'A', 'B', 'D', 'C'])
})

test('顺序没变时不写任何事件', () => {
  const built = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A'), userEvent(2, 'B')], [0, 1, 2])
  const ctx = { sessions: { get: () => built.session } }
  const outcome = history.reorderMessages(ctx, 'session-move', [1, 2])
  assert.equal(outcome.moved, 0)
  assert.equal(built.appended.length, 0)
  assert.deepEqual(visibleTexts(built), ['sys', 'A', 'B'])
})

test('reorderMessages 忽略未知 / 重复的 seq 并补齐漏掉的消息', () => {
  const built = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A'), userEvent(2, 'B'), userEvent(3, 'C')], [0, 1, 2, 3])
  const ctx = { sessions: { get: () => built.session } }
  const outcome = history.reorderMessages(ctx, 'session-move', [3, 3, 999, 0])
  assert.equal(outcome.order.join(','), '3,1,2', '0 是受保护的系统头，不该被拖动；缺的按原顺序补上')
  assert.deepEqual(visibleTexts(built), ['sys', 'C', 'A', 'B'])
})

test('reorderMessages 之后编辑标记跟着挂到新节点上', () => {
  const built = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A'), userEvent(2, 'B')], [0, 1, 2])
  const ctx = { sessions: { get: () => built.session } }
  history.saveEdits('session-move', [{ seq: 2, replacedSeq: 2, targetType: 'user/message', targetText: 'B', updatedAt: 1 }])
  history.reorderMessages(ctx, 'session-move', [2, 1])
  const edits = history.loadEdits('session-move')
  const moved = built.appended.filter(event => event.surfaceOp === 'append').map(event => event.seq)
  assert.equal(edits.length, 1)
  assert.ok(moved.includes(edits[0].replacedSeq), '编辑记录指向重新追加后的节点')
  history.clearEdits('session-move')
})

test('HTTP 接口暴露删除片段与拖动重排', async () => {
  const built = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A'), userEvent(2, 'B')], [0, 1, 2])
  const ctx = {
    sessions: { get: id => (id === 'session-move' ? built.session : undefined) },
    agents: { list: () => [] },
    webServer: { register: () => () => {} },
    effect: null,
  }
  const handler = http.createHandler(ctx)
  const call = async (payload) => {
    const listeners = {}
    const request = {
      method: 'POST',
      url: '/manual-context',
      on(name, fn) { listeners[name] = fn; return this },
    }
    const response = { status: 0, writeHead(status) { this.status = status }, end(text) { this.body = text } }
    const pending = handler(request, response)
    listeners.data(Buffer.from(JSON.stringify(payload), 'utf8'))
    listeners.end()
    await pending
    return JSON.parse(response.body)
  }
  const reordered = await call({ op: 'reorder-messages', sessionId: 'session-move', order: [2, 1] })
  assert.equal(reordered.ok, true, reordered.error)
  assert.equal(reordered.moved, 2)
  const lastSeq = built.surfaceNodes[built.surfaceNodes.length - 1]
  const removed = await call({ op: 'delete-part', sessionId: 'session-move', seq: lastSeq, index: 0 })
  assert.equal(removed.ok, true, removed.error)
  assert.equal(removed.mode, 'message', '单块消息删掉唯一片段等于整条删除')
})


// ---------- 写入合规：绝不能再次写出让会话损坏的事件 ----------

test('编辑 / 删除 / 重排写出去的事件全部符合会话形状规则', () => {
  const cases = []
  // user → 原位替换
  const a = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A')], [0, 1])
  history.applyEdit({ sessions: { get: () => a.session }, agents: { list: () => [] } }, 'session-move', 1, 'A 改过')
  cases.push(a)
  // assistant → 遮蔽 + 重放，再单独删掉一个片段
  const b = movableSession([sysEvent(0, 'sys'), assistantEvent(1, '回答')], [0, 1])
  const ctxB = { sessions: { get: () => b.session }, agents: { list: () => [] } }
  history.applyEdit(ctxB, 'session-move', 1, '回答改过')
  const lastNode = b.session.surface.nodes[b.session.surface.nodes.length - 1]
  history.deletePart(ctxB, 'session-move', lastNode, 0)
  cases.push(b)
  // 拖动重排
  const c = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A'), userEvent(2, 'B')], [0, 1, 2])
  history.reorderMessages({ sessions: { get: () => c.session }, agents: { list: () => [] } }, 'session-move', [2, 1])
  cases.push(c)
  // 整条删除
  const d = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A')], [0, 1])
  history.deleteMessages({ sessions: { get: () => d.session } }, 'session-move', [1])
  cases.push(d)
  let total = 0
  for (const built of cases) {
    for (const event of built.appended) {
      assertEventShape(event)
      total += 1
    }
  }
  assert.ok(total > 0, '至少要写出一些事件才算覆盖')
})

test('重放模型输出后可见顺序完全不变', () => {
  const built = movableSession(
    [sysEvent(0, 'sys'), userEvent(1, '问'), assistantEvent(2, '答'), userEvent(3, '追问')],
    [0, 1, 2, 3],
  )
  const ctx = { sessions: { get: () => built.session } }
  history.applyEdit(ctx, 'session-move', 2, '改过的回答')
  assert.deepEqual(visibleTexts(built), ['sys', '问', '改过的回答', '追问'])
})

test('含工具轨迹的历史拒绝重放，不写出 v4 打不开的日志', () => {
  const withToolResult = movableSession(
    [sysEvent(0, 'sys'), assistantEvent(1, '读文件', 'c1', 'read_file'), toolEvent(2, 'c1', '文件内容')],
    [0, 1, 2],
  )
  assert.throws(
    () => history.applyEdit({ sessions: { get: () => withToolResult.session } }, 'session-move', 1, '改过'),
    /工具调用|工具输出/,
  )
  assert.equal(withToolResult.appended.length, 0, '拒绝时必须一个事件都不写')

  const bareToolResult = movableSession([sysEvent(0, 'sys'), userEvent(1, '问'), toolEvent(2, 'c9', '结果')], [0, 1, 2])
  assert.throws(
    () => history.reorderMessages({ sessions: { get: () => bareToolResult.session } }, 'session-move', [2, 1]),
    /工具输出|工具调用/,
  )
})

test('v4 会话的 tool/result 写成一等 tool 角色消息', () => {
  const { ctx, appended } = appendHarness()
  ctx.sessions.get('session-append').header.version = 4
  history.appendMessage(ctx, 'session-append', { kind: 'tool-result', text: '结果', callId: 'c9' })
  const message = appended[0].data.message
  assert.equal(appended[0].type, 'tool/result')
  assert.equal(message.role, 'tool')
  assert.equal(message.toolCallId, 'c9')
  assert.equal(message.source.kind, 'tool')
  assert.equal(message.source.callId, 'c9')
  assert.equal(message.content[0].type, 'text')
})

test('user 与 tool/result 仍是原位替换，不触发重放', () => {
  const built = movableSession([sysEvent(0, 'sys'), userEvent(1, 'A'), toolEvent(2, 'c1', '旧结果')], [0, 1, 2])
  const ctx = { sessions: { get: () => built.session }, agents: { list: () => [] } }
  history.applyEdit(ctx, 'session-move', 1, 'A2')
  assert.equal(built.appended[0].type, 'user/message')
  assert.deepEqual(built.appended[0].surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assert.equal(built.appended[0].data.role, 'user')
  history.applyEdit(ctx, 'session-move', 2, '新结果')
  const written = built.appended[1]
  assertEventShape(written)
  assert.equal(written.type, 'tool/result')
  assert.equal(written.data.message.role, 'user')
  assert.equal(written.data.message.content[0].content[0].text, '新结果')
  assert.equal(built.appended.length, 2, '没有多余的重放事件')
})

test('重放超过上限时直接拒绝，不留下半截日志', () => {
  const events = [sysEvent(0, 'sys')]
  const nodes = [0]
  for (let i = 1; i <= 2001; i += 1) {
    events.push(i === 1 ? assistantEvent(i, '第一条回答', 'c1', 't') : userEvent(i, 'm' + String(i)))
    nodes.push(i)
  }
  const built = movableSession(events, nodes)
  const ctx = { sessions: { get: () => built.session } }
  assert.throws(() => history.applyEdit(ctx, 'session-move', 1, '改'), /单次上限/)
  assert.equal(built.appended.length, 0, '拒绝时一个事件都不该写')
})

test('事件形状自检拦得住角色不匹配的写入', () => {
  // 直接构造一条「user/message 承载 assistant 消息」——正是当初写坏会话的形状
  const bad = {
    id: 'manual-context-edit:x',
    role: 'assistant',
    content: [{ type: 'text', text: 'x' }],
    source: { kind: 'model', provider: 'p', model: 'm' },
  }
  assert.equal(ROLE_BY_TYPE['user/message'], 'user')
  assert.equal(typeof bad.role, 'string')
  assert.notEqual(bad.role, ROLE_BY_TYPE['user/message'])
})


