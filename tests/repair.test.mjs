import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { repairSessions, planRepair, verifySession, visibleSurfaceMessages, isIllegalMask, fixIllegalMask, LEGACY_MASK_SOURCE, ORPHAN_TYPE, readSessionLines, zstdAvailable } from '../src/repair.js'

/** 造一个会话日志（zstd 压缩的 jsonl）。 */
function writeSession(root, sessionId, events) {
  const dir = join(root, '--H-web--', sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  const header = { type: 'session', version: 4, id: sessionId, createdAt: 1, cwd: 'H:/demo', isSeeded: false, delegationDepth: 0 }
  const lines = [JSON.stringify(header)].concat(events.map(function (event) { return JSON.stringify(event) }))
  writeFileSync(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
  return file
}

/** 一条合格的真实系统提示词。 */
function systemPrompt(seq) {
  return {
    type: 'system/message', seq, time: 10 + seq,
    data: { turn: 1, step: 1, message: { id: 'sys-' + String(seq), role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } } },
    surfaceOp: 'append',
  }
}

/** 插件在会话空闲时写下的手动上下文节点（会压在系统提示词前面）。 */
function injectedUser(seq, id) {
  return {
    type: 'user/message', seq, time: 1 + seq,
    data: { id: 'manual-context:r3:' + id, role: 'user', content: [{ type: 'text', text: '手动上下文' }], source: { kind: 'plugin:@dsh-external/manual-context' } },
    surfaceOp: 'append',
  }
}

/** 插件在会话空闲时写下的助手段（落在 turn 之外）。 */
function injectedAssistant(seq, id) {
  return {
    type: 'assistant/message', seq, time: 1 + seq,
    data: { turn: 1, step: 1, message: { id: 'manual-context:r3:' + id + ':1', role: 'assistant', content: [{ type: 'text', text: '模型输出' }], source: { kind: 'model' } } },
    surfaceOp: 'append',
  }
}

/** 旧版插件写的非法遮蔽事件：system/message + 插件来源。 */
function illegalMask(seq, target) {
  return {
    type: 'system/message', seq, time: 1,
    data: { turn: 1, step: 1, message: { id: 'manual-context-deleted:' + String(target), role: 'system', content: [], source: { kind: LEGACY_MASK_SOURCE } } },
    surfaceOp: { op: 'replace', startSeq: target, endSeq: target },
    sourceEventSeqs: [target],
  }
}

/** 合法的空遮蔽事件（来源已经是对的）。 */
function blankMask(seq, target) {
  return {
    type: 'system/message', seq, time: 1,
    data: { turn: 1, step: 1, message: { id: 'manual-context-deleted:' + String(target), role: 'system', content: [], source: { kind: 'system-prompt' } } },
    surfaceOp: { op: 'replace', startSeq: target, endSeq: target },
    sourceEventSeqs: [target],
  }
}

test('isIllegalMask 只认「system/message + 旧版插件来源」', () => {
  assert.equal(isIllegalMask(illegalMask(6, 4)), true)
  assert.equal(isIllegalMask({ type: 'system/message', data: { message: { source: { kind: 'system-prompt' } } } }), false, '正常的系统提示词不能误伤')
  assert.equal(isIllegalMask({ type: 'user/message', data: { source: { kind: LEGACY_MASK_SOURCE } } }), false)
  assert.equal(isIllegalMask(null), false)
})

test('fixIllegalMask 只改来源，位置与遮蔽关系不动', () => {
  const before = illegalMask(6, 4)
  const after = fixIllegalMask(before)
  assert.deepEqual(after.data.message.source, { kind: 'system-prompt' })
  assert.equal(after.type, 'system/message')
  assert.deepEqual(after.surfaceOp, before.surfaceOp)
  assert.deepEqual(after.sourceEventSeqs, before.sourceEventSeqs)
  assert.deepEqual(after.data.message.content, [])
})

test('planRepair：注入节点压在系统提示词前面时，让它退出 surface 折叠', () => {
  const events = [
    injectedUser(0, 'abc'),
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    blankMask(3, 0),
    systemPrompt(4),
  ]
  const plan = planRepair(events)
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, true)
  assert.equal(plan.events[0].type, ORPHAN_TYPE, '被遮蔽的注入节点要整体退出折叠')
  assert.equal(plan.events[0].ignorable, true)
  assert.equal(plan.events[3].surfaceOp, 'append', '失去遮蔽对象的空 system/message 改成追加')
  assert.equal(plan.events[3].sourceEventSeqs, undefined)
  assert.equal(plan.events[4].type, 'system/message', '真实系统提示词一个字都不能动')
})

