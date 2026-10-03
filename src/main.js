import { createApp } from 'vue'
import router from './router'
import App from './App.vue'
import { pluginManager } from './plugins/core/PluginManager.js'
// 主题系统:默认主题(黑空科技)在 theme.css :root,
// 其余主题位于 src/themes/*.css,使用 import.meta.glob 自动引入,新增/删除无需改 main.js。
import './styles/theme.css'
// { eager: true } 会把每个 CSS 展开成静态 import，副作用已由打包器保证，
// 无需再保留引用（原先那句 Object.values(...) 是空操作）。
import.meta.glob('./themes/*.css', { eager: true })
// 主题艺术层:在全部主题变量之后加载,负责字体/材质/动效的创意重构
import './styles/creative.css'
import './styles/ui-polish.css'
import './styles/layout.css'
import { initTheme } from './composables/useTheme.js'

async function loadEnabledPluginNames() {
  try {
    // 必须带超时：后端进程"TCP 连得上但不响应"时原生 fetch 会一直挂着，
    // 而这里在挂载之前 await，页面会永久白屏且没有任何提示。
    const res = await fetch('/api/kernel/plugins', { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const data = await res.json()
    const list = Array.isArray(data.data) ? data.data : []
    return new Set(list.filter((p) => p.enabled !== false && p.loaded).map((p) => p.name))
  } catch (e) {
    console.warn('[plugin] 读取后端插件目录失败，按全部启用处理:', e.message)
    return null
  }
}

async function bootstrap() {
  // 恢复上次选择的主题(设置 html[data-theme],须在挂载前完成避免闪烁)
  initTheme()

  // 后端已禁用的插件不再注册前端路由/菜单；拿不到目录时回退为全部加载。
  const enabledNames = await loadEnabledPluginNames()

  // 加载启用插件的本地前端入口
  const pluginContexts = import.meta.glob('/plugins/*/frontend/index.js', { eager: true })

  Object.values(pluginContexts).forEach((module) => {
    const PluginClass = module.default
    if (typeof PluginClass !== 'function') return
    const plugin = new PluginClass()
    if (enabledNames && !enabledNames.has(plugin.name)) {
      console.info(`[plugin] ${plugin.name} 后端已禁用，跳过前端注册`)
      return
    }
    pluginManager.register(plugin)
  })

  // 先完成初始化，再把已加载的插件切换到 enabled；这样 onEnable/onDisable
  // 与设置页的生命周期语义一致，而不是只停留在 initialized 状态。
  // 逐插件容错：PluginBase.enable() 在 onEnable 抛错时会 rethrow，
  // 原先这里没有 try/catch 且 bootstrap() 也没有 .catch()，
  // 任何一个插件启用失败都会让 app.mount 永不执行 —— 整站白屏且无任何提示。
  try {
    await pluginManager.initializeAll()
  } catch (e) {
    console.error('[plugin] 插件初始化失败，跳过初始化阶段:', e)
  }
  for (const plugin of pluginManager.list()) {
    try {
      await pluginManager.enable(plugin.name)
    } catch (e) {
      console.error(`[plugin] ${plugin.name} 启用失败，跳过:`, e)
    }
  }

  // 统一注册插件路由(菜单显示由禁用名单过滤,路由始终保留)
  // 2026-08-12 安全修复:动态路由统一补 requiresAuth,未登录不可访问任何插件页面
  try {
    pluginManager.getRoutes().forEach((route) => {
      if (route && route.path) {
        router.addRoute('Home', { ...route, meta: { ...route.meta, requiresAuth: true } })
      }
    })
  } catch (e) {
    console.error('[plugin] 注册插件路由失败，跳过:', e)
  }

  const app = createApp(App)
  app.use(router)
  app.mount('#app')
}

// 兜底：bootstrap 任何未预料的异常都不能让页面停在空白状态，
// 至少渲染一句可读的提示，方便用户与运维判断是前端还是后端的问题。
bootstrap().catch((e) => {
  console.error('[app] 启动失败:', e)
  const el = document.getElementById('app')
  if (el) {
    el.innerHTML = '<div style="padding:32px;font-family:system-ui,sans-serif;color:#b00">'
      + '<h2>页面启动失败</h2>'
      + '<p>请刷新重试；若持续失败请检查后端服务是否正常。</p>'
      + `<pre style="white-space:pre-wrap;color:#666">${String(e && e.message || e)}</pre>`
      + '</div>'
  }
})
