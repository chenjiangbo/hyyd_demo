import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // 桌面应用现在加载 v2（新采集工具 UI）。v1 的 index.html 保留作浏览器参考，
        // 不再作为 Electron 入口。
        input: resolve('src/renderer/index-v2.html')
      }
    }
  }
})
