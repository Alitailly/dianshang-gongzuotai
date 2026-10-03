/**
 * 内核通用路由：插件卸载 + 电子书工具。
 *
 * 询盘领域的网页抓取与飞书记录接口由 inquiry 插件的 inquiry 路由提供。
 */
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { authRequired, adminRequired } from '../lib/auth.js'
import { LOCAL_PLUGINS_DIR } from '../lib/config.js'

const router = express.Router()

async function listLocalPlugins() {
  const entries = await fs.promises.readdir(LOCAL_PLUGINS_DIR, { withFileTypes: true })
  const plugins = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(LOCAL_PLUGINS_DIR, entry.name, 'plugin.json')
    try {
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'))
      if (manifest && manifest.name) {
        plugins.push({ dir: entry.name, name: manifest.name, title: manifest.title || manifest.name })
      }
    } catch {
      // 无 plugin.json 的目录跳过
    }
  }
  return plugins
}

// 卸载内置插件(删除代码目录;仅限管理员,目录名来自扫描结果,防路径穿越)
router.post('/plugins/uninstall', authRequired, adminRequired, async (req, res) => {
  try {
    const { name } = req.body || {}
    if (!name) return res.status(400).json({ error: '缺少插件名' })

    const plugins = await listLocalPlugins()
    const target = plugins.find(p => p.name === name)
    if (!target) {
      return res.status(404).json({ error: `未找到插件 "${name}"` })
    }
    if (target.name === 'inquiry' || target.name === 'market') {
      return res.status(400).json({ error: '询盘/竞品选品是核心插件，禁止卸载；如需停用请使用插件启停功能' })
    }

    await fs.promises.rm(path.join(LOCAL_PLUGINS_DIR, target.dir), { recursive: true, force: true })
    console.log(`[server] 插件 "${name}" (${target.dir}) 已卸载`)
    res.json({ success: true, name, dir: target.dir })
  } catch (error) {
    console.error('卸载插件失败:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// ---------- 电子书：读取用户「下载」文件夹中的 epub 文件 ----------
const EBOOK_DIR = path.join(os.homedir(), 'Downloads')

router.get('/ebooks', authRequired, async (req, res) => {
  try {
    const names = await fs.promises.readdir(EBOOK_DIR)
    const ebooks = []
    for (const name of names) {
      if (!/\.epub$/i.test(name)) continue
      const full = path.join(EBOOK_DIR, name)
      try {
        const st = await fs.promises.stat(full)
        if (!st.isFile()) continue
        ebooks.push({
          name,
          title: name.replace(/\.epub$/i, ''),
          size: st.size,
          modified: st.mtime.toISOString()
        })
      } catch {
        // 单个文件读取失败跳过
      }
    }
    ebooks.sort((a, b) => b.modified.localeCompare(a.modified) || a.title.localeCompare(b.title, 'zh-CN'))
    res.json({ success: true, dir: EBOOK_DIR, ebooks })
  } catch (e) {
    res.status(502).json({ error: `读取电子书目录失败: ${e.message}` })
  }
})

router.get('/ebooks/file', authRequired, async (req, res) => {
  const name = String(req.query.name || '')
  if (!/^[^/\\]+$/.test(name)) {
    return res.status(400).json({ error: '文件名不合法' })
  }
  const full = path.join(EBOOK_DIR, path.basename(name))
  try {
    const resolved = path.resolve(full)
    if (!resolved.startsWith(path.resolve(EBOOK_DIR) + path.sep)) {
      return res.status(400).json({ error: '文件名不合法' })
    }
    const st = await fs.promises.stat(resolved)
    if (!st.isFile() || !/\.epub$/i.test(resolved)) {
      return res.status(404).json({ error: '文件不存在' })
    }
    res.download(resolved, path.basename(resolved))
  } catch (e) {
    res.status(404).json({ error: '文件不存在' })
  }
})

export default router
