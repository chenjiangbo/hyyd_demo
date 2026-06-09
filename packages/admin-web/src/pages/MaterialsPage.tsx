import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { useCursorQuery } from '../hooks/useCursorQuery'
import { MaterialCard } from '../components/MaterialCard'
import { Lightbox } from '../components/Lightbox'
import { LoadMore } from '../components/LoadMore'
import { Card, PageHeader, LoadingBlock, ErrorBlock, EmptyBlock } from '../components/ui'

export default function MaterialsPage(): React.JSX.Element {
  const [employeeId, setEmployeeId] = useState<number | undefined>(undefined)
  const [type, setType] = useState<string>('')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [lightbox, setLightbox] = useState<string | null>(null)

  const employees = useQuery({ queryKey: ['employees'], queryFn: () => adminApi.employees() })

  const list = useCursorQuery(
    ['materials', employeeId, type, search],
    (cursor) => adminApi.materials({ cursor, employeeId, type: type || undefined, search: search || undefined })
  )

  return (
    <div>
      <PageHeader title="素材浏览" subtitle="跨员工 / 订单的全部采集素材" />

      {/* 筛选栏 */}
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
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
        >
          <option value="">全部类型</option>
          <option value="text">文字</option>
          <option value="image">图片</option>
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
            placeholder="搜索文本内容…"
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm w-56"
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
        <EmptyBlock label="没有符合条件的素材" />
      ) : (
        <Card className="px-4">
          {list.items.map((m) => (
            <MaterialCard key={m.id} m={m} showEmployee onOpenImage={setLightbox} />
          ))}
          <LoadMore
            hasNext={!!list.hasNextPage}
            loading={list.isFetchingNextPage}
            onLoad={() => void list.fetchNextPage()}
          />
        </Card>
      )}

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
