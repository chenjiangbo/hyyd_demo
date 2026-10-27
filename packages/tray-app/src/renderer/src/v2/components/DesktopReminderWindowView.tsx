import React, { useEffect, useState, useRef, useCallback } from 'react'
import {
  snoozeOrderReminder,
  doneOrderReminder,
  dismissOrderReminderPopups,
  type OrderReminder
} from '../api'

export default function DesktopReminderWindowView(): React.JSX.Element {
  const [reminders, setReminders] = useState<OrderReminder[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card')
  const [isProcessing, setIsProcessing] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const remindersRef = useRef<OrderReminder[]>([])

  useEffect(() => {
    remindersRef.current = reminders
  }, [reminders])

  const playChime = (): void => {
    try {
      if (!audioRef.current) {
        audioRef.current = new Audio('data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU')
      }
      void audioRef.current.play()
    } catch {}
  }

  const applyNewReminders = useCallback((data: unknown) => {
    if (!data) return
    const rawList = Array.isArray(data) ? (data as OrderReminder[]) : [data as OrderReminder]
    if (rawList.length === 0) return

    setReminders((prev) => {
      const prevKey = prev.map((r) => `${r.id}_${r.notification_generation || 1}`).sort().join('|')
      const newKey = rawList.map((r) => `${r.id}_${r.notification_generation || 1}`).sort().join('|')
      if (prevKey === newKey) {
        return prev // 数据完全无变化，不触发状态重置，保留当前翻页和展开状态
      }
      const prevVersions = new Set(prev.map((r) => `${r.id}_${r.notification_generation || 1}`))
      const hasNew = rawList.some((r) => !prevVersions.has(`${r.id}_${r.notification_generation || 1}`))
      if (hasNew) playChime()
      setCurrentIndex((prevIdx) => (prevIdx >= rawList.length ? Math.max(0, rawList.length - 1) : prevIdx))
      return rawList
    })
  }, [])

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'

    window.api?.getCurrentReminder?.().then((data) => {
      applyNewReminders(data)
    })

    const cleanup = window.api?.onReminderData?.((data) => {
      applyNewReminders(data)
    })

    return () => {
      cleanup?.()
    }
  }, [applyNewReminders])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (viewMode === 'card' && reminders.length > 1) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          setCurrentIndex((prev) => Math.max(0, prev - 1))
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          setCurrentIndex((prev) => Math.min(reminders.length - 1, prev + 1))
        }
      }
      if (e.key === 'Escape') {
        void handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [viewMode, reminders.length])

  const handleToggleViewMode = (mode: 'card' | 'list') => {
    setViewMode(mode)
    if (window.api?.resizeDesktopReminder) {
      if (mode === 'list') {
        void window.api.resizeDesktopReminder({ width: 380, height: 540 })
      } else {
        void window.api.resizeDesktopReminder({ width: 380, height: 270 })
      }
    }
  }

  const resetToCard = (): void => {
    setViewMode('card')
    void window.api?.resizeDesktopReminder?.({ width: 380, height: 270 })
  }

  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copy = (value: string, key: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!value) return
    void navigator.clipboard?.writeText(value)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1200)
  }

  const handleSnoozeItem = async (id: number): Promise<void> => {
    if (isProcessing) return
    setIsProcessing(true)
    try {
      await snoozeOrderReminder(id, 10)
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))

      const nextList = reminders.filter((r) => r.id !== id)
      if (nextList.length === 0) {
        resetToCard()
        window.api?.hideDesktopReminder?.()
        setReminders([])
      } else {
        setReminders(nextList)
        setCurrentIndex((prev) => (prev >= nextList.length ? nextList.length - 1 : prev))
      }
    } catch (err) {
      console.error('[reminder] snooze failed:', err)
    } finally {
      setIsProcessing(false)
    }
  }

  const handleDoneItem = async (id: number): Promise<void> => {
    if (isProcessing) return
    setIsProcessing(true)
    try {
      await doneOrderReminder(id)
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))

      const nextList = reminders.filter((r) => r.id !== id)
      if (nextList.length === 0) {
        resetToCard()
        window.api?.hideDesktopReminder?.()
        setReminders([])
      } else {
        setReminders(nextList)
        setCurrentIndex((prev) => (prev >= nextList.length ? nextList.length - 1 : prev))
      }
    } catch (err) {
      console.error('[reminder] mark done failed:', err)
    } finally {
      setIsProcessing(false)
    }
  }

  const handleSnoozeAll = async (): Promise<void> => {
    if (reminders.length === 0 || isProcessing) return
    setIsProcessing(true)
    try {
      await Promise.all(reminders.map((r) => snoozeOrderReminder(r.id, 10)))
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
      resetToCard()
      window.api?.hideDesktopReminder?.()
      setReminders([])
    } catch (err) {
      console.error('[reminder] snooze all failed:', err)
    } finally {
      setIsProcessing(false)
    }
  }

  const handleDoneAll = async (): Promise<void> => {
    if (reminders.length === 0 || isProcessing) return
    setIsProcessing(true)
    try {
      await Promise.all(reminders.map((r) => doneOrderReminder(r.id)))
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
      resetToCard()
      window.api?.hideDesktopReminder?.()
      setReminders([])
    } catch (err) {
      console.error('[reminder] done all failed:', err)
    } finally {
      setIsProcessing(false)
    }
  }

  const handleClose = async (): Promise<void> => {
    try {
      await dismissOrderReminderPopups(remindersRef.current.map((r) => ({
        id: r.id,
        generation: Number(r.notification_generation || 1)
      })))
    } catch (err) {
      console.error('[reminder] dismiss popup failed:', err)
      return
    }
    resetToCard()
    window.api?.hideDesktopReminder?.()
  }

  if (reminders.length === 0) {
    return <div className="w-full h-full bg-transparent" />
  }

  const safeIndex = Math.min(currentIndex, reminders.length - 1)
  const currentReminder = reminders[safeIndex]
  if (!currentReminder) return <div className="w-full h-full bg-transparent" />

  const totalCount = reminders.length

  const extractOrderNo = (r: OrderReminder): string => {
    const huanyuOrderNo = r.huanyu_order_no || r.huanyuOrderNo
    if (huanyuOrderNo && huanyuOrderNo !== 'SYSTEM' && huanyuOrderNo !== 'ALL') return huanyuOrderNo
    if (r.order_no && r.order_no !== 'SYSTEM' && r.order_no !== 'ALL') return r.order_no
    if (r.orderNo && r.orderNo !== 'SYSTEM' && r.orderNo !== 'ALL') return r.orderNo
    const huanyuMatch = r.content?.match(/寰宇订单号[：:]\s*([A-Za-z0-9_-]+)/)
    if (huanyuMatch) return huanyuMatch[1]
    const match = r.content?.match(/(?:订单号|单号)[：:]\s*([A-Za-z0-9_-]+)/)
    return match ? match[1] : ''
  }

  const extractBriefContent = (rawContent?: string): string => {
    if (!rawContent) return ''
    const normalized = rawContent.replace(/\\n/g, '\n')
    const lines = normalized.split('\n').filter(Boolean).filter((line) => !/^(B端订单号|寰宇订单号|订单号)[：:]/.test(line.trim()))
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

  const currentTag = currentReminder.type === 'manual' ? '手工备忘' : '系统提醒'
  const isUrgent = currentTag === '系统提醒'
  const timeStr = currentReminder.remind_time || currentReminder.remindTime
  const currentFormattedTime = timeStr
    ? new Date(timeStr).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
    : ''

  const renderFormattedContent = (rawContent: string) => {
    if (!rawContent) return null
    const normalized = rawContent.replace(/\\n/g, '\n')
    const lines = normalized.split('\n').filter(Boolean).filter((line) => !/^(B端订单号|寰宇订单号|订单号)[：:]/.test(line.trim()))
    const fallbackOrderNo = extractOrderNo(currentReminder)
    const hasOrderInContent =
      rawContent.includes('订单号:') ||
      rawContent.includes('订单号：') ||
      rawContent.includes('单号:') ||
      rawContent.includes('单号：')

    return (
      <div className="space-y-1.5 text-[13px] leading-relaxed text-text-main font-normal">
        {[{ label: 'B端订单号', value: currentReminder.order_no || currentReminder.orderNo }, { label: '寰宇订单号', value: currentReminder.huanyu_order_no || currentReminder.huanyuOrderNo }].filter((item) => item.value && item.value !== 'SYSTEM' && item.value !== 'ALL').map((item) => (
          <div key={item.label} className="flex items-center text-[13px]">
            <span className="w-[72px] shrink-0 whitespace-nowrap text-text-muted">{item.label}：</span>
            <span className="flex-1 font-mono break-all text-text-main">{item.value}</span>
            <IconCopyButton title={`复制${item.label} ${item.value}`} copied={copiedKey === `number-${item.label}`} onClick={(e) => copy(item.value!, `number-${item.label}`, e)} />
          </div>
        ))}
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
                    <span className="font-mono text-text-main font-medium break-all text-left">{val}</span>
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
              <span className="font-mono text-text-main font-medium break-all text-left">{fallbackOrderNo}</span>
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

  if (viewMode === 'list') {
    return (
      <div className="w-full h-full p-2 select-none bg-transparent flex flex-col justify-end box-border">
        {customScrollStyle}
        <div
          className="w-full h-full rounded-xl border border-border-subtle bg-white p-2.5 shadow-2xl flex flex-col box-border overflow-hidden"
          style={{
            boxShadow: '0 16px 32px -8px rgba(0, 0, 0, 0.25), 0 0 16px rgba(0,0,0,0.08)'
          }}
        >
          {/* 顶部标题与返回卡片视图 */}
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
                onClick={() => handleToggleViewMode('card')}
                className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium text-text-main bg-surface-container hover:bg-border-subtle transition-colors cursor-pointer"
                title="返回卡片模式"
              >
                <span className="material-symbols-outlined text-[13px]">view_carousel</span>
                卡片模式
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="text-text-muted hover:text-text-main p-0.5 rounded hover:bg-surface-container transition-colors cursor-pointer"
                title="关闭浮窗"
              >
                <span className="material-symbols-outlined text-[15px]">close</span>
              </button>
            </div>
          </div>

          {/* 中间清单列表：内部平滑滚动，窗口外壳绝不放大 */}
          <div className="py-1.5 flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1 custom-reminder-scroll">
            {reminders.map((r, idx) => {
              const orderNo = extractOrderNo(r)
              const rTime = r.remind_time || r.remindTime
              const rTimeStr = rTime
                ? new Date(rTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
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
                        <span className="font-mono text-text-main text-[12px] font-medium truncate text-left">{orderNo}</span>
                      ) : <span className="text-[11px] text-text-muted">无单号</span>}
                      {(r.huanyu_order_no || r.huanyuOrderNo) && r.order_no && (
                        <span className="ml-1 text-[10px] text-text-muted truncate">寰宇 {r.huanyu_order_no || r.huanyuOrderNo}</span>
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

          {/* 底部全部批量操作 */}
          <div className="flex items-center justify-between border-t border-border-subtle/80 pt-1.5 gap-2 shrink-0">
            <button
              type="button"
              disabled={isProcessing}
              onClick={handleSnoozeAll}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-border-subtle bg-surface-bg px-2 py-1.5 text-[12px] font-semibold text-text-main hover:bg-surface-container hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">snooze</span>
              全部延后 10 分钟
            </button>
            <button
              type="button"
              disabled={isProcessing}
              onClick={handleDoneAll}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-action-green px-2 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-action-green/90 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">check_circle</span>
              全部标记完成
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 默认卡片视图 (Card Mode)
  return (
    <div className="w-full h-full p-2 select-none bg-transparent flex flex-col justify-end box-border">
      {customScrollStyle}
      <div
        className="w-full h-full rounded-xl border border-border-subtle bg-white p-2.5 shadow-2xl flex flex-col box-border overflow-hidden"
        style={{
          boxShadow: '0 16px 32px -8px rgba(0, 0, 0, 0.25), 0 0 16px rgba(0,0,0,0.08)'
        }}
      >
        {/* 顶部：左侧标签，右侧翻页器、时间与关闭 */}
        <div className="flex items-center justify-between border-b border-border-subtle/80 pb-1.5 shrink-0">
          <div className="flex items-center gap-1.5">
            <span
              className={
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold ' +
                (currentTag === '手工备忘'
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'bg-red-50 text-error border border-red-200')
              }
            >
              <span className="material-symbols-outlined text-[13px]">
                {currentTag === '手工备忘' ? 'alarm' : 'warning'}
              </span>
              {currentTag}
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
              {currentFormattedTime}
            </span>
            <button
              type="button"
              onClick={handleClose}
              className="text-text-muted hover:text-text-main p-0.5 rounded hover:bg-surface-container transition-colors cursor-pointer"
              title="关闭浮窗"
            >
              <span className="material-symbols-outlined text-[15px]">close</span>
            </button>
          </div>
        </div>

        {/* 中间内容：固定高度容器内滑动，单条/多条窗口尺寸严格一致 */}
        <div className="py-1.5 flex-1 min-h-0 overflow-hidden flex flex-col">
          <div className="flex-1 min-h-0 bg-surface-bg/70 p-2 rounded-lg border border-border-subtle/70 overflow-y-auto pr-1 custom-reminder-scroll">
            {renderFormattedContent(currentReminder.content)}
          </div>
        </div>

        {/* 底部按钮：延后 10 分钟 / 已完成，以及多条时的批量操作 */}
        <div className="flex flex-col gap-1 border-t border-border-subtle/80 pt-1.5 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={isProcessing}
              onClick={() => handleSnoozeItem(currentReminder.id)}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border border-border-subtle bg-surface-bg px-2 py-1.5 text-[12px] font-semibold text-text-main hover:bg-surface-container hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">snooze</span>
              延后 10 分钟
            </button>
            <button
              type="button"
              disabled={isProcessing}
              onClick={() => handleDoneItem(currentReminder.id)}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-action-green px-2 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-action-green/90 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">check_circle</span>
              已完成
            </button>
          </div>

          {/* 多条时的批量操作与清单切换（单条时不显示此行，card总高依然通过flex保持完全相同） */}
          {totalCount > 1 && (
            <div className="flex items-center justify-between text-[10.5px] text-text-muted px-0.5 pt-0.5">
              <span>共有 <strong className="text-text-main font-semibold">{totalCount}</strong> 条提醒</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleToggleViewMode('list')}
                  className="text-primary hover:underline font-medium transition-colors cursor-pointer"
                >
                  展开清单
                </button>
                <span className="text-border-subtle">·</span>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={handleSnoozeAll}
                  className="text-text-muted hover:text-text-main transition-colors disabled:opacity-50 cursor-pointer"
                >
                  全部延后
                </button>
                <span className="text-border-subtle">·</span>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={handleDoneAll}
                  className="text-action-green hover:underline font-medium transition-colors disabled:opacity-50 cursor-pointer"
                >
                  全部完成
                </button>
              </div>
            </div>
          )}
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
