<template>
  <div class="login-container">
    <canvas ref="canvas" class="liquid-canvas"></canvas>
    
    <!-- 顶部深色渐变带(呼应黑空科技顶栏 #1f2329→#2a2f38),白色 Logo 在此 -->
        <div class="login-top">
      <span class="logo-mark">选品</span>
      <div class="brand-copy">
        <h2 class="title">选品助手</h2>
        <p class="subtitle">RPA INQUIRY AUTOMATION</p>
      </div>
    </div>

    <div class="login-box">
      <div class="login-box-head">
        <span class="head-line"></span>
        <span class="head-text">安全登录</span>
        <span class="head-line"></span>
      </div>
      <el-form :model="loginForm" label-width="80px" @submit.prevent="handleLogin">
        <el-form-item label="用户名">
          <el-input v-model="loginForm.username" placeholder="请输入用户名" autocomplete="username"></el-input>
        </el-form-item>
        
        <el-form-item label="密码">
          <el-input v-model="loginForm.password" type="password" placeholder="请输入密码" show-password autocomplete="current-password"></el-input>
        </el-form-item>
        
        <el-form-item>
          <el-button type="primary" @click="handleLogin" style="width: 100%" :loading="loading">登录</el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { initTheme } from '../composables/useTheme.js'

const router = useRouter()
const canvas = ref(null)
let animationId = null
let resizeHandler = null

const loginForm = ref({
  username: '',
  password: ''
})
const loading = ref(false)

const handleLogin = async () => {
  if (!loginForm.value.username || !loginForm.value.password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }

  loading.value = true
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginForm.value),
      signal: controller.signal
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      ElMessage.error(err.error || '登录失败')
      return
    }

    const { token, user } = await res.json()
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(user))
    ElMessage.success('登录成功')
    router.push('/tools') // 登录后默认进入询盘自动化(2026-08-08)
  } catch (error) {
    console.error('登录请求失败:', error)
    ElMessage.error('无法连接服务器,请确认已启动 server.js(npm run server)')
  } finally {
    clearTimeout(timeout)
    loading.value = false
  }
}

let ctx = null
let particles = []
const colors = [
  { r: 37, g: 99, b: 235 },   // 黑空科技品牌蓝 #2563eb
  { r: 85, g: 136, b: 240 },  // light-3 #5588f0
  { r: 59, g: 130, b: 246 },  // 亮蓝
  { r: 96, g: 165, b: 250 },  // 浅蓝
  { r: 147, g: 197, b: 253 }  // 更浅蓝白
]

function createParticles() {
  particles = []
  const w = window.innerWidth
  const h = window.innerHeight
  const cols = 4
  const rows = 3
  const cellW = w / cols
  const cellH = h / rows
  
  for (let i = 0; i < 10; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    particles.push({
      x: col * cellW + cellW / 2 + (Math.random() - 0.5) * cellW * 0.5,
      y: row * cellH + cellH / 2 + (Math.random() - 0.5) * cellH * 0.5,
      radius: 150 + Math.random() * 200,
      color: colors[i % colors.length],
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      alpha: 0.3 + Math.random() * 0.3
    })
  }
}

function draw() {
  if (!ctx) return
  const w = window.innerWidth
  const h = window.innerHeight
  ctx.clearRect(0, 0, w, h)
  
  particles.forEach(p => {
    const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius)
    gradient.addColorStop(0, `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, ${p.alpha})`)
    gradient.addColorStop(1, `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, 0)`)
    
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
    ctx.fillStyle = gradient
    ctx.fill()
  })
}

function update() {
  const w = window.innerWidth
  const h = window.innerHeight
  
  particles.forEach(p => {
    p.x += p.vx
    p.y += p.vy
    
    if (p.x < -p.radius) p.x = w + p.radius
    if (p.x > w + p.radius) p.x = -p.radius
    if (p.y < -p.radius) p.y = h + p.radius
    if (p.y > h + p.radius) p.y = -p.radius
  })
}

let lastFrame = 0
function animate(ts) {
  // 2026-08-12 限帧 ~30fps:每 33ms 才更新/绘制一次,CPU 开销减半,视觉几乎无差
  if (ts - lastFrame >= 33) {
    lastFrame = ts
    update()
    draw()
  }
  animationId = requestAnimationFrame(animate)
}

