<script setup lang="ts">
import { ref, reactive, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useDataRange } from '../composables/useDataRange'
import { appState } from '../store'
import type { ItemListResult } from '../types'

const result = ref<ItemListResult>({ items: [], total: 0, page: 1, page_size: 50 })
const loading = ref(false)

const keyword = ref('')
const hasAds = ref('')
const sortBy = ref('')
const order = ref<'asc' | 'desc'>('asc')
const page = ref(1)
const pageSize = ref(50)

const {
  rangeMode,
  customRange,
  adFinalizedDate,
  statsEndDate,
  getRange,
  disabledDate,
  loadDataStatus,
} = useDataRange()

// ===== 列定义（分组）=====
type Fmt = 'money' | 'int' | 'pct' | 'tag' | 'plain'
interface ColDef { prop: string; label: string; width?: number; sortable?: boolean | 'custom'; fmt?: Fmt }
interface GroupDef { key: string; label: string; cols: ColDef[] }

const groups: GroupDef[] = [
  {
    key: 'info', label: '商品信息',
    cols: [
      { prop: 'title', label: '商品', width: 250, fmt: 'plain' },
      { prop: 'store', label: '店铺', width: 75, fmt: 'plain' },
      { prop: 'seller_sku', label: 'SKU', width: 125, fmt: 'plain', sortable: 'custom' },
      { prop: 'item_id', label: '商品ID', width: 125, fmt: 'plain' },
      { prop: 'variation_count', label: '变体', width: 70, fmt: 'int' },
      { prop: 'price', label: '现价', width: 85, fmt: 'money', sortable: 'custom' },
      { prop: 'original_price', label: '原价', width: 85, fmt: 'money', sortable: 'custom' },
      { prop: 'commission_rate', label: '佣金率%', width: 85, fmt: 'comm_pct', sortable: 'custom' },
      { prop: 'unit_commission', label: '佣金/件', width: 90, fmt: 'comm_money', sortable: 'custom' },
      { prop: 'platform_shipping', label: '平台运费', width: 90, fmt: 'ship' },
      { prop: 'unit_income', label: '实际收入/件', width: 105, fmt: 'avg', sortable: 'custom' },
    ],
  },
  {
    key: 'stock', label: '库存',
    cols: [
      { prop: 'sold_quantity', label: '已售', width: 75, fmt: 'int', sortable: 'custom' },
      { prop: 'available_quantity', label: '可售库存', width: 90, fmt: 'int', sortable: 'custom' },
    ],
  },
  {
    key: 'traffic', label: '流量·自然vs付费',
    cols: [
      { prop: 'total_visits', label: '全流量总访问', width: 105, fmt: 'int' },
      { prop: 'natural_visits', label: '自然访问(估算)', width: 110, fmt: 'int' },
      { prop: 'ad_clicks', label: '广告点击', width: 90, fmt: 'int', sortable: 'custom' },
      { prop: 'ad_impressions', label: '曝光', width: 90, fmt: 'int', sortable: 'custom' },
      { prop: 'natural_visits_rate', label: '自然访问占比(访问)', width: 135, fmt: 'pct' },
      { prop: 'ad_click_rate', label: '广告点击占比(访问)', width: 135, fmt: 'pct' },
      { prop: 'natural_sales', label: '自然销售额', width: 105, fmt: 'money', sortable: 'custom' },
      { prop: 'ad_sales', label: '广告销售额', width: 105, fmt: 'money', sortable: 'custom' },
      { prop: 'natural_sales_rate', label: '自然销售额占比(销售)', width: 150, fmt: 'pct', sortable: 'custom' },
      { prop: 'ad_share', label: '广告销售额占比(销售)', width: 150, fmt: 'pct', sortable: 'custom' },
    ],
  },
  {
    key: 'ads', label: '广告·加投决策',
    cols: [
      { prop: 'ad_cost', label: '广告花费', width: 95, fmt: 'money', sortable: 'custom' },
      { prop: 'ad_sales', label: '广告收入', width: 95, fmt: 'money', sortable: 'custom' },
      { prop: 'ad_roas', label: 'ROAS', width: 80, fmt: 'money', sortable: 'custom' },
      { prop: 'breakeven_roas', label: '保本ROAS', width: 95, fmt: 'money', sortable: 'custom' },
      { prop: 'ad_acos', label: 'ACOS%', width: 80, fmt: 'pct', sortable: 'custom' },
      { prop: 'ad_clicks', label: '点击', width: 75, fmt: 'int', sortable: 'custom' },
      { prop: 'ad_impressions', label: '曝光', width: 90, fmt: 'int', sortable: 'custom' },
      { prop: 'ad_ctr', label: 'CTR%', width: 75, fmt: 'pct', sortable: 'custom' },
    ],
  },
  {
    key: 'quality', label: '质量',
    cols: [
      { prop: 'performance_score', label: '体验分', width: 80, fmt: 'int', sortable: 'custom' },
      { prop: 'has_ads', label: '广告', width: 70, fmt: 'tag' },
    ],
  },
]

