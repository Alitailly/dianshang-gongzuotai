<template>
  <header class="page-header">
    <div class="page-header-main">
      <el-button
        v-if="back"
        class="page-back"
        text
        circle
        aria-label="返回"
        @click="goBack"
      >
        <el-icon :size="16"><ArrowLeft /></el-icon>
      </el-button>
      <div class="page-header-text">
        <h1 class="page-title">
          <span>{{ title }}</span>
          <slot name="title-extra" />
        </h1>
        <p v-if="subtitle || $slots.subtitle" class="page-subtitle">
          <slot name="subtitle">{{ subtitle }}</slot>
        </p>
      </div>
    </div>
    <div v-if="$slots.actions" class="page-header-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup>
// 页面级标题栏：标题 + 一句话说明 + 右侧操作区；back 传路径时显示返回按钮
import { useRouter } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'

const props = defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  back: { type: [String, Object], default: '' },
})

const router = useRouter()
const goBack = () => router.push(props.back)
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding-bottom: 4px;
}

.page-header-main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.page-back {
  flex: none;
  width: 32px;
  height: 32px;
  min-height: 32px !important;
  margin-top: 1px;
  padding: 0 !important;
  border: 1px solid var(--app-border, #e8eaef) !important;
  background: var(--app-card-bg, #fff) !important;
  color: var(--app-text-regular, #606266);
}

.page-back:hover {
  border-color: var(--app-accent-line, var(--el-color-primary-light-5)) !important;
  color: var(--app-accent, var(--el-color-primary)) !important;
}

.page-header-text { min-width: 0; }

.page-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0;
  font-family: var(--app-font-display, inherit);
  font-size: 22px;
  font-weight: 700;
  line-height: 32px;
  letter-spacing: 0.5px;
  color: var(--app-text-primary, #303133);
}

.page-subtitle {
  margin: 4px 0 0;
  max-width: 760px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--app-text-secondary, #5f6774);
}

.page-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 768px) {
  .page-title { font-size: 19px; line-height: 28px; }
}
</style>
