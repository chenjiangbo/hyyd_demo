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
    }
  }
}
