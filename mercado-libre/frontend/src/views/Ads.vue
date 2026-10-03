<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, watch } from 'vue'
import * as echarts from 'echarts'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useDataRange } from '../composables/useDataRange'
import { appState } from '../store'
import type { AdsItemListResult, AdsSummary, AdsTrendDay } from '../types'

const summary = ref<AdsSummary | null>(null)
const trend = ref<AdsTrendDay[]>([])
const list = ref<AdsItemListResult>({ items: [], total: 0, page: 1, page_size: 50 })
const loading = ref(false)
const listLoading = ref(false)
const chartEl = ref<HTMLElement | null>(null)
let chart: echarts.ECharts | null = null

const {
  rangeMode,
  customRange,
  maxDate,
  adFinalizedDate,
  statsEndDate,
  getRange,
  disabledDate,
  loadDataStatus,
} = useDataRange()

const keyword = ref('')
const sortBy = ref('ad_cost')
const order = ref<'asc' | 'desc'>('desc')
const page = ref(1)
const pageSize = ref(50)

// 趋势图模式：金额（花费/销售额）｜流量（曝光/点击）
const chartMode = ref<'money' | 'traffic'>('money')

// 各轴数值范围（预设 + 自定义），用于锁定纵轴观察细节
type RangeMode = 'auto' | '0-1000' | '0-5000' | '100-1000' | 'custom'
const RANGE_PRESETS: { value: RangeMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: '0-1000', label: '0-1000' },
  { value: '0-5000', label: '0-5000' },
  { value: '100-1000', label: '100-1000' },
  { value: 'custom', label: '自定义' },
]
const axisRanges = reactive<Record<string, { mode: RangeMode; min?: number; max?: number }>>({
  cost: { mode: 'auto' }, // 广告花费轴
  sales: { mode: 'auto' }, // 广告销售额轴
  imp: { mode: 'auto' }, // 曝光轴
  click: { mode: 'auto' }, // 点击轴
})

function effectiveRange(key: string): { min?: number; max?: number } {
  const r = axisRanges[key]
  if (r.mode === 'custom') return { min: r.min, max: r.max }
  if (r.mode === 'auto') return {}
  const [min, max] = r.mode.split('-').map(Number)
  return { min, max }
}

function resetRanges() {
  axisRanges.cost = { mode: 'auto' }
  axisRanges.sales = { mode: 'auto' }
  axisRanges.imp = { mode: 'auto' }
  axisRanges.click = { mode: 'auto' }
  if (chart) {
    chart.clear()
    renderChart()
  }
}

/** 金额轴自适应单位：<1万 显示原始金额，1万-100万 用 k，≥100万 用 M */
function moneyAxis(v: number) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e4) return Math.round(v / 1e3) + 'k'
  return Math.round(v).toLocaleString()
}

/** 次数轴自适应单位：<1万 原值，≥1万 用 万 */
function countAxis(v: number) {
  if (v >= 1e4) {
    const w = v / 1e4
    return (Number.isInteger(w) ? String(w) : w.toFixed(1).replace(/\.0$/, '')) + '万'
  }
  return String(Math.round(v))
}

function fmtTooltip(v: number) {
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

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
  const d = summary.value
  if (!d) return []
  const c = d.current
  const p = d.prev
  const y = d.yesterday
  const mk = (label: string, value: string, sub: string, cur: number, prev: number | null | undefined) => ({
    label, value, sub, ...pctChange(cur, prev ?? 0),
  })
  return [
    mk('广告花费 (BRL)', fmt(c.cost), y ? `昨日 ${fmt(y.cost)}` : '昨日 未定档', c.cost, p?.cost),
    mk('广告销售额 (BRL)', fmt(c.sales), y ? `昨日 ${fmt(y.sales)}` : '昨日 未定档', c.sales, p?.sales),
    mk('曝光 (次)', fmt(c.impressions, 0), y ? `昨日 ${fmt(y.impressions, 0)}` : '昨日 未定档', c.impressions, p?.impressions),
    mk('点击 (次)', fmt(c.clicks, 0), y ? `昨日 ${fmt(y.clicks, 0)}` : '昨日 未定档', c.clicks, p?.clicks),
    mk('ROAS', fmt(c.roas), y ? `昨日 ${fmt(y.roas)}` : '昨日 未定档', c.roas, p?.roas),
    mk('ACOS (%)', fmt(c.acos, 1), y ? `昨日 ${fmt(y.acos, 1)}` : '昨日 未定档', c.acos, p?.acos),
  ]
}

async function load() {
  loading.value = true
  try {
    const { from, to } = getRange()
    const params = { store: appState.store || undefined, date_from: from, date_to: to }
    const [s, t] = await Promise.all([api.getAdsSummary(params), api.getAdsTrend(params)])
    summary.value = s
    trend.value = t
    renderChart()
  } finally {
    loading.value = false
  }
}

