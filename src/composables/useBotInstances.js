/**
 * Bot 实例/询盘账号管理（设置 + 状态）
 * 用于设置页、询盘页账号选择、端口悬浮窗等。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { request, authHeaders } from '../utils/request.js'

const instances = ref([])
const statuses = ref([])
const loading = ref(false)
const ready = ref(false)
// 任务状态是否已成功加载过一次。未就绪时禁止把账号当作空闲,避免状态未知就提交
const statusReady = ref(false)
let timer = null
let subscribers = 0

async function loadInstances(force = false) {
  loading.value = true
  try {
    const res = await request('/api/settings/instances', {
      headers: authHeaders(),
      silentNetworkError: true,
      timeoutMs: 15000
    })
    if (res.ok) {
      const data = await res.json()
      instances.value = data.instances || []
      ready.value = true
    }
  } catch {
    // 忽略瞬时错误
  } finally {
    loading.value = false
  }
  if (force) await loadStatus()
}

async function loadStatus() {
  try {
    const res = await request('/api/bot/instances/status', {
      headers: authHeaders(),
      silentNetworkError: true,
      timeoutMs: 15000
    })
    if (res.ok) {
      const data = await res.json()
      statuses.value = data.instances || []
      statusReady.value = true
    }
  } catch {
    // 忽略，保留旧状态
  }
}

const isStatusReady = computed(() => statusReady.value)

const accounts = computed(() => instances.value.map(x => x.account).filter(Boolean))
const accountOptions = computed(() => instances.value.filter(x => x.account).map(x => ({
  account: x.account,
  ip: x.ip,
  id: x.id,
  name: x.name || x.ip
})))

function getStatusByAccount(account) {
  const acc = String(account || '').trim()
  return statuses.value.find(s => String(s.account || '').trim() === acc) || null
}

function getStatusById(id) {
  return statuses.value.find(s => s.id === id) || null
}

function isAccountBusy(account) {
  const acc = String(account || '').trim()
  // 未选择账号时不作为忙碌处理(按钮由 !selectedAccount 控制)
  if (!acc) return false
  const st = getStatusByAccount(acc)
  // 状态尚未加载/该账号暂无状态:保守返回 true,避免"提交后才发现账号被占用"
  if (!st) return true
  return st.task_running === true
}

function onVisible() {
  // 浏览器从后台/闲置切回前台时立即刷新一次，避免定时器被节流导致账号/任务状态滞后
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') loadStatus()
}

function startPolling() {
  subscribers += 1
  if (!timer) {
    loadInstances()
    loadStatus()
    timer = setInterval(() => {
      loadStatus()
    }, 5000)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  }
}

function stopPolling() {
  subscribers = Math.max(0, subscribers - 1)
  if (subscribers === 0 && timer) {
    clearInterval(timer)
    timer = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}

export function useBotInstances() {
  onMounted(startPolling)
  onUnmounted(stopPolling)
  return {
    instances,
    statuses,
    accounts,
    accountOptions,
    loading,
    ready,
    isStatusReady,
    loadInstances,
    loadStatus,
    getStatusByAccount,
    getStatusById,
    isAccountBusy,
    refresh: () => { loadInstances(true) }
  }
}

export function useBotInstancesOnce() {
  // 单次加载不启动轮询，适合设置页等低频场景
  return {
    instances,
    statuses,
    accounts,
    accountOptions,
    loading,
    ready,
    isStatusReady,
    loadInstances,
    loadStatus,
    getStatusByAccount,
    getStatusById,
    isAccountBusy,
    refresh: () => { loadInstances(true) }
  }
}
