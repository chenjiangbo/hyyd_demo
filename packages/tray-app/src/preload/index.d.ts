import { ElectronAPI } from '@electron-toolkit/preload'

export interface CaptureConversation {
  id: number
  channel: string
  threadKey: string
  conversationTitle: string | null
  phone: string | null
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
  content: string
  firstSeenAt: string
  lastSeenAt: string
  seenCount: number
  sourceScreenshotPath: string | null
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
      quitApp: () => void
      getCaptureStatus: () => Promise<unknown>
      getCaptureConversations: (channel?: string) => Promise<CaptureConversation[]>
      getCaptureMessages: (threadId: number) => Promise<CaptureMessage[]>
      // 现场采集素材
      materialsAddText: (orderId: number, text: string) => Promise<MaterialViewRow>
      materialsAddImage: (orderId: number, dataUrl: string) => Promise<MaterialViewRow>
      materialsList: (orderId: number) => Promise<MaterialViewRow[]>
      materialsDelete: (id: number) => Promise<{ id: number }>
      materialsStatus: (orderId?: number) => Promise<MaterialSyncCounts>
      materialsRetryFailed: () => Promise<{ retried: number }>
      materialsDiscardFailed: () => Promise<{ discarded: number }>
      materialsSetConfig: (cfg: { backendUrl: string; employeeCode: string }) => Promise<{ ok: boolean }>
      clipboardRead: () => Promise<{ text: string | null; imageDataUrl: string | null }>
    }
  }
}
