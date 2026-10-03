import { computed, ref } from 'vue'
import { api } from '../api'
import type { DataStatus } from '../types'

/**
 * 时间范围选择：预设(近7/15/30/60/90天) + 自定义日期区间。
 *
 * 可查规则：
 * - 统计截止日 = min(巴西昨天, 广告定档日)：销量/销售/佣金/物流 是实时的，广告是 T+1
 *   次日 10:00（巴西）定档，两边必须同窗，否则「结算 = 销售额 − 佣金 − 物流 − 广告花费」
 *   这类派生列会拿两个窗口的数字相减相除而算错。
 * - 巴西 0:00–10:00 定档日会退回前天（前天的广告才是最终值），此时统计区间也随之截止前天。
 * - 访客列已停用（ML 访客 API 仅提供按天去重独立访客，无含重复点击总访客口径）。
 */
export function useDataRange() {
  const rangeMode = ref('30')
  const customRange = ref<[string, string] | null>(null)
  const dataStatus = ref<DataStatus | null>(null)

  function fmtDate(d: Date) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  /** 可查截止日（实时数据）= 巴西今天 */
  const maxDate = computed(() => dataStatus.value?.br_today ?? null)
  /** 广告定档截止日（广告只统计到此日） */
  const adFinalizedDate = computed(() => dataStatus.value?.latest_finalized_date ?? null)
  /** 快照最早一天，之前无数据 */
  const minDate = computed(() => dataStatus.value?.earliest_date ?? null)

  function parseDay(s: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
    if (!m) return null
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0)
  }

  /** 统计截止日 = min(巴西昨天, 广告定档日)。广告与订单必须同窗，页面数字才对得上 */
  const statsEndDate = computed(() => {
    const today = parseDay(maxDate.value || fmtDate(new Date())) || new Date()
    today.setDate(today.getDate() - 1) // 巴西昨天
    const yStr = fmtDate(today)
    const cap = adFinalizedDate.value
    return cap && cap < yStr ? cap : yStr
  })

  function getRange(): { from: string; to: string } {
    const to = statsEndDate.value
    if (rangeMode.value === 'custom' && customRange.value) {
      const from = customRange.value[0] > to ? to : customRange.value[0]
      if (customRange.value[1] !== to) customRange.value = [from, to]
      return { from, to }
    }
    // 预设（近N天）= 最近 N 个「完整日」，截止统计截止日（见 statsEndDate）
    const days = Number(rangeMode.value) || 30
    const toD = parseDay(to) || new Date()
    const fromD = new Date(toD)
    fromD.setDate(fromD.getDate() - (days - 1))
    return { from: fmtDate(fromD), to }
  }

  /** 自定义日期选择器：今天之后与快照最早一天之前不可点 */
  function disabledDate(d: Date) {
    const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0)
    const max = maxDate.value ? parseDay(maxDate.value) : null
    const min = minDate.value ? parseDay(minDate.value) : null
    if (max && d0.getTime() > max.getTime()) return true
    if (min && d0.getTime() < min.getTime()) return true
    return false
  }

  async function loadDataStatus() {
    try {
      dataStatus.value = await api.getDataStatus()
      // 若自定义范围落在不可查区间，收敛到可查区间
      if (customRange.value) {
        const { from, to } = getRange()
        customRange.value = [from, to]
      }
    } catch {
      dataStatus.value = null
    }
  }

  return {
    rangeMode,
    customRange,
    dataStatus,
    maxDate,
    adFinalizedDate,
    minDate,
    statsEndDate,
    getRange,
    disabledDate,
    loadDataStatus,
  }
}
