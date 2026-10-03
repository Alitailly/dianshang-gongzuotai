/**
 * 用户存储模块:users.json 的读写封装
 * 密码存储:scrypt 加盐哈希(scrypt$<salt-hex>$<hash-hex>)
 * 兼容迁移:旧明文密码账号首次登录成功后自动升级为哈希
 * 原子写入:tmp + rename,防止崩溃损坏文件
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { atomicWriteJson } from './lib/fileStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const USERS_FILE = path.join(__dirname, 'users.json')

const SCRYPT_PREFIX = 'scrypt$'

// 启动时把已存在文件的权限收紧到 0600（文件里是各账号的 scrypt 哈希）。
// 只在模块加载时做一次：writeUsers 每次都以 0600 写入，之后不会再有 0644 的文件产生。
// 参考 server/lib/auth.js 对 .secret / .sessions.json 的同类处理。
try {
  if (fs.existsSync(USERS_FILE)) fs.chmodSync(USERS_FILE, 0o600)
} catch (e) {
  console.warn('[users] 无法收紧 users.json 权限:', e.message)
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, 32)
  return `${SCRYPT_PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`
}

function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith(SCRYPT_PREFIX)
}

/** 校验密码:哈希格式走 scrypt 比对,旧明文格式直接比对(兼容) */
function verifyPassword(stored, password) {
  if (isHashed(stored)) {
    const parts = stored.split('$')
    if (parts.length !== 3) return false
    const [, saltHex, hashHex] = parts
    try {
      const salt = Buffer.from(saltHex, 'hex')
      const expected = Buffer.from(hashHex, 'hex')
      const actual = crypto.scryptSync(String(password), salt, expected.length)
      return expected.length === actual.length && crypto.timingSafeEqual(actual, expected)
    } catch {
      return false
    }
  }
  return stored === password
}

/** 生成稳定用户 id（改名/删除后旧 token 能据此失效） */
function newUserId() {
  return crypto.randomBytes(8).toString('hex')
}

// users.json 读取缓存。
// authRequired 对每个 API 请求都要读一次用户表（前端还有 3s/5s 轮询、多实例并发），
// 原先每次都 readFileSync + JSON.parse 整个文件，属纯浪费。
// 用「mtimeMs:size」当缓存键：文件一被改写立即失效，因此改名/禁用/删号依然即时生效。
let usersCache = null // { key, users }

