/** 手动上下文文件夹管理的单元测试。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'mc-store-'))
process.env.DSH_HOME = join(sandbox, 'home')
process.env.DSH_MANUAL_CONTEXT_DIRS = ''

const store = await import('../src/store.js')

test('ensureRoots 创建工作区与 home 两个目录', () => {
  const cwd = join(sandbox, 'ws')
  const roots = store.ensureRoots(cwd)
  assert.equal(roots.length, 2)
  assert.equal(roots[0], join(cwd, 'manual-context'))
  assert.equal(roots[1], join(sandbox, 'home', 'manual-context'))
})

test('createEntry 写入第一个可写根目录并补全扩展名', () => {
  const cwd = join(sandbox, 'ws')
  const entry = store.createEntry(cwd, '项目约定', '# 约定\n\n使用中文')
  assert.equal(entry.name, '项目约定.md')
  assert.equal(entry.content, '# 约定\n\n使用中文')
  assert.ok(entry.id.startsWith('0:'))
  assert.equal(entry.hash.length, 16)
})

test('segmentsToBody 与 parseSegments 互为逆运算', () => {
  const segments = [
    { meta: {}, text: '无标记的开头段' },
    { meta: { role: 'user' }, text: '第一段\n带换行' },
    { meta: { role: 'tool-call', tool: 'read_file', args: '{"path":"a"}' }, text: '调用' },
    { meta: { role: 'tool-result', callId: 'c1', isError: 'true' }, text: '结果' },
  ]
  const body = store.segmentsToBody(segments)
  const back = store.parseSegments(body)
  assert.equal(back.length, 4)
  assert.equal(back[0].text, '无标记的开头段')
  assert.equal(back[1].meta.role, 'user')
  assert.equal(back[1].text, '第一段\n带换行')
  assert.equal(back[2].meta.tool, 'read_file')
  assert.equal(back[3].meta.callId, 'c1')
  assert.equal(back[3].meta.isError, 'true')
  assert.equal(store.segmentsToBody(back), body, '解析→重组幂等')
})

test('新增的空片段靠段标记保留下来', () => {
  const body = store.segmentsToBody([
    { meta: { role: 'user' }, text: '有内容' },
    { meta: { role: 'assistant' }, text: '' },
  ])
  const back = store.parseSegments(body)
  assert.equal(back.length, 2)
  assert.equal(back[1].meta.role, 'assistant')
  assert.equal(back[1].text, '')
  assert.equal(store.segmentsToBody([{ meta: {}, text: '   ' }]), '', '空段不落盘')
})

test('listEntries 只收录文本文件并忽略隐藏文件', () => {
  const cwd = join(sandbox, 'ws')
  const root = join(cwd, 'manual-context')
  writeFileSync(join(root, 'notes.md'), 'notes')
  writeFileSync(join(root, 'plain.txt'), 'plain')
  writeFileSync(join(root, 'image.png'), 'binary')
  writeFileSync(join(root, '.hidden.md'), 'hidden')
  const names = store.listEntries(cwd).map(e => e.name).sort()
  assert.deepEqual(names, ['notes.md', 'plain.txt', '项目约定.md'])
})

test('writeEntry / readEntry / deleteEntry 往返', () => {
  const cwd = join(sandbox, 'ws')
  const created = store.createEntry(cwd, 'temp', 'old')
  const updated = store.writeEntry(cwd, created.id, 'new content')
  assert.equal(updated.content, 'new content')
  assert.equal(store.readEntry(cwd, created.id).content, 'new content')
  assert.notEqual(updated.hash, created.hash)
  store.deleteEntry(cwd, created.id)
  assert.equal(store.listEntries(cwd).some(e => e.id === created.id), false)
})

test('文件名净化拒绝路径穿越', () => {
  const cwd = join(sandbox, 'ws')
  assert.throws(() => store.createEntry(cwd, '../escape', 'x'))
  assert.throws(() => store.createEntry(cwd, 'sub/child', 'x'))
  assert.throws(() => store.createEntry(cwd, '', 'x'))
})

test('renderEntryBlock 只注入正文（不带文件名与插件标记）', () => {
  const cwd = join(sandbox, 'ws')
  const entry = store.createEntry(cwd, 'rules', 'RULE')
  const full = store.readEntry(cwd, entry.id)
  const block = store.renderEntryBlock(full)
  assert.equal(block, 'RULE')
  assert.equal(block.includes('rules'), false, '不能出现文件名')
  assert.equal(block.includes(store.MARKER), false, '不能出现插件标记')
  assert.equal(store.renderEntryBlock(full, { text: '  片段正文  ', index: 1, meta: {} }), '片段正文', '分段注入只取该段正文')
})

test('DSH_MANUAL_CONTEXT_DIRS 覆盖默认根目录', () => {
  const custom = join(sandbox, 'custom')
  process.env.DSH_MANUAL_CONTEXT_DIRS = custom
  assert.deepEqual(store.contextRoots('ignored'), [custom])
  process.env.DSH_MANUAL_CONTEXT_DIRS = ''
})

test.after(() => { rmSync(sandbox, { recursive: true, force: true }) })

test('composeEntry 组装 frontmatter 与正文', () => {
  assert.equal(store.composeEntry({ role: 'user' }, '正文'), '正文', 'user 是默认值，不写 frontmatter')
  assert.equal(
    store.composeEntry({ role: 'assistant', tool: 'read_file', args: '{"a":1}' }, 'hi'),
    '---\nrole: assistant\ntool: read_file\nargs: {"a":1}\n---\nhi',
  )
  assert.equal(store.composeEntry({ isError: true }, 'x'), '---\nisError: true\n---\nx')
  assert.equal(store.composeEntry({ isError: false, tool: '', callId: null }, 'x'), 'x', '空值全部省略')
})

test('writeEntryMeta 往返：结构化写入后 role 与 meta 都能读回', () => {
  const cwd = join(sandbox, 'ws-meta')
  store.ensureRoots(cwd)
  const entry = store.createEntry(cwd, 'meta', '原始正文')
  const saved = store.writeEntryMeta(cwd, entry.id, { role: 'tool-result', callId: 'c1', isError: true }, '执行失败')
  assert.equal(saved.role, 'tool-result')
  assert.equal(saved.body, '执行失败')
  assert.equal(saved.meta.callId, 'c1')
  assert.equal(saved.meta.isError, 'true')

  // 再改回默认 role：role 行应被移除
  const back = store.writeEntryMeta(cwd, entry.id, { role: 'user' }, '普通正文')
  assert.equal(back.role, 'user')
  assert.equal(back.content, '普通正文')
})
