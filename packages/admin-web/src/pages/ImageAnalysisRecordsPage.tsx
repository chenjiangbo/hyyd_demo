import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { Lightbox } from '../components/Lightbox'
import { fmtTimeFull } from '../lib/format'

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const labels: Record<string, string> = { recognizing: '识别中', matching: '匹配中', pending: '等待处理', processing: '处理中', retrying: '处理中，等待重试', failed: '处理失败', completed: '处理完成', available: '等待分析', not_downloaded: '等待图片', not_found: '未取得图片', ambiguous: '图片待确认' }

export default function ImageAnalysisRecordsPage(): React.JSX.Element {
  const [preview, setPreview] = useState<string | null>(null)
  const query = useInfiniteQuery({
    queryKey: ['image-analysis-records'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => adminApi.imageAnalysisRecords(pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined
  })
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  const total = query.data?.pages[0]?.total
  async function openImage(source: 'wechat' | 'wxwork' | 'pet', id: number): Promise<void> {
    try {
      const { url } = source === 'pet' ? await adminApi.petImageAnalysisRecordUrl(id) : await adminApi.nativeChatAttachmentUrl(id)
      setPreview(url)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }
  return <div className="space-y-4">
    <div><h1 className="text-2xl font-semibold">图片识别记录</h1><p className="mt-2 text-fg-muted">查看微信、企微和浮动精灵的图片及识别结果。</p></div>
    <div className="flex items-center gap-4"><button className="rounded border border-line px-3 py-2" type="button" onClick={() => void query.refetch()}>刷新记录</button>{total !== undefined && <span className="text-sm text-fg-muted">共 {total} 条，已加载 {items.length} 条</span>}</div>
    {query.isLoading && <p>正在加载…</p>}
    {query.error && <p className="text-danger">加载失败：{(query.error as Error).message}</p>}
    {!query.isLoading && !query.error && items.length === 0 && <p className="text-fg-muted">暂无图片记录</p>}
    {items.length > 0 && <div className="overflow-x-auto rounded border border-line"><table className="w-full text-left text-sm">
      <thead className="bg-surface-2 text-fg-muted"><tr><th className="px-3 py-2">来源</th><th className="px-3 py-2">员工</th><th className="px-3 py-2">会话</th><th className="px-3 py-2">时间</th><th className="px-3 py-2">图片</th><th className="px-3 py-2">识别结果</th></tr></thead>
      <tbody>{items.map((item) => {
        const image = record(item.image_analysis)
        const match = record(item.registration_match)
        const confirmed = record(match?.confirmedSelection)
        const fields = Array.isArray(image?.visibleFields) ? image.visibleFields.map(record).filter((v): v is Record<string, unknown> => v !== null) : []
        const candidates = Array.isArray(match?.candidateApplications) ? match.candidateApplications.map(record).filter((v): v is Record<string, unknown> => v !== null) : []
        const status = str(image?.status) || item.state
        return <tr key={`${item.source}-${item.id}`} className="border-t border-line align-top">
          <td className="whitespace-nowrap px-3 py-3">{item.source === 'pet' ? '浮动精灵' : item.source === 'wxwork' ? '企微' : '微信'}</td>
          <td className="whitespace-nowrap px-3 py-3">{item.employee_name}</td>
          <td className="min-w-40 px-3 py-3 break-words">{item.title || '—'}</td>
          <td className="whitespace-nowrap px-3 py-3">{fmtTimeFull(item.occurred_at)}{item.received_time_unknown && <div className="text-warning">收到时间待核实</div>}</td>
          <td className="whitespace-nowrap px-3 py-3">{item.image_available ? <><button type="button" className="text-accent-strong underline" onClick={() => void openImage(item.source, item.id)}>查看图片</button>{item.image_rendition === 'thumbnail' && <div className="text-fg-muted">缩略图</div>}</> : <span className="text-fg-muted">暂无图片</span>}</td>
          <td className="min-w-64 px-3 py-3">
            <div>{!image && item.full_image_state === 'pending' ? '等待清晰图片' : labels[status] ?? status}{str(image?.imageType) && ` · ${str(image?.imageType)}`}</div>
            {str(image?.description) && <div className="mt-1 whitespace-pre-wrap break-words text-fg-muted">{str(image?.description)}</div>}
            {(item.error || str(image?.error) || str(match?.error)) && <div className="mt-1 break-words text-danger">处理失败：{item.error || str(image?.error) || str(match?.error)}</div>}
            {(str(image?.visibleText) || fields.length > 0) && <details className="mt-1"><summary className="cursor-pointer">查看识别内容</summary>{str(image?.visibleText) && <div className="whitespace-pre-wrap break-words">{str(image?.visibleText)}</div>}{fields.map((field, i) => <div key={i}>{str(field.label)}：{str(field.value)}</div>)}</details>}
            {match && <div className="mt-1">挂号归属：{item.order_id !== null ? '已关联订单' : str(match.reason) || labels[str(match.status)] || '等待确认'}{(str(confirmed?.applicationNo) || str(match.applicationNo)) && ` · 申领号 ${str(confirmed?.applicationNo) || str(match.applicationNo)}`}{item.order_id !== null && ` · 订单 ${item.order_id}`}</div>}
            {candidates.length > 0 && <details className="mt-1"><summary className="cursor-pointer">查看候选（{candidates.length}）</summary>{candidates.map((candidate, i) => <div key={i} className="mt-2"><div>申领号：{str(candidate.applicationNo)}{typeof candidate.confidence === 'number' && ` · AI 匹配度 ${candidate.confidence}%`}</div>{Array.isArray(candidate.orders) && candidate.orders.map(record).filter((v): v is Record<string, unknown> => v !== null).map((order, n) => <div key={n}>订单：{str(order.sourceOrderNo) || String(order.orderId ?? '')}{typeof order.confidence === 'number' && ` · AI 匹配度 ${order.confidence}%`}</div>)}</div>)}</details>}
          </td>
        </tr>
      })}</tbody>
    </table></div>}
    {query.hasNextPage && <button type="button" className="rounded border border-line px-3 py-2" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '加载中…' : '加载更多'}</button>}
    <Lightbox src={preview} onClose={() => setPreview(null)} />
  </div>
}
