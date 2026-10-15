/**
 * Clash / mihomo 控制面：控制口自动发现、RESTful API 封装、节点与地区优选。
 *
 * 相比现成插件（都把控制口写死成 127.0.0.1:9090），这里做**三层发现**，因为实测本机磁盘上
 * 有两份配置、其中一份是过期的：
 *   ① 显式配置（插件 config 里的 controller / controllerSecret）
 *   ② 各客户端的数据目录里的 config.yaml（mihomo 用 ~/.config/mihomo，CFW 用 ~/.config/clash，
 *      Verge 用 %APPDATA%/io.github.clash-verge-rev.clash-verge-rev 等）
 *   ③ 把「代理类进程真正在监听的回环端口」全部拿出来逐个试
 * 每层都带上可用的 secret 逐个握手（GET /version），第一个成功者胜出。
 *
 * @module dsh-clash-autovpn/clash
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { log } from './log.js'

const IS_WINDOWS = process.platform === 'win32'
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'])
const NON_NODE_TYPES = new Set([
  'Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'Dns', 'DnsResolver',
])
/** 订阅里用来「打广告/公告」的伪节点（选中它们没有任何意义）。 */
const INFO_NODE_RE = /订阅|失效|更新|请选|如您|如果|官网|防失联|频道|群组|加群|续费|购买|剩余|到期|流量|重置|时间|网址|发布页/i

/* ------------------------------------------------------------------ 配置发现 */

/** 各客户端 config.yaml 的候选路径（按可信度排序：运行中的核心优先）。 */
function candidateConfigFiles() {
  const home = os.homedir()
  const appdata = process.env.APPDATA || ''
  const local = process.env.LOCALAPPDATA || ''
  const list = [
    path.join(home, '.config', 'mihomo', 'config.yaml'),
    path.join(home, '.config', 'clash', 'config.yaml'),
    path.join(home, '.config', 'clash-verge', 'config.yaml'),
    path.join(home, '.config', 'clash-verge-rev', 'config.yaml'),
    path.join(home, '.config', 'io.github.clash-verge-rev.clash-verge-rev', 'config.yaml'),
    path.join(home, '.config', 'com.vortex.helper', 'config.yaml'),
    appdata && path.join(appdata, 'clash_win', 'config.yaml'),
    appdata && path.join(appdata, 'io.github.clash-verge-rev.clash-verge-rev', 'config.yaml'),
    local && path.join(local, 'io.github.clash-verge-rev.clash-verge-rev', 'config.yaml'),
  ].filter(Boolean)
  // 各客户端的 profiles/*.yml 兜底（值可能来自订阅模板，可信度最低，放最后）
  const profileDirs = [
    path.join(home, '.config', 'mihomo', 'profiles'),
    path.join(home, '.config', 'clash', 'profiles'),
  ]
  for (const dir of profileDirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/\.ya?ml$/i.test(name) && name !== 'list.yml') list.push(path.join(dir, name))
      }
    } catch {
      /* 目录不存在 */
    }
  }
  return list
}

function scalar(text, key) {
  const m = text.match(new RegExp(`^\\s*(?:${key})\\s*:\\s*(.+?)\\s*$`, 'im'))
  if (!m) return null
  return m[1].replace(/^['"]|['"]$/g, '').trim() || null
}

/** 从配置文件里收集 {端口候选, secret 候选, mixed-port 候选}。 */
export function readConfigHints() {
  const controllers = []
  const secrets = []
  let mixedPort = null
  for (const file of candidateConfigFiles()) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const controller = scalar(text, 'external-controller')
    if (controller) controllers.push({ controller, file })
    const secret = scalar(text, 'secret')
    if (secret) secrets.push(secret)
    if (mixedPort == null) {
      const mp = scalar(text, 'mixed-port') ?? scalar(text, 'port')
      const n = Number(mp)
      if (Number.isInteger(n) && n > 0) mixedPort = n
    }
  }
  return { controllers, secrets: [...new Set(secrets)], mixedPort }
}

/** 找出「代理类进程」正在监听的回环端口 —— 对付 GUI 随机分配控制口的情况。 */
export function proxyProcessPorts() {
  if (!IS_WINDOWS) return []
  let netstat = ''
  try {
    netstat = execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
  } catch {
    return []
  }
  const byPid = new Map()
  for (const line of netstat.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (!m) continue
    const host = m[1]
    if (host !== '127.0.0.1' && host !== '[::1]' && host !== '0.0.0.0') continue
    const pid = m[3]
    if (!byPid.has(pid)) byPid.set(pid, new Set())
    byPid.get(pid).add(Number(m[2]))
  }
  if (byPid.size === 0) return []
  let tasklist = ''
  try {
    tasklist = execFileSync('tasklist.exe', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
  } catch {
    return []
  }
  const ports = new Set()
  for (const line of tasklist.split(/\r?\n/)) {
    const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''))
    if (cols.length < 2) continue
    const [image, pid] = cols
    if (!/clash|mihomo|verge|sing-?box|v2ray|nekoray|flclash|hiddify|karing/i.test(image)) continue
    for (const p of byPid.get(pid) ?? []) ports.add(p)
  }
  return [...ports]
}

