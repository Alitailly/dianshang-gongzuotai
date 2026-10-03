/**
 * 全局测试模式（dry_run）共享状态。
 * 机器人状态页和首轮询盘页共用同一个变量，避免“首轮测试模式”和“全局测试模式”不一致。
 */
import { ref } from 'vue'
import { request, authHeaders } from '../utils/request.js'

const dryRun = ref(false)
const loaded = ref(false)
let loadingPromise = null

async function loadDryRun(force = false) {
  if (!force && loaded.value) return dryRun.value
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    try {
      const res = await request('/api/bot/status', { headers: authHeaders() })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          dryRun.value = data.dry_run === true
          loaded.value = true
        }
      }
    } catch {
      // 忽略瞬时错误
    } finally {
      loadingPromise = null
    }
    return dryRun.value
  })()
  return loadingPromise
}

async function setDryRun(val) {
  const res = await request('/api/bot/set-dry-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ dry_run: !!val })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  dryRun.value = !!val
  loaded.value = true
  return data
}

export function useDryRun() {
  return { dryRun, loaded, loadDryRun, setDryRun }
}
