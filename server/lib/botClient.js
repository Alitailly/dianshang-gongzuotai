/** server/lib/botClient.js — 转发指令到 bot 控制接口，支持多 IP/多实例 */
import { BOT_CONTROL_URL, BOT_CONTROL_TOKEN } from './config.js'
import { instanceControlBase, instanceControlToken } from './botInstances.js'

const defaultBase = BOT_CONTROL_URL.replace(/\/api\/command$/, '')

/**
 * 可选的“执行前 Bot 版本校验”钩子。
 *
 * 由询盘插件在 start() 时注册；这样版本策略（哪些 action 必须校验、期望版本
 * 存在询盘插件侧）仍归询盘插件所有，portal 的 botClient 只提供扩展点。
 * 钩子抛错时 postToBot 不再向 Bot 发送任何指令。
 */
let botVersionGuard = null

export function setBotVersionGuard(guard) {
  botVersionGuard = typeof guard === 'function' ? guard : null
}

/**
 * 解析请求目标：
 * - target 为 resolveTarget() 返回的实例对象（含 { ip, control_port, token } 或 { instanceId/ip/account }）
 * - 未传入时使用全局默认（兼容旧行为）
 *
 * 2026-09-19：删掉了原先两条永不进入的分支——`typeof target === 'string'` 和
 * `target.control_base || target.base`。全仓库调用点传的都是 resolveTarget 的返回值或 undefined，
 * 而 resolveTarget 从不产出这两种形态。保留它们的唯一效果是：任何调用方只要塞一个带 base 的对象，
 * 就能把全局 BOT_CONTROL_TOKEN 发到任意主机。
 */
function normalizeTarget(target) {
  if (!target) return { base: defaultBase, token: BOT_CONTROL_TOKEN }
  const base = instanceControlBase(target)
  return { base, token: instanceControlToken(target) }
}

/**
 * 转发指令到指定 bot 控制接口。
 * body 为指令体；options.target 可指定实例/地址；options.timeoutMs 覆盖超时。
 */
export async function postToBot(body, { timeoutMs = 5000, target, skipVersionGuard = false } = {}) {
  // 先过版本门禁，再发指令。校验失败时不允许把任何业务动作发给目标机器。
  if (botVersionGuard && !skipVersionGuard) {
    await botVersionGuard({ body, target })
  }
  const { base, token } = normalizeTarget(target)
  const url = `${base}/api/command`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let botRes
  try {
    botRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Control-Token': token } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
  const data = await botRes.json().catch(() => ({}))
  if (!botRes.ok) {
    throw new Error(data.error || `机器人响应异常 HTTP ${botRes.status}`)
  }
  if (data.success === false) {
    throw new Error(data.error || '机器人拒绝执行该指令')
  }
  return data
}

/**
 * GET 查询 bot 控制接口（port_status / bot_status / task_status 等只读接口）。
 */
export async function getFromBot(action, { timeoutMs = 3000, target } = {}) {
  const { base, token } = normalizeTarget(target)
  const url = `${base}/api/command?action=${encodeURIComponent(action)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      headers: token ? { 'X-Control-Token': token } : {},
      signal: controller.signal
    })
    const data = await r.json().catch(() => ({}))
    return { ok: r.ok, ...data }
  } finally {
    clearTimeout(timer)
  }
}
