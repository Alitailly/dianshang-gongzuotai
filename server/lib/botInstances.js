/**
 * Bot 实例（IP/询盘账号）配置管理
 *
 * 每个实例 = 局域网内一台 Mac 上的 bot 程序 + 它绑定的唯一询盘账号。
 * 配置默认仍兼容 server/bot_instances.json；新路径为
 * data/plugins/inquiry/bot_instances.json（复制过去后自动切换，避免双写）。
 *
 * 兼容策略：
 * - 未配置任何实例时，所有 bot 调用仍回退到原先的 127.0.0.1:18810 本地模式。
 */
import fs from 'fs'
import net from 'net'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { BOT_CONTROL_URL, BOT_CONTROL_TOKEN } from './config.js'
import { atomicWriteJson } from './fileStore.js'
import pluginDataPaths from './pluginDataPaths.cjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { getPluginDataDir, resolveManagedPath } = pluginDataPaths
const INQUIRY_DATA_DIR = getPluginDataDir('inquiry', 'INQUIRY_DATA_DIR')
const NEW_INSTANCES_FILE = path.join(INQUIRY_DATA_DIR, 'bot_instances.json')
const LEGACY_INSTANCES_FILE = path.join(__dirname, '..', 'bot_instances.json')

/** 实例文件的唯一解析入口：读和写共用，迁移后不会新旧双写。 */
export function getInstancesFile() {
  return resolveManagedPath({
    newPath: NEW_INSTANCES_FILE,
    legacyPath: LEGACY_INSTANCES_FILE,
    explicitEnvVar: 'INQUIRY_BOT_INSTANCES_FILE',
    modeEnvVar: 'INQUIRY_DATA_MODE',
  })
}

const DEFAULT_CONTROL_PORT = 18810
const LOCAL_FALLBACK = {
  id: 'local',
  name: '本机 Bot',
  ip: '127.0.0.1',
  control_port: DEFAULT_CONTROL_PORT,
  account: '',
  token: ''
}

/**
 * [安全 P0-2] 是否为本机/局域网私有 IPv4。
 * ad-hoc(请求里临时传 IP)目标只允许这些网段，避免把控制令牌发给公网/域名。
 * 覆盖 10/8、172.16/12、192.168/16、127/8、169.254/16(链路本地)、100.64/10(CGNAT)。
 */
