<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Setting } from '@element-plus/icons-vue'
import { pluginManager } from '../plugins/core/PluginManager.js'
import { request, authHeaders } from '../utils/request.js'

const router = useRouter()
const CUSTOM_PLUGINS_KEY = 'customPlugins'

const selectedName = ref(null)
const showInstallDialog = ref(false)
const disabledPlugins = ref(JSON.parse(localStorage.getItem('disabledPlugins') || '[]'))
const customPlugins = ref(JSON.parse(localStorage.getItem(CUSTOM_PLUGINS_KEY) || '[]'))
const kernelPlugins = ref([])

const installForm = ref({
  name: '',
  version: '',
  type: 'local',
  description: '',
  author: ''
})

const updateDisabledPlugins = (plugins) => {
  disabledPlugins.value = plugins
  localStorage.setItem('disabledPlugins', JSON.stringify(plugins))
}

const updateCustomPlugins = (plugins) => {
  customPlugins.value = plugins
  localStorage.setItem(CUSTOM_PLUGINS_KEY, JSON.stringify(plugins))
}

async function loadKernelPlugins() {
  try {
    const res = await request('/api/kernel/plugins')
    if (!res.ok) return
    const data = await res.json()
    kernelPlugins.value = Array.isArray(data.data) ? data.data : []
  } catch (e) {
    console.warn('[plugins] 读取后端插件目录失败，回退到前端注册表:', e.message)
  }
}

// 打开插件自己的设置页（由 plugin.json 的 settings 声明提供入口）
const openPluginSettings = async (plugin) => {
  const route = plugin?.settings?.route
  if (!route) {
    ElMessage.info('该插件未声明设置入口')
    return
  }
  try {
    await router.push(route)
  } catch (e) {
    ElMessage.error(`打开设置失败：${e.message}`)
  }
}

// 设置门户侧的“对接插件版本”；插件自身版本在插件设置页维护。
const editExpectedVersion = async (plugin) => {
  try {
    const { value } = await ElMessageBox.prompt(
      `插件自身版本为 v${plugin.version}。这里设置门户期望对接的版本；不一致时页面会提示，但不会自动修改插件代码。`,
      `设置「${plugin.title || plugin.name}」对接版本`,
      {
        confirmButtonText: '保存',
        cancelButtonText: '取消',
        inputValue: plugin.expectedVersion || plugin.version,
        inputPattern: /^\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
        inputErrorMessage: '版本号格式不正确，例如 1.2.3 或 1.2.3-beta.1'
      }
    )
    const res = await request(`/api/kernel/plugins/${encodeURIComponent(plugin.name)}/expected-version`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ version: value })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
    ElMessage.success('对接插件版本号已更新')
    await loadKernelPlugins()
  } catch (e) {
    if (e === 'cancel' || e === 'close') return
    ElMessage.error(`保存失败：${e.message || e}`)
  }
}

// 插件列表 = 后端插件目录(含禁用项) + 自定义插件元信息
const allPlugins = computed(() => {
  const builtin = kernelPlugins.value.length
    ? kernelPlugins.value.map((k) => {
        const inst = pluginManager.get(k.name)
        return {
          name: k.name,
          title: k.title || inst?.title || k.name,
          version: k.version || inst?.version || '1.0.0',
          expectedVersion: k.expectedVersion || k.version || '1.0.0',
          versionMatch: typeof k.versionMatch === 'boolean' ? k.versionMatch : true,
          settings: k.settings || null,
          type: inst?.type || 'local',
          description: k.description || inst?.description || '暂无描述',
          enabled: k.enabled !== false,
          author: inst?.author || 'System',
          createdAt: null,
          builtin: true,
          kernel: true,
          loaded: !!k.loaded,
          error: k.error || null,
          // 有没有后端入口：决定是否显示「重载」按钮（纯前端插件没有可重载的后端代码）
          hasBackend: k.hasBackend === true,
          apiMount: k.apiMount || '/api',
        }
      })
    : pluginManager.list().map((p) => ({
        name: p.name,
        title: p.title || p.name,
        version: p.version,
        expectedVersion: p.version,
        versionMatch: true,
        settings: null,
        type: p.type,
        description: p.description || '暂无描述',
        enabled: !disabledPlugins.value.includes(p.name),
        author: p.author || 'Unknown',
        createdAt: null,
        builtin: true,
      }))
  const custom = customPlugins.value.map((p) => ({
    ...p,
    expectedVersion: p.expectedVersion || p.version || '1.0.0',
    versionMatch: true,
    settings: p.settings || null,
    enabled: !disabledPlugins.value.includes(p.name),
    builtin: false,
  }))
  return [...builtin, ...custom]
})

