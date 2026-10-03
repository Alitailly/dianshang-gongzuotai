<template>
  <div class="settings-page">
    <el-card>
      <template #header>
        <div class="card-header settings-hero">
          <div class="hero-left">
            <div class="hero-icon"><el-icon><Setting /></el-icon></div>
            <div>
              <div class="hero-title">设置</div>
              <div class="hero-sub">管理账号、系统主题、版本与文件下载</div>
            </div>
          </div>
          <el-tag size="small" effect="plain" round>系统配置</el-tag>
        </div>
      </template>

      <!-- 插件管理：原独立页面 /plugins 迁移进网站设置 -->
      <div v-if="isAdmin" class="settings-panel plugin-admin-section">
        <Plugins />
      </div>

      <!-- 用户管理：原独立页面 /users 迁移进网站设置 -->
      <div v-if="isAdmin" class="settings-panel user-admin-section">
        <UserManageView />
      </div>

      <!-- 账号设置(2026-08-07:原独立页面合并至此,置顶) -->
      <div class="settings-panel account-section">
        <div class="section-title">
          <el-icon><Lock /></el-icon>
          <span>账号设置</span>
          <el-tag size="small" type="info" effect="plain">修改用户名/密码,需验证原密码</el-tag>
        </div>
        <el-form :model="form" label-width="110px" class="account-form">
          <el-form-item label="当前用户名">
            <el-input :model-value="currentUser.username" disabled style="max-width: 320px" />
          </el-form-item>
          <el-form-item label="新用户名">
            <el-input v-model="form.username" placeholder="留空则不修改" style="max-width: 320px" />
          </el-form-item>
          <el-form-item label="新密码">
            <el-input v-model="form.password" type="password" show-password placeholder="留空则不修改" autocomplete="new-password" style="max-width: 320px" />
          </el-form-item>
          <el-form-item label="确认新密码">
            <el-input v-model="form.confirmPassword" type="password" show-password placeholder="再次输入新密码" autocomplete="new-password" style="max-width: 320px" />
          </el-form-item>
          <el-divider />
          <el-form-item label="原密码" required>
            <el-input v-model="form.oldPassword" type="password" show-password placeholder="修改需验证原密码" autocomplete="current-password" style="max-width: 320px" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="saving" @click="save">保存修改</el-button>
          </el-form-item>
        </el-form>
      </div>

      <!-- 文件下载中心(2026-09-09):网站根目录 xxh_down -->
      <div class="settings-panel download-section">
        <div class="section-title">
          <el-icon><Download /></el-icon>
          <span>文件下载</span>
          <el-button size="small" type="primary" plain :icon="Download" @click="openDownloadDialog">打开下载中心</el-button>
        </div>
        <div class="download-tip">
          网站根目录 <code>xxh_down</code> 文件夹中的内容可在此查看并下载；任意电脑访问本网站都能下载，不依赖本机路径。
        </div>
      </div>

      <!-- 主题中心 -->
      <div class="settings-panel theme-section">
        <div class="section-title">
          <el-icon><MagicStick /></el-icon>
          <span>主题中心</span>
          <span class="theme-count">共 {{ THEMES.length }} 套</span>
        </div>
        <div class="theme-toolbar">
          <el-radio-group v-model="themeFilter" size="small">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="light">浅色</el-radio-button>
            <el-radio-button value="dark">暗色</el-radio-button>
          </el-radio-group>
          <el-button size="small" :icon="MagicStick" @click="randomTheme">随机换肤</el-button>
          <span class="filtered-count">当前显示 {{ filteredThemes.length }} 套</span>
        </div>
        <div class="theme-grid">
          <div
            v-for="t in filteredThemes"
            :key="t.name"
            class="theme-card"
            :class="{ active: currentTheme === t.name }"
            @click="applyTheme(t.name)"
          >
            <!-- 主题预览色块 -->
            <div class="theme-preview" :style="{ background: t.preview[1] }">
              <div class="preview-window">
                <div class="preview-titlebar">
                  <span class="pw-dot" :style="{ background: t.preview[0] }"></span>
                  <span class="pw-dot" :style="{ background: t.preview[2] }"></span>
                  <span class="pw-dot"></span>
                  <span class="pw-title" :style="{ fontFamily: t.font }">{{ t.label }}</span>
                </div>
                <div class="preview-body">
                  <span class="preview-side" :style="{ background: `linear-gradient(180deg, ${t.preview[0]}26, ${t.preview[2]}14)` }"></span>
                  <span class="preview-content">
                    <i :style="{ background: t.preview[0] }"></i>
                    <i :style="{ background: t.preview[2] }"></i>
                    <i></i>
                  </span>
                </div>
              </div>
              <span class="theme-badge" :class="{ dark: t.dark }">{{ t.dark ? '暗色' : '浅色' }}</span>
            </div>
            <div class="theme-meta">
              <div class="theme-name">
                {{ t.label }}
                <el-icon v-if="currentTheme === t.name" class="check-icon"><Check /></el-icon>
              </div>
              <div class="theme-desc">{{ t.desc }}</div>
            </div>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 文件下载中心弹窗 -->
    <el-dialog ref="downloadDialogRef" v-model="downloadDialogVisible" title="文件下载中心" width="760px" @opened="scrollDownloadTop" @closed="resetDownloadDir">
      <div class="download-toolbar">
        <el-button size="small" :icon="Download" @click="goParent" :disabled="downloadDir === ''">返回上级</el-button>
        <el-button size="small" :icon="Download" @click="refreshDownloads" :disabled="downloadLoading">刷新</el-button>
        <span class="download-path">当前目录：{{ downloadDir === '' ? 'xxh_down /' : 'xxh_down / ' + downloadDir }}</span>
      </div>
      <el-table v-loading="downloadLoading" :data="downloadEntries" empty-text="文件夹为空" row-key="path" style="width: 100%">
        <el-table-column label="名称" min-width="260">
          <template #default="{ row }">
            <span class="download-name" :class="{ 'is-dir': row.type === 'dir' }" @click="row.type === 'dir' ? enterDir(row) : downloadFile(row)">
              <el-icon><component :is="row.type === 'dir' ? Folder : Document" /></el-icon>
              <span class="name-text">{{ row.name }}</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="120">
          <template #default="{ row }">{{ row.type === 'dir' ? '—' : formatSize(row.size) }}</template>
        </el-table-column>
        <el-table-column label="修改时间" width="180">
          <template #default="{ row }">{{ formatTime(row.modified) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="center">
          <template #default="{ row }">
            <el-button v-if="row.type === 'dir'" size="small" @click="enterDir(row)">打开</el-button>
            <el-button v-else size="small" type="primary" @click="downloadFile(row)">下载</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { MagicStick, Check, Lock, Download, Folder, Document, Setting } from '@element-plus/icons-vue'
