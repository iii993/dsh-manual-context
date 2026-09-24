/**
 * 手动上下文编辑器 — 宿主插件。
 *
 * 1) 自动检测「手动上下文」文件夹，把缺失的条目在每次对话前插入到
 *    用户输入与历史上下文之间（agent/pre-step）。
 * 2) 通过 surface replace 支持在 Web 中直接编辑历史对话，并按会话保存修改状态。
 * 3) 提供 /manual-context 同源 HTTP 接口给浏览器端 UI。
 *
 * @module @dsh-external/manual-context
 */
import { installInjection } from './inject.js'
import { installHttp, applyQueuedOperations } from './http.js'
import { ensureRoots, dshHome, FOLDER_NAME } from './store.js'

export const name = 'manual-context'
export const inject = ['sessions']

/** 挂载注入钩子与 HTTP 接口。 */
export function apply(ctx) {
  installInjection(ctx)
  // 空闲时的编辑/非 user 注入会被排队（那时没有开放的 turn/step）。
  // agent/request 发生在 step/start 之后、请求组装之前，是唯一合法的写入窗口。
  ctx.on('agent/request', async (payload, next) => {
    try {
      applyQueuedOperations(ctx)
    } catch (error) {
      ctx.logger?.warn?.('[manual-context] 排队操作应用失败: ' + (error instanceof Error ? error.message : String(error)))
    }
    return next()
  })
  // dsh 的 HTTP 服务名是 webServer；headless 等没有它的 profile 里这段不会执行，
  // 注入能力仍然照常工作。
  ctx.inject(['webServer', 'sessions', 'agents'], (scope) => {
    try {
      ensureRoots(undefined)
    } catch {
      // home 目录不可写时忽略
    }
    installHttp(scope)
  })
  try {
    ctx.logger?.info?.('[manual-context] 已加载；默认上下文目录: ' + dshHome() + '\\' + FOLDER_NAME)
  } catch {
    // logger 不可用时静默
  }
}

export default { name, inject, apply }
