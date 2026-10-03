/** server/lib/runtimeLogger.js — 网站运行日志缓冲(内存 ring buffer)
 * 用于日志中心默认展示“网站运行时的日志”，不依赖 bot 日志文件。
 */
const MAX_LOGS = 3000
let seq = 0
const logs = []

export function logRuntime(level = 'info', source = 'system', message = '') {
  const item = {
    id: ++seq,
    ts: Date.now(),
    level,
    source,
    message: String(message)
  }
  logs.push(item)
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS)
  }
  return item
}

export function getRuntimeLogs({ offset = 0, limit = 300, source = '' } = {}) {
  const from = Number(offset) || 0
  const count = Math.min(Math.max(Number(limit) || 300, 1), 1000)
  let list = logs.filter((l) => l.id > from)
  if (source) {
    list = list.filter((l) => l.source === source)
  }
  list = list.slice(-count)
  return {
    logs: list,
    lastId: list.length ? list[list.length - 1].id : from
  }
}
