/**
 * 轻量插件内核。
 *
 * 规则：
 *   - 只扫描 plugins/<name>/plugin.json；
 *   - api.module 指向该插件的后端入口（ESM，导出 Express router 或 { router, start, stop }）；
 *   - 插件运行在当前 Express 进程内，不引入 PM2 / WS / 独立端口；
 *   - 启用状态优先读 server/data/plugins.json，缺省用 plugin.json 的 enabled（默认 true）。
 */
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { ROOT_DIR } from '../lib/config.js'
import { atomicWriteJson } from '../lib/fileStore.js'
import { getPluginOwnVersion, isValidVersion } from '../lib/pluginManifest.js'
import { MARKER_KEY, installReloadHooks, purgePluginCjsCache, registerReloadScope } from './esmReloadHooks.js'

export const PLUGIN_DIR = path.join(ROOT_DIR, 'plugins')
const PLUGIN_STATE_FILE = path.join(ROOT_DIR, 'server', 'data', 'plugins.json')

// 下面几个函数都接受可选的 stateFile/dir 尾参（默认走真实路径）：
// 测试要用临时目录跑「完整的挂载 + 热重载」，不能去写真实的 server/data/plugins.json。
export function readPluginState(file = PLUGIN_STATE_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

export function writePluginState(next, file = PLUGIN_STATE_FILE) {
  atomicWriteJson(file, next)
  return next
}

export function setPluginEnabled(name, enabled, file = PLUGIN_STATE_FILE) {
  const state = readPluginState(file)
  state[name] = { ...(state[name] || {}), enabled: !!enabled }
  return writePluginState(state, file)
}

export { isValidVersion }

/**
 * 写入门户侧的“对接插件版本”（expectedVersion）。
 *
 * 注意：这不是插件自身版本。插件自身版本由插件设置页写 plugin.json；
 * 网站只维护“我希望对接哪个版本”，两者不一致时页面提示，不自动覆盖插件。
 */
export function setPluginExpectedVersion(name, version) {
  const cleanVersion = String(version || '').trim()
  if (!isValidVersion(cleanVersion)) throw new Error('版本号格式不正确，请使用如 1.2.3 或 1.2.3-beta.1')
  const state = readPluginState()
  state[name] = { ...(state[name] || {}), expectedVersion: cleanVersion }
  writePluginState(state)
  return cleanVersion
}

/** @deprecated 旧 API 兼容别名：原 /version 接口现在语义为 expectedVersion。 */
export const setPluginVersion = setPluginExpectedVersion

export function validatePluginManifest(manifest, { dir, dirName }) {
  const manifestPath = path.join(dir, 'plugin.json')
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`插件清单不是对象：${manifestPath}`)
  if (!manifest.name || typeof manifest.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(manifest.name)) {
    throw new Error(`插件 name 必须是字母、数字或连字符：${manifestPath}`)
  }
  if (manifest.api !== undefined && (!manifest.api || typeof manifest.api !== 'object' || Array.isArray(manifest.api))) {
    throw new Error(`插件 ${manifest.name} 的 api 必须是对象`)
  }
  if (manifest.api?.mount !== undefined && (typeof manifest.api.mount !== 'string' || !/^\/api(?:\/|$)/.test(manifest.api.mount) || manifest.api.mount.includes('..'))) {
    throw new Error(`插件 ${manifest.name} 的 api.mount 必须是以 /api 开头的绝对路径`)
  }
  if (manifest.api?.module !== undefined) {
    if (typeof manifest.api.module !== 'string' || !manifest.api.module.startsWith('.')) {
      throw new Error(`插件 ${manifest.name} 的 api.module 必须是相对路径：${manifest.api.module}`)
    }
    const root = path.resolve(dir)
    const modulePath = path.resolve(root, manifest.api.module)
    if (modulePath !== root && !modulePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`插件 ${manifest.name} 的 api.module 不得越出插件目录`)
    }
    if (!fs.existsSync(modulePath) || !fs.statSync(modulePath).isFile()) {
      throw new Error(`插件 ${manifest.name} 的 api.module 不存在：${manifest.api.module}`)
    }
    const realRoot = fs.realpathSync(root)
    const realModule = fs.realpathSync(modulePath)
    if (realModule !== realRoot && !realModule.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`插件 ${manifest.name} 的 api.module 不得通过符号链接越出插件目录`)
    }
  }
  if (manifest.settings !== undefined) {
    const settings = manifest.settings
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`插件 ${manifest.name} 的 settings 必须是对象`)
    }
    if (settings.route !== undefined && (typeof settings.route !== 'string' || !settings.route.startsWith('/') || settings.route.includes('..'))) {
      throw new Error(`插件 ${manifest.name} 的 settings.route 必须是以 / 开头的站内路径`)
    }
    if (settings.roles !== undefined && (!Array.isArray(settings.roles) || settings.roles.some((r) => typeof r !== 'string'))) {
      throw new Error(`插件 ${manifest.name} 的 settings.roles 必须是字符串数组`)
    }
  }
  if (manifest.name !== dirName) {
    console.warn(`[plugin] 目录名 ${dirName} 与插件名 ${manifest.name} 不一致`)
  }
  return { ...manifest, dir, dirName }
}

