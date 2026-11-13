import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { Card, LoadingBlock, ErrorBlock, EmptyBlock } from '../components/ui'
import { StatusBadge, PoolBadge } from '../components/badges'
import { MaterialCard } from '../components/MaterialCard'
import { Lightbox } from '../components/Lightbox'
import { fmtTime, fmtTimeFull, fmtBytes, fmtDuration } from '../lib/format'
import { ORDER_FIELD_GROUPS, KNOWN_KEYS, isEmptyVal } from '../lib/orderFields'
import { AsrBadge } from '../components/badges'
import type { OrderMessage } from '../api/types'

type OrderDetailTab = 'basic' | 'messages' | 'calls' | 'ai'
type MessageChannelTab = 'all' | 'wxwork' | 'wechat'

function Field({ label, value, raw }: { label: string; value: unknown; raw?: boolean }): React.JSX.Element {
  return (
    <div className="flex gap-2 py-1 text-sm">
      <span className="w-28 shrink-0 text-fg-muted" title={raw ? '原始值（未做语义解读）' : undefined}>
        {label}
        {raw && <span className="text-fg-subtle"> *</span>}
      </span>
      <span className="break-all">{String(value)}</span>
    </div>
  )
}

export default function OrderDetailPage(): React.JSX.Element {
  const { id } = useParams()
  const orderId = Number(id)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [showJson, setShowJson] = useState(false)
  const [activeTab, setActiveTab] = useState<OrderDetailTab>('basic')
  const [messageChannel, setMessageChannel] = useState<MessageChannelTab>('all')
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisStatus, setAnalysisStatus] = useState<{ ok: boolean; text: string } | null>(null)

  async function reanalyze(): Promise<void> {
    setAnalyzing(true)
    setAnalysisStatus(null)
    try {
      await adminApi.reanalyzeOrder(orderId)
      await aiResult.refetch()
      setAnalysisStatus({ ok: true, text: '分析完成' })
    } catch (error) {
      void aiResult.refetch()
      setAnalysisStatus({ ok: false, text: error instanceof Error ? error.message : '分析失败' })
    } finally {
      setAnalyzing(false)
    }
  }

  const q = useQuery({
    queryKey: ['order-full', orderId],
    queryFn: () => adminApi.orderFull(orderId),
    enabled: Number.isFinite(orderId)
  })
  const aiResult = useQuery({
    queryKey: ['order-ai-result', orderId],
    queryFn: () => adminApi.orderAiResult(orderId),
    enabled: Number.isSafeInteger(orderId) && orderId > 0
  })

  if (q.isLoading) return <LoadingBlock />
  if (q.error) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
  if (!q.data) return <EmptyBlock />

  const { order, recommendations, attachments, materials, calls, statusHistory, messages } =
    q.data
  const rec = recommendations ?? {}
  const displayName = String(rec.patientName || rec.insurName || order.customerName || '—')
  const displayPhone = String(rec.paMobile || rec.ecpPhone || order.customerPhone || '—')
  const filteredMessages = messages.filter((m) => messageChannel === 'all' || m.channel === messageChannel)
  const wxworkCount = messages.filter((m) => m.channel === 'wxwork').length
  const wechatCount = messages.filter((m) => m.channel === 'wechat').length
  // 未知字段：rec 里有值但不在已知映射里的
  const unknownFields = Object.entries(rec).filter(([k, v]) => !KNOWN_KEYS.has(k) && !isEmptyVal(v))
  const aiGroups = new Map<string, NonNullable<NonNullable<typeof aiResult.data>['result']>['fields']>()
  for (const field of aiResult.data?.result?.fields ?? []) {
    const key = field.orderNo || ''
    const group = aiGroups.get(key) ?? []
    group.push(field)
    aiGroups.set(key, group)
  }

  return (
    <div>
      {/* 返回 + header */}
      <div className="mb-4">
        <Link to="/orders" className="text-sm text-fg-muted hover:text-fg">
          ← 返回订单列表
        </Link>
      </div>

      <Card className="p-5 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <h1 className="text-xl font-semibold">{displayName}</h1>
          <PoolBadge poolType={order.poolType} />
          <StatusBadge status={order.status} />
          <button type="button" disabled={analyzing} onClick={() => void reanalyze()} className="ml-auto rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{analyzing ? '分析中…' : '重新分析'}</button>
          {analysisStatus && <span role="status" className={analysisStatus.ok ? 'text-sm text-green-700' : 'text-sm text-red-700'}>{analysisStatus.text}</span>}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-sm">
          <Field label="订单号" value={order.sourceOrderNo} />
          <Field label="客户电话" value={displayPhone} />
          <Field label="申领员工" value={order.employee?.name ?? '—'} />
          <Field label="详情抓取" value={order.detailFetchedAt ? fmtTimeFull(order.detailFetchedAt) : '未抓取'} />
          <Field label="创建时间" value={fmtTimeFull(order.createdAt)} />
          <Field label="更新时间" value={fmtTimeFull(order.updatedAt)} />
        </div>
      </Card>

      <div className="mb-4 border-b border-line">
        {[
          { key: 'basic' as const, label: '基本信息' },
          { key: 'messages' as const, label: `消息 ${messages.length}` },
          { key: 'calls' as const, label: `通话 ${calls.length}` },
          { key: 'ai' as const, label: 'AI分析结果' }
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`mr-5 border-b-2 px-1 pb-2 text-sm ${
              activeTab === tab.key
                ? 'border-accent text-accent-strong font-medium'
                : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'ai' && <Card className="p-5 mb-4">
        <h2 className="text-sm font-semibold mb-3">最新分析结果</h2>
        {aiResult.isLoading ? <LoadingBlock /> : aiResult.error ? <ErrorBlock error={aiResult.error} onRetry={() => void aiResult.refetch()} /> : <>
          {aiResult.data?.latestRun?.status === 'failed' && <p className="mb-3 text-sm text-red-700">最近一次分析失败：{aiResult.data.latestRun.error || '请查看后台日志'}</p>}
          {aiResult.data?.latestRun?.status === 'running' && <p className="mb-3 text-sm text-fg-muted">正在分析，显示上次结果</p>}
          {aiResult.data?.result ? <>
            <p className="mb-3 text-xs text-fg-muted">分析时间：{fmtTimeFull(aiResult.data.result.completedAt || aiResult.data.result.createdAt)}　模型：{aiResult.data.result.model}</p>
            {aiResult.data.result.fields.length === 0 ? <EmptyBlock label="本次分析未提取到字段" /> : <div className="space-y-5">{[...aiGroups].map(([orderNo, fields]) => <section key={orderNo || 'unknown'}>
              {orderNo && <h3 className="mb-2 border-b border-line pb-2 text-sm font-semibold">寰宇订单号：{orderNo}</h3>}
              <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">{fields.map((field) => {
                const sources = Array.isArray(field.evidence) ? field.evidence.map((item: unknown) => item && typeof item === 'object' && 'sourceId' in item ? String(item.sourceId).trim() : '').filter(Boolean) : []
                return <div key={field.id} className="py-2 text-sm"><div className="flex gap-2"><span className="w-28 shrink-0 text-fg-muted">{field.label}</span><span className="whitespace-pre-wrap break-all">{field.value}</span></div>{sources.length > 0 && <div className="mt-1 pl-28 text-xs text-fg-muted">依据：{sources.join('、')}</div>}</div>
              })}</div>
            </section>)}</div>}
          </> : <EmptyBlock label="暂无分析结果" />}
        </>}
      </Card>}

      {activeTab === 'basic' && (
        <>
          <Card className="p-5 mb-4">
            <h2 className="text-sm font-semibold mb-3">状态变更历史（{statusHistory.length}）</h2>
            {statusHistory.length === 0 ? (
              <EmptyBlock label="暂无状态变更记录（插件下一轮同步后开始记录）" />
            ) : (
              <ol className="relative border-l border-line ml-2">
                {statusHistory.map((h, i) => {
                  const last = i === statusHistory.length - 1
                  return (
                    <li key={h.id} className="ml-4 pb-4 last:pb-0">
                      <span
                        className={`absolute -left-[5px] w-2.5 h-2.5 rounded-full ${
                          last ? 'bg-accent' : 'bg-line-strong'
                        }`}
                      />
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${last ? 'text-accent-strong' : ''}`}>
                          {h.orderStateName ?? '—'}
                        </span>
                        {h.orderState && (
                          <code className="text-xs text-fg-subtle">状态码 {h.orderState}</code>
                        )}
                        {last && <span className="text-xs text-accent-strong">当前</span>}
                      </div>
                      <div className="text-xs text-fg-subtle">{fmtTimeFull(h.recordedAt)}</div>
                    </li>
                  )
                })}
              </ol>
            )}
          </Card>

          <Card className="p-5 mb-4">
            <h2 className="text-sm font-semibold mb-3">泰康详情字段</h2>
            {!recommendations ? (
              <EmptyBlock label="该订单尚未抓取详情（detailJson 为空）" />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
                {ORDER_FIELD_GROUPS.map((g) => {
                  const present = g.fields.filter((f) => !isEmptyVal(rec[f.key]))
                  if (present.length === 0) return null
                  return (
                    <div key={g.group} className="mb-3 break-inside-avoid">
                      <div className="text-xs font-medium text-accent-strong mb-1">{g.group}</div>
                      {present.map((f) => (
                        <Field key={f.key} label={f.label} value={rec[f.key]} />
                      ))}
                    </div>
                  )
                })}
                {unknownFields.length > 0 && (
                  <div className="mb-3 break-inside-avoid">
                    <div className="text-xs font-medium text-fg-subtle mb-1">其他字段（原始值）</div>
                    {unknownFields.map(([k, v]) => (
                      <Field key={k} label={k} value={typeof v === 'object' ? JSON.stringify(v) : v} raw />
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card className="p-5 mb-4">
            <h2 className="text-sm font-semibold mb-3">附件（{attachments.length}）</h2>
            {attachments.length === 0 ? (
              <EmptyBlock label="无附件" />
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {attachments.map((a) => {
                  const isImg = a.mimeType?.startsWith('image/')
                  return (
                    <div key={a.id} className="text-center">
                      {isImg && a.url ? (
                        <img
                          src={a.url}
                          alt={a.fileName}
                          onClick={() => setLightbox(a.url)}
                          className="w-full h-24 object-cover rounded-md border border-line cursor-zoom-in"
                        />
                      ) : (
                        <a
                          href={a.url ?? '#'}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-center w-full h-24 rounded-md border border-line bg-surface-2 text-sm text-fg-muted"
                        >
                          文件
                        </a>
                      )}
                      <div className="mt-1 text-xs text-fg-muted truncate" title={a.fileName}>
                        {a.fileType}
                      </div>
                      <div className="text-xs text-fg-subtle">{fmtBytes(a.byteSize)}</div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>

          <Card className="p-5 mb-4">
            <h2 className="text-sm font-semibold mb-1">素材（{materials.length}）</h2>
            {materials.length === 0 ? (
              <EmptyBlock label="无素材" />
            ) : (
              <div>
                {materials.map((m) => (
                  <MaterialCard key={m.id} m={m} showOrder={false} onOpenImage={setLightbox} />
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <button
              onClick={() => setShowJson((v) => !v)}
              className="text-sm font-semibold text-fg-muted hover:text-fg"
            >
              {showJson ? '▲ 收起' : '▼ 展开'} 原始 JSON（rawJson / detailJson）
            </button>
            {showJson && (
              <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-fg-subtle mb-1">rawJson</div>
                  <pre className="text-xs bg-surface-2 rounded-md p-3 overflow-auto max-h-96">
                    {JSON.stringify(q.data.rawJson, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="text-xs text-fg-subtle mb-1">detailJson</div>
                  <pre className="text-xs bg-surface-2 rounded-md p-3 overflow-auto max-h-96">
                    {JSON.stringify(q.data.detailJson, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      {activeTab === 'messages' && (
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-3">
            {[
              { key: 'all' as const, label: `全部 ${messages.length}` },
              { key: 'wxwork' as const, label: `企微 ${wxworkCount}` },
              { key: 'wechat' as const, label: `微信 ${wechatCount}` }
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setMessageChannel(tab.key)}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  messageChannel === tab.key
                    ? 'bg-accent-soft text-accent-strong font-medium'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {filteredMessages.length === 0 ? (
            <div className="p-5">
              <EmptyBlock label="无采集到的聊天消息" />
            </div>
          ) : (
            <ChatTimeline messages={filteredMessages} onOpenImage={setLightbox} />
          )}
        </Card>
      )}

      {activeTab === 'calls' && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold mb-3">通话记录与录音（{calls.length}）</h2>
          {calls.length === 0 ? (
            <EmptyBlock label="无通话" />
          ) : (
            <div>
              {calls.map((c) => (
                <div key={c.id} className="py-3 border-b border-line last:border-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium tabular-nums">{c.phone}</span>
                    {c.contactName && <span className="text-xs text-fg-muted">{c.contactName}</span>}
                    <span className="text-xs text-fg-subtle">
                      {c.direction === 'in' ? '呼入' : '呼出'} · {fmtDuration(c.durationSec)} · {fmtTime(c.startedAt)}
                    </span>
                    <AsrBadge status={c.asrStatus} />
                    {c.hasRecording && <OrderCallAudio callId={c.id} />}
                  </div>
                  {c.asrText && (
                    <p className="mt-2 text-sm text-fg-muted whitespace-pre-wrap break-words">{c.asrText}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

// 聊天记录时间线：self 右、other 左、system 居中；chatTime 算不出时标"估"。
function ChatTimeline({
  messages,
  onOpenImage
}: {
  messages: OrderMessage[]
  onOpenImage: (url: string) => void
}): React.JSX.Element {
  return (
    <div className="max-h-[72vh] overflow-auto bg-surface-2 px-5 py-4">
      <div className="space-y-3">
      {messages.map((m, index) => {
        const showConversation = index === 0 || messages[index - 1].conversationName !== m.conversationName
        if (m.senderType === 'system') {
          return (
            <div key={m.id}>
              {showConversation && <ConversationDivider name={m.conversationName} />}
              <div className="text-center">
                <span className="text-xs text-fg-subtle bg-surface rounded-full px-2.5 py-0.5">
                  {m.contentText}
                </span>
              </div>
            </div>
          )
        }
        const self = m.senderType === 'self'
        const estimated = !m.chatTime
        const time = fmtTime(m.chatTime ?? m.sortTime ?? m.capturedAt)
        return (
          <div key={m.id}>
            {showConversation && <ConversationDivider name={m.conversationName} />}
            <div className={`flex ${self ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[74%] ${self ? 'items-end' : 'items-start'} flex flex-col`}>
                <div className={`mb-1 flex items-center gap-2 px-1 ${self ? 'flex-row-reverse' : ''}`}>
                  {m.senderName && <span className="text-xs text-fg-subtle">{m.senderName}</span>}
                  <span className="text-[11px] text-fg-subtle">{time}</span>
                </div>
                <div
                  className={`rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm ${
                    self
                      ? 'bg-accent-soft text-accent-strong rounded-tr-sm'
                      : 'bg-surface text-fg rounded-tl-sm'
                  }`}
                >
                  {m.contentText}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 px-1">
                  {estimated && <span className="text-[11px] text-warning">估</span>}
                  {m.seenCount > 1 && (
                    <span className="text-[11px] text-fg-subtle">×{m.seenCount}</span>
                  )}
                  {m.screenshotUrl && (
                    <button
                      onClick={() => onOpenImage(m.screenshotUrl as string)}
                      className="text-[11px] text-fg-subtle hover:text-accent-strong"
                    >
                      截图
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })}
      </div>
    </div>
  )
}

function ConversationDivider({ name }: { name: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center py-2">
      <span className="max-w-[80%] truncate rounded-full bg-surface px-3 py-1 text-xs text-fg-subtle">
        {name}
      </span>
    </div>
  )
}

// 订单详情页里的通话录音按需播放
function OrderCallAudio({ callId }: { callId: number }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [transcoding, setTranscoding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const r = await adminApi.callRecordingUrl(callId)
      if (r.status === 'transcoding') {
        setUrl(null)
        setTranscoding(true)
        timerRef.current = window.setTimeout(() => void load(), 3000)
        return
      }
      if (r.status === 'failed') {
        setUrl(null)
        setTranscoding(false)
        setError(r.message || '转码失败')
        return
      }
      setTranscoding(false)
      setUrl(r.url)
    } catch (e) {
      setTranscoding(false)
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  if (url) return <audio controls src={url} className="h-7" />
  if (transcoding) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-accent-strong">
        <span className="material-symbols-outlined animate-spin text-[13px]">progress_activity</span>
        转码中…
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={() => void load()}
        disabled={loading}
        className="text-xs px-2 py-0.5 rounded border border-line text-fg-muted hover:bg-surface-2"
      >
        {loading ? '…' : '▶ 录音'}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  )
}
