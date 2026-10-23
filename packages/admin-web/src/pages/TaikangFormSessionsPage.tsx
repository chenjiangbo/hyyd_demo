import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { adminApi } from '../api/client'
import { EmptyBlock, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'
import { fmtTimeFull } from '../lib/format'

const ROUTE_LABELS: Record<string, string> = {
  'green-order': '绿通服务',
  'register-order': '挂号协助',
  'expert-add': '专家添加',
  'hospital-add': '医院添加'
}

type Filters = { account: string; routeKind: string; order: string }

export default function TaikangFormSessionsPage(): React.JSX.Element {
  const [draft, setDraft] = useState<Filters>({ account: '', routeKind: '', order: '' })
  const [filters, setFilters] = useState<Filters>(draft)
  const query = useInfiniteQuery({
    queryKey: ['taikang-form-sessions', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => adminApi.taikangFormSessions({ ...filters, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 30_000
  })
  const sessions = query.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div>
      <PageHeader title="泰康填报记录" subtitle="按员工、页面和订单查看表单操作与接口往返" />
      <form
        className="flex flex-wrap items-end gap-3 mb-4"
        onSubmit={(event) => { event.preventDefault(); setFilters({ ...draft }) }}
      >
        <label className="text-xs text-fg-muted">
          泰康账号
          <input
            value={draft.account}
            onChange={(event) => setDraft({ ...draft, account: event.target.value })}
            className="block mt-1 w-40 px-2.5 py-1.5 border border-line bg-surface rounded text-sm text-fg"
          />
        </label>
        <label className="text-xs text-fg-muted">
          页面
          <select
            value={draft.routeKind}
            onChange={(event) => setDraft({ ...draft, routeKind: event.target.value })}
            className="block mt-1 w-40 px-2.5 py-1.5 border border-line bg-surface rounded text-sm text-fg"
          >
            <option value="">全部页面</option>
            {Object.entries(ROUTE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="text-xs text-fg-muted">
          订单号
          <input
            value={draft.order}
            onChange={(event) => setDraft({ ...draft, order: event.target.value })}
            className="block mt-1 w-48 px-2.5 py-1.5 border border-line bg-surface rounded text-sm text-fg"
          />
        </label>
        <button type="submit" className="px-3 py-1.5 bg-accent text-white rounded text-sm">查询</button>
      </form>

      {query.isLoading ? <LoadingBlock /> : !query.data && query.error ? <ErrorBlock error={query.error} onRetry={() => void query.refetch()} /> : !sessions.length ? (
        <EmptyBlock label="暂无填报记录" />
      ) : (
        <>
          <div className="overflow-x-auto border border-line bg-surface rounded">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-2 text-fg-muted text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">开始时间</th>
                  <th className="px-3 py-2 font-medium">页面 / 服务</th>
                  <th className="px-3 py-2 font-medium">订单号</th>
                  <th className="px-3 py-2 font-medium">员工 / 泰康账号</th>
                  <th className="px-3 py-2 font-medium">事件</th>
                  <th className="px-3 py-2 font-medium">最近记录</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} className="border-t border-line hover:bg-surface-2">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Link to={`/taikang-form-sessions/${session.id}`} className="text-accent-strong hover:underline">
                        {fmtTimeFull(session.startedAt)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{ROUTE_LABELS[session.routeKind] ?? session.routeKind}{session.serviceName ? ` · ${session.serviceName}` : ''}</td>
                    <td className="px-3 py-2 font-mono text-xs">{session.sourceOrderNo || '—'}</td>
                    <td className="px-3 py-2">{session.employee.name} <span className="text-fg-subtle">({session.taikangAccount})</span></td>
                    <td className="px-3 py-2 tabular-nums">{session.eventCount}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-fg-muted">{fmtTimeFull(session.lastEventAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{session.endedAt ? '已结束' : '未结束'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {query.hasNextPage && (
            <button
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="mt-4 px-3 py-1.5 border border-line rounded text-sm disabled:opacity-60"
            >
              {query.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          )}
          {query.isFetchNextPageError && <ErrorBlock error={query.error} onRetry={() => void query.fetchNextPage()} />}
        </>
      )}
    </div>
  )
}
