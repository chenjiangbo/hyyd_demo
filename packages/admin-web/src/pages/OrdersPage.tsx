import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { useCursorQuery } from '../hooks/useCursorQuery'
import { OrderTable } from '../components/OrderTable'
import { LoadMore } from '../components/LoadMore'
import { Card, PageHeader, LoadingBlock, ErrorBlock, EmptyBlock } from '../components/ui'

type PoolTab = 'general' | 'register'
type TriFilter = '' | 'true' | 'false'

const POOL_TABS: Array<{ key: PoolTab; label: string }> = [
  { key: 'general', label: '绿通业务' },
  { key: 'register', label: '挂号业务' }
]

const TRI_OPTIONS = [
  { value: '', label: '不限' },
  { value: 'true', label: '有' },
  { value: 'false', label: '无' }
] satisfies Array<{ value: TriFilter; label: string }>

export default function OrdersPage(): React.JSX.Element {
  const [pool, setPool] = useState<PoolTab>('general')
  const [employeeId, setEmployeeId] = useState<number | undefined>(undefined)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [hasWechatMessage, setHasWechatMessage] = useState<TriFilter>('')
  const [hasWxworkMessage, setHasWxworkMessage] = useState<TriFilter>('')
  const [hasRecording, setHasRecording] = useState<TriFilter>('')
  const [createdFrom, setCreatedFrom] = useState('')
  const [createdTo, setCreatedTo] = useState('')

  const employees = useQuery({ queryKey: ['employees'], queryFn: () => adminApi.employees() })

  const list = useCursorQuery(
    ['orders', pool, employeeId, search, hasWechatMessage, hasWxworkMessage, hasRecording, createdFrom, createdTo],
    (cursor) =>
      adminApi.orders({
        cursor,
        poolType: pool,
        employeeId,
        search: search || undefined,
        hasWechatMessage: hasWechatMessage || undefined,
        hasWxworkMessage: hasWxworkMessage || undefined,
        hasRecording: hasRecording || undefined,
        createdFrom: createdFrom || undefined,
        createdTo: createdTo || undefined
      })
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
        <FilterSelect
          label="微信消息"
          value={hasWechatMessage}
          onChange={setHasWechatMessage}
        />
        <FilterSelect
          label="企微消息"
          value={hasWxworkMessage}
          onChange={setHasWxworkMessage}
        />
        <FilterSelect
          label="录音"
          value={hasRecording}
          onChange={setHasRecording}
        />
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          申领时间
          <input
            type="date"
            value={createdFrom}
            onChange={(e) => setCreatedFrom(e.target.value)}
            className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg"
          />
        </label>
        <span className="text-xs text-fg-subtle">至</span>
        <input
          type="date"
          value={createdTo}
          onChange={(e) => setCreatedTo(e.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
        />
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

function FilterSelect({
  label,
  value,
  onChange
}: {
  label: string
  value: TriFilter
  onChange: (value: TriFilter) => void
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-1 text-xs text-fg-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as TriFilter)}
        className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg"
      >
        {TRI_OPTIONS.map((option) => (
          <option key={option.value || 'all'} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}
