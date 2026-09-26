/**
 * 浏览器端面板的渲染测试。
 *
 * 用一个极简 React 桩把 `client.js` 里的 Editor 组件渲染成元素树，
 * 通过覆盖 useState 的初值来进入「面板已打开」的各种状态，
 * 从而在没有浏览器的情况下验证布局代码不会抛错、关键控件都在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Editor 里 useState 的调用序号（改组件时若顺序变了，这里要同步）：
 *   0 open · 1 tab · 2 busy · 3 error · 4 status · 5 entries · 6 activeId
 *   7 draft · 8 dirty · 9 history · 10 editing · 11 selectedSeq · 12 editDraft
 *   13 newName · 14 newRoot · 15 role · 16 showCompose · 17 composeKind
 *   18 composeText · 19 composeToolName · 20 composeToolInput · 21 composeIsError
 *   22 newRole · 23 editMode · 24 multiSelect · 25 selectedSeqs · 26 entryMulti
 *   27 selectedIds · 28 entryMode · 29 entryMeta · 30 entryBody · 31 reasoningDraft
 *   32 editingPart · 33 focusPart · 34 dragSeq · 35 dragOverSeq · 36 sessionId
 *   37 sessionOptions · 38 entryEnabled · 39 entryWeight · 40 dragEntryId · 41 dragOverEntry
 *   42 entryView · 43 segList · 44 segIndex · 45 segText · 46 segRole · 47 segDirty
 */
const S = {
  open: 0, tab: 1, status: 4, entries: 5, activeId: 6, draft: 7,
  history: 9, editing: 10, selectedSeq: 11, editDraft: 12, role: 15,
  showCompose: 16, composeKind: 17,
}

/** 按调用序号覆盖 useState 初值的 React 桩。 */
function loadEditor(overrides = {}) {
  let index = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props) {
      return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
    },
    useState(initial) {
      const at = index
      index += 1
      const value = Object.prototype.hasOwnProperty.call(overrides, at)
        ? overrides[at]
        : (typeof initial === 'function' ? initial() : initial)
      return [value, function () {}]
    },
    useEffect() {},
    useLayoutEffect() {},
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
  }
  return { React, stateCount: () => index }
}

let cached = null
async function loadBundle() {
  if (cached !== null) return cached
  const loaded = {}
  globalThis.window = { __ModuleLoader__: { load(definition) { loaded.id = definition.id; loaded.factory = definition.factory } } }
  await import(new URL('../src/client.js', import.meta.url).href)
  assert.equal(loaded.id, '@dsh-external/manual-context')
  cached = loaded
  return cached
}

function render(overrides) {
  const bundle = cached
  const { React } = loadEditor(overrides)
  const mod = bundle.factory(function requireStub(name) {
    if (name === 'react') return React
    throw new Error('未预期的 require: ' + name)
  })
  return mod.ManualContextEditor({ sessionId: 'session-render' })
}

/** 收集元素树里的所有文本。 */
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) texts(child, out)
  }
  return out
}

/** 收集元素树里指定 className 的节点。 */
function byClass(node, className, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) byClass(child, className, out); return out }
  const classes = String((node.props && node.props.className) || '').split(/\s+/)
  if (classes.includes(className)) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) byClass(child, className, out)
  return out
}

await loadBundle()

test('未打开时只渲染入口按钮', () => {
  const tree = render({})
  const all = texts(tree)
  assert.ok(all.some(t => t.includes('上下文编辑')))
  assert.equal(byClass(tree, 'mc-panel').length, 0)
})

test('打开面板后渲染两个标签页与头部', () => {
  const tree = render({ 0: true, 1: 'context', 4: { cwd: 'H:\\demo', roots: [{ index: 0, path: '/a', label: '项目（当前工作区）' }] } })
  const all = texts(tree)
  assert.equal(byClass(tree, 'mc-panel').length, 1)
  assert.ok(all.includes('上下文编辑器'))
  assert.ok(all.includes('手动上下文'))
  assert.ok(all.includes('对话历史'))
  assert.ok(all.includes('项目（当前工作区）'))
})

