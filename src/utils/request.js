import { ElMessage } from 'element-plus'
import 'element-plus/es/components/message/style/css'

/**
 * 统一请求封装
 * 401 处理:登录已过期或账号被禁用 → 清除本地登录态并跳转登录页
 * (登录接口本身除外,401 属于正常登录失败流程)
 * 网络异常(fetch 抛错):统一 ElMessage 提示,避免各组件静默失败
 * (HTTP 错误响应不在此提示——由调用方根据 res.json().error 展示具体原因,避免重复弹窗)
 */
export async function request(url, options = {}) {
  // silentNetworkError: 后台轮询调用置 true,避免服务不可达时每轮弹出一次网络错误
  // timeoutMs: 客户端请求超时,防止个别接口长时间无响应导致按钮/表格一直处于加载态
  const { silentNetworkError = false, timeoutMs = 90000, signal: externalSignal, ...fetchOptions } = options
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  if (externalSignal && externalSignal.aborted) controller.abort()
  if (externalSignal && typeof externalSignal.addEventListener === 'function' && !externalSignal.aborted) {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  let res
  try {
    res = await fetch(url, { ...fetchOptions, signal: controller.signal })
  } catch {
    // 超时和网络不可达原先共用一句文案：像 /api/ebooks、候选轮询这类 90s 超时的场景，
    // 提示「请检查服务是否运行」会把用户引向错误方向。
    const msg = timedOut ? `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）` : '网络异常，请检查服务是否运行'
    if (!silentNetworkError) ElMessage.error(msg)
    throw new Error(msg)
  } finally {
    clearTimeout(timer)
    if (externalSignal && typeof externalSignal.removeEventListener === 'function') externalSignal.removeEventListener('abort', onExternalAbort)
  }
  if (res.status === 401 && !String(url).includes('/api/login')) {
    logoutAndRedirect()
  }
  return res
}

/**
 * 统一认证头
 * 没有 token 时返回空对象：原先会拼出 `Bearer null` 这种非法头发出去，
 * 除了让服务端日志出现无意义的鉴权失败，没有任何好处。
 */
export function authHeaders() {
  const token = localStorage.getItem('token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * 清除本地登录态并跳转登录页(登录页内调用时不重复跳转)
 */
export function logoutAndRedirect() {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  if (!window.location.pathname.includes('/login')) {
    window.location.href = '/login'
  }
}
