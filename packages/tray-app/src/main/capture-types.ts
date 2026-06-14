export type CaptureChannel = 'wxwork' | 'wechat'

export type CaptureSenderType = 'self' | 'other' | 'system' | 'unknown'

export type CaptureRegionType = 'sidebar' | 'title' | 'chat' | 'input' | 'unknown'

export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureOcrBlock {
  text: string
  bbox: CaptureRect
  confidence?: number | null
  // sidecar 在本机采样的气泡填充色（跳过文字后的底色）。供后端结构化判 self/other；采不到为 null。
  colorSample?: { r: number; g: number; b: number } | null
}

export interface CaptureFrameEvent {
  type: 'frame'
  channel: CaptureChannel
  processName: 'WXWork.exe' | 'WeChat.exe' | 'Weixin.exe'
  windowTitle?: string | null
  capturedAt: string
  window: {
    left: number
    top: number
    width: number
    height: number
    showState: 'normal' | 'maximized' | 'minimized'
  }
  screenshotPath: string
  imageHash?: string | null
  ocr: {
    engine: 'windows_ocr'
    status: 'success' | 'failed'
    text: string
    blocks: CaptureOcrBlock[]
  }
  keepReason?: string
  diffScore?: number
  conversationKind?: 'group' | 'single' | null
  orderNo?: string | null
  messages?: CaptureStructuredMessage[]
}

export interface CaptureStructuredMessage {
  speaker: 'self' | 'other' | 'system'
  name?: string | null
  text: string
}

export interface CaptureSidecarStatus {
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