const MESSAGES = [
  { seq: 0, type: 'system/message', kind: 'system', label: '系统提示词', role: 'system', time: 1, text: '你是助手',
    blocks: [{ type: 'text', text: '你是助手' }],
    parts: [{ index: 0, type: 'text', kind: 'system', label: '系统提示词', text: '你是助手' }],
    toolCalls: [], edited: false, protected: true },
  { seq: 1, type: 'user/message', kind: 'user', label: '用户输入', role: 'user', time: 2, text: '帮我看看配置',
    blocks: [{ type: 'text', text: '帮我看看配置' }],
    parts: [{ index: 0, type: 'text', kind: 'user', label: '用户输入', text: '帮我看看配置' }],
    toolCalls: [], edited: false, protected: false },
  { seq: 2, type: 'assistant/message', kind: 'assistant', label: '模型输出', role: 'assistant', time: 3, text: '我来读取文件',
    blocks: [
      { type: 'text', text: '我来读取文件' },
      { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.md"}' },
    ],
    parts: [
      { index: 0, type: 'text', kind: 'assistant', label: '模型输出', text: '我来读取文件' },
      { index: 1, type: 'tool-call', kind: 'tool-call', label: '工具调用', text: '', toolName: 'read_file', toolInput: '{"path":"a.md"}', callId: 'c1' },
    ],
    toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.md' } }],
    edited: true, protected: false },
]

test('历史页渲染左右分栏与消息列表', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 11: 1 })
  assert.equal(byClass(tree, 'mc-body').length, 1)
  assert.equal(byClass(tree, 'mc-hlist').length, 1, '左侧列表')
  assert.equal(byClass(tree, 'mc-hitem').length, 3, '三条消息')
  const all = texts(tree)
  assert.ok(all.includes('刷新'))
  assert.ok(all.includes('＋ 新增'))
  assert.ok(all.includes('3 条 · 已编辑 0 条'))
  // 列表预览
  assert.ok(all.some(t => t.includes('帮我看看配置')))
  assert.ok(all.some(t => t.includes('工具调用：read_file')))
})

test('选中消息后在右侧渲染完整内容与编辑按钮', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 11: 2 })
  const full = byClass(tree, 'mc-fulltext')
  assert.equal(full.length, 1, '完整正文区')
  assert.equal(full[0].children[0], '我来读取文件')
  assert.equal(byClass(tree, 'mc-part').length, 2, '模型输出与工具调用各占一行')
  assert.equal(byClass(tree, 'mc-ta').length, 0, '未编辑时没有文本框')
  const all = texts(tree)
  assert.ok(all.includes('模型输出 1'), '片段切换条')
  assert.ok(all.includes('工具调用 2'))
  assert.ok(all.includes('编辑整条'))
  assert.ok(all.includes('清除标记'))
})

test('排队中的改动在列表里可见：将被删除 / 将被添加', () => {
  // 排队还没写进日志的改动以前在面板上完全隐形 —— 既不知道排了什么，也没法改。
  const messages = MESSAGES.map(function (message, index) {
    return index === 2 ? Object.assign({}, message, { pendingDelete: true }) : message
  })
  const tree = render({
    0: true, 1: 'history', 11: 0,
    9: {
      messages, edits: [], nodes: [0, 1, 2],
      pendingAdds: [{ queueIndex: 0, source: 'append', kind: 'user', text: '还没写进去的补充', editable: true }],
    },
  })
  const all = texts(tree)
  assert.ok(all.includes('将被删除'), '被删除的消息要有标签')
  assert.ok(all.includes('将被添加'), '待添加的条目要列出来')
  assert.ok(all.some(t => t.includes('还没写进去的补充')), '待添加的正文要能看到')
  assert.ok(all.includes('编辑'), '面板追加的消息要能就地改写')
  assert.ok(all.includes('丢弃'))
})

