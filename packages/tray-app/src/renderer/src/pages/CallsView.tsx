import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type CallSummary,
  type CallTranscript,
  type AsrStatus
} from '../api/client'

const LIST_POLL_MS = 5_000 // 列表里有 processing 时的自动刷新间隔
const DETAIL_POLL_MS = 3_000

export default function CallsView(): React.JSX.Element {
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.listCalls()
      setCalls(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 列表只要有任意一条 processing，每 LIST_POLL_MS 自动刷新
  const hasProcessing = useMemo(
    () => calls.some((c) => c.asrStatus === 'processing' || c.asrStatus === 'pending'),
    [calls]
  )
  useEffect(() => {
    if (!hasProcessing) return
    const t = setInterval(refresh, LIST_POLL_MS)
    return () => clearInterval(t)
  }, [hasProcessing, refresh])

  // 过滤
  const filtered = useMemo(() => {
    if (!query.trim()) return calls
    const q = query.trim().toLowerCase()
    return calls.filter((c) =>
      c.phone.toLowerCase().includes(q) ||
      c.order?.sourceOrderNo.toLowerCase().includes(q) ||
      c.order?.customerName.toLowerCase().includes(q)
    )
  }, [calls, query])

  const selected = useMemo(() => calls.find((c) => c.id === selectedId) ?? null, [calls, selectedId])

  return (
    <div className="flex h-full">
      {/* 左侧列表 */}
      <div className="w-80 border-r border-slate-200 flex flex-col bg-white">
        <header className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-2">
          <h1 className="text-base font-semibold text-slate-800">
            通话记录 <span className="text-slate-400 font-normal">({calls.length})</span>
          </h1>
          <button
            onClick={refresh}
            disabled={loading}
            className="text-xs px-2 py-1 border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded"
          >
            {loading ? '…' : '🔄'}
          </button>
        </header>
        <div className="px-3 py-2 border-b border-slate-100">
          <input
            type="text"
            placeholder="搜索号码 / 订单号 / 就诊人"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded focus:outline-none focus:border-blue-400"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="mx-3 my-2 px-3 py-2 bg-red-50 border border-red-200 text-xs text-red-700 rounded">
              ❌ {error}
            </div>
          )}
          {filtered.length === 0 && !loading && (
            <div className="text-center py-12 text-slate-400 text-sm">
              {query ? '无匹配结果' : '暂无通话记录'}
            </div>
          )}
          {filtered.map((c) => (
            <CallCard
              key={c.id}
              call={c}
              active={c.id === selectedId}
              onClick={() => setSelectedId(c.id)}
            />
          ))}
        </div>
      </div>

      {/* 右侧详情 */}
      <div className="flex-1 overflow-y-auto bg-slate-50">
        {selected ? (
          <CallDetailPanel call={selected} onRefreshList={refresh} />
        ) : (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            请选择左侧通话查看详情
          </div>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 列表卡片
// ────────────────────────────────────────────────────────────

function CallCard({
  call,
  active,
  onClick
}: {
  call: CallSummary
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const time = new Date(call.startedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-3 border-b border-slate-100 hover:bg-slate-50 transition ${
        active ? 'bg-blue-50 border-l-4 border-l-blue-500' : 'border-l-4 border-l-transparent'
      }`}
    >
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {call.direction === 'in' ? '📥 来电' : '📤 去电'} · {time}
        </span>
        <span>{formatDuration(call.durationSec)}</span>
      </div>
      <div className="text-sm text-slate-700 mt-1">
        {call.contactName ? (
          <span>
            {call.contactName} <span className="font-mono text-xs text-slate-400">{call.phone}</span>
          </span>
        ) : (
          <span className="font-mono">{call.phone}</span>
        )}
      </div>
      <div className="text-xs text-slate-600 mt-1">
        {call.order ? (
          <span>
            <span className="text-slate-400">→</span> {call.order.customerName} ·{' '}
            <code className="text-[10px] text-slate-500">{call.order.sourceOrderNo.slice(-8)}</code>
          </span>
        ) : (
          <span className="text-slate-400">未关联订单</span>
        )}
      </div>
      <div className="mt-1.5">
        <CallStatusBadge call={call} />
      </div>
    </button>
  )
}

/**
 * 通话状态徽章：
 * - 未接通的通话（missed/rejected/outgoing_unanswered）：直接显示通话结果，不谈转写
 * - 已接通（answered）：按是否有录音 + 转写状态显示
 */
function CallStatusBadge({ call }: { call: CallSummary }): React.JSX.Element {
  // 未接通类：优先按 callStatus 展示，这类通话本来就没有录音
  const callStatusMap: Record<string, { label: string; cls: string }> = {
    missed: { label: '🔴 未接来电', cls: 'bg-red-50 text-red-600' },
    rejected: { label: '🚫 已拒接', cls: 'bg-orange-50 text-orange-600' },
    outgoing_unanswered: { label: '📞 未接通', cls: 'bg-slate-100 text-slate-500' }
  }
  if (call.callStatus && call.callStatus !== 'answered') {
    const m = callStatusMap[call.callStatus] ?? { label: call.callStatus, cls: 'bg-slate-100 text-slate-500' }
    return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>
  }

  // 已接通：没录音 vs 有录音按转写状态
  if (!call.hasRecording) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
        已接通 · 无录音
      </span>
    )
  }
  const asrMap: Record<AsrStatus, { label: string; cls: string }> = {
    no_recording: { label: '无录音', cls: 'bg-slate-100 text-slate-500' },
    pending: { label: '待转写', cls: 'bg-slate-100 text-slate-600' },
    processing: { label: '转写中…', cls: 'bg-amber-100 text-amber-700 animate-pulse' },
    done: { label: '已转写 ✓', cls: 'bg-emerald-100 text-emerald-700' },
    failed: { label: '转写失败', cls: 'bg-red-100 text-red-700' },
    requires_manual: { label: '需人工', cls: 'bg-orange-100 text-orange-700' }
  }
  const m = asrMap[call.asrStatus] ?? asrMap.pending
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>
}

// ────────────────────────────────────────────────────────────
// 详情面板
// ────────────────────────────────────────────────────────────

function CallDetailPanel({
  call,
  onRefreshList
}: {
  call: CallSummary
  onRefreshList: () => void
}): React.JSX.Element {
  const [transcript, setTranscript] = useState<CallTranscript | null>(null)
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const detailAbortRef = useRef(false)

  // 加载详情：转写 + 录音 URL
  // 注：本期 demo 不接 LLM，关联订单完全靠 phone 匹配，所以删掉 AI 分析获取。
  useEffect(() => {
    detailAbortRef.current = false
    setTranscript(null)
    setRecordingUrl(null)
    setError(null)
    setLoading(true)

    const load = async (): Promise<void> => {
      try {
        const t = await api.getCallTranscript(call.id)
        if (detailAbortRef.current) return
        setTranscript(t)
        if (call.hasRecording) {
          try {
            const r = await api.getCallRecordingUrl(call.id)
            if (!detailAbortRef.current) setRecordingUrl(r.url)
          } catch (e) {
            console.warn('录音 URL 获取失败:', e)
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    }
    void load()

    return () => {
      detailAbortRef.current = true
    }
  }, [call.id, call.hasRecording])

  // 选中后如果还是 processing/pending，定时轮询
  useEffect(() => {
    if (!transcript) return
    if (transcript.asrStatus !== 'pending' && transcript.asrStatus !== 'processing') return
    const t = setInterval(async () => {
      try {
        const newT = await api.getCallTranscript(call.id)
        setTranscript(newT)
        if (newT.asrStatus === 'done' || newT.asrStatus === 'failed') {
          onRefreshList() // 让左列表也更新一下
        }
      } catch {/* 静默 */}
    }, DETAIL_POLL_MS)
    return () => clearInterval(t)
  }, [transcript, call.id, onRefreshList])

  const handleRetry = async () => {
    setRetrying(true)
    try {
      await api.retranscribeCall(call.id)
      // 立刻拉一次新状态
      const t = await api.getCallTranscript(call.id)
      setTranscript(t)
      onRefreshList()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRetrying(false)
    }
  }

  const handleCopy = () => {
    if (transcript?.asrText) {
      navigator.clipboard.writeText(transcript.asrText).catch(() => null)
    }
  }

  const startedAt = new Date(call.startedAt).toLocaleString('zh-CN')

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto">
      {/* 元数据头 */}
      <section className="bg-white rounded-md border border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold text-slate-800">
              {call.direction === 'in' ? '📥 来电' : '📤 去电'}{' '}
              {call.contactName ? `${call.contactName} (${call.phone})` : call.phone}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {startedAt} · 时长 {formatDuration(call.durationSec)}
            </div>
          </div>
          <CallStatusBadge call={call} />
        </div>
      </section>

      {/* 关联订单卡 —— 按手机号实时匹配 */}
      <section className="bg-white rounded-md border border-slate-200 p-4">
        <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
          关联订单
          {call.relatedOrders.length > 1 && (
            <span className="ml-2 text-fg-subtle normal-case">
              （{call.relatedOrders.length} 单同号）
            </span>
          )}
        </h3>
        {call.relatedOrders.length === 0 ? (
          <div className="text-sm text-slate-500">
            未匹配到当前员工名下手机号一致的订单。
            <div className="text-[11px] text-fg-subtle mt-1">
              按手机号精确匹配；订单详情（recommendations）抓回前可能临时匹配不上。
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {call.relatedOrders.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-slate-800 truncate">
                    {o.customerName} ·{' '}
                    <code className="text-xs text-slate-600">{o.sourceOrderNo}</code>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">状态: {o.status}</div>
                </div>
                <span className="text-xs text-slate-400 shrink-0">订单 #{o.id}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 录音播放器 */}
      <section className="bg-white rounded-md border border-slate-200 p-4">
        <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">录音</h3>
        {!call.hasRecording ? (
          <div className="text-sm text-slate-400">
            {call.callStatus === 'missed'
              ? '未接来电，无录音'
              : call.callStatus === 'rejected'
                ? '已拒接，无录音'
                : call.callStatus === 'outgoing_unanswered'
                  ? '拨出未接通，无录音'
                  : '该通话尚未上传录音文件（或客户端未匹配到录音）'}
          </div>
        ) : recordingUrl ? (
          // controlsList 禁用下载按钮（避免误下载客户隐私）
          <audio controls preload="metadata" controlsList="nodownload" className="w-full">
            <source src={recordingUrl} />
            浏览器不支持 audio 标签
          </audio>
        ) : (
          <div className="text-sm text-slate-400">加载录音 URL 中…</div>
        )}
      </section>

      {/* 转写文字 */}
      <section className="bg-white rounded-md border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide">通话转写</h3>
          <div className="flex items-center gap-2">
            {transcript?.asrText && (
              <button
                onClick={handleCopy}
                className="text-xs px-2 py-1 border border-slate-300 hover:bg-slate-50 rounded"
              >
                📋 复制
              </button>
            )}
            {call.hasRecording &&
              transcript &&
              transcript.asrStatus !== 'processing' &&
              transcript.asrStatus !== 'pending' && (
                <button
                  onClick={handleRetry}
                  disabled={retrying}
                  className="text-xs px-2 py-1 border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded"
                >
                  {retrying ? '触发中…' : '🔄 重抓转写'}
                </button>
              )}
          </div>
        </div>
        <TranscriptBlock transcript={transcript} loading={loading} error={error} />
      </section>

      {/* 本期不接 LLM 分析，先采数据为重，后续再上 */}
    </div>
  )
}

function TranscriptBlock({
  transcript,
  loading,
  error
}: {
  transcript: CallTranscript | null
  loading: boolean
  error: string | null
}): React.JSX.Element {
  if (loading && !transcript) {
    return <div className="text-sm text-slate-400">加载中…</div>
  }
  if (error) {
    return <div className="text-sm text-red-600">❌ {error}</div>
  }
  if (!transcript) {
    return <div className="text-sm text-slate-400">无数据</div>
  }
  if (transcript.asrStatus === 'no_recording') {
    return <div className="text-sm text-slate-400">这条通话没有录音，无法转写。</div>
  }
  if (transcript.asrStatus === 'processing' || transcript.asrStatus === 'pending') {
    return (
      <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
        ⏳ 正在转写中…（每 3 秒自动刷新）
      </div>
    )
  }
  if (transcript.asrStatus === 'failed' || transcript.asrStatus === 'requires_manual') {
    return (
      <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
        ❌ {transcript.asrText || '转写失败'}
      </div>
    )
  }
  if (!transcript.asrText) {
    return <div className="text-sm text-slate-400">转写完成但内容为空</div>
  }
  // 按行渲染。说话人按 speaker_id 区分上色（不臆测谁是客服/客户），同一说话人同色
  const lines = transcript.asrText.split('\n')
  // 调色板：按出现顺序给每个不同说话人分配一个颜色
  const palette = [
    'text-blue-700 bg-blue-50',
    'text-orange-700 bg-orange-50',
    'text-emerald-700 bg-emerald-50',
    'text-violet-700 bg-violet-50',
    'text-rose-700 bg-rose-50'
  ]
  const speakerColor = new Map<string, string>()
  const colorOf = (speaker: string): string => {
    if (!speakerColor.has(speaker)) {
      speakerColor.set(speaker, palette[speakerColor.size % palette.length])
    }
    return speakerColor.get(speaker)!
  }
  return (
    <div className="space-y-1 font-mono text-sm leading-relaxed">
      {lines.map((line, i) => {
        // 格式: [00:00] 说话人 N：xxx
        const m = line.match(/^\[([^\]]+)\]\s*([^：:]+)[：:]\s*(.*)$/)
        if (!m) {
          return <div key={i} className="text-slate-700">{line}</div>
        }
        const [, ts, speaker, text] = m
        return (
          <div key={i} className="flex items-start gap-2">
            <span className="text-xs text-slate-400 shrink-0 mt-0.5 w-12">{ts}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${colorOf(speaker)}`}>{speaker}</span>
            <span className="text-slate-800">{text}</span>
          </div>
        )
      })}
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
