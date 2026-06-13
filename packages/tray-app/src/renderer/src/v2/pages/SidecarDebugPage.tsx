import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 【临时·采集调试页】可视化验证 sidecar（微信/企微 PC 端采集）的输出。
 *
 * 数据来自 Electron 主进程内存里的"最近原始帧"环形缓冲（window.api.getCaptureDebugFrames），
 * 含 sidecar 已吐出但持久化层暂未消费的字段：结构化消息 messages[]（带 self/other/system 说话人）、
 * orderNo（订单号候选）、conversationKind（group/single）、keepReason/diffScore（去重判定）。
 *
 * ⚠️ 临时调试用：不落库、重启清空。只在 Windows 客户端(Electron)内、且 HYYD_ENABLE_SIDECAR=1 时有数据。
 * 验证完成后可整页删除（连同 capture:debug-frames IPC / preload 暴露）。
 */

interface DebugMessage {
  speaker: 'self' | 'other' | 'system'
  name?: string | null
  text: string
}
interface DebugFrame {
  channel: 'wxwork' | 'wechat'
  processName: string
  windowTitle?: string | null
  capturedAt: string
  window: { width: number; height: number; showState: string }
  screenshotPath: string
  imageHash?: string | null
  ocr: { status: 'success' | 'failed'; text: string; blocks: unknown[] }
  keepReason?: string
  diffScore?: number
  conversationKind?: 'group' | 'single' | null
  orderNo?: string | null
  messages?: DebugMessage[]
}
interface SidecarStatus {
  enabled: boolean
  running: boolean
  collecting: boolean
  mode: string
  lastError: string | null
  lastFrameAt: string | null
  capturedFrameCount: number
  skippedDuplicateCount: number
  sidecarPath: string | null
}

// window.api 只在 Electron 里存在；浏览器预览时为 undefined
type CaptureApi = {
  getCaptureStatus: () => Promise<SidecarStatus>
  getCaptureDebugFrames: (limit?: number) => Promise<DebugFrame[]>
  clearCaptureDebugFrames: () => Promise<{ cleared: number }>
  getCaptureScreenshot: (path: string) => Promise<string | null>
}
function getApi(): CaptureApi | null {
  const api = (window as unknown as { api?: Partial<CaptureApi> }).api
  return api && typeof api.getCaptureDebugFrames === 'function' ? (api as CaptureApi) : null
}

export default function SidecarDebugPage(): React.JSX.Element {
  const api = getApi()
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [frames, setFrames] = useState<DebugFrame[]>([])
  const [selected, setSelected] = useState<number>(0)
  const [auto, setAuto] = useState(true)
  const [loadedAt, setLoadedAt] = useState<string>('')
  const stickTop = useRef(true)

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      const [st, fr] = await Promise.all([api.getCaptureStatus(), api.getCaptureDebugFrames(60)])
      setStatus(st)
      setFrames(fr)
      // 自动刷新时若用户停在第 0 帧（最新），新帧进来保持跟随最新；否则不动选中项
      if (stickTop.current) setSelected(0)
      setLoadedAt(new Date().toLocaleTimeString())
    } catch {
      /* ignore transient ipc errors */
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])
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
          本页读取的是 Electron 主进程里的 sidecar 实时帧。当前是浏览器预览（无 <code>window.api</code>）。
          请在 Windows 客户端运行，并确保启动时 <code>HYYD_ENABLE_SIDECAR=1</code>，
          且前台为微信/企业微信窗口才会产生帧。
        </p>
      </div>
    )
  }

  const cur = frames[selected] ?? null

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface-bg">
      <StatusBar
        status={status}
        frameCount={frames.length}
        loadedAt={loadedAt}
        auto={auto}
        onToggleAuto={() => setAuto((v) => !v)}
        onRefresh={() => void refresh()}
        onClear={async () => {
          await api.clearCaptureDebugFrames()
          await refresh()
        }}
      />
      <div className="flex-1 min-h-0 flex">
        {/* 左：帧列表 */}
        <div className="w-72 shrink-0 border-r border-border-subtle bg-white overflow-y-auto">
          {frames.length === 0 ? (
            <div className="p-4 text-body-sm text-text-muted">
              暂无帧。请让微信/企业微信在前台、并在客户会话里翻动消息（滚轮/点击/回车都会触发采集）。
            </div>
          ) : (
            frames.map((f, i) => (
              <FrameRow
                key={`${f.capturedAt}-${i}`}
                f={f}
                active={i === selected}
                onClick={() => {
                  setSelected(i)
                  stickTop.current = i === 0
                }}
              />
            ))
          )}
        </div>
        {/* 右：帧详情 */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {cur ? <FrameDetail f={cur} loadShot={api.getCaptureScreenshot} /> : <Empty />}
        </div>
      </div>
    </div>
  )
}