const localPlugins = computed(() => allPlugins.value.filter((p) => p.type === 'local'))

// 详情卡只存名字、用 computed 从 allPlugins 派生（须定义在 allPlugins 之后，避免 TDZ）：
// 直接存对象的话，切换启用状态后 allPlugins 会重算出新对象，
// 而详情卡仍指向旧的那个，界面上的「已启用/已禁用」会一直显示陈旧值。
const selectedPlugin = computed(() => allPlugins.value.find((p) => p.name === selectedName.value) || null)

// 按钮 loading 态必须放在 ref 里：allPlugins 是 computed，
// 它返回的是 getter 里现造的普通对象数组，computed 不会做深层响应式包装，
// 所以原先的 `plugin.loading = true` 根本不会触发重渲染——
// loading 永远不显示，异步期间按钮还能被反复点击。
const toggling = ref({})   // name -> bool
const isToggling = (name) => !!toggling.value[name]
const setToggling = (name, value) => {
  const next = { ...toggling.value }
  if (value) next[name] = true
  else delete next[name]
  toggling.value = next
}

// 重载按钮的 loading 同理（同样不能挂在 plugin 对象上）
const reloading = ref({})  // name -> bool
const isReloading = (name) => !!reloading.value[name]
const setReloading = (name, value) => {
  const next = { ...reloading.value }
  if (value) next[name] = true
  else delete next[name]
  reloading.value = next
}
const reloadingAll = ref(false)