/* ------------------------------------------------------------------ API 客户端 */

const DEFAULT_PORTS = [9090, 9097, 9091, 9093]

async function httpJson(url, { method = 'GET', body, secret, timeoutMs = 2500, headers } = {}) {
  const h = { ...(headers || {}) }
  if (secret) h.Authorization = `Bearer ${secret}`
  if (body !== undefined) h['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text.slice(0, 400) }
  }
  return { status: res.status, json }
}

/**
 * 自动发现控制口。
 * @param {{controller?: string|null, controllerSecret?: string|null, timeoutMs?: number}} options
 * @returns {Promise<{base: string, secret: string, version: object|null, source: string}|null>}
 */
export async function discoverController(options = {}) {
  const timeoutMs = options.timeoutMs ?? 1200
  const hints = readConfigHints()
  const secrets = [...new Set([options.controllerSecret, ...hints.secrets, ''].filter((s) => s != null))]

  /** @type {{base: string, source: string}[]} */
  const candidates = []
  const push = (base, source) => {
    if (!base) return
    const normalized = base.startsWith('http') ? base : `http://${base}`
    if (!candidates.some((c) => c.base === normalized)) candidates.push({ base: normalized, source })
  }

  if (options.controller && options.controller !== 'auto') {
    push(options.controller, 'explicit')
  }
  for (const { controller, file } of hints.controllers) {
    push(controller, `config:${path.basename(path.dirname(file))}`)
  }
  for (const port of proxyProcessPorts()) push(`127.0.0.1:${port}`, 'process-port')
  for (const port of DEFAULT_PORTS) push(`127.0.0.1:${port}`, 'default')

  for (const { base, source } of candidates) {
    for (const secret of secrets) {
      try {
        const { status, json } = await httpJson(`${base}/version`, { secret, timeoutMs })
        if (status === 200 && json) {
          const version = json.meta ? `mihomo ${json.version}` : `clash ${json.version}`
          log('info', `控制口发现成功：${base}（来源 ${source}${secret ? '，带 secret' : ''}，${version}）`)
          return { base, secret: secret || '', version: json, source, label: version }
        }
      } catch {
        /* 换下一个候选 */
      }
    }
  }
  log('warn', `控制口发现失败：试过 ${candidates.length} 个地址 × ${secrets.length} 个 secret`)
  return null
}

/** Clash / mihomo 控制面客户端。 */
export class ClashClient {
  constructor({ base, secret = '', label = '' }) {
    this.base = base
    this.secret = secret
    this.label = label
  }

  get(pathname, timeoutMs = 4000) {
    return httpJson(`${this.base}${pathname}`, { secret: this.secret, timeoutMs })
  }

  async configs() {
    const { status, json } = await this.get('/configs')
    if (status !== 200) throw new Error(`GET /configs 返回 ${status}`)
    return json
  }

  async connections() {
    const { status, json } = await this.get('/connections')
    if (status !== 200) throw new Error(`GET /connections 返回 ${status}`)
    return json
  }

