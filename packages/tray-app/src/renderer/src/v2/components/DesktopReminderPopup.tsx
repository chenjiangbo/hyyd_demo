import { useState, useEffect, useRef } from 'react'
import {
  fetchOrderReminders,
  snoozeOrderReminder,
  doneOrderReminder,
  type OrderReminder
} from '../api'

export function DesktopReminderPopup() {
  const [activeReminders, setActiveReminders] = useState<OrderReminder[]>([])
  const [currentIndex] = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // 轮询检查到期的提醒
  async function checkDueReminders() {
    try {
      const list = await fetchOrderReminders({ status: 'pending' })
      const now = new Date()
      // 筛选出达到提醒时间的项
      const due = list.filter((r) => {
        const timeStr = r.remind_time || r.remindTime
        if (!timeStr) return false
        return new Date(timeStr) <= now
      })

      if (due.length > 0) {
        // 如果在 Electron 环境中，调用原生独立桌面右下角浮窗
        if (window.api?.showDesktopReminder) {
          void window.api.showDesktopReminder(due[0])
          return
        }

        setActiveReminders((prev) => {
          // 合并并去重
          const existingIds = new Set(prev.map((item) => item.id))
          const newlyAdded = due.filter((item) => !existingIds.has(item.id))
          if (newlyAdded.length > 0) {
            // 播放提示音
            try {
              if (!audioRef.current) {
                audioRef.current = new Audio('data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU')
              }
              void audioRef.current.play()
            } catch {}
          }
          return due
        })
      } else {
        if (window.api?.hideDesktopReminder) {
          void window.api.hideDesktopReminder()
        }
        setActiveReminders([])
      }
    } catch {
      // 静默失败，下次重试
    }
  }

  useEffect(() => {
    // 启动时检查一次
    void checkDueReminders()
    // 每 15 秒轮询一次
    const timer = setInterval(() => {
      void checkDueReminders()
    }, 15000)

    const handleUpdate = () => {
      void checkDueReminders()
    }
    window.addEventListener('huanyu-reminders-updated', handleUpdate)

    return () => {
      clearInterval(timer)
      window.removeEventListener('huanyu-reminders-updated', handleUpdate)
    }
  }, [])

  // 如果在 Electron 中，由独立桌面原生窗口负责渲染，主窗口无需再渲染 DOM 弹层
  if (window.api?.showDesktopReminder) {
    return null
  }

  if (activeReminders.length === 0) return null

  // 保证当前索引不越界
  const safeIndex = Math.min(currentIndex, activeReminders.length - 1)
  const currentItem = activeReminders[safeIndex]
  if (!currentItem) return null

  const tag = currentItem.type === 'manual' ? '手工备忘' : '系统提醒'
  const isUrgent = tag === '系统提醒'
  const timeStr = currentItem.remind_time || currentItem.remindTime
  const formattedTime = timeStr
    ? new Date(timeStr).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : ''

  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copy = (value: string, key: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!value) return
    void navigator.clipboard?.writeText(value)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1200)
  }

  const handleOpenOrder = (orderNo: string): void => {
    if (!orderNo) return
    const cleanNo = orderNo.trim()
    if (window.api?.openOrderFromReminder) {
      void window.api.openOrderFromReminder(cleanNo)
    } else {
      window.dispatchEvent(
        new CustomEvent('huanyu-navigate-order', { detail: { orderNo: cleanNo } })
      )
    }
  }

  // 延后 10 分钟
  async function handleSnooze() {
    if (isProcessing) return
    setIsProcessing(true)
    try {
      await snoozeOrderReminder(currentItem.id, 10)
      setActiveReminders((prev) => prev.filter((r) => r.id !== currentItem.id))
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
    } catch {
      // 异常处理
    } finally {
      setIsProcessing(false)
    }
  }

  // 标记已完成
  async function handleDone() {
    if (isProcessing) return
    setIsProcessing(true)
    try {
      await doneOrderReminder(currentItem.id)
      setActiveReminders((prev) => prev.filter((r) => r.id !== currentItem.id))
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
    } catch {
      // 异常处理
    } finally {
      setIsProcessing(false)
    }
  }

  const fallbackOrderNo = currentItem.order_no || currentItem.orderNo
  const hasOrderInContent =
    currentItem.content?.includes('订单号:') ||
    currentItem.content?.includes('订单号：') ||
    currentItem.content?.includes('单号:') ||
    currentItem.content?.includes('单号：')

  const renderFormattedContent = (rawContent: string) => {
    if (!rawContent) return null
    const normalized = rawContent.replace(/\\n/g, '\n')
    const lines = normalized.split('\n').filter(Boolean)

    return (
      <div className="space-y-1.5 text-[13px] leading-relaxed text-text-main font-normal">
        {lines.map((line, idx) => {
          const colonIdx = line.indexOf(':') > -1 ? line.indexOf(':') : line.indexOf('：')
          if (colonIdx > -1) {
            const label = line.slice(0, colonIdx).trim()
            const val = line.slice(colonIdx + 1).trim()
            const isOrderField =
              label.includes('单号') ||
              label.includes('订单') ||
              /^(COD|HY|OD|FW|YF)/i.test(val)

            return (
              <div key={idx} className="flex items-start text-[13px]">
                <span className="w-[72px] shrink-0 whitespace-nowrap text-text-muted">{label}：</span>
                {isOrderField ? (
                  <div className="flex-1 flex items-center gap-1.5 min-w-0">
                    <button
                      type="button"
                      onClick={() => handleOpenOrder(val)}
                      className="font-mono text-primary hover:underline font-medium break-all text-left cursor-pointer transition-colors"
                      title="点击在工作台中搜索此订单"
                    >
                      {val}
                    </button>
                    <IconCopyButton
                      title={`复制订单号 ${val}`}
                      copied={copiedKey === `val-${idx}`}
                      onClick={(e) => copy(val, `val-${idx}`, e)}
                    />
                  </div>
                ) : (
                  <span className="flex-1 break-words text-text-main leading-relaxed">{val}</span>
                )}
              </div>
            )
          }
          return (
            <div key={idx} className="text-text-main break-words text-[13px]">
              {line}
            </div>
          )
        })}
        {!hasOrderInContent && fallbackOrderNo && fallbackOrderNo !== 'SYSTEM' && fallbackOrderNo !== 'ALL' && (
          <div className="flex items-start text-[13px] pt-1 border-t border-border-subtle/50">
            <span className="w-[72px] shrink-0 whitespace-nowrap text-text-muted">订单号：</span>
            <div className="flex-1 flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                onClick={() => handleOpenOrder(fallbackOrderNo)}
                className="font-mono text-primary hover:underline font-medium break-all text-left cursor-pointer transition-colors"
                title="点击在工作台中搜索此订单"
              >
                {fallbackOrderNo}
              </button>
              <IconCopyButton
                title={`复制订单号 ${fallbackOrderNo}`}
                copied={copiedKey === 'fallback-orderno'}
                onClick={(e) => copy(fallbackOrderNo, 'fallback-orderno', e)}
              />
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="fixed bottom-5 right-5 z-[99999] w-96 rounded-xl border border-border-subtle bg-white p-4 shadow-2xl transition-all duration-300 animate-in slide-in-from-bottom-5 overflow-hidden"
      style={{
        boxShadow: '0 20px 30px -10px rgba(0, 0, 0, 0.2), 0 0 15px rgba(0,0,0,0.05)'
      }}
    >
      {/* 顶部标签与时间 */}
      <div className="flex items-center justify-between border-b border-border-subtle/80 pb-2.5">
        <div className="flex items-center gap-1.5">
          <span
            className={
              'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ' +
              (tag === '手工备忘' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-red-50 text-error border border-red-200')
            }
          >
            <span className="material-symbols-outlined text-[14px]">
              {tag === '手工备忘' ? 'alarm' : 'warning'}
            </span>
            {tag}
          </span>
          {isUrgent && (
            <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-semibold bg-red-50 text-error border border-red-200 animate-pulse">
              待处理
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {activeReminders.length > 1 && (
            <span className="text-[11px] font-medium text-text-muted bg-surface-container px-1.5 py-0.5 rounded">
              {safeIndex + 1} / {activeReminders.length}
            </span>
          )}
          <span className="text-[12px] font-medium text-text-muted">
            {formattedTime}
          </span>
        </div>
      </div>

      {/* 提醒主要内容：展示多行结构化提醒/备忘内容 */}
      <div className="py-2.5">
        <div className="bg-surface-bg/70 p-2.5 rounded-lg border border-border-subtle/70">
          {renderFormattedContent(currentItem.content)}
        </div>
      </div>

      {/* 底部按钮：仅保留 延后10分钟 和 已完成 */}
      <div className="flex items-center justify-between border-t border-border-subtle/80 pt-3 gap-2">
        <button
          type="button"
          disabled={isProcessing}
          onClick={handleSnooze}
          className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-border-subtle bg-surface-bg px-3 py-2 text-body-sm font-semibold text-text-main hover:bg-surface-container hover:border-text-muted transition-colors disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[16px]">snooze</span>
          延后 10 分钟
        </button>
        <button
          type="button"
          disabled={isProcessing}
          onClick={handleDone}
          className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-action-green px-3 py-2 text-body-sm font-semibold text-white shadow-sm hover:bg-action-green/90 transition-colors disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[16px]">check_circle</span>
          已完成
        </button>
      </div>
    </div>
  )
}

function IconCopyButton({
  title = '复制订单号',
  copied,
  onClick
}: {
  title?: string
  copied: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-md bg-white/70 border border-border-subtle text-[#6f7f95] hover:bg-primary-fixed hover:text-primary hover:border-primary-fixed-dim transition-colors"
    >
      {copied ? (
        <span className="material-symbols-outlined text-action-green" style={{ fontSize: '12px' }}>
          check
        </span>
      ) : (
        <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>
          content_copy
        </span>
      )}
    </button>
  )
}

export default DesktopReminderPopup
