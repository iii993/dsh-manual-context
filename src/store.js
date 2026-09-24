/**
 * 手动上下文文件夹的发现、创建与读写。
 *
 * 默认根目录（按扫描顺序）：
 *   1. <会话工作区>/manual-context
 *   2. $DSH_HOME/manual-context
 * 环境变量 DSH_MANUAL_CONTEXT_DIRS 可覆盖（分号分隔的绝对路径）。
 *
 * 文件夹内的每个 *.md / *.txt 文件都是一个「手动上下文条目」。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve, extname, basename, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

/** 文件夹名（同时是注入标记的命名空间）。 */
export const FOLDER_NAME = 'manual-context'
/** 注入内容的标记前缀，用于检测「当前上下文里是否已有该条目」。 */
export const MARKER = 'dsh-manual-context'
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text'])
const MAX_FILE_BYTES = 512 * 1024

/** Harness home（与 dsh 自身保持一致的解析顺序）。 */
export function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
}

/** 插件设置文件（放在 $DSH_HOME/manual-context/ 下，与条目目录同级）。 */
const SETTINGS_NAME = 'settings.json'

/** 读取插件设置；文件缺失或损坏时回退到默认值（注入开启）。 */
export function readSettings() {
  const file = join(dshHome(), FOLDER_NAME, SETTINGS_NAME)
  if (!existsSync(file)) return { inject: true }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { inject: parsed === null || typeof parsed !== 'object' ? true : parsed.inject !== false }
  } catch {
    return { inject: true }
  }
}

/** 写入插件设置（只认已知字段）。 */
export function writeSettings(patch) {
  const next = Object.assign(readSettings(), patch !== null && typeof patch === 'object' ? patch : {})
  const root = join(dshHome(), FOLDER_NAME)
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  writeFileSync(join(root, SETTINGS_NAME), JSON.stringify({ inject: next.inject !== false }, null, 2) + '\n', 'utf8')
  return { inject: next.inject !== false }
}

/** 注入总开关：关掉之后同步会把已注入的节点全部遮蔽掉，并且不再注入新内容。 */
export function injectionEnabled() {
  return readSettings().inject === true
}

/** 该工作区要扫描的全部手动上下文根目录。 */
export function contextRoots(cwd) {
  const roots = []
  const configured = process.env.DSH_MANUAL_CONTEXT_DIRS
  if (typeof configured === 'string' && configured.trim() !== '') {
    for (const entry of configured.split(';')) {
      const trimmed = entry.trim()
      if (trimmed !== '') roots.push(resolve(trimmed))
    }
  } else {
    if (typeof cwd === 'string' && cwd.trim() !== '') roots.push(join(resolve(cwd), FOLDER_NAME))
    roots.push(join(dshHome(), FOLDER_NAME))
  }
  const unique = []
  for (const root of roots) if (!unique.includes(root)) unique.push(root)
  return unique
}

/** 创建缺失的根目录（不可写时静默跳过，不阻断会话）。 */
export function ensureRoots(cwd) {
  const ready = []
  for (const root of contextRoots(cwd)) {
    try {
      if (!existsSync(root)) mkdirSync(root, { recursive: true })
      ready.push(root)
    } catch {
      // 只读盘 / 无权限：跳过
    }
  }
  return ready
}

function isTextFile(name) {
  if (name.startsWith('.')) return false
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase())
}

