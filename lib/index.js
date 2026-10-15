/**
 * dsh-clash-autovpn —— DSH 的「按需 VPN」插件。
 *
 * 它解决的四件事：
 *   1. **判定**：DSH 联网失败时，用「直连目标 / 经本机代理访问同一目标 / 国内基准站」三条对照
 *      判断这次失败是不是墙造成的（而不是网络本身断了或目标站故障）。
 *   2. **开**：确认是墙的问题就自动开代理——自动发现 Clash 控制口、按地区优先序自动选一个
 *      **实测能打开目标**的节点、把 Clash 切到 rule（省订阅流量）、打开系统代理，并且用宿主
 *      自己的 `installProxyFromEnvironment()` 让 DSH 自身出站也走代理。
 *   3. **关**：联网空闲 N 分钟自动关，逐项还原（模式 / 节点选择 / 系统代理 / DSH 出站策略）。
 *   4. **刹车**：VPN 流量超过预算（默认 1GB）立刻关代理、暂停联网工具，并在下一次联网尝试时
 *      用宿主的问答 UI **询问你**是否继续。
 *
 * @module dsh-clash-autovpn
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DEFAULT_CONFIG, VpnManager, fmtBytes } from './manager.js'
import { log, recentLog, logPath, pluginDir, readState } from './log.js'

export const name = 'dsh-clash-autovpn'
export const inject = ['tools']

const VERSION = '0.2.0'

/**
 * 取 `@deepseek-ai/dsh-tools` 的 `defineTool`。
 *
 * 三层：① 具名导入（宿主的 loader 通常能解析 `@deepseek-ai/*`，其它插件也这么写）；
 * ② 安装目录 asar 的绝对路径（应对某些 profile 布局下裸名解析不到）；
 * ③ 兜底恒等函数 + warn（工具定义本身仍是合法对象，注册依然可用，只是少了宿主的校验/归一化）。
 */
async function resolveDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod?.defineTool === 'function') return mod.defineTool
  } catch (error) {
    log('warn', `具名导入 @deepseek-ai/dsh-tools 失败：${String(error?.message || error)}`)
  }
  const roots = []
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules'))
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules'))
  }
  try {
    roots.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules'))
  } catch {
    /* 忽略 */
  }
  for (const root of roots) {
    const target = path.join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    try {
      const mod = await import('file:///' + target.replace(/\\/g, '/').replace(/ /g, '%20'))
      if (typeof mod?.defineTool === 'function') {
        log('info', 'defineTool 取自 asar 绝对路径')
        return mod.defineTool
      }
    } catch {
      /* 试下一个 */
    }
  }
  log('warn', '拿不到宿主的 defineTool，降级为恒等函数（工具仍可注册，但缺少宿主侧的 schema 校验）')
  return (definition) => definition
}

function jsonRender(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/**
 * 把工具返回值净化成「无损 JSON」。宿主会校验工具结果必须能无损 JSON 化——实测
 * `vpn_status({includeLog:false})` 曾因为返回对象里带一个 `undefined` 字段而被整轮拒收
 * （"value is not lossless JSON"）。所以每个工具出口都过一遍这个函数：
 * 丢掉 undefined 键、把 NaN/Infinity 变成 null、Date/Error 转成字符串。
 */
function jsonSafe(value) {
  if (value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'function' || typeof value === 'symbol') return null
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return { name: value.name, message: String(value.message || value) }
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = jsonSafe(item)
    }
    return out
  }
  return String(value)
}

function textOf(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
}

/** 从工具参数里取一个「目标 URL」（用于诊断与节点优选）。 */
function targetFromArgs(toolName, args) {
  let parsed = args
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed.url ?? parsed.uri ?? parsed.href ?? parsed.link
  if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate
  return null
}

