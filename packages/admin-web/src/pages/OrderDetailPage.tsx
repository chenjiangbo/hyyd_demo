import { useState } from 'react'
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
import type { OrderFull, OrderMessage } from '../api/types'

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

  const q = useQuery({
    queryKey: ['order-full', orderId],
    queryFn: () => adminApi.orderFull(orderId),
    enabled: Number.isFinite(orderId)
  })

  if (q.isLoading) return <LoadingBlock />
  if (q.error) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
  if (!q.data) return <EmptyBlock />

  const { order, recommendations, attachments, materials, calls, statusHistory, brief, messages } =
    q.data
  const rec = recommendations ?? {}
  // 未知字段：rec 里有值但不在已知映射里的
  const unknownFields = Object.entries(rec).filter(([k, v]) => !KNOWN_KEYS.has(k) && !isEmptyVal(v))

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
          <h1 className="text-xl font-semibold">{order.customerName}</h1>
          <PoolBadge poolType={order.poolType} />
          <StatusBadge status={order.status} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-sm">
          <Field label="订单号" value={order.sourceOrderNo} />
          <Field label="客户电话" value={order.customerPhone ?? '—'} />
          <Field label="申领员工" value={order.employee?.name ?? '—'} />
          <Field label="详情抓取" value={order.detailFetchedAt ? fmtTimeFull(order.detailFetchedAt) : '未抓取'} />
          <Field label="创建时间" value={fmtTimeFull(order.createdAt)} />
          <Field label="更新时间" value={fmtTimeFull(order.updatedAt)} />
        </div>
      </Card>

      {/* AI 滚动简报 */}
      <BriefCard brief={brief} />

      {/* 状态变更历史 */}
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

      {/* 泰康详情字段 */}
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

      {/* 附件画廊 */}
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
                      className="flex items-center justify-center w-full h-24 rounded-md border border-line bg-surface-2 text-2xl"
                    >
                      📄
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

      {/* 素材时间线 */}
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

      {/* 聊天记录时间线 */}
      <Card className="p-5 mb-4">
        <h2 className="text-sm font-semibold mb-3">聊天记录（{messages.length}）</h2>
        {messages.length === 0 ? (
          <EmptyBlock label="无采集到的聊天消息" />
        ) : (
          <ChatTimeline messages={messages} onOpenImage={setLightbox} />
        )}
      </Card>

      {/* 通话时间线 */}
      <Card className="p-5 mb-4">
        <h2 className="text-sm font-semibold mb-1">通话（{calls.length}）</h2>
        {calls.length === 0 ? (
          <EmptyBlock label="无通话" />
        ) : (
          <div>
            {calls.map((c) => (
              <div key={c.id} className="py-3 border-b border-line last:border-0">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium tabular-nums">{c.phone}</span>
                  <span className="text-xs text-fg-subtle">
                    {c.direction === 'in' ? '呼入' : '呼出'} · {fmtDuration(c.durationSec)} · {fmtTime(c.startedAt)}
                  </span>
                  <AsrBadge status={c.asrStatus} />
                  {c.hasRecording && <OrderCallAudio callId={c.id} />}
                </div>
                {c.asrText && (
                  <p className="mt-1.5 text-sm text-fg-muted whitespace-pre-wrap break-words">{c.asrText}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* JSON debug */}
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

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

// AI 滚动简报卡片：综合微信/企微消息 + 通话/录音转写 + 素材一次产出。
function BriefCard({ brief }: { brief: OrderFull['brief'] }): React.JSX.Element {
  const b = (brief.json ?? null) as {
    summary?: string | null
    stage?: string | null
    stageEvidence?: string | null
    hasOpenIssue?: boolean
    nextActions?: string[]
    risks?: string[]
    keyInfo?: Record<string, string | null>
    model?: string
  } | null

  return (
    <Card className="p-5 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold">AI 滚动简报</h2>
        {brief.updatedAt ? (
          <span className="text-xs text-fg-subtle">更新于 {fmtTimeFull(brief.updatedAt)}</span>
        ) : null}
      </div>
      {!b || !brief.updatedAt ? (
        <EmptyBlock label="该订单尚未生成简报（采集到消息/通话后自动产出）" />
      ) : (
        <div className="space-y-3 text-sm">
          {b.stage && (
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-accent-soft text-accent-strong font-medium">
                {b.stage}
              </span>
              {b.hasOpenIssue && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-warning/10 text-warning">
                  有未决事项
                </span>
              )}
              {b.stageEvidence && <span className="text-xs text-fg-subtle">{b.stageEvidence}</span>}
            </div>
          )}
          {b.summary && <p className="text-fg whitespace-pre-wrap leading-relaxed">{b.summary}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {b.nextActions && b.nextActions.length > 0 && (
              <div>
                <div className="text-xs font-medium text-fg-muted mb-1">待办</div>
                <ul className="list-disc list-inside space-y-0.5 text-fg-muted">
                  {b.nextActions.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
            {b.risks && b.risks.length > 0 && (
              <div>
                <div className="text-xs font-medium text-danger mb-1">风险</div>
                <ul className="list-disc list-inside space-y-0.5 text-danger">
                  {b.risks.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {b.keyInfo && Object.values(b.keyInfo).some((v) => v) && (
            <div>
              <div className="text-xs font-medium text-fg-muted mb-1">关键信息</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1">
                {Object.entries(b.keyInfo)
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-2 text-sm">
                      <span className="text-fg-muted shrink-0">{k}</span>
                      <span className="break-all">{v}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
          {b.model && <div className="text-xs text-fg-subtle">模型 {b.model}</div>}
        </div>
      )}
    </Card>
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
    <div className="space-y-2">
      {messages.map((m) => {
        if (m.senderType === 'system') {
          return (
            <div key={m.id} className="text-center">
              <span className="text-xs text-fg-subtle bg-surface-2 rounded-full px-2.5 py-0.5">
                {m.contentText}
              </span>
            </div>
          )
        }
        const self = m.senderType === 'self'
        const estimated = !m.chatTime
        const time = fmtTime(m.chatTime ?? m.sortTime ?? m.capturedAt)
        return (
          <div key={m.id} className={`flex ${self ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[78%] ${self ? 'items-end' : 'items-start'} flex flex-col`}>
              {!self && m.senderName && (
                <span className="text-xs text-fg-subtle mb-0.5 px-1">{m.senderName}</span>
              )}
              <div
                className={`rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                  self
                    ? 'bg-accent-soft text-accent-strong rounded-br-sm'
                    : 'bg-surface-2 text-fg rounded-bl-sm'
                }`}
              >
                {m.contentText}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 px-1">
                <span className="text-[11px] text-fg-subtle">{time}</span>
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
        )
      })}
    </div>
  )
}

// 订单详情页里的通话录音按需播放
function OrderCallAudio({ callId }: { callId: number }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  if (url) return <audio controls src={url} className="h-7" />
  return (
    <button
      onClick={async () => {
        setLoading(true)
        try {
          const r = await adminApi.callRecordingUrl(callId)
          setUrl(r.url)
        } finally {
          setLoading(false)
        }
      }}
      disabled={loading}
      className="text-xs px-2 py-0.5 rounded border border-line text-fg-muted hover:bg-surface-2"
    >
      {loading ? '…' : '▶ 录音'}
    </button>
  )
}
