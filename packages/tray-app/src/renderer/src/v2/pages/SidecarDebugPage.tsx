import { useCallback, useEffect, useMemo, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiagEntry {
  ts: string
  tag: 'sidecar' | 'insert' | 'structure' | 'upload' | 'error' | 'info'
  msg: string
}

interface DbgMessage {
  speaker: 'self' | 'other' | 'system'
  name?: string | null
  text: string
  kind?: 'time' | 'notice' | 'other' | null
  box?: { x: number; y: number; w: number; h: number } | null
  l?: number | null
  r?: number | null
  decidedBy?: 'position' | 'color' | 'center' | 'bubble' | null
}

interface OcrBlock {
  text: string
  bbox: { x: number; y: number; width: number; height: number }
  confidence?: number | null
  colorSample?: { R?: number; G?: number; B?: number; r?: number; g?: number; b?: number } | null
}

interface DbgFrame {
  channel: 'wxwork' | 'wechat'
  processName: string
  title?: string | null
  windowTitle?: string | null
  capturedAt: string
  window: { width: number; height: number; showState: string }
  screenshotPath: string
  ocr: { status: 'success' | 'failed'; text: string; blocks: OcrBlock[] }
  keepReason?: string
  diffScore?: number
  conversationKind?: 'group' | 'single' | null
  orderNo?: string | null
  messages?: DbgMessage[]
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
  bubbles?: Array<{ x: number; y: number; w: number; h: number; area: number; speaker: 'self' | 'other'; hasText: boolean }> | null
}

interface SidecarStatus {
  enabled: boolean
  running: boolean
  collecting: boolean
  mode: string
  lastError: string | null
  capturedFrameCount: number
  skippedDuplicateCount: number
}

type SessionResult = 'dedup_skip' | 'typing_skip' | 'filtered' | 'kept' | 'pending'

interface CaptureSession {
  id: string
  ts: string
  channel: 'wechat' | 'wxwork' | 'unknown'
  windowTitle: string
  windowSize: string
  trigger: string
  result: SessionResult
  // step: dedup
  dedupDiff?: number
  // step: ocr
  ocrStatus?: 'success' | 'failed'
  ocrCharCount?: number
  ocrPreview?: string
  ocrBlank?: boolean
  // step: filter
  orderNo?: string
  convKind?: 'group' | 'single'
  // step: keep
  keepDiff?: number
  keepReason?: string
  screenshotPath?: string
  // step: ts insert
  insertDuplicate?: boolean
  newMessageCount?: number
  insertOrderNo?: string
  // step: structure
  structureInfo?: string
  // step: upload
  uploads: Array<{ ok: boolean; line: string }>
  // linked debug frame (for screenshot + full OCR + messages)
  dbgFrame?: DbgFrame
}

type CaptureApi = {
  getCaptureStatus: () => Promise<SidecarStatus>
  getCaptureDebugFrames: (limit?: number) => Promise<DbgFrame[]>
  clearCaptureDebugFrames: () => Promise<{ cleared: number }>
  getCaptureScreenshot: (path: string) => Promise<string | null>
  getDiagLogs: (limit?: number) => Promise<DiagEntry[]>
  clearDiagLogs: () => Promise<{ cleared: number }>
  pickCaptureImage: () => Promise<string | null>
  runCaptureOnImage: (imagePath: string, channel?: string) => Promise<DbgFrame | null>
}

function getApi(): CaptureApi | null {
  const api = (window as unknown as { api?: Partial<CaptureApi> }).api
  return api && typeof api.getDiagLogs === 'function' ? (api as CaptureApi) : null
}

// ─── Log parser → structured sessions ────────────────────────────────────────
//
// diagLog is newest-first; we reverse to oldest-first, then walk through and
// group consecutive sidecar/insert/structure/upload lines into "sessions" —
// one session = one screenshot attempt (trigger → dedup → ocr → filter/keep →
// insert → structure → upload).

function parseSessions(logs: DiagEntry[], frames: DbgFrame[]): CaptureSession[] {
  const oldest = [...logs].reverse()

  // rolling window context from "命中目标窗口" log lines
  let winTitle = ''
  let winChannel: CaptureSession['channel'] = 'unknown'
  let winSize = ''

  let cur: CaptureSession | null = null
  const sessions: CaptureSession[] = []
  let idN = 0

  const flush = (): void => {
    if (cur) { sessions.push(cur); cur = null }
  }

  const mkSession = (ts: string, result: SessionResult, trigger: string): CaptureSession => ({
    id: `${ts}-${idN++}`,
    ts,
    channel: winChannel,
    windowTitle: winTitle,
    windowSize: winSize,
    trigger,
    result,
    uploads: [],
  })

  for (const { ts, tag, msg } of oldest) {
    if (tag === 'sidecar') {
      let m: RegExpMatchArray | null

      // ① Window context update (not a capture attempt itself)
      // Format: 命中目标窗口 [channel] "title" WxH
      m = msg.match(/^命中目标窗口 \[(\w+)\] "(.+?)" (\d+x\d+)/)
      if (m) {
        winChannel = m[1] === 'wechat' ? 'wechat' : m[1] === 'wxwork' ? 'wxwork' : 'unknown'
        winTitle = m[2]
        winSize = m[3]
        continue
      }

      // ② Typing skip — instantaneous, no further steps
      if (msg.startsWith('打字中，跳过兜底定时截图')) {
        flush()
        sessions.push(mkSession(ts, 'typing_skip', 'interval'))
        continue
      }

      // ③ Dedup skip — instantaneous, no further steps
      // Format: 跳过·近似重复 diff=X.XXX（reason=Y）
      m = msg.match(/^跳过·近似重复 diff=([0-9.]+)（reason=(\w+)）/)
      if (m) {
        flush()
        const s = mkSession(ts, 'dedup_skip', m[2] ?? 'unknown')
        s.dedupDiff = parseFloat(m[1])
        sessions.push(s)
        continue
      }

      // ④ Blank screen warning (attaches to ongoing attempt)
      if (msg.startsWith('⚠️') && cur) {
        cur.ocrBlank = true
        continue
      }

      // ⑤ OCR result — starts a new screenshot attempt
      // Format: OCR[success] 143字: preview text...
      m = msg.match(/^OCR\[(success|failed)\] (\d+)字: (.*)/)
      if (m) {
        flush()
        cur = mkSession(ts, 'pending', 'unknown')
        cur.ocrStatus = m[1] as 'success' | 'failed'
        cur.ocrCharCount = parseInt(m[2])
        cur.ocrPreview = m[3].trim()
        continue
      }

      // ⑥ Customer filter: failed → 非客户会话（保留截图供调试）
      // Format: 非客户会话，不入库（保留截图供调试）标题="T" → <fullpath>
      m = msg.match(/^非客户会话[^"]*"(.*?)"[^→]*→ (.+)/)
      if (m && cur) {
        cur.result = 'filtered'
        if (m[1]) cur.windowTitle = m[1]
        cur.screenshotPath = m[2].trim()
        continue
      }
      if (msg.startsWith('非客户会话') && cur) {
        cur.result = 'filtered'
        continue
      }

      // ⑦ Kept frame
      // Format: 保留关键帧 [reason] kind 标题="T" 订单号=X diff=Y 触发=Z → path
      m = msg.match(/^保留关键帧 \[([^\]]*)\] (\S+) 标题="(.*?)" 订单号=(\S+) diff=([0-9.]+) 触发=(\S+) → (.+)/)
      if (m && cur) {
        cur.result = 'kept'
        cur.keepReason = m[1]
        const rawKind = m[2]
        cur.convKind = rawKind === 'group' ? 'group' : rawKind === 'single' ? 'single' : undefined
        if (m[3]) cur.windowTitle = m[3]
        cur.orderNo = m[4] !== '无' ? m[4] : undefined
        cur.keepDiff = parseFloat(m[5])
        cur.trigger = m[6]
        cur.screenshotPath = m[7].trim()
        continue
      }
    } else if (tag === 'insert' && cur) {
      // Format: 新帧 channel "title" → N 条新消息 订单候选=X
      const m = msg.match(/新帧 .+ → (\d+) 条新消息 订单候选=(\S+)/)
      if (m) {
        cur.insertDuplicate = false
        cur.newMessageCount = parseInt(m[1])
        cur.insertOrderNo = m[2] !== '无' ? m[2] : undefined
      } else if (msg.startsWith('去重·已存在')) {
        cur.insertDuplicate = true
      }
    } else if (tag === 'structure' && cur) {
      // Format: channel "title" → M条消息
      const m = msg.match(/→ (\d+)\s*条消息/)
      if (m) cur.structureInfo = `${m[1]} 条消息`
    } else if (tag === 'upload' && cur) {
      cur.uploads.push({ ok: msg.startsWith('✓'), line: msg })
    }
  }

  flush()

  // Link kept sessions to their debug frame (matched by screenshotPath)
  const frameByPath = new Map(frames.map((f) => [f.screenshotPath, f]))
  for (const s of sessions) {
    if (s.screenshotPath) s.dbgFrame = frameByPath.get(s.screenshotPath)
  }

  return sessions.reverse() // newest first
}

// Remove spaces that Windows OCR inserts between consecutive CJK characters
// e.g. "赵 倩 COD..." → "赵倩 COD..."
function compactCJK(text: string): string {
  return text.replace(/(?<=[一-鿿㐀-䶿])\s+(?=[一-鿿㐀-䶿])/g, '')
}

function formatOcrBlocksForCopy(blocks: OcrBlock[]): string {
  return blocks.map((b, i) => {
    const conf = b.confidence == null ? '' : ` conf=${b.confidence}`
    return `${i} ${b.text} (${b.bbox.x},${b.bbox.y}) ${b.bbox.width}×${b.bbox.height}${conf}`
  }).join('\n')
}

function blockCenter(b: OcrBlock): { x: number; y: number } {
  return {
    x: b.bbox.x + b.bbox.width / 2,
    y: b.bbox.y + b.bbox.height / 2,
  }
}

function blockInMessageBox(block: OcrBlock, msg: DbgMessage, pad = 6): boolean {
  if (!msg.box) return false
  const c = blockCenter(block)
  return (
    c.x >= msg.box.x - pad &&
    c.x <= msg.box.x + msg.box.w + pad &&
    c.y >= msg.box.y - pad &&
    c.y <= msg.box.y + msg.box.h + pad
  )
}

function findSenderBlock(msg: DbgMessage, blocks: OcrBlock[], messages: DbgMessage[]): OcrBlock | null {
  if (!msg.name || !msg.box || msg.speaker !== 'other') return null
  const text = msg.name.trim()
  const occupied = new Set<OcrBlock>()
  for (const m of messages) {
    for (const b of blocks) {
      if (blockInMessageBox(b, m, 3)) occupied.add(b)
    }
  }
  const candidates = blocks
    .filter((b) => b.text.trim() === text)
    .filter((b) => !occupied.has(b))
    .filter((b) => {
      const c = blockCenter(b)
      return (
        c.x < msg.box!.x + Math.max(80, msg.box!.w * 0.35) &&
        b.bbox.y + b.bbox.height <= msg.box!.y + 12 &&
        msg.box!.y - (b.bbox.y + b.bbox.height) <= 80
      )
    })
    .sort((a, b) => (b.bbox.y + b.bbox.height) - (a.bbox.y + a.bbox.height))
  return candidates[0] ?? null
}

function shortText(text: string, n = 18): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TRIGGER_LABEL: Record<string, string> = {
  foreground: '窗口激活',
  'key-enter': '回车发送',
  enter: '回车发送',
  click: '鼠标点击',
  wheel: '滚轮翻阅',
  interval: '定时采样',
  unknown: '未知',
}

const CH_LABEL = { wechat: '微信', wxwork: '企微', unknown: '?' } as const
const CH_CLS = {
  wechat: 'bg-green-100 text-green-700',
  wxwork: 'bg-blue-100 text-blue-700',
  unknown: 'bg-gray-100 text-gray-500',
} as const

const RESULT_CFG: Record<SessionResult, { label: string; cls: string }> = {
  kept:        { label: '保留 ✓', cls: 'bg-green-100 text-green-700' },
  filtered:    { label: '非客户会话', cls: 'bg-amber-100 text-amber-700' },
  dedup_skip:  { label: '去重跳过', cls: 'bg-gray-100 text-gray-500' },
  typing_skip: { label: '打字中', cls: 'bg-gray-100 text-gray-500' },
  pending:     { label: '处理中…', cls: 'bg-blue-100 text-blue-600' },
}

const TRIGGER_CLS: Record<string, string> = {
  foreground:  'bg-blue-100 text-blue-700',
  'key-enter': 'bg-green-100 text-green-700',
  enter:       'bg-green-100 text-green-700',
  click:       'bg-purple-100 text-purple-700',
  wheel:       'bg-cyan-100 text-cyan-700',
  interval:    'bg-gray-100 text-gray-600',
  unknown:     'bg-gray-100 text-gray-400',
}

type PageTab = 'pipeline' | 'ocr'

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SidecarDebugPage(): React.JSX.Element {
  const api = getApi()
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [logs, setLogs] = useState<DiagEntry[]>([])
  const [frames, setFrames] = useState<DbgFrame[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [loadedAt, setLoadedAt] = useState('')
  const [activeTab, setActiveTab] = useState<PageTab>('pipeline')

  const sessions = useMemo(() => parseSessions(logs, frames), [logs, frames])
  const selected = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null,
    [sessions, selectedId]
  )

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      const [st, fr, dl] = await Promise.all([
        api.getCaptureStatus(),
        api.getCaptureDebugFrames(80),
        api.getDiagLogs(400),
      ])
      setStatus(st)
      setFrames(fr)
      setLogs(dl)
      setLoadedAt(new Date().toLocaleTimeString())
    } catch { /* ignore transient IPC errors */ }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!auto || !api) return
    const t = setInterval(() => void refresh(), 2000)
    return () => clearInterval(t)
  }, [auto, api, refresh])

  if (!api) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-muted p-8 text-center">
        <span className="material-symbols-outlined text-4xl">desktop_windows</span>
        <p className="text-h3-title text-text-main">采集调试仅在 Windows 客户端可用</p>
        <p className="text-body-sm max-w-md">
          请在 Windows 客户端运行，并确保前台为微信/企业微信窗口才会产生采集事件。
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface-bg">
      <TopBar
        status={status}
        sessionCount={sessions.length}
        frameCount={frames.length}
        loadedAt={loadedAt}
        auto={auto}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onToggleAuto={() => setAuto((v) => !v)}
        onRefresh={() => void refresh()}
        onClear={async () => {
          await Promise.all([api.clearDiagLogs(), api.clearCaptureDebugFrames()])
          await refresh()
        }}
      />
      {activeTab === 'pipeline' ? (
        <div className="flex-1 min-h-0 flex">
          <SessionList
            sessions={sessions}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
          />
          <div className="flex-1 min-h-0 overflow-y-auto">
            {selected ? (
              <SessionDetail session={selected} loadShot={api.getCaptureScreenshot} />
            ) : (
              <EmptyPanel />
            )}
          </div>
        </div>
      ) : (
        <OcrView
          frames={frames}
          loadShot={api.getCaptureScreenshot}
          pickImage={api.pickCaptureImage}
          runOnImage={api.runCaptureOnImage}
          onRefresh={refresh}
        />
      )}
    </div>
  )
}

