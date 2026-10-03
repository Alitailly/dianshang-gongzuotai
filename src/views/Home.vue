<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import {
  Setting,
  Collection,
  Document,
  Tools,
  SwitchButton,
  DataAnalysis,
  ShoppingCart,
  Picture,
  Shop,
  ArrowRight
} from '@element-plus/icons-vue'
import { request, authHeaders, logoutAndRedirect } from '../utils/request.js'

const router = useRouter()
const route = useRoute()
const user = ref(JSON.parse(localStorage.getItem('user') || '{}'))
const isAdmin = computed(() => user.value.role === 'admin')
const displayName = computed(() => user.value.username || user.value.name || '用户')
const avatarText = computed(() => String(displayName.value).trim().slice(0, 1).toUpperCase())
const activeMenu = ref('/')
const disabledPlugins = ref(JSON.parse(localStorage.getItem('disabledPlugins') || '[]'))

// 从路由中获取插件菜单项
const pluginMenuItems = computed(() => {
  const allRoutes = router.getRoutes()
  return allRoutes
    .filter(route => route.meta?.plugin && !route.meta?.hidden && !disabledPlugins.value.includes(route.meta.plugin))
    .map((route, sourceIndex) => ({
      index: route.name.toLowerCase(),
      path: route.path,
      title: route.meta.title,
      icon: route.meta.icon,
      plugin: route.meta.plugin,
      group: route.meta.group || '',
      groupIcon: route.meta.groupIcon || '',
      groupBadge: route.meta.groupBadge || '',
      groupOrder: Number.isFinite(Number(route.meta.groupOrder)) ? Number(route.meta.groupOrder) : null,
      section: route.meta.section || '',
      sidebarOrder: Number.isFinite(Number(route.meta.sidebarOrder))
        ? Number(route.meta.sidebarOrder)
        : 1000 + sourceIndex
    }))
    .sort((a, b) => a.sidebarOrder - b.sidebarOrder || a.title.localeCompare(b.title, 'zh-CN'))
})

// 图标映射：键必须是插件路由 meta.icon 里真正声明过的名字。
// 原来还挂着 TrendCharts / Filter，但没有任何插件声明它们，属死条目；
// 反过来 ShoppingCart / Picture 被 market 插件声明却不在表里，会静默回落成 Collection。
const iconMap = {
  'Collection': Collection,
  'Document': Document,
  'Setting': Setting,
  'DataAnalysis': DataAnalysis,
  'ShoppingCart': ShoppingCart,
  'Picture': Picture,
  'Shop': Shop
}

const menuBlocks = computed(() => {
  const blocks = []
  const groups = new Map()
  for (const item of pluginMenuItems.value) {
    if (!item.group) {
      blocks.push({ type: 'item', key: item.index, order: item.sidebarOrder, item })
      continue
    }
    let group = groups.get(item.group)
    if (!group) {
      group = {
        type: 'group',
        key: `group:${item.group}`,
        title: item.group,
        icon: item.groupIcon || 'Shop',
        badge: item.groupBadge,
        order: item.groupOrder ?? item.sidebarOrder,
        sections: []
      }
      groups.set(item.group, group)
      blocks.push(group)
    }
    let section = group.sections.find((entry) => entry.title === (item.section || '其他'))
    if (!section) {
      section = { title: item.section || '其他', order: item.sidebarOrder, items: [] }
      group.sections.push(section)
    }
    section.items.push(item)
    section.order = Math.min(section.order, item.sidebarOrder)
  }
  for (const group of groups.values()) {
    group.sections.sort((a, b) => a.order - b.order)
  }
  return blocks.sort((a, b) => a.order - b.order)
})

// 分组默认全部展开，避免新增分组时还要回来改这里
const defaultOpeneds = computed(() => menuBlocks.value.filter((b) => b.type === 'group').map((b) => b.key))

const getIcon = (iconName) => {
  return iconMap[iconName] || Collection
}

const isSettingsPath = (path) => path.startsWith('/plugins') || path.startsWith('/users') || path.startsWith('/settings')

const findMenuItem = (path) => [...pluginMenuItems.value]
  .sort((a, b) => b.path.length - a.path.length)
  .find(item => path === item.path || (item.path && item.path !== '/' && path.startsWith(`${item.path}/`)))

// 根据当前路由计算高亮菜单
const calcActiveMenu = () => {
  const path = route.path
  if (path === '/' || path === '') return '/'
  // 插件管理、用户管理已迁移进网站设置；旧地址访问时也高亮“设置”。
  if (isSettingsPath(path)) return 'settings'
  const plugin = findMenuItem(path)
  return plugin ? plugin.index : path
}