function readManifest(dir, dirName) {
  const manifestPath = path.join(dir, 'plugin.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  return validatePluginManifest(manifest, { dir, dirName })
}

/**
 * 扫描 plugins/*\/plugin.json。
 *
 * 容错原则：单个插件的清单坏掉只影响它自己。
 * 原先这里对坏清单直接 throw，而 server.js 的顶层 await 没有捕获，
 * 结果是「改坏任何一个 plugin.json」→ 内核 + 全部插件一起启不来，
 * 整个门户只剩 500。现在改为把坏插件作为 broken 条目一并返回，
 * 由 mountPlugins 记录成 loaded:false 并展示在插件页，其余照常启动。
 */
export function scanPlugins(rootDir = PLUGIN_DIR) {
  if (!fs.existsSync(rootDir)) return []
  const plugins = []
  const names = new Set()

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(rootDir, entry.name)
    if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue

    let manifest
    try {
      manifest = readManifest(dir, entry.name)
    } catch (e) {
      console.error(`[plugin] ${entry.name} 清单无效，已跳过：${e.message}`)
      plugins.push({ name: entry.name, title: entry.name, dir, dirName: entry.name, broken: true, error: e.message })
      continue
    }

    if (names.has(manifest.name)) {
      // 谁才是"正主"不能由 readdirSync 的顺序决定（不同文件系统顺序不同）。
      // 规则：目录名与插件名一致的那个优先；只有它才算正常插件，另一个降级为 broken。
      const idx = plugins.findIndex(p => p.name === manifest.name && !p.broken)
      const existing = idx >= 0 ? plugins[idx] : null
      const newMatchesDir = entry.name === manifest.name
      const oldMatchesDir = !!existing && existing.dirName === manifest.name

      if (existing && newMatchesDir && !oldMatchesDir) {
        const msg = `插件 name 重复：${manifest.name}（目录 ${existing.dirName} 已让位给同名的 ${entry.name}）`
        console.error(`[plugin] ${msg}`)
        plugins[idx] = { ...existing, broken: true, error: msg }
        names.delete(manifest.name)   // 让下面按正常路径重新登记
      } else {
        const msg = `插件 name 重复：${manifest.name}（目录 ${entry.name}）`
        console.error(`[plugin] ${msg}，已跳过`)
        plugins.push({ ...manifest, dir, dirName: entry.name, broken: true, error: msg })
        continue
      }
    }
    names.add(manifest.name)
    plugins.push(manifest)
  }

  return plugins.sort((a, b) => (Number(a.order) || 100) - (Number(b.order) || 100) || String(a.name).localeCompare(String(b.name)))
}

export function pluginPublicInfo(plugin, enabled, extra = {}) {
  // version 永远是插件自己的 plugin.json.version；expectedVersion 才是门户侧对接版本。
  const ownVersion = plugin.dir ? getPluginOwnVersion(plugin.dir) : (isValidVersion(plugin.version) ? String(plugin.version).trim() : '1.0.0')
  const expectedVersion = isValidVersion(extra.expectedVersion) ? String(extra.expectedVersion).trim() : ownVersion
  const info = {
    name: plugin.name,
    title: plugin.title || plugin.name,
    description: plugin.description || '',
    version: ownVersion,
    expectedVersion,
    versionMatch: ownVersion === expectedVersion,
    order: Number(plugin.order) || 100,
    enabled,
    menu: plugin.menu || null,
    frontend: plugin.frontend || null,
    settings: plugin.settings || null,
    apiMount: plugin.api?.mount || '/api',
    ...extra
  }
  // extra 可能带旧的 version 字段，必须以清单中的实际版本为准覆盖回来。
  info.version = ownVersion
  info.expectedVersion = expectedVersion
  info.versionMatch = ownVersion === expectedVersion
  return info
}