export function isPrivateIPv4(ip) {
  if (!net.isIPv4(String(ip || '').trim())) return false
  const [a, b] = String(ip).trim().split('.').map(Number)
  if (a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** 解析/校验 control_port：合法范围 1-65535，缺省返回默认端口 */
export function parseControlPort(value, fallback = DEFAULT_CONTROL_PORT) {
  if (value === undefined || value === null || value === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/** 校验配置实例的 IP：允许合法 IPv4 或合法主机名（仅管理员可写配置） */
export function isValidInstanceIp(ip) {
  const s = String(ip || '').trim()
  if (!s) return false
  if (net.isIP(s)) return true
  // 主机名：字母数字点段，禁止空白/斜杠/冒号/协议前缀等
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(s)
}


function readFile() {
  const file = getInstancesFile()
  try {
    // 已存在的旧文件一并收紧：早期版本以默认 0644 落盘，只改写入路径救不了老文件
    try { fs.chmodSync(file, 0o600) } catch { /* 只读挂载等场景忽略 */ }
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Array.isArray(data) ? data : (Array.isArray(data.instances) ? data.instances : [])
  } catch {
    return []
  }
}

function writeFile(instances) {
  const file = getInstancesFile()
  // 0600：每个实例都带明文 X-Control-Token，默认 0644 等于把 bot 控制令牌
  // 暴露给同机其它本地用户（与 auth.js 对 .secret/.sessions.json 的处理对齐）
  atomicWriteJson(file, { instances }, { mode: 0o600 })
}

function normalizeInstance(obj) {
  if (!obj || typeof obj !== 'object') return null
  const ip = String(obj.ip || '').trim()
  if (!ip) return null
  const port = Number(obj.control_port || obj.port || DEFAULT_CONTROL_PORT)
  return {
    id: String(obj.id || `bot-${crypto.randomBytes(4).toString('hex')}`),
    name: String(obj.name || ip).trim(),
    ip,
    control_port: Number.isFinite(port) ? Math.max(1, Math.min(65535, Math.floor(port))) : DEFAULT_CONTROL_PORT,
    account: String(obj.account || '').trim(),
    token: String(obj.token || '').trim()
  }
}

export function getInstances() {
  const list = readFile().map(normalizeInstance).filter(Boolean)
  // 去重：按 id 和 ip 去重，避免配置文件被手工改坏
  const seenIds = new Set()
  const seenIps = new Set()
  const deduped = list.filter(x => {
    if (seenIds.has(x.id) || seenIps.has(x.ip)) return false
    seenIds.add(x.id)
    seenIps.add(x.ip)
    return true
  })
  // 维护/测试保护：INQUIRY_EXCLUDE_IPS=10.1.0.37,192.168.1.20 时，门户完全看不到这些实例，
  // 因而不会对它们发起任何轮询、状态读取或业务指令。不设置时行为与原来完全一致。
  const excluded = String(process.env.INQUIRY_EXCLUDE_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!excluded.length) return deduped
  return deduped.filter((x) => !excluded.includes(String(x.ip || '').trim()))
}

export function saveInstances(instances) {
  const list = (instances || []).map(normalizeInstance).filter(Boolean)
  writeFile(list)
  return list
}

export function getInstance(idOrIp) {
  const key = String(idOrIp || '').trim()
  if (!key) return null
  const found = getInstances().find(x => x.id === key || x.ip === key)
  return found || null
}

export function getInstanceByAccount(account) {
  const acc = String(account || '').trim()
  if (!acc) return null
  return getInstances().find(x => String(x.account || '').trim() === acc) || null
}

/**
 * 解析请求目标。优先级：显式 instanceId > ip > account > 未配置时本地回退。
 *
 * [安全 P0-2] ad-hoc 分支（请求里直接传 ip）：
 * - 只允许私有/回环 IPv4，拒绝域名、公网 IP；
 * - control_port 必须 1-65535；
 * - 返回对象带 `_adhoc: true` 标记，instanceControlToken 据此禁止回退全局 token。
 */
export class TargetResolutionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TargetResolutionError'
    this.code = 400
    this.reason = 'INVALID_BOT_TARGET'
    this.status = 400
  }
}

/**
 * 解析请求目标。
 * 只有未提供任何目标参数时，才会按配置实例或本机默认值回退；显式目标无效时必须拒绝。
 */
export function resolveTarget({ instanceId, ip, account, instance, target, control_port } = {}) {
  const explicitInstance = instanceId || instance || target
  if (explicitInstance) {
    // 显式选择“本机”时优先返回本地回退实例，避免已配置远程实例后无法查看本机状态
    if (String(explicitInstance).trim().toLowerCase() === 'local') {
      return { ...LOCAL_FALLBACK }
    }
    const found = getInstance(explicitInstance)
    if (found) return found
    throw new TargetResolutionError('指定的 bot 实例不存在或已被删除')
  }
  // 显式传 IP 时允许直接连接该 IP（默认 18810），但只接受私有/回环 IPv4，
  // 防止把全局控制令牌发给公网目标。已配置 IP 优先使用它自己的 token。
  if (ip !== undefined && ip !== null && String(ip).trim() !== '') {
    const cleanIp = String(ip).trim()
    const found = getInstance(cleanIp)
    if (found) return found
    if (!isPrivateIPv4(cleanIp)) throw new TargetResolutionError('bot 目标 IP 必须是允许的私有或回环 IPv4 地址')
    const port = parseControlPort(control_port)
    if (port === null) throw new TargetResolutionError('bot 控制端口不合法，应为 1-65535')
    return {
      id: `ip-${cleanIp}:${port}`,
      name: cleanIp,
      ip: cleanIp,
      control_port: port,
      account: String(account || '').trim(),
      token: '',
      _adhoc: true
    }
  }
  if (account) {
    const found = getInstanceByAccount(account)
    if (found) return found
    throw new TargetResolutionError('指定的询盘账号未绑定 bot 实例')
  }
  const all = getInstances()
  if (all.length) return all[0]
  return { ...LOCAL_FALLBACK }
}

/**
 * 将实例转为 bot 控制接口地址。
 * 兼容 BOT_CONTROL_URL 未配置实例时的本机回退。
 */
export function instanceControlBase(instance) {
  const inst = instance || LOCAL_FALLBACK
  if (inst && inst.ip && inst.control_port) {
    return `http://${inst.ip}:${inst.control_port}`
  }
  // 未配置实例时回退到全局 BOT_CONTROL_URL 里的 base
  return BOT_CONTROL_URL.replace(/\/api\/command$/, '')
}

/**
 * [安全 P0-2] 实例控制令牌。
 * - 已配置实例/本机回退：可用实例自带 token，否则回退全局 BOT_CONTROL_TOKEN；
 * - ad-hoc 临时目标：只允许实例自带 token，绝不回退全局 token（避免令牌泄漏到攻击者 IP）。
 */
export function instanceControlToken(instance) {
  if (instance && instance.token) return instance.token
  if (instance && instance._adhoc) return ''
  return BOT_CONTROL_TOKEN
}

/**
 * 从表格名中解析询盘账号。
 * 由于账号名可含空格，按“配置的账号列表中最大匹配后缀”解析。
 * 返回账号名；未匹配到返回空字符串。
 */
export function matchAccountFromTableName(tableName, accounts) {
  const name = String(tableName || '').trim()
  if (!name) return ''
  const list = (accounts || []).map(x => String(x || '').trim()).filter(Boolean)
  if (!list.length) return ''
  let best = ''
  for (const acc of list) {
    if (!acc) continue
    if (name === acc || name.endsWith(` ${acc}`)) {
      if (acc.length > best.length) best = acc
    }
  }
  return best
}
