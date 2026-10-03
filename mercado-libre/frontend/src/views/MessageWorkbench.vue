<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { appState } from '../store'
import type { MessageHistoryMsg, MessageItem } from '../types'

const loading = ref(false)
const syncing = ref(false)
const items = ref<MessageItem[]>([])
const tagFilter = ref<'pre_sale' | 'post_sale'>('pre_sale')
const statusFilter = ref<'new' | 'draft' | 'sent' | 'skipped' | ''>('')

const drawerOpen = ref(false)
const detail = ref<MessageItem | null>(null)
const history = ref<MessageHistoryMsg[]>([])
const draft = ref('')
const detailLoading = ref(false)
const sending = ref(false)

const TAG_LABEL: Record<string, string> = { pre_sale: '售前', post_sale: '售后' }
const STATUS_LABEL: Record<string, string> = {
  new: '待生成',
  draft: '待审',
  sent: '已发送',
  skipped: '已跳过',
}
const STATUS_TYPE: Record<string, 'warning' | 'primary' | 'success' | 'info'> = {
  new: 'warning',
  draft: 'primary',
  sent: 'success',
  skipped: 'info',
}

// 终态（已发送/已跳过）只读：不能再生成草稿或发送，抽屉只展示问答记录
const isTerminal = computed(
  () => detail.value?.status === 'sent' || detail.value?.status === 'skipped',
)

const histTitle = computed(() => {
  const d = detail.value
  if (!d) return ''
  if (d.tag === 'pre_sale') return d.status === 'sent' ? '客户问题与回复' : '问答记录'
  return '会话历史'
})

function fmtTime(s: string | null) {
  if (!s) return '-'
  return s.replace('T', ' ').slice(0, 16)
}

async function load() {
  loading.value = true
  try {
    const res = await api.getMessages({
      store: appState.store || undefined,
      tag: tagFilter.value,
      status: statusFilter.value || undefined,
    })
    items.value = res.items
  } catch {
    ElMessage.error('加载消息列表失败')
  } finally {
    loading.value = false
  }
}

async function syncNow() {
  syncing.value = true
  try {
    const r = await api.syncMessages(appState.store || undefined)
    const part = [`新增 ${r.new}`]
    if (r.failed) part.push(`失败 ${r.failed}`)
    ElMessage.success(`同步完成：${part.join('，')}`)
    await load()
  } catch {
    ElMessage.error('同步失败，请稍后重试')
  } finally {
    syncing.value = false
  }
}

async function openDetail(row: MessageItem) {
  drawerOpen.value = true
  detailLoading.value = true
  detail.value = row
  draft.value = row.draft || ''
  history.value = []
  try {
    const res = await api.getMessageDetail(row.id)
    if (res.ok && res.item) {
      detail.value = res.item
      draft.value = res.item.draft || ''
      history.value = res.history || []
    } else {
      ElMessage.warning(res.message || '加载详情失败')
    }
  } catch {
    ElMessage.error('加载会话详情失败')
  } finally {
    detailLoading.value = false
  }
}

async function generate() {
  if (!detail.value) return
  try {
    const res = await api.generateDraft(detail.value.id)
    if (res.ok) {
      draft.value = res.draft || ''
      ElMessage.success('草稿已生成，请校验后发送')
    } else {
      ElMessage.warning(res.message || '生成失败')
    }
  } catch {
    ElMessage.error('生成请求失败')
  }
}

async function confirmSend() {
  if (!detail.value) return
  if (!draft.value.trim()) {
    ElMessage.warning('草稿为空，请先生成或填写')
    return
  }
  try {
    await ElMessageBox.confirm(
      '确认将以上内容发送给买家？发送后不可撤回，发送前请仔细校验。',
      '人审确认',
      { confirmButtonText: '确认发送', cancelButtonText: '再想想', type: 'warning' },
    )
  } catch {
    return
  }
  sending.value = true
  try {
    const res = await api.sendMessageReply(detail.value.id, draft.value.trim())
    if (res.ok) {
      ElMessage.success('回复已发送')
      drawerOpen.value = false
      await load()
    } else {
      ElMessage.warning(res.message || '发送失败')
    }
  } catch {
    ElMessage.error('发送请求失败')
  } finally {
    sending.value = false
  }
}

async function doSkip() {
  if (!detail.value) return
  try {
    await ElMessageBox.confirm('标记为「跳过」后此消息不再进入待审队列，确定？', '跳过确认', {
      confirmButtonText: '跳过',
      cancelButtonText: '取消',
      type: 'info',
    })
  } catch {
    return
  }
  const res = await api.skipMessage(detail.value.id)
  if (res.ok) {
    ElMessage.success('已跳过')
    drawerOpen.value = false
    await load()
  } else {
    ElMessage.warning(res.message || '操作失败')
  }
}

function authorName(m: MessageHistoryMsg) {
  return m._author || m.from?.name || (m.from ? `买家 ${m.from.user_id}` : '未知')
}

function buyerName(m: MessageItem) {
  return m.sender_name || (m.sender_id ? `买家 ${m.sender_id}` : '买家')
}

onMounted(load)
watch(() => [appState.store, appState.refreshKey], load)
</script>

