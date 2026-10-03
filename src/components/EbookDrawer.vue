<template>
  <div class="ebook-drawer" :style="drawerStyle">
    <!-- 左侧拉出/收起箭头 -->
    <button class="ebook-toggle" :class="{ open, draggable }" @click="toggle" @contextmenu.prevent="openMenu($event)" :title="open ? '收起电子书' : '展开电子书'">
      <el-icon :size="20">
        <ArrowRight v-if="!open" />
        <ArrowLeft v-else />
      </el-icon>
    </button>

    <!-- 电子书面板 -->
    <transition name="ebook-slide">
      <div v-if="open" class="ebook-panel" :style="{ height: panelHeight + 'px' }" @contextmenu.prevent="openMenu($event)">
        <div class="resize-handle top" @mousedown="startResize('top', $event)"></div>
        <div class="ebook-header" :class="{ draggable }" @mousedown="startDrag">
          <span class="ebook-header-icon">
            <el-icon :size="18"><Reading /></el-icon>
          </span>
          <span class="ebook-title">{{ currentBook ? '阅读' : '我的电子书' }}</span>
          <el-button v-if="currentBook" text size="small" @click="closeReader">返回列表</el-button>
          <el-button v-else text :icon="Refresh" size="small" :loading="loading" @click="loadBooks">刷新</el-button>
        </div>

        <!-- 书目列表 -->
        <template v-if="!currentBook">
          <div class="ebook-count" v-if="loaded">共 {{ books.length }} 本</div>

          <el-scrollbar class="ebook-body">
            <div v-if="loading && !books.length" class="ebook-loading">
              <el-icon :size="28" class="is-loading"><Loading /></el-icon>
              <span>正在读取下载文件夹…</span>
            </div>

            <el-empty v-else-if="!books.length" description="下载文件夹中没有 epub 文件" :image-size="70" />

            <div v-else class="ebook-list">
              <div v-for="book in books" :key="book.name" class="ebook-card">
                <div class="book-cover">
                  <el-icon :size="26"><Reading /></el-icon>
                  <span class="book-epub">EPUB</span>
                </div>
                <div class="book-info">
                  <div class="book-name" :title="book.title">{{ book.title }}</div>
                  <div class="book-meta">
                    <span>{{ formatSize(book.size) }}</span>
                    <span>{{ formatDate(book.modified) }}</span>
                  </div>
                  <div v-if="getBookProgress(book.name) && formatProgress(getBookProgress(book.name).percentage)" class="book-progress">
                    已读 {{ formatProgress(getBookProgress(book.name).percentage) }}
                  </div>
                  <el-button size="small" text type="primary" :loading="opening === book.name" @click="openBook(book)">
                    {{ opening === book.name ? '加载中' : (getBookProgress(book.name) ? '继续阅读' : '打开') }}
                  </el-button>
                </div>
              </div>
            </div>
          </el-scrollbar>
        </template>

        <!-- 阅读器 -->
        <template v-else>
          <div class="ebook-count">{{ currentBook.title }}</div>
          <div class="reader-toolbar">
            <el-button size="small" @click="prevPage">上一页</el-button>
            <el-button size="small" @click="nextPage">下一页</el-button>
            <el-button
              size="small"
              type="primary"
              plain
              :disabled="!returnStack.length"
              :title="returnStack.length ? '回到点击注释/脚注前的位置' : '点击书内注释/脚注后可用'"
              @click="goBackToPrevious"
            >返回原文</el-button>
            <el-button size="small" @click="saveProgress">保存进度</el-button>
            <span v-if="progressText" class="reader-progress">{{ progressText }}</span>
            <span class="reader-hint">在框内阅读</span>
          </div>
          <div ref="readerEl" class="reader-area"></div>
        </template>

        <div class="resize-handle bottom" @mousedown="startResize('bottom', $event)"></div>
      </div>
    </transition>

    <!-- 右键菜单：自由拖动设置 -->
    <teleport to="body">
      <div v-if="menuVisible" class="ebook-ctx-menu" :style="{ left: menuX + 'px', top: menuY + 'px' }" @contextmenu.prevent>
        <div class="ctx-item" @click="toggleDraggable">
          {{ draggable ? '关闭自由拖动' : '开启自由拖动' }}
        </div>
        <div class="ctx-item" @click="resetPosition">恢复左侧默认位置</div>
      </div>
    </teleport>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { ArrowRight, ArrowLeft, Reading, Refresh, Loading } from '@element-plus/icons-vue'
