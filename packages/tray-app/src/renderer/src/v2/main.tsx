import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/900.css'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import DesktopReminderWindowView from './components/DesktopReminderWindowView'
import { initTheme } from './lib/theme'

// 启动即应用上次选择的主题（避免浅色闪一下）
initTheme()

const isDesktopReminder = new URLSearchParams(window.location.search).get('view') === 'desktop-reminder'

createRoot(document.getElementById('v2-root')!).render(
  <StrictMode>
    {isDesktopReminder ? <DesktopReminderWindowView /> : <App />}
  </StrictMode>
)