function sha(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** 条目可以模拟的消息角色。 */
export const ENTRY_ROLES = ['user', 'assistant', 'tool-call', 'tool-result', 'reasoning']
const ROLE_SET = new Set(ENTRY_ROLES)

/** 规范化角色名，未知值一律按 user 处理。 */
export function normalizeRole(value) {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return ROLE_SET.has(role) ? role : 'user'
}

/**
 * 解析条目：可选的 YAML 风格 frontmatter + 正文。
 *
 * ```
 * ---
 * role: tool-result
 * callId: manual-call-1
 * isError: false
 * ---
 * 正文
 * ```
 */
/** frontmatter 键的规范写法：解析时把小写、下划线等变体归一到驼峰。 */
const META_KEYS = {
  role: 'role',
  tool: 'tool',
  args: 'args',
  callid: 'callId',
  call_id: 'callId',
  iserror: 'isError',
  is_error: 'isError',
  enabled: 'enabled',
  disabled: 'disabled',
  weight: 'weight',
  priority: 'weight',
}

/** 真假值解析（frontmatter 里都是字符串）。 */
function truthy(value) {
  if (value === true) return true
  if (typeof value !== 'string') return false
  const text = value.trim().toLowerCase()
  return text === 'true' || text === '1' || text === 'yes' || text === 'on'
}

/**
 * 条目是否参与注入（缺省 true）。
 * 支持 `enabled: false` 与 `disabled: true` 两种写法。
 */
export function entryEnabled(meta) {
  const source = meta !== null && typeof meta === 'object' ? meta : {}
  if (source.enabled !== undefined) return truthy(source.enabled)
  if (source.disabled !== undefined) return !truthy(source.disabled)
  return true
}

/**
 * 注入权重（缺省 0）。
 *   <= 0：注入到系统提示词下方（紧接 system prompt）
 *   > 0：注入到正常对话的最后面，权重越大越靠前
 */
export function entryWeight(meta) {
  const source = meta !== null && typeof meta === 'object' ? meta : {}
  const value = Number(source.weight)
  return Number.isFinite(value) ? value : 0
}

/** 段标记：单独一行写成 <!-- role: assistant --> 或 <!-- tool: read_file -->。 */
const SEGMENT_RE = /^<!--\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*?)\s*-->\s*$/

/**
 * 把条目正文切成若干段，每段可以有自己的 role 与工具元数据。
 *
 * 连续的标记行组成「段头」，其后到下一个段头之间的正文属于该段：
 *
 *   <!-- role: tool-call -->
 *   <!-- tool: read_file -->
 *   我来读取配置文件
 *
 *   <!-- role: assistant -->
 *   好的
 *
 * 没有任何标记时返回单段（meta 为空，由文件级 role 决定），因此老写法完全兼容。
 */
export function parseSegments(body) {
  const source = typeof body === 'string' ? body : ''
  const segments = []
  let meta = null
  let buffer = []

  const flush = function () {
    const text = buffer.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
    if (meta !== null) segments.push({ meta, text })
    else if (text !== '') segments.push({ meta: {}, text })
    buffer = []
    meta = null
  }

  for (const line of source.split(/\r?\n/)) {
    const match = SEGMENT_RE.exec(line.trim())
    if (match === null) {
      buffer.push(line)
      continue
    }
    const lower = match[1].toLowerCase()
    const key = META_KEYS[lower] ?? lower
    // 段头还没写正文时，后面的标记行属于同一个段头
    if (meta !== null && buffer.join('\n').trim() === '') {
      meta[key] = match[2]
      continue
    }
    flush()
    meta = {}
    meta[key] = match[2]
  }
  flush()

  if (segments.length === 0) return [{ meta: {}, text: '' }]
  return segments
}

/** 生成一个段标记行（与解析规则保持一致）。 */
export function segmentMarker(key, value) {
  return '<!-- ' + key + ': ' + value + ' -->'
}

/** 段标记行里允许出现的键（同时也是写出顺序）。 */
const SEGMENT_KEYS = ['role', 'tool', 'args', 'callId', 'isError']

/**
 * 把片段数组重组为条目正文 —— 与 {@link parseSegments} 严格对称：
 * 每个片段先写它的段标记行，再写正文，片段之间用换行分隔。
 * 首尾空行会被剥掉，所以「解析 → 重组」是幂等的。
 */
export function segmentsToBody(segments) {
  const list = Array.isArray(segments) ? segments : []
  const blocks = []
  for (const segment of list) {
    if (segment === null || typeof segment !== 'object') continue
    const raw = segment.meta !== null && typeof segment.meta === 'object' ? segment.meta : {}
    const lines = []
    for (const key of SEGMENT_KEYS) {
      const value = raw[key]
      if (value === undefined || value === null) continue
      if (key === 'isError') {
        if (truthy(value)) lines.push(segmentMarker(key, 'true'))
        continue
      }
      const text = String(value).trim()
      if (text === '') continue
      lines.push(segmentMarker(key, text))
    }
    const body = typeof segment.text === 'string' ? segment.text : ''
    if (lines.length === 0 && body.trim() === '') continue
    blocks.push(lines.concat(body.replace(/^\n+/, '').replace(/\n+$/, '')).join('\n'))
  }
  return blocks.join('\n')
}

