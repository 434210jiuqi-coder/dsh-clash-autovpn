/**
 * 装载前预检：按宿主将要使用的那条解析路径（profile 的 node_modules 符号链接）
 * 真正 import 插件入口，并用**真实** defineTool（从 asar 取）+ mock ctx 调一次 apply()，
 * 断言工具与钩子都注册成功。这样能在重启 DSH 之前就抓出装载期错误。
 *
 * 运行（cwd 需为 profile 目录，走 junction 解析）：
 *   node C:\...\dsh-clash-autovpn\test\plugin-load.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profileDir = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
if (!fs.existsSync(profileDir)) {
  console.log(`SKIP  这个预检要有真实 DSH profile：${profileDir}`)
  console.log('      CI / 没装 DSH 的机器上跳过；本插件的真实行为要在本机手动跑 test/smoke.mjs 验。')
  process.exit(0)
}
process.chdir(profileDir)

const registered = []
const hooks = []
const guards = []
const effects = []

const mockCtx = {
  tools: {
    register(tool) {
      registered.push(tool)
      return () => {}
    },
    guard(fn) {
      guards.push(fn)
      return () => {}
    },
  },
  on(event, fn) {
    hooks.push({ event, fn })
    return () => {}
  },
  get() {
    return undefined // userQuestions / launchEnvironment 都不给，验证「没有也要能装」
  },
  effect(callback) {
    const disposer = callback()
    effects.push(disposer)
    return () => {}
  },
}

console.log('cwd =', process.cwd())
console.log('解析入口：', await import.meta.resolve('dsh-clash-autovpn'))

const mod = await import('dsh-clash-autovpn')
console.log('导出：', Object.keys(mod).join(', '))
console.log('name =', mod.name, '| inject =', JSON.stringify(mod.inject))

await mod.apply(mockCtx, {
  autoEnable: false,          // 预检不要触发真实自动行为
  meterIntervalMs: 600000,
  budgetMB: 1024,
})

const toolNames = registered.map((t) => t?.name).sort()
const expected = ['vpn_budget', 'vpn_diagnose', 'vpn_disable', 'vpn_enable', 'vpn_nodes', 'vpn_status']
const okTools = JSON.stringify(toolNames) === JSON.stringify(expected)
const okHooks = hooks.some((h) => h.event === 'tools/pre-execute') && hooks.some((h) => h.event === 'tools/post-execute')
const okGuard = guards.length === 1
const okEffect = effects.length === 1

console.log(`\n注册工具 (${registered.length})：${toolNames.join(', ')}`)
console.log(`钩子：${hooks.map((h) => h.event).join(', ')} | guard：${guards.length} | effect：${effects.length}`)

// 顺手验证工具定义的基本形状（宿主会据此生成 JSON Schema）
for (const tool of registered) {
  if (typeof tool.description !== 'string' || tool.description.length < 20) console.log(`  ⚠ ${tool.name} 描述过短`)
  if (typeof tool.execute !== 'function') console.log(`  ⚠ ${tool.name} 缺少 execute`)
  if (tool.output?.schema === undefined) console.log(`  ⚠ ${tool.name} 缺少 output.schema`)
}

// 真实调用一次 vpn_status（只读），并断言结果能**无损 JSON 化** —— 宿主对工具结果有此校验，
// 曾经因为返回对象里带 undefined 字段被整轮拒收（"value is not lossless JSON"）。
let okJson = false
let statusSummary = ''
try {
  const statusTool = registered.find((t) => t.name === 'vpn_status')
  const noLog = await statusTool.execute({ includeLog: false }, {})
  const roundTrip = JSON.parse(JSON.stringify(noLog))
  const lossless = JSON.stringify(roundTrip) === JSON.stringify(noLog) && JSON.stringify(noLog) !== undefined
  const withLog = await statusTool.execute({ includeLog: true }, {})
  const losslessWithLog = JSON.stringify(JSON.parse(JSON.stringify(withLog))) === JSON.stringify(withLog)
  okJson = lossless && losslessWithLog
  statusSummary = `includeLog=false → active=${noLog.active} usage=${noLog.usage?.sessionText} 键数=${Object.keys(noLog).length}；includeLog=true → recentLog=${withLog.recentLog?.length ?? 0} 行`
} catch (error) {
  statusSummary = `调用失败：${String(error?.message || error)}`
}

const checks = [
  ['工具名齐备', okTools],
  ['pre/post-execute 钩子已挂', okHooks],
  ['联网 guard 已注册', okGuard],
  ['卸载清理 effect 已注册', okEffect],
  ['vpn_status 结果可无损 JSON 化（含 includeLog=false）', okJson],
]
console.log(`\nvpn_status 实测：${statusSummary}`)
let bad = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) bad++
}
console.log(bad === 0 ? '\n装载预检通过 ✅' : `\n装载预检失败：${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
