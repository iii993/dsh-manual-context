import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { repairSessions, isIllegalMask, fixIllegalMask, LEGACY_MASK_SOURCE, readSessionLines, zstdAvailable } from '../src/repair.js'

/** 造一个会话日志（zstd 压缩的 jsonl）。 */
function writeSession(root, sessionId, events) {
  const dir = join(root, '--H-web--', sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  const header = { id: sessionId, version: 4, cwd: 'H:/demo' }
  const lines = [JSON.stringify(header)].concat(events.map(function (event) { return JSON.stringify(event) }))
  writeFileSync(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
  return file
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

test('repairSessions 扫描出坏会话，apply 后修好并留备份', { skip: !zstdAvailable() }, () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-repair-'))
  const good = writeSession(root, 'session-good', [
    { type: 'system/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { id: 's', role: 'system', content: [{ type: 'text', text: 'hi' }], source: { kind: 'system-prompt' } } } },
  ])
  const bad = writeSession(root, 'session-bad', [
    { type: 'user/message', seq: 0, time: 0, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    illegalMask(1, 0),
  ])

  const dry = repairSessions({ root, apply: false })
  assert.equal(dry.scanned, 2)
  assert.equal(dry.broken, 1, '只有坏会话要被算进来')
  assert.equal(dry.repaired, 0, 'dry-run 不写盘')
  assert.equal(dry.sessions[0].id, 'session-bad')
  assert.equal(dry.sessions[0].fixed, 1)

  const applied = repairSessions({ root, apply: true })
  assert.equal(applied.repaired, 1)
  assert.equal(applied.failed, 0)
  assert.equal(existsSync(bad + '.corrupt-bak'), true, '落盘前必须留备份')
  assert.equal(existsSync(good + '.corrupt-bak'), false, '好会话不该被碰')

  // 修完：来源合法、其余字段一字未动
  const events = readSessionLines(bad).slice(1).map(function (line) { return JSON.parse(line) })
  assert.deepEqual(events[1].data.message.source, { kind: 'system-prompt' })
  assert.deepEqual(events[1].surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 })
  assert.equal(events[1].data.message.id, 'manual-context-deleted:0')

  // 再扫一次应该没有坏会话了
  assert.equal(repairSessions({ root, apply: false }).broken, 0)
})

test('repairSessions 跳过正在运行的会话', { skip: !zstdAvailable() }, () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-repair-run-'))
  writeSession(root, 'session-live', [
    { type: 'user/message', seq: 0, time: 0, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    illegalMask(1, 0),
  ])
  const report = repairSessions({ root, apply: true, running: new Set(['session-live']) })
  assert.equal(report.broken, 0, '运行中的会话不动，避免和 dsh 内存里的日志打架')
  assert.equal(report.skippedRunning, 1)
})
