<template>
  <div v-if="authed" class="port-float">
    <!-- 右侧悬浮手柄 -->
    <div
      class="handle"
      :class="{ 'glow-running': runningCount > 0 && busyCount === 0, 'glow-busy': busyCount > 0, active: expanded }"
      @click="expanded = !expanded"
      :title="expanded ? '收起端口状态' : '展开端口状态'"
    >
      <span class="h-dot" :class="[overall, { busy: busyCount > 0 }]"></span>
      <span class="h-text">端口</span>
      <span v-if="stuckCount" class="alert-badge" :title="`${stuckCount} 个端口有验证码`">!</span>
    </div>

    <!-- 展开面板：按 IP 分组 -->
    <transition name="slide">
      <div v-if="expanded" class="float-panel">
        <div class="fp-header">
          <span class="fp-title">CDP 端口（按 IP）</span>
          <div class="fp-actions">
            <el-button size="small" text :loading="loading" @click="loadStatus">刷新</el-button>
            <el-button size="small" text @click="expanded = false">收起</el-button>
          </div>
        </div>

        <div v-for="grp in groups" :key="grp.id" class="fp-group">
          <div class="fp-group-title">
            <span class="fp-group-name">{{ grp.name || grp.ip }}</span>
            <el-tag size="small" :type="grp.online ? 'success' : 'danger'" effect="plain">{{ grp.online ? '在线' : '离线' }}</el-tag>
            <el-tag v-if="grp.busy" size="small" type="warning" effect="dark">忙碌</el-tag>
            <span class="fp-group-ip">{{ grp.ip }}</span>
          </div>
          <div class="fp-group-account" v-if="grp.account">账号：{{ grp.account }}</div>
          <div
            v-for="p in grp.ports"
            :key="p.port"
            class="fp-row"
            :class="{ 'row-stuck': p.status === 'stuck' }"
            @contextmenu.prevent="openMenu(grp, p, $event)"
          >
            <span class="ps-dot" :class="[p.status, { busy: p.busy }]"></span>
            <span class="fp-port">{{ p.port }}</span>
            <el-tag :type="tagType(p.status)" size="small" effect="light">{{ statusText(p.status) }}</el-tag>
            <span v-if="workText(p)" class="fp-work" :class="{ busy: p.busy }">{{ workText(p) }}</span>
          </div>
          <div v-if="!grp.ports.length" class="fp-group-empty">暂无端口数据</div>
        </div>

        <div v-if="!groups.length" class="fp-empty">暂无 Bot 实例，请在「设置」中添加</div>
      </div>
    </transition>

    <!-- 自绘右键菜单 -->
    <teleport to="body">
      <div v-if="menuVisible" class="ctx-menu" :style="{ left: menuX + 'px', top: menuY + 'px' }" @contextmenu.prevent>
        <div v-if="menuPort && menuPort.status === 'off'" class="ctx-item" @click="runAction('start', menuGrp, menuPort.port)">开启端口 {{ menuPort.port }}</div>
        <div v-if="menuPort && menuPort.status === 'running'" class="ctx-item" @click="runAction('close', menuGrp, menuPort.port)">关闭端口 {{ menuPort.port }}</div>
        <div v-if="menuPort && menuPort.status === 'stuck'" class="ctx-item" @click="runAction('focus', menuGrp, menuPort.port)">置顶浏览器</div>
      </div>
    </teleport>
  </div>
</template>


<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useBotInstances } from '../composables/useBotInstances.js'
import { usePorts } from '../composables/usePorts.js'
import { request, authHeaders } from '../utils/request.js'

const authed = ref(!!localStorage.getItem('token'))
const expanded = ref(false)
const { statuses, loadStatus, loading } = useBotInstances()

const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuGrp = ref(null)
const menuPort = ref(null)

const openMenu = (grp, p, e) => {
  menuGrp.value = grp
  menuPort.value = p
  menuVisible.value = true
  const menuW = 180
  const menuH = 40 * 3
  menuX.value = Math.min(e.clientX, window.innerWidth - menuW - 8)
  menuY.value = Math.min(e.clientY, window.innerHeight - menuH - 8)
}

