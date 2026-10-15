/**
 * 连通性探测与「是不是墙」的判定。
 *
 * 判定思路（三条对照，不是拍脑袋）：
 *   ① **直连目标**的失败特征（ECONNRESET / 超时 / 403 / 451）
 *   ② **经本机代理访问同一目标**是否成功 —— 同一台机器、同一时刻，只有出站路径不同，
 *      这是「被墙」的决定性证据
 *   ③ **国内基准站直连**是否成功 —— 区分「被墙」与「这台机器根本没网」
 *
 * 实现上**刻意不依赖 undici**（实测插件目录里 `import('undici')` 解析失败）：
 *   - 直连探测用 `node:https`/`node:http`（Node 默认不读系统代理、也没有开 `proxyEnv`，天然是直连），
 *   - 代理探测用 `node:net` 手写 HTTP CONNECT 隧道 + `node:tls`，零依赖且语义明确。
 * 两个探测都**不受插件自己安装的全局代理策略影响**，所以对照结果永远可信。
 *
 * @module dsh-clash-autovpn/probe
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns/promises'
import { log } from './log.js'

/** 国内基准站：直连得通说明「本机有网」。 */
const DOMESTIC_BASELINE = 'https://www.baidu.com/'
/** 通用「墙外基准」站点（204 端点，响应体为空、不受缓存干扰）。 */
export const FOREIGN_BASELINE = 'https://www.gstatic.com/generate_204'

const UA = 'Mozilla/5.0 (compatible; dsh-clash-autovpn/0.1; +local-probe)'

/** 失败文本 → 失败类别。 */
export function classifyFailure(text) {
  const s = String(text || '')
  if (/ECONNRESET|socket hang up|connection reset/i.test(s)) return 'reset'
  if (/ETIMEDOUT|timed? ?out|timeout|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/i.test(s)) return 'timeout'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(s)) return 'dns'
  if (/ECONNREFUSED|connection refused/i.test(s)) return 'refused'
  if (/certificate|CERT_|EPROTO|TLS|SSL/i.test(s)) return 'tls'
  if (/HTTP 403|\b403\b/.test(s)) return 'http-403'
  if (/HTTP 451|\b451\b/.test(s)) return 'http-451'
  if (/HTTP 429|\b429\b/.test(s)) return 'http-429'
  return 'other'
}

/** 这段文本像不像「网络层失败」（供 post-execute 钩子判断要不要触发诊断）。 */
export function looksNetworkFailure(text) {
  const kind = classifyFailure(text)
  if (kind !== 'other') return true
  return /fetch failed|network error|failed to fetch|Unable to connect|连接被|无法连接|拒绝连接|连接超时/i.test(String(text || ''))
}

function normalizeError(error) {
  return String(error?.code || error?.cause?.code || error?.message || error)
}

/**
 * 直连探测（node:https/http，天然直连、不经任何代理）。
 * @returns {Promise<{ok: boolean, status: number|null, error: string|null, kind: string|null, ms: number}>}
 */
export function directFetch(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve({ ms: Date.now() - started, ...payload })
    }
    let target
    try {
      target = new URL(url)
    } catch (error) {
      finish({ ok: false, status: null, error: `非法 URL：${url}`, kind: 'other' })
      return
    }
    const mod = target.protocol === 'http:' ? http : https
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { 'user-agent': UA, accept: '*/*' },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0
        res.resume()
        finish({
          ok: status < 400,
          status,
          error: null,
          kind: status === 403 ? 'http-403' : status === 451 ? 'http-451' : null,
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('ETIMEDOUT'))
    })
    req.on('error', (error) => {
      const message = normalizeError(error)
      finish({ ok: false, status: null, error: message, kind: classifyFailure(message) })
    })
    req.end()
  })
}

function parseProxy(proxyUrl) {
  const u = new URL(proxyUrl)
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  const auth = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null
  return { host: u.hostname, port, auth }
}