test('planRepair：被遮蔽的注入段整链退出折叠，不会变成空消息', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    systemPrompt(2),
    { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1 } },
    injectedUser(5, 'xyz'),
    injectedAssistant(6, 'xyz'),
    blankMask(7, 5),
    blankMask(8, 6),
  ]
  const plan = planRepair(events)
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, true)
  // 注入段原本就被空遮蔽事件遮住（模型看不到），所以正确的做法是连遮蔽链一起退出折叠，
  // 而不是降级成 user/message —— 后者会在 surface 上留下空消息，看着就像「历史被修乱了」。
  assert.equal(plan.events[5].type, ORPHAN_TYPE)
  assert.equal(plan.events[6].type, ORPHAN_TYPE)
  assert.equal(plan.events[7].type, ORPHAN_TYPE)
  assert.equal(plan.events[8].type, ORPHAN_TYPE)
  const after = visibleSurfaceMessages(plan.events)
  assert.deepEqual(after.map(function (m) { return m.role + '|' + m.text }), ['system|system prompt'], '可见内容只有原本的系统提示词，没有多出空消息')
})

test('planRepair：真实内容挡住时宁可不动（返回原因）', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    systemPrompt(2),
    { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1 } },
    { type: 'user/message', seq: 5, time: 6, data: { id: 'real-user', role: 'user', content: [{ type: 'text', text: '真实输入' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 6, time: 7, data: { turn: 1, step: 1, message: { id: 'real-assistant', role: 'assistant', content: [{ type: 'text', text: '真实回复' }], source: { kind: 'model' } } }, surfaceOp: 'append' },
  ]
  const plan = planRepair(events)
  // 把助手段降级成 user/message 虽然能过加载校验，但用户打开会话就会发现助手回复
  // 「没了」。宁可放弃也不动内容 —— 这是本轮踩过的坑。
  assert.equal(plan.ok, false, '会改变模型看到的内容就放弃')
  assert.match(String(plan.reason), /内容/)
})

