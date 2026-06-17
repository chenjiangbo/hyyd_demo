import { ElectronAPI } from '@electron-toolkit/preload'

export interface CaptureConversation {
  id: number
  channel: string
  threadKey: string
  conversationTitle: string | null
  phone: string | null
  orderNo: string | null
  conversationKind: string | null
  isGroup: boolean
  classification: string | null
  firstSeenAt: string | null
  lastSeenAt: string | null
  messageCount: number
  lastMessagePreview: string
}

export interface CaptureMessage {
  id: number
  threadId: number
  senderType: 'self' | 'other' | 'system' | 'unknown'
  senderName: string | null
  content: string
  firstSeenAt: string
  lastSeenAt: string
  seenCount: number
  sourceScreenshotPath: string | null
}

// 【临时·采集调试页】sidecar 原始帧（含 sidecar 结构化成品消息），仅内存、不落库
export interface CaptureDebugMessage {
  speaker: 'self' | 'other' | 'system'
  name?: string | null
  text: string
  kind?: 'time' | 'notice' | 'other' | null
  box?: { x: number; y: number; w: number; h: number } | null
  l?: number | null
  r?: number | null
  decidedBy?: 'position' | 'color' | 'center' | null
}
export interface CaptureDebugFrame {
  type: 'frame'
  channel: 'wxwork' | 'wechat'
  processName: string
  /** 会话标题：聊天区顶行 OCR（取代旧 windowTitle） */
  title?: string | null
  windowTitle?: string | null
  capturedAt: string
  window: { left: number; top: number; width: number; height: number; showState: string }
  screenshotPath: string
  imageHash?: string | null
  ocr: { engine: string; status: 'success' | 'failed'; text: string; blocks: unknown[] }
  keepReason?: string
  diffScore?: number
  conversationKind?: 'group' | 'single' | null
  orderNo?: string | null
  messages?: CaptureDebugMessage[]
  filtered?: boolean
  chatX0?: number | null
  chatX1?: number | null
  inputCutY?: number | null
  inputCut?: {
    sendButtonY?: number | null
    separatorLineY?: number | null
    gapCutY?: number | null
    lastBubbleBottomY?: number | null
    finalCutY?: number | null
    finalReason?: 'separator_line' | 'send_button' | string | null
    removedLineCount?: number
    removedLinePreview?: string[]
  } | null
  droppedBlockCount?: number | null
  structureError?: string | null
  scanY0?: number | null
  scanY1?: number | null
  contactRight?: number | null
  bubbles?: Array<{
    x: number
    y: number
    w: number
    h: number
    area: number
    speaker: 'self' | 'other'
    hasText: boolean
  }> | null
}

export interface DiagLogEntry {
  ts: string
  tag: 'sidecar' | 'insert' | 'structure' | 'upload' | 'error' | 'info'
  msg: string
}

// 现场采集素材（剪贴板粘贴）—— 由 main/material-store.ts 给出的视图行
export type MaterialType = 'text' | 'image'
export type MaterialSyncStatus =
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'failed'
  | 'pending_delete'
  | 'tombstone'

export interface MaterialViewRow {
  id: number
  orderId: number
  type: MaterialType
  textContent: string | null
  imageDataUrl: string | null
  mimeType: string | null
  byteSize: number | null
  syncStatus: MaterialSyncStatus
  remoteUrl: string | null
  createdAt: number
}

export interface MaterialSyncCounts {
  pending: number
  syncing: number
  failed: number
  pendingDelete: number
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      hideWindow: () => void
      minimizeWindow: () => void
      requestWindowClose: () => Promise<void>
      quitApp: () => void
      getWindowPreferences: () => Promise<{ closeBehavior: 'ask' | 'minimize' | 'quit' }>
      setWindowPreferences: (prefs: { closeBehavior: 'ask' | 'minimize' | 'quit' }) => Promise<{ closeBehavior: 'ask' | 'minimize' | 'quit' }>
      setWindowStage: (stage: 'login' | 'main') => void
      getCaptureStatus: () => Promise<unknown>
      getCaptureConversations: (channel?: string) => Promise<CaptureConversation[]>
      getCaptureMessages: (threadId: number) => Promise<CaptureMessage[]>
      getCaptureFrames: (channel?: string, limit?: number) => Promise<unknown[]>
      getCaptureScreenshot: (path: string) => Promise<string | null>
      getCaptureShots: (channel?: string, limit?: number) => Promise<unknown[]>
      clearCaptureShots: () => Promise<{ deleted: number }>
      // 【临时·采集调试页】
      getCaptureDebugFrames: (limit?: number) => Promise<CaptureDebugFrame[]>
      clearCaptureDebugFrames: () => Promise<{ cleared: number }>
      pickCaptureImage: () => Promise<string | null>
      runCaptureOnImage: (imagePath: string, channel?: string) => Promise<CaptureDebugFrame | null>
      getDiagLogs: (limit?: number) => Promise<DiagLogEntry[]>
      clearDiagLogs: () => Promise<{ cleared: number }>
      // 现场采集素材
      materialsAddText: (orderId: number, text: string) => Promise<MaterialViewRow>
      materialsAddImage: (orderId: number, dataUrl: string) => Promise<MaterialViewRow>
      materialsList: (orderId: number) => Promise<MaterialViewRow[]>
      materialsDelete: (id: number) => Promise<{ id: number }>
      materialsStatus: (orderId?: number) => Promise<MaterialSyncCounts>
      materialsRetryFailed: () => Promise<{ retried: number }>
      materialsDiscardFailed: () => Promise<{ discarded: number }>
      materialsSetConfig: (cfg: { backendUrl: string; employeeCode: string }) => Promise<{ ok: boolean }>
      captureSetConfig: (cfg: { backendUrl: string; employeeCode: string }) => Promise<{ ok: boolean }>
      clipboardRead: () => Promise<{ text: string | null; imageDataUrl: string | null }>
    }
  }
}
