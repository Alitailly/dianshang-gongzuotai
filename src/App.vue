<template>
  <el-config-provider :locale="zhCn">
    <router-view></router-view>
    <!-- 2026-08-12 安全修复:登录页不显示端口悬浮球(未登录不可见/不可操作端口) -->
    <PortFloatBall v-if="!isLoginPage" />
    <!-- 左侧电子书悬浮窗(epub) -->
    <EbookDrawer v-if="!isLoginPage" />
  </el-config-provider>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import PortFloatBall from './components/PortFloatBall.vue'
import EbookDrawer from './components/EbookDrawer.vue'

const route = useRoute()
const isLoginPage = computed(() => route.path === '/login')
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: var(--app-font, Arial, sans-serif);
}

#app {
  width: 100%;
  min-height: 100vh;
}
</style>