onMounted(() => {
  // [2026-08-13] 登录页固定黑空科技风格:强制 data-theme=black-air,
  // 使 Element Plus 组件(输入框/按钮/弹层)也按黑空渲染,不随登录后选择的主题变化。
  // 不用 applyTheme(那会写 localStorage 覆盖用户保存的主题);离开时 initTheme() 恢复。
  document.documentElement.setAttribute('data-theme', 'black-air')

  if (canvas.value) {
    canvas.value.width = window.innerWidth
    canvas.value.height = window.innerHeight
    ctx = canvas.value.getContext('2d')
    createParticles()
    animate()
    
    resizeHandler = () => {
      if (canvas.value) {
        canvas.value.width = window.innerWidth
        canvas.value.height = window.innerHeight
        createParticles()
      }
    }
    window.addEventListener('resize', resizeHandler)
  }
})

onUnmounted(() => {
  if (animationId) {
    cancelAnimationFrame(animationId)
  }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler)
    resizeHandler = null
  }
  ctx = null
  // [2026-08-13] 离开登录页(登录成功跳转/返回)时恢复用户保存的主题
  initTheme()
})
</script>

<style scoped>
/* 黑空科技登录页 v5:深空蓝黑底 + 极光粒子 + 白卡片聚焦。 */
.login-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(900px 460px at 50% -12%, rgba(56, 132, 255, 0.22) 0%, transparent 62%),
    radial-gradient(600px 380px at 82% 90%, rgba(34, 211, 238, 0.08) 0%, transparent 58%),
    linear-gradient(165deg, #1f2329 0%, #262c36 48%, #0e1116 100%);
}

.login-container::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(rgba(148, 197, 255, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 197, 255, 0.045) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 40%, #000 0%, transparent 75%);
  pointer-events: none;
}

.liquid-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  opacity: 0.34;
}

.login-top {
  position: relative;
  z-index: 10;
  text-align: center;
  margin-bottom: 30px;
}

.logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 86px;
  height: 42px;
  padding: 0 16px;
  border-radius: 12px;
  color: #fff;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 4px;
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.45), rgba(34, 211, 238, 0.22));
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 10px 24px rgba(37, 99, 235, 0.35);
  animation: logo-float 4s ease-in-out infinite;
}

@keyframes logo-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

.brand-copy {
  margin-top: 14px;
}

.title {
  color: #ffffff;
  margin: 0;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: 4px;
  background: linear-gradient(100deg, #ffffff 0%, #bfdbfe 50%, #67e8f9 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  text-shadow: none;
}

.subtitle {
  margin: 7px 0 0;
  color: rgba(191, 219, 254, 0.62);
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  letter-spacing: 5px;
  text-transform: uppercase;
}

.login-box {
  position: relative;
  z-index: 10;
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 14px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(37, 99, 235, 0.08);
  padding: 30px 38px 26px;
  width: 410px;
  overflow: hidden;
  backdrop-filter: blur(8px);
}

.login-box::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, #2563eb 0%, #22d3ee 50%, transparent 100%);
}

.login-box::after {
  content: '';
  position: absolute;
  right: -60px;
  top: -60px;
  width: 150px;
  height: 150px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(37, 99, 235, 0.1) 0%, transparent 68%);
  pointer-events: none;
}

.login-box-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
}

.head-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(37, 99, 235, 0.28));
}

.head-line:last-child {
  background: linear-gradient(90deg, rgba(37, 99, 235, 0.28), transparent);
}

.head-text {
  font-size: 13px;
  letter-spacing: 4px;
  color: #334155;
  font-weight: 700;
}

:deep(.el-form-item__label) {
  color: #475569;
  font-weight: 600;
}

:deep(.el-input__wrapper) {
  box-shadow: none;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
}

:deep(.el-input__wrapper:hover) {
  border-color: #93c5fd;
  transform: translateY(-1px);
}

:deep(.el-input__wrapper.is-focus) {
  border-color: #2563eb;
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.13);
}

:deep(.el-input__inner) {
  color: #0f172a;
}

:deep(.el-input__inner::placeholder) {
  /* 2026-09-11 对比度审计:白色登录卡上 #94a3b8 仅 2.9:1,加深到 #64748b(≈4.4:1) */
  color: #64748b;
}

:deep(.el-form-item) {
  margin-bottom: 22px;
}

:deep(.el-button--primary) {
  background: linear-gradient(135deg, #2563eb 0%, #0ea5e9 100%);
  border: none;
  border-radius: 10px;
  height: 44px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 6px;
  box-shadow: 0 12px 26px rgba(37, 99, 235, 0.32);
  transition: transform 0.2s, box-shadow 0.2s, filter 0.2s;
}

:deep(.el-button--primary:hover) {
  background: linear-gradient(135deg, #3b82f6 0%, #22d3ee 100%);
  box-shadow: 0 16px 34px rgba(37, 99, 235, 0.42);
  transform: translateY(-2px);
}

:deep(.el-button--primary.is-loading) {
  opacity: 0.85;
}
</style>