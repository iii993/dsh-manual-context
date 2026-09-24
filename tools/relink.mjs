#!/usr/bin/env node
/**
 * 把插件重新挂载进 dsh profile 的 node_modules。
 *
 * 背景：profile 由 pnpm 管理（nodeLinker: hoisted），pnpm install 会 prune
 * 掉不在 lockfile 里的顶层包。本插件是**手工 junction**挂载的开发插件，
 * 因此每次用插件管理器安装/更新/卸载别的插件（或 dsh 升级后重装 profile），
 * 这个 junction 就会被清掉，而 cordis.patch.yml 仍在引用它 ——
 * 表现为：面板入口消失、日志报找不到 @dsh-external/manual-context。
 *
 * 用法：
 *   node tools/relink.mjs                       # 用默认路径
 *   node tools/relink.mjs --profile <profile>   # 指定 profile 目录
 *   node tools/relink.mjs --source <插件目录>    # 指定插件源码目录（默认当前目录）
 *   node tools/relink.mjs --dry-run             # 只看会做什么
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const source = resolve(argOf('--source', process.cwd()))
const dshHome = argOf('--dsh-home', process.env.DSH_HOME || 'H:\\dsh-home')
const profile = resolve(argOf('--profile', join(dshHome, 'profiles', 'web')))
const dryRun = args.includes('--dry-run')

const link = join(profile, 'node_modules', '@dsh-external', 'manual-context')

if (!existsSync(join(source, 'package.json'))) {
  console.error('✗ 插件目录里没有 package.json: ' + source)
  process.exit(1)
}
if (!existsSync(profile)) {
  console.error('✗ profile 目录不存在: ' + profile)
  process.exit(1)
}

/** 读出现有链接指向哪里；不是链接则返回 null。 */
function currentTarget(path) {
  try {
    const stat = lstatSync(path)
    if (!stat.isSymbolicLink()) return { kind: 'real', target: null }
    const raw = readlinkSync(path)
    return { kind: 'link', target: raw.replace(/^\\\\\?\\/, '') }
  } catch {
    return null
  }
}

const state = currentTarget(link)
const sameTarget = state && state.kind === 'link' && resolve(state.target) === source

if (sameTarget) {
  console.log('✓ 已挂载: ' + link + '  ->  ' + source)
} else if (dryRun) {
  console.log('· 需要重建: ' + link + '  ->  ' + source + (state ? '（当前: ' + state.kind + '）' : '（当前不存在）'))
} else {
  if (state) rmSync(link, { recursive: true, force: true })
  mkdirSync(join(profile, 'node_modules', '@dsh-external'), { recursive: true })
  symlinkSync(source, link, 'junction')
  console.log('✓ 已重建挂载: ' + link + '  ->  ' + source)
}

// 顺带提醒：profile 的 cordis.patch.yml 必须有对应的 insert 行，否则挂上也不会加载。
const patch = join(profile, 'cordis.patch.yml')
if (existsSync(patch)) {
  const text = readFileSync(patch, 'utf8')
  const declared = text.includes('@dsh-external/manual-context')
  console.log((declared ? '✓' : '✗') + ' cordis.patch.yml ' + (declared ? '已包含' : '缺少') + ' @dsh-external/manual-context 的 insert 行')
}
console.log('提示：改动后需要重启 dsh（宿主插件不热重载）。')
