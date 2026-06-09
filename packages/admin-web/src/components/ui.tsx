// 一组轻量共享 UI 原子：页头、卡片、状态点、加载/错误/空态。
import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  right
}: {
  title: string
  subtitle?: string
  right?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-end justify-between mb-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-fg-muted mt-0.5">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function Card({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={`rounded-lg border border-line bg-surface ${className}`}>{children}</div>
  )
}

/** 小圆点状态指示 */
export function Dot({ color }: { color: 'green' | 'red' | 'yellow' | 'gray' }): React.JSX.Element {
  const map: Record<string, string> = {
    green: 'bg-success',
    red: 'bg-danger',
    yellow: 'bg-warning',
    gray: 'bg-fg-subtle'
  }
  return <span className={`inline-block w-2 h-2 rounded-full ${map[color]}`} />
}

export function LoadingBlock({ label = '加载中…' }: { label?: string }): React.JSX.Element {
  return <div className="py-12 text-center text-fg-subtle text-sm">{label}</div>
}

export function ErrorBlock({
  error,
  onRetry
}: {
  error: unknown
  onRetry?: () => void
}): React.JSX.Element {
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <div className="py-8 px-4 text-center">
      <p className="text-danger text-sm mb-2">加载失败：{msg}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-sm px-3 py-1 rounded-md border border-line hover:bg-surface-2"
        >
          重试
        </button>
      )}
    </div>
  )
}

export function EmptyBlock({ label = '暂无数据' }: { label?: string }): React.JSX.Element {
  return (
    <div className="py-12 text-center text-fg-subtle text-sm border border-dashed border-line rounded-lg">
      {label}
    </div>
  )
}