test('待添加的条目按历史同款显示思维链与工具调用', () => {
  const tree = render({
    0: true, 1: 'history', 11: 0,
    9: {
      messages: MESSAGES, edits: [], nodes: [0, 1, 2],
      pendingAdds: [{
        queueIndex: 0, source: 'append', kind: 'assistant', text: '正文内容',
        reasoning: '先想一想', toolName: 'read_file', toolInput: '{"path":"a"}', editable: true,
      }],
    },
  })
  const all = texts(tree)
  assert.ok(all.includes('思维链（reasoning 块）'), '思维链要单独成块，和历史里一样')
  assert.ok(all.includes('先想一想'))
  assert.ok(all.includes('正文内容'))
  assert.ok(all.some(t => t.includes('工具调用：read_file')), '工具调用也要显示出来')
  assert.ok(byClass(tree, 'mc-hitem').length >= 2, '卡片用历史同款样式')
})

test('排队中的手动上下文段只提示去条目页改', () => {
  const tree = render({
    0: true, 1: 'history', 11: 0,
    9: {
      messages: MESSAGES, edits: [], nodes: [0, 1, 2],
      pendingAdds: [{ queueIndex: 1, source: 'manual-context', kind: 'assistant', text: '条目正文', entryName: 'note.md', editable: false }],
    },
  })
  const all = texts(tree)
  assert.ok(all.includes('将被添加 · 手动上下文'))
  assert.ok(all.some(t => t.includes('note.md')))
  assert.ok(all.some(t => t.includes('去「手动上下文」页改')), '内容在文件里，不能在这里直接改')
})

test('没有排队改动时不显示排队区块', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 11: 0 })
  assert.equal(texts(tree).some(t => t.includes('将被添加')), false)
})

test('系统头的保护提示只在选中它时出现', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 11: 0 })
  assert.equal(byClass(tree, 'mc-fulltext')[0].children[0], '你是助手')
  assert.ok(texts(tree).some(t => t.includes('每轮由 Harness 重渲染')))
})

test('进入编辑态时用文本框替换正文', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 10: 1, 11: 1, 12: '帮我看看配置' })
  assert.equal(byClass(tree, 'mc-fulltext').length, 0)
  const areas = byClass(tree, 'mc-ta')
  assert.equal(areas.length, 2, '正文框 + 思维链框')
  assert.equal(areas[0].props.value, '帮我看看配置')
  assert.equal(byClass(tree, 'mc-reason-ta').length, 1, '思维链专用输入框')
  assert.ok(texts(tree).includes('保存'))
})

test('未选中任何消息时给出引导', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 11: null })
  assert.ok(texts(tree).some(t => t.includes('从左侧选择一条消息')))
})

test('打开新增表单时右侧渲染追加控件', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 16: true, 17: 'tool-call' })
  const all = texts(tree)
  assert.ok(all.includes('新增消息'))
  assert.ok(all.includes('追加到上下文'))
  const selects = byClass(tree, 'mc-select')
  assert.equal(selects.length, 1)
  assert.equal(selects[0].props.value, 'tool-call')
  assert.equal(byClass(tree, 'mc-input').length, 2, '工具名与参数两个输入框')
})

test('手动上下文页渲染条目列表与注入类型下拉', () => {
  const tree = render({
    0: true,
    1: 'context',
    5: [{ id: '0:a.md', name: 'a.md', path: '/w/a.md', role: 'assistant', hash: 'h1', bytes: 1, chars: 1, mtime: 1 }],
    6: '0:a.md',
    7: '正文内容',
    15: 'assistant',
    43: [{ meta: { role: 'assistant' }, text: '正文内容' }],
    44: 0, 45: '正文内容', 46: 'assistant',
    4: { cwd: '/w', roots: [{ index: 0, path: '/w/manual-context', label: '项目（当前工作区）' }], injected: [{ id: '0:a.md', inContext: false }] },
  })
  assert.equal(byClass(tree, 'mc-item').length, 1)
  const selects = byClass(tree, 'mc-select')
  assert.equal(selects.length, 5, '根目录 + 新建角色 + 文件 / 片段 / 片段角色')
  assert.equal(selects[1].props.value, 'user', '新建默认角色')
  assert.equal(selects[2].props.value, '0:a.md', '左边那个下拉选 .md 文件')
  assert.equal(selects[3].props.value, '0', '右边那个下拉选片段')
  assert.equal(selects[4].props.value, 'assistant', '片段角色取自段标记')
  assert.equal(byClass(tree, 'mc-ta')[0].props.value, '正文内容')
  assert.ok(texts(tree).some(t => t.includes('未注入')))
})

