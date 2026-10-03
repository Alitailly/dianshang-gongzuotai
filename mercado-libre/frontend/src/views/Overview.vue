<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as echarts from 'echarts'
import { api } from '../api'
import { useDataRange } from '../composables/useDataRange'
import { appState } from '../store'
import type { OverviewResult, RankingResult, TrendDay } from '../types'

const data = ref<OverviewResult | null>(null)
const trend = ref<TrendDay[]>([])
const loading = ref(false)
const chartEl = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null

// 时间范围（含可查截止规则）
const {
  rangeMode,
  customRange,
  adFinalizedDate,
  statsEndDate,
  getRange,
  disabledDate,
  loadDataStatus,
} = useDataRange()

// 排行榜
const rankingType = ref('revenue')
const ranking = ref<RankingResult | null>(null)
const rankingLoading = ref(false)

function fmt(v: any, digits = 2) {
  if (v === null || v === undefined || v === '') return '-'
  const n = Number(v)
  if (Number.isNaN(n)) return v
  return digits >= 0 ? n.toFixed(digits) : String(n)
}

function pctChange(cur: number, prev: number) {
  if (!prev) return { pct: 0, up: true, isNew: cur > 0 }
  const pct = ((cur - prev) / prev) * 100
  return { pct, up: pct >= 0, isNew: false }
}

const kpis = () => {
  const d = data.value
  if (!d) return []
  const mk = (label: string, value: string, sub: string, cur: number, prev: number) => ({
    label, value, sub, ...pctChange(cur, prev),
  })
  return [
    mk('总销售额 (BRL)', fmt(d.total_revenue), `昨日 ${fmt(d.yesterday_revenue)}`, d.total_revenue, d.prev_revenue),
    mk('总销量 (件)', fmt(d.total_sold, 0), `昨日 ${fmt(d.yesterday_sold, 0)}`, d.total_sold, d.prev_sold),
    mk(
      '广告花费 (BRL)',
      fmt(d.total_ad_cost),
      d.yesterday_ad_cost == null ? '昨日 未定档' : `昨日 ${fmt(d.yesterday_ad_cost)}`,
      d.total_ad_cost,
      d.prev_ad_cost,
    ),
    mk('结算金额 (BRL)', fmt(d.total_settlement), `昨日 ${fmt(d.yesterday_settlement)}`, d.total_settlement, d.prev_settlement),
    mk('订单数', fmt(d.total_orders, 0), `昨日 ${fmt(d.yesterday_orders, 0)}`, d.total_orders, d.prev_orders),
    mk('动销率 (%)', `${fmt(d.sold_rate, 1)}%`, `有售 ${d.sold_listings} / 在售 ${d.active_listings}`, d.sold_rate, d.prev_sold_rate),
  ]
}

async function load() {
  loading.value = true
  try {
    const { from, to } = getRange()
    const params = { store: appState.store || undefined, date_from: from, date_to: to }
    const [ov, tr] = await Promise.all([api.getOverview(params), api.getTrend(params)])
    data.value = ov
    trend.value = tr
    renderChart()
  } finally {
    loading.value = false
  }
}

function renderChart() {
  if (!chartEl.value) return
  if (!chart) chart = echarts.init(chartEl.value)
  const days = trend.value
  chart.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['销量', '销售额'], bottom: 0 },
    grid: { left: 60, right: 70, top: 40, bottom: 40 },
    xAxis: { type: 'category', data: days.map((d) => d.date.slice(5)) },
    yAxis: [
      { type: 'value', name: '销量(件)' },
      { type: 'value', name: '销售额(BRL)' },
    ],
    series: [
      { name: '销量', type: 'bar', data: days.map((d) => d.sold), itemStyle: { color: '#409eff' }, barMaxWidth: 24 },
      { name: '销售额', type: 'line', yAxisIndex: 1, smooth: true, data: days.map((d) => d.revenue), itemStyle: { color: '#67c23a' } },
    ],
  })
}

async function loadRanking() {
  rankingLoading.value = true
  try {
    const { from, to } = getRange()
    ranking.value = await api.getRankings({
      type: rankingType.value,
      store: appState.store || undefined,
      date_from: from,
      date_to: to,
      limit: 10,
    })
  } finally {
    rankingLoading.value = false
  }
}

function reloadAll() {
  load()
  loadRanking()
}

watch(() => [appState.store, appState.refreshKey], reloadAll)
onMounted(async () => {
  await loadDataStatus()
  reloadAll()
})
onBeforeUnmount(() => chart?.dispose())
</script>

