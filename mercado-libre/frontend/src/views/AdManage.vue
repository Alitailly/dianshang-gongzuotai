<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useDataRange } from '../composables/useDataRange'
import { appState } from '../store'
import type { AdManageItem, AdManageListResult, AdManageSummary, AdOp } from '../types'

const result = ref<AdManageListResult>({ items: [], total: 0, page: 1, page_size: 50 })
const summary = ref<AdManageSummary | null>(null)
const loading = ref(false)
const listLoading = ref(false)

const keyword = ref('')
const statusTab = ref('') // ''=全部 active=投放中 hold=暂停
const onlyAttention = ref(false)
const sortBy = ref('ad_cost')
const order = ref<'asc' | 'desc'>('desc')
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
type Fmt = 'title' | 'status' | 'level' | 'money' | 'int' | 'pct' | 'bool' | 'suggestion' | 'lastop' | 'actions' | 'plain'
interface ColDef { prop: string; label: string; width?: number; sortable?: boolean | 'custom'; fmt?: Fmt }
interface GroupDef { key: string; label: string; cols: ColDef[] }

const groups: GroupDef[] = [
  {
    key: 'info', label: '商品',
    cols: [
      { prop: 'title', label: '商品', width: 240, fmt: 'title' },
      { prop: 'store', label: '店铺', width: 75, fmt: 'plain' },
      { prop: 'status', label: '投放状态', width: 95, fmt: 'status', sortable: 'custom' },
      { prop: 'current_level', label: '等级', width: 85, fmt: 'level' },
      { prop: 'price', label: '价格', width: 85, fmt: 'money', sortable: 'custom' },
    ],
  },
  {
    key: 'campaign', label: '投放信息',
    cols: [
      { prop: 'campaign_id', label: 'Campaign', width: 105, fmt: 'plain' },
      { prop: 'ad_group_id', label: 'AdGroup', width: 105, fmt: 'plain' },
      { prop: 'buy_box_winner', label: 'BuyBox', width: 78, fmt: 'bool' },
      { prop: 'deferred_stock', label: '缺货', width: 68, fmt: 'bool' },
      { prop: 'has_discount', label: '带折扣', width: 68, fmt: 'bool' },
      { prop: 'image_quality', label: '主图质量', width: 110, fmt: 'plain' },
      { prop: 'logistic_type', label: '物流类型', width: 100, fmt: 'plain' },
    ],
  },
  {
    key: 'effect', label: '效果',
    cols: [
      { prop: 'ad_impressions', label: '曝光', width: 85, fmt: 'int', sortable: 'custom' },
      { prop: 'ad_clicks', label: '点击', width: 75, fmt: 'int', sortable: 'custom' },
      { prop: 'ad_ctr', label: 'CTR%', width: 75, fmt: 'pct', sortable: 'custom' },
      { prop: 'ad_cost', label: '广告花费', width: 95, fmt: 'money', sortable: 'custom' },
      { prop: 'ad_sales', label: '广告销售额', width: 105, fmt: 'money', sortable: 'custom' },
      { prop: 'ad_roas', label: 'ROAS', width: 80, fmt: 'money', sortable: 'custom' },
      { prop: 'ad_acos', label: 'ACOS%', width: 80, fmt: 'pct', sortable: 'custom' },
      { prop: 'breakeven_roas', label: '保本ROAS', width: 95, fmt: 'money' },
    ],
  },
  {
    key: 'decision', label: '决策',
    cols: [
      { prop: 'suggestion', label: '建议', width: 190, fmt: 'suggestion' },
      { prop: 'last_op', label: '最近操作', width: 170, fmt: 'lastop' },
      { prop: 'actions', label: '操作', width: 120, fmt: 'actions' },
    ],
  },
]

// 显隐列 + 组折叠（折叠后该组只显示代表列）
const visibleGroups = reactive<Record<string, boolean>>({
  info: true, campaign: true, effect: true, decision: true,
})
const collapsedGroups = reactive<Record<string, boolean>>({
  info: false, campaign: false, effect: false, decision: false,
})
const FOLDED_FIELD: Record<string, string> = {
  info: 'title', campaign: 'buy_box_winner', effect: 'ad_roas', decision: 'suggestion',
}
function toggleGroup(key: string) {
  collapsedGroups[key] = !collapsedGroups[key]
}
function foldedValue(g: GroupDef, row: any) {
  const prop = FOLDED_FIELD[g.key]
  if (prop === 'suggestion') return suggestionOf(row)?.text ?? '正常'
  if (prop === 'buy_box_winner') return row.buy_box_winner ? '有' : '无'
  const v = row[prop]
  return v === null || v === undefined || v === '' ? '-' : String(v)
}

