/** server/lib/auth.js — 鉴权:HMAC token + 会话持久化(重启不掉登录) + 登录限速 */
import crypto from 'crypto'
import fs from 'fs'
import { getUserAuthInfo } from '../users.js'
import { SECRET_FILE, SESSION_FILE, TOKEN_TTL_MS } from './config.js'
import { atomicWriteJson } from './fileStore.js'

/** 把敏感文件权限收紧到 0600（已存在文件启动时也要收紧） */
function hardenFilePermissions(file) {
  try {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
  } catch (e) {
    console.warn(`[auth] 无法收紧文件权限 ${file}:`, e.message)
  }
}

function loadSecret() {
  if (process.env.RPA_TOKEN_SECRET) return process.env.RPA_TOKEN_SECRET
  if (fs.existsSync(SECRET_FILE)) {
    hardenFilePermissions(SECRET_FILE)
    return fs.readFileSync(SECRET_FILE, 'utf-8').trim()
  }
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
  return secret
}

const TOKEN_SECRET = loadSecret()  // 模块内常量(不导出)

// ---------- 会话存储:内存 + 磁盘持久化,重启后仍可登录 ----------
// token -> { username, userId, loginAt, lastActiveAt }
export const sessions = new Map()
export const MAX_PERSISTED_SESSIONS = 1000

function isSessionExpired(session, now = Date.now()) {
  const lastActive = Number(session?.lastActiveAt) || Number(session?.loginAt) || 0
  return !lastActive || now - lastActive > TOKEN_TTL_MS
}

/** 清理过期会话，并限制持久化文件的条目数。 */
export function pruneExpiredSessions(now = Date.now()) {
  let changed = false
  for (const [token, session] of sessions) {
    if (isSessionExpired(session, now)) {
      sessions.delete(token)
      changed = true
    }
  }
  while (sessions.size > MAX_PERSISTED_SESSIONS) {
    const oldest = sessions.keys().next().value
    sessions.delete(oldest)
    changed = true
  }
  return changed
}

export function saveSessions() {
  try {
    pruneExpiredSessions()
    const obj = {}
    for (const [token, s] of sessions) {
      obj[token] = s
    }
    // [P2] 会话文件含明文 token，权限收紧到 0600
    atomicWriteJson(SESSION_FILE, obj, { mode: 0o600 })
  } catch (e) {
    console.error('[auth] 会话持久化失败:', e.message)
  }
}

// 滑动续期时把 lastActiveAt 定期落到磁盘，避免服务重启后把活跃会话误判为过期
let _lastSessionSave = 0
function maybeSaveSessions() {
  const now = Date.now()
  if (now - _lastSessionSave >= 60 * 1000) {
    _lastSessionSave = now
    saveSessions()
  }
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return
    hardenFilePermissions(SESSION_FILE)
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'))
    for (const [token, s] of Object.entries(data || {})) sessions.set(token, s)
    const changed = pruneExpiredSessions()
    if (changed) saveSessions()
    console.log(`[auth] 已恢复 ${sessions.size} 个登录会话`)
  } catch (e) {
    console.warn('[auth] 读取持久化会话失败:', e.message)
  }
}

loadSessions()

/** 清除某用户的所有会话（兼容按稳定 id 或用户名清理） */
export function clearUserSessions(usernameOrId) {
  const key = String(usernameOrId || '').trim()
  if (!key) return
  for (const [t, s] of sessions) {
    if (s && (s.username === key || s.userId === key)) sessions.delete(t)
  }
  saveSessions()
}