/** 按标签与 props 查找元素。 */
function findByType(node, type, match, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findByType(child, type, match, out); return out }
  if (node.type === type && (match === undefined || match(node.props))) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) findByType(child, type, match, out)
  return out
}

const HISTORY_STATE = { 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] } }

test('编辑态提供文本 / JSON 两种方式', () => {
  const base = Object.assign({}, HISTORY_STATE, { 10: 2, 11: 2, 12: '我来读取文件' })
  const textTree = render(base)
  assert.ok(texts(textTree).includes('文本'))
  assert.ok(texts(textTree).includes('JSON'))
  assert.equal(byClass(textTree, 'mc-ta').length, 2, '正文 + 思维链')

  const jsonTree = render(Object.assign({}, base, { 23: 'json', 12: '[{"type":"text","text":"x"}]' }))
  assert.equal(byClass(jsonTree, 'mc-ta-code').length, 1, 'JSON 模式用等宽代码框')
})

test('历史多选模式显示复选框与批量删除', () => {
  const tree = render(Object.assign({}, HISTORY_STATE, { 24: true, 25: [1, 2] }))
  const boxes = findByType(tree, 'input', props => props.type === 'checkbox')
  assert.equal(boxes.length, 3, '每条消息一个复选框')
  assert.equal(boxes.filter(box => box.props.checked === true).length, 2)
  assert.ok(texts(tree).includes('已选 2 条'))
  assert.ok(texts(tree).includes('删除选中'))
})

test('每条历史消息都有删除按钮', () => {
  const tree = render(Object.assign({}, HISTORY_STATE, { 11: 1 }))
  const buttons = findByType(tree, 'button', props => props.title === '从模型可见上下文中删除这条消息')
  assert.equal(buttons.length, 3)
})

test('手动上下文条目支持多选与单条删除', () => {
  const tree = render({
    0: true, 1: 'context',
    5: [{ id: '0:a.md', name: 'a.md', path: '/w/a.md', role: 'user', hash: 'h1' }],
    26: true, 27: ['0:a.md'],
    4: { cwd: '/w', roots: [{ index: 0, path: '/w/manual-context', label: '项目' }], injected: [] },
  })
  const boxes = findByType(tree, 'input', props => props.type === 'checkbox')
  assert.equal(boxes.length, 1, '多选模式下只剩多选框（条目开关改成了按钮）')
  assert.equal(boxes[0].props.checked, true)
  // 每个条目一个注入开关，默认「注入中」
  const toggles = findByType(tree, 'button', props => String(props.className || '').includes('mc-toggle'))
  assert.equal(toggles.length, 1, '每个 .md 一个独立开关')
  assert.equal(toggles[0].props['data-on'], 'true', '默认参与注入')
  assert.ok(texts(tree).includes('注入中'))
  assert.ok(texts(tree).includes('已选 1 项'))
  const buttons = findByType(tree, 'button', props => String(props.className || '').includes('mc-x-sm'))
  assert.equal(buttons.length, 1, '条目上的删除按钮')
})

test('手动上下文条目编辑提供文本 / JSON 切换', () => {
  const tree = render({
    0: true, 1: 'context',
    5: [{ id: '0:a.md', name: 'a.md', path: '/w/a.md', role: 'user', hash: 'h1' }],
    6: '0:a.md', 7: '---\nrole: assistant\n---\n正文',
    42: 'raw',
    28: 'json',
    29: { role: 'assistant' }, 30: '正文',
    4: { cwd: '/w', roots: [{ index: 0, path: '/w/manual-context', label: '项目' }], injected: [] },
  })
  const all = texts(tree)
  assert.ok(all.includes('文本'))
  assert.ok(all.includes('JSON'))
  const buttons = findByType(tree, 'button', props =>
    props.title === '按结构化字段编辑 role / tool / args / callId / isError / body')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].props['data-primary'], 'true', 'JSON 模式高亮')
})

