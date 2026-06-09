import type { AsrStatus } from '../api/types'

// 订单状态标签（泰康原文，直接展示，不做语义判断）。
export function StatusBadge({ status }: { status: string }): React.JSX.Element {
  return (
    <span className="inline-block rounded px-1.5 py-0.5 text-xs bg-surface-2 text-fg-muted">
      {status}
    </span>
  )
}

// 池类型标签
export function PoolBadge({ poolType }: { poolType: string | null }): React.JSX.Element | null {
  if (!poolType) return null
  const isReg = poolType === 'register'
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs ${
        isReg ? 'bg-info/15 text-info' : 'bg-accent-soft text-accent-strong'
      }`}
    >
      {isReg ? '挂号' : '绿通'}
    </span>
  )
}

const ASR_LABEL: Record<AsrStatus, string> = {
  no_recording: '无录音',
  pending: '待转写',
  processing: '转写中',
  done: '已完成',
  failed: '失败',
  requires_manual: '需人工'
}

// ASR 状态标签，非 done 高亮。
export function AsrBadge({ status }: { status: AsrStatus }): React.JSX.Element {
  const cls: Record<AsrStatus, string> = {
    done: 'bg-success/15 text-success',
    failed: 'bg-danger/15 text-danger',
    requires_manual: 'bg-danger/15 text-danger',
    processing: 'bg-warning/15 text-warning',
    pending: 'bg-warning/15 text-warning',
    no_recording: 'bg-surface-2 text-fg-subtle'
  }
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${cls[status]}`}>
      {ASR_LABEL[status] ?? status}
    </span>
  )
}

export function DirectionLabel({ direction }: { direction: 'in' | 'out' }): React.JSX.Element {
  return (
    <span className="text-xs text-fg-muted">{direction === 'in' ? '呼入 ↙' : '呼出 ↗'}</span>
  )
}
