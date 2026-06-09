import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { Card, LoadingBlock, ErrorBlock, EmptyBlock } from '../components/ui'
import { Lightbox } from '../components/Lightbox'
import { fmtTimeFull, fmtBytes } from '../lib/format'

export default function MaterialDetailPage(): React.JSX.Element {
  const { id } = useParams()
  const mid = Number(id)
  const [lightbox, setLightbox] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['material-detail', mid],
    queryFn: () => adminApi.materialDetail(mid),
    enabled: Number.isFinite(mid)
  })

  if (q.isLoading) return <LoadingBlock />
  if (q.error) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
  if (!q.data) return <EmptyBlock />

  const m = q.data
  return (
    <div>
      <div className="mb-4">
        <Link to="/materials" className="text-sm text-fg-muted hover:text-fg">
          ← 返回素材浏览
        </Link>
      </div>

      <Card className="p-5 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-sm mb-4">
          <KV k="时间" v={fmtTimeFull(m.createdAt)} />
          <KV k="员工" v={m.employee.name} />
          <KV
            k="订单"
            v={
              <Link to={`/orders/${m.order.id}`} className="text-accent-strong hover:underline">
                {m.order.customerName}（{m.order.sourceOrderNo}）
              </Link>
            }
          />
          <KV k="类型" v={m.type === 'image' ? '图片' : '文字'} />
        </div>

        {m.type === 'image' ? (
          m.imageUrl ? (
            <div>
              <img
                src={m.imageUrl}
                alt="素材"
                onClick={() => setLightbox(m.imageUrl)}
                className="max-h-[70vh] rounded-md border border-line cursor-zoom-in"
              />
              <div className="mt-1 text-xs text-fg-subtle">{fmtBytes(m.byteSize)}</div>
            </div>
          ) : (
            <EmptyBlock label="图片不可用" />
          )
        ) : (
          <pre className="text-sm whitespace-pre-wrap break-words font-sans">{m.textContent}</pre>
        )}
      </Card>

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="text-fg-muted">{k}</span>
      <span className="break-all">{v}</span>
    </div>
  )
}