// ===== 决策建议规则（前端渲染；后端 attention 只用于"只看需关注"过滤）=====
type Suggestion = { text: string; type: 'danger' | 'warning' | 'success' | 'info' }
function suggestionOf(r: AdManageItem): Suggestion | null {
  const cost = r.ad_cost || 0
  const roas = r.ad_roas || 0
  const br = r.breakeven_roas || 0
  if (r.deferred_stock) return { text: '缺货，建议暂停', type: 'danger' }
  if (r.status !== 'active') return { text: '已暂停（hold）', type: 'info' }
  if (cost > 0 && br > 0 && roas < br)
    return { text: '亏损投放（ROAS<保本），建议暂停或降价', type: 'danger' }
  if (cost === 0) return { text: '无消耗，检查出价/展示', type: 'warning' }
  if (r.current_level === 'newbie') return { text: '新手期，先观察转化', type: 'warning' }
  if (cost > 0 && br > 0 && roas >= br * 1.5) return { text: '健康投放，可考虑加预算', type: 'success' }
  if (!r.buy_box_winner) return { text: '未获BuyBox（全店普遍，参考）', type: 'info' }
  if (r.image_quality && r.image_quality !== 'good_quality_thumbnail') return { text: '主图质量差，建议优化', type: 'info' }
  return null
}

const OP_LABELS: Record<string, string> = {
  pause: '暂停投放', resume: '恢复投放', change_bid: '调整出价',
  change_budget: '调整预算', optimize: '优化Listing', other: '其他',
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
function fmtTime(iso: string) {
  if (!iso) return '-'
  return iso.replace('T', ' ').slice(0, 16)
}

// ===== 登记操作弹窗 =====
const opDialog = ref(false)
const opForm = reactive<{ store: string; item_id: string; title: string; op_type: string; note: string }>({
  store: '', item_id: '', title: '', op_type: 'pause', note: '',
})
const opSaving = ref(false)

function openOp(row: AdManageItem) {
  opForm.store = row.store
  opForm.item_id = row.item_id
  opForm.title = row.title
  opForm.op_type = 'pause'
  opForm.note = ''
  opDialog.value = true
}

async function saveOp() {
  if (!opForm.note.trim()) {
    ElMessage.warning('请填写备注')
    return
  }
  opSaving.value = true
  try {
    await api.createAdOp({
      store: opForm.store,
      item_id: opForm.item_id,
      op_type: opForm.op_type,
      note: opForm.note.trim(),
    })
    ElMessage.success('已登记操作')
    opDialog.value = false
    loadList()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.detail || '登记失败')
  } finally {
    opSaving.value = false
  }
}

// ===== 操作历史弹窗 =====
const histDialog = ref(false)
const histLoading = ref(false)
const histTitle = ref('')
const histRows = ref<AdOp[]>([])

async function openHist(row: AdManageItem) {
  histTitle.value = row.title
  histDialog.value = true
  histLoading.value = true
  try {
    histRows.value = await api.getAdOps({ item_id: row.item_id })
  } catch {
    histRows.value = []
    ElMessage.error('加载操作历史失败')
  } finally {
    histLoading.value = false
  }
}

// ===== KPI =====
const kpis = computed(() => {
  const d = summary.value
  if (!d) return []
  return [
    { label: '投放中商品', value: String(d.active_count), sub: `共 ${d.total_count} 个有广告活动` },
    { label: '暂停商品', value: String(d.hold_count), sub: 'hold 状态' },
    { label: '广告花费 (BRL)', value: fmtMoney(d.ad_cost), sub: `截至 ${d.ad_finalized_date ?? '-'}` },
    { label: '广告销售额 (BRL)', value: fmtMoney(d.ad_sales), sub: '区间归因' },
    { label: 'ROAS', value: fmtMoney(d.roas), sub: '销售额÷花费' },
    { label: 'ACOS (%)', value: fmtPct(d.acos), sub: '花费÷销售额' },
    { label: 'BuyBox 获得率 (%)', value: fmtPct(d.buy_box_rate), sub: '赢家/投放数' },
    { label: '保本 ROAS', value: fmtMoney(d.avg_breakeven_roas), sub: '商品级均值' },
  ]
})

