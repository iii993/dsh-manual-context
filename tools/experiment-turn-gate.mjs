import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MOD = 'H:/npm-global/node_modules/@deepseek-ai/dsh/node_modules'
const asUrl = (f) => 'file://' + f.replace(/\\/g, '/')
const catalogModule = await import(asUrl(path.join(MOD, '@deepseek-ai/dsh-session-format-catalog/lib/index.js')))
const persistenceModule = await import(asUrl(path.join(MOD, '@deepseek-ai/dsh-session-persistence/lib/index.js')))
const withChildren = catalogModule.createSessionFormatCatalogWithChildren
const validateStoredEvents = persistenceModule.validateStoredEvents

function readLines(file) {
  const buffer = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i+1] === 0xb5 && buffer[i+2] === 0x2f && buffer[i+3] === 0xfd) starts.push(i)
  }
  const chunks = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i+1] : buffer.length
    try { chunks.push(zlib.zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8')) } catch {}
  }
  return chunks.join('').split(/\r?\n/).filter(l => l.trim() !== '')
}

// 需要一个**真实**的 v4 header（合成的 header 过不了校验），从命令行或环境变量给出：
//   node tools/experiment-turn-gate.mjs <某个 v4 会话文件>
const sample = process.argv[2] ?? process.env.MC_SAMPLE_SESSION
if (typeof sample !== 'string' || sample === '') {
  console.error('用法: node tools/experiment-turn-gate.mjs <某个 v4 会话文件>')
  process.exit(1)
}
const header = JSON.parse(readLines(sample)[0])
const t = Date.now()
const MC = { kind: 'plugin:@dsh-external/manual-context', form: 'instructions' }
const withSeq = (events) => events.map((event, index) => ({ ...event, seq: index }))
const base = withSeq([
  { type: 'turn/start', time: t, data: { turn: 1 } },
  { type: 'step/start', time: t, data: { turn: 1, step: 1 } },
  { type: 'user/message', time: t, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
  { type: 'step/end', time: t, data: { turn: 1, step: 1 } },
  { type: 'turn/end', time: t, data: { turn: 1 } },
])
const seq = base.length

function tryLoad(events, label) {
  try {
    const restore = withChildren([]).createRestore(header, { recovery: 'recoverable', validation: 'transformed' })
    for (const event of events) restore.decodeRow(event)
    const artifact = restore.finish()
    validateStoredEvents({ id: header.id, version: artifact.header.version, kind: 'jsonl', path: '' }, (artifact.events ?? []).slice(), header.id)
    console.log('✔ ' + label)
  } catch (error) {
    console.log('✘ ' + label + ' → ' + String(error && error.message ? error.message : error).slice(0, 160))
  }
}

tryLoad(base, '基线')
// 删除条目时会写的「空内容 system 遮蔽节点」（turn 外）
tryLoad(base.concat([{
  type: 'system/message', time: t, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2],
  data: { turn: 1, step: 1, message: { id: 'manual-context-deleted:2', role: 'system', content: [], source: MC } },
}]), '遮蔽节点（turn 外 replace）')
// 工具返回（turn 外）
tryLoad(base.concat([{
  type: 'tool/result', time: t, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { id: 'mc-tool', role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '结果' }], source: { kind: 'tool', callId: 'call-1' } } },
}]), '工具返回（turn 外 append）')
// 含 reasoning + text + tool-call 的多块 assistant 消息（turn 外）
tryLoad(base.concat([{
  type: 'assistant/message', time: t, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { id: 'mc-blocks', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'v3' },
      content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '说' }, { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{}' }] },
    stream: [{ type: 'reasoning-chunks', time0: t, index: 0, dt: [0], texts: ['想'] }, { type: 'text-chunks', time0: t, index: 1, dt: [0], texts: ['说'] },
      { type: 'tool-call-chunks', time0: t, index: 2, dt: [0], id: 'call-1', name: 'read_file', args: ['{}'] }] },
}]), '多块 assistant（思维链+正文+工具调用，turn 外）')