import { request, authHeaders } from '../utils/request.js'

const open = ref(false)
const books = ref([])
const loading = ref(false)
const loaded = ref(false)
const opening = ref('')
const currentBook = ref(null)
const readerEl = ref(null)

// 阅读进度与“注释/脚注跳转后返回原文”
const EBOOK_PROGRESS_KEY = 'rpa_ebook_progress_v1'
const ebookProgressMap = ref(loadEbookProgress())
const currentLocationData = ref(null)
const currentCfi = ref('')
const returnStack = ref([])

// 自由拖动 / 右键菜单
const drawerX = ref(0)
const drawerY = ref(0)
const draggable = ref(false)
const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const drawerStyle = computed(() => ({
  left: `${drawerX.value}px`,
  top: `${drawerY.value}px`
}))
let dragStart = null

// 上下高度自定义缩小
const panelHeight = ref(typeof window !== 'undefined' ? window.innerHeight : 800)
const MIN_PANEL_HEIGHT = 200
let resizeStart = null

let ebook = null
let rendition = null

const toggle = () => {
  open.value = !open.value
  if (open.value) {
    loadBooks()
  } else {
    closeReader()
    // 收回时回到左侧默认原位，下次展开也从原位拉出
    drawerX.value = 0
    drawerY.value = 0
  }
}

const openMenu = (e) => {
  menuX.value = Math.min(e.clientX, window.innerWidth - 180 - 8)
  menuY.value = Math.min(e.clientY, window.innerHeight - 120 - 8)
  menuVisible.value = true
}

const closeMenu = () => {
  menuVisible.value = false
}

const toggleDraggable = () => {
  draggable.value = !draggable.value
  closeMenu()
  if (!draggable.value) {
    // 关闭自由拖动时吸附回左侧默认位置，避免面板停在屏幕中间
    drawerX.value = 0
    drawerY.value = 0
  }
}

const resetPosition = () => {
  drawerX.value = 0
  drawerY.value = 0
  closeMenu()
}

const startDrag = (e) => {
  if (!draggable.value || e.button !== 0) return
  if (e.target && e.target.closest && e.target.closest('button')) return
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    px: drawerX.value,
    py: drawerY.value
  }
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', stopDrag)
}

// 拖动边界：抽屉整体是 position:fixed + translate，原先不做任何 clamp，
// 可以把面板连同左侧把手一起拖出可视区，之后再也点不到把手上的
// 「恢复默认位置」菜单，只能刷新页面。
// 约束就是「把手必须留在视口内」——把手 30×72、left:0、相对 100vh 容器垂直居中，
// 所以水平方向在 [0, 视口宽-30]，垂直方向让 50vh±36px 落在 [0, 视口高]。
const HANDLE_W = 30
const HANDLE_H = 72
const clampDrawerX = (x) => Math.min(Math.max(x, 0), Math.max(0, window.innerWidth - HANDLE_W))
const clampDrawerY = (y) => {
  const half = HANDLE_H / 2
  const lo = half - window.innerHeight / 2
  const hi = window.innerHeight / 2 - half
  return Math.min(Math.max(y, lo), Math.max(lo, hi))
}

const onDragMove = (e) => {
  if (!dragStart) return
  drawerX.value = clampDrawerX(dragStart.px + e.clientX - dragStart.x)
  drawerY.value = clampDrawerY(dragStart.py + e.clientY - dragStart.y)
}

const stopDrag = () => {
  dragStart = null
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', stopDrag)
}

const startResize = (side, e) => {
  if (e.button !== 0) return
  resizeStart = {
    side,
    startY: e.clientY,
    startHeight: panelHeight.value,
    startTop: drawerY.value
  }
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', stopResize)
}

const onResizeMove = (e) => {
  if (!resizeStart) return
  const delta = e.clientY - resizeStart.startY
  const grow = resizeStart.side === 'bottom' ? delta : -delta
  let newHeight = resizeStart.startHeight + grow
  newHeight = Math.min(Math.max(newHeight, MIN_PANEL_HEIGHT), window.innerHeight)
  panelHeight.value = newHeight
  if (resizeStart.side === 'top') {
    // 上边调整时保持底边不动，同步移动整个抽屉的垂直位置
    drawerY.value = resizeStart.startTop + (resizeStart.startHeight - newHeight)
  }
}