const closeMenu = () => {
  menuVisible.value = false
  menuGrp.value = null
  menuPort.value = null
}

const runAction = async (action, grp, port) => {
  closeMenu()
  const payload = { port }
  if (grp?.id && grp.id !== 'local') payload.instanceId = grp.id
  else if (grp?.ip) payload.ip = grp.ip
  if (grp?.account) payload.account = grp.account
  try {
    const url = action === 'start'
      ? '/api/bot/launch-chrome'
      : action === 'close'
        ? '/api/bot/close-chrome'
        : '/api/bot/focus-chrome'
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload)
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    ElMessage.success(data.message || '操作成功')
    loadStatus()
  } catch (e) {
    ElMessage.error(`${action === 'start' ? '开启' : action === 'close' ? '关闭' : '置顶'}失败: ${e.message}`)
  }
}

const onDocClick = () => closeMenu()

const { ports: legacyPorts, busyCount: legacyBusy } = usePorts()

const groups = computed(() => {
  const list = statuses.value || []
  if (list.length) {
    return list.map(st => ({
      id: st.id,
      name: ['127.0.0.1', 'localhost'].includes(String(st.ip || '')) ? '网站部署机' : st.name,
      ip: st.ip,
      account: st.account,
      online: st.online,
      busy: st.task_running,
      ports: ((st.bot && st.bot.cdp_ports) || [])
        .filter(p => p.port >= 18800 && p.port <= 18804)
        .map(p => ({ ...p, status: !p.alive ? 'off' : (p.stuck ? 'stuck' : 'running'), busy: !!p.busy }))
    }))
  }
  // 未配置实例时兼容旧的单机端口显示
  if (legacyPorts.value && legacyPorts.value.length) {
    return [{
      id: 'local',
      name: '网站部署机 Bot',
      ip: '127.0.0.1',
      account: '',
      online: legacyPorts.value.some(p => p.alive),
      busy: legacyBusy.value > 0,
      ports: legacyPorts.value.filter(p => p.port >= 18800 && p.port <= 18804)
        .map(p => ({ ...p, status: !p.alive ? 'off' : (p.stuck ? 'stuck' : 'running'), busy: !!p.busy }))
    }]
  }
  return []
})

const flatPorts = computed(() => groups.value.flatMap(g => g.ports))
const runningCount = computed(() => flatPorts.value.filter(p => p.status === 'running').length)
const busyCount = computed(() => flatPorts.value.filter(p => p.busy).length)
const stuckCount = computed(() => flatPorts.value.filter(p => p.status === 'stuck').length)
const overall = computed(() => {
  if (stuckCount.value) return 'stuck'
  if (runningCount.value) return 'running'
  return 'off'
})
const statusText = (s) => ({ off: '未开启', running: '运行中', stuck: '验证码' }[s] || s)
const tagType = (s) => ({ off: 'info', running: 'success', stuck: 'warning' }[s] || 'info')
const workText = (p) => p.status === 'running' ? (p.busy ? '工作中' : '空闲') : ''

watch(expanded, (v) => { if (v) loadStatus() })
onMounted(() => {
  document.addEventListener('click', onDocClick)
  loadStatus()
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
})
</script>


<style scoped>
.port-float {
  position: fixed;
  right: 0;
  top: var(--app-float-top, 40%);
  transform: translateY(-50%);
  z-index: 3000;
  display: flex;
  align-items: center;
}