// 显隐列（按组）
const visibleGroups = reactive<Record<string, boolean>>({
  info: true,
  stock: true,
  traffic: true,
  ads: true,
  quality: true,
})

// 组折叠：折叠后该组只显示一个代表列
const collapsedGroups = reactive<Record<string, boolean>>({
  info: false,
  stock: false,
  traffic: false,
  ads: false,
  quality: false,
})
const FOLDED_FIELD: Record<string, string> = {
  info: 'price',
  stock: 'available_quantity',
  traffic: 'ad_clicks',
  ads: 'ad_roas',
  quality: 'performance_score',
}
function toggleGroup(key: string) {
  collapsedGroups[key] = !collapsedGroups[key]
}
function foldedValue(g: GroupDef, row: any) {
  const prop = FOLDED_FIELD[g.key]
  const col = g.cols.find((c) => c.prop === prop)
  if (!col) return '-'
  const v = row[prop]
  if (col.fmt === 'pct') return fmtPct(v)
  if (col.fmt === 'int') return fmtInt(v)
  return fmtMoney(v)
}

// ===== 格式化 =====
function fmtMoney(v: any) {
  return v === null || v === undefined || v === '' ? '-' : Number(v).toFixed(2)
}
function fmtInt(v: any) {
  return v === null || v === undefined || v === '' ? '-' : Number(v).toLocaleString()
}
function fmtPct(v: any) {
  return v === null || v === undefined || v === '' ? '-' : Number(v).toFixed(1) + '%'
}

// 状态感知显示：佣金率/佣金件/平台运费/实际收入 均来自官方 API（与上架/卖出无关），
// 有值显示数值，无值显示「-」（个别商品官方无报价）
function statusVal(row: any, prop: string, fmt: 'money' | 'pct') {
  const v = row[prop]
  if (v === null || v === undefined || v === '') return { text: '-', cls: 'cell-gray' }
  return { text: fmt === 'pct' ? fmtPct(v) : fmtMoney(v), cls: '' }
}

// 平台运费显示：按承担方区分（buyer=买家承担 / meli=平台包邮 / seller=卖家承担）
function shipText(row: any) {
  const p = row.shipping_payer
  if (p === 'buyer') return '买家付'
  if (p === 'meli') return '包邮'
  if (p === 'seller') return row.platform_shipping != null ? fmtMoney(row.platform_shipping) : '-'
  return row.platform_shipping != null ? fmtMoney(row.platform_shipping) : '-'
}
function shipTooltip(row: any) {
  const p = row.shipping_payer
  if (p === 'buyer') return '买家承担运费，卖家无需付'
  if (p === 'meli') return '平台强制包邮，卖家无需付'
  if (p === 'seller') return '卖家承担运费（平台成本价）'
  return '平台运费'
}

