/**
 * 插件管理器:统一注册、初始化、启用/禁用、路由收集
 * 模块级单例,main.js 与各视图共享同一实例
 */
export class PluginManager {
  constructor() {
    this.plugins = new Map()
  }

  /** 注册插件(同名插件幂等) */
  register(plugin) {
    if (!plugin || typeof plugin.name !== 'string') {
      throw new Error('插件缺少 name')
    }
    if (this.plugins.has(plugin.name)) {
      console.warn(`[PluginManager] 插件 "${plugin.name}" 已注册,忽略重复`)
      return this.plugins.get(plugin.name)
    }
    this.plugins.set(plugin.name, plugin)
    return plugin
  }

  get(name) {
    return this.plugins.get(name) || null
  }

  list() {
    return [...this.plugins.values()]
  }

  /** 执行所有插件 initialize() 生命周期 */
  async initializeAll() {
    const results = []
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.initialize()
        results.push({ name: plugin.name, ok: true })
      } catch (error) {
        console.error(`[PluginManager] "${plugin.name}" 初始化失败:`, error)
        results.push({ name: plugin.name, ok: false, error: error.message })
      }
    }
    return results
  }

  async enable(name) {
    const plugin = this.get(name)
    if (!plugin) throw new Error(`插件 "${name}" 不存在`)
    await plugin.enable()
  }

  async disable(name) {
    const plugin = this.get(name)
    if (!plugin) throw new Error(`插件 "${name}" 不存在`)
    await plugin.disable()
  }

  /** 插件路由 */
  getRoutes() {
    return this.list().flatMap(p => p.getRoutes())
  }
}

export const pluginManager = new PluginManager()
