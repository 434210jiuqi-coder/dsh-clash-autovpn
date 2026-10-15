/**
 * 状态机：判定 → 开代理（选节点 / 切模式 / 系统代理 / 进程内出口）→ 计量 → 空闲自动关
 *        → 流量超预算时警告 + 暂停 + 询问。
 *
 * 安全底线（写这个文件时最优先的约束）：
 *  - 任何一步失败都不把用户机器留在「系统代理开着但代理不通」的状态：disable() 逐项做、逐项
 *    try/catch，失败只降级记录，最终一定把 active 落回 false；
 *  - 打开之前先**保存**原始值（系统代理两项 / Clash 模式 / 各节点组当前选择），并落盘，
 *    这样 DSH 崩溃后下次装载还能还原（recoverOnLoad）；
 *  - 流量计量以 Clash 自己的累计计数差值为准（/connections 的 uploadTotal+downloadTotal），
 *    不猜、不估算。
 *
 * @module dsh-clash-autovpn/manager
 */
import {
  ClashClient, candidateNodes, discoverController, pickNode, regionOf, selectableGroups,
} from './clash.js'
import { FOREIGN_BASELINE, diagnose, looksNetworkFailure, proxyFetch } from './probe.js'
import { installEgress } from './egress.js'
import { enableSystemProxy, readSystemProxy, refreshWinInet, restoreSystemProxy } from './systemproxy.js'
import { log, patchState, readState } from './log.js'

const MIB = 1024 * 1024
/** 明确会联网的工具名（其余按参数内容判断）。 */
const NETWORK_TOOL_RE = /^(web_fetch|web_search|web_[a-z_]*)$/i
/** 命令行里出现这些就认为这条 pwsh/bash 会联网。 */
const NETWORK_CMD_RE = /https?:\/\/|\bgit\s+(clone|pull|fetch|push)\b|\bcurl\b|\bwget\b|\bgh\s+\w|\bnpm\s+(i|install|view|ping)\b|\bpnpm\s+(add|install|view)\b|\bpip3?\s+install\b|\bInvoke-(WebRequest|RestMethod)\b|\biwr\b|\bdocker\s+pull\b|\bwinget\s+install\b|\bscoop\s+install\b/i
const SHELL_TOOLS = /^(pwsh|bash|terminal|shell|bash_local|pwsh_local)$/i

export const DEFAULT_CONFIG = {
  /** 自动模式：检测到「被墙」就自动开代理。关掉后只能用工具手动开。 */
  autoEnable: true,
  /** 联网空闲多少分钟后自动关代理。 */
  autoDisableIdleMinutes: 3,
  /** 流量预算（MB）。超过后警告 + 暂停 + 询问。 */
  budgetMB: 1024,
  /** 预算口径：session=本次 DSH 进程累计；day=当日累计（跨重启）。 */
  budgetScope: 'session',
  /** 自动选节点时的地区优先序。 */
  regionPriority: ['香港', '日本', '新加坡', '台湾', '美国'],
  /** 开代理时是否临时把 Clash 切到 rule（国内直连、只有国外走节点），关代理时还原。 */
  switchModeToRule: true,
  /** 是否接管 Windows 系统代理（其它程序用；DSH 自身不依赖它）。 */
  touchSystemProxy: true,
  /** 代理地址：'auto' 表示用控制面 /configs 里的混合端口。 */
  proxyUrl: 'auto',
  /** 控制口：'auto' 表示自动发现。 */
  controller: 'auto',
  controllerSecret: null,
  /** 要在哪些节点组里同步切换节点：'auto' = 所有有意义的 select 组。 */
  targetGroups: 'auto',
  /** 计量轮询间隔。 */
  meterIntervalMs: 10000,
  /** 节点测速阈值：经代理实测超过这个毫秒数就尝试换节点。 */
  speedThresholdMs: 2500,
  /** 询问用户时的等待上限；超时按「停止」处理（宁可不做，也不偷偷烧流量）。与宿主自带
   *  ask_user_question 的默认等待（120s）对齐，避免在一次工具调用里挂太久触发调用超时策略。 */
  askTimeoutMs: 120000,
  /** 自动开代理的频率上限（次/小时），防止故障时空转。 */
  maxAutoEnablesPerHour: 6,
}