const stopResize = () => {
  resizeStart = null
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', stopResize)
}

const onDocClick = () => closeMenu()

const loadBooks = async () => {
  loading.value = true
  try {
    const res = await request('/api/ebooks', { headers: authHeaders(), silentNetworkError: true })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.success) {
      books.value = data.ebooks || []
      loaded.value = true
    }
  } catch {
    // 忽略，保持原列表
  } finally {
    loading.value = false
  }
}

// epub.min.js 是 UMD 包，入口处就是 `t.ePub = e(t.JSZip)` —— 它**依赖全局 JSZip**，
// 所以 jszip.min.js 不是冗余文件，两者必须按序加载。
// 这两个库合计约 320KB，只有真正打开一本书时才需要，改为按需注入（原先放在
// index.html 里同步阻塞首屏）。失败时清空缓存，便于下次重试。
let epubLibPromise = null
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`加载失败: ${src}`))
    document.head.appendChild(el)
  })
}
function ensureEpubLib() {
  if (window.ePub) return Promise.resolve()
  if (!epubLibPromise) {
    epubLibPromise = loadScriptOnce('/vendor/jszip.min.js')
      .then(() => loadScriptOnce('/vendor/epub.min.js'))
      .then(() => { if (!window.ePub) throw new Error('EPUB 阅读组件未加载') })
      .catch((e) => { epubLibPromise = null; throw e })
  }
  return epubLibPromise
}

