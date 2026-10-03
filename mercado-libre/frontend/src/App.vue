<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { api } from './api'
import { appState, bumpRefresh } from './store'
import type { StoreInfo } from './types'

const route = useRoute()
const embedded = new URLSearchParams(window.location.search).get('embed') === '1'
if (embedded) document.documentElement.classList.add('ml-embed')
const stores = ref<StoreInfo[]>([])
const syncing = ref(false)
const syncMsg = ref('')

// 实时巴西时间 + 广告定档截止日（巴西 10:00 前=前天，之后=昨天）
const brTime = ref('')
const cnTime = ref('')
const brHour = ref(0)
const brToday = ref('') // MM-DD
const adFinalizedDate = ref('') // MM-DD：最新已定档的广告日期
let clockTimer: number | undefined

function fmtIn(tz: string) {
  return new Date().toLocaleString('zh-CN', {
    timeZone: tz,
    hour12: false,
    hourCycle: 'h23',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function tick() {
  const now = new Date()
  brTime.value = fmtIn('America/Sao_Paulo')
  cnTime.value = fmtIn('Asia/Shanghai')
  // 巴西本地墙钟（巴西固定 UTC-3，2019 年起无夏令时）
  const br = new Date(now.getTime() - 3 * 3600 * 1000)
  brHour.value = br.getUTCHours()
  brToday.value = `${pad2(br.getUTCMonth() + 1)}-${pad2(br.getUTCDate())}`
  // 广告定档截止日：10:00 前 → 前天；10:00 后（含）→ 昨天
  const daysBack = brHour.value < 10 ? 2 : 1
  const fin = new Date(br.getTime() - daysBack * 86400000)
  adFinalizedDate.value = `${pad2(fin.getUTCMonth() + 1)}-${pad2(fin.getUTCDate())}`
}

const menuItems = [
  { path: '/overview', title: '经营总览' },
  { path: '/products', title: '商品分析' },
  { path: '/ads', title: '广告流量' },
  { path: '/ad-manage', title: '广告投放' },
  { path: '/ai-ad', title: '广告助手' },
  { path: '/messages', title: '消息工作台' },
]

onMounted(async () => {
  tick()
  clockTimer = window.setInterval(tick, 1000)
  try {
    stores.value = await api.getStores()
  } catch (e) {
    console.error(e)
  }
})

onBeforeUnmount(() => {
  if (clockTimer) window.clearInterval(clockTimer)
})

async function doSync() {
  syncing.value = true
  syncMsg.value = '同步中，请稍候…'
  try {
    await api.sync()
    const timer = setInterval(async () => {
      const s = await api.syncStatus()
      if (!s.running) {
        clearInterval(timer)
        syncing.value = false
        syncMsg.value = s.error ? '同步失败：' + s.error : '同步完成'
        bumpRefresh()
      }
    }, 3000)
  } catch (e) {
    syncing.value = false
    syncMsg.value = '同步请求失败'
  }
}
</script>

<template>
  <el-container class="layout" :class="{ embedded }">
    <el-aside v-if="!embedded" width="200px" class="aside">
      <div class="logo">美客多数据看板</div>
      <el-menu :default-active="route.path" router class="menu">
        <el-menu-item v-for="m in menuItems" :key="m.path" :index="m.path">
          <span>{{ m.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="header-left">
          <el-select v-model="appState.store" placeholder="全店铺" style="width: 200px">
            <el-option label="全店铺" value="" />
            <el-option
              v-for="s in stores"
              :key="s.name"
              :label="`${s.display_name} (${s.site_id})`"
              :value="s.display_name"
            />
          </el-select>
          <span class="currency">币种：巴西雷亚尔 (BRL)</span>
        </div>
        <div class="header-right">
          <span v-if="syncMsg" class="sync-msg">{{ syncMsg }}</span>
          <el-tooltip
            :content="
              brHour >= 10
                ? `巴西 ${brToday} 已过 10:00，昨日（${adFinalizedDate}）广告已定档`
                : `巴西 ${brToday} 未到 10:00，昨日广告未定档，最新定档为 ${adFinalizedDate}；巴西 10:00 = 北京 21:00（夏令时 22:00）`
            "
            placement="bottom"
          >
            <span class="br-clock">
              <span class="br-label">巴西</span>
              <b>{{ brTime }}</b>
              <span class="ad-state" :class="brHour >= 10 ? 'ok' : 'warn'">
                {{ brHour >= 10 ? '广告已定档至 ' + adFinalizedDate : '广告仅定档至 ' + adFinalizedDate }}
              </span>
              <span class="cn">北京 {{ cnTime }}</span>
            </span>
          </el-tooltip>
          <el-button type="primary" :loading="syncing" @click="doSync">
            同步数据
          </el-button>
        </div>
      </el-header>

      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100vh;
}
.layout.embedded {
  height: 100%;
  min-height: 100%;
}
.layout.embedded .header {
  height: 52px;
  padding: 0 16px;
}
.aside {
  background: #1f2d3d;
  color: #fff;
}
.logo {
  height: 60px;
  line-height: 60px;
  text-align: center;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
}
.menu {
  border-right: none;
  background: #1f2d3d;
}
.menu :deep(.el-menu-item) {
  color: #cfd8e3;
}
.menu :deep(.el-menu-item.is-active) {
  background: #409eff;
  color: #fff;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #e4e7ed;
  background: #fff;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}
.currency {
  color: #606266;
  font-size: 14px;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.sync-msg {
  color: #909399;
  font-size: 13px;
}
.br-clock {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #303133;
  background: #f0f2f5;
  padding: 5px 12px;
  border-radius: 4px;
  cursor: help;
  white-space: nowrap;
}
.br-clock .br-label {
  color: #409eff;
  font-weight: 600;
}
.br-clock b {
  font-variant-numeric: tabular-nums;
}
.br-clock .cn {
  color: #909399;
  font-size: 12px;
}
.ad-state {
  font-size: 12px;
  font-weight: 600;
}
.ad-state.ok {
  color: #67c23a;
}
.ad-state.warn {
  color: #e6a23c;
}
.main {
  background: #f0f2f5;
}
</style>

<style>
html.ml-embed,
html.ml-embed body,
html.ml-embed #app {
  height: 100%;
  margin: 0;
  background: #f0f2f5;
}
</style>
