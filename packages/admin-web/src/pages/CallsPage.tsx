import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { useCursorQuery } from '../hooks/useCursorQuery'
import { CallCard } from '../components/CallCard'
import { LoadMore } from '../components/LoadMore'
import { Card, PageHeader, LoadingBlock, ErrorBlock, EmptyBlock } from '../components/ui'

const ASR_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'done', label: '已完成' },
  { value: 'pending', label: '待转写' },
  { value: 'processing', label: '转写中' },
  { value: 'failed', label: '失败' },
  { value: 'requires_manual', label: '需人工' },
  { value: 'no_recording', label: '无录音' }
]

const LINKED_OPTIONS = [
  { value: '', label: '全部通话' },
  { value: 'false', label: '⚠ 仅未关联订单' },
  { value: 'true', label: '仅已关联订单' }
]

export default function CallsPage(): React.JSX.Element {
  const [employeeId, setEmployeeId] = useState<number | undefined>(undefined)
  const [asrStatus, setAsrStatus] = useState('')
  const [linked, setLinked] = useState('')

  const employees = useQuery({ queryKey: ['employees'], queryFn: () => adminApi.employees() })

  const list = useCursorQuery(
    ['calls', employeeId, asrStatus, linked],
    (cursor) =>
      adminApi.calls({
        cursor,
        employeeId,
        asrStatus: asrStatus || undefined,
        linked: linked || undefined
      })
  )

  return (
    <div>
      <PageHeader title="通话浏览" subtitle="跨员工的全部通话记录与转写" />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select
          value={employeeId ?? ''}
          onChange={(e) => setEmployeeId(e.target.value ? Number(e.target.value) : undefined)}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
        >
          <option value="">全部员工</option>
          {employees.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select
          value={asrStatus}
          onChange={(e) => setAsrStatus(e.target.value)}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
        >
          {ASR_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={linked}
          onChange={(e) => setLinked(e.target.value)}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
        >
          {LINKED_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {list.isLoading ? (
        <LoadingBlock />
      ) : list.error ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : list.items.length === 0 ? (
        <EmptyBlock label="没有符合条件的通话" />
      ) : (
        <Card className="px-4">
          {list.items.map((c) => (
            <CallCard key={c.id} c={c} showEmployee />
          ))}
          <LoadMore
            hasNext={!!list.hasNextPage}
            loading={list.isFetchingNextPage}
            onLoad={() => void list.fetchNextPage()}
          />
        </Card>
      )}
    </div>
  )
}
