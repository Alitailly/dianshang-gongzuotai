import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [
    vue(),
    // Element Plus 按需引入:API(ElMessage 等)自动导入并带样式
    AutoImport({
      imports: ['vue', 'vue-router'],
      resolvers: [ElementPlusResolver()],
      dts: false
    }),
    // 模板中的 el-* 组件自动按需注册
    Components({
      resolvers: [ElementPlusResolver()],
      dts: false
    })
  ],
  server: {
    port: 5173, // 生产 server.js 占用 5055,dev 用 5173 避免端口冲突
    proxy: {
      // 开发环境将 /api 转发到 server.js
      '/api': {
        target: 'http://localhost:5055',
        changeOrigin: true
      },
      // 首轮询盘候选图片本地缓存(服务端下载后静态托管,见 server/routes/bot.js)
      '/pick-imgs': {
        target: 'http://localhost:5055',
        changeOrigin: true
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        // [2026-08-13] vendor 拆独立 chunk:vue/element-plus 变更频率远低于业务代码,
        // 独立后浏览器可长期缓存,改业务代码时只重新下载业务 chunk
        manualChunks: {
          'vendor-vue': ['vue', 'vue-router'],
          'vendor-element': ['element-plus', '@element-plus/icons-vue']
        }
      }
    }
  }
})