function renderChart() {
  if (!chartEl.value) return
  if (!chart) chart = echarts.init(chartEl.value)
  const days = trend.value
  const x = days.map((d) => d.date.slice(5))

  if (chartMode.value === 'money') {
    // 金额视图：双轴 —— 花费(左轴) / 销售额(右轴) 各自按量程缩放，避免小数值被压扁
    const rc = effectiveRange('cost')
    const rs = effectiveRange('sales')
    chart.setOption({
      tooltip: { trigger: 'axis', valueFormatter: fmtTooltip },
      grid: { left: 70, right: 85, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: x },
      yAxis: [
        {
          type: 'value',
          name: '广告花费(BRL)',
          min: rc.min,
          max: rc.max,
          axisLabel: { formatter: moneyAxis },
        },
        {
          type: 'value',
          name: '广告销售额(BRL)',
          min: rs.min,
          max: rs.max,
          axisLabel: { formatter: moneyAxis },
        },
      ],
      series: [
        { name: '广告花费', type: 'line', yAxisIndex: 0, smooth: true, data: days.map((d) => d.cost), itemStyle: { color: '#e6a23c' } },
        { name: '广告销售额', type: 'line', yAxisIndex: 1, smooth: true, data: days.map((d) => d.sales), itemStyle: { color: '#67c23a' } },
      ],
    })
  } else {
    // 流量视图：曝光(左轴, 万单位) + 点击(右轴, 原值)，两轴范围均可选
    const ri = effectiveRange('imp')
    const rc2 = effectiveRange('click')
    chart.setOption({
      tooltip: { trigger: 'axis', valueFormatter: fmtTooltip },
      grid: { left: 70, right: 85, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: x },
      yAxis: [
        {
          type: 'value',
          name: '曝光(次)',
          min: ri.min,
          max: ri.max,
          axisLabel: { formatter: countAxis },
        },
        {
          type: 'value',
          name: '点击(次)',
          min: rc2.min,
          max: rc2.max,
          axisLabel: { formatter: (v: number) => Math.round(v).toLocaleString() },
        },
      ],
      series: [
        { name: '曝光', type: 'bar', yAxisIndex: 0, data: days.map((d) => d.impressions), itemStyle: { color: '#409eff' }, barMaxWidth: 24 },
        { name: '点击', type: 'line', yAxisIndex: 1, smooth: true, data: days.map((d) => d.clicks), itemStyle: { color: '#f56c6c' } },
      ],
    })
  }
}

async function loadList() {
  listLoading.value = true
  try {
    const { from, to } = getRange()
    list.value = await api.getAdsItems({
      store: appState.store || undefined,
      keyword: keyword.value || undefined,
      sort_by: sortBy.value,
      order: order.value,
      page: page.value,
      page_size: pageSize.value,
      date_from: from,
      date_to: to,
    })
  } catch (e) {
    ElMessage.error('加载广告列表失败')
  } finally {
    listLoading.value = false
  }
}

function onSortChange({ prop, order: o }: { prop: string; order: string | null }) {
  if (!o) {
    sortBy.value = 'ad_cost'
    order.value = 'desc'
  } else {
    sortBy.value = prop
    order.value = o === 'ascending' ? 'asc' : 'desc'
  }
  page.value = 1
  loadList()
}

function search() {
  page.value = 1
  loadList()
}