function StatusBar({
  status,
  frameCount,
  loadedAt,
  auto,
  onToggleAuto,
  onRefresh,
  onClear
}: {
  status: SidecarStatus | null
  frameCount: number
  loadedAt: string
  auto: boolean
  onToggleAuto: () => void
  onRefresh: () => void
  onClear: () => void
}): React.JSX.Element {
  const collecting = status?.collecting
  const dot = collecting ? 'bg-green-500' : status?.running ? 'bg-amber-500' : 'bg-gray-400'
  return (
    <div className="shrink-0 border-b border-border-subtle bg-white px-4 py-2.5 flex items-center gap-4 flex-wrap">
      <div className="flex items-center gap-2">
        <span className={`w-2.5 h-2.5 rounded-full ${dot} ${collecting ? 'animate-pulse' : ''}`} />
        <span className="text-body-md font-semibold text-text-main">采集调试</span>
        <span className="text-label-caps px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">临时</span>
      </div>
      <div className="text-body-sm text-text-muted flex items-center gap-3">
        <span>状态 <b className="text-text-main">{status?.mode ?? '—'}</b></span>
        <span>保留 <b className="text-text-main">{status?.capturedFrameCount ?? 0}</b></span>
        <span>去重跳过 <b className="text-text-main">{status?.skippedDuplicateCount ?? 0}</b></span>
        <span>缓冲帧 <b className="text-text-main">{frameCount}</b></span>
        {status?.lastFrameAt && <span>最后帧 {new Date(status.lastFrameAt).toLocaleTimeString()}</span>}
      </div>
      {status?.lastError && (
        <span className="text-body-sm text-red-600 truncate max-w-xs" title={status.lastError}>
          ⚠ {status.lastError}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {loadedAt && <span className="text-label-caps text-text-muted">刷新于 {loadedAt}</span>}
        <button
          onClick={onToggleAuto}
          className={
            'px-2.5 py-1 rounded text-body-sm border transition-colors ' +
            (auto
              ? 'bg-primary text-white border-primary'
              : 'bg-white text-text-muted border-border-subtle hover:text-primary')
          }
        >
          {auto ? '自动刷新·开' : '自动刷新·关'}
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
          清空缓冲
        </button>
      </div>
    </div>
  )
}

function FrameRow({
  f,
  active,
  onClick
}: {
  f: DebugFrame
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const msgN = f.messages?.length ?? 0
  return (
    <button
      onClick={onClick}
      className={
        'w-full text-left px-3 py-2 border-b border-border-subtle transition-colors ' +
        (active ? 'bg-primary/10' : 'hover:bg-surface-container-low')
      }
    >
      <div className="flex items-center gap-2">
        <ChannelChip channel={f.channel} />
        <span className="text-body-sm text-text-main font-medium">
          {new Date(f.capturedAt).toLocaleTimeString()}
        </span>
        {f.conversationKind && (
          <span className="text-label-caps px-1 rounded bg-surface-container-low text-text-muted">
            {f.conversationKind === 'group' ? '群聊' : '单聊'}
          </span>
        )}
        <span className="ml-auto text-label-caps text-text-muted">{msgN} 条</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-label-caps text-text-muted">
        {f.orderNo ? (
          <span className="text-primary font-medium truncate">#{f.orderNo}</span>
        ) : (
          <span className="text-text-muted">无订单号</span>
        )}
        {f.keepReason && <span className="ml-auto">{f.keepReason}</span>}
        {typeof f.diffScore === 'number' && <span>diff {f.diffScore.toFixed(3)}</span>}
      </div>
    </button>
  )
}

function FrameDetail({
  f,
  loadShot
}: {
  f: DebugFrame
  loadShot: (path: string) => Promise<string | null>
}): React.JSX.Element {
  const [shot, setShot] = useState<string | null>(null)
  const [showOcr, setShowOcr] = useState(false)
  const [bigShot, setBigShot] = useState(false)

  useEffect(() => {
    let alive = true
    setShot(null)
    void loadShot(f.screenshotPath).then((d) => {
      if (alive) setShot(d)
    })
    return () => {
      alive = false
    }
  }, [f.screenshotPath, loadShot])

  return (
    <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* 左：结构化消息 */}
      <section className="min-w-0">
        <h3 className="text-body-md font-semibold text-text-main mb-2 flex items-center gap-2">
          结构化消息
          <span className="text-label-caps text-text-muted">（self/other/system 由 sidecar 颜色+位置判定）</span>
        </h3>
        <div className="rounded-lg border border-border-subtle bg-white p-3 space-y-2">
          {(f.messages?.length ?? 0) === 0 ? (
            <p className="text-body-sm text-text-muted">该帧无结构化消息（OCR 可能失败或非聊天画面）。</p>
          ) : (
            f.messages!.map((m, i) => <Bubble key={i} m={m} />)
          )}
        </div>
      </section>

      {/* 右：元数据 + 截图 + OCR */}
      <section className="min-w-0 space-y-3">
        <h3 className="text-body-md font-semibold text-text-main">帧元数据</h3>
        <dl className="rounded-lg border border-border-subtle bg-white p-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-body-sm">
          <Meta k="渠道" v={f.channel === 'wxwork' ? '企业微信' : '微信'} />
          <Meta k="进程" v={f.processName} />
          <Meta k="会话类型" v={f.conversationKind ?? '—'} />
          <Meta k="订单号候选" v={f.orderNo ?? '—'} highlight={!!f.orderNo} />
          <Meta k="采集时间" v={new Date(f.capturedAt).toLocaleString()} />
          <Meta k="窗口" v={`${f.window.width}×${f.window.height} ${f.window.showState}`} />
          <Meta k="保留原因" v={f.keepReason ?? '—'} />
          <Meta k="差异分" v={typeof f.diffScore === 'number' ? f.diffScore.toFixed(4) : '—'} />
          <Meta k="OCR" v={`${f.ocr.status} · ${f.ocr.blocks.length} 词块`} />
          <Meta k="窗口标题" v={f.windowTitle || '—'} />
        </dl>

        <div>
          <button
            onClick={() => setBigShot((v) => !v)}
            className="text-body-sm text-primary hover:underline mb-1"
          >
            截图原图 {bigShot ? '（点击收起）' : '（点击放大）'}
          </button>
          <div className="rounded-lg border border-border-subtle bg-surface-container-low overflow-hidden">
            {shot ? (
              <img
                src={shot}
                alt="frame"
                className={'w-full object-contain ' + (bigShot ? '' : 'max-h-64')}
              />
            ) : (
              <div className="h-32 flex items-center justify-center text-body-sm text-text-muted">
                加载截图…
              </div>
            )}
          </div>
        </div>

        <div>
          <button
            onClick={() => setShowOcr((v) => !v)}
            className="text-body-sm text-primary hover:underline"
          >
            OCR 全文 {showOcr ? '▲' : '▼'}
          </button>
          {showOcr && (
            <pre className="mt-1 rounded-lg border border-border-subtle bg-white p-3 text-body-sm text-text-muted whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
              {f.ocr.text || '（空）'}
            </pre>
          )}
        </div>
      </section>
    </div>
  )
}

function Bubble({ m }: { m: DebugMessage }): React.JSX.Element {
  if (m.speaker === 'system') {
    return (
      <div className="flex justify-center">
        <span className="text-label-caps text-text-muted bg-surface-container-low rounded px-2 py-0.5">
          {m.text}
        </span>
      </div>
    )
  }
  const self = m.speaker === 'self'
  return (
    <div className={'flex ' + (self ? 'justify-end' : 'justify-start')}>
      <div className="max-w-[78%]">
        {m.name && !self && <div className="text-label-caps text-text-muted mb-0.5 px-1">{m.name}</div>}
        <div
          className={
            'rounded-lg px-3 py-1.5 text-body-sm whitespace-pre-wrap break-words ' +
            (self
              ? 'bg-green-500 text-white rounded-tr-sm'
              : 'bg-white border border-border-subtle text-text-main rounded-tl-sm')
          }
        >
          {m.text}
        </div>
        <div className={'text-label-caps text-text-muted mt-0.5 px-1 ' + (self ? 'text-right' : '')}>
          {self ? '专员 (self)' : '客户 (other)'}
        </div>
      </div>
    </div>
  )
}

function Meta({ k, v, highlight }: { k: string; v: string; highlight?: boolean }): React.JSX.Element {
  return (
    <>
      <dt className="text-text-muted">{k}</dt>
      <dd className={'truncate ' + (highlight ? 'text-primary font-medium' : 'text-text-main')} title={v}>
        {v}
      </dd>
    </>
  )
}

function ChannelChip({ channel }: { channel: 'wxwork' | 'wechat' }): React.JSX.Element {
  const wx = channel === 'wxwork'
  return (
    <span
      className={
        'text-label-caps px-1.5 py-0.5 rounded ' +
        (wx ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700')
      }
    >
      {wx ? '企微' : '微信'}
    </span>
  )
}

function Empty(): React.JSX.Element {
  return (
    <div className="h-full flex items-center justify-center text-body-sm text-text-muted">
      选择左侧一帧查看详情
    </div>
  )
}
