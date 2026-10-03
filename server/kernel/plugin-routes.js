/**
 * 插件管理 API（内核级）。
 *
 * GET  /api/kernel/plugins                 插件目录 + 当前启用状态
 * POST /api/kernel/plugins/:name/enable    启用插件（立即生效，无需重启门户）
 * POST /api/kernel/plugins/:name/disable   禁用插件（立即生效，并停止其后台服务）
 * POST /api/kernel/plugins/:name/reload    热重载单个插件的后端代码（含子模块，不可用于纯前端插件）
 * POST /api/kernel/plugins/reload-all      批量热重载所有「已启用且有后端入口」的插件
 * PUT  /api/kernel/plugins/:name/expected-version  设置门户“对接插件版本”（管理员）
 * PUT  /api/kernel/plugins/:name/version            旧 API 兼容别名，语义同 expected-version
 *
 * 说明：插件自身版本在 plugin.json，由插件设置页维护；这里是门户期望对接的版本。
 * 后端路由与后台服务已即时生效；前端的插件路由/菜单是启动时注册的，
 * 仍需要刷新页面（后端返回到前端的 loaded 状态会随之更新）。
 */
import express from 'express'
import { authRequired, adminRequired } from '../lib/auth.js'
import { getPluginOwnVersion } from '../lib/pluginManifest.js'

function publicPlugin(p) {
  // 插件自身版本可能刚在插件设置页改过，接口读取时从 plugin.json 刷新一次；
  // 否则运行中的 kernel 记录会一直显示旧版本，直到重启。
  const actualVersion = p.dir ? getPluginOwnVersion(p.dir) : p.version
  const expectedVersion = p.expectedVersion || actualVersion
  return {
    name: p.name,
    title: p.title,
    description: p.description,
    version: actualVersion,
    expectedVersion,
    versionMatch: actualVersion === expectedVersion,
    order: p.order,
    enabled: p.enabled,
    loaded: !!p.loaded,
    error: p.error || null,
    menu: p.menu || null,
    settings: p.settings || null,
    apiMount: p.apiMount || '/api',
    frontend: p.frontend || null,
    // 有没有后端入口：apiMount 默认就是 '/api'，光看它区分不出来，
    // 而「重载」按钮只对有后端入口的插件有意义
    hasBackend: p.hasBackend === true
  }
}

export function createPluginKernelRouter(pluginSystem) {
  const router = express.Router()
  const find = (name) => pluginSystem?.plugins?.find((p) => p.name === name)

  // GET 目录公开：前端启动时需要在未登录/无 token 的情况下知道哪些插件后端已启用；
  // 只返回名称、标题、开关、菜单等元数据，不含密钥。
  router.get('/plugins', (req, res) => {
    res.json({
      ok: true,
      data: (pluginSystem?.plugins || []).map(publicPlugin),
      ts: Date.now()
    })
  })

  const toggle = (enabled) => async (req, res) => {
    const plugin = find(req.params.name)
    if (!plugin) return res.status(404).json({ ok: false, error: `未找到插件 ${req.params.name}` })
    try {
      const record = await pluginSystem.setEnabled(plugin.name, enabled)
      res.json({
        ok: true,
        data: {
          name: record.name,
          enabled: record.enabled,
          loaded: !!record.loaded,
          error: record.error || null,
          // 前端插件路由/菜单在页面加载时注册，需要刷新才能反映出来
          frontendReloadRequired: true
        },
        ts: Date.now()
      })
    } catch (e) {
      // 启用失败时状态不会被改写，插件保持原样，错误如实返回
      res.status(500).json({ ok: false, error: e.message })
    }
  }

  router.post('/plugins/:name/enable', authRequired, adminRequired, toggle(true))
  router.post('/plugins/:name/disable', authRequired, adminRequired, toggle(false))

  const setExpectedVersion = async (req, res) => {
    const plugin = find(req.params.name)
    if (!plugin) return res.status(404).json({ ok: false, error: `未找到插件 ${req.params.name}` })
    try {
      const setter = pluginSystem.setExpectedVersion || pluginSystem.setVersion
      const record = await setter.call(pluginSystem, plugin.name, req.body?.version)
      res.json({ ok: true, data: publicPlugin(record), ts: Date.now() })
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message })
    }
  }

  router.put('/plugins/:name/expected-version', authRequired, adminRequired, setExpectedVersion)
  // 旧 API 兼容：原 /version 现在落到门户“对接插件版本”，不再改 plugin.json。
  router.put('/plugins/:name/version', authRequired, adminRequired, setExpectedVersion)

  // 热重载：重新 import 插件后端代码（含 routes/、lib/ 等子模块）并原子替换，无需重启门户。
  // 失败码：404 插件不存在 / 400 禁用中·纯前端·name 与 api.module 变更 / 409 并发中 /
  //         500 import 失败·未导出 router·重载后 start 失败·内核降级模式
  const reloadStatus = (code) => ({ NOT_FOUND: 404, INVALID_STATE: 400, BUSY: 409 }[code] || 500)

  const reloadOne = async (req, res) => {
    const plugin = find(req.params.name)
    if (!plugin) return res.status(404).json({ ok: false, error: `未找到插件 ${req.params.name}` })
    if (typeof pluginSystem.reload !== 'function') {
      return res.status(500).json({ ok: false, error: '当前内核不支持热重载（降级模式）' })
    }
    try {
      const r = await pluginSystem.reload(plugin.name)
      res.json({
        ok: true,
        data: {
          ...publicPlugin(r.record),
          deep: r.deep !== false, // false = 仅入口文件生效（Node 版本不支持深度重载）
          setupSkipped: !!r.setupSkipped, // 该插件有 setup()，本次未重新执行
          restartRequired: !!r.restartRequired,
          warnings: r.warnings || [],
          // 后端重载不影响前端注册；前端插件代码是构建期扫描的，改完要 npm run build
          frontendReloadRequired: false,
          frontendBuildRequired: true
        },
        ts: Date.now()
      })
    } catch (e) {
      res.status(reloadStatus(e.code)).json({ ok: false, error: e.message })
    }
  }

  const reloadAll = async (req, res) => {
    if (typeof pluginSystem.reloadAll !== 'function') {
      return res.status(500).json({ ok: false, error: '当前内核不支持热重载（降级模式）' })
    }
    try {
      const summary = await pluginSystem.reloadAll()
      // 逐项结果由 results 表达，这里统一 200（批量汇总，不是单个失败）
      res.json({ ok: true, data: { ...summary, frontendBuildRequired: true }, ts: Date.now() })
    } catch (e) {
      res.status(reloadStatus(e.code)).json({ ok: false, error: e.message })
    }
  }

  // 静态路径先注册：与下面的 3 段路径结构上不冲突，但作为约定防止将来加 POST /plugins/reload 踩坑
  router.post('/plugins/reload-all', authRequired, adminRequired, reloadAll)
  router.post('/plugins/:name/reload', authRequired, adminRequired, reloadOne)

  return router
}

export default createPluginKernelRouter
