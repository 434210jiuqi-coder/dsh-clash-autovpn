/**
 * DSH 进程内出站路由：让 Harness 自己的 fetch（web 搜索/抓取、MCP、子进程）走本机 Clash。
 *
 * **为什么不能只改系统代理**：DSH 的出站策略由 `@deepseek-ai/dsh-http-proxy` 决定，它
 * 「不读取 macOS 或 Windows 的系统代理设置」，只看启动时的 `http_proxy/https_proxy/no_proxy`
 * 环境变量。也就是说：光把系统代理打开，DSH 自己抓网页依然直连（照样被墙）。所以必须调用
 * 宿主自己的 `installProxyFromEnvironment()` 在**运行时**重装一次策略。
 *
 * 三层取用策略，逐级降级（第一层是宿主正统接口，最后一层是自建 dispatcher，保证任何 DSH
 * 版本上都不至于完全不工作）：
 *   ① `@deepseek-ai/dsh-http-proxy` 的具名导入
 *   ② 直接从安装目录里的 asar 绝对路径 import（实测可行；应对宿主不再对外暴露该包名）
 *   ③ 自建 undici ProxyAgent + 按主机名分流的 dispatcher（照搬 dsh-clash-proxy 的做法）
 *
 * `installProxyFromEnvironment(env)` 需要的 `env` 是一个「启动环境快照」，其契约只有一条：
 * `env.get(name)` 返回 `{ value }` 或 `undefined`（见 dsh-launch-environment）。因此这里用一
 * 个最小适配器即可，不必依赖那个包。
 *
 * @module dsh-clash-autovpn/egress
 */
import path from 'node:path'
import { log } from './log.js'

const LOOPBACK_RE = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|0\.0\.0\.0)$/i
const PRIVATE_RE = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/

/** DSH 安装目录里的 asar 路径（用于第二层降级）。 */
function asarCandidates() {
  const out = []
  const resources = process.resourcesPath
  if (resources) {
    out.push(path.join(resources, 'app.asar', 'dsh', 'node_modules'))
    out.push(path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules'))
  }
  try {
    const execDir = path.dirname(process.execPath)
    out.push(path.join(execDir, 'resources', 'app.asar', 'dsh', 'node_modules'))
  } catch {
    /* 忽略 */
  }
  return out
}

/** 构造 installProxyFromEnvironment 需要的启动环境快照适配器。 */
function envSnapshot(values) {
  return {
    get(name) {
      const raw = values[name] !== undefined ? values[name] : values[String(name).toUpperCase()]
      return raw === undefined ? undefined : { value: String(raw) }
    },
  }
}

async function loadHarnessProxy() {
  try {
    return await import('@deepseek-ai/dsh-http-proxy')
  } catch (error) {
    log('warn', `具名导入 @deepseek-ai/dsh-http-proxy 失败：${String(error?.message || error)}，尝试 asar 绝对路径`)
  }
  for (const root of asarCandidates()) {
    const target = path.join(root, '@deepseek-ai', 'dsh-http-proxy', 'lib', 'index.js')
    try {
      const url = 'file:///' + target.replace(/\\/g, '/').replace(/ /g, '%20')
      return await import(url)
    } catch {
      /* 试下一个候选目录 */
    }
  }
  return null
}

/** 第三层降级用的 undici：裸名解析不到（实测），因此按目录逐个找。 */
async function loadUndici() {
  try {
    return await import('undici')
  } catch {
    /* 继续按路径找 */
  }
  const roots = [...asarCandidates()]
  if (process.env.DSH_PROFILE_DIR) roots.push(path.join(process.env.DSH_PROFILE_DIR, 'node_modules'))
  for (const root of roots) {
    const target = path.join(root, 'undici', 'index.js')
    try {
      return await import('file:///' + target.replace(/\\/g, '/').replace(/ /g, '%20'))
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/** 第三层降级：自建「按主机名分流」的 dispatcher。 */
async function installSelfBuilt(proxyUrl, noProxyList) {
  const undici = await loadUndici()
  if (!undici) {
    throw new Error(
      '无法加载 undici，且宿主的 @deepseek-ai/dsh-http-proxy 接口也不可用——本次不接管出站（已回滚）',
    )
  }
  const previous = undici.getGlobalDispatcher()
  const proxyAgent = new undici.ProxyAgent({ uri: proxyUrl })
  const directAgent = new undici.Agent()
  const bypass = (hostname) => LOOPBACK_RE.test(hostname) || PRIVATE_RE.test(hostname) || noProxyList.includes(hostname)

  class RoutingDispatcher extends undici.Dispatcher {
    dispatch(options, handler) {
      const origin = options?.origin
      let hostname = ''
      try {
        hostname = new URL(String(origin)).hostname
      } catch {
        return directAgent.dispatch(options, handler)
      }
      return (bypass(hostname) ? directAgent : proxyAgent).dispatch(options, handler)
    }
  }
  undici.setGlobalDispatcher(new RoutingDispatcher())

  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]))
  const noProxy = [...noProxyList, 'localhost', '127.0.0.1', '::1'].join(',')
  process.env.HTTP_PROXY = proxyUrl
  process.env.HTTPS_PROXY = proxyUrl
  process.env.ALL_PROXY = proxyUrl
  process.env.NO_PROXY = noProxy
  process.env.NODE_USE_ENV_PROXY = '1'

  return {
    kind: 'self-built',
    dispose: async () => {
      undici.setGlobalDispatcher(previous)
      for (const n of names) {
        if (before[n] === undefined) delete process.env[n]
        else process.env[n] = before[n]
      }
      await Promise.allSettled([proxyAgent.close(), directAgent.close()])
    },
  }
}

/**
 * 在本进程安装「走本机代理」的出站策略。
 * @param {string} proxyUrl 形如 http://127.0.0.1:7890
 * @returns {Promise<{dispose: () => Promise<void>|void, kind: string}>}
 */
export async function installEgress(proxyUrl) {
  const mod = await loadHarnessProxy()
  if (mod?.installProxyFromEnvironment) {
    const values = {
      ...process.env,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
      no_proxy: 'localhost,127.0.0.1,::1',
    }
    const dispose = await mod.installProxyFromEnvironment(envSnapshot(values), (messages) => {
      for (const m of messages ?? []) log('warn', `代理策略诊断：${typeof m === 'string' ? m : JSON.stringify(m)}`)
    })
    const routed = typeof mod.proxyRouteFor === 'function'
      ? mod.proxyRouteFor(new URL('https://example.com')).proxied === true
      : null
    log('info', `出站策略已安装（宿主接口${routed === true ? '，校验通过' : routed === false ? '，⚠ 校验显示未代理' : ''}）`)
    return { kind: 'harness', dispose: async () => { await dispose() } }
  }
  log('warn', '宿主 http-proxy 接口不可用，降级为自建 dispatcher（功能等价，但少一层宿主校验）')
  return await installSelfBuilt(proxyUrl, [])
}