// 顶栏面包屑：分组 / 菜单项 / 隐藏子页（如 询盘自动化 / 终端日志）
const crumbs = computed(() => {
  const path = route.path
  if (isSettingsPath(path)) return [{ title: '设置' }]
  const item = findMenuItem(path)
  if (!item) return route.meta?.title ? [{ title: route.meta.title }] : []
  const list = []
  if (item.group) list.push({ title: item.group })
  list.push({ title: item.title, path: path === item.path ? '' : item.path })
  const leafTitle = route.meta?.title
  if (path !== item.path && leafTitle && leafTitle !== item.title) list.push({ title: leafTitle })
  return list
})

watch(() => route.path, () => {
  activeMenu.value = calcActiveMenu()
})

const handleLogout = async () => {
  // 通知服务端作废会话(全局单会话),失败不阻塞本地登出
  try {
    await request('/api/logout', {
      method: 'POST',
      headers: authHeaders()
    })
  } catch (e) {
    console.error('登出通知失败:', e)
  }
  ElMessage.success('退出成功')
  logoutAndRedirect()
}

const goCrumb = (crumb) => {
  if (crumb.path) router.push(crumb.path)
}

const handleMenuSelect = async (index) => {
  activeMenu.value = index
  const target = index === '/' ? '/'
    : index === 'settings' ? '/settings'
    : null
  if (target) {
    try {
      await router.push(target)
    } catch (e) {
      // 兜底:路由异常时整页跳转,保证一定能进入目标页
      console.error('路由跳转失败,改用整页跳转:', e)
      window.location.href = target
    }
    return
  }
  // 插件菜单项
  const pluginRoute = pluginMenuItems.value.find(item => item.index === index)
  if (pluginRoute && pluginRoute.path) {
    try {
      await router.push(pluginRoute.path)
    } catch (e) {
      console.error('路由跳转失败,改用整页跳转:', e)
      window.location.href = pluginRoute.path
    }
  } else {
    try {
      await router.push(index)
    } catch (e) {
      console.error('路由跳转失败,改用整页跳转:', e)
      window.location.href = index
    }
  }
}

onMounted(() => {
  if (!localStorage.getItem('token')) {
    router.push('/login')
    return
  }
  activeMenu.value = calcActiveMenu()
})
</script>

<template>
  <div class="home-container">
    <el-container class="home-layout">
      <el-header class="app-header">
        <div class="header-left">
          <span class="brand-mark">选</span>
          <span class="app-title">选品助手</span>
        </div>
        <nav v-if="crumbs.length" class="header-crumbs" aria-label="当前位置">
          <template v-for="(crumb, i) in crumbs" :key="i">
            <el-icon v-if="i > 0" class="crumb-sep"><ArrowRight /></el-icon>
            <span
              class="crumb"
              :class="{ current: i === crumbs.length - 1, link: !!crumb.path }"
              @click="goCrumb(crumb)"
            >{{ crumb.title }}</span>
          </template>
        </nav>
        <div class="header-right">
          <div class="user-info">
            <span class="user-avatar">{{ avatarText }}</span>
            <span class="user-name">{{ displayName }}</span>
            <span v-if="isAdmin" class="user-role">管理员</span>
          </div>
          <el-tooltip content="退出登录" placement="bottom">
            <el-button class="logout-btn" text circle aria-label="退出登录" @click="handleLogout">
              <el-icon :size="16"><SwitchButton /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
      </el-header>
      <el-container class="body-layout">
        <el-aside class="app-aside">
          <el-menu
            :default-active="activeMenu"
            :default-openeds="defaultOpeneds"
            class="app-menu"
            @select="handleMenuSelect"
          >
            <!-- 2026-08-07:仪表盘已删除,默认进入询盘自动化(/tools) -->
            <!-- 插件管理、用户管理已迁移进“设置”页，不再单独占一级菜单 -->
            <div v-if="pluginMenuItems.length" class="menu-caption">工作台</div>

            <template v-for="block in menuBlocks" :key="block.key">
              <el-menu-item v-if="block.type === 'item'" :index="block.item.index">
                <el-icon><component :is="getIcon(block.item.icon)" /></el-icon>
                <span>{{ block.item.title }}</span>
              </el-menu-item>
              <el-sub-menu v-else :index="block.key">
                <template #title>
                  <el-icon><component :is="getIcon(block.icon)" /></el-icon>
                  <span class="group-title">{{ block.title }}</span>
                  <span v-if="block.badge" class="group-badge">{{ block.badge }}</span>
                </template>
                <el-menu-item-group v-for="section in block.sections" :key="section.title" :title="section.title">
                  <el-menu-item v-for="item in section.items" :key="item.index" :index="item.index">
                    <span>{{ item.title }}</span>
                  </el-menu-item>
                </el-menu-item-group>
              </el-sub-menu>
            </template>

            <!-- 2026-08-07:设置移到菜单最底部 -->
            <el-menu-item index="settings" class="settings-menu-item">
              <el-icon><Tools /></el-icon>
              <span>设置</span>
            </el-menu-item>
          </el-menu>
        </el-aside>
        <el-main class="app-main">
          <router-view></router-view>
        </el-main>
      </el-container>
    </el-container>
  </div>