// ===== 条件高亮 =====
function cellClass({ row, column }: any) {
  const p = column.property
  const v = row[p]
  if (p === 'ad_roas' && (row.ad_roas || 0) > 0 && row.breakeven_roas > 0 && row.ad_roas < row.breakeven_roas) return 'cell-red'
  if (p === 'natural_sales_rate') {
    if (v < 30) return 'cell-red'
    if (v >= 60) return 'cell-green'
  }
  if (p === 'ad_share' && row.ad_click_rate > 30 && v < 30) return 'cell-red'
  if (p === 'performance_score' && v < 70) return 'cell-orange'
  if (p === 'available_quantity' && v === 0) return 'cell-gray'
  return ''
}

// ===== 数据加载 =====
async function load() {
  loading.value = true
  try {
    const { from, to } = getRange()
    result.value = await api.getItems({
      store: appState.store || undefined,
      keyword: keyword.value || undefined,
      has_ads: hasAds.value || undefined,
      sort_by: sortBy.value || 'item_id',
      order: order.value || 'asc',
      page: page.value,
      page_size: pageSize.value,
      date_from: from,
      date_to: to,
    })
  } catch (e) {
    ElMessage.error('加载商品失败，请确认后端已启动并已同步数据')
  } finally {
    loading.value = false
  }
}

function onSortChange({ prop, order: o }: { prop: string; order: string | null }) {
  if (!o) {
    sortBy.value = ''
    order.value = 'asc'
  } else {
    sortBy.value = prop
    order.value = o === 'ascending' ? 'asc' : 'desc'
  }
  page.value = 1
  load()
}

function search() {
  page.value = 1
  load()
}

function exportCsv() {
  const { from, to } = getRange()
  window.open(api.exportUrl({
    store: appState.store || '',
    keyword: keyword.value,
    has_ads: hasAds.value,
    sort_by: sortBy.value || 'item_id',
    order: order.value || 'asc',
    date_from: from,
    date_to: to,
  }))
}

watch(() => [appState.store, appState.refreshKey], async () => {
  page.value = 1
  await loadDataStatus()
  load()
})
onMounted(async () => {
  await loadDataStatus()
  load()
})
</script>

