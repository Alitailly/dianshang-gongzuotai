<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const src = computed(() => {
  const page = route.meta.page || '/overview'
  return `/mercado-app/index.html?embed=1#${page}`
})
</script>

<template>
  <iframe class="mercado-frame" :src="src" title="美客多数据看板"></iframe>
</template>

<style scoped>
.mercado-frame {
  display: block;
  width: 100%;
  height: calc(100vh - var(--app-header-height, 56px));
  height: calc(100dvh - var(--app-header-height, 56px));
  border: 0;
  background: #f0f2f5;
}
</style>
