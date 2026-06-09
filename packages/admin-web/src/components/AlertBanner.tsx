import type { AdminAlert } from '../api/types'
import { EmptyBlock } from './ui'

// 仪表盘告警区：红/黄两级，颜色突出。
export function AlertBanner({ alerts }: { alerts: AdminAlert[] }): React.JSX.Element {
  if (alerts.length === 0) {
    return <EmptyBlock label="✓ 当前没有告警，一切正常" />
  }

  // 红色排前
  const sorted = [...alerts].sort((a, b) => (a.level === 'red' ? -1 : 1) - (b.level === 'red' ? -1 : 1))

  return (
    <div className="space-y-2">
      {sorted.map((a, i) => {
        const red = a.level === 'red'
        return (
          <div
            key={i}
            className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
              red
                ? 'border-danger/30 bg-danger/10 text-danger'
                : 'border-warning/30 bg-warning/10 text-warning'
            }`}
          >
            <span className="mt-0.5 shrink-0">{red ? '●' : '▲'}</span>
            <span className="text-fg">{a.message}</span>
          </div>
        )
      })}
    </div>
  )
}