test('planRepair：被遮蔽的注入段连整条遮蔽链一起退出折叠（内容不变）', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    systemPrompt(2),
    { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1 } },
    injectedUser(5, 'ghost'),
    injectedAssistant(6, 'ghost'),
    blankMask(7, 5),
    blankMask(8, 6),
    { type: 'user/message', seq: 9, time: 10, data: { id: 'real-user', role: 'user', content: [{ type: 'text', text: '真实输入' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  ]
  const plan = planRepair(events)
  assert.equal(plan.ok, true)
  assert.equal(plan.changed, true)
  const after = visibleSurfaceMessages(plan.events)
  assert.deepEqual(after.map(function (m) { return m.role + '|' + m.text }), ['system|system prompt', 'user|真实输入'], '可见内容一字不变')
  const changed = plan.events.filter(function (e, index) { return JSON.stringify(e) !== JSON.stringify(events[index]) })
  assert.ok(changed.length > 0, '确实动了事件（否则这份日志根本通不过加载校验）')
})

test('repairSessions 扫描出坏会话，apply 后修好并留备份', { skip: !zstdAvailable() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-repair-'))
  const good = writeSession(root, 'session-good', [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    systemPrompt(2),
  ])
  const bad = writeSession(root, 'session-bad', [
    injectedUser(0, 'deadbeef'),
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    illegalMask(3, 0),
    systemPrompt(4),
  ])

  const dry = await repairSessions({ root, apply: false })
  assert.equal(dry.scanned, 2)
  assert.equal(dry.broken, 1, '只有坏会话要被算进来')
  assert.equal(dry.repaired, 0, 'dry-run 不写盘')
  assert.equal(dry.sessions[0].id, 'session-bad')
  assert.ok(dry.sessions[0].actions.length > 0, '坏会话要给出修复动作')
  assert.equal(dry.sessions[0].after, null, '修复后应当能通过校验')

  const applied = await repairSessions({ root, apply: true })
  assert.equal(applied.repaired, 1)
  assert.equal(applied.failed, 0)
  assert.equal(existsSync(bad + '.corrupt-bak'), true, '落盘前必须留备份')
  assert.equal(existsSync(good + '.corrupt-bak'), false, '好会话不该被碰')

  const events = readSessionLines(bad).slice(1).map(function (line) { return JSON.parse(line) })
  assert.equal(events[0].type, ORPHAN_TYPE, '压在系统提示词前面的注入节点退出折叠')
  assert.equal(events[3].data.message.source.kind, 'system-prompt', '非法遮蔽来源同时被修好')
  assert.deepEqual(events[3].data.message.content, [], '遮蔽事件仍然是空的，模型内容不变')
  assert.equal(events[4].type, 'system/message', '系统提示词不动')

  assert.equal((await repairSessions({ root, apply: false })).broken, 0, '再扫一次应该全好')
})

test('repairSessions 只处理指定的会话', { skip: !zstdAvailable() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-repair-one-'))
  const a = writeSession(root, 'session-a', [injectedUser(0, 'a'), { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }, { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } }, blankMask(3, 0), systemPrompt(4)])
  const b = writeSession(root, 'session-b', [injectedUser(0, 'b'), { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }, { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } }, blankMask(3, 0), systemPrompt(4)])

  const one = await repairSessions({ root, apply: true, sessionId: 'session-a' })
  assert.equal(one.scanned, 1, '只扫指定的那一个会话')
  assert.equal(one.repaired, 1)
  assert.equal(existsSync(a + '.corrupt-bak'), true)
  assert.equal(existsSync(b + '.corrupt-bak'), false, '别的会话一根手指都不碰')
})

test('repairSessions 跳过正在运行的会话', { skip: !zstdAvailable() }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-repair-run-'))
  writeSession(root, 'session-live', [injectedUser(0, 'c'), { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }, { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } }, blankMask(3, 0), systemPrompt(4)])
  const report = await repairSessions({ root, apply: true, running: new Set(['session-live']) })
  assert.equal(report.broken, 0, '运行中的会话不动，避免和 dsh 内存里的日志打架')
  assert.equal(report.skippedRunning, 1)
})

test('verifySession 能认出修好的日志（拿得到 dsh 校验器时）', { skip: !zstdAvailable() }, async () => {
  const header = { type: 'session', version: 4, id: 'session-verify', createdAt: 1, cwd: 'H:/demo', isSeeded: false, delegationDepth: 0 }
  const good = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    systemPrompt(2),
  ]
  const okResult = await verifySession(header, good)
  assert.equal(okResult.ok, true)
  const bad = [injectedUser(0, 'z'), { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }, { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } }, blankMask(3, 0), systemPrompt(4)]
  const badResult = await verifySession(header, bad)
  if (badResult.verified) {
    assert.equal(badResult.ok, false, '坏日志必须被判为打不开')
    const plan = planRepair(bad)
    assert.equal(plan.ok, true)
    assert.equal((await verifySession(header, plan.events)).ok, true, '修完要能通过 dsh 自己的校验')
  }
})
