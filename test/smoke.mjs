/**
 * 端到端自测（真实改动本机 Clash 与系统代理，结束**必定**还原）。
 *
 * 运行（用宿主同款运行时；务必用后台任务跑，因为整轮要 1–3 分钟）：
 *   ELECTRON_RUN_AS_NODE=1 "…\DeepSeek Harness.exe" test/smoke.mjs
 *
 * 三类保障：
 *   1. 开头记录基线（模式 / 各节点组选择 / 系统代理），finally 里无条件还原；
 *   2. 输出同时写 test/smoke-run.log，避免 stdout 管道被提前回收时丢结果；
 *   3. 末尾显式 process.exit，不留悬挂进程。
 */
import fs from 'node:fs'
import { ClashClient, candidateNodes, discoverController, pickNode, regionOf, selectableGroups } from '../lib/clash.js'
import { diagnose, directFetch, policyFetch, proxyFetch } from '../lib/probe.js'
import { VpnManager, DEFAULT_CONFIG } from '../lib/manager.js'
import { readSystemProxy, restoreSystemProxy } from '../lib/systemproxy.js'
import { patchState } from '../lib/log.js'

const RUNLOG = new URL('./smoke-run.log', import.meta.url)
fs.writeFileSync(RUNLOG, '')
const results = []
const origLog = console.log.bind(console)
console.log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
  origLog(line)
  try {
    fs.appendFileSync(RUNLOG, line + '\n')
  } catch {
    /* 忽略 */
  }
}
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ⚠ 必须有：装完出站策略后，进程里剩下的句柄（undici 的 keep-alive 套接字、计量定时器、
// AbortSignal.timeout 的定时器）**全是 unref 的**，事件循环会被抽干 → Node 静默 exit(0)，
// 连 finally 都不会跑。宿主进程里有大量 ref 句柄（HTTP 服务等），不会出现这种情况；
// 独立测试进程必须自己挂一个 ref 的定时器。
const keepAlive = setInterval(() => {}, 1000)

const TARGET = 'https://raw.githubusercontent.com/Lunatic029/dsh-clash-proxy/main/README.md'

let found = null
let client = null
let baseline = null
let manager = null

async function captureBaseline() {
  const cfg = await client.configs()
  const proxies = await client.proxies()
  return {
    mode: cfg.mode,
    groups: Object.fromEntries(selectableGroups(proxies).map((g) => [g.name, g.now])),
    sysProxy: readSystemProxy(),
  }
}

async function restoreBaseline(why) {
  if (!client || !baseline) return
  console.log(`\n[还原] ${why}`)
  try {
    await client.setMode(baseline.mode)
    const proxies = await client.proxies()
    const available = new Set(Object.keys(proxies))
    for (const [group, node] of Object.entries(baseline.groups)) {
      if (available.has(group) && node) await client.select(group, node)
    }
    const after = await client.configs()
    const proxiesAfter = await client.proxies()
    const groupsAfter = Object.fromEntries(selectableGroups(proxiesAfter).map((g) => [g.name, g.now]))
    const groupsSame = Object.entries(baseline.groups).every(([g, n]) => groupsAfter[g] === n)
    console.log(`[还原] mode=${after.mode}（基线 ${baseline.mode}）节点选择一致=${groupsSame}`)
    console.log(`[还原] 节点选择 = ${JSON.stringify(groupsAfter)}`)
    if (String(after.mode) !== String(baseline.mode) || !groupsSame) {
      console.log('[还原] ⚠ 未完全还原，请用 test/restore-baseline.mjs 兜底')
    }
  } catch (error) {
    console.log(`[还原] 失败：${String(error?.message || error)}；请用 test/restore-baseline.mjs 兜底`)
  }
}

