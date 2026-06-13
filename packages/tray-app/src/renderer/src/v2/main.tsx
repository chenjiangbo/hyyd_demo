import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('v2-root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