/** 选区/取根 URL 作为测速地址：root 比深层页面更可能返回 2xx/3xx。 */
function testUrlFor(target) {
  if (!target) return FOREIGN_BASELINE
  try {
    const u = new URL(target)
    return `${u.protocol}//${u.host}/`
  } catch {
    return FOREIGN_BASELINE
  }
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < MIB) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * MIB) return `${(n / MIB).toFixed(1)} MB`
  return `${(n / (1024 * MIB)).toFixed(2)} GB`
}

function dayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class VpnManager {
  /**
   * @param {object} options
   * @param {object} options.config 已归一化的配置
   * @param {(text: string) => void} [options.onNotice] 需要用户可见的提示（注入下一轮上下文）
   * @param {object} [options.services] 宿主服务（ctx.get 得到的 tools / userQuestions）
   */
  constructor({ config, onNotice = () => {}, services = {} } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) }
    this.onNotice = onNotice
    this.services = services
    this.onLog = (level, message) => log(level, message)

    /** 运行期状态（不落盘的放这里）。 */
    this.active = false
    this.enabledAt = null
    this.tripped = false
    this.tripInfo = null
    this.client = null
    this.proxyUrl = null
    this.node = null
    this.region = null
    this.delayMs = null
    this.activationBytes = 0
    this.lastTotals = null
    this.lastTotalsAt = null
    this.lastActivityAt = null
    this.timer = null
    this.restore = null
    this.autoEnableTimes = []
    this.lastAskAt = 0
    this.lastFailureSeenAt = 0

    const state = readState()
    // 口径说明（与 README 一致）：
    //   session = **本次装载（≈ 本次 DSH 启动）** 的累计，跨重启归零；
    //   需要跨重启的当日累计就用 budgetScope: 'day'（按日期键自然跨重启累加，次日清零）。
    //   两者都清零时，用户主动追加的额外额度（extraBytes）也一并归零 —— 新会话给一份干净预算。
    this.sessionBytes = 0
    this.extraBytes = 0
    const today = dayKey()
    const sameDay = state.dayKey === today
    this.day = { key: today, bytes: sameDay ? Number(state.dayBytes) || 0 : 0 }
    this.enableCount = 0
    this.persist({ dayKey: this.day.key, dayBytes: this.day.bytes })
  }

  /* ------------------------------------------------------------ 配置与状态 */

  get budgetBytes() {
    const base = Number(this.config.budgetMB) * MIB
    return base + this.extraBytes
  }

  get usedBytes() {
    return this.config.budgetScope === 'day' ? this.day.bytes : this.sessionBytes
  }

  persist(patch = {}) {
    return patchState({
      sessionBytes: this.sessionBytes,
      extraBytes: this.extraBytes,
      enableCount: this.enableCount,
      dayKey: this.day.key,
      dayBytes: this.day.bytes,
      ...patch,
    })
  }

  status() {
    const asked = this.budgetBytes
    return {
      active: this.active,
      tripped: this.tripped,
      tripInfo: this.tripInfo,
      enabledAt: this.enabledAt,
      node: this.node,
      region: this.region,
      delayMs: this.delayMs,
      proxyUrl: this.proxyUrl,
      controller: this.client?.base ?? null,
      controllerLabel: this.client?.label ?? null,
      usage: {
        scope: this.config.budgetScope,
        sessionBytes: this.sessionBytes,
        dayBytes: this.day.bytes,
        activationBytes: this.activationBytes,
        budgetBytes: asked,
        extraBytes: this.extraBytes,
        percent: asked > 0 ? Math.min(100, Math.round((this.usedBytes / asked) * 100)) : 0,
        sessionText: fmtBytes(this.sessionBytes),
        activationText: fmtBytes(this.activationBytes),
        budgetText: fmtBytes(asked),
      },
      lastActivityAt: this.lastActivityAt,
      idleCloseMinutes: this.config.autoDisableIdleMinutes,
      enableCount: this.enableCount,
      config: {
        autoEnable: this.config.autoEnable,
        budgetMB: this.config.budgetMB,
        budgetScope: this.config.budgetScope,
        regionPriority: this.config.regionPriority,
        switchModeToRule: this.config.switchModeToRule,
        touchSystemProxy: this.config.touchSystemProxy,
      },
    }
  }

  /* ------------------------------------------------------------ 工具识别 */

  /** 这个工具调用是否可能联网。 */
  isNetworkTool(name, args) {
    const n = String(name || '')
    if (NETWORK_TOOL_RE.test(n)) return true
    if (SHELL_TOOLS.test(n)) {
      let text = ''
      try {
        text = typeof args === 'string' ? args : JSON.stringify(args ?? {})
      } catch {
        text = ''
      }
      return NETWORK_CMD_RE.test(text)
    }
    return false
  }

  /** guard 用：被暂停时否决联网工具调用，返回否决理由（undefined = 放行）。 */
  networkToolReason(exec) {
    if (!this.tripped) return undefined
    const name = exec?.name
    if (!this.isNetworkTool(name, exec?.arguments)) return undefined
    return (
      `VPN 流量守卫已暂停联网：本次已用 ${fmtBytes(this.usedBytes)} / 预算 ${fmtBytes(this.budgetBytes)}。` +
      `代理已自动关闭。请先询问用户（ask_user_question）是否继续——用户同意后用 vpn_budget 工具放行。`
    )
  }

  /** 记录一次「有联网意图」的活动，用于空闲判定。 */
  noteActivity() {
    this.lastActivityAt = Date.now()
  }

  /* ------------------------------------------------------------ 诊断 */

  async diagnose({ target = null, note = null } = {}) {
    const found = await discoverController({
      controller: this.config.controller,
      controllerSecret: this.config.controllerSecret,
    })
    const client = found ? new ClashClient(found) : null
    let proxyUrl = null
    if (client) {
      try {
        const cfg = await client.configs()
        const port = cfg['mixed-port'] ?? cfg.port ?? cfg['socks-port']
        if (port) proxyUrl = `http://127.0.0.1:${port}`
      } catch {
        /* 控制面读不到配置，用兜底端口 */
      }
    }
    proxyUrl = proxyUrl || (this.config.proxyUrl !== 'auto' ? this.config.proxyUrl : 'http://127.0.0.1:7890')

    const report = await diagnose({
      target,
      proxyUrl,
      controllerOk: Boolean(found),
      controllerLabel: found?.label ?? null,
    })
    log('info', `诊断(${target || '无目标'}) → ${report.verdict}：${report.summary}`)
    return {
      ...report,
      note,
      controller: found ? { base: found.base, label: found.label, source: found.source } : null,
      proxyUrl,
      active: this.active,
    }
  }

  /* ------------------------------------------------------------ 开关 */

  async clientOrThrow() {
    if (this.client) return this.client
    const found = await discoverController({
      controller: this.config.controller,
      controllerSecret: this.config.controllerSecret,
    })
    if (!found) {
      throw new Error(
        '未找到 Clash/mihomo 控制口。请确认代理软件已启动；或在插件配置里显式指定 controller（如 127.0.0.1:9090）与 controllerSecret。',
      )
    }
    this.client = new ClashClient(found)
    return this.client
  }

  /** 目标节点组：auto = 所有「有意义的 select 组」。 */
  async targetGroups(client, proxies) {
    const all = selectableGroups(proxies)
    if (Array.isArray(this.config.targetGroups) && this.config.targetGroups.length > 0) {
      const wanted = new Set(this.config.targetGroups)
      const picked = all.filter((g) => wanted.has(g.name))
      if (picked.length > 0) return picked
      log('warn', `配置里的 targetGroups 在本次 /proxies 里一个都不存在，回退到 auto`)
    }
    return all
  }

  /**
   * 开启代理。
   * @param {{reason?: string, target?: string|null, region?: string|null, force?: boolean}} options
   */
  async enable({ reason = 'manual', target = null, region = null, force = false } = {}) {
    if (this.active) return { ok: true, already: true, status: this.status() }
    if (this.tripped && !force) {
      return {
        ok: false,
        blocked: 'tripped',
        message: `流量预算已用尽（${fmtBytes(this.usedBytes)} / ${fmtBytes(this.budgetBytes)}），已暂停联网。请先用 vpn_budget 询问用户如何处理。`,
        status: this.status(),
      }
    }

    const client = await this.clientOrThrow()
    const proxies = await client.proxies()
    const groups = await this.targetGroups(client, proxies)
    if (groups.length === 0) throw new Error('没找到可切换的节点组（/proxies 里没有可用的 select 组）')

    const restore = {
      clash: { mode: null, groups: {} },
      sysProxy: null,
      wroteSysProxyServer: null,
      egress: null,
    }

    // ① 记录原始模式，按需切到 rule
    try {
      const cfg = await client.configs()
      restore.clash.mode = cfg.mode ?? null
      const mixedPort = cfg['mixed-port'] ?? cfg.port ?? 7890
      if (this.config.proxyUrl && this.config.proxyUrl !== 'auto') {
        this.proxyUrl = this.config.proxyUrl
      } else {
        this.proxyUrl = `http://127.0.0.1:${mixedPort}`
      }
      if (this.config.switchModeToRule && cfg.mode !== 'rule') {
        const ok = await client.setMode('rule')
        log('info', `Clash 模式 ${cfg.mode} → rule：${ok ? '成功' : '失败'}`)
      }
    } catch (error) {
      this.proxyUrl = this.proxyUrl || (this.config.proxyUrl !== 'auto' ? this.config.proxyUrl : 'http://127.0.0.1:7890')
      log('warn', `读取/切换 Clash 模式失败（继续）：${String(error?.message || error)}`)
    }

    // ② 记录各组的当前选择
    for (const group of groups) restore.clash.groups[group.name] = group.now ?? null

    // ③ 选节点（地区优先 + 实测；测速地址优先用目标站，顺带筛掉地区受限节点）
    const priority = region ? [region, ...this.config.regionPriority.filter((r) => r !== region)] : this.config.regionPriority
    const picked = await pickNode({
      client,
      proxies,
      groups,
      priority,
      exclude: null,
      testUrl: testUrlFor(target),
      timeoutMs: 3000,
      perRegion: 6,
      report: (m) => log('info', `选节点：${m}`),
    })
    if (!picked?.node) {
      const tried = (picked?.failures ?? []).slice(0, 6).join('；')
      throw new Error(`所有候选节点测速都失败，无法自动选节点。${tried ? `失败样例：${tried}` : ''}`)
    }
    this.node = { name: picked.node, group: groups[0].name, groups: groups.map((g) => g.name) }
    this.region = picked.region
    this.delayMs = picked.delayMs

    // ④ 在各组里选中该节点
    const switched = []
    for (const group of groups) {
      try {
        if (await client.select(group.name, picked.node)) switched.push(group.name)
      } catch (error) {
        log('warn', `组「${group.name}」切换节点失败：${String(error?.message || error)}`)
      }
    }
    if (switched.length === 0) throw new Error('节点测速通过，但所有组都切换失败——请检查控制面权限/secret')
    log('info', `已选节点「${picked.node}」（${picked.region}，${picked.delayMs}ms），生效组：${switched.join(' / ')}`)

    // ⑤ 系统代理（其它程序用）
    if (this.config.touchSystemProxy) {
      try {
        const saved = readSystemProxy()
        const server = this.proxyUrl.replace(/^https?:\/\//, '')
        restore.sysProxy = { enable: saved.enable, server: saved.server }
        restore.wroteSysProxyServer = server
        const ok = enableSystemProxy(server)
        log('info', `系统代理 → ${server}：${ok ? '已开启' : '写入失败（其它程序可能仍走直连）'}（原值 enable=${saved.enable} server=${saved.server}）`)
      } catch (error) {
        log('warn', `系统代理开启失败（不影响 DSH 自身）：${String(error?.message || error)}`)
      }
    }

    // ⑥ DSH 自身出口（**这一步才是关键**：系统代理对 DSH 无效）
    let egressError = null
    try {
      const egress = await installEgress(this.proxyUrl)
      restore.egress = egress
    } catch (error) {
      egressError = String(error?.message || error)
      log('error', `DSH 出站策略安装失败：${egressError}`)
    }
    if (!restore.egress) {
      // 关键一步失败 → 立刻回滚已经做的改动，不留半开状态
      await this.rollback(restore, 'egress-install-failed')
      throw new Error(`DSH 出站代理安装失败（系统代理已回滚）：${egressError}`)
    }

    // ⑦ 计量基线
    this.active = true
    this.enabledAt = Date.now()
    this.lastActivityAt = Date.now()
    this.activationBytes = 0
    try {
      const conns = await client.connections()
      this.lastTotals = Number(conns.uploadTotal || 0) + Number(conns.downloadTotal || 0)
      this.lastTotalsAt = Date.now()
    } catch {
      this.lastTotals = null
    }
    this.restore = restore
    this.enableCount += 1
    this.autoEnableTimes.push(Date.now())
    this.startMeter()

    this.persist({
      active: true,
      enabledAt: this.enabledAt,
      node: picked.node,
      region: picked.region,
      proxyUrl: this.proxyUrl,
      restore: {
        mode: restore.clash.mode,
        groups: restore.clash.groups,
        sysProxy: restore.sysProxy,
        wroteSysProxyServer: restore.wroteSysProxyServer,
      },
    })

    return {
      ok: true,
      reason,
      target,
      node: picked.node,
      region: picked.region,
      delayMs: picked.delayMs,
      groups: switched,
      mode: this.config.switchModeToRule ? 'rule' : 'unchanged',
      systemProxy: this.config.touchSystemProxy ? this.proxyUrl.replace(/^https?:\/\//, '') : null,
      egress: restore.egress.kind,
      proxyUrl: this.proxyUrl,
      status: this.status(),
    }
  }

  /** 回滚「已经做了一半」的开启动作（不触发通知、不改 tripped）。 */
  async rollback(restore, why) {
    log('warn', `回滚开启动作（${why}）`)
    try {
      if (restore?.egress?.dispose) await restore.egress.dispose()
    } catch (error) {
      log('warn', `回滚 egress 失败：${String(error?.message || error)}`)
    }
    try {
      if (restore?.sysProxy && this.config.touchSystemProxy) {
        restoreSystemProxy(restore.sysProxy, restore.wroteSysProxyServer)
      }
    } catch (error) {
      log('warn', `回滚系统代理失败：${String(error?.message || error)}`)
    }
    try {
      if (restore?.clash?.mode && this.client) await this.client.setMode(restore.clash.mode)
    } catch (error) {
      log('warn', `回滚 Clash 模式失败：${String(error?.message || error)}`)
    }
    try {
      if (restore?.clash?.groups && this.client) {
        for (const [group, node] of Object.entries(restore.clash.groups)) {
          if (node) await this.client.select(group, node)
        }
      }
    } catch (error) {
      log('warn', `回滚节点选择失败：${String(error?.message || error)}`)
    }
  }

  /**
   * 关闭代理并把机器还原。
   * @param {{reason?: string, keepTrip?: boolean}} options
   */
  async disable({ reason = 'manual', keepTrip = false } = {}) {
    const wasActive = this.active
    const activationBytes = this.activationBytes
    const node = this.node?.name ?? null
    const durationMs = this.enabledAt ? Date.now() - this.enabledAt : 0

    this.stopMeter()
    this.active = false
    const restore = this.restore
    this.restore = null

    if (restore) await this.rollback(restore, `disable:${reason}`)

    if (!keepTrip) this.tripped = false
    this.enabledAt = null
    this.node = null
    this.region = null
    this.delayMs = null
    this.activationBytes = 0
    this.lastTotals = null

    this.persist({ active: false, restore: null })
    if (wasActive) {
      log('info', `代理已关闭（${reason}）；本次用了 ${fmtBytes(activationBytes)}，本次会话累计 ${fmtBytes(this.sessionBytes)}`)
    }
    return { ok: true, wasActive, reason, activationBytes, activationText: fmtBytes(activationBytes), durationMs, node, status: this.status() }
  }

  /* ------------------------------------------------------------ 计量与超预算 */

  startMeter() {
    this.stopMeter()
    const interval = Math.max(3000, Number(this.config.meterIntervalMs) || 10000)
    this.timer = setInterval(() => {
      this.tick().catch((error) => log('warn', `计量轮询异常：${String(error?.message || error)}`))
    }, interval)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stopMeter() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 一次计量：读 Clash 累计流量 → 差分 → 判预算 / 判空闲。 */
  async tick() {
    if (!this.active || !this.client) return
    let total = null
    try {
      const conns = await this.client.connections()
      total = Number(conns.uploadTotal || 0) + Number(conns.downloadTotal || 0)
    } catch (error) {
      log('warn', `读取 Clash 流量失败：${String(error?.message || error)}`)
    }

    if (total != null) {
      if (this.lastTotals == null || total < this.lastTotals) {
        // 核心重启过 → 计数归零，重新取基线，避免把负数当流量
        this.lastTotals = total
      } else {
        const delta = total - this.lastTotals
        this.lastTotals = total
        this.activationBytes += delta
        this.sessionBytes += delta
        this.day.bytes += delta
        if (delta > 16 * 1024) this.lastActivityAt = Date.now()
        this.persist()
      }
    }

    const budget = this.budgetBytes
    if (budget > 0 && this.usedBytes >= budget) {
      await this.trip({
        usedBytes: this.usedBytes,
        budgetBytes: budget,
        activationBytes: this.activationBytes,
      })
      return
    }

    const idleMs = Math.max(1, Number(this.config.autoDisableIdleMinutes) || 3) * 60000
    if (this.lastActivityAt && Date.now() - this.lastActivityAt > idleMs) {
      const summary = await this.disable({ reason: 'idle' })
      this.onNotice(
        `〔dsh-clash-autovpn〕代理已按空闲规则自动关闭（联网空闲超过 ${this.config.autoDisableIdleMinutes} 分钟）。` +
        `本次用量 ${summary.activationText}，本次会话累计 ${fmtBytes(this.sessionBytes)}。需要时我会再次自动开启。`,
      )
    }
  }

  /** 流量超预算：立刻关代理 + 暂停 + 警告（询问在 index.js 的 pre-execute 里做，那里才有 callId）。 */
  async trip({ usedBytes, budgetBytes, activationBytes }) {
    const text =
      `⚠ VPN 流量已超预算：本次会话已用 ${fmtBytes(usedBytes)}（预算 ${fmtBytes(budgetBytes)}）` +
      `${activationBytes ? `，其中本轮 ${fmtBytes(activationBytes)}` : ''}。` +
      `已**自动关闭代理**（系统代理与 DSH 出站策略都已还原），并暂停一切联网工具调用，等你决定是否继续。`
    log('warn', `流量超预算：session=${usedBytes} budget=${budgetBytes} activation=${activationBytes}`)
    this.tripInfo = {
      at: Date.now(),
      usedBytes,
      budgetBytes,
      activationBytes,
      message: text,
    }
    this.tripped = true
    await this.disable({ reason: 'budget-exceeded', keepTrip: true })
    this.persist({ tripped: true, tripInfo: this.tripInfo })
    this.onNotice(text)
    return this.tripInfo
  }

  /**
   * 处理暂停状态（用户在问答里给出决定后调用）。
   * @param {{action: 'continue'|'stop'|'reset', addMB?: number}} options
   */
  async resolveTrip({ action = 'stop', addMB = null } = {}) {
    const had = this.tripInfo
    if (action === 'continue') {
      const add = Number(addMB) > 0 ? Number(addMB) : Number(this.config.budgetMB) || 1024
      this.extraBytes += add * MIB
      this.tripped = false
      this.tripInfo = null
      this.persist({ tripped: false, tripInfo: null })
      log('info', `用户选择继续：追加预算 ${add}MB，累计额外额度 ${this.extraBytes / MIB}MB`)
      return { ok: true, action, addedMB: add, budgetBytes: this.budgetBytes, tripInfo: had }
    }
    if (action === 'reset') {
      this.sessionBytes = 0
      this.day = { key: dayKey(), bytes: 0 }
      this.extraBytes = 0
      this.tripped = false
      this.tripInfo = null
      this.persist({ tripped: false, tripInfo: null })
      log('info', '用户选择重置用量计数（session=0, day=0, extra=0）')
      return { ok: true, action, status: this.status() }
    }
    this.tripped = false
    this.tripInfo = null
    this.persist({ tripped: false, tripInfo: null })
    log('info', '用户选择停止：保持代理关闭，联网工具恢复放行（不再自动开代理，直到你明确要求）')
    return { ok: true, action: 'stop', tripInfo: had }
  }

  /* ------------------------------------------------------------ 节点工具 */

  async listNodes() {
    const client = await this.clientOrThrow()
    const proxies = await client.proxies()
    const groups = selectableGroups(proxies)
    const nodes = candidateNodes(proxies, groups)
    return {
      controller: { base: client.base, label: client.label },
      groups: groups.map((g) => ({ name: g.name, type: g.type, now: g.now, count: g.members.length })),
      current: this.node?.name ?? null,
      nodes: nodes.map((name) => ({ name, region: regionOf(name) })),
    }
  }

  async testNodes({ group = null, url = FOREIGN_BASELINE, timeoutMs = 3000, limit = 12 } = {}) {
    const client = await this.clientOrThrow()
    const proxies = await client.proxies()
    const groups = await this.targetGroups(client, proxies)
    const target = group ? groups.find((g) => g.name === group) : groups[0]
    if (!target) throw new Error(`组「${group}」不存在或没有可测节点`)
    const pool = candidateNodes(proxies, [target]).slice(0, Math.max(1, limit))
    const now = target.now
    const results = await Promise.all(
      pool.map(async (node) => {
        const { delay, error } = await client.nodeDelay(node, url, timeoutMs)
        return { node, region: regionOf(node), delay, error: error ?? null, current: node === now }
      }),
    )
    results.sort((a, b) => (a.delay ?? Number.MAX_SAFE_INTEGER) - (b.delay ?? Number.MAX_SAFE_INTEGER))
    return { group: target.name, now, url, results }
  }

  async selectNode({ node, group = null }) {
    if (!node) throw new Error('selectNode 需要 node 名称')
    const client = await this.clientOrThrow()
    const proxies = await client.proxies()
    const groups = await this.targetGroups(client, proxies)
    const targets = group ? groups.filter((g) => g.name === group) : groups
    if (targets.length === 0) throw new Error(`组「${group}」不存在`)
    const done = []
    for (const g of targets) {
      if (await client.select(g.name, node)) done.push(g.name)
    }
    // 运行期也更新记录，便于关闭时还原到「用户手动选的那个」——手动选不算自动改动，仍按原值还原。
    if (this.active) {
      this.node = { name: node, group: done[0] ?? null, groups: done }
      this.region = regionOf(node)
    }
    return { ok: done.length > 0, node, groups: done }
  }

  /** 开启后校验「经代理真能打开目标」，太慢或不通就换一次节点。 */
  async verifyAndMaybeSwitch(target, { reason = 'verify' } = {}) {
    if (!this.active || !target) return { checked: false }
    const probe = await proxyFetch(target, this.proxyUrl, 12000)
    const slow = probe.ok && probe.ms > Number(this.config.speedThresholdMs || 2500)
    if (probe.ok && !slow) return { checked: true, ok: true, ms: probe.ms, switched: false }

    log('warn', `开启后校验未通过（${probe.ok ? `${probe.ms}ms 过慢` : probe.kind || probe.error}），尝试换节点`)
    const client = await this.clientOrThrow()
    const proxies = await client.proxies()
    const groups = await this.targetGroups(client, proxies)
    const picked = await pickNode({
      client,
      proxies,
      groups,
      priority: this.config.regionPriority,
      exclude: this.node?.name ?? null,
      testUrl: testUrlFor(target),
      timeoutMs: 3000,
      perRegion: 6,
      report: (m) => log('info', `换节点：${m}`),
    })
    if (!picked?.node) return { checked: true, ok: false, switched: false, detail: '没有更合适的节点' }
    const applied = []
    for (const group of groups) {
      if (await client.select(group.name, picked.node)) applied.push(group.name)
    }
    this.node = { name: picked.node, group: applied[0] ?? null, groups: applied }
    this.region = picked.region
    this.delayMs = picked.delayMs
    this.persist({ node: picked.node, region: picked.region })
    const recheck = await proxyFetch(target, this.proxyUrl, 12000)
    log('info', `换到「${picked.node}」后复测：${recheck.ok ? `HTTP ${recheck.status} ${recheck.ms}ms` : recheck.kind || recheck.error}`)
    return { checked: true, ok: recheck.ok, ms: recheck.ms, switched: true, node: picked.node, region: picked.region, reason }
  }

  /* ------------------------------------------------------------ 自动判定 */

  /** 这次工具失败要不要触发「自动开代理」。 */
  shouldAutoReact(toolName, result) {
    if (!this.config.autoEnable) return { react: false, why: 'autoEnable=off' }
    if (this.active) return { react: false, why: 'already-active' }
    if (this.tripped) return { react: false, why: 'tripped' }
    if (!this.isNetworkTool(toolName, null)) return { react: false, why: 'not-network-tool' }
    const text = (result?.content ?? [])
      .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('\n')
    const failed = Boolean(result?.isError) || looksNetworkFailure(text)
    if (!failed) return { react: false, why: 'no-failure-signature' }
    const hourAgo = Date.now() - 3600000
    this.autoEnableTimes = this.autoEnableTimes.filter((t) => t > hourAgo)
    if (this.autoEnableTimes.length >= Number(this.config.maxAutoEnablesPerHour || 6)) {
      return { react: false, why: 'rate-limited' }
    }
    if (Date.now() - this.lastFailureSeenAt < 15000) return { react: false, why: 'debounced' }
    this.lastFailureSeenAt = Date.now()
    return { react: true, why: 'network-failure', text: text.slice(0, 600) }
  }

  /* ------------------------------------------------------------ 崩溃恢复 */

  /**
   * 装载时的自愈：上次进程若在「开着代理」的状态下消失（崩溃/被杀），
   * 把系统代理与 Clash 模式还原回记录的原值。
   */
  async recoverOnLoad() {
    const state = readState()
    if (!state?.active) return { recovered: false }
    log('warn', '检测到上次进程结束时代理仍处于开启状态（疑似崩溃），开始还原…')
    const result = { recovered: true, sysProxy: null, mode: null, groups: [] }
    const restore = state.restore || {}
    try {
      if (restore.sysProxy && this.config.touchSystemProxy) {
        const r = restoreSystemProxy(restore.sysProxy, restore.wroteSysProxyServer)
        result.sysProxy = r
        log('info', `系统代理还原：${JSON.stringify(r)}`)
      }
    } catch (error) {
      log('warn', `系统代理还原失败：${String(error?.message || error)}`)
    }
    try {
      const found = await discoverController({
        controller: this.config.controller,
        controllerSecret: this.config.controllerSecret,
      })
      if (found) {
        const client = new ClashClient(found)
        if (restore.mode) {
          await client.setMode(restore.mode)
          result.mode = restore.mode
        }
        for (const [group, node] of Object.entries(restore.groups || {})) {
          if (node && (await client.select(group, node))) result.groups.push(group)
        }
      }
    } catch (error) {
      log('warn', `Clash 状态还原失败：${String(error?.message || error)}`)
    }
    patchState({ active: false, restore: null })
    return result
  }

  /** 插件卸载：必须关代理（否则用户机器会留着开着但没人管的系统代理）。 */
  async shutdown() {
    if (this.active) {
      await this.disable({ reason: 'plugin-unload' })
    } else {
      // 即使当前没开代理，也可能有残留（比如 egress 装上了但 active 已被清）——保守地刷一次系统代理通知
      try {
        refreshWinInet()
      } catch {
        /* 忽略 */
      }
    }
    this.stopMeter()
  }
}

export { fmtBytes }
