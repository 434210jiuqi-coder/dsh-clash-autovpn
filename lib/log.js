/**
 * 日志与状态持久化。
 *
 * 两个原则：
 *  1. **绝不影响宿主**：所有文件操作都各自 try/catch 吞掉，插件宁可少记一条日志，也不能让
 *     一次 fs 失败冒泡到 DSH 的工具调用链或启动流程。
 *  2. **状态可恢复**：开代理前的原始状态（系统代理 / Clash 模式 / 各节点组选择）必须落盘，
 *     这样即使 DSH 崩溃、插件被卸载，下一次装载时也能把用户的机器还原回原样。
 *
 * @module dsh-clash-autovpn/log
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** DSH 主目录：与宿主一致，优先取环境变量。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 插件私有目录（日志与状态都在这里）。 */
export function pluginDir() {
  const dir = path.join(dshHome(), 'clash-autovpn')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录建不出来时后续写入各自失败，不影响宿主 */
  }
  return dir
}

export function statePath() {
  return path.join(pluginDir(), 'state.json')
}

export function logPath() {
  return path.join(pluginDir(), 'autovpn.log')
}

/** 进程内最近日志（供 vpn_status 展示，避免再读盘）。 */
const ring = []
const RING_MAX = 200

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/**
 * 记一行日志：进内存环 + 追加到 autovpn.log。
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 */
export function log(level, message) {
  const line = `${stamp()} [${level}] ${message}`
  ring.push(line)
  if (ring.length > RING_MAX) ring.shift()
  try {
    fs.appendFileSync(logPath(), line + os.EOL)
  } catch {
    /* 日志写不进去不是错误 */
  }
  return line
}

/** 最近若干行日志（新的在后）。 */
export function recentLog(limit = 12) {
  return ring.slice(-limit)
}

/** 读取状态文件；文件缺失或损坏都返回空对象。 */
export function readState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 原子写状态文件（临时文件 + rename）。 */
export function writeState(state) {
  const target = statePath()
  const tmp = `${target}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, target)
  } catch (error) {
    log('warn', `状态落盘失败：${String(error?.message || error)}`)
  }
}

/** 合并式写入：只覆盖传入的键。 */
export function patchState(patch) {
  const next = { ...readState(), ...patch }
  writeState(next)
  return next
}
