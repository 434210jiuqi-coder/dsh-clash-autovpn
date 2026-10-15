/**
 * 数据驱动的还原：读 state.json 里记录的原值，把 Clash 模式与各节点组选择还原。
 * 这条路径同时也是插件「崩溃自愈」用的同一段代码（manager.recoverOnLoad）。
 */
import { ClashClient, discoverController, selectableGroups } from '../lib/clash.js'
import { VpnManager, DEFAULT_CONFIG } from '../lib/manager.js'
import { readState, logPath } from '../lib/log.js'

const state = readState()
console.log('state.json =', JSON.stringify({
  active: state.active, node: state.node, restore: state.restore,
}, null, 2))

const found = await discoverController({})
if (!found) {
  console.log('控制面未找到，无法还原')
  process.exit(1)
}
const client = new ClashClient(found)
const before = await client.configs()
console.log(`还原前：mode=${before.mode}`)
const proxies = await client.proxies()
console.log('还原前节点选择 =', JSON.stringify(Object.fromEntries(selectableGroups(proxies).map((g) => [g.name, g.now]))))

const manager = new VpnManager({ config: { ...DEFAULT_CONFIG }, onNotice: () => {} })
const result = await manager.recoverOnLoad()
console.log('recoverOnLoad =', JSON.stringify(result))

const after = await client.configs()
const proxiesAfter = await client.proxies()
console.log(`还原后：mode=${after.mode}`)
console.log('还原后节点选择 =', JSON.stringify(Object.fromEntries(selectableGroups(proxiesAfter).map((g) => [g.name, g.now]))))
console.log('新 state.json =', JSON.stringify(readState()))
console.log('日志：', logPath())
