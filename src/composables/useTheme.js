/**
 * 主题系统核心:主题注册表 + data-theme 切换 + localStorage 持久化
 *
 * 机制:html[data-theme="主题名"] → src/themes/*.css 内的变量覆盖块生效。
 * 默认主题 = 黑空科技(black-air),变量定义在 src/styles/theme.css :root。
 * 切换入口:SettingsView 主题中心(Home 顶栏无主题下拉)。
 */
import { ref } from 'vue'

export const THEME_KEY = 'rpa-theme'

/** 主题注册表(名称须与 themes/*.css 的 data-theme 值一致)
 *  preview: [主色, 背景, 辅色]——设置页主题卡会模拟迷你窗口展示
 *  font:    该主题的显示字体,设置页预览会真实呈现字体人格 */
export const THEMES = [
  { name: 'black-air', label: '深空蓝', desc: '深空蓝 + 极光青，默认科技感', dark: false, preview: ['#2563eb', '#f5f7fa', '#22d3ee'], font: "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif" },
  { name: 'cyberpunk', label: '赛博霓虹', desc: '紫黑底 + 品红/青色双霓虹，故障艺术', dark: true, preview: ['#ff2d95', '#12081f', '#00f0ff'], font: "'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { name: 'black-gold', label: '黑金奢感', desc: '纯黑 + 香槟金，克制的奢华商务感', dark: true, preview: ['#c9a25e', '#0a0a0a', '#f4e3bb'], font: "Georgia, 'Songti SC', serif" },
  { name: 'retro-paper', label: '复古纸感', desc: '米黄纸 + 深棕红，旧文档报纸气质', dark: false, preview: ['#9a3b26', '#f4ead8', '#b5822f'], font: "Georgia, 'Songti SC', 'SimSun', serif" },
  { name: 'sakura', label: '樱花粉彩', desc: '浅粉白 + 樱粉，日系温柔的少女感', dark: false, preview: ['#f472b6', '#fdf6fa', '#f9a8d4'], font: "'Yuanti SC', 'YouYuan', 'PingFang SC', sans-serif" },
  { name: 'terminal-green', label: '终端绿', desc: '黑底绿字 + 等宽字体 + CRT 扫描线', dark: true, preview: ['#33ff66', '#070a0b', '#8affa8'], font: "'SF Mono', Menlo, Consolas, monospace" }
]
// 当前主题(初始化即校验 localStorage,非法值回退默认,避免中间态)
const savedTheme = localStorage.getItem(THEME_KEY)
const currentTheme = ref(THEMES.some(t => t.name === savedTheme) ? savedTheme : 'black-air')

/** 应用主题:设置根属性 + 持久化 */
export function applyTheme(name) {
  if (!THEMES.some(t => t.name === name)) return
  document.documentElement.setAttribute('data-theme', name)
  localStorage.setItem(THEME_KEY, name)
  currentTheme.value = name
}

/** 应用启动时恢复上次选择的主题(非法值回退默认) */
export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY)
  applyTheme(saved && THEMES.some(t => t.name === saved) ? saved : 'black-air')
}

/** 视图内使用:返回响应式当前主题、切换函数、主题注册表 */
export function useTheme() {
  return { currentTheme, applyTheme, THEMES }
}