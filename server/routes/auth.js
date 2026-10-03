/** server/routes/auth.js — 登录/登出(从 server.js 逐字抽出) */
import express from 'express'
import { verifyUser } from '../users.js'
import {
  signToken, sessions, clientIp,
  LOGIN_ATTEMPTS, LOGIN_MAX_FAILS, LOGIN_COOLDOWN_MS, authRequired,
  saveSessions, setSessionCookie, clearSessionCookie, getSessionToken,
} from '../lib/auth.js'

const router = express.Router()
router.post('/login', (req, res) => {
  const ip = clientIp(req)
  const rec = LOGIN_ATTEMPTS.get(ip) || { fails: 0, cooldownUntil: 0, touchedAt: 0 }
  const now = Date.now()
  if (rec.cooldownUntil > now) {
    const waitSec = Math.ceil((rec.cooldownUntil - now) / 1000)
    return res.status(429).json({ error: `连续登录失败次数过多，请 ${waitSec} 秒后再试` })
  }
  const { username, password } = req.body || {}
  const user = verifyUser(username, password)
  if (!user) {
    rec.fails += 1
    rec.touchedAt = now   // 供 LOGIN_ATTEMPTS 定期清理判断空闲时长
    if (rec.fails >= LOGIN_MAX_FAILS) {
      rec.fails = 0
      rec.cooldownUntil = now + LOGIN_COOLDOWN_MS
      LOGIN_ATTEMPTS.set(ip, rec)
      return res.status(429).json({ error: '连续登录失败 3 次，该设备已锁定 1 分钟' })
    }
    LOGIN_ATTEMPTS.set(ip, rec)
    return res.status(401).json({ error: '用户名或密码错误' })
  }
  // 登录成功:清除该 IP 的失败计数
  LOGIN_ATTEMPTS.delete(ip)
  if (user.status === 'disabled') {
    return res.status(401).json({ error: '账号已被禁用,请联系管理员' })
  }
  const token = signToken({ uid: user.id, username: user.username, name: user.name, role: user.role })
  // 多端共存：保留已有会话，只新增当前会话（会话绑定稳定 userId）
  sessions.set(token, { userId: user.id, username: user.username, loginAt: Date.now(), lastActiveAt: Date.now() })
  saveSessions()
  setSessionCookie(res, token)
  res.json({ token, user: { username: user.username, name: user.name, role: user.role } })
})

// 退出登录:作废当前会话（兼容 Authorization 头与 Cookie-only）
router.post('/logout', authRequired, (req, res) => {
  const token = getSessionToken(req)
  if (token) sessions.delete(token)
  saveSessions()
  clearSessionCookie(res)
  res.json({ success: true })
})

export default router
