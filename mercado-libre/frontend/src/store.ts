import { reactive } from 'vue'

export const appState = reactive({
  store: '', // '' 表示全店铺
  refreshKey: 0, // 每次同步完成后 +1，驱动各视图重新拉数据
})

export function setStore(store: string) {
  appState.store = store
}

export function bumpRefresh() {
  appState.refreshKey++
}
