import type { ReactNode } from 'react'

// 仪表盘顶部指标卡片。
export function StatCard({
  label,
  value,
  sub,
  accent
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  accent?: boolean
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3.5">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accent ? 'text-accent-strong' : ''}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-fg-subtle">{sub}</div>}
    </div>
  )
}
