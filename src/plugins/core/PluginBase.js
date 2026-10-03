export default class PluginBase {
  constructor(name) {
    this.name = name
    this.enabled = false
    this.initialized = false
    this.version = '1.0.0'
    this.type = 'local' // local 或 remote
    this.dependencies = []
  }

  /**
   * 插件初始化方法
   */
  async initialize() {
    if (this.initialized) {
      console.warn(`[${this.name}] 插件已初始化`)
      return
    }
    
    try {
      await this.onInitialize()
      this.initialized = true
      console.log(`[${this.name}] 插件初始化成功`)
    } catch (error) {
      console.error(`[${this.name}] 插件初始化失败:`, error)
      throw error
    }
  }

  /**
   * 启用插件
   */
  async enable() {
    if (this.enabled) {
      console.warn(`[${this.name}] 插件已启用`)
      return
    }
    
    try {
      await this.onEnable()
      this.enabled = true
      console.log(`[${this.name}] 插件已启用`)
    } catch (error) {
      console.error(`[${this.name}] 插件启用失败:`, error)
      throw error
    }
  }

  /**
   * 禁用插件
   */
  async disable() {
    if (!this.enabled) {
      console.warn(`[${this.name}] 插件已禁用`)
      return
    }
    
    try {
      await this.onDisable()
      this.enabled = false
      console.log(`[${this.name}] 插件已禁用`)
    } catch (error) {
      console.error(`[${this.name}] 插件禁用失败:`, error)
      throw error
    }
  }

  /**
   * 获取插件路由配置
   */
  getRoutes() {
    return []
  }

  // 生命周期钩子方法（子类可重写）
  async onInitialize() {}
  async onEnable() {}
  async onDisable() {}
}

export class LocalPlugin extends PluginBase {
  // 不再接收 config：PluginBase 的构造函数只认 name，第二个实参会被静默丢弃，
  // 留着这个形参只会让人误以为传进去的配置生效了。
  constructor(name) {
    super(name)
    this.type = 'local'
  }
}