// ─── TopBar ───────────────────────────────────────────────────────────────────

function TopBar({
  status, sessionCount, frameCount, loadedAt, auto, activeTab, onTabChange,
  onToggleAuto, onRefresh, onClear,
}: {
  status: SidecarStatus | null
  sessionCount: number
  frameCount: number
  loadedAt: string
  auto: boolean
  activeTab: PageTab
  onTabChange: (tab: PageTab) => void
  onToggleAuto: () => void
  onRefresh: () => void
  onClear: () => void
}): React.JSX.Element {
  const collecting = status?.collecting
  const dot = collecting ? 'bg-green-500' : status?.running ? 'bg-amber-500' : 'bg-gray-400'
  return (
    <div className="shrink-0 border-b border-border-subtle bg-white">
      {/* Row 1: status + controls */}
      <div className="px-4 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${dot} ${collecting ? 'animate-pulse' : ''}`} />
          <span className="text-body-md font-semibold text-text-main">采集调试</span>
          <span className="text-label-caps px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">临时</span>
        </div>
        <div className="text-body-sm text-text-muted flex items-center gap-4">
          <span>状态 <b className="text-text-main">{status?.mode ?? '—'}</b></span>
          <span>保留帧 <b className="text-text-main">{status?.capturedFrameCount ?? 0}</b></span>
          <span>去重 <b className="text-text-main">{status?.skippedDuplicateCount ?? 0}</b></span>
          <span>事件 <b className="text-text-main">{sessionCount}</b></span>
        </div>
        {status?.lastError && (
          <span className="text-body-sm text-red-600 truncate max-w-xs" title={status.lastError}>
            ⚠ {status.lastError}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {loadedAt && <span className="text-label-caps text-text-muted">{loadedAt}</span>}
          <button
            onClick={onToggleAuto}
            className={
              'px-2.5 py-1 rounded text-body-sm border transition-colors ' +
              (auto ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle hover:text-primary')
            }
          >
            {auto ? '自动·开' : '自动·关'}
          </button>
          <button
            onClick={onRefresh}
            className="px-2.5 py-1 rounded text-body-sm border border-border-subtle text-text-main hover:bg-surface-container-low"
          >
            刷新
          </button>
          <button
            onClick={onClear}
            className="px-2.5 py-1 rounded text-body-sm border border-border-subtle text-text-muted hover:text-red-600 hover:border-red-300"
          >
            清空
          </button>
        </div>
      </div>
      {/* Row 2: tabs */}
      <div className="px-4 flex items-center gap-0 border-t border-border-subtle">
        {([
          ['pipeline', `采集管道（${sessionCount} 事件）`],
          ['ocr', `OCR 识别（${frameCount} 帧）`],
        ] as const).map(([tab, label]) => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={
              'px-4 py-2 text-body-sm border-b-2 transition-colors ' +
              (activeTab === tab
                ? 'border-primary text-primary font-medium'
                : 'border-transparent text-text-muted hover:text-text-main')
            }
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Session list (left panel) ────────────────────────────────────────────────

function SessionList({
  sessions, selectedId, onSelect,
}: {
  sessions: CaptureSession[]
  selectedId: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  if (sessions.length === 0) {
    return (
      <div className="w-72 shrink-0 border-r border-border-subtle bg-white flex items-center justify-center p-6">
        <p className="text-body-sm text-text-muted text-center leading-relaxed">
          暂无采集事件。<br />
          让微信/企微在前台，<br />
          回车/点击/滚动触发采集。
        </p>
      </div>
    )
  }

  return (
    <div className="w-72 shrink-0 border-r border-border-subtle bg-white overflow-y-auto">
      {sessions.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          active={s.id === selectedId}
          onClick={() => onSelect(s.id)}
        />
      ))}
    </div>
  )
}

function SessionRow({
  session: s, active, onClick,
}: {
  session: CaptureSession
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const rc = RESULT_CFG[s.result]
  const time = new Date(s.ts).toLocaleTimeString('zh-CN', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })

  return (
    <button
      onClick={onClick}
      className={
        'w-full text-left px-3 py-2.5 border-b border-border-subtle transition-colors ' +
        (active ? 'bg-primary/10' : 'hover:bg-surface-container-low')
      }
    >
      {/* Row 1: channel + time + result badge */}
      <div className="flex items-center gap-1.5">
        <span className={`text-label-caps px-1.5 py-0.5 rounded shrink-0 ${CH_CLS[s.channel]}`}>
          {CH_LABEL[s.channel]}
        </span>
        <span className="text-body-sm text-text-muted tabular-nums">{time}</span>
        <span className={`ml-auto text-label-caps px-1.5 py-0.5 rounded shrink-0 ${rc.cls}`}>
          {rc.label}
        </span>
      </div>
      {/* Row 2: trigger + window title */}
      <div className="mt-1 flex items-center gap-2">
        <span className={`text-label-caps px-1.5 py-0.5 rounded shrink-0 ${TRIGGER_CLS[s.trigger] ?? TRIGGER_CLS.unknown}`}>
          {TRIGGER_LABEL[s.trigger] ?? s.trigger}
        </span>
        {s.windowTitle && (
          <span className="text-body-sm text-text-main truncate">{s.windowTitle}</span>
        )}
      </div>
      {/* Row 3: order / diff / size */}
      <div className="mt-0.5 flex items-center gap-2 text-label-caps text-text-muted">
        {s.orderNo && (
          <span className="text-primary font-medium truncate">#{s.orderNo.slice(0, 24)}</span>
        )}
        {s.result === 'dedup_skip' && s.dedupDiff != null && (
          <span>diff={s.dedupDiff.toFixed(3)}</span>
        )}
        {s.result === 'kept' && s.keepDiff != null && (
          <span>diff={s.keepDiff.toFixed(3)}</span>
        )}
        {s.windowSize && <span className="ml-auto">{s.windowSize}</span>}
      </div>
    </button>
  )
}

// ─── Session detail / waterfall (right panel) ─────────────────────────────────

function SessionDetail({
  session: s, loadShot,
}: {
  session: CaptureSession
  loadShot: (path: string) => Promise<string | null>
}): React.JSX.Element {
  const [shotData, setShotData] = useState<string | null>(null)
  const [shotLoading, setShotLoading] = useState(false)

  // Prefer the debug frame's screenshot path (same physical file); fallback to log path
  const shotPath = s.dbgFrame?.screenshotPath ?? s.screenshotPath

  useEffect(() => {
    if (!shotPath) { setShotData(null); return }
    let alive = true
    setShotLoading(true)
    setShotData(null)
    loadShot(shotPath).then((d) => {
      if (alive) { setShotData(d); setShotLoading(false) }
    })
    return () => { alive = false }
  }, [shotPath, loadShot])

  // Use full OCR text from debug frame if available, otherwise log preview (max 160 chars)
  const rawOcr = s.dbgFrame?.ocr.text ?? s.ocrPreview ?? ''
  const ocrCompact = compactCJK(rawOcr)
  const messages = s.dbgFrame?.messages ?? []

  const time = new Date(s.ts).toLocaleString('zh-CN', { hour12: false })
  const isStopped = s.result === 'dedup_skip' || s.result === 'typing_skip'

  return (
    <div className="p-5 max-w-2xl space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-label-caps px-2 py-0.5 rounded ${CH_CLS[s.channel]}`}>
          {CH_LABEL[s.channel]}
        </span>
        <span className="text-body-md font-semibold text-text-main">
          {s.windowTitle || '（未知窗口）'}
        </span>
        {s.windowSize && (
          <span className="text-body-sm text-text-muted">{s.windowSize}</span>
        )}
        <span className="ml-auto text-body-sm text-text-muted">{time}</span>
      </div>

      {/* ① Trigger */}
      <Step n="①" title="触发" color="green">
        <div className="flex items-center gap-2 flex-wrap text-body-sm">
          <span className={`text-label-caps px-2 py-0.5 rounded ${TRIGGER_CLS[s.trigger] ?? TRIGGER_CLS.unknown}`}>
            {TRIGGER_LABEL[s.trigger] ?? s.trigger}
          </span>
          {s.windowTitle && (
            <span className="text-text-muted">"{s.windowTitle}"</span>
          )}
          {s.windowSize && (
            <span className="text-text-muted">{s.windowSize}</span>
          )}
        </div>
      </Step>

      {/* ② Screenshot & dedup */}
      {s.result === 'typing_skip' ? (
        <Step n="②" title="截图 & 去重" color="gray">
          <p className="text-body-sm text-text-muted">
            打字中（静默期内有按键），跳过本轮定时截图；等回车发送后再采。
          </p>
        </Step>
      ) : s.result === 'dedup_skip' ? (
        <Step n="②" title="截图 & 去重" color="gray">
          <p className="text-body-sm text-text-muted">
            近似重复，跳过截图。
            {s.dedupDiff != null && (
              <>
                {' '}diff=<b className="text-text-main">{s.dedupDiff.toFixed(4)}</b>
                <span className="ml-1 text-text-muted">（阈值约 0.02，低于此值=画面几乎没变）</span>
              </>
            )}
          </p>
        </Step>
      ) : (
        <Step n="②" title="截图 & 去重" color={s.ocrStatus ? 'green' : 'amber'}>
          {s.ocrBlank && (
            <p className="text-body-sm text-amber-600 mb-2">
              ⚠ 画面接近全黑——可能是 GPU/CEF 渲染，BitBlt 无法抠到内容
            </p>
          )}
          {s.keepDiff != null && (
            <p className="text-body-sm text-text-muted mb-2">
              diff=<b className="text-text-main">{s.keepDiff.toFixed(4)}</b> → 保留新帧
              {s.keepReason ? <span className="text-text-muted ml-1">（{s.keepReason}）</span> : ''}
            </p>
          )}
          {/* Screenshot thumbnail */}
          {shotLoading ? (
            <div className="rounded border border-border-subtle bg-surface-container-low h-28 flex items-center justify-center text-body-sm text-text-muted">
              加载截图…
            </div>
          ) : shotData ? (
            <img
              src={shotData}
              alt="screenshot"
              className="w-full rounded border border-border-subtle object-contain max-h-72"
            />
          ) : shotPath ? (
            <div className="rounded border border-border-subtle bg-surface-container-low px-3 py-2 text-body-sm text-text-muted">
              截图文件读取失败（文件可能已被删除）
            </div>
          ) : null}
        </Step>
      )}

      {/* ③ OCR — only when a screenshot was taken */}
      {!isStopped && (
        <Step
          n="③"
          title="OCR 识别"
          color={!s.ocrStatus ? 'gray' : s.ocrStatus === 'success' ? 'green' : 'red'}
          dimmed={!s.ocrStatus}
        >
          {s.ocrStatus ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-body-sm">
                <span className={s.ocrStatus === 'success' ? 'text-green-600' : 'text-red-600'}>
                  {s.ocrStatus === 'success' ? '✓ 成功' : '✗ 失败'}
                </span>
                {s.ocrCharCount != null && (
                  <span className="text-text-muted">{s.ocrCharCount} 字</span>
                )}
                {s.dbgFrame && (
                  <span className="text-label-caps text-text-muted">{s.dbgFrame.ocr.blocks?.length ?? 0} 词块</span>
                )}
              </div>
              {ocrCompact && (
                <pre className="text-body-sm text-text-main whitespace-pre-wrap break-all bg-surface-container-low rounded p-2 max-h-36 overflow-y-auto leading-relaxed">
                  {ocrCompact.length > 600 ? ocrCompact.slice(0, 600) + '…' : ocrCompact}
                </pre>
              )}
            </div>
          ) : (
            <p className="text-body-sm text-text-muted">—</p>
          )}
        </Step>
      )}

      {/* ④ Customer conversation filter */}
      {!isStopped && (
        <Step
          n="④"
          title="客户会话判断"
          color={!s.ocrStatus ? 'gray' : s.result === 'filtered' ? 'red' : 'green'}
          dimmed={!s.ocrStatus}
        >
          {!s.ocrStatus ? (
            <p className="text-body-sm text-text-muted">—</p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-body-sm text-text-muted">
                标题行（聊天区顶行）：<b className="text-text-main">{s.windowTitle || '（空，分区可能失败）'}</b>
              </p>
              {s.result === 'filtered' ? (
                <p className="text-body-sm text-red-600">
                  ✗ 非客户会话 — 标题未含"就医服务群"，也未匹配 COD/fwyy 订单号；不入库、不上报（截图保留供调试）
                </p>
              ) : (
                <div className="flex items-center gap-2 flex-wrap text-body-sm">
                  <span className="text-green-600">✓ 客户会话</span>
                  {s.convKind && (
                    <span className="text-label-caps px-1.5 py-0.5 rounded bg-surface-container-low text-text-muted">
                      {s.convKind === 'group' ? '群聊（标题含就医服务群）' : '单聊（标题含订单号）'}
                    </span>
                  )}
                  {s.orderNo && (
                    <span className="font-medium text-primary">#{s.orderNo}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </Step>
      )}

      {/* ⑤ TS insert — only for kept frames */}
      {s.result === 'kept' && (
        <Step
          n="⑤"
          title="本地入库"
          color={s.insertDuplicate == null ? 'amber' : s.insertDuplicate ? 'gray' : 'green'}
        >
          {s.insertDuplicate == null ? (
            <p className="text-body-sm text-text-muted">等待入库…</p>
          ) : s.insertDuplicate ? (
            <p className="text-body-sm text-text-muted">
              TS 层已存在（imageHash 相同，TS-level 去重）
            </p>
          ) : (
            <div className="text-body-sm space-y-1">
              <p>新帧 → <b>{s.newMessageCount ?? 0}</b> 条新消息</p>
              {s.insertOrderNo ? (
                <p className="text-text-muted">
                  订单候选 <span className="text-primary font-medium">{s.insertOrderNo}</span>
                </p>
              ) : (
                <p className="text-text-muted">未识别到订单号</p>
              )}
            </div>
          )}
        </Step>
      )}

      {/* ⑥ Structure — only for kept non-duplicate frames */}
      {s.result === 'kept' && s.insertDuplicate === false && (
        <Step
          n="⑥"
          title="结构化消息（sidecar）"
          color={s.structureInfo ? 'green' : 'amber'}
        >
          {s.structureInfo ? (
            <div className="space-y-2">
              <p className="text-body-sm text-text-muted">{s.structureInfo}</p>
              {messages.length > 0 && (
                <div className="space-y-1.5 mt-2">
                  {messages.map((m, i) => (
                    <MessageBubble key={i} m={m} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-body-sm text-text-muted">等待结构化…</p>
          )}
        </Step>
      )}

      {/* ⑦ Upload — only when there are new messages */}
      {s.result === 'kept' && s.insertDuplicate === false && (s.newMessageCount ?? 0) > 0 && (
        <Step
          n="⑦"
          title="上报后端"
          color={
            s.uploads.length === 0 ? 'amber' :
            s.uploads.every((u) => u.ok) ? 'green' : 'red'
          }
        >
          {s.uploads.length === 0 ? (
            <p className="text-body-sm text-text-muted">等待上报…</p>
          ) : (
            <div className="space-y-1">
              {s.uploads.map((u, i) => (
                <p key={i} className={'text-body-sm ' + (u.ok ? 'text-text-main' : 'text-red-600')}>
                  {u.line}
                </p>
              ))}
            </div>
          )}
        </Step>
      )}
    </div>
  )
}

// ─── Step card ────────────────────────────────────────────────────────────────

type StepColor = 'green' | 'red' | 'amber' | 'gray'

const STEP_BAR_CLS: Record<StepColor, string> = {
  green: 'bg-green-400',
  red:   'bg-red-400',
  amber: 'bg-amber-300',
  gray:  'bg-gray-200',
}

function Step({
  n, title, color, dimmed, children,
}: {
  n: string
  title: string
  color: StepColor
  dimmed?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={'flex gap-3 ' + (dimmed ? 'opacity-40' : '')}>
      {/* Colored left bar */}
      <div className={`w-1 shrink-0 rounded-full self-stretch min-h-[1rem] ${STEP_BAR_CLS[color]}`} />
      <div className="flex-1 min-w-0 pb-1">
        {/* Step header */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-body-sm font-mono text-text-muted w-5 shrink-0">{n}</span>
          <span className="text-body-sm font-semibold text-text-main">{title}</span>
        </div>
        {/* Step content */}
        <div className="pl-7">{children}</div>
      </div>
    </div>
  )
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ m }: { m: DbgMessage }): React.JSX.Element {
  const judge = m.l != null && m.r != null ? `L${m.l.toFixed(2)}/R${m.r.toFixed(2)}${m.decidedBy ? '·' + m.decidedBy : ''}` : ''
  if (m.speaker === 'system') {
    return (
      <div className="flex justify-center">
        <span className="text-label-caps text-text-muted bg-surface-container-low rounded px-2 py-0.5">
          {m.kind === 'time' ? '🕐 ' : ''}{m.text}{m.kind ? `（system:${m.kind}${judge ? '·' + judge : ''}）` : ''}
        </span>
      </div>
    )
  }
  const self = m.speaker === 'self'
  return (
    <div className={'flex ' + (self ? 'justify-end' : 'justify-start')}>
      <div className="max-w-[80%]">
        {m.name && !self && (
          <div className="text-label-caps text-text-muted mb-0.5 px-1">{m.name}</div>
        )}
        <div className={
          'rounded-lg px-3 py-1.5 text-body-sm whitespace-pre-wrap break-words ' +
          (self
            ? 'bg-green-500 text-white rounded-tr-sm'
            : 'bg-white border border-border-subtle text-text-main rounded-tl-sm')
        }>
          {m.text}
        </div>
        <div className={'text-label-caps text-text-muted mt-0.5 px-1 ' + (self ? 'text-right' : '')}>
          {self ? '专员 (self)' : '客户 (other)'}{judge ? ` · ${judge}` : ''}
        </div>
      </div>
    </div>
  )
}

// ─── OCR Visualization tab ────────────────────────────────────────────────────

function OcrView({
  frames,
  loadShot,
  pickImage,
  runOnImage,
  onRefresh,
}: {
  frames: DbgFrame[]
  loadShot: (path: string) => Promise<string | null>
  pickImage: () => Promise<string | null>
  runOnImage: (imagePath: string, channel?: string) => Promise<DbgFrame | null>
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [shotData, setShotData] = useState<string | null>(null)
  const [shotLoading, setShotLoading] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [overlayMode, setOverlayMode] = useState<'blocks' | 'zones' | 'bubbles' | 'messages'>('zones')
  const [copiedBlocks, setCopiedBlocks] = useState(false)
  const [copiedJson, setCopiedJson] = useState(false)
  const [uploadChannel, setUploadChannel] = useState<'wxwork' | 'wechat'>('wxwork')
  const [uploading, setUploading] = useState(false)
  const uploadTest = useCallback(async () => {
    const p = await pickImage()
    if (!p) return
    setUploading(true)
    try {
      await runOnImage(p, uploadChannel)
      await onRefresh()
      setSelectedIdx(0) // 新跑的帧排在最前
    } finally {
      setUploading(false)
    }
  }, [pickImage, runOnImage, onRefresh, uploadChannel])

  const frame = frames[selectedIdx] ?? null
  const blocks = frame?.ocr?.blocks ?? []
  const blockCopyText = useMemo(() => formatOcrBlocksForCopy(blocks), [blocks])
  const copyBlockText = useCallback(async () => {
    await navigator.clipboard.writeText(blockCopyText)
    setCopiedBlocks(true)
    window.setTimeout(() => setCopiedBlocks(false), 1200)
  }, [blockCopyText])
  const copyFullJson = useCallback(async () => {
    if (!frame) return
    await navigator.clipboard.writeText(JSON.stringify(frame, null, 2))
    setCopiedJson(true)
    window.setTimeout(() => setCopiedJson(false), 1200)
  }, [frame])

  useEffect(() => {
    if (!frame?.screenshotPath) { setShotData(null); return }
    let alive = true
    setShotLoading(true)
    setShotData(null)
    loadShot(frame.screenshotPath).then((d) => {
      if (alive) { setShotData(d); setShotLoading(false) }
    })
    return () => { alive = false }
  }, [frame?.screenshotPath, loadShot])

  if (frames.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-body-sm text-text-muted">
        <span>暂无帧数据。可实时采集，或上传一张截图测试结构化。</span>
        <div className="flex items-center gap-2">
          <select
            value={uploadChannel}
            onChange={(e) => setUploadChannel(e.target.value as 'wxwork' | 'wechat')}
            className="px-2 py-1 rounded border border-border-subtle text-body-sm bg-white"
          >
            <option value="wxwork">企微</option>
            <option value="wechat">微信</option>
          </select>
          <button
            onClick={uploadTest}
            disabled={uploading}
            className="px-3 py-1.5 rounded bg-primary text-white text-body-sm disabled:opacity-60"
          >
            {uploading ? '识别中…' : '上传图片测试'}
          </button>
        </div>
      </div>
    )
  }

  const fw = frame?.window?.width ?? 1
  const fh = frame?.window?.height ?? 1

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Left: frame list */}
      <div className="w-56 shrink-0 border-r border-border-subtle overflow-y-auto bg-white">
        {frames.map((f, i) => {
          const t = new Date(f.capturedAt).toLocaleTimeString('zh-CN', {
            hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
          })
          return (
            <button
              key={f.screenshotPath + String(i)}
              onClick={() => setSelectedIdx(i)}
              className={
                'w-full text-left px-3 py-2 border-b border-border-subtle transition-colors ' +
                (i === selectedIdx ? 'bg-primary/10' : 'hover:bg-surface-container-low')
              }
            >
              <div className="flex items-center gap-1.5">
                <span className={`text-label-caps px-1.5 py-0.5 rounded shrink-0 ${CH_CLS[f.channel] ?? 'bg-gray-100 text-gray-500'}`}>
                  {CH_LABEL[f.channel] ?? '?'}
                </span>
                <span className="text-body-sm tabular-nums text-text-muted">{t}</span>
              </div>
              <div className="mt-0.5 text-body-sm text-text-main truncate">
                {f.title ?? f.windowTitle ?? '（未知窗口）'}
              </div>
              <div className="mt-0.5 text-label-caps text-text-muted">
                {f.ocr?.status === 'success' ? `${f.ocr.blocks.length} 词块` : 'OCR 失败'}
                {' · '}{f.window?.width ?? '?'}×{f.window?.height ?? '?'}
              </div>
            </button>
          )
        })}
      </div>

      {/* Right: OCR visualization */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {frame && (
          <>
            {/* Header + controls */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-body-md font-semibold text-text-main">
                {frame.title ?? frame.windowTitle ?? '（未知窗口）'}
              </span>
              {frame.filtered && (
                <span className="text-label-caps px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">非客户·过滤</span>
              )}
              {frame.orderNo && (
                <span className="text-body-sm font-medium text-primary">#{frame.orderNo}</span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <div className="flex rounded border border-border-subtle overflow-hidden">
                  {(['blocks', 'zones', 'bubbles', 'messages'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setOverlayMode(mode)}
                      className={
                        'px-2.5 py-1 text-body-sm ' +
                        (overlayMode === mode ? 'bg-primary text-white' : 'bg-white text-text-muted hover:text-primary')
                      }
                    >
                      {mode === 'blocks' ? '词块' : mode === 'zones' ? '分区' : mode === 'bubbles' ? '气泡' : '消息'}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setShowLabels((v) => !v)}
                  className="px-2.5 py-1 rounded border border-border-subtle text-body-sm text-text-muted hover:text-primary"
                >
                  {showLabels ? '隐藏标签' : '显示标签'}
                </button>
                <button
                  onClick={copyFullJson}
                  title="复制本帧完整调试 JSON（与截图旁的 .debug.json 同内容）"
                  className="px-2.5 py-1 rounded border border-border-subtle text-body-sm text-text-muted hover:text-primary"
                >
                  {copiedJson ? '已复制' : '复制调试JSON'}
                </button>
                <select
                  value={uploadChannel}
                  onChange={(e) => setUploadChannel(e.target.value as 'wxwork' | 'wechat')}
                  title="上传图片按哪个渠道的气泡色识别"
                  className="px-1.5 py-1 rounded border border-border-subtle text-body-sm bg-white text-text-muted"
                >
                  <option value="wxwork">企微</option>
                  <option value="wechat">微信</option>
                </select>
                <button
                  onClick={uploadTest}
                  disabled={uploading}
                  title="选一张本地截图跑结构化（结果作为新帧出现在最前）"
                  className="px-2.5 py-1 rounded border border-border-subtle text-body-sm text-text-muted hover:text-primary disabled:opacity-60"
                >
                  {uploading ? '识别中…' : '上传图片测试'}
                </button>
              </div>
            </div>

            {/* Summary bar */}
            <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-label-caps text-text-muted bg-surface-container-low rounded px-3 py-2">
              <span>{CH_LABEL[frame.channel] ?? '?'} · {fw}×{fh}</span>
              <span>聊天区 <b className="text-text-main">[{frame.chatX0 ?? '?'},{frame.chatX1 ?? '?'})</b></span>
              <span>标题 <b className="text-text-main">{frame.title || '—'}</b></span>
              <span>判定 <b className="text-text-main">
                {frame.filtered ? '非客户' : frame.conversationKind === 'group' ? '群聊·就医服务群' : frame.conversationKind === 'single' ? '单聊·订单号' : '—'}
              </b></span>
              <span>词块 <b className="text-text-main">{blocks.length}</b></span>
              {frame.droppedBlockCount != null && <span>丢弃 <b className="text-text-main">{frame.droppedBlockCount}</b></span>}
              {frame.contactRight != null && <span>联系人右界 <b className="text-text-main">{frame.contactRight}</b></span>}
              {(frame.scanY0 != null || frame.scanY1 != null) && (
                <span>扫描带 <b className="text-text-main">Y[{frame.scanY0 ?? '?'},{frame.scanY1 ?? '?'})</b></span>
              )}
              <span>气泡 <b className="text-text-main">{frame.bubbles?.length ?? 0}</b></span>
              <span>消息 <b className="text-text-main">{frame.messages?.length ?? 0}</b></span>
            </div>

            {/* 结构化失败：把异常堆栈显示在这里，可复制发给开发排查（原图+OCR 仍在下方可看） */}
            {frame.structureError && (
              <div className="rounded border border-red-300 bg-red-50">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-red-200">
                  <span className="text-label-caps font-semibold text-red-700">结构化失败（分区/气泡检测异常）</span>
                  <button
                    onClick={() => { void navigator.clipboard.writeText(frame.structureError ?? '') }}
                    className="px-2 py-0.5 rounded border border-red-300 text-body-sm text-red-700 hover:bg-red-100"
                  >
                    复制
                  </button>
                </div>
                <pre className="px-3 py-2 text-[11px] leading-snug text-red-900 whitespace-pre-wrap break-all max-h-48 overflow-auto font-mono">
                  {frame.structureError}
                </pre>
              </div>
            )}

            {overlayMode === 'zones' && (
              <div className="flex items-center gap-3 flex-wrap text-label-caps text-text-muted">
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3" style={{ borderLeft: '2px dashed rgba(216,90,48,0.9)' }} />聊天区左右界</span>
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3" style={{ borderTop: '2px dashed rgba(37,99,235,0.9)' }} />气泡扫描带上下沿</span>
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3 bg-gray-500/30" />联系人区（丢弃）</span>
              </div>
            )}
            {overlayMode === 'bubbles' && (
              <div className="flex items-center gap-3 flex-wrap text-label-caps text-text-muted">
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3 rounded-sm border-2 border-emerald-600 bg-emerald-500/10" />self 气泡</span>
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3 rounded-sm border-2 border-slate-600 bg-slate-500/10" />other 气泡</span>
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3 rounded-sm border-2 border-dashed border-rose-500 bg-rose-500/10" />空气泡（没归到文字）</span>
              </div>
            )}
            {overlayMode === 'messages' && (
              <div className="flex items-center gap-3 flex-wrap text-label-caps text-text-muted">
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3 rounded-sm border-2 border-emerald-600 bg-emerald-500/10" />self 消息</span>
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3 rounded-sm border-2 border-slate-600 bg-slate-500/10" />other 消息</span>
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3 rounded-sm border-2 border-dashed border-amber-600 bg-amber-500/10" />system</span>
                <span className="inline-flex items-center gap-1"><i className="w-3 h-3 rounded-sm border-2 border-violet-600 bg-violet-500/10" />发送人</span>
              </div>
            )}

            {/* Screenshot with overlays */}
            <div
              className="relative border border-border-subtle rounded overflow-hidden bg-black/5"
              style={{ position: 'relative' }}
            >
              {shotLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-surface-container-low/80 text-body-sm text-text-muted z-10">
                  加载截图…
                </div>
              )}
              {shotData ? (
                <>
                  <img src={shotData} alt="screenshot" className="w-full block" />

                  {overlayMode === 'blocks' && blocks.map((b, i) => {
                    const cs = b.colorSample
                    const cr = cs?.R ?? cs?.r, cg = cs?.G ?? cs?.g, cb = cs?.B ?? cs?.b
                    const hasBg = cr != null && cg != null && cb != null
                    return (
                      <div
                        key={i}
                        title={`[${i}] ${b.text}`}
                        style={{
                          position: 'absolute',
                          left: `${(b.bbox.x / fw) * 100}%`, top: `${(b.bbox.y / fh) * 100}%`,
                          width: `${(b.bbox.width / fw) * 100}%`, height: `${(b.bbox.height / fh) * 100}%`,
                          border: '1px solid rgba(59,130,246,0.75)',
                          backgroundColor: hasBg ? `rgba(${cr},${cg},${cb},0.18)` : 'rgba(59,130,246,0.07)',
                          boxSizing: 'border-box', overflow: 'hidden',
                        }}
                      >
                        {showLabels && (
                          <span style={{ fontSize: '7px', lineHeight: '1.1', color: 'rgba(30,64,175,0.95)', backgroundColor: 'rgba(219,234,254,0.88)', padding: '0 1px', display: 'block', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                            {b.text}
                          </span>
                        )}
                      </div>
                    )
                  })}

                  {overlayMode === 'zones' && (
                    <>
                      {/* dropped 联系人区 shade (left of chatX0) */}
                      {frame.chatX0 != null && frame.chatX0 > 0 && (
                        <div style={{ position: 'absolute', left: 0, top: 0, width: `${(frame.chatX0 / fw) * 100}%`, height: '100%', backgroundColor: 'rgba(120,120,120,0.28)' }}>
                          {showLabels && <span style={{ fontSize: '8px', color: '#fff', background: 'rgba(95,94,90,0.85)', padding: '0 2px' }}>联系人区·丢弃 {frame.droppedBlockCount ?? ''}</span>}
                        </div>
                      )}
                      {/* chatX0 / chatX1 vertical lines */}
                      {frame.chatX0 != null && (
                        <div style={{ position: 'absolute', left: `${(frame.chatX0 / fw) * 100}%`, top: 0, width: 0, height: '100%', borderLeft: '2px dashed rgba(216,90,48,0.9)' }} />
                      )}
                      {frame.chatX1 != null && (
                        <div style={{ position: 'absolute', left: `${(frame.chatX1 / fw) * 100}%`, top: 0, width: 0, height: '100%', borderLeft: '2px dashed rgba(216,90,48,0.6)' }} />
                      )}
                      {/* 气泡扫描带上/下沿 */}
                      {frame.scanY0 != null && (
                        <div style={{ position: 'absolute', left: `${((frame.chatX0 ?? 0) / fw) * 100}%`, top: `${(frame.scanY0 / fh) * 100}%`, width: `${(((frame.chatX1 ?? fw) - (frame.chatX0 ?? 0)) / fw) * 100}%`, height: 0, borderTop: '2px dashed rgba(37,99,235,0.85)' }}>
                          {showLabels && <span style={{ fontSize: '8px', color: '#1D4ED8', background: 'rgba(219,234,254,0.92)', padding: '0 2px' }}>扫描上沿 {frame.scanY0}</span>}
                        </div>
                      )}
                      {frame.scanY1 != null && (
                        <div style={{ position: 'absolute', left: `${((frame.chatX0 ?? 0) / fw) * 100}%`, top: `${(frame.scanY1 / fh) * 100}%`, width: `${(((frame.chatX1 ?? fw) - (frame.chatX0 ?? 0)) / fw) * 100}%`, height: 0, borderTop: '2px dashed rgba(37,99,235,0.55)' }}>
                          {showLabels && <span style={{ fontSize: '8px', color: '#1D4ED8', background: 'rgba(219,234,254,0.92)', padding: '0 2px' }}>扫描下沿 {frame.scanY1}</span>}
                        </div>
                      )}
                      {/* input cut region (below inputCutY) */}
                      {frame.inputCutY != null && (
                        <div style={{ position: 'absolute', left: `${((frame.chatX0 ?? 0) / fw) * 100}%`, top: `${(frame.inputCutY / fh) * 100}%`, width: `${(((frame.chatX1 ?? fw) - (frame.chatX0 ?? 0)) / fw) * 100}%`, height: `${((fh - frame.inputCutY) / fh) * 100}%`, backgroundColor: 'rgba(216,90,48,0.16)', borderTop: '1.5px dashed rgba(216,90,48,0.8)' }}>
                          {showLabels && <span style={{ fontSize: '8px', color: '#993C1D', background: 'rgba(250,236,231,0.9)', padding: '0 2px' }}>输入框·切除 {frame.inputCut?.finalReason ?? ''}</span>}
                        </div>
                      )}
                      {frame.inputCut?.separatorLineY != null && (
                        <div style={{ position: 'absolute', left: `${((frame.chatX0 ?? 0) / fw) * 100}%`, top: `${(frame.inputCut.separatorLineY / fh) * 100}%`, width: `${(((frame.chatX1 ?? fw) - (frame.chatX0 ?? 0)) / fw) * 100}%`, height: 0, borderTop: '1.5px solid rgba(20,130,95,0.95)' }}>
                          {showLabels && <span style={{ fontSize: '8px', color: '#075E45', background: 'rgba(215,245,235,0.92)', padding: '0 2px' }}>分隔线 {frame.inputCut.separatorLineY}</span>}
                        </div>
                      )}
                      {frame.inputCut?.sendButtonY != null && (
                        <div style={{ position: 'absolute', left: `${((frame.chatX0 ?? 0) / fw) * 100}%`, top: `${(frame.inputCut.sendButtonY / fh) * 100}%`, width: `${(((frame.chatX1 ?? fw) - (frame.chatX0 ?? 0)) / fw) * 100}%`, height: 0, borderTop: '1.5px solid rgba(37,99,235,0.9)' }}>
                          {showLabels && <span style={{ fontSize: '8px', color: '#1D4ED8', background: 'rgba(219,234,254,0.92)', padding: '0 2px' }}>发送 {frame.inputCut.sendButtonY}</span>}
                        </div>
                      )}
                      {frame.inputCut?.gapCutY != null && (
                        <div style={{ position: 'absolute', left: `${((frame.chatX0 ?? 0) / fw) * 100}%`, top: `${(frame.inputCut.gapCutY / fh) * 100}%`, width: `${(((frame.chatX1 ?? fw) - (frame.chatX0 ?? 0)) / fw) * 100}%`, height: 0, borderTop: '1px dotted rgba(168,85,247,0.95)' }}>
                          {showLabels && <span style={{ fontSize: '8px', color: '#7E22CE', background: 'rgba(243,232,255,0.92)', padding: '0 2px' }}>gap 对比 {frame.inputCut.gapCutY}</span>}
                        </div>
                      )}
                      {frame.inputCut?.lastBubbleBottomY != null && (
                        <div style={{ position: 'absolute', left: `${((frame.chatX0 ?? 0) / fw) * 100}%`, top: `${(frame.inputCut.lastBubbleBottomY / fh) * 100}%`, width: `${(((frame.chatX1 ?? fw) - (frame.chatX0 ?? 0)) / fw) * 100}%`, height: 0, borderTop: '1px dashed rgba(234,88,12,0.95)' }}>
                          {showLabels && <span style={{ fontSize: '8px', color: '#9A3412', background: 'rgba(255,237,213,0.92)', padding: '0 2px' }}>最后消息 {frame.inputCut.lastBubbleBottomY}</span>}
                        </div>
                      )}
                    </>
                  )}

                  {/* 气泡视图：只画检测到的气泡连通域（含没归到文字的空气泡） */}
                  {overlayMode === 'bubbles' && (frame.bubbles ?? []).map((bb, i) => {
                    const col = bb.speaker === 'self' ? '15,110,86' : '51,65,85'
                    const empty = !bb.hasText
                    return (
                      <div
                        key={`bubble-${i}`}
                        title={`${bb.speaker} 气泡 ${bb.w}×${bb.h} area=${bb.area}${empty ? '（空·无文字）' : ''}`}
                        style={{
                          position: 'absolute',
                          left: `${(bb.x / fw) * 100}%`, top: `${(bb.y / fh) * 100}%`,
                          width: `${(bb.w / fw) * 100}%`, height: `${(bb.h / fh) * 100}%`,
                          border: empty ? '2px dashed rgba(244,63,94,0.9)' : `2px solid rgba(${col},0.95)`,
                          backgroundColor: empty ? 'rgba(244,63,94,0.10)' : `rgba(${col},0.12)`,
                          boxSizing: 'border-box',
                        }}
                      >
                        {showLabels && (
                          <span style={{ fontSize: '9px', lineHeight: '1.2', color: '#fff', background: empty ? 'rgba(244,63,94,0.95)' : `rgba(${col},0.95)`, padding: '1px 3px', display: 'inline-block', whiteSpace: 'nowrap' }}>
                            {bb.speaker}{empty ? '·空' : ''} {bb.w}×{bb.h}
                          </span>
                        )}
                      </div>
                    )
                  })}

                  {/* 消息视图：最终消息框 + 发送人框 */}
                  {overlayMode === 'messages' && (
                    <>
                      {(frame.messages ?? []).map((m, i) => {
                        if (!m.box) return null
                        const col = m.speaker === 'self' ? '15,110,86' : m.speaker === 'system' ? '186,117,23' : '51,65,85'
                        const label = m.speaker === 'system'
                          ? `system${m.kind ? ':' + m.kind : ''}`
                          : `${m.speaker} 消息`
                        return (
                          <div
                            key={i}
                            title={`${label}${m.name ? ' · ' + m.name : ''} | ${m.text}`}
                            style={{
                              position: 'absolute',
                              left: `${(m.box.x / fw) * 100}%`, top: `${(m.box.y / fh) * 100}%`,
                              width: `${(m.box.w / fw) * 100}%`, height: `${(m.box.h / fh) * 100}%`,
                              border: `${m.speaker === 'system' ? '2px dashed' : '2px solid'} rgba(${col},0.95)`,
                              backgroundColor: `rgba(${col},0.12)`,
                              boxSizing: 'border-box',
                            }}
                          >
                            {showLabels && (
                              <span style={{ fontSize: '9px', lineHeight: '1.2', color: '#fff', background: `rgba(${col},0.95)`, padding: '1px 3px', display: 'inline-block', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {label}{m.l != null && m.r != null ? ` · L${m.l.toFixed(2)}/R${m.r.toFixed(2)}` : ''}
                              </span>
                            )}
                          </div>
                        )
                      })}
                      {(frame.messages ?? []).map((m, i) => {
                        const sender = findSenderBlock(m, blocks, frame.messages ?? [])
                        if (!sender) return null
                        return (
                          <div
                            key={`sender-${i}`}
                            title={`发送人：${m.name ?? ''}`}
                            style={{
                              position: 'absolute',
                              left: `${(sender.bbox.x / fw) * 100}%`,
                              top: `${(sender.bbox.y / fh) * 100}%`,
                              width: `${(sender.bbox.width / fw) * 100}%`,
                              height: `${(sender.bbox.height / fh) * 100}%`,
                              border: '2px solid rgba(124,58,237,0.95)',
                              backgroundColor: 'rgba(124,58,237,0.12)',
                              boxSizing: 'border-box',
                            }}
                          >
                            {showLabels && (
                              <span style={{ fontSize: '9px', lineHeight: '1.2', color: '#fff', background: 'rgba(124,58,237,0.95)', padding: '1px 3px', display: 'inline-block', whiteSpace: 'nowrap' }}>
                                sender · {shortText(m.name ?? '')}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </>
                  )}
                </>
              ) : !shotLoading ? (
                <div className="h-32 flex items-center justify-center text-body-sm text-text-muted">
                  截图不可用（已被过滤删除或路径无效）
                </div>
              ) : null}
            </div>

            {frame.inputCut && (
              <div>
                <div className="text-label-caps text-text-muted mb-1.5">输入区定位</div>
                <div className="border border-border-subtle rounded overflow-hidden text-body-sm">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border-subtle">
                    <div className="bg-surface-container-low px-3 py-2">
                      <div className="text-label-caps text-text-muted">最终切线</div>
                      <div className="text-text-main tabular-nums">{frame.inputCut.finalCutY ?? '—'}</div>
                    </div>
                    <div className="bg-surface-container-low px-3 py-2">
                      <div className="text-label-caps text-text-muted">依据</div>
                      <div className="text-text-main">{frame.inputCut.finalReason ?? '未确定'}</div>
                    </div>
                    <div className="bg-surface-container-low px-3 py-2">
                      <div className="text-label-caps text-text-muted">发送按钮</div>
                      <div className="text-text-main tabular-nums">{frame.inputCut.sendButtonY ?? '—'}</div>
                    </div>
                    <div className="bg-surface-container-low px-3 py-2">
                      <div className="text-label-caps text-text-muted">像素分隔线</div>
                      <div className="text-text-main tabular-nums">{frame.inputCut.separatorLineY ?? '—'}</div>
                    </div>
                    <div className="bg-surface-container-low px-3 py-2">
                      <div className="text-label-caps text-text-muted">gap 对比</div>
                      <div className="text-text-main tabular-nums">{frame.inputCut.gapCutY ?? '—'}</div>
                    </div>
                    <div className="bg-surface-container-low px-3 py-2">
                      <div className="text-label-caps text-text-muted">最后消息下沿</div>
                      <div className="text-text-main tabular-nums">{frame.inputCut.lastBubbleBottomY ?? '—'}</div>
                    </div>
                    <div className="bg-surface-container-low px-3 py-2">
                      <div className="text-label-caps text-text-muted">切除行数</div>
                      <div className="text-text-main tabular-nums">{frame.inputCut.removedLineCount ?? 0}</div>
                    </div>
                    <div className="bg-surface-container-low px-3 py-2">
                      <div className="text-label-caps text-text-muted">切除预览</div>
                      <div className="text-text-main truncate">{frame.inputCut.removedLinePreview?.join(' / ') || '—'}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Decision table */}
            {(frame.messages?.length ?? 0) > 0 && (
              <div>
                <div className="text-label-caps text-text-muted mb-1.5">判定依据表（{frame.messages!.length} 条消息）</div>
                <div className="border border-border-subtle rounded overflow-hidden">
                  <div className="max-h-64 overflow-y-auto">
                    {frame.messages!.map((m, i) => {
                      const col = m.speaker === 'self' ? 'text-green-700' : m.speaker === 'system' ? 'text-amber-700' : 'text-text-muted'
                      const sender = findSenderBlock(m, blocks, frame.messages ?? [])
                      return (
                        <div key={i} className="grid grid-cols-[72px_96px_1fr_170px] gap-2 px-3 py-1.5 border-b border-border-subtle last:border-0 text-body-sm hover:bg-surface-container-low">
                          <span className={`w-12 shrink-0 font-medium ${col}`}>{m.speaker}{m.kind ? ':' + m.kind : ''}</span>
                          <span className="text-label-caps text-text-muted truncate" title={m.name ?? ''}>
                            {m.name ? `sender:${m.name}` : sender ? 'sender:?' : ''}
                          </span>
                          <span className="truncate text-text-main" title={m.text}>{m.text}</span>
                          <span className="text-label-caps text-text-muted tabular-nums text-right">
                            {m.box ? `box(${m.box.x},${m.box.y}) ${m.box.w}×${m.box.h}` : 'box —'}
                            {m.l != null && m.r != null ? ` · L${m.l.toFixed(2)}/R${m.r.toFixed(2)}` : ''}
                            {sender ? ` · name(${sender.bbox.x},${sender.bbox.y})` : ''}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Raw OCR text */}
            <div>
              <div className="text-label-caps text-text-muted mb-1.5">
                OCR 原始文本（去 CJK 间距后，共 {compactCJK(frame.ocr?.text ?? '').length} 字）
              </div>
              <pre className="text-body-sm text-text-main whitespace-pre-wrap break-all bg-surface-container-low rounded p-3 max-h-40 overflow-y-auto leading-relaxed">
                {compactCJK(frame.ocr?.text ?? '') || '（空）'}
              </pre>
            </div>

            {/* Block list */}
            <div>
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <div className="text-label-caps text-text-muted">
                  全部词块（{blocks.length} 个，含会话列表、输入框等所有区域）
                </div>
                <button
                  onClick={copyBlockText}
                  disabled={!blockCopyText}
                  className="px-2.5 py-1 rounded border border-border-subtle text-body-sm text-text-muted hover:text-primary disabled:opacity-50"
                >
                  {copiedBlocks ? '已复制' : '复制原始词块'}
                </button>
              </div>
              <textarea
                readOnly
                value={blockCopyText}
                className="w-full h-40 mb-3 rounded border border-border-subtle bg-surface-container-low p-3 font-mono text-xs text-text-main resize-y"
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="border border-border-subtle rounded overflow-hidden">
                <div className="max-h-64 overflow-y-auto">
                  {blocks.map((b, i) => {
                    const cs = b.colorSample
                    const cr = cs?.R ?? cs?.r
                    const cg = cs?.G ?? cs?.g
                    const cb = cs?.B ?? cs?.b
                    const hasBg = cr != null && cg != null && cb != null
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-2 px-3 py-1 border-b border-border-subtle last:border-0 text-body-sm hover:bg-surface-container-low"
                      >
                        <span className="text-label-caps text-text-muted w-7 shrink-0 tabular-nums text-right">
                          {i}
                        </span>
                        {hasBg ? (
                          <span
                            className="w-3 h-3 rounded-sm shrink-0 border border-black/10"
                            style={{ backgroundColor: `rgb(${cr},${cg},${cb})` }}
                            title={`rgb(${cr},${cg},${cb})`}
                          />
                        ) : (
                          <span className="w-3 h-3 shrink-0" />
                        )}
                        <span className="flex-1 truncate text-text-main">{b.text}</span>
                        <span className="text-label-caps text-text-muted shrink-0 tabular-nums">
                          ({b.bbox.x},{b.bbox.y}) {b.bbox.width}×{b.bbox.height}
                        </span>
                        {b.confidence != null && (
                          <span className="text-label-caps text-text-muted shrink-0 tabular-nums w-10 text-right">
                            {Math.round(b.confidence * 100)}%
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyPanel(): React.JSX.Element {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-text-muted">
      <span className="material-symbols-outlined text-3xl">bug_report</span>
      <p className="text-body-sm text-center">
        暂无采集事件<br />
        <span className="text-label-caps">让微信/企微在前台操作即可触发</span>
      </p>
    </div>
  )
}