  async proxies() {
    const { status, json } = await this.get('/proxies')
    if (status !== 200) throw new Error(`GET /proxies 返回 ${status}`)
    return json?.proxies ?? {}
  }

  /** 切换全局模式（rule / global / direct）。 */
  async setMode(mode) {
    const body = { mode }
    let r = await httpJson(`${this.base}/configs`, { method: 'PATCH', body, secret: this.secret, timeoutMs: 4000 })
    if (r.status >= 400) {
      r = await httpJson(`${this.base}/configs`, { method: 'PUT', body, secret: this.secret, timeoutMs: 4000 })
    }
    return r.status < 400
  }

  /** 在某个组里选择节点。 */
  async select(group, node) {
    const r = await httpJson(
      `${this.base}/proxies/${encodeURIComponent(group)}`,
      { method: 'PUT', body: { name: node }, secret: this.secret, timeoutMs: 4000 },
    )
    return r.status < 400
  }

  /** 单个节点的延迟（真正经该节点发起一次请求）。失败返回 null 并带上原因。 */
  async nodeDelay(node, url, timeoutMs = 3000) {
    const qs = `?timeout=${timeoutMs}&url=${encodeURIComponent(url)}`
    try {
      const { status, json } = await this.get(`/proxies/${encodeURIComponent(node)}/delay${qs}`, timeoutMs + 3000)
      if (status === 200 && typeof json?.delay === 'number') return { delay: json.delay }
      return { delay: null, error: json?.message || `HTTP ${status}` }
    } catch (error) {
      return { delay: null, error: String(error?.message || error) }
    }
  }

  /** 整组测速（一次请求拿到组内所有节点的延迟），部分核心不支持时返回 null。 */
  async groupDelay(group, url, timeoutMs = 3000) {
    const qs = `?timeout=${timeoutMs}&url=${encodeURIComponent(url)}`
    try {
      const { status, json } = await this.get(`/group/${encodeURIComponent(group)}/delay${qs}`, timeoutMs + 8000)
      if (status !== 200 || !json || typeof json !== 'object') return null
      const out = {}
      for (const [name, value] of Object.entries(json)) {
        if (typeof value === 'number') out[name] = value
      }
      return out
    } catch {
      return null
    }
  }
}

/* ------------------------------------------------------------------ 地区与节点 */

/** 旗帜 / 关键词 → 规范地区名。 */
const FLAG_REGIONS = {
  '🇭🇰': '香港', '🇯🇵': '日本', '🇸🇬': '新加坡', '🇹🇼': '台湾', '🇨🇳': '台湾',
  '🇺🇸': '美国', '🇰🇷': '韩国', '🇬🇧': '英国', '🇩🇪': '德国', '🇫🇷': '法国',
  '🇨🇦': '加拿大', '🇦🇺': '澳大利亚', '🇳🇱': '荷兰', '🇷🇺': '俄罗斯', '🇹🇷': '土耳其',
  '🇮🇳': '印度', '🇻🇳': '越南', '🇲🇾': '马来西亚', '🇹🇭': '泰国', '🇵🇭': '菲律宾',
  '🇮🇩': '印尼', '🇧🇷': '巴西', '🇦🇷': '阿根廷', '🇨🇭': '瑞士', '🇸🇪': '瑞典',
  '🇫🇮': '芬兰', '🇮🇪': '爱尔兰', '🇮🇹': '意大利', '🇪🇸': '西班牙', '🇦🇹': '奥地利',
  '🇵🇱': '波兰', '🇺🇦': '乌克兰', '🇮🇱': '以色列', '🇦🇪': '阿联酋', '🇿🇦': '南非',
  '🇪🇬': '埃及', '🇲🇴': '澳门', '🇰🇿': '哈萨克', '🇵🇰': '巴基斯坦', '🇧🇩': '孟加拉',
  '🇱🇰': '斯里兰卡', '🇳🇵': '尼泊尔', '🇰🇭': '柬埔寨', '🇱🇦': '老挝', '🇧🇳': '文莱',
  '🇲🇲': '缅甸', '🇲🇳': '蒙古', '🇩🇰': '丹麦', '🇳🇴': '挪威', '🇧🇪': '比利时',
  '🇨🇿': '捷克', '🇭🇺': '匈牙利', '🇷🇴': '罗马尼亚', '🇬🇷': '希腊', '🇵🇹': '葡萄牙',
  '🇨🇱': '智利', '🇲🇽': '墨西哥', '🇳🇿': '新西兰', '🇸🇦': '沙特', '🇶🇦': '卡塔尔',
  '🇮🇷': '伊朗', '🇻🇪': '委内瑞拉', '🇨🇴': '哥伦比亚', '🇵🇪': '秘鲁', '🇺🇾': '乌拉圭',
  '🇪🇨': '厄瓜多尔', '🇧🇴': '玻利维亚', '🇵🇾': '巴拉圭',
}

