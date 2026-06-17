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
  /** 会话标题：sidecar 从聊天区顶行 OCR 得到（= 会话名/群名）。取代旧的 GetWindowText windowTitle。 */
  title?: string | null
  /** @deprecated 旧字段，sidecar 不再发送；保留仅为向后兼容老数据。新代码用 title。 */
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
    engine: 'windows_ocr' | 'windows'
    status: 'success' | 'failed'
    text: string
    blocks: CaptureOcrBlock[]
  }
  keepReason?: string
  diffScore?: number
  conversationKind?: 'group' | 'single' | null
  orderNo?: string | null
  /** sidecar 分区+拼行+判说话人后的成品消息（后端不再二次结构化）。 */
  messages?: CaptureStructuredMessage[]
  /** 非客户会话过滤掉的帧：仅供调试页查看截图/OCR，不入库、不上报。 */
  filtered?: boolean
  // ── 调试元数据（仅采集调试页用；入库/上报时忽略）──
  chatX0?: number | null
  chatX1?: number | null
  inputCutY?: number | null
  inputCut?: CaptureInputCutDebug | null
  droppedBlockCount?: number | null
  /** 结构化失败时的异常文本（含堆栈）。非空表示分区/气泡检测抛了异常，messages 为空，原图+OCR 仍保留。 */
  structureError?: string | null
  /** 气泡扫描带上/下沿 Y。 */
  scanY0?: number | null
  scanY1?: number | null
  /** 联系人列表右界（chatX0 = 此 + padding）。 */
  contactRight?: number | null
  /** 检测到的所有气泡连通域（含没有文字的空气泡），供「气泡」视图独立查看。 */
  bubbles?: CaptureDebugBubble[] | null
}

export interface CaptureDebugBubble {
  x: number
  y: number
  w: number
  h: number
  area: number
  speaker: 'self' | 'other'
  hasText: boolean
}

export interface CaptureInputCutDebug {
  sendButtonY?: number | null
  separatorLineY?: number | null
  gapCutY?: number | null
  lastBubbleBottomY?: number | null
  finalCutY?: number | null
  finalReason?: 'separator_line' | 'send_button' | string | null
  removedLineCount?: number
  removedLinePreview?: string[]
}

export interface CaptureStructuredMessage {
  speaker: 'self' | 'other' | 'system'
  name?: string | null
  text: string
  /** system 消息细分：'time'(时间锚点,保留) / 'notice'(群通知,可忽略) / 'other'；非 system 为 undefined。 */
  kind?: 'time' | 'notice' | 'other' | null
  // ── 调试元数据（仅调试页用）──
  box?: { x: number; y: number; w: number; h: number } | null
  l?: number | null
  r?: number | null
  decidedBy?: 'position' | 'color' | 'center' | null
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
