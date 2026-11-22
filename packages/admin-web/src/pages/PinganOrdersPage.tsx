import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import type { PinganOrderListRow } from '../api/types'
import { EmptyBlock, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'
import { fmtTimeFull } from '../lib/format'

const ORDER_TYPES = [
  { value: 'ORDINARY_REGISTER', label: 'VIP 挂号' },
  { value: 'HOSPITALIZE_DOMESTIC', label: '国内住院' }
]

function stateLabel(value: string): string {
  const labels: Record<string, string> = {
    running: '采集中', completed: '已完成', partial_failure: '部分失败', error: '失败',
    list: '仅列表', detail: '详情已采集', complete: '采集完整', partial_failure_order: '部分采集'
  }
  return labels[value] ?? (value || '—')
}

function JsonSection({ title, value }: { title: string; value: unknown }): React.JSX.Element {
  return (
    <section className="border-t border-line py-3">
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-surface-2 p-3 text-xs leading-5">
        {JSON.stringify(value, null, 2) ?? 'null'}
      </pre>
    </section>
  )
}

export default function PinganOrdersPage(): React.JSX.Element {
  const [draft, setDraft] = useState({ search: '', orderType: '', employeeId: '' })
  const [filters, setFilters] = useState(draft)
  const [page, setPage] = useState(1)
  const [selectedOrder, setSelectedOrder] = useState<Pick<PinganOrderListRow, 'pinganUserId' | 'orderId'> | null>(null)
  const accountsQuery = useQuery({ queryKey: ['pingan-accounts'], queryFn: () => adminApi.pinganAccounts(), refetchInterval: 30_000 })
  const staffQuery = useQuery({ queryKey: ['pingan-staff'], queryFn: () => adminApi.pinganStaff(), refetchInterval: 30_000 })
  const employeesQuery = useQuery({ queryKey: ['pingan-employees'], queryFn: () => adminApi.pinganEmployees() })
  const runsQuery = useQuery({ queryKey: ['pingan-runs'], queryFn: () => adminApi.pinganRuns(), refetchInterval: 15_000 })
  const ordersQuery = useQuery({
    queryKey: ['pingan-orders', filters, page],
    queryFn: () => adminApi.pinganOrders({
      page,
      pageSize: 50,
      search: filters.search,
      orderType: filters.orderType || undefined,
      employeeId: filters.employeeId ? Number(filters.employeeId) : undefined
    }),
    refetchInterval: 15_000
  })
  const detailQuery = useQuery({
    queryKey: ['pingan-order', selectedOrder],
    queryFn: () => adminApi.pinganOrder(selectedOrder!.pinganUserId, selectedOrder!.orderId),
    enabled: selectedOrder !== null
  })
  const accounts = accountsQuery.data ?? []
  const staff = staffQuery.data ?? []
  const unmappedCount = staff.filter((person) => !person.mapped).length
  const orders = ordersQuery.data?.items ?? []
  const runs = runsQuery.data ?? []

  function submitFilters(event: FormEvent): void {
    event.preventDefault()
    setPage(1)
    setFilters({ ...draft })
  }

  return (
    <div>
      <PageHeader title="平安好医生订单" subtitle="采集批次、订单详情与员工归属" />

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">采集账号</h2>
          <span className="text-sm text-fg-muted">{accounts.length} 个账号</span>
        </div>
        {accountsQuery.isLoading ? <LoadingBlock /> : accountsQuery.error ? <ErrorBlock error={accountsQuery.error} onRetry={() => void accountsQuery.refetch()} /> : !accounts.length ? (
          <EmptyBlock label="暂无已维护的平安登录账号" />
        ) : (
          <div className="overflow-x-auto border border-line bg-surface rounded">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-2 text-fg-muted text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">平安用户 ID</th>
                  <th className="px-3 py-2 font-medium">平安显示姓名</th>
                  <th className="px-3 py-2 font-medium">订单</th>
                  <th className="px-3 py-2 font-medium">采集批次</th>
                  <th className="px-3 py-2 font-medium">最近采集</th>
                  <th className="px-3 py-2 font-medium">对应员工</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.pinganUserId} className="border-t border-line">
                    <td className="px-3 py-2 font-mono text-xs">{account.pinganUserId}</td>
                    <td className="px-3 py-2">{account.displayName || '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{account.orderCount}</td>
                    <td className="px-3 py-2 tabular-nums">{account.runCount}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-fg-muted">{account.lastCollectedAt ? fmtTimeFull(account.lastCollectedAt) : '—'}</td>
                    <td className="px-3 py-2">{account.employeeName ?? '未匹配'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">订单当前处理人</h2>
          <span className="text-sm text-fg-muted">{staff.length} 人 · {unmappedCount} 人待匹配</span>
        </div>
        {staffQuery.isLoading ? <LoadingBlock /> : staffQuery.error ? <ErrorBlock error={staffQuery.error} onRetry={() => void staffQuery.refetch()} /> : !staff.length ? (
          <EmptyBlock label="尚未采集到订单处理人" />
        ) : (
          <div className="overflow-x-auto border border-line bg-surface rounded">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-2 text-fg-muted text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">平安处理人 ID</th>
                  <th className="px-3 py-2 font-medium">处理人</th>
                  <th className="px-3 py-2 font-medium">寰宇员工</th>
                  <th className="px-3 py-2 font-medium">订单</th>
                  <th className="px-3 py-2 font-medium">最近出现</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((person) => (
                  <tr key={person.pinganStaffId} className="border-t border-line">
                    <td className="px-3 py-2 font-mono text-xs">{person.pinganStaffId}</td>
                    <td className="px-3 py-2">{person.displayName || '未提供姓名'}</td>
                    <td className="px-3 py-2">{person.employee?.name ?? '未匹配'}</td>
                    <td className="px-3 py-2 tabular-nums">{person.orderCount}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-fg-muted">{fmtTimeFull(person.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="text-base font-semibold mb-3">最近采集批次</h2>
        {runsQuery.isLoading ? <LoadingBlock /> : runsQuery.error ? <ErrorBlock error={runsQuery.error} onRetry={() => void runsQuery.refetch()} /> : !runs.length ? (
          <EmptyBlock label="尚无采集批次" />
        ) : (
          <div className="overflow-x-auto border border-line bg-surface rounded">
            <table className="w-full text-sm text-left">
              <thead className="bg-surface-2 text-fg-muted text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">开始时间</th>
                  <th className="px-3 py-2 font-medium">采集账号</th>
                  <th className="px-3 py-2 font-medium">采集员工</th>
                  <th className="px-3 py-2 font-medium">查询日期</th>
                  <th className="px-3 py-2 font-medium">分页</th>
                  <th className="px-3 py-2 font-medium">列表 / 详情 / 附件</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t border-line">
                    <td className="px-3 py-2 whitespace-nowrap">{fmtTimeFull(run.startedAt)}</td>
                    <td className="px-3 py-2">{run.collectorDisplayName ?? '平安账号'} <span className="text-fg-subtle">/ {run.pinganUserId}</span></td>
                    <td className="px-3 py-2">{run.collectorEmployee?.name ?? '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{run.scanStartDate} 至 {run.scanEndDate}</td>
                    <td className="px-3 py-2 tabular-nums">{run.pageCount}</td>
                    <td className="px-3 py-2 tabular-nums">{run.listRows ?? '—'} / {run.detailCount ?? '—'} / {run.attachmentCount ?? '—'}</td>
                    <td className="px-3 py-2">{stateLabel(run.state)}{run.errorCount ? ` · 错误 ${run.errorCount}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">订单记录</h2>
          <span className="text-sm text-fg-muted">共 {ordersQuery.data?.total ?? 0} 条</span>
        </div>
        <form className="flex flex-wrap items-end gap-3 mb-4" onSubmit={submitFilters}>
          <label className="text-xs text-fg-muted">
            订单号 / 员工 / 账号
            <input value={draft.search} onChange={(event) => setDraft({ ...draft, search: event.target.value })} className="block mt-1 w-56 px-2.5 py-1.5 border border-line bg-surface rounded text-sm text-fg" />
          </label>
          <label className="text-xs text-fg-muted">
            订单类型
            <select value={draft.orderType} onChange={(event) => setDraft({ ...draft, orderType: event.target.value })} className="block mt-1 w-40 px-2.5 py-1.5 border border-line bg-surface rounded text-sm">
              <option value="">全部类型</option>
              {ORDER_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-fg-muted">
            员工
            <select value={draft.employeeId} onChange={(event) => setDraft({ ...draft, employeeId: event.target.value })} className="block mt-1 w-44 px-2.5 py-1.5 border border-line bg-surface rounded text-sm">
              <option value="">全部员工</option>
              {(employeesQuery.data ?? []).map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </select>
          </label>
          <button type="submit" className="px-3 py-1.5 bg-accent text-white rounded text-sm">查询</button>
        </form>

        {ordersQuery.isLoading ? <LoadingBlock /> : ordersQuery.error ? <ErrorBlock error={ordersQuery.error} onRetry={() => void ordersQuery.refetch()} /> : !orders.length ? (
          <EmptyBlock label="暂无平安订单" />
        ) : (
          <>
            <div className="overflow-x-auto border border-line bg-surface rounded">
              <table className="w-full text-sm text-left">
                <thead className="bg-surface-2 text-fg-muted text-xs">
                  <tr>
                    <th className="px-3 py-2 font-medium">最近采集</th>
                    <th className="px-3 py-2 font-medium">订单号</th>
                    <th className="px-3 py-2 font-medium">类型</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">当前处理人 / 员工</th>
                    <th className="px-3 py-2 font-medium">详情 / 附件</th>
                    <th className="px-3 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={`${order.pinganUserId}:${order.orderId}`} className="border-t border-line hover:bg-surface-2">
                      <td className="px-3 py-2 whitespace-nowrap text-fg-muted">{fmtTimeFull(order.lastSeenAt)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{order.orderId}</td>
                      <td className="px-3 py-2">{order.orderTypeName}</td>
                      <td className="px-3 py-2">{order.statusName || order.status || '—'}</td>
                      <td className="px-3 py-2">
                        {order.employee?.name ?? (order.handlerUserId ? '处理人待匹配' : order.handlerName ? '缺少处理人 ID' : '未分配')}
                        <div className="text-xs text-fg-subtle">{order.handlerName || order.handlerUserId || '无当前处理人'}</div>
                      </td>
                      <td className="px-3 py-2">
                        {stateLabel(order.captureState)} / 附件 {order.attachmentState === 'not_captured' ? '未采集' : order.attachmentCount}
                        {order.attachmentErrors.length ? <div className="text-xs text-danger">附件问题 {order.attachmentErrors.length}</div> : null}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => setSelectedOrder(order)} className="px-2.5 py-1 border border-line rounded text-sm hover:bg-surface">详情</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between mt-3 text-sm text-fg-muted">
              <span>第 {page} / {Math.max(1, ordersQuery.data?.pageCount ?? 1)} 页</span>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="px-3 py-1 border border-line rounded disabled:opacity-40">上一页</button>
                <button disabled={page >= (ordersQuery.data?.pageCount ?? 1)} onClick={() => setPage((value) => value + 1)} className="px-3 py-1 border border-line rounded disabled:opacity-40">下一页</button>
              </div>
            </div>
          </>
        )}
      </section>

      {selectedOrder && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedOrder(null) }}>
          <div className="w-full max-w-3xl h-full overflow-y-auto bg-surface p-5 shadow-xl">
            <div className="flex items-start justify-between border-b border-line pb-3 mb-2">
              <div>
                <h2 className="text-lg font-semibold">平安订单详情</h2>
                <p className="mt-1 font-mono text-xs text-fg-muted">{selectedOrder.orderId}</p>
              </div>
              <button aria-label="关闭详情" title="关闭详情" onClick={() => setSelectedOrder(null)} className="w-8 h-8 border border-line rounded text-lg">×</button>
            </div>
            {detailQuery.isLoading ? <LoadingBlock /> : detailQuery.error ? <ErrorBlock error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /> : detailQuery.data ? (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 py-3 text-sm">
                  <div><dt className="text-xs text-fg-muted">订单类型</dt><dd>{detailQuery.data.orderTypeName}</dd></div>
                  <div><dt className="text-xs text-fg-muted">订单状态</dt><dd>{detailQuery.data.statusName || detailQuery.data.status || '—'}</dd></div>
                  <div><dt className="text-xs text-fg-muted">当前处理人</dt><dd>{detailQuery.data.handlerName || '未分配'}{detailQuery.data.handlerUserId ? `（${detailQuery.data.handlerUserId}）` : ''}</dd></div>
                  <div><dt className="text-xs text-fg-muted">归属员工</dt><dd>{detailQuery.data.employee?.name ?? '待匹配'}</dd></div>
                  <div><dt className="text-xs text-fg-muted">采集状态</dt><dd>{stateLabel(detailQuery.data.captureState)}</dd></div>
                  <div><dt className="text-xs text-fg-muted">附件采集</dt><dd>{detailQuery.data.attachmentState === 'complete' ? '完整' : detailQuery.data.attachmentState === 'partial_failure' ? '部分附件不可用' : '尚未采集'}</dd></div>
                  <div><dt className="text-xs text-fg-muted">最近上报员工</dt><dd>{detailQuery.data.lastSeenRun?.collectorEmployee?.name ?? '—'}</dd></div>
                  <div><dt className="text-xs text-fg-muted">首次发现</dt><dd>{fmtTimeFull(detailQuery.data.firstSeenAt)}</dd></div>
                  <div><dt className="text-xs text-fg-muted">最近采集</dt><dd>{fmtTimeFull(detailQuery.data.lastSeenAt)}</dd></div>
                </dl>
                {detailQuery.data.errors.length > 0 && <div className="mb-3 text-sm text-danger">{detailQuery.data.errors.join('；')}</div>}
                {detailQuery.data.attachmentErrors.length > 0 && (
                  <section className="border-t border-line py-3">
                    <h3 className="text-sm font-semibold mb-2 text-danger">附件采集问题</h3>
                    <ul className="space-y-1 text-sm text-danger">{detailQuery.data.attachmentErrors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}</ul>
                  </section>
                )}
                <section className="border-t border-line py-3">
                  <h3 className="text-sm font-semibold mb-2">附件</h3>
                  {detailQuery.data.attachments.length ? <div className="flex flex-wrap gap-3">{detailQuery.data.attachments.map((attachment) => (
                    <a key={attachment.attachmentId} href={attachment.url} target="_blank" rel="noreferrer" className="text-sm text-accent-strong underline">
                      {attachment.fileName}（{Math.ceil(Number(attachment.byteSize) / 1024)} KB）
                    </a>
                  ))}</div> : <p className="text-sm text-fg-muted">无附件</p>}
                </section>
                <JsonSection title="列表原始数据" value={detailQuery.data.listJson} />
                <JsonSection title="订单详情原始数据" value={detailQuery.data.detailJson} />
                <JsonSection title="解密字段" value={detailQuery.data.decryptedFields} />
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
