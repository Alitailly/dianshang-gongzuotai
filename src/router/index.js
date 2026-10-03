import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/ElementLogin.vue')
  },
  {
    path: '/',
    name: 'Home',
    component: () => import('../views/Home.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        // 2026-08-07:删除仪表盘,默认进入询盘自动化(/tools 由插件动态注册)
        path: '',
        redirect: '/tools'
      },
      {
        // 插件管理已迁移进 SettingsView；旧地址保留重定向，避免书签失效。
        path: 'plugins',
        redirect: { name: 'Settings' }
      },
      {
        // 用户管理已迁移进 SettingsView；旧地址保留重定向，避免书签失效。
        path: 'users',
        redirect: { name: 'Settings' }
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('../views/SettingsView.vue'),
        meta: { requiresAuth: true }
      }
    ]
  },
  // 通配符路由，处理所有未匹配的路由
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    beforeEnter: (to, from, next) => {
      // 重定向到 Home 并让 Home 组件处理动态路由
      next('/')
    }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

/** localStorage 里的 user 可能被写坏（半截写入/手工改过），
 *  JSON.parse 直接抛错会让导航守卫中断，页面卡在原地且没有任何提示。 */
function readStoredUser() {
  try {
    const raw = localStorage.getItem('user')
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')
  if (to.meta.requiresAuth && !token) {
    return next('/login')
  }
  const user = readStoredUser()
  if (to.meta.requiresAdmin && user.role !== 'admin') {
    return next('/')
  }
  next()
})

export default router