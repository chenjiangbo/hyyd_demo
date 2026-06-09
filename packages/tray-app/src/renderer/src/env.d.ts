/// <reference types="vite/client" />

interface CaptureSidecarStatus {
  enabled: boolean
  running: boolean
  collecting: boolean
  mode: 'disabled' | 'starting' | 'ready' | 'collecting' | 'error'
  targetApps: string[]
  lastError: string | null
  lastFrameAt: string | null
  capturedFrameCount: number
  skippedDuplicateCount: number
  lastTextPreview: string | null
  sidecarPath: string | null
}

interface CaptureConversation {
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

interface CaptureMessage {
  id: number
  threadId: number
  senderType: 'self' | 'other' | 'system' | 'unknown'
  content: string
  firstSeenAt: string
  lastSeenAt: string
  seenCount: number
  sourceScreenshotPath: string | null
}

interface CaptureRectXYWH {
  x: number
  y: number
  width: number
  height: number
}

interface CaptureFrameDebug {
  id: number
  channel: string
  capturedAt: string
  windowWidth: number
  windowHeight: number
  windowShowState: string
  screenshotPath: string
  ocrStatus: string
  ocrText: string
  ocrBlocks: Array<{ text: string; bbox: CaptureRectXYWH; confidence?: number | null }>
  layoutVersionId: number | null
  frameStatus: string
}

interface CaptureLayoutRect {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface CaptureLayoutDebug {
  id: number
  channel: string
  windowWidth: number
  windowHeight: number
  windowShowState: string
  triggerReason: string
  vlmModel: string | null
  vlmConfidence: number | null
  vlmRawResponse: string | null
  regions: {
    sidebar: CaptureLayoutRect | null
    title: CaptureLayoutRect | null
    chat: CaptureLayoutRect | null
    input: CaptureLayoutRect | null
  }
  createdAt: string
}

interface CaptureShot {
  path: string
  fileName: string
  channel: string
  capturedAt: string | null
}

interface AiReconstructMessage {
  sender: string
  name: string | null
  time: string | null
  content: string
  type: string
}

interface AiReconstructResult {
  model: string
  ok: boolean
  error: string | null
  latencyMs: number
  isChat: boolean | null
  conversationTitle: string | null
  messages: AiReconstructMessage[]
  rawContent: string
}

// ─── 现场采集素材（剪贴板粘贴）──────────────────────────────
type MaterialType = 'text' | 'image'
type MaterialSyncStatus =
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'failed'
  | 'pending_delete'
  | 'tombstone'
interface MaterialViewRow {
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
interface MaterialSyncCounts {
  pending: number
  syncing: number
  failed: number
  pendingDelete: number
}

interface Window {
  api?: {
    hideWindow: () => void
    minimizeWindow: () => void
    quitApp: () => void
    getCaptureStatus: () => Promise<CaptureSidecarStatus>
    getCaptureConversations: (channel?: string) => Promise<CaptureConversation[]>
    getCaptureMessages: (threadId: number) => Promise<CaptureMessage[]>
    getCaptureFrames: (channel?: string, limit?: number) => Promise<CaptureFrameDebug[]>
    getCaptureLayout: (id: number) => Promise<CaptureLayoutDebug | null>
    getCaptureScreenshot: (path: string) => Promise<string | null>
    getCaptureShots: (channel?: string, limit?: number) => Promise<CaptureShot[]>
    clearCaptureShots: () => Promise<{ deleted: number }>
    reconstructCaptureAi: (
      inputs: Array<{ path: string; capturedAt: string | null }>,
      models?: string[],
      channel?: string
    ) => Promise<AiReconstructResult[]>
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