import { useTheme } from '../composables/useTheme.js'
import Plugins from './Plugins.vue'
import UserManageView from './UserManageView.vue'
import { request, authHeaders } from '../utils/request.js'

const { currentTheme, applyTheme, THEMES } = useTheme()

// ---- 主题中心:筛选与随机换肤 ----
const themeFilter = ref('all')
const filteredThemes = computed(() => {
  if (themeFilter.value === 'all') return THEMES
  return THEMES.filter(t => t.dark === (themeFilter.value === 'dark'))
})

const randomTheme = () => {
  const random = filteredThemes.value[Math.floor(Math.random() * filteredThemes.value.length)]
  if (random) {
    applyTheme(random.name)
    ElMessage.success(`已切换为「${random.label}」`)
  }
}

// ---- 账号设置(2026-08-07:原账号设置页合并至此) ----
function readLocalUser() {
  try {
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    return user && typeof user === 'object' ? user : {}
  } catch {
    return {}
  }
}

const currentUser = ref({ ...readLocalUser(), role: '' })
const isAdmin = computed(() => currentUser.value.role === 'admin')
const saving = ref(false)
const form = ref({
  username: '',
  password: '',
  confirmPassword: '',
  oldPassword: ''
})

async function loadCurrentUser() {
  try {
    const res = await request('/api/users/me', { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    if (data.user) currentUser.value = data.user
  } catch (e) {
    console.warn('[settings] 读取当前用户身份失败:', e.message)
  }
}

onMounted(loadCurrentUser)

const save = async () => {
  if (!form.value.username && !form.value.password) {
    ElMessage.warning('请填写要修改的用户名或密码')
    return
  }
  if (!form.value.oldPassword) {
    ElMessage.warning('请输入原密码验证')
    return
  }
  if (form.value.password && form.value.password !== form.value.confirmPassword) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }

  saving.value = true
  try {
    const res = await request('/api/users/me', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token')}`
      },
      body: JSON.stringify({
        newUsername: form.value.username || undefined,
        oldPassword: form.value.oldPassword,
        password: form.value.password || undefined
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }

    const data = await res.json()
    // 更新本地登录态(新 token + 新用户信息),然后刷新留在设置页
    localStorage.setItem('token', data.token)
    localStorage.setItem('user', JSON.stringify(data.user))
    ElMessage.success('账号信息已更新,即将刷新')
    setTimeout(() => {
      location.href = '/settings'
    }, 800)
  } catch (e) {
    ElMessage.error(`修改失败: ${e.message}`)
  } finally {
    saving.value = false
  }
}

// ---- 文件下载中心(2026-09-09) ----
const downloadDialogVisible = ref(false)
const downloadDialogRef = ref(null)
const downloadLoading = ref(false)
const downloadDir = ref('')
const downloadEntries = ref([])

// 每次打开下载中心时把弹窗内容滚回顶部，避免沿用上一次的滚动位置。
// Element Plus 弹窗实际滚动容器是 .el-overlay-dialog，内容过长时优先重置它。
function scrollDownloadTop() {
  const root = downloadDialogRef.value?.$el
  const rootEl = root && typeof root.querySelector === 'function' ? root : null
  const body = rootEl?.querySelector('.el-dialog__body') || document.querySelector('.el-dialog__body')
  if (body) body.scrollTop = 0
  const overlay = rootEl?.querySelector('.el-overlay-dialog') || document.querySelector('.el-overlay-dialog')
  if (overlay) overlay.scrollTop = 0
}

function formatSize(size) {
  if (size === null || size === undefined || size === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = Number(size)
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`
}

function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function resetDownloadDir() {
  downloadDir.value = ''
}

async function loadDownloads(dir = '') {
  downloadLoading.value = true
  try {
    const res = await request(`/api/settings/downloads/list?dir=${encodeURIComponent(dir)}`, { headers: authHeaders() })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    downloadDir.value = dir || ''
    downloadEntries.value = data.entries || []
  } catch (e) {
    ElMessage.error(`读取下载目录失败: ${e.message}`)
  } finally {
    downloadLoading.value = false
  }
}

function openDownloadDialog() {
  downloadDialogVisible.value = true
  loadDownloads('')
}

function refreshDownloads() {
  loadDownloads(downloadDir.value)
}

function enterDir(row) {
  loadDownloads(row.path)
}

function goParent() {
  const dir = downloadDir.value
  if (!dir) return
  const idx = dir.lastIndexOf('/')
  loadDownloads(idx === -1 ? '' : dir.slice(0, idx))
}

async function downloadFile(row) {
  try {
    const res = await request(`/api/settings/downloads/file?path=${encodeURIComponent(row.path)}`, { headers: authHeaders() })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = row.name
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    ElMessage.success(`开始下载: ${row.name}`)
  } catch (e) {
    ElMessage.error(`下载失败: ${e.message}`)
  }
}
</script>

<style scoped>
.settings-page {
  padding: var(--app-content-padding, 20px);
  max-width: 1280px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ---------- 顶部 Hero ---------- */
.card-header.settings-hero {
  padding: 18px 22px;
  background: var(--app-card-header-bg, transparent);
  border-bottom: 1px solid var(--app-card-header-border, #f0f1f5);
}

.hero-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.hero-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  font-size: 21px;
  color: var(--app-accent, var(--el-color-primary, #2563eb));
  background: var(--app-accent-soft, rgba(37, 99, 235, 0.12));
  border: 1px solid var(--app-accent-line, rgba(37, 99, 235, 0.32));
  box-shadow: 0 8px 20px rgba(37, 99, 235, 0.12);
}

.hero-title {
  font-family: var(--app-font-display, inherit);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 1px;
  color: var(--app-text-primary, #303133);
  line-height: 1.3;
}

.hero-sub {
  margin-top: 3px;
  font-size: 13px;
  color: var(--app-text-secondary, #909399);
}

/* ---------- 设置分组面板 ---------- */
.settings-panel {
  position: relative;
  margin-top: 6px;
  padding: 20px 22px 18px;
  border: 1px solid var(--app-card-border, #e8eaef);
  border-radius: var(--app-radius-card, 10px);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.018) 0%, rgba(255, 255, 255, 0) 100%),
    var(--app-card-bg, #ffffff);
  box-shadow: var(--app-card-shadow, 0 1px 4px rgba(0, 0, 0, 0.05));
  overflow: hidden;
  transition:
    border-color 0.25s var(--ui-ease, ease),
    box-shadow 0.25s var(--ui-ease, ease),
    transform 0.25s var(--ui-ease, ease);
}

.settings-panel::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 3px;
  background: var(--app-card-accent, var(--el-color-primary, #2563eb));
  opacity: 0.72;
  pointer-events: none;
}

.settings-panel:hover {
  border-color: var(--app-card-hover-border, var(--el-color-primary-light-7, #aac5f8));
  box-shadow: var(--app-card-hover-shadow, 0 12px 28px rgba(15, 23, 42, 0.1));
}

/* Bot 实例子组件在面板内去掉自带的顶部分隔线 */
.bot-panel:deep(.bot-instances-settings) {
  margin-top: 0 !important;
  padding-top: 0 !important;
  border-top: none !important;
}

.bot-panel:deep(.section-title) {
  margin-bottom: 16px;
}

/* ---------- 通用分节标题 ---------- */
.section-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 700;
  font-family: var(--app-font-display, inherit);
  color: var(--app-text-primary, #303133);
  margin-bottom: 16px;
  letter-spacing: 0.4px;
}

.section-title .el-icon {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 15px;
  color: var(--app-accent, var(--el-color-primary, #2563eb));
  background: var(--app-accent-soft, rgba(37, 99, 235, 0.12));
  flex-shrink: 0;
}

/* ---------- 主题中心 ---------- */
.theme-section {
  padding: 2px 0;
}

.theme-count {
  font-size: 12px;
  font-weight: 500;
  color: var(--app-text-secondary, #909399);
  margin-left: auto;
}

.theme-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.filtered-count {
  font-size: 12px;
  color: var(--app-text-secondary, #909399);
}

/* 主题卡片网格:自适应列数 */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: var(--app-gap, 20px);
}

.theme-card {
  background: var(--app-card-bg, #fff);
  border: 1px solid var(--app-card-border, #e8eaef);
  border-radius: var(--app-radius-card, 10px);
  overflow: hidden;
  cursor: pointer;
  transition:
    transform 0.25s var(--ui-ease, cubic-bezier(0.22, 0.61, 0.36, 1)),
    box-shadow 0.25s var(--ui-ease, cubic-bezier(0.22, 0.61, 0.36, 1)),
    border-color 0.25s var(--ui-ease, cubic-bezier(0.22, 0.61, 0.36, 1)),
    background-color 0.25s var(--ui-ease, cubic-bezier(0.22, 0.61, 0.36, 1));
}

.theme-card:hover {
  transform: translateY(-4px);
  border-color: var(--app-card-hover-border, var(--el-color-primary-light-7, #aac5f8));
  box-shadow: var(--app-card-hover-shadow, 0 8px 24px rgba(0, 0, 0, 0.1));
}

.theme-card:focus-visible {
  outline: 2px solid var(--el-color-primary, #2563eb);
  outline-offset: 2px;
}

.theme-card.active {
  border-color: var(--el-color-primary);
  background: var(--app-card-header-bg, transparent);
  box-shadow:
    0 0 0 2px var(--el-color-primary-light-8, #c0d5fa),
    var(--app-card-hover-shadow, 0 8px 24px rgba(15, 23, 42, 0.12));
}

.theme-card.active .theme-badge {
  background: var(--el-color-primary, #2563eb);
  color: var(--el-color-white, #fff);
}

.theme-card.active .preview-window {
  box-shadow:
    0 0 0 2px var(--el-color-primary-light-7, #aac5f8),
    0 10px 26px rgba(0, 0, 0, 0.18);
}

/* 预览区:迷你工作台窗口 */
.theme-preview {
  position: relative;
  height: 118px;
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.theme-preview::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.12) 0%, transparent 42%);
  pointer-events: none;
}

.preview-window {
  width: 100%;
  height: 100%;
  background: var(--app-card-bg, #fff);
  border: 1px solid var(--app-card-border, #e8eaef);
  border-radius: 9px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  transform: translateY(5px);
  transition: transform 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.theme-card:hover .preview-window {
  transform: translateY(2px);
}

.preview-titlebar {
  height: 24px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  background: rgba(0, 0, 0, 0.08);
}

.pw-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.45);
  flex-shrink: 0;
}

.pw-title {
  margin-left: auto;
  font-size: 12px;
  letter-spacing: 1px;
  color: var(--app-text-regular, #606266);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-body {
  display: flex;
  height: calc(100% - 24px);
}

.preview-side {
  width: 20%;
  min-width: 20px;
  border-right: 1px solid rgba(128, 128, 128, 0.1);
}

.preview-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px;
}

.preview-content i {
  display: block;
  height: 6px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.2);
}

.preview-content i:nth-child(2) {
  width: 72%;
}

.preview-content i:nth-child(3) {
  width: 45%;
}

.theme-badge {
  position: absolute;
  top: 18px;
  right: 18px;
  font-size: 12px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  backdrop-filter: blur(4px);
}

.theme-badge.dark {
  background: rgba(255, 255, 255, 0.32);
  color: rgba(0, 0, 0, 0.72);
}

.theme-meta {
  padding: 12px 14px 14px;
}

.theme-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 700;
  color: var(--app-text-primary, #303133);
}

.check-icon {
  color: var(--el-color-success);
}

.theme-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--app-text-secondary, #909399);
}

/* ---------- 账号设置 ---------- */
.account-section {
  padding-top: 2px;
}

.account-form {
  max-width: 560px;
}

.account-form :deep(.el-input) {
  max-width: 320px;
}

/* ---------- 文件下载中心 ---------- */
.download-section {
  padding-top: 2px;
}

.download-tip {
  font-size: 13px;
  line-height: 1.6;
  color: var(--app-text-secondary, #909399);
}

.download-tip code {
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--app-accent-soft, rgba(37, 99, 235, 0.1));
  color: var(--app-accent, var(--el-color-primary, #2563eb));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.download-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.download-path {
  flex: 1;
  font-size: 13px;
  color: var(--app-text-secondary, #909399);
  word-break: break-all;
}

.download-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--app-text-primary, #303133);
}

.download-name:hover {
  color: var(--el-color-primary);
}

.download-name .name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 响应式 ---------- */
@media (max-width: 900px) {
  .settings-page {
    padding: 14px;
  }

  .card-header.settings-hero {
    padding: 14px 16px;
  }

  .hero-title {
    font-size: 18px;
  }

  .settings-panel {
    padding: 16px 16px 14px;
  }

  .theme-grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 14px;
  }

  .theme-preview {
    height: 104px;
  }

  .account-form {
    max-width: 100%;
  }
}
</style>