<template>
  <div v-loading="loading">
    <el-card shadow="never" class="row">
      <div class="toolbar">
        <el-radio-group v-model="rangeMode" size="small" @change="reloadAll">
          <el-radio-button value="7" label="近7天"></el-radio-button>
          <el-radio-button value="15" label="近15天"></el-radio-button>
          <el-radio-button value="30" label="近30天"></el-radio-button>
          <el-radio-button value="60" label="近60天"></el-radio-button>
          <el-radio-button value="90" label="近90天"></el-radio-button>
          <el-radio-button value="custom" label="自定义"></el-radio-button>
        </el-radio-group>
        <el-date-picker
          v-if="rangeMode === 'custom'"
          v-model="customRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          :disabled-date="disabledDate"
          style="width: 260px"
          @change="reloadAll"
        />
        <span class="range-hint">
          统计至 <b>{{ statsEndDate }}</b>（= 广告定档日 {{ adFinalizedDate }}，次日10:00定档；
          {{ statsEndDate }} 之后的实时销量待定档后再纳入，订单与广告同窗以保证结算口径一致）
        </span>
      </div>
    </el-card>

    <div class="kpi-grid">
      <div v-for="k in kpis()" :key="k.label" class="kpi-card">
        <div class="kpi-label">{{ k.label }}</div>
        <div class="kpi-value">{{ k.value }}</div>
        <div class="kpi-sub">
          <span class="sub">{{ k.sub }}</span>
          <span class="trend" :class="k.up ? 'up' : 'down'">
            <template v-if="k.isNew">▲ 新增</template>
            <template v-else-if="k.pct === 0">— 持平</template>
            <template v-else>{{ k.up ? '▲' : '▼' }} {{ Math.abs(k.pct).toFixed(1) }}%</template>
          </span>
        </div>
      </div>
    </div>

    <el-card shadow="never" class="row">
      <template #header>店铺表现</template>
      <div class="store-cards">
        <div v-for="s in data?.by_store ?? []" :key="s.store" class="store-card">
          <div class="store-name">{{ s.store }}</div>
          <div class="store-metrics">
            <div class="metric"><span>订单</span><b>{{ fmt(s.orders, 0) }}</b></div>
            <div class="metric"><span>销售额(BRL)</span><b>{{ fmt(s.revenue) }}</b></div>
            <div class="metric"><span>广告花费(BRL)</span><b>{{ fmt(s.ad_cost) }}</b></div>
          </div>
        </div>
      </div>
      <el-table :data="data?.by_store ?? []" border size="small">
        <el-table-column type="index" label="序号" width="60" />
        <el-table-column prop="store" label="店铺" />
        <el-table-column label="销售额(BRL)">
          <template #default="{ row }">{{ fmt(row.revenue) }}</template>
        </el-table-column>
        <el-table-column prop="orders" label="订单数" />
        <el-table-column label="广告花费(BRL)">
          <template #default="{ row }">{{ fmt(row.ad_cost) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="row">
      <template #header>销量 / 销售额 趋势</template>
      <div ref="chartEl" class="chart"></div>
    </el-card>

    <el-card shadow="never" class="row">
      <template #header>排行榜 TOP10</template>
      <el-tabs v-model="rankingType" @tab-change="loadRanking">
        <el-tab-pane label="销售额" name="revenue" />
        <el-tab-pane label="销量" name="sold_quantity" />
        <el-tab-pane label="广告花费" name="ad_cost" />
        <el-tab-pane label="ROAS" name="ad_roas" />
      </el-tabs>
      <el-table :data="ranking?.items ?? []" v-loading="rankingLoading" border size="small">
        <el-table-column prop="rank" label="排名" width="60" />
        <el-table-column prop="title" label="商品" show-overflow-tooltip />
        <el-table-column prop="store" label="店铺" width="90" />
        <el-table-column label="值" width="130">
          <template #default="{ row }">{{ fmt(row.value) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.range-hint {
  color: #909399;
  font-size: 12px;
}
.range-hint b {
  color: #409eff;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}
@media (max-width: 1400px) {
  .kpi-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
.kpi-card {
  background: #fff;
  border-radius: 6px;
  padding: 14px 18px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}
.kpi-label {
  color: #909399;
  font-size: 13px;
  margin-bottom: 8px;
}
.kpi-value {
  font-size: 24px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.kpi-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}
.kpi-sub .sub {
  color: #909399;
}
.trend.up {
  color: #f56c6c;
}
.trend.down {
  color: #67c23a;
}
.store-cards {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.store-card {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 12px 18px;
  min-width: 220px;
  background: #fafbfc;
}
.store-name {
  font-weight: 600;
  margin-bottom: 10px;
  color: #303133;
}
.store-metrics {
  display: flex;
  gap: 24px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.metric span {
  color: #909399;
  font-size: 12px;
}
.metric b {
  font-size: 18px;
  color: #303133;
}
.row {
  margin-bottom: 16px;
}
.chart {
  height: 320px;
}
</style>
