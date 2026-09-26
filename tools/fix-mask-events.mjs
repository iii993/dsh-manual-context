import { homedir } from 'node:os'
/**
 * 修复插件旧版写坏的「非法遮蔽事件」——只动真正导致会话打不开的那些。
 *
 * 症状：某个对话打开后**一片空白而且没有任何报错** —— 其实是会话加载就失败了：
 *   stored session "…" failed validation:
 *   Error: session event at seq N message must have system-prompt source
 *
 * 原因：插件删除/重排节点时用空 system/message 做遮蔽（这一步必须如此 —— 只有
 * system/message 能带 sourceEventSeqs），但来源写成了插件，而 v4 要求它来自 system-prompt。
 *
 * 修法：只把这个来源改成 { kind: 'system-prompt' }，内容仍为空、位置与遮蔽关系完全不变。
 *
 * 用法：
 *   node tools/fix-mask-events.mjs            # 扫描（dry-run）
 *   node tools/fix-mask-events.mjs --apply    # 落盘（先备份 .corrupt-bak）
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MOD = 'H:/npm-global/node_modules/@deepseek-ai/dsh/node_modules'
const asUrl = (f) => 'file://' + f.replace(/\\/g, '/')
const catalog = await import(asUrl(path.join(MOD, '@deepseek-ai/dsh-session-format-catalog/lib/index.js')))
const persistence = await import(asUrl(path.join(MOD, '@deepseek-ai/dsh-session-persistence/lib/index.js')))
const withChildren = catalog.createSessionFormatCatalogWithChildren
const validateStoredEvents = persistence.validateStoredEvents

const PLUGIN_KIND = 'plugin:@dsh-external/manual-context'
const apply = process.argv.includes('--apply')
const root = process.argv.slice(2).find(a => a !== '--apply') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

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

function loadCheck(header, events) {
  const restore = withChildren([]).createRestore(header, { recovery: 'recoverable', validation: 'transformed' })
  for (const event of events) restore.decodeRow(event)
  const artifact = restore.finish()
  validateStoredEvents({ id: header.id, version: artifact.header.version, kind: 'jsonl', path: '' }, (artifact.events ?? []).slice(), header.id)
}

function fixSource(event) {
  return { ...event, data: { ...event.data, message: { ...event.data.message, source: { kind: 'system-prompt' } } } }
}

function filesUnder(dir) {
  const out = []
  function walk(at, depth) {
    if (depth > 3) return
    let entries = []
    try { entries = fs.readdirSync(at, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = path.join(at, entry.name)
      if (entry.isDirectory()) { walk(abs, depth + 1); continue }
      if (entry.name.startsWith('session') && entry.name.endsWith('.jsonl.zstd')) out.push(abs)
    }
  }
  walk(dir, 0)
  return out
}

let scanned = 0
let failing = 0
let repaired = 0
for (const file of filesUnder(root)) {
  scanned += 1
  const lines = readLines(file)
  if (lines.length === 0) continue
  let header
  const events = []
  try {
    header = JSON.parse(lines[0])
    for (const line of lines.slice(1)) events.push(JSON.parse(line))
  } catch { continue }

  let baseline = null
  try { loadCheck(header, events); baseline = 'ok' } catch (error) { baseline = String(error?.cause?.message ?? error?.message ?? error) }
  if (baseline === 'ok') continue
  failing += 1

  let touched = 0
  const next = events.map((event) => {
    if (event === null || typeof event !== 'object') return event
    if (event.type !== 'system/message') return event
    const kind = event.data?.message?.source?.kind
    if (kind === 'system-prompt' || kind !== PLUGIN_KIND) return event
    touched += 1
    return fixSource(event)
  })
  const label = path.basename(path.dirname(file)).slice(0, 26)
  if (touched === 0) {
    console.log('✘ ' + label + ' 加载失败，但不是插件遮蔽事件造成的：' + baseline.slice(0, 90))
    continue
  }

  let after = null
  try { loadCheck(header, next); after = 'ok' } catch (error) { after = String(error?.cause?.message ?? error?.message ?? error) }
  console.log((after === 'ok' ? '✔ ' : '△ ') + label + '  修正 ' + touched + ' 条来源 → ' + (after === 'ok' ? '加载通过' : '仍有问题：' + after.slice(0, 90)))
  if (after !== 'ok' || !apply) continue

  const backup = file + '.corrupt-bak'
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from([lines[0]].concat(next.map(e => JSON.stringify(e))).join('\n') + '\n', 'utf8')))
  repaired += 1
}

console.log('---')
console.log('扫描 ' + scanned + ' 个会话，加载失败 ' + failing + ' 个，' + (apply ? '已修复 ' + repaired + ' 个（备份 *.corrupt-bak）' : 'dry-run 未写盘（加 --apply 执行）'))
