import React, { useState, useEffect } from 'react'
import {
  fetchOrderReminders,
  createOrderReminder,
  doneOrderReminder,
  deleteOrderReminder,
  type OrderReminder,
  type Order
} from '../api'

interface OrderReminderModalProps {
  order: Order
  onClose: () => void
  onUpdated?: () => void
}

export function OrderReminderModal({ order, onClose, onUpdated }: OrderReminderModalProps) {
  const [reminders, setReminders] = useState<OrderReminder[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function formatDateTimeLocal(d: Date): string {
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day}T${hours}:${mins}`
  }

  // 表单状态
  const [remindTime, setRemindTime] = useState(() => {
    const now = new Date()
    now.setMinutes(now.getMinutes() + 15)
    return formatDateTimeLocal(now)
  })
  const [content, setContent] = useState('')

  const orderNo = order.sourceOrderNo || String(order.id)
  const customerName = order.customerName || (order.rawJson as Record<string, unknown>)?.patientName || '客户'

  async function loadReminders() {
    setLoading(true)
    setError(null)
    try {
      const list = await fetchOrderReminders({ orderNo })
      setReminders(list)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '加载提醒失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadReminders()
  }, [orderNo])

  function formatStandardDateTime(val?: string | Date | null): string {
    if (!val) return ''
    const d = typeof val === 'string' ? new Date(val) : val
    if (isNaN(d.getTime())) return String(val)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    const secs = String(d.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${mins}:${secs}`
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim()) {
      setError('请输入提醒内容')
      return
    }
    if (!remindTime) {
      setError('请选择提醒时间')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const rawData = order.rawJson as Record<string, any> | undefined
      const orderCreatedTime = order.createdAt || rawData?.applyTime || rawData?.sqsj || rawData?.created_at || ''
      const formattedApplyTime = formatStandardDateTime(orderCreatedTime)
      const finalContent = `订单号: ${orderNo}${formattedApplyTime ? `\n申请时间: ${formattedApplyTime}` : ''}\n备忘内容: ${content.trim()}`

      await createOrderReminder({
        orderNo,
        remindTime: new Date(remindTime).toISOString(),
        content: finalContent,
        type: 'manual',
        extraData: { applyTime: formattedApplyTime, rawContent: content.trim() }
      })
      setContent('')
      await loadReminders()
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
      onUpdated?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '创建提醒失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDone(id: number) {
    try {
      await doneOrderReminder(id)
      await loadReminders()
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
      onUpdated?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '操作失败')
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteOrderReminder(id)
      await loadReminders()
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
      onUpdated?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  // 快捷时间填充
  function setQuickTime(minutes: number) {
    const d = new Date()
    d.setMinutes(d.getMinutes() + minutes)
    setRemindTime(formatDateTimeLocal(d))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl border border-border-subtle overflow-hidden flex flex-col max-h-[90vh]">
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3.5 bg-surface-bg">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[22px]">notifications_active</span>
            <div>
              <h2 className="text-[15px] font-bold text-text-main">设置订单跟进提醒</h2>
              <p className="text-[12px] text-text-muted">
                {String(customerName)} · <span className="font-mono-data">{orderNo}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-container hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {error && (
            <div className="rounded-md bg-red-50 border border-error/30 p-2.5 text-[12px] text-error flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {error}
            </div>
          )}

          {/* 新建提醒表单 */}
          <form onSubmit={handleAdd} className="space-y-3 rounded-lg border border-border-subtle p-3.5 bg-surface-bg/50">
            <div className="text-[13px] font-semibold text-text-main flex items-center gap-1">
              <span className="material-symbols-outlined text-[16px] text-primary">add_alert</span>
              新增跟进备忘
            </div>

            <div>
              <label className="block text-[12px] font-medium text-text-muted mb-1">提醒时间：</label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="datetime-local"
                  required
                  value={remindTime}
                  onChange={(e) => setRemindTime(e.target.value)}
                  className="h-8.5 rounded-md border border-border-subtle bg-white px-2.5 text-body-sm text-text-main outline-none focus:border-primary focus:ring-1 focus:ring-primary flex-1 min-w-[200px]"
                />
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setQuickTime(15)}
                    className="px-2 py-1 text-[11px] rounded bg-white border border-border-subtle text-text-muted hover:text-primary hover:border-primary"
                  >
                    15分后
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuickTime(30)}
                    className="px-2 py-1 text-[11px] rounded bg-white border border-border-subtle text-text-muted hover:text-primary hover:border-primary"
                  >
                    30分后
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuickTime(60)}
                    className="px-2 py-1 text-[11px] rounded bg-white border border-border-subtle text-text-muted hover:text-primary hover:border-primary"
                  >
                    1小时后
                  </button>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-[12px] font-medium text-text-muted mb-1">提醒内容：</label>
              <textarea
                required
                rows={2}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="例如：联系就诊人确认材料、跟进住院床位排队情况等..."
                className="w-full rounded-md border border-border-subtle p-2.5 text-body-sm text-text-main outline-none focus:border-primary focus:ring-1 focus:ring-primary bg-white resize-none"
              />
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-body-sm font-semibold text-white shadow-sm hover:bg-primary/90 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
                {submitting ? '添加中…' : '添加提醒'}
              </button>
            </div>
          </form>

          {/* 已有提醒列表 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[13px] font-semibold text-text-main">
                本订单提醒记录 ({reminders.length})
              </span>
              {loading && <span className="text-[11px] text-text-muted">加载中…</span>}
            </div>

            {reminders.length === 0 ? (
              <div className="py-6 text-center text-body-sm text-text-muted bg-surface-bg rounded-lg border border-dashed border-border-subtle">
                暂无提醒记录，可在上方添加
              </div>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {reminders.map((r) => {
                  const isDone = r.status === 'done'
                  const rTime = r.remind_time || r.remindTime || ''
                  const tag = r.type === 'manual' ? '手工备忘' : '系统提醒'

                  return (
                    <div
                      key={r.id}
                      className={
                        'p-3 rounded-lg border transition-colors flex items-start justify-between gap-2.5 ' +
                        (isDone ? 'bg-surface-bg/60 border-border-subtle opacity-70' : 'bg-white border-border-subtle shadow-xs')
                      }
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span
                            className={
                              'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ' +
                              (tag === '手工备忘' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-blue-50 text-blue-700 border border-blue-200')
                            }
                          >
                            {tag}
                          </span>
                          <span className="text-[11px] text-text-muted">
                            {formatStandardDateTime(rTime)}
                          </span>
                          {isDone && (
                            <span className="text-[10px] text-action-green font-medium">· 已完成</span>
                          )}
                        </div>
                        <p className={'text-body-sm text-text-main break-words whitespace-pre-line ' + (isDone ? 'line-through text-text-muted' : '')}>
                          {r.content}
                        </p>
                      </div>

                      <div className="flex items-center gap-1 shrink-0 pt-0.5">
                        {!isDone && (
                          <button
                            type="button"
                            onClick={() => handleDone(r.id)}
                            className="p-1 rounded text-text-muted hover:text-action-green hover:bg-green-50"
                            title="标记已完成"
                          >
                            <span className="material-symbols-outlined text-[18px]">check_circle</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(r.id)}
                          className="p-1 rounded text-text-muted hover:text-error hover:bg-red-50"
                          title="删除此提醒"
                        >
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="border-t border-border-subtle px-5 py-3 bg-surface-bg flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-white border border-border-subtle px-4 py-1.5 text-body-sm font-medium text-text-main hover:bg-surface-container transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

export default OrderReminderModal