// ===== 数据加载 =====
async function loadSummary() {
  try {
    const { from, to } = getRange()
    summary.value = await api.getAdManageSummary({
      store: appState.store || undefined,
      date_from: from,
      date_to: to,
    })
  } catch (e) {
    summary.value = null
  }
}

async function loadList() {
  listLoading.value = true
  try {
    const { from, to } = getRange()
    result.value = await api.getAdManageItems({
      store: appState.store || undefined,
      keyword: keyword.value || undefined,
      status: statusTab.value || undefined,
      attention: onlyAttention.value ? '1' : undefined,
      sort_by: sortBy.value,
      order: order.value,
      page: page.value,
      page_size: pageSize.value,
      date_from: from,
      date_to: to,
    })
  } catch (e) {
    ElMessage.error('加载投放列表失败')
  } finally {
    listLoading.value = false
  }
}

function reloadAll() {
  loading.value = true
  Promise.all([loadSummary(), loadList()]).finally(() => {
    loading.value = false
  })
}

function search() {
  page.value = 1
  loadList()
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

watch(() => [appState.store, appState.refreshKey], () => {
  page.value = 1
  reloadAll()
})
onMounted(async () => {
  await loadDataStatus()
  reloadAll()
})
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
          投放状态为实时；效果指标统计至 <b>{{ statsEndDate }}</b>（= 广告定档日 {{ adFinalizedDate }}，次日10:00定档）
        </span>
      </div>
    </el-card>

    <div class="kpi-grid">
      <div v-for="k in kpis" :key="k.label" class="kpi-card">
        <div class="kpi-label">{{ k.label }}</div>
        <div class="kpi-value">{{ k.value }}</div>
        <div class="kpi-sub">{{ k.sub }}</div>
      </div>
    </div>

    <el-card shadow="never">
      <template #header>投放监控</template>
      <div class="toolbar">
        <el-radio-group v-model="statusTab" size="small" @change="search">
          <el-radio-button value="" label="全部"></el-radio-button>
          <el-radio-button value="active" label="投放中"></el-radio-button>
          <el-radio-button value="hold" label="暂停"></el-radio-button>
        </el-radio-group>
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
          placeholder="搜索 标题 / 商品ID"
          clearable
          style="width: 260px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-checkbox v-model="onlyAttention" @change="search">只看需关注</el-checkbox>
        <el-button type="primary" @click="search">查询</el-button>
        <span class="total">共 {{ result.total }} 个有广告活动的商品</span>
      </div>

      <el-table
        :data="result.items"
        border
        stripe
        @sort-change="onSortChange"
        style="width: 100%"
      >
        <template v-for="g in groups" :key="g.key">
          <!-- 折叠态：整组合成一列 -->
          <el-table-column
            v-if="visibleGroups[g.key] && collapsedGroups[g.key]"
            :label="g.label"
            align="center"
            width="130"
            show-overflow-tooltip
          >
            <template #header>
              <span class="group-toggle" @click="toggleGroup(g.key)">{{ g.label }} ▸</span>
            </template>
            <template #default="{ row }">
              <span>{{ foldedValue(g, row) }}</span>
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
                <!-- 商品：缩略图 + 标题链接 -->
                <template v-if="c.fmt === 'title'">
                  <div class="title-cell">
                    <el-image v-if="row.thumbnail" :src="row.thumbnail" fit="cover" class="thumb" />
                    <a v-if="row.permalink" :href="row.permalink" target="_blank" rel="noopener" class="title-link">
                      {{ row.title }}
                    </a>
                    <span v-else>{{ row.title }}</span>
                    <span class="item-id">{{ row.item_id }}</span>
                  </div>
                </template>
                <!-- 投放状态 -->
                <el-tag v-else-if="c.fmt === 'status'" :type="row.status === 'active' ? 'success' : 'info'" size="small">
                  {{ row.status === 'active' ? '投放中' : '暂停' }}
                </el-tag>
                <!-- 等级 -->
                <el-tag v-else-if="c.fmt === 'level'" :type="row.current_level === 'green' ? 'success' : 'warning'" size="small">
                  {{ row.current_level === 'green' ? '健康' : '新手' }}
                </el-tag>
                <!-- 布尔 -->
                <span v-else-if="c.fmt === 'bool'" :class="row[c.prop] ? 'bool-yes' : 'bool-no'">
                  {{ row[c.prop] ? '✓' : '✗' }}
                </span>
                <!-- 建议 -->
                <template v-else-if="c.fmt === 'suggestion'">
                  <el-tag v-if="suggestionOf(row)" :type="suggestionOf(row)!.type" size="small" effect="light" class="sug-tag">
                    {{ suggestionOf(row)!.text }}
                  </el-tag>
                  <span v-else class="ok-text">正常</span>
                </template>
                <!-- 最近操作 -->
                <template v-else-if="c.fmt === 'lastop'">
                  <template v-if="row.last_op">
                    <span class="op-label">{{ OP_LABELS[row.last_op.op_type] ?? row.last_op.op_type }}</span>
                    <span class="op-note">{{ row.last_op.note }}</span>
                    <span class="op-time">{{ fmtTime(row.last_op.created_at) }}</span>
                  </template>
                  <span v-else class="op-empty">—</span>
                </template>
                <!-- 操作按钮 -->
                <template v-else-if="c.fmt === 'actions'">
                  <el-button size="small" type="primary" plain @click="openOp(row)">登记</el-button>
                  <el-button size="small" @click="openHist(row)">历史</el-button>
                </template>
                <!-- 数值 -->
                <span v-else-if="c.fmt === 'money'">{{ fmtMoney(row[c.prop]) }}</span>
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
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="loadList"
          @size-change="search"
        />
      </div>
    </el-card>

    <!-- 登记操作弹窗 -->
    <el-dialog v-model="opDialog" title="登记投放操作" width="480px">
      <div class="op-info">
        <div class="op-title">{{ opForm.title }}</div>
        <div class="op-id">{{ opForm.item_id }}</div>
      </div>
      <el-form label-width="90px">
        <el-form-item label="操作类型">
          <el-select v-model="opForm.op_type" style="width: 100%">
            <el-option v-for="(label, val) in OP_LABELS" :key="val" :label="label" :value="val" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="opForm.note"
            type="textarea"
            :rows="3"
            placeholder="例如：ROAS 低于保本，去后台暂停 3 天观察"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="opDialog = false">取消</el-button>
        <el-button type="primary" :loading="opSaving" @click="saveOp">保存</el-button>
      </template>
    </el-dialog>

    <!-- 操作历史弹窗 -->
    <el-dialog v-model="histDialog" title="操作历史" width="620px">
      <div class="op-info">
        <div class="op-title">{{ histTitle }}</div>
      </div>
      <el-table :data="histRows" border size="small" v-loading="histLoading">
        <el-table-column prop="created_at" label="时间" width="150">
          <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column prop="op_label" label="类型" width="110" />
        <el-table-column prop="note" label="备注" show-overflow-tooltip />
      </el-table>
      <template #footer>
        <el-button @click="histDialog = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script lang="ts">
export default { name: 'AdManage' }
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
.total {
  color: #909399;
  font-size: 13px;
  margin-left: auto;
}
.col-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}
@media (max-width: 1700px) {
  .kpi-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
@media (max-width: 900px) {
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
  color: #909399;
  font-size: 12px;
}
.row {
  margin-bottom: 16px;
}
.pager {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
.group-toggle {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.group-toggle:hover {
  color: #409eff;
}
.title-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.thumb {
  width: 34px;
  height: 34px;
  border-radius: 4px;
  margin-bottom: 2px;
}
.title-link {
  color: #303133;
  text-decoration: none;
  font-weight: 500;
}
.title-link:hover {
  color: #409eff;
}
.item-id {
  color: #909399;
  font-size: 12px;
}
.bool-yes {
  color: #67c23a;
  font-weight: 600;
}
.bool-no {
  color: #c0c4cc;
}
.sug-tag {
  white-space: normal;
  height: auto;
  line-height: 1.3;
  padding: 3px 6px;
}
.ok-text {
  color: #909399;
}
.op-label {
  color: #303133;
  font-weight: 600;
  margin-right: 4px;
}
.op-note {
  color: #606266;
  margin-right: 4px;
}
.op-time {
  color: #909399;
  font-size: 12px;
}
.op-empty {
  color: #c0c4cc;
}
.op-info {
  margin-bottom: 14px;
}
.op-title {
  font-weight: 600;
  color: #303133;
}
.op-id {
  color: #909399;
  font-size: 12px;
  margin-top: 2px;
}
</style>
