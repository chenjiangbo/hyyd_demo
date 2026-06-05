import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 暴露给渲染进程的最小 API
const api = {
  hideWindow: () => ipcRenderer.send('window:hide'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  quitApp: () => ipcRenderer.send('app:quit'),
  getCaptureStatus: () => ipcRenderer.invoke('capture:status'),
  // 本地采集库读取（企微/微信会话与消息）
  getCaptureConversations: (channel?: string) =>
    ipcRenderer.invoke('capture:conversations', channel),
  getCaptureMessages: (threadId: number) => ipcRenderer.invoke('capture:messages', threadId),
  // 采集调试
  getCaptureFrames: (channel?: string, limit?: number) =>
    ipcRenderer.invoke('capture:frames', channel, limit),
  getCaptureLayout: (id: number) => ipcRenderer.invoke('capture:layout', id),
  getCaptureScreenshot: (path: string) => ipcRenderer.invoke('capture:screenshot', path),
  // 截图验证
  getCaptureShots: (channel?: string, limit?: number) =>
    ipcRenderer.invoke('capture:shots', channel, limit),
  clearCaptureShots: () => ipcRenderer.invoke('capture:clear-shots'),
  reconstructCaptureAi: (
    inputs: Array<{ path: string; capturedAt: string | null }>,
    models?: string[],
    channel?: string
  ) => ipcRenderer.invoke('capture:ai-reconstruct', inputs, models, channel)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
