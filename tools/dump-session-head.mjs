/**
 * 排查用：按修改时间倒序列出会话，打印每个会话的 surface 节点（含事件来源与遮蔽关系）。
 * 用来确认「对话打不开」「注入位置不对」这类问题。
 *
 * 用法：node tools/dump-session-head.mjs [会话目录] [个数]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const root = process.argv[2] ?? 'H:/dsh-home/sessions'
const limit = Number(process.argv[3] ?? 3)

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
  const events = lines.slice(1).map(l => { try { return JSON.parse(l) } catch { return null } })
  console.log('=== ' + item.file.slice(root.length) + '  事件=' + events.length + '  改动=' + new Date(item.mtime).toLocaleString('zh-CN'))
  for (const event of events.slice(-12)) {
    if (event === null) continue
    const data = event.data ?? {}
    const message = data.message !== undefined ? data.message : (event.type === 'user/message' ? data : null)
    const op = event.surfaceOp === undefined ? '-'
      : (typeof event.surfaceOp === 'string' ? event.surfaceOp : 'replace[' + event.surfaceOp.startSeq + '..' + event.surfaceOp.endSeq + ']')
    console.log('   seq=' + event.seq + ' ' + event.type + ' ' + op
      + ' src=' + (message?.source?.kind ?? '-')
      + ' id=' + String(message?.id ?? '-').slice(0, 34))
  }
}