<template>
  <div>
    <el-card shadow="never" class="row">
      <div class="toolbar">
        <el-radio-group v-model="tagFilter" size="small" @change="load">
          <el-radio-button value="pre_sale" label="售前"></el-radio-button>
          <el-radio-button value="post_sale" label="售后"></el-radio-button>
        </el-radio-group>
        <el-select v-model="statusFilter" placeholder="状态" clearable style="width: 130px" @change="load">
          <el-option label="待生成" value="new" />
          <el-option label="待审" value="draft" />
          <el-option label="已发送" value="sent" />
          <el-option label="已跳过" value="skipped" />
        </el-select>
        <el-button type="primary" :loading="syncing" @click="syncNow">同步</el-button>
        <el-button @click="load">刷新</el-button>
        <span class="hint">按状态分类查看；草稿需点「生成草稿」，已发送的只读展示问答记录</span>
      </div>
    </el-card>

    <el-card shadow="never">
      <el-table :data="items" border v-loading="loading" @row-click="openDetail" style="width: 100%">
        <el-table-column prop="store" label="店铺" width="90" />
        <el-table-column prop="tag" label="类型" width="80">
          <template #default="{ row }">
            <el-tag :type="row.tag === 'pre_sale' ? 'success' : 'warning'" size="small">
              {{ TAG_LABEL[row.tag] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="买家" width="120">
          <template #default="{ row }">{{ buyerName(row) }}</template>
        </el-table-column>
        <el-table-column prop="message_text" label="消息" min-width="320" show-overflow-tooltip />
        <el-table-column prop="received_at" label="收到时间" width="150">
          <template #default="{ row }">{{ fmtTime(row.received_at) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="STATUS_TYPE[row.status]" size="small">{{ STATUS_LABEL[row.status] }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty
        v-if="!loading && items.length === 0"
        :description="tagFilter === 'post_sale' ? '售后消息需平台开通消息权限后接入，暂无数据' : '暂无售前提问'"
        :image-size="80"
      />
    </el-card>

    <el-drawer v-model="drawerOpen" size="560px" :destroy-on-close="false">
      <template #header>
        <div class="drawer-head">
          <span class="drawer-title">
            {{ detail?.tag === 'pre_sale' ? '提问' : '会话' }} #{{ detail?.id }}（{{
              detail ? TAG_LABEL[detail.tag] : ''
            }}）
          </span>
          <el-tag v-if="detail" :type="STATUS_TYPE[detail.status]" size="small">
            {{ STATUS_LABEL[detail.status] }}
          </el-tag>
        </div>
      </template>

      <div v-loading="detailLoading" class="body">
        <!-- 会话历史：已发送 → 只读的「客户问题 + 回复」 -->
        <div class="hist">
          <div class="hist-title">
            {{ histTitle }}
            <span v-if="!isTerminal" class="hist-sub">（{{ detail?.pack_id }}）</span>
          </div>
          <div v-if="history.length" class="bubbles">
            <div
              v-for="(m, i) in history"
              :key="i"
              class="bubble-row"
              :class="{ mine: m._author === '卖家' }"
            >
              <div class="bubble-meta">{{ authorName(m) }} · {{ fmtTime(m.date_created || '') }}</div>
              <div class="bubble">{{ m.text }}</div>
            </div>
          </div>
          <div v-else class="empty-hist">无历史消息</div>
        </div>

        <!-- 待处理（new/draft）：当前消息 + 草稿区（人审闸门）。终态不显示，只留上面的问答记录 -->
        <template v-if="!isTerminal">
          <div class="cur">
            <div class="cur-title">待回复消息</div>
            <div class="cur-text">{{ detail?.message_text }}</div>
            <div v-if="detail?.item_id" class="cur-meta">商品 {{ detail.item_id }}</div>
            <div v-if="detail?.order_id" class="cur-meta">订单 {{ detail.order_id }}</div>
          </div>

          <div class="draft">
            <div class="draft-head">
              <span class="cur-title">回复草稿（巴西葡萄牙语）</span>
              <el-button size="small" type="primary" plain @click="generate">生成草稿</el-button>
            </div>
            <el-input
              v-model="draft"
              type="textarea"
              :rows="6"
              resize="vertical"
              placeholder="点击「生成草稿」或手动填写，发送前请仔细校验"
            />
            <div class="draft-actions">
              <el-button type="success" :loading="sending" @click="confirmSend">确认发送</el-button>
              <el-button @click="doSkip">跳过</el-button>
            </div>
          </div>
        </template>

        <div v-else class="readonly-note">
          {{
            detail?.status === 'sent'
              ? '该提问已回复，以上为完整问答记录（只读）。'
              : '该提问已跳过，未回复。'
          }}
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script lang="ts">
export default { name: 'MessageWorkbench' }
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
  margin-left: auto;
}
.row {
  margin-bottom: 16px;
}
.drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.drawer-title {
  font-size: 16px;
  font-weight: 600;
}
.body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.hist-title,
.cur-title {
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.hist-sub {
  font-weight: 400;
  color: #909399;
  font-size: 12px;
}
.readonly-note {
  color: #909399;
  font-size: 12px;
}
.bubbles {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bubble-row.mine {
  align-items: flex-end;
}
.bubble-row.mine .bubble {
  background: #ecf5ff;
  color: #303133;
}
.bubble-meta {
  font-size: 12px;
  color: #909399;
  margin-bottom: 2px;
}
.bubble {
  background: #f4f4f5;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.6;
  color: #303133;
  white-space: pre-wrap;
}
.empty-hist {
  color: #909399;
  font-size: 13px;
  padding: 8px 0;
}
.cur-text {
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.cur-meta {
  color: #909399;
  font-size: 12px;
  margin-top: 6px;
}
.draft-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.draft-actions {
  margin-top: 12px;
  display: flex;
  gap: 10px;
}
</style>
