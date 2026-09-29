import { useState, useEffect, useRef } from 'react'
import {
  fetchOrderReminders,
  snoozeOrderReminder,
  doneOrderReminder,
  type OrderReminder
} from '../api'

export function DesktopReminderPopup() {
  const [activeReminders, setActiveReminders] = useState<OrderReminder[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card')
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
        // 如果在 Electron 环境中，调用原生独立桌面右下角浮窗，传递全部到期提醒
        if (window.api?.showDesktopReminder) {
          void window.api.showDesktopReminder(due)
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
    // 每 5 秒高频准时轮询一次，配合 backgroundThrottling: false 绝不延误
    const timer = setInterval(() => {
      void checkDueReminders()
    }, 5000)

    const handleUpdate = () => {
      void checkDueReminders()
    }
    window.addEventListener('huanyu-reminders-updated', handleUpdate)

    return () => {
      clearInterval(timer)
      window.removeEventListener('huanyu-reminders-updated', handleUpdate)
    }
  }, [])

  // 监听键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (viewMode === 'card' && activeReminders.length > 1) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          setCurrentIndex((prev) => Math.max(0, prev - 1))
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          setCurrentIndex((prev) => Math.min(activeReminders.length - 1, prev + 1))
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [viewMode, activeReminders.length])

  // 如果在 Electron 中，由独立桌面原生窗口负责渲染，主窗口无需再渲染 DOM 弹层
  if (window.api?.showDesktopReminder) {
    return null
  }

  if (activeReminders.length === 0) return null

  // 保证当前索引不越界
  const safeIndex = Math.min(currentIndex, activeReminders.length - 1)
  const currentItem = activeReminders[safeIndex]
  if (!currentItem) return null

  const totalCount = activeReminders.length
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

  const extractOrderNo = (r: OrderReminder): string => {
    if (r.order_no && r.order_no !== 'SYSTEM' && r.order_no !== 'ALL') return r.order_no
    if (r.orderNo && r.orderNo !== 'SYSTEM' && r.orderNo !== 'ALL') return r.orderNo
    const match = r.content?.match(/(?:订单号|单号)[：:]\s*([A-Za-z0-9_-]+)/)
    return match ? match[1] : ''
  }

  const extractBriefContent = (rawContent?: string): string => {
    if (!rawContent) return ''
    const normalized = rawContent.replace(/\\n/g, '\n')
    const lines = normalized.split('\n').filter(Boolean)
    for (const line of lines) {
      if (line.includes('提醒内容') || line.includes('备忘内容')) {
        const colonIdx = line.indexOf(':') > -1 ? line.indexOf(':') : line.indexOf('：')
        if (colonIdx > -1) {
          return line.slice(colonIdx + 1).trim()
        }
      }
    }
    const last = lines[lines.length - 1]
    return last || rawContent
  }

  // 延后指定一条
  async function handleSnoozeItem(id: number) {
    if (isProcessing) return
    setIsProcessing(true)
    try {
      await snoozeOrderReminder(id, 10)
      setActiveReminders((prev) => prev.filter((r) => r.id !== id))
      setCurrentIndex((prev) => Math.max(0, prev - 1))
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
    } catch {
      // 异常处理
    } finally {
      setIsProcessing(false)
    }
  }

  // 标记指定一条已完成
  async function handleDoneItem(id: number) {
    if (isProcessing) return
    setIsProcessing(true)
    try {
      await doneOrderReminder(id)
      setActiveReminders((prev) => prev.filter((r) => r.id !== id))
      setCurrentIndex((prev) => Math.max(0, prev - 1))
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
    } catch {
      // 异常处理
    } finally {
      setIsProcessing(false)
    }
  }

  // 全部延后 10 分钟
  async function handleSnoozeAll() {
    if (activeReminders.length === 0 || isProcessing) return
    setIsProcessing(true)
    try {
      await Promise.all(activeReminders.map((r) => snoozeOrderReminder(r.id, 10)))
      setActiveReminders([])
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
    } catch {
      // 异常处理
    } finally {
      setIsProcessing(false)
    }
  }

  // 全部标记已完成
  async function handleDoneAll() {
    if (activeReminders.length === 0 || isProcessing) return
    setIsProcessing(true)
    try {
      await Promise.all(activeReminders.map((r) => doneOrderReminder(r.id)))
      setActiveReminders([])
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
    } catch {
      // 异常处理
    } finally {
      setIsProcessing(false)
    }
  }

  const renderFormattedContent = (rawContent: string) => {
    if (!rawContent) return null
    const normalized = rawContent.replace(/\\n/g, '\n')
    const lines = normalized.split('\n').filter(Boolean)
    const fallbackOrderNo = extractOrderNo(currentItem)
    const hasOrderInContent =
      rawContent.includes('订单号:') ||
      rawContent.includes('订单号：') ||
      rawContent.includes('单号:') ||
      rawContent.includes('单号：')

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
        {!hasOrderInContent && fallbackOrderNo && (
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

  const customScrollStyle = (
    <style>{`
      .custom-reminder-scroll {
        scrollbar-width: thin;
        scrollbar-color: rgba(148, 163, 184, 0.4) transparent;
      }
      .custom-reminder-scroll::-webkit-scrollbar {
        width: 4px;
      }
      .custom-reminder-scroll::-webkit-scrollbar-track {
        background: transparent;
      }
      .custom-reminder-scroll::-webkit-scrollbar-thumb {
        background: rgba(148, 163, 184, 0.35);
        border-radius: 4px;
      }
      .custom-reminder-scroll::-webkit-scrollbar-thumb:hover {
        background: rgba(100, 116, 139, 0.6);
      }
    `}</style>
  )

  // 列表视图
  if (viewMode === 'list') {
    return (
      <div
        className="fixed bottom-5 right-5 z-[99999] w-[380px] h-[508px] rounded-xl border border-border-subtle bg-white p-2.5 shadow-2xl transition-all duration-300 animate-in slide-in-from-bottom-5 flex flex-col box-border overflow-hidden"
        style={{
          boxShadow: '0 20px 30px -10px rgba(0, 0, 0, 0.2), 0 0 15px rgba(0,0,0,0.05)'
        }}
      >
        {customScrollStyle}
        <div className="flex items-center justify-between border-b border-border-subtle/80 pb-1.5 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[12.5px] font-bold text-text-main flex items-center gap-1">
              <span className="material-symbols-outlined text-[15px] text-primary">format_list_bulleted</span>
              待处理清单
            </span>
            <span className="bg-primary/10 text-primary text-[10.5px] font-semibold px-1.5 py-0.2 rounded font-mono">
              {totalCount} 条
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setViewMode('card')}
              className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium text-text-main bg-surface-container hover:bg-border-subtle transition-colors cursor-pointer"
              title="返回卡片模式"
            >
              <span className="material-symbols-outlined text-[13px]">view_carousel</span>
              卡片模式
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode('card')
                setActiveReminders([])
              }}
              className="text-text-muted hover:text-text-main p-0.5 rounded hover:bg-surface-container transition-colors cursor-pointer"
              title="关闭"
            >
              <span className="material-symbols-outlined text-[15px]">close</span>
            </button>
          </div>
        </div>

        <div className="py-1.5 flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1 custom-reminder-scroll">
          {activeReminders.map((r, idx) => {
            const orderNo = extractOrderNo(r)
            const rTime = r.remind_time || r.remindTime
            const rTimeStr = rTime
              ? new Date(rTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
              : ''
            const brief = extractBriefContent(r.content)

            return (
              <div
                key={r.id}
                className="p-1.5 rounded-lg border border-border-subtle bg-surface-bg/60 hover:bg-surface-bg transition-colors flex flex-col gap-1 shrink-0"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[11px] font-mono text-text-muted shrink-0">#{idx + 1}</span>
                    <span
                      className={
                        'px-1.5 py-0.2 rounded text-[10px] font-bold shrink-0 ' +
                        (r.type === 'manual'
                          ? 'bg-amber-50 text-amber-700 border border-amber-200'
                          : 'bg-red-50 text-error border border-red-200')
                      }
                    >
                      {r.type === 'manual' ? '备忘' : '系统'}
                    </span>
                    {orderNo ? (
                      <button
                        type="button"
                        onClick={() => handleOpenOrder(orderNo)}
                        className="font-mono text-primary text-[12px] font-medium hover:underline truncate text-left cursor-pointer"
                        title="点击在工作台中查看此订单"
                      >
                        {orderNo}
                      </button>
                    ) : (
                      <span className="text-[11px] text-text-muted">无单号</span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] text-text-muted mr-1">{rTimeStr}</span>
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => handleSnoozeItem(r.id)}
                      className="px-1.5 py-0.5 rounded text-[10.5px] font-medium border border-border-subtle bg-white text-text-main hover:bg-surface-container transition-colors disabled:opacity-50 cursor-pointer"
                      title="延后 10 分钟"
                    >
                      延后
                    </button>
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => handleDoneItem(r.id)}
                      className="px-1.5 py-0.5 rounded text-[10.5px] font-medium bg-action-green text-white hover:bg-action-green/90 transition-colors disabled:opacity-50 cursor-pointer"
                      title="标记完成"
                    >
                      完成
                    </button>
                  </div>
                </div>

                <div className="text-[11.5px] text-text-main leading-snug line-clamp-2 pl-3">
                  {brief}
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between border-t border-border-subtle/80 pt-1.5 gap-2 shrink-0">
          <button
            type="button"
            disabled={isProcessing}
            onClick={async () => {
              await handleSnoozeAll()
              setViewMode('card')
            }}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-border-subtle bg-surface-bg px-2 py-1.5 text-[12px] font-semibold text-text-main hover:bg-surface-container hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px]">snooze</span>
            全部延后 10 分钟
          </button>
          <button
            type="button"
            disabled={isProcessing}
            onClick={async () => {
              await handleDoneAll()
              setViewMode('card')
            }}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-action-green px-2 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-action-green/90 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px]">check_circle</span>
            全部标记完成
          </button>
        </div>
      </div>
    )
  }

  // 默认卡片视图 (Card Mode)
  return (
    <div
      className="fixed bottom-5 right-5 z-[99999] w-[380px] h-[254px] rounded-xl border border-border-subtle bg-white p-2.5 shadow-2xl transition-all duration-300 animate-in slide-in-from-bottom-5 flex flex-col box-border overflow-hidden"
      style={{
        boxShadow: '0 20px 30px -10px rgba(0, 0, 0, 0.2), 0 0 15px rgba(0,0,0,0.05)'
      }}
    >
      {customScrollStyle}
      {/* 顶部：左侧标签，右侧翻页器、时间与关闭 */}
      <div className="flex items-center justify-between border-b border-border-subtle/80 pb-1.5 shrink-0">
        <div className="flex items-center gap-1.5">
          <span
            className={
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold ' +
              (tag === '手工备忘' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-red-50 text-error border border-red-200')
            }
          >
            <span className="material-symbols-outlined text-[13px]">
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

        <div className="flex items-center gap-1.5">
          {/* 翻页器移到右侧后方 */}
          {totalCount > 1 && (
            <div className="flex items-center bg-surface-container border border-border-subtle px-1 py-0.5 rounded text-[11px] text-text-main font-semibold shadow-xs">
              <button
                type="button"
                disabled={safeIndex <= 0}
                onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
                className="w-3.5 h-3.5 rounded flex items-center justify-center hover:bg-white text-text-muted hover:text-text-main disabled:opacity-25 transition-colors cursor-pointer"
                title="上一条 (快捷键 ←)"
              >
                <span className="material-symbols-outlined text-[13px]">chevron_left</span>
              </button>
              <span className="px-1 font-mono text-[11px]">{safeIndex + 1}/{totalCount}</span>
              <button
                type="button"
                disabled={safeIndex >= totalCount - 1}
                onClick={() => setCurrentIndex((prev) => Math.min(totalCount - 1, prev + 1))}
                className="w-3.5 h-3.5 rounded flex items-center justify-center hover:bg-white text-text-muted hover:text-text-main disabled:opacity-25 transition-colors cursor-pointer"
                title="下一条 (快捷键 →)"
              >
                <span className="material-symbols-outlined text-[13px]">chevron_right</span>
              </button>
            </div>
          )}

          <span className="text-[11.5px] font-medium text-text-muted font-mono">
            {formattedTime}
          </span>
          <button
            type="button"
            onClick={() => {
              setViewMode('card')
              setActiveReminders([])
            }}
            className="text-text-muted hover:text-text-main p-0.5 rounded hover:bg-surface-container transition-colors cursor-pointer"
            title="关闭浮窗"
          >
            <span className="material-symbols-outlined text-[15px]">close</span>
          </button>
        </div>
      </div>

      {/* 提醒主要内容：固定高度容器内滑动，单条/多条窗口尺寸严格一致 */}
      <div className="py-1.5 flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="flex-1 min-h-0 bg-surface-bg/70 p-2 rounded-lg border border-border-subtle/70 overflow-y-auto pr-1 custom-reminder-scroll">
          {renderFormattedContent(currentItem.content)}
        </div>
      </div>

      {/* 底部按钮 */}
      <div className="flex flex-col gap-1 border-t border-border-subtle/80 pt-1.5 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => handleSnoozeItem(currentItem.id)}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-border-subtle bg-surface-bg px-2 py-1.5 text-[12px] font-semibold text-text-main hover:bg-surface-container hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px]">snooze</span>
            延后 10 分钟
          </button>
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => handleDoneItem(currentItem.id)}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-action-green px-2 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-action-green/90 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px]">check_circle</span>
            已完成
          </button>
        </div>

        {totalCount > 1 && (
          <div className="flex items-center justify-between text-[10.5px] text-text-muted px-0.5 pt-0.5">
            <span>共有 <strong className="text-text-main font-semibold">{totalCount}</strong> 条提醒</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className="text-primary hover:underline font-medium transition-colors cursor-pointer"
              >
                展开清单
              </button>
              <span className="text-border-subtle">·</span>
              <button
                type="button"
                disabled={isProcessing}
                onClick={async () => {
                  await handleSnoozeAll()
                  setViewMode('card')
                }}
                className="text-text-muted hover:text-text-main transition-colors disabled:opacity-50 cursor-pointer"
              >
                全部延后
              </button>
              <span className="text-border-subtle">·</span>
              <button
                type="button"
                disabled={isProcessing}
                onClick={async () => {
                  await handleDoneAll()
                  setViewMode('card')
                }}
                className="text-action-green hover:underline font-medium transition-colors disabled:opacity-50 cursor-pointer"
              >
                全部完成
              </button>
            </div>
          </div>
        )}
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
      className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-md bg-white/70 border border-border-subtle text-[#6f7f95] hover:bg-primary-fixed hover:text-primary hover:border-primary-fixed-dim transition-colors cursor-pointer"
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