export async function apply(ctx, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...(config || {}) }
  const defineTool = await resolveDefineTool()

  /** 待注入下一轮上下文的提示（由 post-execute 的 additionalContexts 通道送出）。 */
  const pendingNotices = []
  const pushNotice = (text) => {
    if (!text) return
    pendingNotices.push(String(text))
    while (pendingNotices.length > 5) pendingNotices.shift()
    log('info', `提示待注入：${String(text).slice(0, 160)}`)
  }

  const manager = new VpnManager({ config: merged, onNotice: pushNotice })

  /* ------------------------------------------------- 对外服务（供其它插件借用） */

  /**
   * 单一实例原则：代理的「开 / 关 / 逐项还原 / 计量 / 预算」状态只有这一份。
   *
   * 别的插件（例如 dsh-sync-autovpn 在开始 GitHub 同步前预开代理）必须通过这个服务借用，
   * **不要**各自 `new VpnManager()`：两份实例各记一份「原始状态」，关闭时会互相覆盖，
   * 典型后果是系统代理被留在开着没人管（见 README「安全边界」）。
   * 取用方式：`const vpn = ctx.get('clashAutovpn')`。
   */
  const publicApi = {
    version: VERSION,
    manager,
    get active() { return manager.active },
    get tripped() { return manager.tripped },
    get proxyUrl() { return manager.proxyUrl },
    status: () => manager.status(),
    noteActivity: () => { manager.noteActivity() },
    enable: (options) => manager.enable(options || {}),
    disable: (options) => manager.disable(options || {}),
    verifyAndMaybeSwitch: (target, options) => manager.verifyAndMaybeSwitch(target, options || {}),
  }
  // 提供共享服务的路径要认多家 cordis：4.x 是 `ctx.provide(name, value)`，更早的写法是
  // `ctx.set(name, value)`。宿主的 ctx 可能只给其中一种（实测桌面宿主里 `ctx.provide`
  // 就是 undefined），所以逐个试，全都不可用就退回到 `globalThis.__dshClashAutovpn`
  // ——dsh-sync-autovpn 的 provider() 会兜底用它，功能不受影响，只是少了「正式服务」这条线。
  const provideAttempts = [
    ['provide', () => ctx.provide?.('clashAutovpn', publicApi)],
    ['set', () => ctx.set?.('clashAutovpn', publicApi)],
  ]
  let providedBy = null
  const provideErrors = []
  for (const [label, run] of provideAttempts) {
    try {
      const result = run()
      if (typeof ctx[label] !== 'function') {
        provideErrors.push(`${label}: 宿主 ctx 没有这个方法`)
        continue
      }
      providedBy = label
      log('info', `已提供 clashAutovpn 服务（${label}）：其它插件可 ctx.get('clashAutovpn') 借用同一个代理实例`)
      void result
      break
    } catch (error) {
      provideErrors.push(`${label}: ${String(error?.message || error)}`)
    }
  }
  if (!providedBy) {
    log(
      'warn',
      `无法以服务形式提供 clashAutovpn（${provideErrors.join('；')}）——` +
        `改为只挂 globalThis.__dshClashAutovpn 兜底；dsh-sync-autovpn 仍能借到同一个实例`,
    )
  }

  /* ------------------------------------------------------------ 生命周期 */

  // 崩溃自愈：上次进程在「代理开着」的状态下消失时，把机器还原回记录的原值。
  manager.recoverOnLoad().catch((error) => log('warn', `崩溃自愈失败：${String(error?.message || error)}`))

  // 卸载时必须关代理：否则会留下「系统代理开着但没人管」。
  try {
    ctx.effect(() => () => {
      // 兜底全局也要一起撤掉：别的插件（dsh-sync-autovpn）在没有服务时会拿它当后备，
      // 卸载后还留着就等于留了个「已关停但看起来可用」的实例。
      try {
        if (globalThis.__dshClashAutovpn === manager) delete globalThis.__dshClashAutovpn
      } catch {
        /* 忽略 */
      }
      manager.shutdown().catch((error) => log('error', `卸载清理失败：${String(error?.message || error)}`))
    }, 'dsh-clash-autovpn: cleanup')
  } catch (error) {
    log('warn', `注册清理钩子失败：${String(error?.message || error)}`)
  }

  /* ------------------------------------------------------------ 暂停守卫 */

  // 超预算后否决一切联网工具调用。guard 是宿主提供的**单调**否决通道：
  // 任何后续监听器都无法把它改回放行，所以这是「一定会暂停」的保证。
  try {
    ctx.tools?.guard?.((exec) => manager.networkToolReason(exec))
  } catch (error) {
    log('warn', `注册联网守卫失败（超预算时的硬暂停将不可用）：${String(error?.message || error)}`)
  }

  /* ------------------------------------------------------------ 询问用户 */

  /**
   * 用宿主的 userQuestions 服务真问一次。返回 'continue' | 'stop' | 'timeout' | 'unavailable'。
   * 注意：approval（审批弹窗）在 approval=never 的会话里会被自动拒绝，所以这里刻意走问答服务。
   */
  async function askUserAboutBudget(exec, info) {
    const questions = ctx.get('userQuestions')
    if (!questions?.ask || !exec?.agent) return { decision: 'unavailable' }
    if (Date.now() - manager.lastAskAt < 60000) return { decision: 'timeout', why: 'recently-asked' }
    manager.lastAskAt = Date.now()
    const usedText = fmtBytes(info?.usedBytes ?? manager.usedBytes)
    const budgetText = fmtBytes(info?.budgetBytes ?? manager.budgetBytes)
    const options = [
      {
        label: `继续：追加 ${merged.budgetMB}MB 额度并重开代理`,
        description: `追加后本会话可用额度变为 ${fmtBytes(manager.budgetBytes + merged.budgetMB * 1024 * 1024)}。`,
      },
      {
        label: '继续：本次不限额（我自己盯着用量）',
        description: '把预算放大到 100GB，仍会记录用量但不再自动暂停。',
      },
      { label: '停止：保持代理关闭，不要联网', description: '我会停下当前联网动作，等你之后明确要求再开。' },
    ]
    const ask = questions.ask({
      questions: [{
        id: 'dsh-clash-autovpn-budget',
        header: 'VPN 流量超预算',
        question:
          `VPN 流量已达 ${usedText}（预算 ${budgetText}）。代理已自动关闭、联网工具已暂停。` +
          `接下来怎么办？`,
        options,
      }],
      agent: exec.agent,
      signal: exec.signal,
      wait: { callId: exec.callId },
    })
    const timeoutMs = Math.max(15000, Number(merged.askTimeoutMs) || 180000)
    const result = await Promise.race([
      ask.then((r) => ({ kind: 'answered', r })).catch((e) => ({ kind: 'error', e })),
      new Promise((resolve) => {
        const t = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
        if (typeof t.unref === 'function') t.unref()
      }),
    ])
    if (result.kind === 'timeout') return { decision: 'timeout' }
    if (result.kind === 'error') {
      log('warn', `询问用户失败：${String(result.e?.message || result.e)}`)
      return { decision: 'unavailable' }
    }
    const answer = result.r?.answers?.[0]
    const selected = String(answer?.selected?.[0] ?? answer?.custom ?? '')
    if (/停止/.test(selected)) return { decision: 'stop', selected }
    if (/不限额/.test(selected)) return { decision: 'continue-unlimited', selected }
    if (/继续/.test(selected)) return { decision: 'continue', selected }
    return { decision: 'stop', selected: selected || '(未选择)' }
  }

  /** 询问 → 按回答放行或否决本次调用。 */
  async function handleTrippedCall(exec, next) {
    const decision = await next()
    if (decision?.kind === 'deny') return decision
    const info = manager.tripInfo
    log('warn', `超预算后捕获到联网调用「${exec?.name}」，开始询问用户`)
    const asked = await askUserAboutBudget(exec, info)

    if (asked.decision === 'continue' || asked.decision === 'continue-unlimited') {
      await manager.resolveTrip({
        action: 'continue',
        addMB: asked.decision === 'continue-unlimited' ? 102400 : merged.budgetMB,
      })
      pushNotice(`〔dsh-clash-autovpn〕用户选择「${asked.selected}」，正在重新开启代理…`)
      try {
        const enabled = await manager.enable({ reason: 'user-continued', target: targetFromArgs(exec?.name, exec?.arguments), force: true })
        pushNotice(
          `〔dsh-clash-autovpn〕代理已重新开启（节点「${enabled.node}」，${enabled.region}，${enabled.delayMs}ms），` +
          `预算上限现在是 ${fmtBytes(manager.budgetBytes)}。可以继续刚才的联网动作。`,
        )
        return { kind: 'allow' }
      } catch (error) {
        return {
          kind: 'deny',
          reason: `用户同意继续，但重新开启代理失败：${String(error?.message || error)}`,
        }
      }
    }

    if (asked.decision === 'timeout' && asked.why === 'recently-asked') {
      return {
        kind: 'deny',
        reason:
          `VPN 流量超预算（已用 ${fmtBytes(manager.usedBytes)} / ${fmtBytes(manager.budgetBytes)}），` +
          `刚刚已经问过用户但还没等到回答，代理保持关闭。请等待用户回答后再试。`,
      }
    }

    await manager.resolveTrip({ action: 'stop' })
    return {
      kind: 'deny',
      reason:
        asked.decision === 'timeout'
          ? `VPN 流量超预算且询问超时（${Math.round((Number(merged.askTimeoutMs) || 180000) / 1000)}s 内没有回答），` +
            `按「停止」处理：代理保持关闭。需要联网请先让用户明确同意（vpn_budget action=continue）。${asked.selected ? `（用户选项：${asked.selected}）` : ''}`
          : `用户选择「${asked.selected}」：保持代理关闭，不要联网。若确需联网，请用户明确同意后再调用 vpn_budget(action=continue)。`,
    }
  }

  /* ------------------------------------------------------------ 钩子 */

  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (manager.isNetworkTool(exec?.name, exec?.arguments)) {
          manager.noteActivity()
          if (manager.tripped) return await handleTrippedCall(exec, next)
        }
      } catch (error) {
        log('warn', `pre-execute 处理异常（放行）：${String(error?.message || error)}`)
      }
      return await next()
    })
    log('info', '联网活动监听已挂载（tools/pre-execute）')
  } catch (error) {
    log('warn', `挂载 pre-execute 失败：${String(error?.message || error)}`)
  }

  /** 一次自动反应（诊断 → 开 / 换节点），有总时长上限，超时则后台继续。 */
  async function reactToFailure(exec, resultText) {
    const target = targetFromArgs(exec?.name, exec?.arguments)
    const report = await manager.diagnose({ target, note: `触发工具：${exec?.name}` })

    if (manager.active) {
      const switched = await manager.verifyAndMaybeSwitch(target, { reason: 'failure-while-active' })
      if (switched.switched) {
        return (
          `〔dsh-clash-autovpn〕代理本来已开启，但这次仍然失败；已自动换到节点「${switched.node}」（${switched.region}）。` +
          `请重试刚才的请求。`
        )
      }
      return (
        `〔dsh-clash-autovpn〕代理已在运行（节点「${manager.node?.name ?? '未知'}」），这次失败经检查**不像**封锁问题` +
        `（判定：${report.verdict}）。${report.summary}`
      )
    }

    if (report.verdict === 'vpn-needed' || report.verdict === 'no-direct-internet' ||
        (report.verdict === 'vpn-region-blocked' && merged.autoEnable !== false)) {
      const region = report.verdict === 'vpn-region-blocked' ? merged.regionPriority?.[0] ?? null : null
      const enabled = await manager.enable({
        reason: `auto:${report.verdict}`,
        target,
        region,
      })
      const check = await manager.verifyAndMaybeSwitch(target, { reason: 'post-enable' })
      return (
        `〔dsh-clash-autovpn〕已自动开启 Clash 代理：节点「${enabled.node}」（${enabled.region}，${enabled.delayMs}ms）` +
        `，模式 ${enabled.mode === 'rule' ? '已临时切到 rule' : '未改动'}，系统代理 ${enabled.systemProxy ?? '未改动'}，` +
        `DSH 出站策略 ${enabled.egress === 'harness' ? '已接管（宿主接口）' : '已接管（降级实现）'}。` +
        `${check.checked && check.ok ? `经代理实测目标已通（${check.ms}ms）` : ''}` +
        `请重试刚才失败的请求。判定依据：${report.summary}`
      )
    }

    return (
      `〔dsh-clash-autovpn〕本次联网失败**判定为非代理问题**（${report.verdict}）：${report.summary}` +
      `未开启代理。` +
      (report.verdict === 'no-internet' ? '请先检查本机网络。' : '')
    )
  }

  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decided = (await next()) ?? { kind: 'accept' }
      try {
        const isNet = manager.isNetworkTool(exec?.name, exec?.arguments)
        if (isNet) manager.noteActivity()

        // ① 联网失败 → 自动判定 + 自动开代理（有总时长上限；超时则转后台，由提示通道送达）
        let immediate = null
        if (isNet && !manager.tripped) {
          const react = manager.shouldAutoReact(exec?.name, result)
          if (react.react) {
            const cap = Math.max(8000, Number(merged.autoReactTimeoutMs) || 30000)
            const task = reactToFailure(exec, textOf(result))
            const raced = await Promise.race([
              task,
              new Promise((resolve) => {
                const t = setTimeout(() => resolve(null), cap)
                if (typeof t.unref === 'function') t.unref()
              }),
            ])
            if (raced) immediate = raced
            else {
              log('warn', `自动反应超过 ${cap}ms 未完成，转入后台；结果会在下一次工具结果时送达`)
              task
                .then((notice) => pushNotice(notice))
                .catch((error) => pushNotice(`〔dsh-clash-autovpn〕自动开代理失败：${String(error?.message || error)}`))
            }
          }
        }

        // ② 把提示（含刚算出来的结论）注入下一轮上下文 —— 宿主唯一采纳的插件副通道
        const drained = [...(immediate ? [immediate] : []), ...pendingNotices.splice(0, pendingNotices.length)]
        if (drained.length === 0) return decided
        return {
          ...decided,
          additionalContexts: [
            ...(Array.isArray(decided?.additionalContexts) ? decided.additionalContexts : []),
            ...drained.map((text) => ({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: String(text).slice(0, 900) }],
              source: { kind: 'dsh-clash-autovpn' },
            })),
          ],
        }
      } catch (error) {
        log('warn', `post-execute 处理异常（放行）：${String(error?.message || error)}`)
      }
      return decided
    })
    log('info', '联网失败监听已挂载（tools/post-execute）')
  } catch (error) {
    log('warn', `挂载 post-execute 失败：${String(error?.message || error)}`)
  }

  /* ------------------------------------------------------------ 工具面 */

  const statusTool = defineTool({
    name: 'vpn_status',
    description:
      'Show the on-demand VPN assistant state: whether the Clash proxy is currently on, which node/region was selected, ' +
      'traffic used in this session vs the budget, whether networking is paused by the traffic guard, and recent log lines.',
    parameters: {
      includeLog: { type: 'boolean', description: 'Include the last few plugin log lines (default true).' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) => {
      const status = manager.status()
      return {
        ...status,
        version: VERSION,
        stateFile: `${pluginDir()}\\state.json`,
        logFile: logPath(),
        persisted: readState(),
        // 注意：includeLog=false 时**不能**写成 recentLog: undefined —— 宿主会以
        // "value is not lossless JSON" 拒收整个结果（已在 jsonSafe 里兜底，这里也不留 undefined）
        ...(args?.includeLog === false ? {} : { recentLog: recentLog(12) }),
      }
    },
    timeoutMs: 15000,
  })

  const diagnoseTool = defineTool({
    name: 'vpn_diagnose',
    description:
      'Decide whether a failed network access is caused by the VPN/proxy being off (great-firewall style blocking), by ' +
      'comparing: direct access to the target, access through the local Clash proxy, and a domestic baseline site. ' +
      'Call this when a fetch/search fails and you want evidence before turning the proxy on. Returns a verdict such as ' +
      'vpn-needed / vpn-region-blocked / no-internet / target-ok-direct / proxy-unreachable.',
    parameters: {
      target: { type: 'string', description: 'The URL that failed, if known (e.g. the web_fetch url).' },
      note: { type: 'string', description: 'Optional free-form note recorded in the plugin log.' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) => manager.diagnose({ target: args?.target ?? null, note: args?.note ?? null }),
    timeoutMs: 90000,
  })

  const enableTool = defineTool({
    name: 'vpn_enable',
    description:
      'Turn the on-demand VPN on: discover the local Clash/mihomo controller, pick the fastest node that can actually ' +
      'reach the target (region priority: 香港 → 日本 → 新加坡 → 台湾 → 美国), switch Clash to rule mode, enable the ' +
      'Windows system proxy, and route the harness own egress through it. Auto-restores everything later.',
    parameters: {
      target: { type: 'string', description: 'URL you want to be able to reach; used to test which node works.' },
      reason: { type: 'string', description: 'Why the proxy is being enabled (recorded in the log).' },
      region: { type: 'string', description: 'Prefer this region first, e.g. 日本 / 新加坡 / 美国.' },
      force: { type: 'boolean', description: 'Enable even if the traffic budget is exhausted (ask the user first).' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) =>
      manager.enable({
        reason: args?.reason || 'tool:vpn_enable',
        target: args?.target ?? null,
        region: args?.region ?? null,
        force: Boolean(args?.force) || manager.tripped,
      }),
    timeoutMs: 120000,
  })

  const disableTool = defineTool({
    name: 'vpn_disable',
    description:
      'Turn the on-demand VPN off and restore everything that was changed: Clash mode, node selections in the groups, the ' +
      'Windows system proxy (only if it still holds the values this plugin wrote), and the harness egress policy. ' +
      'Reports how much traffic this activation used.',
    parameters: {
      reason: { type: 'string', description: 'Why the proxy is being turned off (recorded in the log).' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) => manager.disable({ reason: args?.reason || 'tool:vpn_disable' }),
    timeoutMs: 60000,
  })

  const nodesTool = defineTool({
    name: 'vpn_nodes',
    description:
      'Inspect and control Clash nodes: action=list shows proxy groups and nodes with inferred regions; action=test runs ' +
      'real latency tests through candidate nodes (optionally against a specific url); action=select switches a node ' +
      'manually in the relevant groups.',
    parameters: {
      action: { type: 'string', required: true, description: "One of: 'list', 'test', 'select'." },
      group: { type: 'string', description: 'Proxy group name to act on (default: the first meaningful group).' },
      node: { type: 'string', description: "Required for action='select': exact node name." },
      url: { type: 'string', description: 'URL used for the latency test (default: a 204 foreign baseline).' },
      limit: { type: 'number', description: 'Max nodes to test (default 12).' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) => {
      const action = String(args?.action || 'list')
      if (action === 'list') return await manager.listNodes()
      if (action === 'test') {
        return await manager.testNodes({
          group: args?.group ?? null,
          url: args?.url ?? undefined,
          limit: Number(args?.limit) || 12,
        })
      }
      if (action === 'select') {
        return await manager.selectNode({ node: args?.node, group: args?.group ?? null })
      }
      throw new Error(`未知 action：${action}（可用：list / test / select）`)
    },
    timeoutMs: 120000,
  })

  const budgetTool = defineTool({
    name: 'vpn_budget',
    description:
      'Resolve the paused state after the VPN traffic budget (default 1GB) was exceeded. action=continue adds more ' +
      'allowance (addMB, default one full budget) and re-enables the proxy; action=stop keeps the proxy off; ' +
      'action=reset zeroes the counters. Only use continue/reset after the user explicitly agreed.',
    parameters: {
      action: { type: 'string', required: true, description: "One of: 'continue', 'stop', 'reset'." },
      addMB: { type: 'number', description: "With action='continue': how many MB to add (default: one full budget)." },
      userSaid: { type: 'string', description: "Quote what the user agreed to, for the audit log." },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) => {
      const action = String(args?.action || 'stop')
      if (args?.userSaid) log('info', `用户表态：${String(args.userSaid).slice(0, 300)}`)
      const resolved = await manager.resolveTrip({ action, addMB: args?.addMB ?? null })
      if (action !== 'continue') return resolved
      const enabled = await manager.enable({
        reason: 'tool:vpn_budget:continue',
        target: null,
        force: true,
      })
      return { ...resolved, enabled }
    },
    timeoutMs: 120000,
  })

  const tools = [
    diagnoseTool,
    enableTool,
    disableTool,
    nodesTool,
    budgetTool,
    statusTool,
  ]
  for (const tool of tools) {
    try {
      // 统一在出口净化一次：宿主校验「工具结果必须能无损 JSON 化」，
      // 任何一个 undefined 字段都会让整次调用被拒收（见 jsonSafe 的注释）。
      const raw = tool.execute
      tool.execute = async (args, exec) => jsonSafe(await raw(args, exec))
      ctx.tools.register(tool)
    } catch (error) {
      log('error', `注册工具 ${tool?.name} 失败：${String(error?.message || error)}`)
    }
  }
  log('info', `dsh-clash-autovpn ${VERSION} 已加载：注册 ${tools.length} 个工具（自动开=${merged.autoEnable ? '开' : '关'}，预算=${merged.budgetMB}MB/${merged.budgetScope}，空闲关=${merged.autoDisableIdleMinutes}分钟）`)

  // 便于自动化测试与排查：把管理器挂到全局（只读用途）
  try {
    globalThis.__dshClashAutovpn = manager
  } catch {
    /* 忽略 */
  }
}

export { VpnManager, DEFAULT_CONFIG }
