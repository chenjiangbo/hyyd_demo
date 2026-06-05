import { useCallback, useEffect, useMemo, useState } from 'react'
import { detectConversation, convKindLabel, TITLE_MAX_Y } from '../lib/detectConversation'

type Channel = 'wechat' | 'wxwork'

/**
 * 采集调试页：选一帧 → 截图上叠加 OCR 块框，旁边列出 OCR 文字，
 * 并展示第1层"会话识别"（OCR 读标题 → 客户/泰康群/未匹配）。
 */
export default function CaptureDebugView(): React.JSX.Element {
  const [channel, setChannel] = useState<Channel>('wxwork')
  const [frames, setFrames] = useState<CaptureFrameDebug[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOcrBoxes, setShowOcrBoxes] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!window.api?.getCaptureFrames) throw new Error('采集调试接口不可用（非 Windows 客户端）')
      const data = await window.api.getCaptureFrames(channel, 40)
      setFrames(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [channel])

  useEffect(() => {
    refresh()
  }, [refresh])

  const selected = useMemo(() => frames.find((f) => f.id === selectedId) ?? null, [frames, selectedId])

  // 选中帧 → 拉截图 + layout
  useEffect(() => {
    let cancelled = false
    setScreenshot(null)
    if (!selected) return
    void (async () => {
      try {
        const shot = await window.api!.getCaptureScreenshot(selected.screenshotPath)
        if (cancelled) return
        setScreenshot(shot)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selected])

  return (
    <div className="flex h-full">
      {/* 左侧帧列表 */}
      <div className="w-72 border-r border-slate-200 flex flex-col bg-white">
        <header className="px-4 py-3 border-b border-slate-200">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-base font-semibold text-slate-800">
              采集调试 <span className="text-slate-400 font-normal">({frames.length})</span>
            </h1>
            <button
              onClick={refresh}
              disabled={loading}
              className="text-xs px-2 py-1 border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded"
            >
              {loading ? '…' : '🔄'}
            </button>
          </div>
          <div className="flex items-center gap-1 text-xs">
            {(
              [
                { key: 'wechat', label: '💚 微信' },
                { key: 'wxwork', label: '💙 企微' }
              ] as { key: Channel; label: string }[]
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  setChannel(t.key)
                  setSelectedId(null)
                }}
                className={`px-3 py-1 rounded ${
                  channel === t.key ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="mx-3 my-2 px-3 py-2 bg-red-50 border border-red-200 text-xs text-red-700 rounded">
              ❌ {error}
            </div>
          )}
          {frames.length === 0 && !loading && !error && (
            <div className="text-center py-12 text-slate-400 text-sm">暂无采集帧</div>
          )}
          {frames.map((f) => (
            <button
              key={f.id}
              onClick={() => setSelectedId(f.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 ${
                f.id === selectedId ? 'bg-blue-50 border-l-4 border-l-blue-500' : 'border-l-4 border-l-transparent'
              }`}
            >
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-700">#{f.id}</span>
                <span className="text-slate-400">
                  {new Date(f.capturedAt).toLocaleTimeString('zh-CN')}
                </span>
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {f.windowWidth}×{f.windowHeight} · {f.windowShowState}
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px]">
                <FrameStatusBadge status={f.frameStatus} />
                <span className="text-slate-400">{f.ocrBlocks.length} OCR块</span>
              </div>
              <ConvTag frame={f} />
            </button>
          ))}
        </div>
      </div>

      {/* 右侧：截图叠加 + 详情 */}
      <div className="flex-1 overflow-y-auto bg-slate-50">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            选择左侧采集帧查看 OCR / 分区诊断
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {/* 第1层：会话识别结果（OCR 读标题→过滤/归组） */}
            <ConvDetectPanel frame={selected} />

            {/* 开关 */}
            <div className="flex items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={showOcrBoxes} onChange={(e) => setShowOcrBoxes(e.target.checked)} />
                显示 OCR 块框
              </label>
            </div>

            {/* 截图叠加 */}
            <FrameOverlay frame={selected} screenshot={screenshot} showOcrBoxes={showOcrBoxes} />

            {/* OCR 块列表 */}
            <section className="bg-white rounded-md border border-slate-200 p-4">
              <h3 className="text-xs font-medium text-slate-500 uppercase mb-2">
                OCR 块（{selected.ocrBlocks.length}）· 状态 {selected.ocrStatus}
              </h3>
              <div className="space-y-0.5 max-h-80 overflow-y-auto text-xs font-mono">
                {selected.ocrBlocks.map((b, i) => (
                  <div key={i} className="flex items-start gap-2 py-0.5 border-b border-slate-50">
                    <span className="shrink-0 text-slate-400 text-[10px] w-32">
                      ({b.bbox.x},{b.bbox.y}) {b.bbox.width}×{b.bbox.height}
                    </span>
                    <span className="text-slate-800">{b.text}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

// 左侧列表里每帧的会话识别小标签
function ConvTag({ frame }: { frame: CaptureFrameDebug }): React.JSX.Element {
  const d = detectConversation(frame.ocrBlocks)
  const cls =
    d.kind === 'customer'
      ? 'bg-emerald-100 text-emerald-700'
      : d.kind === 'taikang_group'
        ? 'bg-blue-100 text-blue-700'
        : 'bg-slate-100 text-slate-400'
  return (
    <div className={`mt-1 px-1.5 py-0.5 rounded text-[10px] truncate ${cls}`}>
      {convKindLabel(d)}
    </div>
  )
}

// 右侧：选中帧的会话识别结果详情
function ConvDetectPanel({ frame }: { frame: CaptureFrameDebug }): React.JSX.Element {
  const d = detectConversation(frame.ocrBlocks)
  const keep = d.kind !== 'none'
  return (
    <div
      className={`px-3 py-2 rounded border text-xs ${
        keep ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'
      }`}
    >
      <div className="font-semibold text-slate-700">第1层 会话识别（OCR 读标题）</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          判定：
          <span className={keep ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
            {convKindLabel(d)}
          </span>
        </span>
        {d.phone && <span className="text-slate-500">手机号：{d.phone}</span>}
        {d.name && <span className="text-slate-500">姓名：{d.name}</span>}
        <span className={keep ? 'text-emerald-600' : 'text-rose-500'}>
          {keep ? '→ 会送 AI 还原，并归入此会话' : '→ 不送 AI（丢弃）'}
        </span>
      </div>

      {/* 命中的手机号#姓名行（含坐标）。只有 y≤TITLE_MAX_Y 的才算标题，其余是侧边栏列表 */}
      {d.phoneHits.length > 0 && (
        <div className="mt-1.5 text-[10px] text-slate-500">
          手机号#姓名 命中（{d.phoneHits.length}处，标题栏 y≤{TITLE_MAX_Y}）：
          {d.phoneHits.map((l, i) => {
            const isTitle = l.y <= TITLE_MAX_Y
            return (
              <div key={i} className={`font-mono ${isTitle ? 'text-emerald-600' : 'text-slate-400'}`}>
                {isTitle ? '✓标题 ' : '　侧栏 '}({l.x},{l.y}) {l.text}
              </div>
            )
          })}
        </div>
      )}

      {/* 拼接后的前若干行，确认按行拼接是否正确 */}
      <details className="mt-1.5 text-[10px]">
        <summary className="cursor-pointer text-slate-400">拼接后的行（前 {d.lines.length} 行）</summary>
        <div className="mt-1 space-y-0.5 font-mono text-slate-500">
          {d.lines.map((l, i) => (
            <div key={i}>
              ({l.x},{l.y}) {l.text}
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

function FrameStatusBadge({ status }: { status: string }): React.JSX.Element {
  const map: Record<string, string> = {
    captured: 'bg-emerald-100 text-emerald-700',
    skipped_duplicate: 'bg-slate-100 text-slate-500',
    ocr_failed: 'bg-red-100 text-red-700',
    no_layout: 'bg-amber-100 text-amber-700'
  }
  return <span className={`px-1 rounded ${map[status] ?? 'bg-slate-100 text-slate-500'}`}>{status}</span>
}

function FrameOverlay({
  frame,
  screenshot,
  showOcrBoxes
}: {
  frame: CaptureFrameDebug
  screenshot: string | null
  showOcrBoxes: boolean
}): React.JSX.Element {
  const W = frame.windowWidth || 1
  const H = frame.windowHeight || 1
  const pct = (v: number, total: number): string => `${(v / total) * 100}%`

  return (
    <div className="bg-white rounded-md border border-slate-200 p-2 inline-block max-w-full">
      <div className="relative inline-block max-w-full">
        {screenshot ? (
          <img src={screenshot} alt="采集截图" className="block max-w-full h-auto" />
        ) : (
          <div className="w-[600px] h-[400px] flex items-center justify-center text-slate-400 text-sm">
            截图加载中 / 无法读取（{frame.screenshotPath}）
          </div>
        )}
        {screenshot && showOcrBoxes && (
          <div className="absolute inset-0 pointer-events-none">
            {frame.ocrBlocks.map((b, i) => (
              <div
                key={i}
                className="absolute border border-emerald-500/60"
                style={{
                  left: pct(b.bbox.x, W),
                  top: pct(b.bbox.y, H),
                  width: pct(b.bbox.width, W),
                  height: pct(b.bbox.height, H)
                }}
                title={b.text}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
