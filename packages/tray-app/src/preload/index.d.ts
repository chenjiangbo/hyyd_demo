import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      hideWindow: () => void
      minimizeWindow: () => void
      quitApp: () => void
    }
  }
}
