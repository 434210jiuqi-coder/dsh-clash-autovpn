/**
 * 把 Clash 恢复到「用户原本的状态」。
 *
 * 这组值是 2026-10-14 08:47（插件第一次动手之前）实测抓取的基线，写死在这里作为兜底：
 * 开发测试过程中若进程被强杀、state.json 里的 restore 记录被后续运行覆盖，用它能把
 * 模式与各节点组选择精确还原。
 *
 * 运行：ELECTRON_RUN_AS_NODE=1 "…\DeepSeek Harness.exe" test/restore-baseline.mjs
 */
import { ClashClient, discoverController, selectableGroups } from '../lib/clash.js'
import { enableSystemProxy } from '../lib/systemproxy.js'
import { patchState } from '../lib/log.js'

const BASELINE = {
  mode: 'global',
  groups: {
    GLOBAL: '🇯🇵 Air-日本02',
    '🌍环球剧场': '🚀默认节点',
    '📲电报信息': '🚀默认节点',
    '📺国内影视': '🚫不走代理',
    '🚀默认节点': '订阅专用节点01',
    '🤖人工智能': '🚀默认节点',
  },
  systemProxy: '127.0.0.1:7890',
}

const found = await discoverController({})
if (!found) {
  console.error('控制面未找到')
  process.exit(1)
}
const client = new ClashClient(found)
console.log('控制面：', found.base, found.label)

const okMode = await client.setMode(BASELINE.mode)
console.log(`模式 → ${BASELINE.mode}：${okMode ? 'OK' : '失败'}`)

const proxies = await client.proxies()
const available = new Set(Object.keys(proxies))
for (const [group, node] of Object.entries(BASELINE.groups)) {
  if (!available.has(group)) {
    console.log(`  跳过（组不存在）：${group}`)
    continue
  }
  const ok = await client.select(group, node)
  console.log(`  ${group} → ${node}：${ok ? 'OK' : '失败'}`)
}

const okSys = enableSystemProxy(BASELINE.systemProxy)
console.log(`系统代理 → ${BASELINE.systemProxy}：${okSys ? 'OK' : '失败'}`)

patchState({ active: false, restore: null, tripped: false, tripInfo: null })

const after = await client.configs()
const proxiesAfter = await client.proxies()
console.log(`\n最终：mode=${after.mode}`)
console.log('最终节点选择 =', JSON.stringify(Object.fromEntries(selectableGroups(proxiesAfter).map((g) => [g.name, g.now]))))
