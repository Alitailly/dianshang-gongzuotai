/**
 * 询盘任务状态就绪判断（多实例）
 *
 * 说明：
 * - 入口全局锁定已移除；不同电脑/账号可并行执行各自询盘任务。
 * - 同一 bot 进程内部仍保留串行保护（由 bot 端控制）。
 * - 这里只提供“任务状态是否已就绪”的辅助判断，供快捷跳转等场景使用。
 */
import { computed } from 'vue'
import { useBotInstances } from './useBotInstances.js'
import { usePorts } from './usePorts.js'

export function useTaskLock() {
  const { ready } = useBotInstances()
  const { ready: portsReady } = usePorts()

  const taskLockReady = computed(() => ready.value || portsReady.value)

  return { taskLockReady }
}