try {
  console.log('=== 1) 控制口自动发现 ===')
  found = await discoverController({})
  check('discoverController 找到控制面', Boolean(found), found ? `${found.base}（${found.label}，secret ${found.secret ? '有' : '无'}，来源 ${found.source}）` : '未找到')
  if (!found) throw new Error('控制面未找到，测试无法继续')
  client = new ClashClient(found)
  baseline = await captureBaseline()
  console.log(`     基线：mode=${baseline.mode} 系统代理=${baseline.sysProxy.enable}/${baseline.sysProxy.server}`)
  console.log(`     基线节点选择 = ${JSON.stringify(baseline.groups)}`)

  console.log('\n=== 2) 节点/组解析 ===')
  const proxies = await client.proxies()
  const groups = selectableGroups(proxies)
  const nodes = candidateNodes(proxies, groups)
  check('识别出可切换的节点组', groups.length >= 3, groups.map((g) => `${g.name}(${g.members.length})`).join(' / '))
  check('候选节点数量合理', nodes.length > 20, `${nodes.length} 个`)
  check('剔除广告伪节点', !nodes.some((n) => /订阅|失效|请选|如您|如果/.test(n)), '')
  const hk = nodes.filter((n) => regionOf(n) === '香港')
  const jp = nodes.filter((n) => regionOf(n) === '日本')
  check('地区识别可用', hk.length > 0 && jp.length > 0, `香港 ${hk.length} / 日本 ${jp.length}；样例 ${hk[0] ?? '-'} | ${jp[0] ?? '-'}`)

  console.log('\n=== 3) 单节点测速 ===')
  const sample = jp[0] ?? nodes[0]
  const delay = await client.nodeDelay(sample, 'https://www.gstatic.com/generate_204', 4000)
  check('单节点延迟测试返回数值', typeof delay.delay === 'number', `${sample} → ${delay.delay ?? delay.error}ms`)

  console.log('\n=== 4) 按地区优先选节点 ===')
  const picked = await pickNode({
    client, proxies, groups,
    priority: ['香港', '日本', '新加坡', '台湾', '美国'],
    testUrl: 'https://www.gstatic.com/generate_204',
    timeoutMs: 3000, perRegion: 4,
    report: (m) => console.log(`     · ${m}`),
  })
  check('选出节点', Boolean(picked?.node), picked?.node ? `${picked.node}（${picked.region}，${picked.delayMs}ms）` : JSON.stringify(picked?.failures?.slice(0, 3)))

  console.log('\n=== 5) 诊断：被墙目标 ===')
  const diag = await diagnose({
    target: TARGET,
    proxyUrl: `http://127.0.0.1:${(await client.configs())['mixed-port'] ?? 7890}`,
    controllerOk: true, controllerLabel: found.label,
  })
  check('判定为 vpn-needed', diag.verdict === 'vpn-needed', `${diag.verdict}：${diag.summary.slice(0, 130)}`)
  check('诊断证据含直连失败与代理成功', !diag.evidence.targetDirect?.ok && diag.evidence.targetViaProxy?.ok,
    `直连 ${diag.evidence.targetDirect?.kind} / 代理 HTTP ${diag.evidence.targetViaProxy?.status}`)

  console.log('\n=== 6) 开启代理 ===')
  manager = new VpnManager({
    config: { ...DEFAULT_CONFIG, meterIntervalMs: 600000, autoEnable: false },
    onNotice: (t) => console.log(`     [notice] ${t.slice(0, 150)}`),
  })
  const enabled = await manager.enable({ reason: 'smoke-test', target: TARGET })
  check('开代理成功', enabled.ok === true, `节点=${enabled.node}（${enabled.region}，${enabled.delayMs}ms）组=${enabled.groups.join('/')} 出站=${enabled.egress}`)
  const cfgDuring = await client.configs()
  check('Clash 模式临时切到 rule', cfgDuring.mode === 'rule', `mode=${cfgDuring.mode}（基线 ${baseline.mode}）`)
  const sysDuring = readSystemProxy()
  check('系统代理已打开', sysDuring.enable === 1, `ProxyEnable=${sysDuring.enable} ProxyServer=${sysDuring.server}`)

  console.log('\n=== 7) DSH 自身出站是否真的走代理 ===')
  const directProbe = await directFetch(TARGET, 10000)
  check('直连该目标仍然失败（对照组）', !directProbe.ok, `${directProbe.kind}: ${directProbe.error ?? directProbe.status}`)
  const viaPolicy = await policyFetch(TARGET, 15000)
  check('进程内策略已接管出站（请求到达 GitHub）', viaPolicy.status === 404 || viaPolicy.ok, `HTTP ${viaPolicy.status ?? viaPolicy.error}（${viaPolicy.ms}ms）`)
  const google = await policyFetch('https://www.google.com/generate_204', 15000)
  check('google 经策略可达', google.ok, `HTTP ${google.status ?? google.error}（${google.ms}ms）`)

  console.log('\n=== 8) 流量计量 ===')
  await sleep(1500)
  await manager.tick()
  const usage = manager.status().usage
  check('计量读到累计流量', usage.activationBytes > 0, `本轮 ${usage.activationText}，会话 ${usage.sessionText}，预算 ${usage.budgetText}`)

  console.log('\n=== 9) 运行中换节点（verifyAndMaybeSwitch）===')
  const switched = await manager.verifyAndMaybeSwitch(TARGET, { reason: 'smoke' })
  check('换节点路径可执行', switched.checked === true, JSON.stringify({ ok: switched.ok, ms: switched.ms, switched: switched.switched, node: switched.node }))

  console.log('\n=== 10) 关闭并校验还原 ===')
  const disabled = await manager.disable({ reason: 'smoke-test-end' })
  check('关闭成功', disabled.ok === true, `本轮用量 ${disabled.activationText}`)
  const cfgAfter = await client.configs()
  check('Clash 模式已还原', String(cfgAfter.mode) === String(baseline.mode), `mode=${cfgAfter.mode}`)
  const sysAfter = readSystemProxy()
  check('系统代理已还原', String(sysAfter.enable) === String(baseline.sysProxy.enable) && String(sysAfter.server) === String(baseline.sysProxy.server),
    `ProxyEnable=${sysAfter.enable} ProxyServer=${sysAfter.server}`)

  console.log('\n=== 11) 超预算 → 暂停 → guard 否决 ===')
  manager.config.budgetMB = 0.0001
  manager.active = true
  manager.client = client
  manager.proxyUrl = `http://127.0.0.1:${(await client.configs())['mixed-port'] ?? 7890}`
  manager.lastTotals = null
  manager.lastActivityAt = Date.now()
  await manager.trip({ usedBytes: 3 * 1024 * 1024, budgetBytes: 1024, activationBytes: 3 * 1024 * 1024 })
  check('超预算触发暂停并自动关代理', manager.tripped === true && manager.active === false, String(manager.tripInfo?.message).slice(0, 110))
  const guard = manager.networkToolReason({ name: 'web_fetch', arguments: { url: 'https://x.com' } })
  check('联网工具被 guard 否决', typeof guard === 'string' && /流量守卫/.test(guard), String(guard).slice(0, 80))
  check('非联网工具不受影响', manager.networkToolReason({ name: 'read', arguments: { file_path: 'a.md' } }) === undefined, '')
  check('pwsh 按内容判定联网', manager.isNetworkTool('pwsh', { command: 'git clone https://github.com/a/b' }) === true &&
    manager.isNetworkTool('pwsh', { command: 'Get-ChildItem' }) === false, '')
  check('shouldAutoReact 在暂停后不再自动开', manager.shouldAutoReact('web_fetch', { isError: true, content: [{ type: 'text', text: 'fetch failed ECONNRESET' }] }).react === false, '')
  const resolved = await manager.resolveTrip({ action: 'continue', addMB: 1024 })
  check('同意继续后解除暂停并追加额度', resolved.ok === true && manager.tripped === false && resolved.budgetBytes > 1024 * 1024,
    `预算 ${(resolved.budgetBytes / 1048576).toFixed(0)}MB`)
} catch (error) {
  console.log(`\n!! 测试中断：${error?.stack || error}`)
  results.push({ name: '未捕获异常', ok: false, detail: String(error?.message || error) })
} finally {
  if (manager?.active) {
    try {
      await manager.disable({ reason: 'smoke-finally' })
    } catch {
      /* 忽略 */
    }
  }
  await restoreBaseline('测试结束，恢复基线')
  patchState({ active: false, restore: null, tripped: false, tripInfo: null })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`)
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`)
  console.log(`日志文件：${RUNLOG.pathname}`)
  clearInterval(keepAlive)
  process.exit(failed.length === 0 ? 0 : 2)
}
