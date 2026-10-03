/**
 * 端口状态共享轮询源(2026-08-08)
 * 整个应用只有一个 /api/bot/ports 轮询定时器(3s),
 * PortFloatBall / PortStatusBar / useTaskLock 等组件订阅共享数据,不再各自轮询。
 * 订阅计数:最后一个组件卸载后停止轮询。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { request, authHeaders } from '../utils/request.js'

const POLL_INTERVAL = 3000

// 模块级共享状态(单例)
const ports = ref([])
const botOnline = ref(true)
const stale = ref(false)
const ready = ref(false)
let timer = null
let subscriberCount = 0

const fetchPorts = async () => {
  try {
    const res = await request('/api/bot/ports', {
      headers: authHeaders(),
      silentNetworkError: true,
      timeoutMs: 15000
    })
    if (!res.ok) return
    const data = await res.json()
    if (data.success) {
      ports.value = data.ports || []
      botOnline.value = data.botOnline !== false
      stale.value = !!data.stale
      ready.value = true
    }
  } catch {
    // 瞬时错误忽略,等待下次轮询
  }
}

const onVisible = () => {
  // 浏览器从后台/闲置切回前台时立即刷新一次，避免定时器被节流导致状态滞后
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') fetchPorts()
}

const startPolling = () => {
  subscriberCount++
  if (!timer) {
    fetchPorts()
    timer = setInterval(fetchPorts, POLL_INTERVAL)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  }
}

const stopPolling = () => {
  subscriberCount = Math.max(0, subscriberCount - 1)
  if (subscriberCount === 0 && timer) {
    clearInterval(timer)
    timer = null
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}

export function usePorts() {
  const runningCount = computed(() => ports.value.filter(p => p.status === 'running').length)
  const busyCount = computed(() => ports.value.filter(p => p.busy).length)
  const stuckCount = computed(() => ports.value.filter(p => p.status === 'stuck').length)

  onMounted(startPolling)
  onUnmounted(stopPolling)

  return { ports, botOnline, stale, ready, runningCount, busyCount, stuckCount, refresh: fetchPorts }
}