export async function mountPlugins(app, {
  logger = console,
  pluginDir = PLUGIN_DIR,
  stateFile = PLUGIN_STATE_FILE
} = {}) {
  const state = readPluginState(stateFile)
  const discovered = scanPlugins(pluginDir)
  const plugins = []

  // 旧状态文件里 state[name].version 是“网站改的展示版本”；新模型拆成：
  //   plugin.json.version        = 插件自身版本
  //   state[name].expectedVersion = 网站对接版本
  // 首次启动时把旧值迁移为 expectedVersion，保留用户原来的选择。
  let stateChanged = false
  for (const plugin of discovered) {
    if (plugin.broken || !plugin.name) continue
    const current = state[plugin.name]
    if (isValidVersion(current?.version) && !isValidVersion(current?.expectedVersion)) {
      state[plugin.name] = { ...(current || {}), expectedVersion: String(current.version).trim() }
      delete state[plugin.name].version
      stateChanged = true
    }
  }
  if (stateChanged) writePluginState(state, stateFile)

  // 每个「有后端入口」的插件的运行时句柄。门禁中间件通过闭包引用它。
  // name -> { manifest, record, instance, router, started }
  const runtime = new Map()

  // 热重载并发保护：同一插件不可并发重载；批量重载期间不收单个重载（反之亦然）。
  // mountPlugins 每进程只调用一次，这些标记天然是进程级的。
  const reloading = new Set()
  let reloadingAll = false
  let reloadSeq = 0

  /** 带 code 的错误：路由层据此映射 HTTP 状态码（不改动现有抛错方式，纯增量）。 */
  function pluginError(message, code) {
    const e = new Error(message)
    e.code = code
    return e
  }

  /**
   * 热重载单个插件的后端代码（不重启门户）。
   *
   * 分两阶段，边界就是「原子性」的来源：
   *   阶段 A —— 只加载、不碰旧实例：重读清单 → import 新代码 → 校验导出。
   *             import 可能耗时几百毫秒，但这段完全不在门禁窗口内，旧实例照常服务。
   *             任何失败都在这里抛错，旧 instance / 旧 router / 门禁挂载点原样 ——
   *             「新代码有问题时插件不被打挂」就是靠这个顺序保证的（连 stop() 都不会调）。
   *   阶段 B —— 副作用切换：关闸 → stop() 旧 → start() 新 → 开闸。
   *             B 一旦开始就不可回滚（旧实例已 stop）；start 失败则明确置为"已停止"，
   *             修好代码再点一次重载即可恢复。
   */
  async function reload(name, { fromBatch = false } = {}) {
    const record = plugins.find((p) => p.name === name)
    if (!record) throw pluginError(`未找到插件 ${name}`, 'NOT_FOUND')
    if (record.broken) throw pluginError(`插件 ${name} 清单无效，无法重载`, 'INVALID_STATE')
    const rt = runtime.get(name)
    if (!rt) throw pluginError(`插件 ${name} 没有后端入口，不支持热重载`, 'INVALID_STATE')
    // 禁用插件在启动期就不 import（保留「禁用 = 无副作用」的约定），重载会破坏这条不变式
    if (!record.enabled) throw pluginError(`插件 ${name} 已禁用，请先启用再重载`, 'INVALID_STATE')
    if (reloadingAll && !fromBatch) throw pluginError('正在批量重载插件，请稍后再试', 'BUSY')
    if (reloading.has(name)) throw pluginError(`插件 ${name} 正在重载中，请稍候`, 'BUSY')

    reloading.add(name)
    try {
      // ============ 阶段 A：只加载 + 校验，对旧实例零副作用 ============
      const manifest = readManifest(record.dir, record.dirName) // 清单坏了在这里就抛，旧实例不动
      if (manifest.name !== record.name) {
        // 门禁、runtime Map、状态文件全按旧 name 登记，改名无法在线生效
        throw pluginError(`插件 name 已由 ${record.name} 改为 ${manifest.name}，需重启门户`, 'INVALID_STATE')
      }
      if (!manifest.api?.module) throw pluginError(`插件 ${name} 的 api.module 已被移除，需重启门户`, 'INVALID_STATE')

      const warnings = []
      const oldMount = rt.manifest.api?.mount || '/api'
      const newMount = manifest.api.mount || '/api'
      if (newMount !== oldMount) {
        // 门禁中间件在启动时按旧 mount 注册，Express 无法改挂载位置
        warnings.push(`api.mount 已由 ${oldMount} 改为 ${newMount}，需重启门户才生效（本次仍按 ${oldMount} 提供）`)
      }

      // 与 Node 自身的 realpath 行为对齐（macOS /var → /private/var 软链）
      let pluginRoot = manifest.dir
      try {
        pluginRoot = fs.realpathSync.native(manifest.dir)
      } catch { /* 保持原路径 */ }
      const modulePath = path.resolve(pluginRoot, manifest.api.module)

      const token = `${name}-${Date.now()}-${++reloadSeq}`
      const deep = installReloadHooks()
      registerReloadScope(token, pluginRoot)
      purgePluginCjsCache(manifest.dir) // 插件自己的 .cjs 也拿新代码（ESM 的 ?v= 管不到 CJS）

      const url = pathToFileURL(modulePath)
      url.searchParams.set(MARKER_KEY, token) // 入口自己带标记，钩子才认得出这段 import 图
      const mod = await import(url.href)
      const exported = mod.default || mod
      const router = exported?.router || exported
      if (typeof router !== 'function') {
        throw pluginError(`插件 ${name} 未导出 Express router（已保留旧版本继续运行）`, 'RELOAD_FAILED')
      }
      if (!deep) warnings.push('当前 Node 不支持深度热重载，本次仅入口文件生效，子模块改动需重启门户')

      // ============ 阶段 B：副作用切换（不可回滚区） ============
      const prevRouter = rt.router
      rt.router = null // 关闸：stop 期间不会有新请求打到「正在关闭」的旧路由
      try {
        await deactivate(rt) // 必须先把旧的收干净：定时器 / 子进程 / botClient guard
      } catch (e) {
        rt.router = prevRouter // 门禁恢复原状，旧实例继续服务（优先「不把插件打挂」）
        throw pluginError(`旧实例停止失败，已保留原状：${e.message}`, 'RELOAD_FAILED')
      }

      rt.instance = exported
      rt.record.instance = exported
      // rt.setupDone 绝不重置：setup() 含 app.use 等不可逆挂载，重跑会把资源挂两遍
      try {
        if (typeof exported?.start === 'function') await exported.start({ app, plugin: manifest, logger })
        rt.started = true
      } catch (e) {
        try {
          await exported?.stop?.({ app, plugin: manifest, logger })
        } catch { /* 清理失败不掩盖主错误 */ }
        rt.instance = null
        rt.record.instance = null
        rt.started = false
        record.loaded = false
        record.error = `重载后启动失败：${e.message}`
        throw pluginError(`${record.error}（插件已停止服务，修复代码后再次点击重载即可恢复）`, 'RELOAD_FAILED')
      }

      rt.manifest = manifest
      rt.router = router // 开闸：门禁每请求实时读 rt.router，此处赋值立即生效
      record.loaded = true
      record.error = null
      record.version = getPluginOwnVersion(record.dir) // 版本可能同时被插件设置页改过
      record.versionMatch = record.version === record.expectedVersion

      const setupSkipped = typeof exported?.setup === 'function'
      if (setupSkipped) warnings.push('setup() 未重新执行：其中 app.use 等一次性挂载的改动需重启门户')
      logger.info?.(`[plugin] ${name} 后端已热重载${deep ? '（含子模块）' : '（仅入口）'}`)

      return { record, deep, setupSkipped, warnings, restartRequired: setupSkipped || newMount !== oldMount }
    } finally {
      reloading.delete(name)
    }
  }

  /**
   * 批量热重载「已启用且有后端入口」的插件。
   * 串行执行：market 的 start() 会 spawn Python 子进程并读飞书表，并行会互相挤。
   * 单个失败不中断整批，逐项结果由 results 表达。
   */
  async function reloadAll() {
    if (reloadingAll) throw pluginError('正在批量重载插件，请稍候', 'BUSY')
    if (reloading.size) throw pluginError('有插件正在重载中，请稍后再试', 'BUSY')
    reloadingAll = true
    try {
      const targets = plugins.filter((p) => !p.broken && p.enabled && runtime.has(p.name))
      const results = []
      for (const p of targets) {
        try {
          const r = await reload(p.name, { fromBatch: true })
          results.push({
            name: p.name,
            ok: true,
            loaded: !!r.record.loaded,
            setupSkipped: r.setupSkipped,
            restartRequired: r.restartRequired,
            warnings: r.warnings
          })
        } catch (e) {
          results.push({ name: p.name, ok: false, error: e.message })
        }
      }
      return {
        total: targets.length,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        skipped: plugins.filter((p) => !p.broken && !p.enabled).map((p) => p.name),
        results
      }
    } finally {
      reloadingAll = false
    }
  }

  /**
   * 首次启用时加载插件：动态 import → setup → start。
   * - ESM 模块有缓存，重复 import 返回同一实例。
   * - `setupDone` 单独记录：setup() 通常含 app.use(...) 这类一次性副作用，
   *   即使它中途抛错、管理员修复后再次启用，也不能重复执行（否则资源会被挂载两次）。
   * - start() 与「已加载」分开记：禁用后再启用需要重新 start()，但不能再 import/setup。
   */
  async function activate(rt) {
    if (!rt.instance) {
      const plugin = rt.manifest
      const modulePath = path.resolve(plugin.dir, plugin.api.module)
      const mod = await import(pathToFileURL(modulePath).href)
      const exported = mod.default || mod
      const router = exported?.router || exported
      if (typeof router !== 'function') {
        throw new Error(`插件 ${plugin.name} 未导出 Express router`)
      }
      rt.instance = exported
      rt.router = router
      rt.record.instance = exported   // 供排查/观测；生命周期由 rt 管理

      if (!rt.setupDone && typeof exported?.setup === 'function') {
        rt.setupDone = true            // 先置位：即使 setup 抛错也不再重复执行
        await exported.setup(app, { plugin, logger })
      }
    }
    if (!rt.started) {
      if (typeof rt.instance?.start === 'function') {
        await rt.instance.start({ app, plugin: rt.manifest, logger })
      }
      rt.started = true
    }
    // 全部步骤成功后才标记为已加载：setup/start 中途抛错时 loaded 应保持 false，
    // 否则插件页会显示"已加载"但实际不可用。
    rt.record.loaded = true
    rt.record.error = null
  }

  /** 停用：调 stop() 收掉后台服务（定时器 / 子进程 / 正在跑的步骤）。模块本身无法从进程卸载。 */
  async function deactivate(rt) {
    if (!rt.started) return
    if (typeof rt.instance?.stop === 'function') {
      await rt.instance.stop({ app, plugin: rt.manifest, logger })
    }
    rt.started = false
  }

  for (const plugin of discovered) {
    // 清单损坏/重名的插件：只登记状态供插件页展示，不参与加载，也不影响其它插件
    if (plugin.broken) {
      plugins.push({ ...pluginPublicInfo(plugin, false), dir: plugin.dir, broken: true, loaded: false, error: plugin.error })
      continue
    }

    const enabled = state[plugin.name]?.enabled ?? plugin.enabled !== false
    const expectedVersion = isValidVersion(state[plugin.name]?.expectedVersion)
      ? String(state[plugin.name].expectedVersion).trim()
      : (isValidVersion(plugin.version) ? String(plugin.version).trim() : '1.0.0')
    const info = pluginPublicInfo(plugin, enabled, { expectedVersion })
    // loaded 显式初始化：pluginPublicInfo 不含该字段，缺省会让内部记录里是 undefined
    // （HTTP 层靠 !!p.loaded 侥幸正确，但内部形状不统一，容易被后续代码误判断）
    // hasBackend 显式暴露给前端：apiMount 默认就是 '/api'，光看它区分不出"有没有后端入口"，
    // 而「重载」按钮只对有后端入口的插件有意义。
    // dirName 一并带上：热重载要重新校验清单（readManifest(dir, dirName)），缺了会误报
    // 「目录名 undefined 与插件名不一致」。
    const record = {
      ...info,
      dir: plugin.dir,
      dirName: plugin.dirName,
      loaded: false,
      error: null,
      hasBackend: !!plugin.api?.module
    }

    if (!plugin.api?.module) {
      // 纯前端插件：没有后端入口，前端本身即为完整能力，状态只影响前端菜单/路由。
      plugins.push({ ...record, loaded: true })
      continue
    }

    // 有后端入口的插件：无论当前启用与否，都在「正确的位置」注册一个门禁。
    //
    // 为什么要门禁：Express 既不能卸载已挂载的路由，也不能把新路由插到已有的
    // 404 处理器之前。所以运行时启停只能靠"路由始终在册、由门禁决定是否放行"。
    // 禁用的插件此刻仍然不 import —— 保留"禁用 = 无副作用"（不会触发 Python 探测、
    // 预热读表等 import 期行为），直到真正被启用时才加载。
    const rt = { manifest: plugin, record, instance: null, router: null, started: false, setupDone: false }
    runtime.set(plugin.name, rt)
    plugins.push(record)

    app.use(plugin.api.mount || '/api', (req, res, next) => {
      // 禁用时不拦截，交给后续中间件（该插件的路由最终表现为 404，
      // 与"根本没加载这个插件"的行为一致）；也避免误伤同前缀下的其它路由。
      if (!record.enabled || !rt.router) return next()
      return rt.router(req, res, next)
    })

    if (!enabled) {
      logger.info?.(`[plugin] ${plugin.name} 已禁用，跳过加载（启用时即时生效，无需重启）`)
      continue
    }

    try {
      await activate(rt)
      logger.info?.(`[plugin] ${plugin.name} 已加载（API ${plugin.api.mount || '/api'}）`)
    } catch (e) {
      record.loaded = false
      record.error = e.message
      logger.error?.(`[plugin] ${plugin.name} 加载失败：${e.message}`)
    }
  }

  return {
    plugins,
    byName: new Map(plugins.map((p) => [p.name, p])),

    /**
     * 运行时启停插件（持久化启用状态 + 立即生效，不再要求重启门户）。
     * 启用失败会抛出，由调用方转成 HTTP 错误；此时状态不会被写成 enabled。
     */
    async setEnabled(name, enabled) {
      const rt = runtime.get(name)
      const record = plugins.find((p) => p.name === name)
      if (!record) throw new Error(`未找到插件 ${name}`)
      if (record.broken) throw new Error(`插件 ${name} 清单无效，无法启用`)

      if (enabled) {
        // 先加载、成功后才开门：避免请求打到尚未初始化完成的路由
        if (rt) await activate(rt)
        record.enabled = true
      } else if (rt) {
        // 先关门、再停服务：停的过程中不会有新请求进来
        record.enabled = false
        try {
          await deactivate(rt)
        } catch (e) {
          logger.error?.(`[plugin] ${name} 停止时出错（已禁用）：${e.message}`)
        }
      } else {
        record.enabled = false
      }

      setPluginEnabled(name, enabled, stateFile)
      logger.info?.(`[plugin] ${name} 已${enabled ? '启用' : '禁用'}（即时生效）`)
      return record
    },

    /** 修改门户侧的“对接插件版本号”（expectedVersion），不修改插件自身 plugin.json。 */
    async setExpectedVersion(name, version) {
      const record = plugins.find((p) => p.name === name)
      if (!record) throw new Error(`未找到插件 ${name}`)
      if (record.broken) throw new Error(`插件 ${name} 清单无效，无法修改版本号`)
      record.expectedVersion = setPluginExpectedVersion(name, version)
      // 插件自身版本可能刚在插件设置页改过，这里顺便从 plugin.json 刷新一次。
      record.version = getPluginOwnVersion(record.dir)
      record.versionMatch = record.version === record.expectedVersion
      logger.info?.(`[plugin] ${name} 对接版本号已更新为 ${record.expectedVersion}`)
      return record
    },

    /** @deprecated 旧调用别名；原语义“改展示版本”现在落到 expectedVersion。 */
    async setVersion(name, version) {
      return this.setExpectedVersion(name, version)
    },

    /** 热重载单个插件的后端代码（含 routes/、lib/ 子模块），不重启门户。 */
    reload,

    /** 批量热重载所有「已启用且有后端入口」的插件；单个失败不中断整批。 */
    reloadAll,

    async stop() {
      for (const rt of runtime.values()) {
        try {
          await deactivate(rt)
        } catch (e) {
          logger.error?.(`[plugin] ${rt.manifest.name} 停止失败：${e.message}`)
        }
      }
    }
  }
}
