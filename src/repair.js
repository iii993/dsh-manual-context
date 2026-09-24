/**
 * 修复被插件旧版写坏的会话日志。
 *
 * 症状：对话打开后**一片空白而且没有任何报错** —— 其实是会话**加载**就失败了：
 *   stored session "…" failed validation:
 *   Error: session event at seq N message must have system-prompt source
 *
 * 原因：插件删除 / 重排节点时会写一条空 system/message 把原节点遮蔽掉（必须这么写：
 * 只有 system/message 能带 sourceEventSeqs 这个遮蔽标记），但来源被写成了插件自己；
 * dsh 的 v4 存储校验要求 system/message 来自 system-prompt。
 *
 * 修法：只把这类事件的 source.kind 改成 'system-prompt'。内容仍然为空，位置与遮蔽
 * 关系完全不变，所以模型看到的内容不会有任何变化。原文件先备份成 *.corrupt-bak。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { dshHome } from './store.js'

/** 旧版本给遮蔽事件写的来源 —— 正是会话打不开的原因。 */
export const LEGACY_MASK_SOURCE = 'plugin:@dsh-external/manual-context'

/** 会话日志根目录。 */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** 当前 Node 是否自带 zstd（会话日志是 zstd 压缩的 jsonl）。 */
export function zstdAvailable() {
  return typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function'
}

/** 把 zstd 多帧日志解成行数组（第一行是 header）。 */
export function readSessionLines(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
  }
  const chunks = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8'))
    } catch {
      // 坏帧跳过：修不了的文件会被如实报出来，而不是被静默改坏
    }
  }
  return chunks.join('').split(/\r?\n/).filter(function (line) { return line.trim() !== '' })
}

/** 写回 zstd 单帧日志。 */
function writeSessionLines(file, lines) {
  writeFileSync(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
}

/** 这条事件是不是「非法遮蔽」：system/message 但来源是旧版插件。 */
export function isIllegalMask(event) {
  if (event === null || typeof event !== 'object') return false
  if (event.type !== 'system/message') return false
  return event?.data?.message?.source?.kind === LEGACY_MASK_SOURCE
}

/** 就地修好一条非法遮蔽事件：只改来源，其余一律不动。 */
export function fixIllegalMask(event) {
  return {
    ...event,
    data: { ...event.data, message: { ...event.data.message, source: { kind: 'system-prompt' } } },
  }
}

/** 递归找出所有会话日志文件。 */
function sessionFiles(root) {
  const found = []
  ;(function walk(dir, depth) {
    if (depth > 3) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) { walk(abs, depth + 1); continue }
      if (entry.name.startsWith('session') && entry.name.endsWith('.jsonl.zstd')) found.push(abs)
    }
  })(root, 0)
  return found
}

/**
 * 扫描并（可选）修复所有会话。
 *
 * @param {object} [options]
 * @param {string} [options.root]     会话根目录，默认 $DSH_HOME/sessions
 * @param {boolean} [options.apply]   是否真的写回（false = 只扫描）
 * @param {Set<string>} [options.running] 正在运行的会话 id：跳过，避免和 dsh 内存里的日志打架
 */
export function repairSessions(options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const root = typeof settings.root === 'string' && settings.root !== '' ? settings.root : sessionsRoot()
  const apply = settings.apply === true
  const running = settings.running instanceof Set ? settings.running : new Set()
  const report = {
    ok: true, root, supported: zstdAvailable(),
    scanned: 0, broken: 0, repaired: 0, skippedRunning: 0, failed: 0,
    sessions: [],
  }
  if (!report.supported) {
    report.ok = false
    report.error = '当前 Node 不带 zstd，没法读写会话日志（需要 Node 22.15+ / 24）'
    return report
  }
  if (!existsSync(root)) {
    report.ok = false
    report.error = '找不到会话目录: ' + root
    return report
  }

  for (const file of sessionFiles(root)) {
    report.scanned += 1
    const sessionId = basename(dirname(file))
    if (running.has(sessionId)) { report.skippedRunning += 1; continue }

    let lines
    try { lines = readSessionLines(file) } catch { report.failed += 1; continue }
    if (lines.length < 2) continue

    const events = lines.slice(1).map(function (line) {
      try { return JSON.parse(line) } catch { return null }
    })
    let hit = 0
    const next = events.map(function (event) {
      if (!isIllegalMask(event)) return event
      hit += 1
      return fixIllegalMask(event)
    })
    if (hit === 0) continue

    report.broken += 1
    const row = { id: sessionId, file, fixed: hit, repaired: false }
    if (apply) {
      try {
        const backup = file + '.corrupt-bak'
        if (!existsSync(backup)) copyFileSync(file, backup)
        writeSessionLines(file, [lines[0]].concat(next.map(function (event) { return JSON.stringify(event) })))
        row.repaired = true
        report.repaired += 1
      } catch (error) {
        report.failed += 1
        row.error = error instanceof Error ? error.message : String(error)
      }
    }
    report.sessions.push(row)
  }
  return report
}

/** 会话文件最近修改时间（面板用来提示「这些是刚修过的」）。 */
export function sessionMtime(file) {
  try { return statSync(file).mtimeMs } catch { return null }
}
