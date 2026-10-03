import { createRouter, createWebHashHistory } from 'vue-router'
import Overview from '../views/Overview.vue'
import Products from '../views/Products.vue'
import Ads from '../views/Ads.vue'
import AdManage from '../views/AdManage.vue'
import AdAssistant from '../views/AdAssistant.vue'
import MessageWorkbench from '../views/MessageWorkbench.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/overview', component: Overview, meta: { title: '经营总览' } },
    { path: '/products', component: Products, meta: { title: '商品分析' } },
    { path: '/ads', component: Ads, meta: { title: '广告流量' } },
    { path: '/ad-manage', component: AdManage, meta: { title: '广告投放' } },
    { path: '/ai-ad', component: AdAssistant, meta: { title: '广告助手' } },
    { path: '/messages', component: MessageWorkbench, meta: { title: '消息工作台' } },
  ],
})

export default router