const openBook = async (book) => {
  opening.value = book.name
  try {
    const res = await request(`/api/ebooks/file?name=${encodeURIComponent(book.name)}`, {
      headers: authHeaders()
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    const arrayBuffer = await res.arrayBuffer()

    // 清理上一个阅读器
    closeReader()

    currentBook.value = book
    await nextTick()
    if (!readerEl.value) throw new Error('阅读器容器未准备好')
    await ensureEpubLib()

    const myEbook = window.ePub(arrayBuffer)
    ebook = myEbook
    rendition = ebook.renderTo(readerEl.value, { width: '100%', height: '100%' })

    // 监听位置变化：自动记录并保存阅读进度
    if (rendition.on) rendition.on('relocated', handleRelocated)
    // 监听 EPUB 内部链接(脚注/注释/目录跳转），记录返回原文的位置
    if (rendition.hooks && rendition.hooks.content && typeof rendition.hooks.content.register === 'function') {
      rendition.hooks.content.register(attachContentLinkListener)
    }

    const saved = getBookProgress(book.name)
    const savedCfi = saved && saved.cfi ? saved.cfi : undefined
    try {
      await rendition.display(savedCfi)
    } catch (e) {
      // 旧进度可能因书籍更新失效，回退到开头
      await rendition.display()
    }
    // 生成书内位置索引，让阅读百分比可显示/保存
    try {
      if (myEbook.locations && typeof myEbook.locations.generate === 'function') {
        myEbook.locations.generate(150).then(() => {
          // 快速切换书籍时旧书的索引回调仍会到达：ebook 是模块级变量、已被下一本覆盖，
          // 原先只判 `!ebook` 挡不住这种情况，会把旧书的百分比写到新书的进度上。
          // 这里比对实例身份，确保回调只作用于它自己那本书。
          if (ebook !== myEbook || !myEbook.locations || !currentLocationData.value || !currentLocationData.value.start) return
          const cfi = currentLocationData.value.start.cfi
          const pct = myEbook.locations.percentageFromCfi
            ? myEbook.locations.percentageFromCfi(cfi)
            : null
          if (typeof pct === 'number') {
            currentLocationData.value = {
              ...currentLocationData.value,
              start: { ...currentLocationData.value.start, percentage: pct }
            }
            if (currentBook.value) saveBookProgress(currentBook.value.name, currentLocationData.value)
          }
        }).catch(() => {})
      }
    } catch {}

    // 部分场景 relocated 已触发；这里兜底确保当前进度可用
    if (!currentLocationData.value && rendition.currentLocation) {
      try {
        const location = rendition.currentLocation()
        if (location && location.start) handleRelocated(location)
      } catch {}
    }
  } catch (e) {
    ElMessage.error(`打开失败: ${e.message}`)
    closeReader()
  } finally {
    opening.value = ''
  }
}

const closeReader = () => {
  // 关闭前把最后位置也保存一次，避免自动保存遗漏
  if (currentBook.value && currentLocationData.value) {
    saveBookProgress(currentBook.value.name, currentLocationData.value)
  }
  if (rendition) {
    try {
      if (rendition.off) rendition.off('relocated', handleRelocated)
      rendition.destroy && rendition.destroy()
    } catch {}
  }
  if (ebook) {
    try { ebook.destroy && ebook.destroy() } catch {}
  }
  rendition = null
  ebook = null
  currentBook.value = null
  currentLocationData.value = null
  currentCfi.value = ''
  returnStack.value = []
}

const prevPage = () => {
  try { rendition && rendition.prev && rendition.prev() } catch {}
}

const nextPage = () => {
  try { rendition && rendition.next && rendition.next() } catch {}
}

// ---------- 阅读进度 / 返回原文 ----------
function loadEbookProgress() {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(EBOOK_PROGRESS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function persistEbookProgress() {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(EBOOK_PROGRESS_KEY, JSON.stringify(ebookProgressMap.value))
  } catch {
    // 存储不可用时静默忽略
  }
}

const getBookProgress = (name) => ebookProgressMap.value[name] || null

const formatProgress = (p) => {
  if (p == null || p === '') return ''
  const pct = (typeof p === 'number' && p <= 1) ? p * 100 : p
  return `${Math.round(pct)}%`
}

const saveBookProgress = (name, location) => {
  if (!name || !location || !location.start || !location.start.cfi) return
  ebookProgressMap.value = {
    ...ebookProgressMap.value,
    [name]: {
      cfi: location.start.cfi,
      percentage: typeof location.start.percentage === 'number' ? location.start.percentage : null,
      updatedAt: Date.now()
    }
  }
  persistEbookProgress()
}

const progressText = computed(() => {
  const p = currentLocationData.value && currentLocationData.value.start
    ? currentLocationData.value.start.percentage
    : null
  return p == null ? '' : `已读 ${formatProgress(p)}`
})

const handleRelocated = (location) => {
  currentLocationData.value = location || null
  if (location && location.start && location.start.cfi) {
    currentCfi.value = location.start.cfi
    if (currentBook.value) saveBookProgress(currentBook.value.name, location)
  }
}

const handleContentLinkClicked = () => {
  // EPUB 内部链接(脚注/注释/章节跳转)被点击后，记录离开前的位置，便于返回原文
  if (!currentCfi.value) return
  returnStack.value.push(currentCfi.value)
  if (returnStack.value.length > 50) returnStack.value.shift()
}

const attachContentLinkListener = (contents) => {
  if (!contents || typeof contents.on !== 'function') return
  contents.on('linkClicked', handleContentLinkClicked)
}

const goBackToPrevious = async () => {
  const target = returnStack.value.pop()
  if (!target || !rendition) return
  try {
    await rendition.display(target)
  } catch (e) {
    // 返回失败时把位置放回，避免丢失这一处返回点
    returnStack.value.push(target)
    ElMessage.error(`返回原文失败: ${e.message}`)
  }
}

const saveProgress = () => {
  if (!currentBook.value) return
  if (!currentLocationData.value || !currentLocationData.value.start || !currentLocationData.value.start.cfi) {
    ElMessage.info('尚未获取到阅读位置，请先翻一页')
    return
  }
  saveBookProgress(currentBook.value.name, currentLocationData.value)
  ElMessage.success('阅读进度已保存')
}

const formatSize = (size) => {
  if (size === null || size === undefined) return ''
  const kb = size / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

const formatDate = (iso) => {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
})

onUnmounted(() => {
  closeReader()
  document.removeEventListener('click', onDocClick)
  stopDrag()
  stopResize()
})
</script>

<style scoped>
.ebook-drawer {
  position: fixed;
  left: 0;
  top: 0;
  height: 100vh;
  z-index: 2000;
  pointer-events: none;
}

.ebook-toggle {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 30px;
  height: 72px;
  border: none;
  border-radius: 0 10px 10px 0;
  background: var(--app-header-bg, linear-gradient(180deg, #1f2329, #2a2f38));
  /* 浅色顶栏主题(纸感/樱花)下使用顶栏文字色,避免白字白底 */
  color: var(--app-header-text, #fff);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 2px 0 10px rgba(0, 0, 0, 0.18);
  transition: left 0.25s ease;
  pointer-events: auto;
  z-index: 2100;
}

.ebook-toggle:hover {
  background: var(--app-accent, #2f6fed);
  color: var(--app-accent-contrast, #fff);
}

.ebook-toggle.open {
  left: 460px;
}

.ebook-panel {
  position: absolute;
  left: 0;
  top: 0;
  width: 460px;
  height: 100vh;
  max-height: 100vh;
  min-height: 200px;
  background: var(--app-card-bg, #ffffff);
  border-right: 1px solid var(--app-card-border, #e8eaef);
  box-shadow: 6px 0 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

/* 上下高度调节把手 */
.resize-handle {
  position: absolute;
  left: 0;
  right: 0;
  height: 8px;
  cursor: ns-resize;
  z-index: 2200;
}

.resize-handle.top {
  top: 0;
}

.resize-handle.bottom {
  bottom: 0;
}

.resize-handle:hover {
  background: rgba(47, 111, 237, 0.25);
}

.ebook-slide-enter-active,
.ebook-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.ebook-slide-enter-from,
.ebook-slide-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

.ebook-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border-bottom: 1px solid var(--app-border-light, #f0f1f5);
  font-size: 15px;
  font-weight: 600;
  color: var(--app-text-primary, #303133);
}

.ebook-header-icon {
  color: var(--app-accent, #2f6fed);
}

.ebook-title {
  flex: 1;
}

.ebook-count {
  padding: 8px 16px 0;
  font-size: 12px;
  color: var(--app-text-secondary, #909399);
  word-break: break-all;
}

.ebook-body {
  flex: 1;
  padding: 8px;
}

.ebook-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 60px 0;
  color: var(--app-text-secondary, #909399);
  font-size: 13px;
}

.ebook-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ebook-card {
  display: flex;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--app-border-light, #f0f1f5);
  border-radius: 10px;
  background: var(--app-hover-bg, #fafafa);
  transition: box-shadow 0.2s;
}

.ebook-card:hover {
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
}

.book-cover {
  width: 74px;
  height: 100px;
  flex-shrink: 0;
  border-radius: 6px;
  background: linear-gradient(135deg, var(--app-accent, #2f6fed) 0%, var(--app-accent-2, #22d3ee) 100%);
  color: var(--app-accent-contrast, #fff);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-shadow: 0 4px 10px var(--app-card-hover-shadow, rgba(47, 111, 237, 0.25));
}

.book-epub {
  font-size: 12px;
  letter-spacing: 1px;
  background: rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  padding: 2px 5px;
}

.book-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.book-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-primary, #303133);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.book-meta {
  display: flex;
  gap: 10px;
  font-size: 12px;
  color: var(--app-text-secondary, #909399);
}

.book-progress {
  font-size: 12px;
  color: var(--app-accent, #2f6fed);
}

/* 阅读器 */
.reader-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  row-gap: 6px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--app-border-light, #f0f1f5);
}

.reader-hint {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: var(--app-text-secondary, #909399);
}

.reader-progress {
  font-size: 12px;
  color: var(--app-text-primary, #303133);
  white-space: nowrap;
}

.reader-area {
  flex: 1;
  min-height: 0;
  background: var(--app-card-bg, #faf9f5);
  overflow: hidden;
}

/* 自由拖动提示 */
.ebook-header.draggable {
  cursor: move;
  user-select: none;
}

.ebook-toggle.draggable {
  cursor: move;
}

/* 右键菜单 */
.ebook-ctx-menu {
  position: fixed;
  z-index: 4000;
  background: var(--app-card-bg, #ffffff);
  border: 1px solid var(--app-card-border, #e8eaef);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  padding: 4px;
  user-select: none;
}

.ebook-ctx-menu .ctx-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--app-text-primary, #303133);
  white-space: nowrap;
}

.ebook-ctx-menu .ctx-item:hover {
  background: var(--app-hover-bg, #f5f7fa);
}
</style>