/* 悬浮手柄 */
.handle {
  position: relative;
  width: 36px;
  padding: 14px 0;
  background: var(--app-card-bg, #fff);
  border: 1px solid var(--app-card-border);
  border-right: none;
  border-radius: var(--app-radius-card, 10px) 0 0 var(--app-radius-card, 10px);
  box-shadow: var(--app-card-shadow, 0 2px 8px rgba(0, 0, 0, 0.12));
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  user-select: none;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  transition: background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease, color 0.25s ease;
}
.handle:hover {
  background: var(--app-hover-bg, var(--app-bg));
  border-color: var(--app-accent-line, var(--app-card-border));
}

/* 有端口运行时:手柄绿色呼吸光 */
.handle.glow-running {
  border-color: var(--app-success);
  animation: handle-glow 1.6s ease-in-out infinite;
}

/* 2026-08-08:有端口"工作中"(被询盘任务占用)时:手柄发光改蓝色 */
.handle.glow-busy {
  border-color: var(--app-accent, #409eff);
  animation: handle-glow-busy 1.6s ease-in-out infinite;
}

@keyframes handle-glow {
  0%, 100% {
    box-shadow: var(--app-card-shadow, 0 2px 8px rgba(0, 0, 0, 0.12)), 0 0 6px color-mix(in srgb, var(--app-success, #67c23a) 45%, transparent);
  }
  50% {
    box-shadow: var(--app-card-shadow, 0 2px 8px rgba(0, 0, 0, 0.12)), 0 0 18px color-mix(in srgb, var(--app-success, #67c23a) 80%, transparent);
  }
}

@keyframes handle-glow-busy {
  0%, 100% {
    box-shadow: var(--app-card-shadow, 0 2px 8px rgba(0, 0, 0, 0.12)), 0 0 6px color-mix(in srgb, var(--app-accent, #409eff) 50%, transparent);
  }
  50% {
    box-shadow: var(--app-card-shadow, 0 2px 8px rgba(0, 0, 0, 0.12)), 0 0 18px color-mix(in srgb, var(--app-accent, #409eff) 80%, transparent);
  }
}

/* 验证码红圈徽标(呼吸闪烁) */
.alert-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--app-danger);
  /* 危险色上的文字使用语义对比色,黑色主题下白字在亮红上会看不清 */
  color: var(--app-on-danger, #fff);
  font-size: 12px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  box-shadow: 0 0 6px color-mix(in srgb, var(--app-danger, #f56c6c) 80%, transparent);
  animation: alert-breathe 1.1s ease-in-out infinite;
  z-index: 2;
}

@keyframes alert-breathe {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.35); opacity: 0.75; }
}

.h-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--app-info);
}
.h-dot.running {
  background: var(--app-success);
  box-shadow: 0 0 5px color-mix(in srgb, var(--app-success, #67c23a) 70%, transparent);
}
/* 2026-08-08:有端口"工作中"(被询盘任务占用)时,手柄圆点变蓝色 */
.h-dot.running.busy {
  background: var(--app-accent, #409eff);
  box-shadow: 0 0 5px color-mix(in srgb, var(--app-accent, #409eff) 80%, transparent);
}
.h-dot.stuck {
  background: var(--app-warning);
  box-shadow: 0 0 5px color-mix(in srgb, var(--app-warning, #e6a23c) 70%, transparent);
  animation: h-blink 1.2s ease-in-out infinite;
}

.h-text {
  writing-mode: vertical-lr;
  font-size: 12px;
  color: var(--app-text-secondary);
  letter-spacing: 2px;
}

/* 展开面板 */
.float-panel {
  width: min(320px, calc(100vw - 64px));
  max-height: min(70vh, 620px);
  overflow-y: auto;
  background: var(--app-card-bg, #fff);
  border: 1px solid var(--app-card-border);
  border-radius: var(--app-radius-card, 10px);
  box-shadow: var(--app-card-shadow, 0 4px 16px rgba(0, 0, 0, 0.15)), 0 12px 34px rgba(0, 0, 0, 0.08);
  padding: 12px;
  margin-right: 8px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.fp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 2px 8px;
  border-bottom: 1px solid var(--app-card-header-border, var(--app-border-light, #f0f2f5));
  margin-bottom: 8px;
}
.fp-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-primary);
}

.fp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  border-radius: 6px;
  cursor: default;
}
.fp-row:hover {
  background: var(--app-bg);
}

/* 验证码端口行高亮 */
.fp-row.row-stuck {
  background: color-mix(in srgb, var(--app-danger, #f56c6c) 10%, transparent);
}
.fp-row.row-stuck:hover {
  background: color-mix(in srgb, var(--app-danger, #f56c6c) 16%, transparent);
}
.fp-port {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--app-text-regular);
  flex: 1;
}

/* 工作中/空闲标记(2026-08-06) */
.fp-work {
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 8px;
  color: var(--app-text-secondary, #909399);
  background: var(--app-hover-bg, #f5f7fa);
  flex-shrink: 0;
}

.fp-work.busy {
  color: var(--app-accent, var(--el-color-primary));
  background: var(--app-accent-soft, var(--el-color-primary-light-9, #e8f0fd));
}

.ps-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--app-text-secondary);
}
.ps-dot.running {
  background: var(--app-success);
}
/* 2026-08-08:工作中(被询盘任务占用)的端口圆点变蓝色 */
.ps-dot.running.busy {
  background: var(--app-accent, #409eff);
  box-shadow: 0 0 5px color-mix(in srgb, var(--app-accent, #409eff) 80%, transparent);
}
.ps-dot.stuck {
  background: var(--app-warning);
  animation: h-blink 1.2s ease-in-out infinite;
}
.ps-dot.off {
  background: var(--app-info);
}

.fp-empty {
  padding: 16px 0;
  text-align: center;
  font-size: 12px;
  color: var(--app-text-placeholder);
}

@keyframes h-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* 自绘右键菜单(teleport 到 body,不受面板 overflow 裁剪) */
.ctx-menu {
  position: fixed;
  z-index: 4000;
  min-width: 160px;
  background: var(--app-card-bg, #fff);
  border: 1px solid var(--app-card-border);
  border-radius: var(--app-radius-card, 8px);
  box-shadow: var(--app-card-shadow, 0 4px 16px rgba(0, 0, 0, 0.18));
  padding: 5px;
  user-select: none;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
.ctx-item {
  padding: 8px 12px;
  font-size: 13px;
  color: var(--app-text-primary);
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.ctx-item:hover {
  background: var(--app-bg);
  color: var(--el-color-primary);
}

/* 面板滑出动画:弹性曲线 + 平移缩放,拉出/收起更顺滑 */
/* 展开动画稍缓(0.2s);收起动画干脆(0.12s),避免收起拖沓有延迟感 */
.slide-enter-active {
  transition:
    opacity 0.2s cubic-bezier(0.22, 0.61, 0.36, 1),
    transform 0.2s cubic-bezier(0.22, 0.61, 0.36, 1);
  transform-origin: right center;
}
.slide-leave-active {
  transition:
    opacity 0.12s ease-in,
    transform 0.12s ease-in;
  transform-origin: right center;
}
.slide-enter-from, .slide-leave-to {
  opacity: 0;
  transform: translateX(48px) scale(0.94);
}

/* 手柄展开时的反馈:轻微右移 + 强调色 */
.handle.active {
  background: var(--app-accent-soft, var(--app-hover-bg, #f0f9ff));
  border-color: var(--app-accent-line, var(--el-color-primary));
  box-shadow: var(--app-button-shadow, 0 0 0 1px var(--app-accent-line, transparent));
}
.handle.active .h-text {
  color: var(--app-accent, var(--el-color-primary));
}

/* 按 IP 分组样式 */
.fp-group {
  border: 1px solid var(--app-border-light, #f0f2f5);
  border-radius: var(--app-radius-card, 8px);
  padding: 8px;
  margin-bottom: 8px;
  background: var(--app-bg, #fafafa);
}
.fp-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
}
.fp-group-name {
  color: var(--app-text-primary);
}
.fp-group-ip {
  margin-left: auto;
  color: var(--app-text-secondary);
  font-weight: 400;
}
.fp-group-account {
  font-size: 12px;
  color: var(--app-text-secondary);
  margin-bottom: 4px;
}
.fp-group-empty {
  padding: 8px 0;
  text-align: center;
  font-size: 12px;
  color: var(--app-text-placeholder);
}
</style>
