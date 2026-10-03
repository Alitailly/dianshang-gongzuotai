<template>
  <div class="user-manage">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>用户管理</span>
          <el-button type="primary" @click="openCreate">新建用户</el-button>
        </div>
      </template>

      <el-table :data="users" v-loading="loading" border style="width: 100%">
        <el-table-column prop="username" label="用户名" width="200" />
        <el-table-column prop="name" label="类型姓名" width="200" />
        <el-table-column label="角色" width="140">
          <template #default="{ row }">
            <el-tag :type="row.role === 'admin' ? 'danger' : 'info'">
              {{ row.role === 'admin' ? '管理员' : '普通用户' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="row.status === 'disabled' ? 'danger' : 'success'">
              {{ row.status === 'disabled' ? '已禁用' : '正常' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作">
          <template #default="{ row }">
            <el-button type="primary" link @click="openEdit(row)">编辑</el-button>
            <el-button
              v-if="row.username !== currentUsername"
              :type="row.status === 'disabled' ? 'success' : 'warning'"
              link
              @click="toggleStatus(row)"
            >
              {{ row.status === 'disabled' ? '启用' : '禁用' }}
            </el-button>
            <el-button type="danger" link :disabled="row.username === currentUsername" @click="removeUser(row)">
              {{ row.username === currentUsername ? '当前账号' : '删除' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingUser ? '编辑用户' : '新建用户'" width="480px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="用户名">
          <el-input v-model="form.username" placeholder="登录用户名" :disabled="!!editingUser" />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="form.name" placeholder="显示姓名" />
        </el-form-item>
        <el-form-item :label="editingUser ? '新密码' : '密码'">
          <el-input v-model="form.password" type="password" show-password :placeholder="editingUser ? '留空则不修改' : '登录密码'" />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="form.role">
            <el-radio value="admin">管理员</el-radio>
            <el-radio value="user">普通用户</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="账号状态">
          <el-radio-group v-model="form.status">
            <el-radio value="active">正常</el-radio>
            <el-radio value="disabled">禁用</el-radio>
          </el-radio-group>
          <div class="form-tip">禁用后该账号无法登录,已登录的会被强制退出</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { request, authHeaders } from '../utils/request.js'

const users = ref([])
const loading = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
const editingUser = ref(null)
const currentUsername = ref('')

const form = ref({ username: '', name: '', password: '', role: 'user', status: 'active' })

const loadUsers = async () => {
  loading.value = true
  try {
    const res = await request('/api/users', { headers: authHeaders() })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    users.value = await res.json().then(d => d.users || [])
  } catch (e) {
    ElMessage.error(`加载用户失败: ${e.message}`)
  } finally {
    loading.value = false
  }
}

const openCreate = () => {
  editingUser.value = null
  form.value = { username: '', name: '', password: '', role: 'user', status: 'active' }
  dialogVisible.value = true
}

const openEdit = (user) => {
  editingUser.value = user
  form.value = { username: user.username, name: user.name, password: '', role: user.role, status: user.status || 'active' }
  dialogVisible.value = true
}

const save = async () => {
  if (!form.value.username) {
    ElMessage.warning('请输入用户名')
    return
  }
  if (!editingUser.value && !form.value.password) {
    ElMessage.warning('请输入密码')
    return
  }

  saving.value = true
  try {
    const isEditing = !!editingUser.value
    const res = await request(isEditing ? `/api/users/${encodeURIComponent(editingUser.value.username)}` : '/api/users', {
      method: isEditing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        username: form.value.username,
        name: form.value.name,
        password: form.value.password || undefined,
        role: form.value.role,
        status: form.value.status
      })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }

    const affectedSelf = isEditing && editingUser.value.username === currentUsername.value
    ElMessage.success(isEditing ? '用户已更新' : '用户创建成功')
    dialogVisible.value = false
    await loadUsers()

    if (affectedSelf) {
      // 管理员改了当前账号(用户名/密码),需要重新登录
      ElMessage.warning('当前账号信息已变更,请重新登录')
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      location.href = '/login'
    }
  } catch (e) {
    ElMessage.error(`保存失败: ${e.message}`)
  } finally {
    saving.value = false
  }
}

// 快捷禁用/启用
const toggleStatus = async (user) => {
  const disabling = user.status !== 'disabled'
  if (disabling) {
    try {
      await ElMessageBox.confirm(
        `确定禁用用户「${user.username}」吗?\n禁用后该账号无法登录,若正在登录会被强制退出。`,
        '禁用确认',
        { type: 'warning', confirmButtonText: '禁用', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
  }

  try {
    const res = await request(`/api/users/${encodeURIComponent(user.username)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ status: disabling ? 'disabled' : 'active' })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    ElMessage.success(disabling ? '已禁用该账号' : '已启用该账号')
    await loadUsers()
  } catch (e) {
    ElMessage.error(`操作失败: ${e.message}`)
  }
}

const removeUser = async (user) => {
  try {
    await ElMessageBox.confirm(`确定删除用户「${user.username}」吗?`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }

  try {
    const res = await request(`/api/users/${encodeURIComponent(user.username)}`, {
      method: 'DELETE',
      headers: authHeaders()
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    ElMessage.success('用户已删除')
    await loadUsers()
  } catch (e) {
    ElMessage.error(`删除失败: ${e.message}`)
  }
}

onMounted(() => {
  const user = JSON.parse(localStorage.getItem('user') || '{}')
  currentUsername.value = user.username || ''
  loadUsers()
})
</script>

<style scoped>
.user-manage {
  padding: var(--app-content-padding, 20px);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.form-tip {
  font-size: 12px;
  color: var(--app-text-secondary);
  line-height: 1.5;
  width: 100%;
}
</style>
