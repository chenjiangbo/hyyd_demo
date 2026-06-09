import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrapTheme } from './lib/theme'

// 必须在 React 渲染前应用主题，避免首屏从浅色"闪"成深色
bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