export function parseEntry(text) {
  const source = typeof text === 'string' ? text : ''
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (match === null) return { meta: {}, body: source, role: 'user' }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const sep = trimmed.indexOf(':')
    if (sep <= 0) continue
    const lower = trimmed.slice(0, sep).trim().toLowerCase()
    meta[META_KEYS[lower] ?? lower] = trimmed.slice(sep + 1).trim()
  }
  return {
    meta,
    body: source.slice(match[0].length),
    role: normalizeRole(meta.role),
    enabled: entryEnabled(meta),
    weight: entryWeight(meta),
  }
}

/** 把 role 写回条目内容的 frontmatter（role 为 user 时移除该字段）。 */
export function applyRole(content, role) {
  const source = typeof content === 'string' ? content : ''
  const parsed = parseEntry(source)
  const meta = { ...parsed.meta }
  const next = normalizeRole(role)
  if (next === 'user') delete meta.role
  else meta.role = next
  const lines = Object.keys(meta).map(key => key + ': ' + meta[key])
  if (lines.length === 0) return parsed.body
  return '---\n' + lines.join('\n') + '\n---\n' + parsed.body
}

/** 条目稳定标识：根目录序号 + 文件名，保证前端不暴露真实绝对路径。 */
function entryId(rootIndex, name) {
  return rootIndex + ':' + name
}

/** 扫描所有根目录，返回条目元数据（不含正文）。 */
export function listEntries(cwd) {
  const roots = ensureRoots(cwd)
  const entries = []
  roots.forEach((root, rootIndex) => {
    let names = []
    try {
      names = readdirSync(root)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (!isTextFile(name)) continue
      const path = join(root, name)
      try {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
        const text = readFileSync(path, 'utf8')
        entries.push({
          id: entryId(rootIndex, name),
          name,
          root,
          path,
          bytes: Buffer.byteLength(text, 'utf8'),
          chars: text.length,
          hash: sha(text),
          role: parseEntry(text).role,
          enabled: parseEntry(text).enabled,
          weight: parseEntry(text).weight,
          mtime: stat.mtimeMs,
        })
      } catch {
        // 读不到就跳过
      }
    }
  })
  return entries
}

/** 读取单个条目：完整内容、正文与解析出的角色。 */
export function readEntry(cwd, id) {
  const entry = listEntries(cwd).find(item => item.id === id)
  if (entry === undefined) throw new Error('手动上下文条目不存在: ' + id)
  const content = readFileSync(entry.path, 'utf8')
  const parsed = parseEntry(content)
  const segments = parseSegments(parsed.body)
  return {
    ...entry,
    content,
    body: parsed.body,
    meta: parsed.meta,
    role: parsed.role,
    enabled: parsed.enabled,
    weight: parsed.weight,
    segments: segments.map(function (segment) { return { meta: { ...segment.meta }, text: segment.text } }),
    segmentRoles: segments.map(function (segment) { return normalizeRole(segment.meta.role ?? parsed.role) }),
  }
}

/** frontmatter 里允许出现的键（同时也是写出顺序）。 */
const FRONT_KEYS = ['role', 'tool', 'args', 'callId', 'isError', 'enabled', 'weight']

/**
 * 把结构化元数据 + 正文组装成条目文件内容。
 * role 为 user、isError 非 true、空字符串都会被省略，保证与文本模式写出的一致。
 */
export function composeEntry(meta, body) {
  const source = meta !== null && typeof meta === 'object' ? meta : {}
  const lines = []
  for (const key of FRONT_KEYS) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (key === 'role') {
      const role = normalizeRole(value)
      if (role !== 'user') lines.push('role: ' + role)
      continue
    }
    if (key === 'isError') {
      if (value === true || value === 'true') lines.push('isError: true')
      continue
    }
    if (key === 'enabled') {
      // 默认开启，只有显式关闭才写出去
      if (value !== undefined && value !== null && value !== '' && !entryEnabled({ enabled: value })) lines.push('enabled: false')
      continue
    }
    if (key === 'weight') {
      const num = Number(value)
      if (Number.isFinite(num) && num !== 0) lines.push('weight: ' + String(num))
      continue
    }
    const text = String(value)
    if (text !== '') lines.push(key + ': ' + text)
  }
  const text = typeof body === 'string' ? body : ''
  if (lines.length === 0) return text
  return '---\n' + lines.join('\n') + '\n---\n' + text
}