const KEYWORD_REGIONS = [
  [/香港|Hong ?Kong|\bHK\b|HKG|深港|沪港|京港|广港|莞港|珠港|中转|IEPL|IPLC/i, '香港'],
  [/日本|Japan|\bJP\b|东京|大阪|Tokyo|Osaka|JP-/i, '日本'],
  [/新加坡|Singapore|\bSG\b|狮城|Singapore|SG-/i, '新加坡'],
  [/台湾|Taiwan|\bTW\b|台北|新北|彰化|TWN/i, '台湾'],
  [/美国|United ?States|\bUS\b|洛杉矶|圣何塞|圣何西|西雅图|纽约|芝加哥|达拉斯|凤凰城|硅谷|波特兰|拉斯维加斯|迈阿密|亚特兰大|Ashburn|Los ?Angeles|San ?Jose|Seattle|New ?York|US-/i, '美国'],
  [/韩国|Korea|\bKR\b|首尔|Seoul|KR-/i, '韩国'],
  [/英国|United ?Kingdom|\bUK\b|伦敦|London|GB-/i, '英国'],
  [/德国|Germany|\bDE\b|法兰克福|Frankfurt|DE-/i, '德国'],
  [/法国|France|\bFR\b|巴黎|Paris/i, '法国'],
  [/加拿大|Canada|\bCA\b|多伦多|温哥华|Toronto|Vancouver/i, '加拿大'],
  [/澳大利亚|澳洲|Australia|\bAU\b|悉尼|墨尔本|Sydney|Melbourne/i, '澳大利亚'],
  [/荷兰|Netherlands|\bNL\b|阿姆斯特丹/i, '荷兰'],
  [/俄罗斯|Russia|\bRU\b|莫斯科/i, '俄罗斯'],
  [/土耳其|Turkey|\bTR\b|伊斯坦布尔/i, '土耳其'],
  [/印度|India|\bIN\b|孟买/i, '印度'],
  [/越南|Vietnam|\bVN\b/i, '越南'],
  [/马来|Malaysia|\bMY\b|吉隆坡/i, '马来西亚'],
  [/泰国|Thailand|\bTH\b|曼谷/i, '泰国'],
  [/菲律宾|Philippines|\bPH\b|马尼拉/i, '菲律宾'],
  [/印尼|印度尼西亚|Indonesia|\bID\b|雅加达/i, '印尼'],
  [/阿根廷|Argentina|\bAR\b/i, '阿根廷'],
  [/巴西|Brazil|\bBR\b|圣保罗/i, '巴西'],
  [/瑞士|Switzerland|\bCH\b|苏黎世/i, '瑞士'],
  [/瑞典|Sweden|\bSE\b|斯德哥尔摩/i, '瑞典'],
  [/芬兰|Finland|\bFI\b|赫尔辛基/i, '芬兰'],
  [/爱尔兰|Ireland|\bIE\b|都柏林/i, '爱尔兰'],
  [/意大利|Italy|\bIT\b|米兰/i, '意大利'],
  [/西班牙|Spain|\bES\b|马德里/i, '西班牙'],
]

/** 从节点名推断地区。识别不出返回 '其它'。 */
export function regionOf(nodeName) {
  const name = String(nodeName || '')
  for (const [flag, region] of Object.entries(FLAG_REGIONS)) {
    if (name.includes(flag)) return region
  }
  for (const [re, region] of KEYWORD_REGIONS) {
    if (re.test(name)) return region
  }
  return '其它'
}