// ---------- Cookie 持久登录(类似常驻登录态) ----------
const SESSION_COOKIE = 'rpa_session'
const COOKIE_MAX_AGE = TOKEN_TTL_MS / 1000

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`)
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

export function getSessionToken(req) {
  const header = req.headers.authorization || ''
  if (header.startsWith('Bearer ')) {
    const v = header.slice(7).trim()
    if (v && v !== 'null' && v !== 'undefined') return v
  }
  const cookie = req.headers.cookie || ''
  const m = cookie.match(/(?:^|;\s*)rpa_session=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url')
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expectedBuf = Buffer.from(expected)
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'))
    if (typeof payload.exp !== 'number') return null
    // 不在这里直接判 exp：是否过期交给 authRequired 结合 lastActiveAt 做滑动续期，
    // 避免内网用户闲置/长时间开着页面被强制退出。
    return payload
  } catch {
    return null
  }
}

export function authRequired(req, res, next) {
  const token = getSessionToken(req)
  const payload = token && verifyToken(token)
  if (!payload) {
    return res.status(401).json({ error: '未登录或登录已过期' })
  }
  const session = sessions.get(token)
  if (!session) {
    return res.status(401).json({ error: '登录会话已失效,请重新登录' })
  }
  const now = Date.now()
  // 滑动续期：登录有效期按最近活动时间计算(24h)。
  // 页面开着、后台轮询、偶尔操作都会刷新 lastActiveAt，不会自动退出；
  // 完全无活动超过 24 小时才需要重新登录。
  const lastActive = Number(session.lastActiveAt) || Number(session.loginAt) || now
  if (now - lastActive > TOKEN_TTL_MS) {
    sessions.delete(token)
    saveSessions()
    return res.status(401).json({ error: '登录已超时,请重新登录' })
  }
  session.lastActiveAt = now
  maybeSaveSessions()
  // [P1] 用稳定用户标识重新读取 users.json 的实时 role/status：
  // - 改名/删号后旧 token 立即失效（找不到用户即拒绝）
  // - 角色变更(admin→user)立即生效，不再信任 token 里的旧 role
  const identityKey = session.userId || payload.uid || session.username || payload.username
  const live = getUserAuthInfo(identityKey)
  if (!live) {
    sessions.delete(token)
    saveSessions()
    return res.status(401).json({ error: '账号不存在或已被删除,请重新登录' })
  }
  if (live.status === 'disabled') {
    return res.status(401).json({ error: '账号已被禁用' })
  }
  // 同步会话里的稳定标识/用户名，兼容旧会话
  session.userId = live.id
  session.username = live.username
  req.user = { id: live.id, uid: live.id, username: live.username, name: live.name, role: live.role }
  next()
}

export function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' })
  }
  next()
}

export function clientIp(req) {
  // [2026-08-13 安全] 不信任 x-forwarded-for:本地直连无反向代理,
  // 伪造该头可绕过登录限速(此前可直接清零失败计数/切换身份撞库)
  return String(req.socket.remoteAddress || 'unknown')
}

// 登录限速:同一 IP 连续登录失败 3 次 → 冷却 60s(防暴力破解;局域网工具轻量实现)
export const LOGIN_ATTEMPTS = new Map() // ip -> { fails, cooldownUntil }
// 该 Map 原先只增不减：每个失败过的来源 IP 会永久留一条记录，
// 长期运行(或被扫描)会缓慢吃内存。这里清掉两类条目：
//   1) 已过冷却且无失败计数（touchedAt 由 routes/auth.js 每次失败时刷新）
//   2) 超过 30 分钟没再失败的计数条目——半途放弃的撞库尝试不会永久占位
// unref 保证它不会拖住进程退出。
export const LOGIN_ATTEMPT_TTL_MS = 30 * 60 * 1000
const loginAttemptsSweeper = setInterval(() => {
  const now = Date.now()
  for (const [ip, rec] of LOGIN_ATTEMPTS) {
    const idle = now - (Number(rec?.touchedAt) || 0)
    const cooled = now >= (Number(rec?.cooldownUntil) || 0)
    if (cooled && (!rec?.fails || idle > LOGIN_ATTEMPT_TTL_MS)) LOGIN_ATTEMPTS.delete(ip)
  }
}, 10 * 60 * 1000)
loginAttemptsSweeper.unref?.()
export const LOGIN_MAX_FAILS = 3
export const LOGIN_COOLDOWN_MS = 60 * 1000
