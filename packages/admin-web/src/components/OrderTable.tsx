import { Link } from 'react-router-dom'
import type { OrderListItem, EmployeeOrderRow } from '../api/types'
import { fmtTime } from '../lib/format'
import { StatusBadge, PoolBadge } from './badges'

type Row = OrderListItem | EmployeeOrderRow

// 订单表格，员工详情页与订单浏览页共用。showEmployee 控制是否显示申领员工列。
export function OrderTable({
  rows,
  showEmployee = false
}: {
  rows: Row[]
  showEmployee?: boolean
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-fg-muted border-b border-line bg-surface-2">
            <th className="px-3 py-2.5 font-medium">订单号 / 客户</th>
            <th className="px-3 py-2.5 font-medium">状态</th>
            {showEmployee && <th className="px-3 py-2.5 font-medium">员工</th>}
            <th className="px-3 py-2.5 font-medium">详情</th>
            <th className="px-3 py-2.5 font-medium text-right">附/素/通</th>
            <th className="px-3 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface-2">
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{o.customerName}</span>
                  <PoolBadge poolType={o.poolType} />
                </div>
                <div className="text-xs text-fg-subtle">{o.sourceOrderNo}</div>
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge status={o.status} />
              </td>
              {showEmployee && (
                <td className="px-3 py-2.5 text-xs text-fg-muted">
                  {'employee' in o ? o.employee?.name ?? '—' : '—'}
                </td>
              )}
              <td className="px-3 py-2.5 text-xs text-fg-muted">
                {o.detailFetchedAt ? fmtTime(o.detailFetchedAt) : '未抓取'}
              </td>
              <td className="px-3 py-2.5 text-right text-xs tabular-nums text-fg-muted">
                {o.attachmentCount} / {o.materialCount} / {o.callCount}
              </td>
              <td className="px-3 py-2.5 text-right">
                <Link to={`/orders/${o.id}`} className="text-xs text-accent-strong hover:underline">
                  详情 →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
