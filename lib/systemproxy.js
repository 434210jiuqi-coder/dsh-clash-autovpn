/**
 * Windows 系统代理（WinINET）读写与还原。
 *
 * 为什么用注册表而不是 Clash GUI 的开关：CFW / Clash Verge 的「系统代理」开关本质就是写
 * `HKCU\...\Internet Settings` 的 `ProxyEnable` / `ProxyServer` 两个值，改完之后再通知
 * WinINET 重新读取。直接写这两个值可以做到**保存原值 → 改 → 精确还原**，不依赖任何 GUI 的
 * 内部状态（GUI 的开关状态与注册表不一致时，以注册表为准反而更安全）。
 *
 * 注意：本条链路只影响**其它程序**（浏览器等）。DSH 自身的出站流量**不读系统代理**，
 * 必须走 egress.js 的进程内策略 —— 两者是互补的，不是替代关系。
 *
 * @module dsh-clash-autovpn/systemproxy
 */
import { execFileSync, spawn } from 'node:child_process'

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const IS_WINDOWS = process.platform === 'win32'

function reg(args, timeout = 4000) {
  try {
    return execFileSync('reg.exe', args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

function parseValue(text, name) {
  const re = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'im')
  const m = text.match(re)
  if (!m) return null
  const raw = m[1].trim()
  const dword = raw.match(/^0x([0-9a-f]+)$/i)
  if (dword) return parseInt(dword[1], 16)
  return raw
}

/**
 * 读取当前系统代理状态。
 * @returns {{enable: number|null, server: string|null, override: string|null, autoConfigUrl: string|null}}
 */
export function readSystemProxy() {
  if (!IS_WINDOWS) return { enable: null, server: null, override: null, autoConfigUrl: null }
  const text = reg(['query', REG_KEY])
  return {
    enable: parseValue(text, 'ProxyEnable'),
    server: parseValue(text, 'ProxyServer'),
    override: parseValue(text, 'ProxyOverride'),
    autoConfigUrl: parseValue(text, 'AutoConfigURL'),
  }
}

function writeValue(name, type, value) {
  return reg(['add', REG_KEY, '/v', name, '/t', type, '/d', String(value), '/f'])
}

/**
 * 打开系统代理（只动 ProxyEnable / ProxyServer 两个值）。
 * @param {string} server 形如 `127.0.0.1:7890`
 * @returns {boolean} 是否写入成功
 */
export function enableSystemProxy(server) {
  if (!IS_WINDOWS) return false
  writeValue('ProxyServer', 'REG_SZ', server)
  writeValue('ProxyEnable', 'REG_DWORD', 1)
  const now = readSystemProxy()
  return now.enable === 1 && String(now.server) === String(server)
}

/**
 * 还原系统代理到之前保存的值。**只写回我们确实改过、且当前值仍等于我们写入值的字段**，
 * 避免把用户在我们之后的手动改动覆盖掉。
 * @param {{enable: number|null, server: string|null}} saved
 * @param {string} wroteServer 我们写入的 ProxyServer
 * @returns {{restored: boolean, skipped: string|null}}
 */
export function restoreSystemProxy(saved, wroteServer) {
  if (!IS_WINDOWS) return { restored: false, skipped: 'not-windows' }
  const now = readSystemProxy()
  const userChanged = now.enable === 0 || String(now.server) !== String(wroteServer)
  if (userChanged) {
    // 当前值已不是我们写的那份 —— 用户（或 Clash GUI）中途动过，尊重现状，不覆盖。
    return { restored: false, skipped: 'changed-externally' }
  }
  if (saved?.server != null && String(saved.server) !== '') {
    writeValue('ProxyServer', 'REG_SZ', saved.server)
  }
  writeValue('ProxyEnable', 'REG_DWORD', saved?.enable === 1 ? 1 : 0)
  refreshWinInet()
  return { restored: true, skipped: null }
}

/**
 * 通知 WinINET 设置已变更（INTERNET_OPTION_SETTINGS_CHANGED=39 → REFRESH=37）。
 * 不等待、不阻塞：已经打开的程序会在下一次请求时读到新值，完全没通知成功也不影响
 * 新启动的程序。用 stdio:'ignore' 是为了在受限环境里也能起（管道捕获在沙箱下会失败）。
 */
export function refreshWinInet() {
  if (!IS_WINDOWS) return
  const script = [
    '$sig = \'[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int opt, IntPtr buf, int len);\'',
    'try {',
    '  $t = Add-Type -MemberDefinition $sig -Name DshWinINet -Namespace Dsh -PassThru',
    '  [void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)',
    '  [void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)',
    '} catch { }',
  ].join('\n')
  const shell = process.env.DSH_PWSH || 'pwsh'
  const args = ['-NoProfile', '-NonInteractive', '-Command', script]
  try {
    const child = spawn(shell, args, { stdio: 'ignore', windowsHide: true, detached: true })
    child.on('error', () => {
      // pwsh 不存在时退回 Windows PowerShell 5.1
      try {
        const fallback = spawn('powershell.exe', args, { stdio: 'ignore', windowsHide: true, detached: true })
        fallback.on('error', () => {})
        fallback.unref()
      } catch {
        /* 通知失败可接受 */
      }
    })
    child.unref()
  } catch {
    /* 通知失败可接受 */
  }
}