function reloadAll() {
  load()
  loadList()
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
          订单与广告同窗，巴西 0:00–10:00 定档日退回前天）
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
      <template #header>
        <div class="card-head">
          <span>广告趋势</span>
          <div class="head-right">
            <el-radio-group v-model="chartMode" size="small" @change="renderChart">
              <el-radio-button value="money" label="金额"></el-radio-button>
              <el-radio-button value="traffic" label="曝光/点击"></el-radio-button>
            </el-radio-group>
            <el-button size="small" @click="resetRanges">重置</el-button>
          </div>
        </div>
      </template>

      <!-- 图例 + 每轴数值范围（同一条） -->
      <div class="axis-bar">
        <template v-if="chartMode === 'money'">
          <span class="legend-dot" style="background: #e6a23c"></span>
          <span class="legend-label">广告花费</span>
          <span class="legend-dot" style="background: #67c23a"></span>
          <span class="legend-label">广告销售额</span>
          <span class="axis-item">花费轴</span>
          <el-select v-model="axisRanges.cost.mode" size="small" style="width: 110px" @change="renderChart">
            <el-option v-for="p in RANGE_PRESETS" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
          <template v-if="axisRanges.cost.mode === 'custom'">
            <el-input-number v-model="axisRanges.cost.min" :controls="false" size="small" placeholder="min" style="width: 100px" @change="renderChart" />
            <span class="tilde">~</span>
            <el-input-number v-model="axisRanges.cost.max" :controls="false" size="small" placeholder="max" style="width: 100px" @change="renderChart" />
          </template>
          <span class="axis-item">销售额轴</span>
          <el-select v-model="axisRanges.sales.mode" size="small" style="width: 110px" @change="renderChart">
            <el-option v-for="p in RANGE_PRESETS" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
          <template v-if="axisRanges.sales.mode === 'custom'">
            <el-input-number v-model="axisRanges.sales.min" :controls="false" size="small" placeholder="min" style="width: 100px" @change="renderChart" />
            <span class="tilde">~</span>
            <el-input-number v-model="axisRanges.sales.max" :controls="false" size="small" placeholder="max" style="width: 100px" @change="renderChart" />
          </template>
        </template>
        <template v-else>
          <span class="legend-dot" style="background: #409eff"></span>
          <span class="legend-label">曝光</span>
          <span class="legend-dot" style="background: #f56c6c"></span>
          <span class="legend-label">点击</span>
          <span class="axis-item">曝光轴</span>
          <el-select v-model="axisRanges.imp.mode" size="small" style="width: 110px" @change="renderChart">
            <el-option v-for="p in RANGE_PRESETS" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
          <template v-if="axisRanges.imp.mode === 'custom'">
            <el-input-number v-model="axisRanges.imp.min" :controls="false" size="small" placeholder="min" style="width: 100px" @change="renderChart" />
            <span class="tilde">~</span>
            <el-input-number v-model="axisRanges.imp.max" :controls="false" size="small" placeholder="max" style="width: 100px" @change="renderChart" />
          </template>
          <span class="axis-item">点击轴</span>
          <el-select v-model="axisRanges.click.mode" size="small" style="width: 110px" @change="renderChart">
            <el-option v-for="p in RANGE_PRESETS" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
          <template v-if="axisRanges.click.mode === 'custom'">
            <el-input-number v-model="axisRanges.click.min" :controls="false" size="small" placeholder="min" style="width: 100px" @change="renderChart" />
            <span class="tilde">~</span>
            <el-input-number v-model="axisRanges.click.max" :controls="false" size="small" placeholder="max" style="width: 100px" @change="renderChart" />
          </template>
        </template>
      </div>

      <div ref="chartEl" class="chart"></div>
    </el-card>

    <el-card shadow="never">
      <template #header>商品广告列表</template>
      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="搜索 标题 / SKU / 商品ID"
          clearable
          style="width: 300px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-button type="primary" @click="search">查询</el-button>
        <span class="total">共 {{ list.total }} 个投放商品（区间内有广告数据）</span>
      </div>
      <el-table :data="list.items" border v-loading="listLoading" @sort-change="onSortChange" style="width: 100%">
        <el-table-column prop="title" label="商品" min-width="260" show-overflow-tooltip />
        <el-table-column prop="store" label="店铺" width="90" />
        <el-table-column prop="ad_cost" label="广告花费" width="110" sortable="custom">
          <template #default="{ row }">{{ fmt(row.ad_cost) }}</template>
        </el-table-column>
        <el-table-column prop="ad_clicks" label="点击" width="90" sortable="custom">
          <template #default="{ row }">{{ fmt(row.ad_clicks, 0) }}</template>
        </el-table-column>
        <el-table-column prop="ad_impressions" label="曝光" width="110" sortable="custom">
          <template #default="{ row }">{{ fmt(row.ad_impressions, 0) }}</template>
        </el-table-column>
        <el-table-column prop="ad_ctr" label="CTR(%)" width="90" sortable="custom">
          <template #default="{ row }">{{ fmt(row.ad_ctr) }}</template>
        </el-table-column>
        <el-table-column prop="ad_sales" label="广告销售额" width="120" sortable="custom">
          <template #default="{ row }">{{ fmt(row.ad_sales) }}</template>
        </el-table-column>
        <el-table-column prop="ad_roas" label="ROAS" width="90" sortable="custom">
          <template #default="{ row }">{{ fmt(row.ad_roas) }}</template>
        </el-table-column>
        <el-table-column prop="ad_acos" label="ACOS(%)" width="100" sortable="custom">
          <template #default="{ row }">{{ fmt(row.ad_acos) }}</template>
        </el-table-column>
      </el-table>
      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="list.total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="loadList"
          @size-change="search"
        />
      </div>
    </el-card>
  </div>
</template>

<script lang="ts">
export default { name: 'Ads' }
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.range-hint {
  color: #909399;
  font-size: 12px;
}
.range-hint b {
  color: #409eff;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.head-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.axis-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 8px 12px;
  background: #fafbfc;
  border: 1px solid #ebeef5;
  border-radius: 4px;
}
.axis-item {
  color: #606266;
  font-size: 13px;
  margin-right: 2px;
}
.tilde {
  color: #909399;
}
.legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-left: 6px;
}
.legend-label {
  color: #606266;
  font-size: 13px;
  margin-right: 4px;
}
.total {
  color: #909399;
  font-size: 13px;
  margin-left: auto;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}
@media (max-width: 1400px) {
  .kpi-grid {
    grid-template-columns: repeat(3, 1fr);
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
.row {
  margin-bottom: 16px;
}
.chart {
  height: 320px;
}
.pager {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
