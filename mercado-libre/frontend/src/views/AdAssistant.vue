<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useDataRange } from '../composables/useDataRange'
import { appState } from '../store'
import type { AdAnalysisResult } from '../types'

const {
  rangeMode,
  customRange,
  adFinalizedDate,
  statsEndDate,
  getRange,
  disabledDate,
  loadDataStatus,
} = useDataRange()

const analyzing = ref(false)
const result = ref<AdAnalysisResult | null>(null)
const stores = ref<{ name: string; display_name: string; site_id: string }[]>([])
// 页面内店铺选择：默认跟随全局，可独立切换（不复写全局，避免影响其他页面）
const storeFilter = ref(appState.store)

async function analyze() {
  analyzing.value = true
  result.value = null
  try {
    const { from, to } = getRange()
    result.value = await api.analyzeAds({
      store: storeFilter.value || undefined,
      date_from: from,
      date_to: to,
    })
    if (result.value.ok === false) {
      ElMessage.warning(result.value.message || '分析未成功')
    }
  } catch (e) {
    ElMessage.error('分析请求失败，请重试')
    result.value = { ok: false, reason: 'llm_error', message: '分析请求失败，请重试' }
  } finally {
    analyzing.value = false
  }
}

function storeLabel() {
  if (!storeFilter.value) return '全店铺'
  const s = stores.value.find((x) => x.display_name === storeFilter.value)
  return s ? `${s.display_name} (${s.site_id})` : storeFilter.value
}

function fmtNum(n: number | undefined | null) {
  if (n == null) return '-'
  if (Math.abs(n) >= 1000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  return String(Math.round(n * 100) / 100)
}

onMounted(async () => {
  await loadDataStatus()
  try {
    stores.value = await api.getStores()
  } catch {
    /* 店铺列表拉取失败不阻塞分析 */
  }
})
</script>

<template>
  <div>
    <el-card shadow="never" class="row">
      <div class="toolbar">
        <el-select v-model="storeFilter" placeholder="全店铺" style="width: 170px" size="small">
          <el-option label="全店铺" value="" />
          <el-option
            v-for="s in stores"
            :key="s.name"
            :label="`${s.display_name} (${s.site_id})`"
            :value="s.display_name"
          />
        </el-select>
        <el-radio-group v-model="rangeMode" size="small">
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
        />
        <el-button type="primary" :loading="analyzing" @click="analyze">
          {{ analyzing ? '分析中…' : '开始分析' }}
        </el-button>
        <span class="hint">
          基于定时快照数据（统计至 <b>{{ statsEndDate }}</b> = 广告定档日 {{ adFinalizedDate }}，次日 10:00 定档）
        </span>
      </div>
    </el-card>

    <template v-if="result">
      <!-- 失败提示 -->
      <el-alert
        v-if="result.ok === false"
        :title="result.message || '分析未成功'"
        type="warning"
        show-icon
        :closable="false"
        class="row"
      >
        <div class="alert-actions">
          <el-button size="small" @click="analyze">重试</el-button>
        </div>
      </el-alert>

      <!-- 成功结果 -->
      <template v-else>
        <el-card shadow="never" class="row">
          <template #header>
            <div class="card-head">
              <span>分析结果</span>
              <span class="range">
                分析店铺：<b>{{ storeLabel() }}</b>
                ｜数据时间范围：{{ result.date_from }} ~ {{ result.date_to }}
                ｜广告定档截止 <b>{{ result.ad_finalized_date }}</b>
              </span>
            </div>
          </template>
          <p class="overview">{{ result.overview }}</p>

          <!-- 精确汇总行（数字来自后端聚合，非 LLM 生成） -->
          <div v-if="result.summary" class="metric-row">
            <div class="metric-chip">
              <span class="m-label">广告花费</span>
              <span class="m-value" :class="{ bad: result.summary!.cost > 0 && result.summary!.sales === 0 }">{{ fmtNum(result.summary.cost) }}</span>
            </div>
            <div class="metric-chip">
              <span class="m-label">广告销售额</span>
              <span class="m-value">{{ fmtNum(result.summary.sales) }}</span>
            </div>
            <div class="metric-chip">
              <span class="m-label">ROAS</span>
              <span class="m-value" :class="{ bad: result.summary.roas < 2 }">{{ result.summary.roas }}</span>
            </div>
            <div class="metric-chip">
              <span class="m-label">ACOS</span>
              <span class="m-value" :class="{ bad: result.summary.acos > 40 }">{{ result.summary.acos }}%</span>
            </div>
            <div class="metric-chip">
              <span class="m-label">CTR</span>
              <span class="m-value">{{ result.summary.ctr }}%</span>
            </div>
            <div class="metric-chip">
              <span class="m-label">CPC</span>
              <span class="m-value">{{ result.summary.cpc }}</span>
            </div>
            <div class="metric-chip">
              <span class="m-label">投放商品</span>
              <span class="m-value">{{ result.summary.ad_items }}</span>
            </div>
          </div>
        </el-card>

        <!-- 指标 + 建议成对 -->
        <div class="block-list">
          <el-card
            v-for="(b, i) in result.blocks || []"
            :key="i"
            shadow="never"
            class="block-card"
          >
            <div class="block-head">
              <span class="block-idx">{{ i + 1 }}</span>
              <span class="block-metric">{{ b.metric }}</span>
              <span class="block-value">{{ b.value }}</span>
            </div>
            <div class="block-advice">{{ b.advice }}</div>
          </el-card>
        </div>
      </template>
    </template>

    <el-empty v-else description="选择时间范围后点击「开始分析」，AI 将基于广告聚合数据给出优化建议" />
  </div>
</template>

<script lang="ts">
export default { name: 'AdAssistant' }
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.hint {
  color: #909399;
  font-size: 12px;
}
.hint b {
  color: #409eff;
}
.row {
  margin-bottom: 16px;
}
.alert-actions {
  margin-top: 12px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.range {
  color: #909399;
  font-size: 13px;
}
.range b {
  color: #409eff;
}
.overview {
  font-size: 15px;
  line-height: 1.8;
  color: #303133;
  margin: 4px 0 16px;
  white-space: pre-wrap;
}
.metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.metric-chip {
  flex: 1 1 110px;
  min-width: 110px;
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.m-label {
  font-size: 12px;
  color: #909399;
}
.m-value {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
  font-variant-numeric: tabular-nums;
}
.m-value.bad {
  color: #f56c6c;
}
.block-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 16px;
}
.block-card {
  border-left: 3px solid #409eff;
}
.block-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.block-idx {
  flex: none;
  width: 22px;
  height: 22px;
  line-height: 22px;
  text-align: center;
  border-radius: 50%;
  background: #409eff;
  color: #fff;
  font-size: 13px;
}
.block-metric {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}
.block-value {
  font-size: 16px;
  font-weight: 600;
  color: #409eff;
  font-variant-numeric: tabular-nums;
}
.block-advice {
  font-size: 13px;
  line-height: 1.7;
  color: #606266;
  white-space: pre-wrap;
}
</style>