function usersFileKey() {
  try {
    const st = fs.statSync(USERS_FILE)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

/** 必须返回副本：调用方(changePassword/updateUser/removeUser 等)会就地改字段后再落盘，
 *  直接给出缓存内的对象会在「改了但校验失败/未落盘」时污染缓存。user 是扁平对象，浅拷贝足够。 */
const cloneUsers = (users) => users.map(u => ({ ...u }))

function readUsers() {
  const key = usersFileKey()
  if (key && usersCache && usersCache.key === key) return cloneUsers(usersCache.users)

  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'))
    const users = Array.isArray(data.users) ? data.users : []
    let migrated = false
    // 兼容旧数据:无 status 视为正常;无稳定 id 时补一个并落盘
    const normalized = users.map(u => {
      const user = { status: 'active', ...u }
      if (!user.id) {
        user.id = newUserId()
        migrated = true
      }
      return user
    })
    if (migrated) {
      try {
        writeUsers(normalized)
      } catch (e) {
        console.warn('[users] 用户 id 迁移落盘失败:', e.message)
      }
    }
    usersCache = { key: usersFileKey() ?? key, users: normalized }
    return cloneUsers(normalized)
  } catch {
    // 解析失败不写缓存：文件修好后应立刻恢复，而不是被一份坏结果钉住
    return []
  }
}

function writeUsers(users) {
  // 0600：文件里是各账号的 scrypt 哈希，默认 0644 会让同机其它用户可读
  atomicWriteJson(USERS_FILE, { users }, { mode: 0o600 })
  usersCache = { key: usersFileKey(), users: cloneUsers(users) }
}

/** 首次启动:确保存在默认管理员 */
export function ensureDefaultUser() {
  if (!fs.existsSync(USERS_FILE)) {
    const initialPassword = String(process.env.RPA_ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url'))
    writeUsers([{ id: newUserId(), username: 'admin', password: hashPassword(initialPassword), name: '管理员', role: 'admin', status: 'active' }])
    if (process.env.RPA_ADMIN_PASSWORD) {
      console.warn('[users] 已创建默认管理员 admin，初始密码来自 RPA_ADMIN_PASSWORD，请登录后立即修改密码!')
    } else {
      console.warn(`[users] 已创建默认管理员 admin，本次随机初始密码: ${initialPassword}`)
      console.warn('[users] 此密码只显示一次，请立即登录并修改!')
    }
  }
}

/** 登录校验(返回用户对象,是否禁用由调用方判断);旧明文密码首次验证成功后自动迁移为哈希 */
export function verifyUser(username, password) {
  const users = readUsers()
  const user = users.find(u => u.username === username)
  if (!user) return null
  if (!verifyPassword(user.password, password)) return null
  if (!isHashed(user.password)) {
    // 旧明文账号首次登录成功 → 升级为哈希(失败不阻断登录)
    try {
      user.password = hashPassword(password)
      writeUsers(users)
      console.warn(`[users] 账号 ${username} 密码已自动升级为 scrypt 哈希`)
    } catch (e) {
      console.warn('[users] 密码哈希迁移失败:', e.message)
    }
  }
  return user
}

/**
 * 按稳定用户 id 读取实时身份(兼容用户名/旧 token)。
 * 返回 { id, username, name, role, status }；用户不存在返回 null。
 */
export function getUserAuthInfo(idOrName) {
  const key = String(idOrName || '').trim()
  if (!key) return null
  const users = readUsers()
  const user = users.find(u => u.id === key) || users.find(u => u.username === key)
  if (!user) return null
  return { id: user.id, username: user.username, name: user.name, role: user.role, status: user.status }
}

/** 用户列表(不含密码) */
export function listUsers() {
  return readUsers().map(({ id, username, name, role, status }) => ({ id, username, name, role, status }))
}

/** 创建用户 */
export function createUser({ username, password, name, role, status }) {
  if (!username || !password) throw new Error('用户名和密码必填')
  const users = readUsers()
  if (users.some(u => u.username === username)) throw new Error('用户名已存在')
  const user = {
    id: newUserId(),
    username,
    password: hashPassword(password),
    name: name || username,
    role: role === 'admin' ? 'admin' : 'user',
    status: status === 'disabled' ? 'disabled' : 'active'
  }
  users.push(user)
  writeUsers(users)
  return { id: user.id, username: user.username, name: user.name, role: user.role, status: user.status }
}

/** 管理员编辑用户(可改用户名/密码/姓名/角色/状态) */
export function updateUser(username, { newUsername, password, name, role, status } = {}) {
  const users = readUsers()
  const idx = users.findIndex(u => u.username === username)
  if (idx < 0) throw new Error('用户不存在')

  const target = users[idx]
  if (newUsername && newUsername !== username) {
    if (users.some(u => u.username === newUsername)) throw new Error('用户名已存在')
    target.username = newUsername
  }
  if (password) target.password = hashPassword(password)
  if (name !== undefined) target.name = name
  if (role && role !== target.role) {
    // 最后一个可用管理员不能被降级：只统计 active 管理员（不含自己）
    if (target.role === 'admin' && role !== 'admin') {
      const otherActiveAdmins = users.filter((u, i) => i !== idx && u.role === 'admin' && u.status !== 'disabled').length
      if (target.status !== 'disabled' && otherActiveAdmins === 0) {
        throw new Error('至少保留一个可用的管理员')
      }
    }
    target.role = role
  }
  if (status) {
    // 禁用最后一个可用的管理员会被拒绝
    if (status === 'disabled' && target.role === 'admin') {
      const otherActiveAdmins = users.filter((u, i) => i !== idx && u.role === 'admin' && u.status !== 'disabled').length
      if (otherActiveAdmins === 0) {
        throw new Error('至少保留一个可用的管理员')
      }
    }
    target.status = status === 'disabled' ? 'disabled' : 'active'
  }
  writeUsers(users)
  return { id: target.id, username: target.username, name: target.name, role: target.role, status: target.status }
}

/** 删除用户(不能删最后一个可用管理员) */
export function removeUser(username) {
  const users = readUsers()
  const idx = users.findIndex(u => u.username === username)
  if (idx < 0) throw new Error('用户不存在')
  const target = users[idx]
  const otherActiveAdmins = users.filter((u, i) => i !== idx && u.role === 'admin' && u.status !== 'disabled').length
  if (target.role === 'admin' && target.status !== 'disabled' && otherActiveAdmins === 0) {
    throw new Error('至少保留一个可用的管理员')
  }
  writeUsers(users.filter((u, i) => i !== idx))
  return { id: target.id, username: target.username, role: target.role, status: target.status }
}

/** 用户修改自己的用户名/姓名/密码(必须验证原密码) */
export function updateSelf(username, { newUsername, oldPassword, password, name } = {}) {
  if (!oldPassword) throw new Error('请输入原密码进行验证')
  const users = readUsers()
  const idx = users.findIndex(u => u.username === username)
  if (idx < 0) throw new Error('用户不存在')

  const target = users[idx]
  if (!verifyPassword(target.password, oldPassword)) throw new Error('原密码错误')

  if (newUsername && newUsername !== username) {
    if (users.some(u => u.username === newUsername)) throw new Error('用户名已存在')
    target.username = newUsername
  }
  if (password) target.password = hashPassword(password)
  if (name !== undefined && name !== '') target.name = name

  writeUsers(users)
  return { id: target.id, username: target.username, name: target.name, role: target.role }
}
