import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initTheme } from './lib/theme'

// 启动即应用上次选择的主题（避免浅色闪一下）
initTheme()

createRoot(document.getElementById('v2-root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
