import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { Lightbox } from '../components/Lightbox'
import { fmtTimeFull } from '../lib/format'

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const labels: Record<string, string> = { recognizing: '识别中', matching: '匹配中', pending: '等待处理', processing: '处理中', retrying: '处理中，等待重试', failed: '处理失败', completed: '处理完成', available: '等待分析', not_downloaded: '等待图片', not_found: '未取得图片', ambiguous: '图片待确认' }

function ImageTest({ source, id, available }: { source: 'wechat' | 'wxwork' | 'pet'; id: number; available: boolean }): React.JSX.Element {
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [runs, setRuns] = useState<Array<{ id: string; status: string; result: Record<string, unknown>; created_at: string }>>([])
  async function load(): Promise<void> {
    try { setError(''); setRuns(await adminApi.imageAnalysisTests(source, id)); setOpen(true) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  async function run(): Promise<void> {
    setRunning(true)
    setError('')
    try { await adminApi.runImageAnalysisTest(source, id); await load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setRunning(false) }
  }
  return <div className="mt-2 space-y-1">
    <div className="flex flex-wrap gap-3"><button type="button" disabled={!available || running} className="text-accent-strong underline disabled:opacity-50" onClick={() => void run()}>{running ? '测试中…' : '测试图片识别'}</button><button type="button" className="text-accent-strong underline" onClick={() => open ? setOpen(false) : void load()}>{open ? '收起测试记录' : '查看测试记录'}</button></div>
    {error && <div className="text-danger">{error}</div>}
    {open && runs.length === 0 && <div className="text-fg-muted">暂无测试记录</div>}
    {open && runs.map((run) => {
      const image = record(run.result.image)
      const imageResponse = record(run.result.imageResponse)
      const match = record(run.result.match)
      const trace = record(run.result.matchTrace)
      return <details key={run.id}><summary className="cursor-pointer">{fmtTimeFull(run.created_at)} · {labels[run.status] ?? run.status}</summary>
        {str(run.result.error) && <div className="text-danger">{str(run.result.error)}</div>}
        {image && <details><summary className="cursor-pointer">图片识别结果</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(image, null, 2)}</pre></details>}
        {imageResponse && <details><summary className="cursor-pointer">图片识别 AI 原始返回</summary><div>模型：{str(imageResponse.model)}</div><pre className="whitespace-pre-wrap break-all">{str(imageResponse.content)}</pre></details>}
        {match && <details><summary className="cursor-pointer">归属分析结果</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(match, null, 2)}</pre></details>}
        {trace && <details><summary className="cursor-pointer">归属分析 AI 输入和返回</summary><div>分析要求</div><pre className="whitespace-pre-wrap break-all">{str(trace.systemPrompt)}</pre><div>输入内容</div><pre className="whitespace-pre-wrap break-all">{str(trace.userPrompt)}</pre><div>模型：{str(trace.model) || str(trace.requestedModel)}</div><div>AI 原始返回</div><pre className="whitespace-pre-wrap break-all">{str(trace.response) || '尚未收到返回'}</pre></details>}
      </details>
    })}
  </div>
}