<template>
  <div v-loading="loading">
    <el-card shadow="never">
      <div class="toolbar">
        <el-radio-group v-model="rangeMode" size="small" @change="search">
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
          @change="search"
        />
        <span class="range-hint">
          统计至 <b>{{ statsEndDate }}</b>（= 广告定档日 {{ adFinalizedDate }}，次日10:00定档；
          订单与广告同窗，结算/自然销售额/占比才准确）；全流量总访问统计至昨日；
          自然访问=全流量总访问−广告点击（估算）
        </span>
      </div>

      <div class="toolbar">
        <el-popover trigger="click" width="220">
          <template #reference>
            <el-button size="small">☰ 列显示</el-button>
          </template>
          <div class="col-options">
            <el-checkbox v-for="g in groups" :key="g.key" v-model="visibleGroups[g.key]">{{ g.label }}</el-checkbox>
          </div>
        </el-popover>
        <el-input
          v-model="keyword"
          placeholder="搜索 标题 / SKU / 商品ID"
          clearable
          style="width: 280px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="hasAds" placeholder="广告状态" clearable style="width: 130px" @change="search">
          <el-option label="有广告" value="1" />
          <el-option label="无广告" value="0" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="exportCsv">导出 CSV</el-button>
        <span class="total">共 {{ result.total }} 个商品</span>
      </div>

      <el-table
        :data="result.items"
        border
        stripe
        :cell-class-name="cellClass"
        @sort-change="onSortChange"
        style="width: 100%"
      >
        <el-table-column type="expand" width="40">
          <template #default="{ row }">
            <div class="variation-box">
              <el-table :data="row.variations" border size="small">
                <el-table-column prop="seller_sku" label="SKU" width="130" />
                <el-table-column prop="gtin" label="GTIN" width="150" />
                <el-table-column label="价格(BRL)" width="110">
                  <template #default="{ row: v }">{{ fmtMoney(v.price) }}</template>
                </el-table-column>
                <el-table-column prop="available_quantity" label="可售库存" width="100" />
              </el-table>
            </div>
          </template>
        </el-table-column>

        <template v-for="g in groups" :key="g.key">
          <!-- 折叠态：整组合成一列（显示代表值） -->
          <el-table-column
            v-if="visibleGroups[g.key] && collapsedGroups[g.key]"
            :label="g.label"
            align="center"
            width="120"
            show-overflow-tooltip
          >
            <template #header>
              <span class="group-toggle" @click="toggleGroup(g.key)">{{ g.label }} ▸</span>
            </template>
            <template #default="{ row }">
              <span :class="g.key === 'profit' && row[FOLDED_FIELD[g.key]] < 0 ? 'cell-red' : ''">{{ foldedValue(g, row) }}</span>
            </template>
          </el-table-column>

          <!-- 展开态：显示组内所有子列 -->
          <el-table-column v-else-if="visibleGroups[g.key]" :label="g.label" align="center">
            <template #header>
              <span class="group-toggle" @click="toggleGroup(g.key)">{{ g.label }} ▾</span>
            </template>
            <el-table-column
              v-for="c in g.cols"
              :key="c.prop"
              :prop="c.prop"
              :label="c.label"
              :width="c.width"
              :sortable="(c.sortable as any)"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                <el-tag v-if="c.fmt === 'tag'" :type="row.has_ads ? 'success' : 'info'" size="small">
                  {{ row.has_ads ? '是' : '否' }}
                </el-tag>
                <span v-else-if="c.fmt === 'money'">{{ fmtMoney(row[c.prop]) }}</span>
                <span v-else-if="c.fmt === 'ship'">
                  <el-tooltip :content="shipTooltip(row)" placement="top">
                    <span :class="row.shipping_payer === 'seller' ? '' : 'cell-green'">
                      {{ shipText(row) }}
                    </span>
                  </el-tooltip>
                </span>
                <span v-else-if="c.fmt === 'comm_pct' || c.fmt === 'comm_money' || c.fmt === 'avg'">
                  <span :class="statusVal(row, c.prop, c.fmt === 'comm_pct' ? 'pct' : 'money').cls">
                    {{ statusVal(row, c.prop, c.fmt === 'comm_pct' ? 'pct' : 'money').text }}
                  </span>
                </span>
                <span v-else-if="c.fmt === 'int'">{{ fmtInt(row[c.prop]) }}</span>
                <span v-else-if="c.fmt === 'pct'">{{ fmtPct(row[c.prop]) }}</span>
                <span v-else>{{ row[c.prop] ?? '-' }}</span>
              </template>
            </el-table-column>
          </el-table-column>
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="result.total"
          :page-sizes="[20, 50, 100, 200]"
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="load"
          @size-change="search"
        />
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.total {
  color: #909399;
  font-size: 13px;
  margin-left: auto;
}
.range-hint {
  color: #909399;
  font-size: 12px;
}
.range-hint b {
  color: #409eff;
}
.col-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.variation-box {
  padding: 8px 0 8px 48px;
}
.pager {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
:deep(.cell-red) {
  background: #fef0f0;
  color: #f56c6c;
  font-weight: 600;
}
:deep(.cell-yellow) {
  background: #fdf6ec;
  color: #e6a23c;
}
:deep(.cell-orange) {
  background: #fdf0e8;
  color: #e6a23c;
}
:deep(.cell-gray) {
  background: #f4f4f5;
  color: #909399;
}
:deep(.cell-green) {
  color: #67c23a;
  font-weight: 600;
}
.group-toggle {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.group-toggle:hover {
  color: #409eff;
}
</style>