test('条目编辑区有五个段标记按钮', () => {
  const tree = render({
    0: true, 1: 'context',
    5: [{ id: '0:a.md', name: 'a.md', path: '/w/a.md', role: 'user', hash: 'h1' }],
    6: '0:a.md', 7: '正文',
    42: 'raw',
    4: { cwd: '/w', roots: [{ index: 0, path: '/w/manual-context', label: '项目' }], injected: [] },
  })
  const buttons = findByType(tree, 'button', props => String(props.title || '').startsWith('在光标处插入'))
  assert.equal(buttons.length, 5)
  assert.deepEqual(buttons.map(b => b.children[0]), ['用户输入', '模型输出', '思维链', '工具调用', '工具返回'])
})

test('片段视图：两条下拉 + 片段工具条', () => {
  const tree = render({
    0: true, 1: 'context',
    5: [{ id: '0:a.md', name: 'a.md', path: '/w/a.md', role: 'user', hash: 'h1' }],
    6: '0:a.md',
    42: 'segment',
    43: [
      { meta: { role: 'user' }, text: '第一段' },
      { meta: { role: 'tool-call', tool: 'read_file' }, text: '第二段' },
    ],
    44: 1, 45: '第二段', 46: 'tool-call',
    4: { cwd: '/w', roots: [{ index: 0, path: '/w/manual-context', label: '项目' }], injected: [] },
  })
  const all = texts(tree)
  const selects = byClass(tree, 'mc-select')
  assert.equal(selects[2].props.value, '0:a.md', '左边那个下拉选 .md 文件')
  assert.equal(selects[3].props.value, '1', '右边那个下拉选 .md 里的片段')
  assert.equal(selects[4].props.value, 'tool-call', '片段角色')
  const labels = findByType(tree, 'option').map(option => texts(option).join(''))
  assert.ok(labels.some(label => label.includes('用户输入') && label.includes('第一段')), '片段下拉显示角色与预览')
  assert.ok(labels.some(label => label.includes('工具调用') && label.includes('read_file')), '工具名也进预览')
  assert.ok(all.includes('＋ 新增片段'))
  assert.ok(all.includes('删除片段'))
  assert.ok(all.includes('上移'))
  assert.ok(all.includes('下移'))
  assert.ok(all.includes('第 2 / 2 段'))
  assert.equal(byClass(tree, 'mc-ta')[0].props.value, '第二段')
})

test('片段行可拖动，连续的可合并片段带「合」标记', () => {
  const tree = render({
    0: true, 1: 'context',
    5: [{ id: '0:a.md', name: 'a.md', path: '/w/a.md', role: 'user', hash: 'h1' }],
    6: '0:a.md',
    42: 'segment',
    43: [
      { meta: { role: 'reasoning' }, text: '想一下' },
      { meta: { role: 'assistant' }, text: '说出来' },
      { meta: { role: 'tool-call', tool: 'read_file' }, text: '' },
      { meta: { role: 'user' }, text: '提问' },
    ],
    44: 0, 45: '想一下', 46: 'reasoning',
    4: { cwd: '/w', roots: [{ index: 0, path: '/w/manual-context', label: '项目' }], injected: [] },
  })
  const rows = byClass(tree, 'mc-part')
  assert.equal(rows.length, 4)
  assert.equal(rows[0].props.draggable, true, '片段行可拖动')
  assert.equal(rows[0].props['data-drag'], 'false')
  assert.equal(rows[0].props['data-over'], 'false')
  assert.equal(rows.filter(row => texts(row).includes('合')).length, 3, '连续的思维链/模型输出/工具调用三行都标「合」')
  assert.equal(texts(rows[3]).includes('合'), false, 'user 段是分界线，不参与合并')
})

