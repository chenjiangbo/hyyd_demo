import { useCallback, useEffect, useMemo, useState } from 'react'
import { detectConversation } from '../lib/detectConversation'
import { sampleFrames, dedupMessages, mergeInto } from '../lib/mergeMessages'

type Channel = 'wxwork' | 'wechat'

const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'wxwork', label: '企业微信' },
  { key: 'wechat', label: '微信' }
]

// 不含 "/" → 走百炼（DashScope，国内直连）；含 "/" → 走 blackwhite 网关（OpenRouter）
const DEFAULT_MODELS = [
  'qwen3-vl-235b-a22b-instruct',
  'qwen-vl-max-latest',
  'bytedance-seed/seed-1.6'
]
const SAMPLE_INTERVAL_SEC = 20

interface Conversation {
  key: string
  kind: 'customer' | 'taikang_group'
  title: string
  frames: CaptureFrameDebug[] // 按时间升序
}

export default function CaptureAiView(): React.JSX.Element {
  const [channel, setChannel] = useState<Channel>('wxwork')
  const [frames, setFrames] = useState<CaptureFrameDebug[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set()) // 选中要发 VL 的 frame id
  const [modelsText, setModelsText] = useState(DEFAULT_MODELS.join('\n'))
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastRun, setLastRun] = useState<AiReconstructResult[] | null>(null)
  // 跨多次还原累积（本会话内存）：key = `${convKey}::${model}`
  const [accum, setAccum] = useState<Record<string, AiReconstructMessage[]>>({})
  const [lastStats, setLastStats] = useState<Record<string, { raw: number; deduped: number; added: number; duplicate: number }>>({})
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [zoom, setZoom] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!window.api?.getCaptureFrames) {
      setError('采集接口不可用（仅打包后的 Windows 客户端）')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await window.api.getCaptureFrames(channel, 300)
      setFrames(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [channel])

  useEffect(() => {
    load()
  }, [load])

  // 按会话分组（用 OCR 标题识别；none 丢弃）
  const conversations = useMemo<Conversation[]>(() => {
    const map = new Map<string, Conversation>()
    for (const f of frames) {
      const d = detectConversation(f.ocrBlocks)
      if (d.kind === 'none' || !d.title) continue
      const key = `${d.kind}:${d.title}`
      if (!map.has(key)) map.set(key, { key, kind: d.kind, title: d.title, frames: [] })
      map.get(key)!.frames.push(f)
    }
    const list = [...map.values()]
    for (const c of list) c.frames.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))
    // 按最近活动降序
    list.sort((a, b) => {
      const la = a.frames[a.frames.length - 1]?.capturedAt ?? ''
      const lb = b.frames[b.frames.length - 1]?.capturedAt ?? ''
      return lb.localeCompare(la)
    })
    return list
  }, [frames])

  const selectedConv = useMemo(
    () => conversations.find((c) => c.key === selectedKey) ?? null,
    [conversations, selectedKey]
  )

  // 选中会话时，自动按 20s 规则预选帧
  useEffect(() => {
    if (!selectedConv) {
      setPicked(new Set())
      return
    }
    const sampled = sampleFrames(selectedConv.frames, SAMPLE_INTERVAL_SEC)
    setPicked(new Set(sampled.map((f) => f.id)))
  }, [selectedConv])

  // 为选中会话的帧加载缩略图（点开可放大评估）
  useEffect(() => {
    if (!selectedConv || !window.api) return
    let cancelled = false
    const missing = selectedConv.frames.filter((f) => !(f.id in thumbs))
    if (missing.length === 0) return
    Promise.all(
      missing.map(async (f) => ({ id: f.id, url: await window.api!.getCaptureScreenshot(f.screenshotPath) }))
    ).then((loaded) => {
      if (cancelled) return
      setThumbs((prev) => {
        const n = { ...prev }
        for (const { id, url } of loaded) if (url) n[id] = url
        return n
      })
    })
    return () => {
      cancelled = true
    }
  }, [selectedConv, thumbs])

  const togglePick = (id: number): void => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const run = useCallback(async () => {
    if (!window.api || !selectedConv) return
    const sendFrames = selectedConv.frames.filter((f) => picked.has(f.id))
    if (sendFrames.length === 0) {
      setRunError('请至少选 1 张帧')
      return
    }
    const models = modelsText
      .split(/[\n,]/)
      .map((m) => m.trim())
      .filter(Boolean)
    if (models.length === 0) {
      setRunError('请至少填一个模型')
      return
    }
    setRunning(true)
    setRunError(null)
    try {
      const inputs = sendFrames.map((f) => ({ path: f.screenshotPath, capturedAt: f.capturedAt }))
      const res = await window.api.reconstructCaptureAi(inputs, models, channel)
      setLastRun(res)
      // 对每个模型：先去重本次结果，再并入累积
      const nextAccum = { ...accum }
      const stats: Record<string, { raw: number; deduped: number; added: number; duplicate: number }> = {}
      for (const r of res) {
        const akey = `${selectedConv.key}::${r.model}`
        const dd = dedupMessages(r.messages)
        const merged = mergeInto(nextAccum[akey] ?? [], dd.kept)
        nextAccum[akey] = merged.merged
        stats[akey] = {
          raw: r.messages.length,
          deduped: dd.kept.length,
          added: merged.added,
          duplicate: merged.duplicate
        }
      }
      setAccum(nextAccum)
      setLastStats((p) => ({ ...p, ...stats }))
    } catch (e) {
      setRunError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }, [selectedConv, picked, modelsText, channel, accum])

  const fmtTime = (s: string): string => {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString('zh-CN')
  }

  return (
    <div className="flex h-full">
      {/* 左：会话列表 */}
      <div className="w-72 border-r border-slate-200 flex flex-col bg-white">
        <div className="px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold text-slate-800">
            AI 还原 · 会话 <span className="text-slate-400 font-normal">({conversations.length})</span>
          </div>
          <div className="mt-2 flex gap-1">
            {CHANNELS.map((c) => (
              <button
                key={c.key}
                onClick={() => {
                  setChannel(c.key)
                  setSelectedKey(null)
                }}
                className={`px-3 py-1 text-xs rounded transition ${
                  channel === c.key ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {c.label}
              </button>
            ))}
            <button
              onClick={load}
              className="ml-auto px-3 py-1 text-xs rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
            >
              ↻ 刷新
            </button>
          </div>
          <div className="mt-1.5 text-[11px] text-slate-400">
            共 {frames.length} 帧，按标题归到 {conversations.length} 个会话（未匹配的已排除）
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {loading && <div className="px-4 py-3 text-xs text-slate-400">加载中…</div>}
          {error && <div className="px-4 py-3 text-xs text-rose-500">{error}</div>}
          {!loading && conversations.length === 0 && (
            <div className="px-4 py-6 text-xs text-slate-400">没有识别到客户/泰康群会话</div>
          )}
          {conversations.map((c) => {
            const span =
              c.frames.length > 0
                ? `${fmtTime(c.frames[0].capturedAt)} ~ ${fmtTime(c.frames[c.frames.length - 1].capturedAt)}`
                : ''
            return (
              <button
                key={c.key}
                onClick={() => setSelectedKey(c.key)}
                className={`w-full text-left px-4 py-2.5 border-b border-slate-100 text-xs transition ${
                  c.key === selectedKey ? 'bg-emerald-50' : 'hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`px-1 rounded text-[10px] ${
                      c.kind === 'customer' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {c.kind === 'customer' ? '客户' : '泰康群'}
                  </span>
                  <span className="font-medium text-slate-700 truncate">{c.title}</span>
                </div>
                <div className="text-slate-400 mt-0.5">{c.frames.length} 帧 · {span}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* 右：选中会话的挑帧 + 还原 + 结果 */}
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
        {!selectedConv ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
            选择左侧一个会话
          </div>
        ) : (
          <>
            {/* 挑帧 + 控制 */}
            <div className="px-5 py-3 border-b border-slate-200 bg-white space-y-2">
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-500 mb-1">
                    要发给 VL 的帧（已自动按 {SAMPLE_INTERVAL_SEC}s 挑帧 + 最后一张，可手动勾选）：
                    选中 {picked.size}/{selectedConv.frames.length}
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {selectedConv.frames.map((f) => {
                      const on = picked.has(f.id)
                      const url = thumbs[f.id]
                      return (
                        <div
                          key={f.id}
                          className={`shrink-0 border-2 rounded overflow-hidden bg-white ${
                            on ? 'border-emerald-500' : 'border-slate-200'
                          }`}
                        >
                          <div className="relative">
                            {url ? (
                              <img
                                src={url}
                                onClick={() => setZoom(url)}
                                title="点击放大"
                                className="h-28 w-auto block cursor-zoom-in"
                                alt={f.capturedAt}
                              />
                            ) : (
                              <div className="h-28 w-36 flex items-center justify-center text-[10px] text-slate-400">
                                缩略图加载中…
                              </div>
                            )}
                            <label className="absolute top-1 left-1 bg-white/85 rounded px-1 py-0.5 cursor-pointer flex items-center gap-1 text-[10px]">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => togglePick(f.id)}
                                className="accent-emerald-500"
                              />
                              {on ? '发送' : '跳过'}
                            </label>
                          </div>
                          <div className="text-[10px] font-mono text-center text-slate-500 px-1 py-0.5">
                            {new Date(f.capturedAt).toLocaleTimeString('zh-CN')}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 pt-4">
                  <button
                    onClick={run}
                    disabled={running || picked.size === 0}
                    className="px-4 py-2 text-sm rounded bg-emerald-500 text-white disabled:opacity-40 hover:bg-emerald-600"
                  >
                    {running ? '还原中…' : `用 AI 还原 (${picked.size}张)`}
                  </button>
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">对比模型（每行一个）</div>
                <textarea
                  value={modelsText}
                  onChange={(e) => setModelsText(e.target.value)}
                  rows={2}
                  className="w-full text-xs font-mono border border-slate-300 rounded px-2 py-1.5 resize-y"
                />
              </div>
              {runError && <div className="text-xs text-rose-500">{runError}</div>}
            </div>

            {/* 结果（每个模型一列：累积消息 + 本次统计 + 原始返回） */}
            <div className="flex-1 overflow-auto p-4">
              {!lastRun && !running && (
                <div className="h-full flex items-center justify-center text-sm text-slate-400">
                  勾选帧后点「用 AI 还原」。多次还原会把新消息合并去重进同一份。
                </div>
              )}
              {running && <div className="text-sm text-slate-500">正在请求模型…图片多时要十几秒。</div>}
              {lastRun && (
                <div className="flex gap-4 h-full">
                  {lastRun.map((r) => {
                    const akey = `${selectedConv.key}::${r.model}`
                    return (
                      <ModelColumn
                        key={r.model}
                        result={r}
                        merged={accum[akey] ?? []}
                        stats={lastStats[akey]}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* 点击缩略图放大看原图 */}
      {zoom && (
        <div
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6 cursor-zoom-out"
        >
          <img src={zoom} className="max-w-full max-h-full object-contain" alt="预览" />
        </div>
      )}
    </div>
  )
}

function ModelColumn({
  result,
  merged,
  stats
}: {
  result: AiReconstructResult
  merged: AiReconstructMessage[]
  stats?: { raw: number; deduped: number; added: number; duplicate: number }
}): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white rounded border border-slate-200 overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-200 bg-slate-50">
        <div className="text-xs font-semibold text-slate-800 truncate" title={result.model}>
          {result.model}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
          <span>{result.latencyMs} ms</span>
          {result.ok ? (
            <span className="text-emerald-600">累积 {merged.length} 条</span>
          ) : (
            <span className="text-rose-500">失败</span>
          )}
          {result.isChat === false && (
            <span className="px-1.5 rounded bg-amber-100 text-amber-700">非聊天页</span>
          )}
        </div>
        {stats && (
          <div className="mt-1 text-[10px] text-slate-400">
            本次：原始 {stats.raw} → 去重 {stats.deduped} → 并入累积 新增 {stats.added}/重复 {stats.duplicate}
          </div>
        )}
        {result.conversationTitle && (
          <div className="mt-0.5 text-[10px] text-slate-500 truncate">标题：{result.conversationTitle}</div>
        )}
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-1.5">
        {result.error && <div className="text-xs text-rose-500 break-words">{result.error}</div>}
        {!result.error && merged.length === 0 && <div className="text-xs text-slate-400">（无消息）</div>}
        {merged.map((m, i) => (
          <Bubble key={i} msg={m} />
        ))}
      </div>
      <button
        onClick={() => setShowRaw((v) => !v)}
        className="px-3 py-1.5 text-[11px] text-slate-400 hover:text-slate-600 border-t border-slate-200 text-left"
      >
        {showRaw ? '▾ 隐藏本次原始返回' : '▸ 本次原始返回'}
      </button>
      {showRaw && (
        <pre className="max-h-48 overflow-auto bg-slate-900 text-slate-100 text-[10px] p-2 whitespace-pre-wrap break-words">
          {result.rawContent || '(空)'}
        </pre>
      )}
    </div>
  )
}

function Bubble({ msg }: { msg: AiReconstructMessage }): React.JSX.Element {
  if (msg.sender === 'system') {
    return <div className="text-center text-[10px] text-slate-400 py-0.5">{msg.content}</div>
  }
  const self = msg.sender === 'self'
  return (
    <div className={`flex ${self ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[85%]">
        {!self && msg.name && <div className="text-[10px] text-slate-400 mb-0.5">{msg.name}</div>}
        <div
          className={`px-2.5 py-1.5 rounded-lg text-xs break-words ${
            self ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-800'
          }`}
        >
          {msg.type !== 'text' && <span className="opacity-60 mr-1">[{msg.type}]</span>}
          {msg.content}
        </div>
        {msg.time && (
          <div className={`text-[10px] text-slate-300 mt-0.5 ${self ? 'text-right' : ''}`}>{msg.time}</div>
        )}
      </div>
    </div>
  )
}
