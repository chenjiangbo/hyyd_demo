import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 开发期：vite dev server 跑 5174（base '/'），/api 与 /ws 反向代理到 backend 13000。
// 生产期：build 产物由 Fastify @fastify/static 挂在 /admin/* 下，
// 所以 base 用 '/admin/'，前端路由 basename 同步成 '/admin'（见 main.tsx）。
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/admin/' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:13000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:13000',
        ws: true
      }
    }
  }
}))
