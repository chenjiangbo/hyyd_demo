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

  const { order, recommendations, attachments, materials, calls, statusHistory } = q.data
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
