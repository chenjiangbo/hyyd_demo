import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * v2（最终功能版）浏览器预览用 vite 配置。
 * 用途：在普通浏览器里跑 v2 renderer 做 UI 开发 —— 这些页面只用 HTTP 调后端，
 * 不依赖 Electron IPC，所以可以脱离 Electron 独立预览，迭代更快。
 * 与采集版（electron.vite.config.ts）完全独立，互不影响。
 *
 * 运行：pnpm --filter tray-app dev:v2   →   打开 http://localhost:5174/index-v2.html
 */
// 预览期把根路径重写到 v2 入口，避免落到采集版（v1）的 index.html
function rootToV2() {
  return {
    name: 'root-to-v2',
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url === '/index.html') req.url = '/index-v2.html'
        next()
      })
    }
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), rootToV2()],
  resolve: {
    alias: { '@v2': resolve(__dirname, 'src/renderer/src/v2') }
  },
  server: { port: 5180, strictPort: false },
  build: {
    rollupOptions: { input: resolve(__dirname, 'src/renderer/index-v2.html') }
  }
})
