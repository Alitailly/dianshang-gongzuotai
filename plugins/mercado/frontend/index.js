import { LocalPlugin } from '../../../src/plugins/core/PluginBase.js'

const MercadoFrame = () => import('./MercadoFrame.vue')

const pages = [
  { path: 'mercado/overview', name: 'MercadoOverview', title: '经营总览', section: '经营', order: 1, page: '/overview' },
  { path: 'mercado/products', name: 'MercadoProducts', title: '商品分析', section: '经营', order: 2, page: '/products' },
  { path: 'mercado/ads', name: 'MercadoAds', title: '广告流量', section: '广告', order: 3, page: '/ads' },
  { path: 'mercado/ad-manage', name: 'MercadoAdManage', title: '广告投放', section: '广告', order: 4, page: '/ad-manage' },
  { path: 'mercado/ai-ad', name: 'MercadoAdAssistant', title: '广告助手', section: '广告', order: 5, page: '/ai-ad' },
  { path: 'mercado/messages', name: 'MercadoMessages', title: '消息工作台', section: '消息', order: 6, page: '/messages' }
]

export default class MercadoPlugin extends LocalPlugin {
  constructor() {
    super('mercado')
    this.title = '美客多'
    this.version = '1.0.0'
    this.description = '美客多经营看板'
    this.author = 'System'
    this.dependencies = []
  }

  getRoutes() {
    return pages.map((page) => ({
      path: page.path,
      name: page.name,
      component: MercadoFrame,
      meta: {
        plugin: this.name,
        title: page.title,
        icon: 'Shop',
        group: '美客多',
        groupIcon: 'Shop',
        groupBadge: 'ML',
        groupOrder: 40,
        section: page.section,
        sidebarOrder: page.order,
        page: page.page
      }
    }))
  }
}
