/**
 * 内核通用路由：文件下载中心。
 *
 * Bot 实例与询盘账号由 inquiry 插件的 instances 路由提供。
 */
import express from 'express'
import fs from 'fs'
import path from 'path'
import { authRequired } from '../lib/auth.js'
import { XXH_DOWN_DIR } from '../lib/config.js'

const router = express.Router()

// ---------- 文件下载中心 ----------
// xxh_down 目录位于网站根目录，由服务端读取和下发，
// 因此任何电脑通过网页访问都能下载，不依赖客户端本地路径。

function normalizeDownloadPath(inputPath) {
  const raw = String(inputPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const root = path.resolve(XXH_DOWN_DIR)
  const resolved = path.resolve(root, raw)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

function toRelativeDownloadPath(full) {
  return path.relative(path.resolve(XXH_DOWN_DIR), full).split(path.sep).join('/')
}

async function listDownloadEntries(dir = '') {
  const root = path.resolve(XXH_DOWN_DIR)
  const targetDir = normalizeDownloadPath(dir)
  if (!targetDir) {
    const err = new Error('目录不合法')
    err.status = 400
    throw err
  }
  await fs.promises.mkdir(root, { recursive: true })
  let realTarget
  try {
    realTarget = await fs.promises.realpath(targetDir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  if (realTarget !== root && !realTarget.startsWith(root + path.sep)) {
    const err = new Error('目录不合法')
    err.status = 400
    throw err
  }
  let names
  try {
    names = await fs.promises.readdir(realTarget, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const entries = []
  for (const entry of names) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(targetDir, entry.name)
    let stat
    try {
      stat = await fs.promises.stat(full)
    } catch {
      continue
    }
    entries.push({
      name: entry.name,
      type: stat.isDirectory() ? 'dir' : 'file',
      path: toRelativeDownloadPath(full),
      size: stat.isDirectory() ? null : stat.size,
      modified: stat.mtime.toISOString()
    })
  }
  entries.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name, 'zh-CN')
    return a.type === 'dir' ? -1 : 1
  })
  return entries
}

router.get('/settings/downloads/list', authRequired, async (req, res) => {
  try {
    const entries = await listDownloadEntries(String(req.query.dir || ''))
    res.json({ success: true, dir: String(req.query.dir || ''), entries })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

router.get('/settings/downloads/file', authRequired, async (req, res) => {
  try {
    const full = normalizeDownloadPath(String(req.query.path || ''))
    if (!full) return res.status(400).json({ error: '路径不合法' })
    const root = path.resolve(XXH_DOWN_DIR)
    const resolved = await fs.promises.realpath(full).catch(() => null)
    if (!resolved || (resolved !== root && !resolved.startsWith(root + path.sep))) {
      return res.status(400).json({ error: '路径不合法' })
    }
    const stat = await fs.promises.stat(resolved)
    if (!stat.isFile()) {
      return res.status(400).json({ error: '不能直接下载文件夹，请进入文件夹选择文件' })
    }
    res.download(resolved, path.basename(resolved))
  } catch (e) {
    res.status(404).json({ error: '文件不存在或无法读取' })
  }
})

export default router