/**
 * 从 /proxies 的返回里挑出「可以承载真实节点选择」的组。
 * 排除：纯 DIRECT/REJECT 的组（如「🚫不走代理」）、只有一个成员的组、成员全是节点以外东西的组。
 */
export function selectableGroups(proxies) {
  const groupNames = new Set(
    Object.entries(proxies).filter(([, v]) => GROUP_TYPES.has(v?.type)).map(([k]) => k),
  )
  const out = []
  for (const [name, value] of Object.entries(proxies)) {
    if (!GROUP_TYPES.has(value?.type)) continue
    const members = (value.all ?? []).filter((m) => !groupNames.has(m) || m === 'DIRECT' || m === 'REJECT')
    if (members.length < 2) continue
    if (/不走代理|直连|direct/i.test(name)) continue
    out.push({ name, type: value.type, now: value.now, members })
  }
  return out
}

/** 由组列表推出「真实节点」集合（排除组名、DIRECT/REJECT、广告节点）。 */
export function candidateNodes(proxies, groups) {
  const groupNames = new Set(
    Object.entries(proxies).filter(([, v]) => GROUP_TYPES.has(v?.type)).map(([k]) => k),
  )
  const set = new Set()
  for (const group of groups) {
    for (const name of group.members ?? []) {
      if (groupNames.has(name)) continue
      if (NON_NODE_TYPES.has(proxies[name]?.type)) continue
      if (!proxies[name]) continue
      if (INFO_NODE_RE.test(name)) continue
      set.add(name)
    }
  }
  return [...set]
}

/**
 * 按地区优先级挑一个「真的能打开目标」的节点。
 *
 * 策略：按 priority 逐个地区尝试；地区内并发测速，取该地区最快的一个；若某地区全军覆没
 * 就换下一个地区。这样「香港节点全挂」不会让整个流程失败，而是自动降级到日本、新加坡……
 *
 * @param {object} options
 * @param {ClashClient} options.client
 * @param {object} options.proxies
 * @param {{name: string}[]} options.groups
 * @param {string[]} options.priority 地区优先序
 * @param {string} [options.exclude] 排除的节点（通常是当前失败/过慢的那个）
 * @param {string} [options.testUrl] 测速 URL；给了目标站就用目标站（顺带筛掉地区受限节点）
 * @param {number} [options.timeoutMs]
 * @param {number} [options.perRegion] 每个地区最多测几个
 * @param {(msg: string) => void} [options.report]
 */
export async function pickNode(options) {
  const {
    client, proxies, groups, priority = [], exclude = null, testUrl = 'https://www.gstatic.com/generate_204',
    timeoutMs = 3000, perRegion = 6, report = () => {},
  } = options

  const nodes = candidateNodes(proxies, groups).filter((n) => n !== exclude)
  if (nodes.length === 0) return null

  const byRegion = new Map()
  for (const node of nodes) {
    const region = regionOf(node)
    if (!byRegion.has(region)) byRegion.set(region, [])
    byRegion.get(region).push(node)
  }
  const ordered = [...priority.filter((r) => byRegion.has(r))]
  for (const region of byRegion.keys()) {
    if (!ordered.includes(region)) ordered.push(region)
  }

  const failures = []
  for (const region of ordered) {
    const pool = byRegion.get(region).slice(0, perRegion)
    report(`测速地区「${region}」：${pool.length} 个候选（${pool.join(' / ')}）`)
    const results = await Promise.all(
      pool.map(async (node) => {
        const { delay, error } = await client.nodeDelay(node, testUrl, timeoutMs)
        if (delay == null) failures.push(`${node}: ${error}`)
        return { node, delay }
      }),
    )
    const ok = results.filter((r) => typeof r.delay === 'number').sort((a, b) => a.delay - b.delay)
    if (ok.length > 0) {
      return {
        node: ok[0].node,
        region,
        delayMs: ok[0].delay,
        tested: results.length,
        alive: ok.length,
        failures,
        testUrl,
      }
    }
    report(`地区「${region}」无可用节点，降级到下一个地区`)
  }
  return { node: null, region: null, delayMs: null, failures, testUrl }
}
