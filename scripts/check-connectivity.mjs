#!/usr/bin/env node
/**
 * RPA 门户 / bot 连通性检查
 *
 * 用法:
 *   node scripts/check-connectivity.mjs                    # 检查 server/bot_instances.json 中所有实例
 *   node scripts/check-connectivity.mjs 192.168.1.10         # 额外/临时检查指定 IP(默认端口 18810)
 *   node scripts/check-connectivity.mjs 192.168.1.20:18810
 *   node scripts/check-connectivity.mjs --timeout 3000
 *
 * 退出码:
 *   0 = 所有检查的 bot 都可访问
 *   1 = 至少一个 bot 不可访问(或没有配置实例)
 *   2 = 参数错误
 */
import { getInstances } from '../server/lib/botInstances.js'
import { BOT_CONTROL_TOKEN, PORT } from '../server/lib/config.js'

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_CONTROL_PORT = 18810

const args = process.argv.slice(2)
let timeoutMs = DEFAULT_TIMEOUT_MS
const adhocArgs = []

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--help' || arg === '-h') {
    console.log('用法: node scripts/check-connectivity.mjs [--timeout <毫秒>] [ip[:port] ...]')
    process.exit(0)
  }
  if (arg === '--timeout') {
    const value = Number(args[++i])
    if (!Number.isFinite(value) || value <= 0) {
      console.error('--timeout 需要正整数(毫秒)')
      process.exit(2)
    }
    timeoutMs = value
    continue
  }
  adhocArgs.push(arg)
}

function parseAdhocTarget(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const [ip, portText] = raw.split(':')
  const controlPort = portText ? Number(portText) : DEFAULT_CONTROL_PORT
  if (!ip || !Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65535) {
    console.error(`[WARN] 忽略非法目标: ${raw} (格式应为 ip[:port])`)
    return null
  }
  return {
    id: `adhoc-${raw}`,
    name: raw,
    ip,
    control_port: controlPort,
    account: '',
    token: ''
  }
}

const targets = adhocArgs.length ? adhocArgs.map(parseAdhocTarget).filter(Boolean) : getInstances()

if (!targets.length) {
  console.log('[FAIL] 没有可检查的 bot 实例: server/bot_instances.json 为空,且未传入 IP')
  process.exit(1)
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    const text = await res.text()
    let data = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = { raw: text.slice(0, 200) }
    }
    return { ok: res.ok, status: res.status, data, latency: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

function describeError(error) {
  if (error?.name === 'AbortError') return `超时(>${timeoutMs}ms)`
  const code = error?.cause?.code
  if (code === 'ECONNREFUSED') return '连接被拒绝(端口未监听?)'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return '主机/网络不可达'
  if (code === 'ETIMEDOUT') return '连接超时'
  if (code) return `${code}${error?.cause?.message ? ` (${error.cause.message})` : ''}`
  return error?.message || '未知错误'
}

function targetLabel(target) {
  const address = `${target.ip}:${target.control_port}`
  const name = String(target.name || '').trim()
  return name && name !== target.ip ? `${name} (${address})` : address
}

async function checkBot(target) {
  const label = targetLabel(target)
  const token = target.token || BOT_CONTROL_TOKEN
  if (!token) {
    console.log(`[WARN] ${label} 未配置 RPA_CONTROL_TOKEN,跳过`)
    return { ok: false, name: label, reason: '缺少控制 token' }
  }
  const url = `http://${target.ip}:${target.control_port}/api/command?action=bot_status`
  try {
    const result = await fetchJson(url, { headers: { 'X-Control-Token': token } })
    const online = result.ok && result.data?.success !== false && result.data?.online !== false
    if (online) {
      const version = result.data?.version || '未知'
      console.log(`[OK]   ${label} 在线 version=${version} 延迟=${result.latency}ms`)
      return { ok: true, name: label }
    }
    const reason = result.data?.error || `HTTP ${result.status}`
    console.log(`[FAIL] ${label} 控制接口异常: ${reason} 延迟=${result.latency}ms`)
    return { ok: false, name: label, reason }
  } catch (error) {
    const reason = describeError(error)
    console.log(`[FAIL] ${label} ${reason}`)
    return { ok: false, name: label, reason }
  }
}

async function checkPortal() {
  const url = `http://127.0.0.1:${PORT}/`
  try {
    const result = await fetchJson(url)
    if (result.ok) {
      console.log(`[OK]   本机门户 http://127.0.0.1:${PORT}/ 可访问 延迟=${result.latency}ms`)
    } else {
      console.log(`[WARN] 本机门户 http://127.0.0.1:${PORT}/ 返回 HTTP ${result.status}`)
    }
  } catch (error) {
    console.log(`[WARN] 本机门户 http://127.0.0.1:${PORT}/ 不可访问: ${describeError(error)}`)
  }
}

console.log(`=== RPA 连通性检查 (超时 ${timeoutMs}ms) ===`)
await checkPortal()
console.log(`--- 检查 ${targets.length} 个 bot 实例 ---`)

const results = []
for (const target of targets) {
  results.push(await checkBot(target))
}

const failed = results.filter(r => !r.ok)
console.log(`--- 结果: ${results.length - failed.length}/${results.length} 个 bot 可访问 ---`)
if (failed.length) {
  console.log(`失败列表: ${failed.map(r => r.name).join(', ')}`)
  process.exit(1)
}