test('有思维链的消息在详情里显示思维链区块', () => {
  const withReasoning = Object.assign({}, MESSAGES[2], { reasoning: '模型当时的想法', hasReasoning: true })
  const tree = render({ 0: true, 1: 'history', 9: { messages: [MESSAGES[0], MESSAGES[1], withReasoning], edits: [], nodes: [0, 1, 2] }, 11: 2 })
  const bodies = byClass(tree, 'mc-reason-body')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].children[0], '模型当时的想法')
  assert.ok(texts(tree).some(t => t.includes('思维链')))
})

test('没有思维链的消息不显示该区块', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 11: 2 })
  assert.equal(byClass(tree, 'mc-reason').length, 0)
})

// 32=editingPart · 33=focusPart · 34=dragSeq · 35=dragOverSeq · 23=editMode

test('消息卡片可拖动排序，系统头不可拖', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 11: 2 })
  const items = byClass(tree, 'mc-hitem')
  assert.equal(items.length, 3)
  assert.equal(items[0].props.draggable, false, '系统头不可拖')
  assert.equal(items[1].props.draggable, true)
  assert.equal(typeof items[2].props.onDrop, 'function', '放下时触发重排')
  assert.equal(typeof items[2].props.onDragOver, 'function')
  assert.equal(byClass(tree, 'mc-drag').length, 2, '两条可拖消息各有一个拖动柄')
})

test('工具返回的内容能显示出来（嵌套 content 要展开）', () => {
  const toolResult = {
    seq: 5, type: 'tool/result', kind: 'tool', label: '工具输出', role: undefined, time: 4,
    text: '文件内容 ABC',
    blocks: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: '文件内容 ABC' }] }],
    parts: [{ index: 0, type: 'tool-result', kind: 'tool-result', label: '工具返回', text: '文件内容 ABC', callId: 'c9', isError: false }],
    toolCalls: [], edited: false, protected: false,
  }
  const tree = render({ 0: true, 1: 'history', 9: { messages: [toolResult], edits: [], nodes: [5] }, 11: 5 })
  const full = byClass(tree, 'mc-fulltext')
  assert.equal(full.length, 1)
  assert.equal(full[0].children[0], '文件内容 ABC')
  assert.ok(texts(tree).some(t => t.includes('文件内容 ABC')), '列表预览与详情都能看到内容')
})

test('工具调用行带独立的编辑与删除按钮', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 11: 2 })
  const parts = byClass(tree, 'mc-part')
  assert.equal(parts.length, 2)
  assert.equal(findByType(parts[1], 'button', props => props.title === '编辑这个片段').length, 1)
  assert.equal(findByType(parts[1], 'button', props => props.title === '只删除这个片段').length, 1)
  assert.equal(findByType(parts[0], 'button', props => props.title === '只删除这个片段').length, 1, '多片段消息里每个片段都能单独删')
})

test('进入片段编辑态：只出现一个文本框且没有思维链框', () => {
  const tree = render({
    0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] },
    10: 2, 11: 2, 12: '{"type":"tool-call","name":"read_file"}', 23: 'json', 32: 1, 33: 1,
  })
  assert.equal(byClass(tree, 'mc-ta').length, 1)
  assert.equal(byClass(tree, 'mc-ta-code').length, 1, '工具调用用等宽 JSON 框')
  assert.equal(byClass(tree, 'mc-reason-ta').length, 0, '片段编辑不显示思维链框')
  const all = texts(tree)
  assert.ok(all.some(t => t.includes('工具调用')))
  assert.ok(all.some(t => t.includes('保存')))
})

test('选中片段后详情只显示该片段', () => {
  const tree = render({ 0: true, 1: 'history', 9: { messages: MESSAGES, edits: [], nodes: [0, 1, 2] }, 11: 2, 33: 1 })
  const full = byClass(tree, 'mc-fulltext')
  assert.equal(full.length, 1)
  assert.ok(String(full[0].children[0]).includes('read_file'), '显示工具调用而不是整条正文')
  assert.ok(texts(tree).includes('编辑该片段'))
  assert.ok(texts(tree).includes('删除该片段'))
})
