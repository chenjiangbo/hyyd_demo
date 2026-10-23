import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { adminApi } from '../api/client'
import type { TaikangFormEvent } from '../api/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'
import { fmtTimeFull } from '../lib/format'

const KIND_LABELS: Record<string, string> = {
  'session-start': '开始记录',
  'session-end': '结束记录',
  action: '页面操作',
  'page-state': '页面变化',
  request: '接口请求',
  'capture-error': '记录异常'
}

function eventSummary(event: TaikangFormEvent): string {
  const payload = event.payload
  if (event.kind === 'action') return String(payload.label || payload.action || '页面操作')
  if (event.kind === 'request') {
    const status = typeof payload.status === 'number' ? ` → ${payload.status}` : ''
    return `${payload.method || ''} ${payload.path || ''}${status}`
  }
  if (event.kind === 'page-state') return String(payload.stage || payload.heading || '页面已变化')
  if (event.kind === 'capture-error') return String(payload.error || '记录失败')
  return String(payload.routeKind || '')
}

export default function TaikangFormSessionPage(): React.JSX.Element {
  const { id = '' } = useParams()
  const [downloading, setDownloading] = useState(false)
  const session = useQuery({
    queryKey: ['taikang-form-session', id],
    queryFn: () => adminApi.taikangFormSession(id),
    enabled: !!id,
    refetchInterval: 30_000
  })
  const events = useInfiniteQuery({
    queryKey: ['taikang-form-events', id],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => adminApi.taikangFormEvents(id, pageParam),
    getNextPageParam: (page) => page.nextAfterSequence ?? undefined,
    enabled: !!id,
    refetchInterval: 30_000
  })
  const rows = events.data?.pages.flatMap((page) => page.items) ?? []
  const missingSequence = rows.findIndex((event, index) => event.sequence !== (index ? rows[index - 1]!.sequence + 1 : 1))

  const download = async (): Promise<void> => {
    if (!session.data) return
    setDownloading(true)
    try {
      const all: TaikangFormEvent[] = []
      let after = 0
      for (;;) {
        const page = await adminApi.taikangFormEvents(id, after)
        all.push(...page.items)
        if (page.nextAfterSequence == null) break
        after = page.nextAfterSequence
      }
      if (all.length !== session.data.eventCount) {
        throw new Error(`后台记录数为 ${session.data.eventCount}，实际读取 ${all.length}；请稍后重试`)
      }
      const gap = all.findIndex((event, index) => event.sequence !== index + 1)
      if (gap >= 0) throw new Error(`第 ${gap + 1} 条记录的事件序号不连续，无法下载完整操作记录`)
      const blob = new Blob([JSON.stringify({ session: session.data, events: all }, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `taikang-form-${id}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div>
      <div className="mb-3"><Link to="/taikang-form-sessions" className="text-sm text-accent-strong hover:underline">返回填报记录</Link></div>
      <PageHeader
        title="填报操作记录"
        subtitle={session.data ? `${session.data.employee.name} · ${session.data.taikangAccount} · ${fmtTimeFull(session.data.startedAt)}` : undefined}
        right={<button onClick={() => void download()} disabled={!session.data || downloading} className="px-3 py-1.5 border border-line rounded text-sm disabled:opacity-50">{downloading ? '正在下载…' : '下载完整记录'}</button>}
      />
      {session.isLoading ? <LoadingBlock /> : session.error ? <ErrorBlock error={session.error} onRetry={() => void session.refetch()} /> : session.data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5 text-sm">
          <div><div className="text-xs text-fg-muted">页面</div><div>{({ 'green-order': '绿通服务', 'register-order': '挂号协助', 'expert-add': '专家添加', 'hospital-add': '医院添加' } as Record<string, string>)[session.data.routeKind] ?? session.data.routeKind}{session.data.serviceName ? ` · ${session.data.serviceName}` : ''}</div></div>
          <div><div className="text-xs text-fg-muted">订单号</div><div className="font-mono text-xs">{session.data.sourceOrderNo || '—'}</div></div>
          <div><div className="text-xs text-fg-muted">记录数量</div><div>{session.data.eventCount}</div></div>
          <div><div className="text-xs text-fg-muted">最近记录</div><div>{fmtTimeFull(session.data.lastEventAt)} · {session.data.endedAt ? '已结束' : '未结束'}</div></div>
        </div>
      )}
      {missingSequence >= 0 && <div className="mb-3 p-2 border border-danger text-danger text-sm">事件序号有缺失，请核对上传状态。</div>}
      {events.isLoading ? <LoadingBlock /> : !events.data && events.error ? <ErrorBlock error={events.error} onRetry={() => void events.refetch()} /> : !rows.length ? (
        <EmptyBlock label="暂无操作事件" />
      ) : (
        <>
          <div className="border-l-2 border-line ml-2 space-y-2">
            {rows.map((event) => (
              <details key={event.id} className="ml-4 border border-line bg-surface rounded p-3 group">
                <summary className="cursor-pointer list-none flex flex-wrap gap-2 items-baseline text-sm">
                  <span className="font-mono text-xs text-fg-subtle">#{event.sequence}</span>
                  <span className="text-xs text-fg-muted">{fmtTimeFull(event.occurredAt)}</span>
                  <span className="font-medium">{KIND_LABELS[event.kind] ?? event.kind}</span>
                  <span className="text-fg-muted break-all">{eventSummary(event)}</span>
                </summary>
                <pre className="mt-3 p-3 bg-surface-2 text-xs leading-relaxed overflow-auto max-h-[480px] whitespace-pre-wrap break-all">{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            ))}
          </div>
          {events.hasNextPage && <button onClick={() => void events.fetchNextPage()} disabled={events.isFetchingNextPage} className="mt-4 px-3 py-1.5 border border-line rounded text-sm disabled:opacity-60">{events.isFetchingNextPage ? '加载中…' : '加载更多事件'}</button>}
          {events.isFetchNextPageError && <ErrorBlock error={events.error} onRetry={() => void events.fetchNextPage()} />}
        </>
      )}
    </div>
  )
}
