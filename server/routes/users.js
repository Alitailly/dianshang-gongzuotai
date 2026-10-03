/** server/routes/users.js — 用户管理(从 server.js 逐字抽出) */
import express from 'express'
import { authRequired, adminRequired, clearUserSessions, signToken, sessions, saveSessions, setSessionCookie } from '../lib/auth.js'
import { listUsers, createUser, updateUser, removeUser, updateSelf } from '../users.js'

const router = express.Router()

// 返回服务端实时身份，管理员专属界面据此决定是否渲染，避免信任可篡改的 localStorage role。
router.get('/users/me', authRequired, (req, res) => {
  res.json({ user: { username: req.user.username, name: req.user.name, role: req.user.role } })
})

router.get('/users', authRequired, adminRequired, (req, res) => {
  res.json({ users: listUsers() })
})

// 创建用户(admin)
router.post('/users', authRequired, adminRequired, (req, res) => {
  try {
    createUser(req.body || {})
    res.json({ success: true })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

// 修改自己的用户名/密码(登录用户,需原密码)
// 注意:必须注册在 /api/users/:username 之前,否则 me 会被当成用户名
router.put('/users/me', authRequired, (req, res) => {
  try {
    const oldUsername = req.user.username
    const oldUserId = req.user.id || req.user.uid || ''
    const updated = updateSelf(oldUsername, req.body || {})
    // [P1] 改密/改名后旧会话必须失效：先清理该用户所有旧会话，再新增当前 token
    if (oldUserId) clearUserSessions(oldUserId)
    clearUserSessions(oldUsername)
    if (updated.username !== oldUsername) clearUserSessions(updated.username)
    const token = signToken({ uid: updated.id, username: updated.username, name: updated.name, role: updated.role })
    sessions.set(token, { userId: updated.id, username: updated.username, loginAt: Date.now(), lastActiveAt: Date.now() })
    saveSessions()
    setSessionCookie(res, token)
    res.json({ success: true, token, user: { username: updated.username, name: updated.name, role: updated.role } })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

// 编辑用户(admin):newUsername/password/name/role
router.put('/users/:username', authRequired, adminRequired, (req, res) => {
  try {
    const updated = updateUser(req.params.username, req.body || {})
    // 用户名/密码/状态/角色变更后,该用户所有会话立即失效（按稳定 id + 新旧用户名清理）
    clearUserSessions(updated.id)
    clearUserSessions(req.params.username)
    if (req.body?.newUsername) clearUserSessions(req.body.newUsername)
    res.json({ success: true })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

// 删除用户(admin)
router.delete('/users/:username', authRequired, adminRequired, (req, res) => {
  try {
    const removed = removeUser(req.params.username)
    clearUserSessions(removed.id)
    clearUserSessions(req.params.username)
    res.json({ success: true })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

export default router
