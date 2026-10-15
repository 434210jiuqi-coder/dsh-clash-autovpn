/**
 * 定位「enable() 之后进程静默退出」的调试脚本。
 * 所有输出同时写文件，避免 stdout 缓冲在进程异常结束时丢失。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClashClient, discoverController } from '../lib/clash.js'
import { policyFetch } from '../lib/probe.js'
import { VpnManager, DEFAULT_CONFIG } from '../lib/manager.js'
import { readState } from '../lib/log.js'

// 输出落在系统临时目录（不要写死某台机器的路径）
const OUT = path.join(os.tmpdir(), 'dsh-clash-autovpn-debug-out.txt')
fs.writeFileSync(OUT, '')
function say(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  fs.appendFileSync(OUT, line + '\n')
  try {
    process.stdout.write(line + '\n')
  } catch {
    /* 忽略 */
  }
}

process.on('exit', (code) => say(`!! process exit code=${code}`))
process.on('beforeExit', (code) => say(`!! beforeExit code=${code}`))
process.on('uncaughtException', (e) => say(`!! uncaughtException: ${e?.stack || e}`))
process.on('unhandledRejection', (e) => say(`!! unhandledRejection: ${e?.stack || e}`))

// keep-alive：如果进程是「事件循环被抽干」而退出，这个 ref 的定时器会让它活着
const keepAlive = setInterval(() => {}, 1000)
say('keepalive installed')

const TARGET = 'https://raw.githubusercontent.com/Lunatic029/dsh-clash-proxy/main/README.md'
const found = await discoverController({})
say('controller =', found?.base, found?.label)
const client = new ClashClient(found)
const cfgBefore = await client.configs()
say('mode before =', cfgBefore.mode, 'mixed-port =', cfgBefore['mixed-port'])

const manager = new VpnManager({
  config: { ...DEFAULT_CONFIG, meterIntervalMs: 600000, autoEnable: false },
  onNotice: (t) => say('[notice]', t.slice(0, 160)),
})

say('--- calling enable() ...')
let enabled
try {
  enabled = await manager.enable({ reason: 'debug', target: TARGET })
  say('enable() returned:', enabled)
} catch (error) {
  say('enable() threw:', error?.stack || String(error))
}

say('--- after enable: policyFetch(raw.githubusercontent)')
say('policyFetch =', await policyFetch(TARGET, 12000))
say('--- after enable: policyFetch(google)')
say('policyFetch google =', await policyFetch('https://www.google.com/generate_204', 12000))
say('--- manager.status() =', manager.status())
say('--- state.json =', readState())

say('--- calling disable() ...')
const off = await manager.disable({ reason: 'debug-end' })
say('disable() =', off)
say('mode after =', (await client.configs()).mode)
say('--- done, clearing keepalive')
clearInterval(keepAlive)
say('END')
