import { useEffect, useState, useRef } from 'react'
import {
  snoozeOrderReminder,
  doneOrderReminder,
  type OrderReminder
} from '../api'

export default function DesktopReminderWindowView(): React.JSX.Element {
  const [reminder, setReminder] = useState<OrderReminder | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    // 设为透明背景
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'

    // 获取当前已有提醒数据
    window.api?.getCurrentReminder?.().then((data) => {
      if (data) {
        setReminder(data as OrderReminder)
        playChime()
      }
    })

    // 监听主进程推过来的提醒
    const cleanup = window.api?.onReminderData?.((data) => {
      if (data) {
        setReminder(data as OrderReminder)
        playChime()
      }
    })

    return () => {
      cleanup?.()
    }
  }, [])

  const playChime = (): void => {
    try {
      if (!audioRef.current) {
        // 短促清脆的提示音
        audioRef.current = new Audio('data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU')
      }
      void audioRef.current.play()
    } catch {}
  }


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

  const handleSnooze = async (): Promise<void> => {
    if (!reminder || isProcessing) return
    setIsProcessing(true)
    try {
      await snoozeOrderReminder(reminder.id, 10)
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
      window.api?.hideDesktopReminder?.()
    } catch (err) {
      console.error('[reminder] snooze failed:', err)
    } finally {
      setIsProcessing(false)
    }
  }

  const handleDone = async (): Promise<void> => {
    if (!reminder || isProcessing) return
    setIsProcessing(true)
    try {
      await doneOrderReminder(reminder.id)
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
      window.api?.hideDesktopReminder?.()
    } catch (err) {
      console.error('[reminder] mark done failed:', err)
    } finally {
      setIsProcessing(false)
    }
  }

  const handleClose = (): void => {
    window.api?.hideDesktopReminder?.()
  }

  if (!reminder) {
    return <div className="w-full h-full bg-transparent" />
  }

  const tag = reminder.type === 'manual' ? '手工备忘' : '系统提醒'
  const isUrgent = tag === '系统提醒'
  const timeStr = reminder.remind_time || reminder.remindTime
  const formattedTime = timeStr
    ? new Date(timeStr).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : ''

  const fallbackOrderNo = reminder.order_no || reminder.orderNo
  const hasOrderInContent =
    reminder.content?.includes('订单号:') ||
    reminder.content?.includes('订单号：') ||
    reminder.content?.includes('单号:') ||
    reminder.content?.includes('单号：')

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
    <div className="w-full h-full p-2.5 select-none bg-transparent flex flex-col justify-center">
      <div
        className="w-full rounded-xl border border-border-subtle bg-white p-3.5 shadow-2xl transition-all duration-300"
        style={{
          boxShadow: '0 16px 32px -8px rgba(0, 0, 0, 0.25), 0 0 16px rgba(0,0,0,0.08)'
        }}
      >
        {/* 顶部：标签、时间与关闭 */}
        <div className="flex items-center justify-between border-b border-border-subtle/80 pb-2">
          <div className="flex items-center gap-1.5">
            <span
              className={
                'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ' +
                (tag === '手工备忘'
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'bg-red-50 text-error border border-red-200')
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

          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-medium text-text-muted">
              {formattedTime}
            </span>
            <button
              type="button"
              onClick={handleClose}
              className="text-text-muted hover:text-text-main p-0.5 rounded hover:bg-surface-container transition-colors"
              title="关闭"
            >
              <span className="material-symbols-outlined text-[16px]">close</span>
            </button>
          </div>
        </div>

        {/* 中间内容：结构化展示多行字段 */}
        <div className="py-2.5">
          <div className="bg-surface-bg/70 p-2.5 rounded-lg border border-border-subtle/70">
            {renderFormattedContent(reminder.content)}
          </div>
        </div>

        {/* 底部按钮：延后 10 分钟 / 已完成 */}
        <div className="flex items-center justify-between border-t border-border-subtle/80 pt-2.5 gap-2">
          <button
            type="button"
            disabled={isProcessing}
            onClick={handleSnooze}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-border-subtle bg-surface-bg px-2.5 py-1.5 text-body-sm font-semibold text-text-main hover:bg-surface-container hover:border-text-muted transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[15px]">snooze</span>
            延后 10 分钟
          </button>
          <button
            type="button"
            disabled={isProcessing}
            onClick={handleDone}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-action-green px-2.5 py-1.5 text-body-sm font-semibold text-white shadow-sm hover:bg-action-green/90 transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[15px]">check_circle</span>
            已完成
          </button>
        </div>
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
