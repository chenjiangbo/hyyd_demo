import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import type { AdminMessageItem, OrderRef } from '../api/types'
import { useCursorQuery } from '../hooks/useCursorQuery'
import { LoadMore } from '../components/LoadMore'
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'
import { Lightbox } from '../components/Lightbox'
import { fmtTime, fmtTimeFull } from '../lib/format'

const CHANNEL_OPTIONS = [
  { value: '', label: '全部渠道' },
  { value: 'wxwork', label: '企微' },
  { value: 'wechat', label: '微信' }
]

const LINKED_OPTIONS = [
  { value: '', label: '全部消息' },
  { value: 'true', label: '仅已关联' },
  { value: 'false', label: '仅未关联' }
]

export default function MessagesPage(): React.JSX.Element {
  const [employeeId, setEmployeeId] = useState<number | undefined>(undefined)
  const [channel, setChannel] = useState('')
  const [linked, setLinked] = useState('')
  const [search, setSearch] = useState('')
  const [lightbox, setLightbox] = useState<string | null>(null)

  const employees = useQuery({ queryKey: ['employees'], queryFn: () => adminApi.employees() })
  const list = useCursorQuery(
    ['messages', employeeId, channel, linked, search],
    (cursor) =>
      adminApi.messages({
        cursor,
        employeeId,
        channel: channel || undefined,
        linked: linked || undefined,
        search: search || undefined
      })
  )

  return (
    <div>
      <PageHeader title="消息浏览" subtitle="微信/企微采集消息、关联订单与未关联会话" />

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
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
        >
          {CHANNEL_OPTIONS.map((o) => (
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
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索会话、发送人、内容、申请号"
          className="min-w-72 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
        />
      </div>

      {list.isLoading ? (
        <LoadingBlock />
      ) : list.error ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : list.items.length === 0 ? (
        <EmptyBlock label="没有符合条件的消息" />
      ) : (
        <Card className="px-4">
          {list.items.map((m) => (
            <MessageRow key={m.id} m={m} onOpenImage={setLightbox} />
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

function MessageRow({
  m,
  onOpenImage
}: {
  m: AdminMessageItem
  onOpenImage: (url: string) => void
}): React.JSX.Element {
  const channelLabel = m.channel === 'wxwork' ? '企微' : '微信'
  const linked = !!m.order || !!m.applicationNo || !!m.applicationOrders?.length
  const orders = m.order ? [m.order] : m.applicationOrders ?? []

  return (
    <div
      className={`py-3 pl-3 border-b border-line last:border-0 ${
        linked ? '' : 'border-l-2 border-l-danger bg-danger/5'
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
        <span className="rounded px-1.5 py-0.5 bg-surface-2 text-fg-muted">{channelLabel}</span>
        {m.employee && <span>{m.employee.name}</span>}
        <span>{fmtTimeFull(m.capturedAt)}</span>
        <span className="break-all">会话：{m.conversationName}</span>
        {m.senderName && <span>发送人：{m.senderName}</span>}
        {m.seenCount > 1 && <span>重复采集 ×{m.seenCount}</span>}
      </div>

      <div className="mt-2 text-sm whitespace-pre-wrap break-words">{m.contentText}</div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-fg-subtle">
          消息时间 {fmtTime(m.chatTime ?? m.sortTime ?? m.capturedAt)}
          {!m.chatTime && <span className="text-warning"> 估</span>}
        </span>
        {orders.length > 0 ? (
          <OrderLinks orders={orders} prefix={m.order ? '订单' : `关联 ${orders.length} 单`} />
        ) : m.applicationNo ? (
          <span className="rounded px-1.5 py-0.5 bg-accent-soft text-accent-strong">
            已关联申请号 {m.applicationNo}
          </span>
        ) : (
          <span className="rounded px-1.5 py-0.5 bg-danger/15 text-danger font-medium">
            未关联
          </span>
        )}
        {m.screenshotUrl && (
          <button
            onClick={() => onOpenImage(m.screenshotUrl as string)}
            className="text-accent-strong hover:underline"
          >
            查看截图
          </button>
        )}
      </div>
    </div>
  )
}

function OrderLinks({ orders, prefix }: { orders: OrderRef[]; prefix: string }): React.JSX.Element {
  return (
    <>
      <span className="rounded px-1.5 py-0.5 bg-accent-soft text-accent-strong font-medium">
        {prefix}
      </span>
      {orders.map((order) => (
        <Link
          key={order.id}
          to={`/orders/${order.id}`}
          className="text-accent-strong hover:underline"
        >
          {order.customerName}（{order.sourceOrderNo}）
        </Link>
      ))}
    </>
  )
}
