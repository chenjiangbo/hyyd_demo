import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { useCursorQuery } from '../hooks/useCursorQuery'
import { OrderTable } from '../components/OrderTable'
import { LoadMore } from '../components/LoadMore'
import { Card, PageHeader, LoadingBlock, ErrorBlock, EmptyBlock } from '../components/ui'

type PoolTab = 'general' | 'register'
const POOL_TABS: Array<{ key: PoolTab; label: string }> = [
  { key: 'general', label: '绿通业务' },
  { key: 'register', label: '挂号业务' }
]

export default function OrdersPage(): React.JSX.Element {
  const [pool, setPool] = useState<PoolTab>('general')
  const [employeeId, setEmployeeId] = useState<number | undefined>(undefined)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')

  const employees = useQuery({ queryKey: ['employees'], queryFn: () => adminApi.employees() })

  const list = useCursorQuery(
    ['orders', pool, employeeId, search],
    (cursor) => adminApi.orders({ cursor, poolType: pool, employeeId, search: search || undefined })
  )

  return (
    <div>
      <PageHeader title="订单浏览" subtitle="按业务线分挂号 / 绿通 · 支持按员工筛选与关键字搜索" />

      {/* 绿通 / 挂号 标签页 */}
      <div className="flex gap-1 border-b border-line mb-4">
        {POOL_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setPool(t.key)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
              pool === t.key
                ? 'border-accent text-accent-strong font-medium'
                : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

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
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setSearch(searchInput.trim())
          }}
          className="flex gap-2"
        >
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="订单号 / 客户 / 手机 / 医院"
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm w-64"
          />
          <button className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface-2">
            搜索
          </button>
        </form>
      </div>

      {list.isLoading ? (
        <LoadingBlock />
      ) : list.error ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : list.items.length === 0 ? (
        <EmptyBlock label="没有符合条件的订单" />
      ) : (
        <Card className="overflow-hidden">
          <OrderTable rows={list.items} showEmployee />
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
