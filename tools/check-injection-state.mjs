/**
 * 诊断：手动上下文注入的节点在「重新加载会话」之后是否还在表面（surface）上。
 * 折叠规则与 dsh 一致：surfaceOp:'append' 追加，{op:'replace',startSeq,endSeq} 原地替换。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const root = process.argv[2] ?? 'H:/dsh-home/sessions'
const limit = Number(process.argv[3] ?? 6)

function readLines(file) {
  const buffer = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
  }
  const chunks = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try { chunks.push(zlib.zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8')) } catch {}
  }
  return chunks.join('').split(/\r?\n/).filter(l => l.trim() !== '')
}

const files = []
;(function walk(dir, depth) {
  if (depth > 3) return
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) { walk(abs, depth + 1); continue }
    if (entry.name.startsWith('session') && entry.name.endsWith('.jsonl.zstd')) files.push({ file: abs, mtime: fs.statSync(abs).mtimeMs })
  }
})(root, 0)
files.sort((a, b) => b.mtime - a.mtime)

for (const item of files.slice(0, limit)) {
  const lines = readLines(item.file)
  if (lines.length < 2) continue
  const events = lines.slice(1).map(l => { try { return JSON.parse(l) } catch { return null } })
  const bySeq = new Map()
  for (const e of events) if (e !== null && Number.isSafeInteger(e.seq)) bySeq.set(e.seq, e)

  const surface = []
  const masked = new Set()
  for (const event of events) {
    if (event === null || event.surfaceOp === undefined) continue
    const op = event.surfaceOp
    if (op === 'append') { surface.push(event.seq); continue }
    if (typeof op === 'object' && op.op === 'replace') {
      for (let s = op.startSeq; s <= op.endSeq; s += 1) if (s !== event.seq) masked.add(s)
      const at = surface.indexOf(op.startSeq)
      if (at >= 0) surface.splice(at, op.endSeq - op.startSeq + 1, event.seq)
      else surface.push(event.seq)
    }
  }

  const messageOf = (seq) => {
    const e = bySeq.get(seq)
    if (e === undefined) return null
    return e.type === 'user/message' ? e.data : (e.data ? e.data.message : null)
  }
  const idOf = (seq) => { const m = messageOf(seq); return m !== null && m !== undefined ? String(m.id ?? '') : '' }
  const isManual = (id) => id.startsWith('manual-context:') && !id.startsWith('manual-context-deleted')

  const onSurface = surface.map(idOf).filter(isManual)
  const allManual = []
  for (const [seq, e] of bySeq) {
    const m = messageOf(seq)
    const id = m !== null && m !== undefined ? String(m.id ?? '') : ''
    if (isManual(id)) allManual.push({ seq, id, masked: masked.has(seq), onSurface: surface.indexOf(seq) >= 0 })
  }
  const revisions = {}
  for (const row of allManual) {
    const rev = /^manual-context:r(\d+):/.exec(row.id)
    const key = rev !== null ? 'r' + rev[1] : 'old(无版本号)'
    revisions[key] = (revisions[key] ?? 0) + 1
  }
  const systemAt = surface.findIndex(s => { const e = bySeq.get(s); return e !== undefined && e.type === 'system/message' && Array.isArray(e.data?.message?.content) && e.data.message.content.length > 0 })

  console.log('=== ' + path.basename(path.dirname(item.file)).slice(0, 26) + '  事件=' + events.length + '  表面节点=' + surface.length)
  console.log('   表面上的手动上下文节点: ' + onSurface.length + '  |  系统提示词位置: ' + systemAt)
  console.log('   历史上出现过的注入节点: ' + JSON.stringify(revisions))
  console.log('   其中仍在表面: ' + allManual.filter(r => r.onSurface).length + ' , 已被遮蔽: ' + allManual.filter(r => !r.onSurface).length)
  const first = surface.slice(0, 8).map(s => { const e = bySeq.get(s); const id = idOf(s); return (e ? e.type.replace('/message', '') : '?') + '#' + String(s) + (id ? '(' + id.slice(0, 26) + ')' : '') })
  console.log('   表面前 8 个: ' + first.join('  '))
}