/**
 * 经 HTTP 代理探测：手写 CONNECT 隧道（+ TLS）后发一个 GET，只取状态行。
 * @returns {Promise<{ok: boolean, status: number|null, error: string|null, kind: string|null, ms: number, tunnelMs: number}>}
 */
export function proxyFetch(url, proxyUrl, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const finish = (payload) => resolve({ ms: Date.now() - started, ...payload })
    let target
    let proxy
    try {
      target = new URL(url)
      proxy = parseProxy(proxyUrl)
    } catch (error) {
      finish({ ok: false, status: null, error: `非法 URL/代理：${normalizeError(error)}`, kind: 'other', tunnelMs: 0 })
      return
    }
    const targetPort = Number(target.port || (target.protocol === 'http:' ? 80 : 443))
    const authority = `${target.hostname}:${targetPort}`

    const socket = net.connect({ host: proxy.host, port: proxy.port })
    let stage = 'connect'
    let buffer = ''
    let finished = false
    const done = (payload) => {
      if (finished) return
      finished = true
      clearTimeout(guard)
      socket.destroy()
      finish(payload)
    }
    const guard = setTimeout(() => {
      done({ ok: false, status: null, error: 'ETIMEDOUT', kind: 'timeout', tunnelMs: Date.now() - started })
    }, timeoutMs)
    if (typeof guard.unref === 'function') guard.unref()

    socket.setNoDelay(true)
    socket.on('error', (error) => {
      const message = normalizeError(error)
      done({ ok: false, status: null, error: message, kind: classifyFailure(message), tunnelMs: Date.now() - started })
    })
    socket.on('close', () => {
      if (!finished) {
        done({
          ok: false,
          status: null,
          error: stage === 'connect' ? 'ECONNRESET(代理连接被关闭)' : `ECONNRESET(隧道在 ${stage} 阶段被关闭)`,
          kind: 'reset',
          tunnelMs: Date.now() - started,
        })
      }
    })

    const sendRequestOverSocket = (stream, tlsReadyMs) => {
      stage = 'request'
      const path = `${target.pathname}${target.search}`
      stream.write(
        `GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      )
      const onData = (chunk) => {
        buffer += chunk.toString('latin1')
        const firstLineEnd = buffer.indexOf('\r\n')
        if (firstLineEnd < 0) return
        const statusLine = buffer.slice(0, firstLineEnd)
        const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/)
        stream.removeListener('data', onData)
        if (!m) {
          done({ ok: false, status: null, error: `无法解析状态行：${statusLine.slice(0, 60)}`, kind: 'other', tunnelMs: tlsReadyMs })
          return
        }
        const status = Number(m[1])
        done({
          ok: status < 400,
          status,
          error: null,
          kind: status === 403 ? 'http-403' : status === 451 ? 'http-451' : null,
          tunnelMs: tlsReadyMs,
        })
      }
      stream.on('data', onData)
    }

    socket.once('connect', () => {
      stage = 'tunnel'
      const lines = [
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        'Proxy-Connection: keep-alive',
        ...(proxy.auth ? [`Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}`] : []),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })

    socket.on('data', function onTunnelData(chunk) {
      buffer += chunk.toString('latin1')
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      socket.removeListener('data', onTunnelData)
      const head = buffer.slice(0, headerEnd)
      const statusLine = head.split('\r\n')[0] || ''
      const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/)
      if (!m) {
        done({ ok: false, status: null, error: `代理 CONNECT 响应异常：${statusLine.slice(0, 60)}`, kind: 'other', tunnelMs: Date.now() - started })
        return
      }
      const code = Number(m[1])
      if (code !== 200) {
        done({
          ok: false,
          status: code,
          error: `代理 CONNECT 被拒：HTTP ${code}`,
          kind: 'other',
          tunnelMs: Date.now() - started,
        })
        return
      }
      const tunnelMs = Date.now() - started
      stage = 'tls'
      if (target.protocol === 'http:') {
        sendRequestOverSocket(socket, tunnelMs)
        return
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false })
      tlsSocket.once('secureConnect', () => sendRequestOverSocket(tlsSocket, tunnelMs))
      tlsSocket.once('error', (error) => {
        const message = normalizeError(error)
        done({ ok: false, status: null, error: `TLS：${message}`, kind: classifyFailure(message), tunnelMs })
      })
    })
  })
}

/**
 * 用**进程当前策略**发请求（global fetch）——用来验证插件的出站接管是否真的生效。
 * @returns {Promise<{ok: boolean, status: number|null, error: string|null, kind: string|null, ms: number}>}
 */
export async function policyFetch(url, timeoutMs = 12000) {
  const started = Date.now()
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA } })
    res.body?.cancel?.().catch?.(() => {})
    return { ok: res.status < 400, status: res.status, error: null, kind: null, ms: Date.now() - started }
  } catch (error) {
    const message = normalizeError(error)
    return { ok: false, status: null, error: message, kind: classifyFailure(message), ms: Date.now() - started }
  }
}

/** TCP 连接探测（判断代理端口 / 目标端口是否可连）。 */
export function tcpConnect(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    const done = (ok, error) => {
      socket.destroy()
      resolve({ ok, ms: Date.now() - started, error: error ?? null })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false, 'ETIMEDOUT'))
    socket.once('error', (error) => done(false, error?.code || String(error?.message || error)))
  })
}

/** DNS 解析（直连侧），用于识别 DNS 污染/解析失败。 */
export async function resolveHost(host) {
  try {
    const addresses = await dns.resolve4(host)
    return { ok: addresses.length > 0, addresses }
  } catch (error) {
    return { ok: false, addresses: [], error: error?.code || String(error?.message || error) }
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * 判定「这次连不上是不是墙的原因」。
 * @param {{target?: string|null, proxyUrl: string, controllerOk?: boolean, controllerLabel?: string, timeoutMs?: number}} options
 */
export async function diagnose(options) {
  const { target = null, proxyUrl, controllerOk = false, controllerLabel = null, timeoutMs = 8000 } = options
  const evidence = {}

  let proxyHost = '127.0.0.1'
  let proxyPort = 7890
  try {
    const parsed = new URL(proxyUrl)
    proxyHost = parsed.hostname
    proxyPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  } catch {
    /* 保持默认 */
  }
  evidence.proxyEndpoint = `${proxyHost}:${proxyPort}`
  evidence.proxyTcp = await tcpConnect(proxyHost, proxyPort, 2500)
  evidence.controller = { ok: controllerOk, label: controllerLabel }

  if (!evidence.proxyTcp.ok) {
    return {
      verdict: 'proxy-unreachable',
      recommended: 'clash-not-running',
      summary:
        `本机代理端口 ${evidence.proxyEndpoint} 连不上（${evidence.proxyTcp.error}）——` +
        `Clash/mihomo 没在运行，或混合端口不是这个。这不是「被墙」，先确认代理软件已启动。`,
      evidence,
    }
  }

  evidence.domestic = await directFetch(DOMESTIC_BASELINE, timeoutMs)
  evidence.foreignDirect = await directFetch(FOREIGN_BASELINE, timeoutMs)
  evidence.foreignViaProxy = await proxyFetch(FOREIGN_BASELINE, proxyUrl, timeoutMs + 4000)

  if (target) {
    const host = hostOf(target)
    evidence.target = { url: target, host }
    if (host) evidence.targetDns = await resolveHost(host)
    evidence.targetDirect = await directFetch(target, timeoutMs)
    evidence.targetViaProxy = await proxyFetch(target, proxyUrl, timeoutMs + 4000)
  }

  const targetDirect = evidence.targetDirect
  const targetProxy = evidence.targetViaProxy
  const proxyPathWorks = targetProxy ? targetProxy.ok : evidence.foreignViaProxy.ok

  // ★ 决定性判据：直连目标失败、经代理就通 —— 只有出站路径不同
  if (target && targetDirect && !targetDirect.ok && targetProxy && targetProxy.ok) {
    return {
      verdict: 'vpn-needed',
      recommended: 'enable',
      summary:
        `目标 ${evidence.target.host} 直连失败（${targetDirect.kind || 'error'}: ${targetDirect.error ?? `HTTP ${targetDirect.status}`}），` +
        `经本机代理 ${evidence.proxyEndpoint} 成功（HTTP ${targetProxy.status}，${targetProxy.ms}ms，隧道 ${targetProxy.tunnelMs}ms）——` +
        `典型「只有出站路径不同」的对照结果，判定为网络封锁所致，可以开代理。`,
      evidence,
    }
  }

  if (target && targetDirect && !targetDirect.ok && targetProxy && !targetProxy.ok &&
      targetProxy.status != null && targetProxy.status >= 400) {
    return {
      verdict: 'vpn-region-blocked',
      recommended: 'enable-and-switch-region',
      summary:
        `两条路都连得上但目标站拒绝了当前出口：直连 HTTP ${targetDirect.status ?? '-'}，` +
        `经代理 HTTP ${targetProxy.status}。这更像**地区限制**而不是链路封锁，` +
        `建议开代理并换地区（香港 → 日本 → 新加坡 → 台湾 → 美国 依次试）。`,
      evidence,
    }
  }

  if (target && targetDirect && targetDirect.ok) {
    return {
      verdict: 'target-ok-direct',
      recommended: 'retry',
      summary:
        `目标 ${evidence.target.host} 现在直连就能通（HTTP ${targetDirect.status}，${targetDirect.ms}ms）——` +
        `刚才那次失败更像偶发抖动，直接重试即可，不必开代理。`,
      evidence,
    }
  }

  // 没有具体目标（如 web_search 失败）时，用「墙外基准站」代替目标做对照
  if (!target && !evidence.foreignDirect.ok && evidence.foreignViaProxy.ok) {
    return {
      verdict: 'vpn-needed',
      recommended: 'enable',
      summary:
        `墙外基准站 ${FOREIGN_BASELINE} 直连失败（${evidence.foreignDirect.kind || evidence.foreignDirect.error}），` +
        `经本机代理 ${evidence.proxyEndpoint} 成功（${evidence.foreignViaProxy.ms}ms）；` +
        `国内基准站直连${evidence.domestic.ok ? '正常' : '也不通'}——判定为网络封锁，可以开代理。`,
      evidence,
    }
  }

  if (!evidence.domestic.ok && !evidence.foreignViaProxy.ok) {
    return {
      verdict: 'no-internet',
      recommended: 'check-network',
      summary:
        `国内基准站直连也不通（${evidence.domestic.error ?? evidence.domestic.kind}），且走代理也连不上墙外——` +
        `这是**本机网络断了**，不是墙的问题。先查网线/Wi-Fi/路由，不要盲目开代理。`,
      evidence,
    }
  }

  if (!evidence.domestic.ok && proxyPathWorks) {
    return {
      verdict: 'no-direct-internet',
      recommended: 'enable',
      summary: '直连完全不通（含国内站点），但经本机代理可以访问墙外——本机直连出口有问题、代理链路是好的，可以开代理继续工作。',
      evidence,
    }
  }

  if (target && targetDirect && !targetDirect.ok && !proxyPathWorks) {
    return {
      verdict: 'blocked-both',
      recommended: 'switch-node-or-wait',
      summary:
        `直连与经代理都打不开目标（直连 ${targetDirect.kind ?? targetDirect.status}；` +
        `代理 ${targetProxy?.kind ?? targetProxy?.status ?? evidence.foreignViaProxy.kind ?? '失败'}）——` +
        `目标站自身故障、或当前节点也到不了它。可以试着换个节点/地区，或过一会儿再试。`,
      evidence,
    }
  }

  return {
    verdict: 'inconclusive',
    recommended: 'retry-or-enable',
    summary: '证据不足以判定：直连与代理的表现不一致或都不明确。可以先重试一次；仍失败则开代理试试。',
    evidence,
  }
}

export { log }
