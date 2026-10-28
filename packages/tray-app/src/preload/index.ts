import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { NativeChatPendingImageMatch, PetDropImageMatch } from '@huanyu/shared-types'

// 暴露给渲染进程的最小 API
const api = {
  showWindow: () => ipcRenderer.send('window:show'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  setAuthenticated: (value: boolean) => ipcRenderer.send('session:set-authenticated', value),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  requestWindowClose: () => ipcRenderer.invoke('window:request-close'),
  quitApp: () => ipcRenderer.send('app:quit'),
  hidePet: () => ipcRenderer.send('pet:hide'),
  showPetPanel: (panel: unknown): Promise<void> => ipcRenderer.invoke('pet:panel-show', panel),
  getPetPanel: (): Promise<unknown | null> => ipcRenderer.invoke('pet:panel-current'),
  updatePetPanel: (panelId: string, panel: unknown): Promise<void> => ipcRenderer.invoke('pet:panel-update', panelId, panel),
  hidePetPanel: (): Promise<void> => ipcRenderer.invoke('pet:panel-hide'),
  onPetPanel: (cb: (panel: unknown | null) => void): (() => void) => {
    const show = (_e: unknown, panel: unknown): void => cb(panel)
    const hide = (): void => cb(null)
    ipcRenderer.on('pet:panel-show', show)
    ipcRenderer.on('pet:panel-hide', hide)
    return () => { ipcRenderer.removeListener('pet:panel-show', show); ipcRenderer.removeListener('pet:panel-hide', hide) }
  },
  onPetPanelVisibility: (cb: (visible: boolean) => void): (() => void) => {
    const listener = (_e: unknown, visible: boolean): void => cb(visible)
    ipcRenderer.on('pet:panel-visibility', listener)
    return () => ipcRenderer.removeListener('pet:panel-visibility', listener)
  },
  sendPetPanelAction: (event: { panelId: string; actionId: string; fields?: Record<string, unknown> }): void =>
    ipcRenderer.send('pet:panel-action', event),
  petOrderDictionary: (kind: string, query = '', parent?: { hospitalId?: string; departmentId?: string; currentId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('pet:order-dictionary', kind, query, parent),
  onPetPanelAction: (cb: (event: { panelId: string; actionId: string; fields?: Record<string, unknown> }) => void): (() => void) => {
    const listener = (_e: unknown, event: { panelId: string; actionId: string; fields?: Record<string, unknown> }): void => cb(event)
    ipcRenderer.on('pet:panel-action', listener)
    return () => ipcRenderer.removeListener('pet:panel-action', listener)
  },
  petDebugLog: (payload: unknown): void => ipcRenderer.send('pet:debug-log', payload),
  getPetBounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
    ipcRenderer.invoke('pet:get-bounds'),
  movePet: (x: number, y: number): void => ipcRenderer.send('pet:move', x, y),
  setPetExpanded: (expanded: boolean): Promise<{ bubbleSide: 'left' | 'right' }> =>
    ipcRenderer.invoke('pet:set-expanded', expanded),
  setPetBubbleSize: (size: { width: number; height: number }): Promise<{ bubbleSide: 'left' | 'right' }> =>
    ipcRenderer.invoke('pet:set-bubble-size', size),
  setPetMobileStatus: (status: { state: 'online' | 'stale' | 'unknown'; lastSeenAt: string | null; needsOpen: boolean }): void =>
    ipcRenderer.send('pet:mobile-status', status),
  onPetMobileStatus: (cb: (status: { state: 'online' | 'stale' | 'unknown'; lastSeenAt: string | null }) => void): (() => void) => {
    const listener = (_e: unknown, status: { state: 'online' | 'stale' | 'unknown'; lastSeenAt: string | null }): void => cb(status)
    ipcRenderer.on('pet:mobile-status', listener)
    return () => ipcRenderer.removeListener('pet:mobile-status', listener)
  },
  onPetReminder: (cb: (message: string) => void): (() => void) => {
    const listener = (_e: unknown, message: string): void => cb(message)
    ipcRenderer.on('pet:mobile-reminder', listener)
    return () => ipcRenderer.removeListener('pet:mobile-reminder', listener)
  },
  showPetReminder: (data: { key: string; message: string }): void => ipcRenderer.send('pet:order-reminder', data),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  petDropFiles: (paths: string[]) => ipcRenderer.invoke('pet:drop-files', paths),
  petSelectOrder: (orderId: number, applicationNo?: string) => ipcRenderer.invoke('pet:select-order', { orderId, applicationNo }),
  petDiscardPendingImage: () => ipcRenderer.invoke('pet:discard-pending-image'),
  resolveNativeImageMatch: (payload: { attachmentId: number; applicationNo: string; orderId: number | null }) => ipcRenderer.invoke('pet:resolve-native-image-match', payload),
  onPetImageMatch: (cb: (match: NativeChatPendingImageMatch) => void): (() => void) => {
    const listener = (_e: unknown, match: NativeChatPendingImageMatch): void => cb(match)
    ipcRenderer.on('pet:image-match', listener)
    return () => ipcRenderer.removeListener('pet:image-match', listener)
  },
  onPetStatus: (cb: (status: { state: 'done' | 'unknown' | 'candidates' | 'warning'; message: string; candidates?: unknown[]; imageMatch?: PetDropImageMatch }) => void): (() => void) => {
    const listener = (_e: unknown, status: { state: 'done' | 'unknown' | 'candidates' | 'warning'; message: string; candidates?: unknown[]; imageMatch?: PetDropImageMatch }): void => cb(status)
    ipcRenderer.on('pet:status', listener)
    return () => ipcRenderer.removeListener('pet:status', listener)
  },
  // 自绘标题栏：最大化切换 + 查询是否最大化 + 订阅状态变化
  maximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  // 登录态用小窗、登录后放大到工作台尺寸
  setWindowStage: (stage: 'login' | 'main') => ipcRenderer.send('window:set-stage', stage),
  onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, v: boolean): void => cb(v)
    ipcRenderer.on('window:maximized-changed', listener)
    return () => ipcRenderer.removeListener('window:maximized-changed', listener)
  },
  getWindowPreferences: () => ipcRenderer.invoke('window:get-preferences'),
  setWindowPreferences: (prefs: { closeBehavior: 'ask' | 'minimize' | 'quit' }) =>
    ipcRenderer.invoke('window:set-preferences', prefs),
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
  // 【临时·采集调试页】最近原始帧（含结构化 messages/orderNo/conversationKind）
  getCaptureDebugFrames: (limit?: number) => ipcRenderer.invoke('capture:debug-frames', limit),
  clearCaptureDebugFrames: () => ipcRenderer.invoke('capture:debug-clear'),
  // 调试：上传一张本地图片跑结构化（pickCaptureImage 选文件 → runCaptureOnImage 跑并注入调试帧）
  pickCaptureImage: () => ipcRenderer.invoke('capture:pick-image'),
  runCaptureOnImage: (imagePath: string, channel?: string) =>
    ipcRenderer.invoke('capture:run-on-image', imagePath, channel),
  getDiagLogs: (limit?: number) => ipcRenderer.invoke('capture:diag-logs', limit),
  clearDiagLogs: () => ipcRenderer.invoke('capture:diag-clear'),
  reconstructCaptureAi: (
    inputs: Array<{ path: string; capturedAt: string | null }>,
    models?: string[],
    channel?: string
  ) => ipcRenderer.invoke('capture:ai-reconstruct', inputs, models, channel),

  // 现场采集素材（剪贴板粘贴）
  materialsAddText: (orderId: number, text: string) =>
    ipcRenderer.invoke('materials:add-text', orderId, text),
  materialsAddImage: (orderId: number, dataUrl: string) =>
    ipcRenderer.invoke('materials:add-image', orderId, dataUrl),
  materialsList: (orderId: number) => ipcRenderer.invoke('materials:list', orderId),
  materialsDelete: (id: number) => ipcRenderer.invoke('materials:delete', id),
  materialsStatus: (orderId?: number) => ipcRenderer.invoke('materials:status', orderId),
  materialsRetryFailed: () => ipcRenderer.invoke('materials:retry-failed'),
  materialsDiscardFailed: () => ipcRenderer.invoke('materials:discard-failed'),
  materialsSetConfig: (cfg: { backendUrl: string; employeeCode: string }) =>
    ipcRenderer.invoke('materials:set-config', cfg),
  captureSetConfig: (cfg: { backendUrl: string; employeeCode: string }) =>
    ipcRenderer.invoke('capture:set-config', cfg),
  setCaptureSaveDebug: (value: boolean) =>
    ipcRenderer.invoke('capture:set-save-debug', value),

  // 系统剪贴板（Electron 原生，绕过 navigator.clipboard 焦点限制）
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),

  // 桌面右下角到期提醒原生浮窗
  showDesktopReminder: (data: unknown) => ipcRenderer.invoke('reminder:show', data),
  hideDesktopReminder: (dismissCurrent = false) => ipcRenderer.invoke('reminder:hide', dismissCurrent),
  resizeDesktopReminder: (dims: { width?: number; height?: number }) =>
    ipcRenderer.invoke('reminder:resize', dims),
  getCurrentReminder: () => ipcRenderer.invoke('reminder:get-current'),
  onReminderData: (cb: (data: unknown) => void): (() => void) => {
    const listener = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on('reminder:data', listener)
    return () => ipcRenderer.removeListener('reminder:data', listener)
  }
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
