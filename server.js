/**
 * RPA 门户服务器 — 轻量插件化装配层。
 *
 * 内核只负责：
 *   中间件 / 鉴权 / 用户 / 设置 / 公共接口 / 插件扫描与挂载 / 静态托管。
 *
 * 业务能力全部放 plugins/<name>/：
 *   plugins/inquiry  询盘自动化（bot 控制、日志、聊天、首轮选图、飞书表格代理）
 *
 * 说明：插件运行在当前 Express 进程内，不引入 PM2 / WS；bot 程序本身仍在外部独立运行。
 */
import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { logRuntime } from './server/lib/runtimeLogger.js'
import { ensureDefaultUser } from './server/users.js'
import { ALLOWED_ORIGINS, PORT, ROOT_DIR } from './server/lib/config.js'

import authRoutes from './server/routes/auth.js'
import userRoutes from './server/routes/users.js'
import miscRoutes from './server/routes/misc.js'
import settingsRoutes from './server/routes/settings.js'

import { mountPlugins } from './server/kernel/plugin-manager.js'
import { createPluginKernelRouter } from './server/kernel/plugin-routes.js'

const app = express()
ensureDefaultUser()

// ---------- 中间件 ----------
app.use(express.json({ limit: '1mb' }))
app.use(cors({
  origin(origin, callback) {
    // 无 origin(同源/curl)或白名单内的来源放行
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true)
    const err = new Error(`来源不被允许: ${origin}`)
    err.status = 403
    err.expose = true
    callback(err)
  }
}))

// ---------- API 请求运行日志(网站运行时日志) ----------
// 页面每 1.5~5 秒轮询的只读接口成功时不记：否则日志中心打开时，
// 「网站运行日志」会被它自己的轮询请求刷满，真正的操作记录被淹没。
const POLLING_PATH_RE = /^\/(logs\/(runtime|tail|list|back|pull-all\/status)|bot\/(instances\/status|ports)|tasks\/current|market\/[^/]+\/(status|log))$/
app.use('/api', (req, res, next) => {
  const start = Date.now()
  const isPolling = req.method === 'GET' && POLLING_PATH_RE.test(req.path)
  res.on('finish', () => {
    if (isPolling && res.statusCode < 400) return
    logRuntime('info', 'api', `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`)
  })
  next()
})

// ---------- 内核路由(不随插件启停) ----------
app.use('/api', authRoutes)    // /api/login /api/logout
app.use('/api', userRoutes)    // /api/users*
app.use('/api', miscRoutes)    // /api/plugins/uninstall /api/fetch-page /api/feishu/record*
app.use('/api', settingsRoutes) // /api/settings/*

// ---------- 插件加载(询盘等) ----------
// mountPlugins 会扫描 plugins/*/plugin.json，把启用的插件路由挂到 /api。
// 这里必须兜底：mountPlugins 内部虽有逐插件 try/catch，但目录读取、
// 状态文件等步骤仍在保护之外，异常会让顶层 await 直接 reject，
// 连内核路由和静态托管都起不来(整站不可用)。失败时降级为「零插件内核」照常启动。
let pluginSystem
try {
  pluginSystem = await mountPlugins(app)
} catch (e) {
  console.error('[server] 插件系统加载失败，以降级模式启动(仅内核):', e)
  logRuntime('error', 'system', `插件系统加载失败: ${e.message}`)
  pluginSystem = {
    plugins: [],
    byName: new Map(),
    stop: async () => {},
    // 降级模式下没有任何插件可启停，接口给出一致的错误而不是崩在 undefined 上
    setEnabled: async (name) => { throw new Error(`插件系统未加载，无法操作 ${name}`) },
    setExpectedVersion: async (name) => { throw new Error(`插件系统未加载，无法操作 ${name}`) },
    setVersion: async (name) => { throw new Error(`插件系统未加载，无法操作 ${name}`) },
    reload: async (name) => { throw new Error(`插件系统未加载，无法重载 ${name}`) },
    reloadAll: async () => { throw new Error('插件系统未加载，无法重载插件') }
  }
}
app.use('/api/kernel', createPluginKernelRouter(pluginSystem))

// ---------- 统一错误处理(Express 5:async handler 的异常也会进入这里) ----------
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' })
})

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err)
  const status = err.status || 500
  const message = err.expose ? err.message : (status >= 500 ? '服务器内部错误' : err.message)
  if (status >= 500) {
    console.error('[server] 未处理异常:', err)
    logRuntime('error', 'system', `未处理异常: ${message}`)
  }
  res.status(status).json({ error: message })
})

// ---------- 静态托管(生产:dist 构建产物 + SPA fallback) ----------
const distDir = path.join(ROOT_DIR, 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`[server] 端口 ${PORT} 已启动(内核 + ${pluginSystem.plugins.length} 个插件, API /api)`)
  console.log(`[server] 插件状态: /api/kernel/plugins`)
  logRuntime('info', 'system', `主项目服务已启动，端口 ${PORT}`)
})

const shutdown = async () => {
  try {
    await pluginSystem.stop()
  } catch (e) {
    console.error('[server] 插件停止失败:', e.message)
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