export default function ImageAnalysisRecordsPage(): React.JSX.Element {
  const [preview, setPreview] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'awaiting' | 'waiting_image' | 'completed'>('awaiting')
  const query = useInfiniteQuery({
    queryKey: ['image-analysis-records', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => adminApi.imageAnalysisRecords(pageParam, filter),
    getNextPageParam: (page) => page.nextCursor ?? undefined
  })
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  const total = query.data?.pages[0]?.total
  const filteredTotal = query.data?.pages[0]?.filteredTotal
  const awaitingAi = query.data?.pages[0]?.awaitingAi
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
    <div className="flex flex-wrap items-center gap-4"><button className="rounded border border-line px-3 py-2" type="button" onClick={() => void query.refetch()}>刷新记录</button><label className="flex items-center gap-2 text-sm">筛选<select className="rounded border border-line bg-surface px-3 py-2" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="awaiting">待分析</option><option value="waiting_image">等待图片</option><option value="completed">已分析</option><option value="all">全部记录</option></select></label>{awaitingAi !== undefined && <span className="text-sm font-medium">待图片分析 {awaitingAi} 条</span>}{filteredTotal !== undefined && <span className="text-sm text-fg-muted">当前筛选 {filteredTotal} 条，已加载 {items.length} 条</span>}{total !== undefined && <span className="text-sm text-fg-muted">全部 {total} 条</span>}</div>
    {query.isLoading && <p>正在加载…</p>}
    {query.error && <p className="text-danger">加载失败：{(query.error as Error).message}</p>}
    {!query.isLoading && !query.error && items.length === 0 && <p className="text-fg-muted">暂无图片记录</p>}
    {items.length > 0 && <div className="overflow-x-auto rounded border border-line"><table className="w-full text-left text-sm">
      <thead className="bg-surface-2 text-fg-muted"><tr><th className="px-3 py-2">来源</th><th className="px-3 py-2">员工</th><th className="px-3 py-2">会话</th><th className="px-3 py-2">时间</th><th className="px-3 py-2">图片</th><th className="px-3 py-2">识别结果</th></tr></thead>
      <tbody>{items.map((item) => {
        const image = record(item.image_analysis)
        const match = record(item.registration_match)
        const managerResolution = record(match?.managerResolution)
        const confirmed = record(match?.confirmedSelection) ?? managerResolution
        const notApplicable = str(managerResolution?.status) === 'manager_not_applicable'
        const fields = Array.isArray(image?.visibleFields) ? image.visibleFields.map(record).filter((v): v is Record<string, unknown> => v !== null) : []
        const candidates = Array.isArray(match?.candidateApplications) ? match.candidateApplications.map(record).filter((v): v is Record<string, unknown> => v !== null) : []
        const imageAttempts = Array.isArray(image?.imageAttempts) ? image.imageAttempts.map(record).filter((v): v is Record<string, unknown> => v !== null) : []
        const matchAttempts = Array.isArray(match?.attempts) ? match.attempts.map(record).filter((v): v is Record<string, unknown> => v !== null) : []
        const status = str(image?.status) || item.state
        return <tr key={`${item.source}-${item.id}`} className="border-t border-line align-top">
          <td className="whitespace-nowrap px-3 py-3">{item.source === 'pet' ? '浮动精灵' : item.source === 'wxwork' ? '企微' : '微信'}</td>
          <td className="whitespace-nowrap px-3 py-3">{item.employee_name}</td>
          <td className="min-w-40 px-3 py-3 break-words">{item.title || '—'}</td>
          <td className="whitespace-nowrap px-3 py-3">{fmtTimeFull(item.occurred_at)}{item.received_time_unknown && <div className="text-warning">收到时间待核实</div>}</td>
          <td className="whitespace-nowrap px-3 py-3">{item.image_available ? <><button type="button" className="text-accent-strong underline" onClick={() => void openImage(item.source, item.id)}>查看图片</button>{item.image_rendition === 'thumbnail' && <div className="text-fg-muted">缩略图</div>}</> : <span className="text-fg-muted">暂无图片</span>}</td>
          <td className="min-w-64 px-3 py-3">
            <div>{!image && !item.image_available ? '等待图片' : !image && item.image_rendition !== 'non_thumbnail' && item.source !== 'pet' ? '等待清晰图片' : labels[status] ?? status}{str(image?.imageType) && ` · ${str(image?.imageType)}`}</div>
            {str(image?.description) && <div className="mt-1 whitespace-pre-wrap break-words text-fg-muted">{str(image?.description)}</div>}
            {(item.error || str(image?.error) || str(match?.error)) && <div className="mt-1 break-words text-danger">处理失败：{item.error || str(image?.error) || str(match?.error)}</div>}
            {(str(image?.visibleText) || fields.length > 0) && <details className="mt-1"><summary className="cursor-pointer">查看识别内容</summary>{str(image?.visibleText) && <div className="whitespace-pre-wrap break-words">{str(image?.visibleText)}</div>}{fields.map((field, i) => <div key={i}>{str(field.label)}：{str(field.value)}</div>)}</details>}
            {image && <details className="mt-1"><summary className="cursor-pointer">查看整理后的图片识别结果</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(Object.fromEntries(Object.entries(image).filter(([key]) => key !== 'imageAttempts' && key !== 'registrationMatch')), null, 2)}</pre></details>}
            {imageAttempts.map((attempt, i) => <details className="mt-1" key={`image-${i}`}><summary className="cursor-pointer">图片识别 AI 原始返回（第 {String(attempt.attempt ?? i + 1)} 次）</summary><div>模型：{str(attempt.model)}</div><pre className="whitespace-pre-wrap break-all">{str(attempt.response)}</pre></details>)}
            {match && <div className="mt-1">挂号归属：{notApplicable ? '已放弃关联' : item.order_id !== null ? '已关联订单' : str(match.reason) || labels[str(match.status)] || '等待确认'}{!notApplicable && (str(confirmed?.applicationNo) || str(match.applicationNo)) && ` · 申领号 ${str(confirmed?.applicationNo) || str(match.applicationNo)}`}{item.order_id !== null && ` · 订单 ${item.order_id}`}</div>}
            {candidates.length > 0 && <details className="mt-1"><summary className="cursor-pointer">查看候选（{candidates.length}）</summary>{candidates.map((candidate, i) => <div key={i} className="mt-2"><div>申领号：{str(candidate.applicationNo)}{typeof candidate.confidence === 'number' && ` · AI 匹配度 ${candidate.confidence}%`}</div>{Array.isArray(candidate.orders) && candidate.orders.map(record).filter((v): v is Record<string, unknown> => v !== null).map((order, n) => <div key={n}>订单：{str(order.sourceOrderNo) || String(order.orderId ?? '')}{typeof order.confidence === 'number' && ` · AI 匹配度 ${order.confidence}%`}</div>)}</div>)}</details>}
            {match && <details className="mt-1"><summary className="cursor-pointer">查看归属分析结果</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(Object.fromEntries(Object.entries(match).filter(([key]) => key !== 'attempts')), null, 2)}</pre></details>}
            {matchAttempts.map((attempt, i) => <details className="mt-1" key={`match-${i}`}><summary className="cursor-pointer">归属分析 AI 输入和返回（第 {String(attempt.attempt ?? i + 1)} 次）</summary><div>{attempt.imageIncluded ? '输入图片：请点击本条记录的“查看图片”' : '输入：图片识别内容和相关业务资料'}</div><div>分析要求</div><pre className="whitespace-pre-wrap break-all">{str(attempt.systemPrompt)}</pre><div>输入内容</div><pre className="whitespace-pre-wrap break-all">{str(attempt.userPrompt)}</pre><div>模型：{str(attempt.model) || str(attempt.requestedModel)}</div><div>AI 原始返回</div><pre className="whitespace-pre-wrap break-all">{str(attempt.response) || '尚未收到返回'}</pre></details>)}
            <ImageTest source={item.source} id={item.id} available={item.image_available} />
          </td>
        </tr>
      })}</tbody>
    </table></div>}
    {query.hasNextPage && <button type="button" className="rounded border border-line px-3 py-2" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '加载中…' : '加载更多'}</button>}
    <Lightbox src={preview} onClose={() => setPreview(null)} />
  </div>
}