</template>

<style scoped>
.home-container { height: 100vh; height: 100dvh; overflow: hidden; }
.home-layout { height: 100%; }

/* ---------- 顶栏：品牌区与侧栏同宽，中间是面包屑，右侧是用户 ---------- */
.app-header {
  position: relative;
  height: var(--app-header-height, 56px) !important;
  background: var(--app-header-bg, linear-gradient(90deg, #1f2329 0%, #2a2f38 100%));
  color: var(--app-header-text, #fff);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 20px 0 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  z-index: 10;
  overflow: hidden;
  transition: background 0.35s ease, color 0.35s ease;
}

.app-header::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--app-header-sheen, none);
  pointer-events: none;
}

.app-header::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--app-header-accent, linear-gradient(90deg, #2563eb 0%, #22d3ee 45%, transparent 95%));
  pointer-events: none;
}

.header-left {
  position: relative;
  flex: 0 0 var(--app-shell-aside-width, 232px);
  box-sizing: border-box;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px;
  border-right: 1px solid var(--app-header-divider, rgba(255, 255, 255, 0.12));
}

.brand-mark {
  flex: none;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  font-size: 15px;
  font-weight: 800;
  color: var(--app-header-text, #fff);
  background: var(--app-header-btn-bg, rgba(255, 255, 255, 0.12));
  border: 1px solid var(--app-header-btn-border, rgba(255, 255, 255, 0.25));
}

.app-title {
  font-family: var(--app-font-display, inherit);
  font-size: 17px;
  font-weight: var(--app-title-weight, 700);
  letter-spacing: 2px;
  text-transform: var(--app-title-transform, none);
  color: var(--app-title-color, var(--app-header-text));
  -webkit-text-fill-color: var(--app-title-fill, currentColor);
  background: var(--app-title-background, none);
  -webkit-background-clip: text;
  background-clip: text;
  text-shadow: var(--app-title-shadow, none);
  white-space: nowrap;
}

.header-crumbs {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 4px;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
}

.crumb {
  color: var(--app-header-soft, rgba(255, 255, 255, 0.7));
  overflow: hidden;
  text-overflow: ellipsis;
}

.crumb.link { cursor: pointer; }
.crumb.link:hover { color: var(--app-header-text, #fff); }
.crumb.current { color: var(--app-header-text, #fff); font-weight: 600; }
.crumb-sep { flex: none; font-size: 12px; color: var(--app-header-soft, rgba(255, 255, 255, 0.5)); opacity: 0.7; }

.header-right {
  position: relative;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 12px 0 4px;
  border-radius: 999px;
  font-size: 13px;
  background: var(--app-header-btn-bg, rgba(255, 255, 255, 0.12));
  border: 1px solid var(--app-header-btn-border, rgba(255, 255, 255, 0.18));
}

.user-avatar {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
  color: var(--app-header-text, #fff);
  background: var(--app-header-btn-hover-bg, rgba(255, 255, 255, 0.22));
}

.user-name { color: var(--app-header-text, #fff); font-weight: 600; }

.user-role {
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  color: var(--app-header-text, #fff);
  border: 1px solid var(--app-header-btn-border, rgba(255, 255, 255, 0.3));
}

.logout-btn {
  width: 34px;
  min-height: 34px !important;
  height: 34px;
  padding: 0 !important;
  color: var(--app-header-text, #fff) !important;
  background: var(--app-header-btn-bg, rgba(255, 255, 255, 0.12)) !important;
  border: 1px solid var(--app-header-btn-border, rgba(255, 255, 255, 0.25)) !important;
}

.logout-btn:hover {
  color: var(--app-header-text, #fff) !important;
  background: var(--app-header-btn-hover-bg, rgba(255, 255, 255, 0.22)) !important;
  border-color: var(--app-header-btn-hover-border, rgba(255, 255, 255, 0.4)) !important;
}

/* ---------- 主体布局 ---------- */
.body-layout { height: calc(100vh - var(--app-header-height, 56px)); }

/* ---------- 侧边栏 ---------- */
.app-aside {
  position: relative;
  width: var(--app-shell-aside-width, 232px);
  flex: 0 0 var(--app-shell-aside-width, 232px);
  background-color: var(--app-sidebar-bg, #fff);
  background-image: var(--app-sidebar-tint, none);
  border-right: 1px solid var(--app-sidebar-border, #ececf0);
  padding: 12px 12px 14px;
  overflow-y: auto;
  transition: background-color 0.3s ease, border-color 0.3s ease;
}

.app-menu {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  border-right: none;
  background: transparent;
}

.menu-caption {
  padding: 4px 12px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--app-text-secondary, #94a3b8);
  opacity: 0.85;
}

/* 设置固定吸附在侧栏底部；上方任务与插件数量变化时不影响它的位置。 */
.app-menu :deep(.settings-menu-item) {
  margin-top: auto !important;
  border-top: 1px solid var(--app-sidebar-border, #ececf0);
  border-radius: 0 0 var(--app-menu-radius, 8px) var(--app-menu-radius, 8px);
}

.app-menu :deep(.el-menu-item),
.app-menu :deep(.el-sub-menu__title) {
  position: relative;
  height: 40px;
  line-height: 40px;
  margin: 2px 0;
  padding: 0 12px !important;
  border-radius: var(--app-menu-radius, 8px);
  font-size: 14px;
  color: var(--app-menu-text, #4b5563);
  user-select: none;
  -webkit-user-select: none;
  transition: background 0.2s ease, color 0.2s ease;
}

.app-menu :deep(.el-menu-item:hover),
.app-menu :deep(.el-sub-menu__title:hover) {
  background: var(--app-menu-hover-bg, var(--app-hover-bg, #f5f7fa));
  color: var(--app-menu-active-color, var(--el-color-primary));
}

.app-menu :deep(.el-menu-item.is-active) {
  background: var(--app-menu-active-bg, var(--app-hover-bg, #f5f7fa));
  color: var(--app-menu-active-color, var(--el-color-primary));
  font-weight: 600;
  box-shadow: none;
}

/* 选中项左侧指示条（::before 留给终端绿主题的 > 光标） */
.app-menu :deep(.el-menu-item.is-active)::after {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--app-menu-marker, var(--el-color-primary));
}

.app-menu :deep(.el-menu-item .el-icon),
.app-menu :deep(.el-sub-menu__title .el-icon) { font-size: 17px; margin-right: 10px; }
.app-menu :deep(.el-menu-item.is-active .el-icon) { color: var(--app-menu-marker, var(--el-color-primary)); }

.app-menu :deep(.el-sub-menu .el-menu) { background: transparent; }
.app-menu :deep(.el-sub-menu__icon-arrow) { right: 12px; }
.app-menu :deep(.el-sub-menu.is-opened > .el-sub-menu__title) { font-weight: 600; }

.app-menu :deep(.el-menu-item-group__title) {
  padding: 8px 12px 2px 39px !important;
  font-size: 11px;
  line-height: 1.4;
  letter-spacing: 0.12em;
  color: var(--app-text-secondary, #94a3b8);
  opacity: 0.8;
}

.app-menu :deep(.el-sub-menu .el-menu-item) {
  height: 34px;
  line-height: 34px;
  margin: 1px 0;
  padding-left: 39px !important;
  font-size: 13px;
}

.app-menu :deep(.el-sub-menu .el-menu-item.is-active)::after { top: 8px; bottom: 8px; }

.group-title { margin-right: 8px; }

.group-badge {
  margin-right: 22px;
  margin-left: auto;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 16px;
  color: var(--app-text-secondary, #5f6774);
  border: 1px solid var(--app-border, #e8eaef);
}

/* ---------- 主内容区：干净画布，环境光由全局层渲染 ---------- */
.app-main {
  position: relative;
  min-width: 0;
  min-height: 0;
  background: var(--app-bg, #f5f7fa);
  padding: 0;
  overflow-y: auto;
  transition: background 0.3s ease;
}

.app-main > * { animation: app-view-in 0.3s cubic-bezier(0.22, 0.61, 0.36, 1) backwards; }

@keyframes app-view-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 960px) {
  .header-crumbs { display: none; }
}

@media (max-width: 768px) {
  .header-left { flex: 0 0 auto; border-right: none; padding: 0 0 0 4px; }
}
</style>