/** 用结构化元数据写入条目（JSON 编辑模式）。 */
export function writeEntryMeta(cwd, id, meta, body) {
  return writeEntry(cwd, id, composeEntry(meta, body))
}

/**
 * 写入（覆盖）单个条目；条目必须已存在。
 * @param role - 省略时按内容里的 frontmatter 原样保留。
 */
export function writeEntry(cwd, id, content, role) {
  const entry = listEntries(cwd).find(item => item.id === id)
  if (entry === undefined) throw new Error('手动上下文条目不存在: ' + id)
  if (typeof content !== 'string') throw new Error('content 必须是字符串')
  const next = typeof role === 'string' ? applyRole(content, role) : content
  if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) throw new Error('内容超过 ' + MAX_FILE_BYTES + ' 字节上限')
  writeFileSync(entry.path, next, 'utf8')
  return readEntry(cwd, id)
}

/**
 * 在指定根目录里新建条目。
 * @param rootIndex - 目标根目录下标（见 {@link listRoots}），默认 0（工作区）。
 */
export function createEntry(cwd, name, content, rootIndex = 0, role) {
  const safe = sanitizeName(name)
  const roots = ensureRoots(cwd)
  if (roots.length === 0) throw new Error('没有可写的手动上下文目录')
  const index = Number.isSafeInteger(rootIndex) && rootIndex >= 0 && rootIndex < roots.length ? rootIndex : 0
  const path = join(roots[index], safe)
  if (existsSync(path)) throw new Error('条目已存在: ' + safe)
  const body = typeof content === 'string' ? content : ''
  writeFileSync(path, typeof role === 'string' ? applyRole(body, role) : body, 'utf8')
  return readEntry(cwd, entryId(index, safe))
}

/** 该根目录的人类可读标签。 */
export function rootLabel(root, cwd) {
  if (root === join(dshHome(), FOLDER_NAME)) return '全局（DSH 根目录）'
  if (typeof cwd === 'string' && cwd.trim() !== '' && root === join(resolve(cwd), FOLDER_NAME)) return '项目（当前工作区）'
  return root
}

/** 可写入的根目录清单，供 UI 选择新建位置。 */
export function listRoots(cwd) {
  return ensureRoots(cwd).map((path, index) => ({ index, path, label: rootLabel(path, cwd) }))
}

/** 删除单个条目。 */
export function deleteEntry(cwd, id) {
  const entry = listEntries(cwd).find(item => item.id === id)
  if (entry === undefined) throw new Error('手动上下文条目不存在: ' + id)
  rmSync(entry.path, { force: true })
  return { id, name: entry.name }
}

/** 只允许写入目标目录内的普通文件名。 */
function sanitizeName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('文件名不能为空')
  const trimmed = name.trim()
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes(sep)) throw new Error('文件名不能包含路径分隔符')
  if (trimmed.startsWith('.')) throw new Error('文件名不能以点开头')
  const base = basename(trimmed)
  if (base !== trimmed) throw new Error('文件名不合法')
  if (TEXT_EXTENSIONS.has(extname(base).toLowerCase())) return base
  return base + '.md'
}

/**
 * 为某条目（或它的某一段）生成注入到模型上下文的文本块。
 *
 * 只注入**正文本身**：文件名、路径、插件标记都不该出现在模型看到的内容里。
 * 「是否已同步」靠消息 id（`manual-context:<hash>`）判断，不依赖正文里的标记，
 * 所以去掉包装不影响去重与幂等。
 */
export function renderEntryBlock(entry, segment) {
  const body = segment !== undefined && typeof segment.text === 'string' ? segment.text : entry.content
  return body.trim()
}

/** 该条目对应的、可在历史消息中检索到的唯一标记。 */
export function entryMarker(entry) {
  return '<' + MARKER + ' file="' + entry.name + '" hash="' + entry.hash + '"'
}

