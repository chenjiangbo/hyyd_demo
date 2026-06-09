import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { adminApi } from '../api/client'
import { Card, PageHeader, LoadingBlock, ErrorBlock, EmptyBlock, Dot } from '../components/ui'
import { fmtRelative } from '../lib/format'

export default function EmployeesPage(): React.JSX.Element {
  const q = useQuery({
    queryKey: ['employees'],
    queryFn: () => adminApi.employees(),
    refetchInterval: 15_000
  })

  return (
    <div>
      <PageHeader title="员工" subtitle="各端在线状态与采集统计 · 每 15 秒刷新" />

      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.length === 0 ? (
        <EmptyBlock label="还没有员工接入" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-fg-muted border-b border-line bg-surface-2">
                  <th className="px-3 py-2.5 font-medium">员工</th>
                  <th className="px-3 py-2.5 font-medium">在线</th>
                  <th className="px-3 py-2.5 font-medium">泰康 token</th>
                  <th className="px-3 py-2.5 font-medium text-right">订单(本周)</th>
                  <th className="px-3 py-2.5 font-medium text-right">素材(文/图)</th>
                  <th className="px-3 py-2.5 font-medium">最近素材</th>
                  <th className="px-3 py-2.5 font-medium text-right">通话(完/败)</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{e.name}</div>
                      <div className="text-xs text-fg-subtle">{e.token}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <Dot color={e.online ? 'green' : 'gray'} />
                        <span className="text-xs text-fg-muted">
                          {e.online ? '在线' : '离线'}
                          {(e.clients.ext || e.clients.tray) && (
                            <span className="ml-1 text-fg-subtle">
                              {[e.clients.ext && 'ext', e.clients.tray && 'tray'].filter(Boolean).join('+')}
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {e.tokenOk === null ? (
                        <span className="text-xs text-fg-subtle">未知</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <Dot color={e.tokenOk ? 'green' : 'red'} />
                          <span className="text-xs text-fg-muted">{e.tokenOk ? '有效' : '失效'}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {e.orderCount}
                      <span className="text-fg-subtle"> ({e.weekOrderCount})</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {e.materialText} / {e.materialImage}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-fg-muted">{fmtRelative(e.lastMaterialAt)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {e.callDone}
                      {e.callFailed > 0 && <span className="text-danger"> / {e.callFailed}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Link to={`/employees/${e.id}`} className="text-xs text-accent-strong hover:underline">
                        详情 →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
