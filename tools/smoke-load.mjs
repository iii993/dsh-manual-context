import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire('H:/dsh-home/profiles/web/package.json')
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const pluginMod = await import(pathToFileURL(require.resolve('@dsh-external/manual-context')).href)
const plugin = pluginMod.default ?? pluginMod
const ctx = new Context()
let failed = null
ctx.on('internal/error', (e) => { failed = e })
try {
  ctx.plugin(plugin)
  await new Promise((r) => setTimeout(r, 300))
  console.log('APPLY_OK name=' + pluginMod.name + ' inject=' + JSON.stringify(pluginMod.inject))
} catch (error) {
  console.log('APPLY_FAIL ' + (error && error.message ? error.message : String(error)))
}
if (failed) console.log('CTX_ERROR ' + (failed.message ?? String(failed)))