// 热重载插件后端代码：先停旧实例再加载新代码，无需重启门户。
// 只作用于后端；前端插件代码是构建期扫描的，改完仍需 npm run build（dev 模式刷页面即可）。
const reloadPlugin = async (plugin, { silent = false } = {}) => {
  if (isReloading(plugin.name) || isToggling(plugin.name)) return null
  const title = plugin.title || plugin.name
  if (!silent) {
    try {
      await ElMessageBox.confirm(
        `将停止「${title}」的后端服务并重新加载代码：定时器与子进程会重建，期间该插件接口会短暂 404；` +
        `setup() 不会重新执行。前端插件代码的改动仍需 npm run build 后刷新页面。`,
        `重载「${title}」后端`,
        { confirmButtonText: '重载', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return null   // 用户取消
    }
  }
  try {
    setReloading(plugin.name, true)
    const res = await request(`/api/kernel/plugins/${encodeURIComponent(plugin.name)}/reload`, {
      method: 'POST',
      headers: { ...authHeaders() },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
    const data = body.data || {}
    const warns = Array.isArray(data.warnings) ? data.warnings : []
    if (warns.length) {
      // 有边界情况要说明时用更久的 warning，避免用户在 toast 消失后误以为全都生效了
      ElMessage.warning({ message: `「${title}」后端已重载，但：${warns.join('；')}`, duration: 8000 })
    } else {
      ElMessage.success(`「${title}」后端已热重载，立即生效`)
    }
    return data
  } catch (error) {
    // 后端文案已区分「旧版本继续运行」与「插件已停止服务，可再点一次重载恢复」
    ElMessage.error({ message: `重载失败：${error.message}`, duration: 10000 })
    return null
  } finally {
    setReloading(plugin.name, false)
    // 失败也要刷新：插件可能进入 loaded:false / error 非空的状态
    await loadKernelPlugins()
  }
}

// 批量重载所有「已启用且有后端入口」的插件
const reloadAllPlugins = async () => {
  const targets = localPlugins.value.filter((p) => p.kernel && p.hasBackend && p.enabled)
  if (!targets.length) {
    ElMessage.info('没有可重载的后端插件')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将依次重载 ${targets.length} 个后端插件（${targets.map((p) => p.title || p.name).join('、')}）。` +
      `期间这些插件接口会短暂 404。前端插件代码的改动仍需 npm run build 后刷新页面。`,
      '重载全部后端插件',
      { confirmButtonText: '全部重载', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    reloadingAll.value = true
    const res = await request('/api/kernel/plugins/reload-all', {
      method: 'POST',
      headers: { ...authHeaders() },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
    const d = body.data || {}
    const failed = (d.results || []).filter((r) => !r.ok)
    if (failed.length) {
      ElMessage.warning({
        message: `重载完成：成功 ${d.succeeded} 个，失败 ${failed.length} 个（${failed.map((r) => r.name).join('、')}），详见各插件卡片`,
        duration: 8000
      })
    } else {
      ElMessage.success(`已重载 ${d.succeeded} 个插件，立即生效`)
    }
  } catch (error) {
    ElMessage.error(`重载失败：${error.message}`)
  } finally {
    reloadingAll.value = false
    await loadKernelPlugins()
  }
}

// 切换插件状态：后端插件调用内核 API 持久化；自定义插件仅保存本地元信息
const togglePlugin = async (plugin) => {
  if (isToggling(plugin.name)) return   // 防止连点造成的并发启停
  if (isReloading(plugin.name)) return  // 重载中不许启停（后端会拒绝并发操作）
  try {
    setToggling(plugin.name, true)
    const enable = !plugin.enabled

    if (plugin.builtin && plugin.kernel) {
      const res = await request(`/api/kernel/plugins/${encodeURIComponent(plugin.name)}/${enable ? 'enable' : 'disable'}`, {
        method: 'POST',
        headers: { ...authHeaders() },
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)

      const idx = kernelPlugins.value.findIndex((k) => k.name === plugin.name)
      if (idx >= 0) kernelPlugins.value[idx] = { ...kernelPlugins.value[idx], enabled: enable }

      if (enable) {
        updateDisabledPlugins(disabledPlugins.value.filter((name) => name !== plugin.name))
        if (pluginManager.get(plugin.name)) await pluginManager.enable(plugin.name)
      } else {
        updateDisabledPlugins([...new Set([...disabledPlugins.value, plugin.name])])
        if (pluginManager.get(plugin.name)) await pluginManager.disable(plugin.name)
      }
      // 后端已即时生效（禁用会顺带停掉该插件的后台服务）；前端的路由/菜单是启动时注册的，
      // 所以要提示刷新页面，而不是提示"重启门户"（那是不再需要的动作）。
      ElMessage.success(`已${enable ? '启用' : '禁用'}「${plugin.title || plugin.name}」，刷新页面后前端菜单生效`)
    } else if (plugin.enabled) {
      if (plugin.builtin) await pluginManager.disable(plugin.name)
      updateDisabledPlugins([...new Set([...disabledPlugins.value, plugin.name])])
      ElMessage.success(`${plugin.name} 已禁用`)
    } else {
      if (plugin.builtin) await pluginManager.enable(plugin.name)
      updateDisabledPlugins(disabledPlugins.value.filter((name) => name !== plugin.name))
      ElMessage.success(`${plugin.name} 已启用`)
    }
  } catch (error) {
    ElMessage.error(`操作失败: ${error.message}`)
  } finally {
    setToggling(plugin.name, false)
  }
}

const installPlugin = () => {
  if (!installForm.value.name) {
    ElMessage.warning('请输入插件名称')
    return
  }
  if (allPlugins.value.some((p) => p.name === installForm.value.name)) {
    ElMessage.warning('同名插件已存在')
    return
  }

  const newPlugin = {
    name: installForm.value.name,
    version: installForm.value.version || '1.0.0',
    type: installForm.value.type,
    description: installForm.value.description || '暂无描述',
    author: installForm.value.author || 'Unknown',
    createdAt: new Date().toISOString()
  }

  updateCustomPlugins([...customPlugins.value, newPlugin])

  ElMessage.success('插件元信息已保存；如需真实功能，请在 plugins/ 下实现插件')
  showInstallDialog.value = false
  installForm.value = { name: '', version: '', type: 'local', description: '', author: '' }
}

const uninstallPlugin = async (plugin) => {
  const target = plugin || selectedPlugin.value
  if (!target) return

  try {
    await ElMessageBox.confirm(
      `确定卸载插件「${target.name}」吗?
${target.builtin ? '内置插件会删除其代码目录,需重启开发服务器后生效。' : '卸载后需重新安装才能使用。'}`,
      '卸载确认',
      { type: 'warning', confirmButtonText: '卸载', cancelButtonText: '取消' }
    )
  } catch {
    return // 用户取消
  }

  try {
    if (target.builtin) {
      const res = await request('/api/plugins/uninstall', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({ name: target.name })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `请求失败 HTTP ${res.status}`)
      }
      ElMessage.success(`插件「${target.name}」已从项目删除`)
      ElMessage.warning('请重启开发服务器(或重新构建)后生效')
    } else {
      updateCustomPlugins(customPlugins.value.filter((p) => p.name !== target.name))
      ElMessage.success(`${target.name} 卸载成功`)
    }
  } catch (error) {
    ElMessage.error(`卸载失败: ${error.message}`)
    return
  }

  if (selectedName.value === target.name) {
    selectedName.value = null
  }
}

const formatTime = (time) => {
  if (!time) return '-'
  const date = new Date(time)
  return date.toLocaleString('zh-CN')
}

onMounted(loadKernelPlugins)
</script>

<template>
  <div class="plugins">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>插件管理</span>
          <div>
            <el-button :loading="reloadingAll" @click="reloadAllPlugins">重载全部后端插件</el-button>
            <el-button type="primary" @click="showInstallDialog = true">安装插件</el-button>
          </div>
        </div>
      </template>

      <!-- 热重载的作用范围：写成常驻提示而不是 toast，避免用户看完就忘 -->
      <el-alert type="info" :closable="false" show-icon style="margin-bottom: 16px">
        <template #title>
          重载只作用于插件的<b>后端代码</b>（含 routes/、lib/ 等子模块），立即生效、无需重启门户。
        </template>
        <template #default>
          插件 <code>name</code> / <code>api.mount</code> 变更、<code>setup()</code> 里的挂载改动、
          新增或删除插件目录，仍需重启门户；前端插件代码（frontend/index.js）是构建期扫描，
          改完需 <code>npm run build</code>（dev 模式刷新页面即可）。
        </template>
      </el-alert>

      <div class="local-plugins">
        <el-empty v-if="!localPlugins.length" description="暂无本地插件,请点击上方按钮安装" />
        <el-row :gutter="20" v-if="localPlugins.length">
          <el-col :span="8" v-for="plugin in localPlugins" :key="plugin.name">
            <el-card class="plugin-card" shadow="hover" @click="selectedName = plugin.name">
              <div class="plugin-header">
                <div class="plugin-icon local">
                  <el-icon :size="32"><Setting /></el-icon>
                </div>
                <div class="plugin-info">
                  <h3>{{ plugin.title || plugin.name }}</h3>
                  <div class="plugin-tags">
                    <el-tag :type="plugin.enabled ? 'success' : 'info'" size="small">
                      {{ plugin.enabled ? '已启用' : '已禁用' }}
                    </el-tag>
                    <el-tag :type="plugin.versionMatch ? 'success' : 'danger'" size="small" effect="plain">
                      {{ plugin.versionMatch ? '版本一致' : '对接版本不一致' }}
                    </el-tag>
                    <!-- 加载/重载失败的常驻标识：toast 会消失，这里保证刷新页面后仍看得见 -->
                    <el-tag v-if="plugin.kernel && plugin.error" type="danger" size="small" :title="plugin.error">
                      加载失败
                    </el-tag>
                  </div>
                </div>
              </div>
              <p class="plugin-desc">{{ plugin.description }}</p>
              <div class="plugin-versions">
                <span>自身 <code>v{{ plugin.version }}</code></span>
                <span>对接 <code>v{{ plugin.expectedVersion }}</code></span>
              </div>
              <div class="plugin-footer">
                <div>
                  <el-tag v-if="plugin.builtin" size="small" type="warning">内置</el-tag>
                  <el-tag v-else size="small" type="info">自定义</el-tag>
                </div>
                <div class="footer-actions" @click.stop>
                  <el-button v-if="plugin.settings?.route" size="small" plain :disabled="!plugin.enabled || plugin.loaded === false" @click="openPluginSettings(plugin)">插件设置</el-button>
                  <el-button size="small" plain @click="editExpectedVersion(plugin)">对接版本</el-button>
                  <el-button v-if="!plugin.builtin" type="danger" size="small" plain @click="uninstallPlugin(plugin)">卸载</el-button>
                  <el-button
                    v-if="plugin.kernel && plugin.hasBackend && plugin.enabled"
                    size="small"
                    plain
                    :loading="isReloading(plugin.name)"
                    :disabled="isToggling(plugin.name) || reloadingAll"
                    title="重新加载该插件的后端代码（含子模块），无需重启门户"
                    @click="reloadPlugin(plugin)"
                  >
                    重载
                  </el-button>
                  <el-button
                    :type="plugin.enabled ? 'danger' : 'success'"
                    size="small"
                    @click="togglePlugin(plugin)"
                    :loading="isToggling(plugin.name)"
                    :disabled="isReloading(plugin.name) || reloadingAll"
                  >
                    {{ plugin.enabled ? '禁用' : '启用' }}
                  </el-button>
                </div>
              </div>
            </el-card>
          </el-col>
        </el-row>
      </div>
    </el-card>

    <el-card style="margin-top: 20px" v-if="selectedPlugin">
      <template #header>
        <div class="card-header">
          <span>插件详情</span>
          <div>
            <el-button v-if="selectedPlugin.settings?.route" size="small" type="primary" plain :disabled="!selectedPlugin.enabled || selectedPlugin.loaded === false" @click="openPluginSettings(selectedPlugin)">打开插件设置</el-button>
            <el-button type="danger" size="small" @click="uninstallPlugin(selectedPlugin)" v-if="selectedPlugin && !selectedPlugin.builtin">卸载插件</el-button>
          </div>
        </div>
      </template>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="插件名称">{{ selectedPlugin.name }}</el-descriptions-item>
        <el-descriptions-item label="插件自身版本">{{ selectedPlugin.version }}</el-descriptions-item>
        <el-descriptions-item label="对接插件版本">
          <span>{{ selectedPlugin.expectedVersion }}</span>
          <el-tag :type="selectedPlugin.versionMatch ? 'success' : 'danger'" size="small" style="margin-left: 8px">
            {{ selectedPlugin.versionMatch ? '一致' : '不一致' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="selectedPlugin.enabled ? 'success' : 'info'">
            {{ selectedPlugin.enabled ? '已启用' : '已禁用' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="插件类型">
          <el-tag type="warning">本地插件</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="来源">
          {{ selectedPlugin.builtin ? '内置' : '自定义' }}
        </el-descriptions-item>
        <el-descriptions-item label="作者">{{ selectedPlugin.author }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatTime(selectedPlugin.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="描述" :span="2">{{ selectedPlugin.description }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-dialog v-model="showInstallDialog" title="安装插件" width="500px">
      <el-form :model="installForm" label-width="100px">
        <el-form-item label="插件名称">
          <el-input v-model="installForm.name" placeholder="请输入插件名称" />
        </el-form-item>
        <el-form-item label="插件版本">
          <el-input v-model="installForm.version" placeholder="如: 1.0.0" />
        </el-form-item>
        <el-form-item label="插件描述">
          <el-input v-model="installForm.description" type="textarea" rows="3" placeholder="请输入插件描述" />
        </el-form-item>
        <el-form-item label="作者">
          <el-input v-model="installForm.author" placeholder="请输入作者名称" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showInstallDialog = false">取消</el-button>
        <el-button type="primary" @click="installPlugin">安装</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.plugins {
  padding: var(--app-content-padding, 20px);
  width: 100%;
  max-width: var(--app-page-max-width, 1600px);
  margin: 0 auto;
  min-width: 0;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.plugin-card {
  margin-bottom: 20px;
  height: calc(100% - 20px);
  cursor: pointer;
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.plugin-card:hover {
  border-color: var(--app-card-hover-border, var(--el-color-primary-light-7));
}

.plugin-header {
  display: flex;
  align-items: center;
  margin-bottom: 15px;
}

.plugin-icon {
  width: 50px;
  height: 50px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 随主题强调色使用对比文字色,浅粉/浅金主题下白字不再糊在底色里 */
  color: var(--app-accent-contrast, #fff);
  margin-right: 15px;
}

.plugin-icon.local {
  background: linear-gradient(135deg, var(--app-accent, #2563eb) 0%, var(--app-accent-2, #22d3ee) 100%);
  border-radius: var(--app-tool-icon-radius, 10px);
  box-shadow: var(--app-button-shadow, 0 8px 18px rgba(0, 0, 0, 0.12));
}

.plugin-info h3 {
  margin: 0 0 5px 0;
  font-size: 16px;
  color: var(--app-text-primary, #303133);
  overflow-wrap: anywhere;
}

.plugin-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.plugin-versions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 6px 0 0;
  color: var(--app-text-secondary, #606266);
  font-size: 12px;
}
.plugin-versions code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--app-hover-bg, #f5f7fa);
  border: 1px solid var(--app-card-border, #e8eaef);
  font-family: var(--app-font-mono, monospace);
}

.plugin-desc {
  color: var(--app-text-regular);
  font-size: 13px;
  margin: 10px 0;
  line-height: 1.5;
  height: 40px;
  overflow: hidden;
}

.plugin-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 15px;
  padding-top: 15px;
  border-top: 1px solid var(--app-border-light);
  gap: 10px;
  flex-wrap: wrap;
}

.footer-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 560px) {
  .plugins { padding: 10px; }
  .plugin-header { align-items: flex-start; }
  .plugin-footer { align-items: flex-start; }
  .footer-actions { width: 100%; }
  .footer-actions .el-button { flex: 1; margin-left: 0; }
}
</style>
