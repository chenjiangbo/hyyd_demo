import { useEffect, useRef, useState, type ReactNode } from 'react'
import { initials } from '../lib/orderMapping'
import { getTheme, toggleTheme, type Theme } from '../lib/theme'
import {
  fetchUnmatchedOrderRefs,
  dismissUnmatchedOrderRef,
  confirmUnmatchedOrderRef,
  fetchOrderReminders,
  doneOrderReminder,
  snoozeOrderReminder,
  type UnmatchedOrderRef,
  type OrderReminder
} from '../api'
import StatusBar from './StatusBar'
import { DesktopReminderPopup } from './DesktopReminderPopup'
import type { Session } from '../api'

export type NavKey = 'claim' | 'workbench' | 'customers' | 'dictionary' | 'knowledge' | 'dashboard' | 'debug' | 'settings'

// 顺序与命名对齐原型（数据看板 / 申领台 / 工作台 / 知识库 / 档案库 / 字典维护）
const NAV: { key: NavKey; label: string }[] = [
  { key: 'dashboard', label: '数据看板' },
  { key: 'claim', label: '申领台' },
  { key: 'workbench', label: '工作台' },
  { key: 'knowledge', label: '知识库' },
  { key: 'customers', label: '档案库' },
  { key: 'dictionary', label: '字典维护' },
  // 【临时】sidecar 采集调试，验证完成后连同页面一起删除
  { key: 'debug', label: '🔧 采集调试' }
]

/**
 * 应用外壳：顶部 64px 导航条（品牌 + 5 个一级 Tab + 右侧操作 + 头像）。
 * 各业务页面作为 children 渲染在导航条下方。
 */
export default function AppShell({
  active,
  onNavigate,
  session,
  onLogout,
  onChangePassword,
  search,
  onSearch,
  children
}: {
  active: NavKey
  onNavigate: (k: NavKey) => void
  session: Session
  onLogout: () => void
  onChangePassword?: () => void
  search: string
  onSearch: (v: string) => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="h-full flex flex-col bg-surface-bg text-text-main overflow-hidden relative">
      {/* 顶部导航（对齐原型） */}
      <header className="h-16 shrink-0 bg-white border-b border-border-subtle flex items-center px-6 gap-8 z-50">
        {/* 品牌 */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-white">
            <span className="material-symbols-outlined filled text-[20px]">medical_services</span>
          </div>
          <h1 className="text-h3-title text-primary font-nav font-black">智能寰宇</h1>
        </div>

        {/* 一级导航 */}
        <nav className="hidden md:flex h-full items-center gap-1 shrink-0">
          {NAV.map((n) => {
            const on = n.key === active
            return (
              <button
                key={n.key}
                onClick={() => onNavigate(n.key)}
                className={
                  'h-full flex items-center px-3 text-body-md font-nav font-black border-b-2 transition-colors ' +
                  (on
                    ? 'text-primary border-primary'
                    : 'text-text-main border-transparent hover:text-primary hover:border-primary-fixed')
                }
              >
                {n.label}
              </button>
            )
          })}
        </nav>

        {/* 全局搜索 */}
        <div className="flex-1 max-w-2xl ml-auto">
          <div className="relative flex items-center w-full">
            <span className="material-symbols-outlined absolute left-3 text-outline text-[20px]">search</span>
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="搜索申请号、患者姓名、电话…"
              className="w-full pl-10 pr-16 py-2 bg-surface-container-low border border-transparent rounded-lg text-body-md focus:outline-none focus:bg-white focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
            />
            <button className="absolute right-3 text-primary text-[12px] leading-4 font-bold hover:bg-primary-fixed/30 px-2 py-1 rounded transition-colors">
              高级
            </button>
          </div>
        </div>

        {/* 右侧操作 */}
        <div className="flex items-center gap-1 shrink-0">
          <ThemeToggle />
          <UnmatchedRefsBell />
          <ReminderTodoBell />
          <IconBtn icon="help" title="帮助" />
          <button
            onClick={() => onNavigate('settings')}
            className={
              'w-9 h-9 rounded-full flex items-center justify-center hover:bg-surface-container-low transition-colors ' +
              (active === 'settings' ? 'text-primary bg-surface-container-low' : 'text-on-surface-variant')
            }
            title="设置"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>settings</span>
          </button>
          <UserMenu session={session} onLogout={onLogout} onChangePassword={onChangePassword} />
        </div>
      </header>

      {/* 主体页面 */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{children}</div>

      {/* 底部状态栏 */}
      <StatusBar session={session} />

      {/* 桌面右下角到期提醒浮窗 */}
      <DesktopReminderPopup />
    </div>
  )
}

/**
 * 右上角头像菜单：点击展开/收起，点击外部或选择后关闭。
 * （原来用纯 CSS group-hover，头像与菜单间有 8px 空隙，鼠标移过去就隐藏了，点不到"退出登录"。）
 */
function UserMenu({ session, onLogout, onChangePassword }: { session: Session; onLogout: () => void; onChangePassword?: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div className="relative ml-1" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-body-sm font-semibold"
        title={session.displayName}
      >
        {initials(session.displayName)}
      </button>
      {open && (
        <div className="absolute right-0 top-10 bg-white border border-border-subtle rounded-lg shadow-lg py-1 min-w-32 z-50">
          <div className="px-3 py-1.5 text-body-sm text-text-muted border-b border-border-subtle">
            {session.displayName}
          </div>
          <button
            onClick={() => {
              setOpen(false)
              onChangePassword?.()
            }}
            className="w-full text-left px-3 py-1.5 text-body-sm text-text-main hover:bg-surface-container-low flex items-center gap-2"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>key</span>
            修改密码
          </button>
          <button
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
            className="w-full text-left px-3 py-1.5 text-body-sm text-red-600 hover:bg-surface-container-low flex items-center gap-2"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>logout</span>
            退出登录
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 待确认订单号：展示"识别到订单号/短尾号却没关联到订单"的异常。
 */
function UnmatchedRefsBell(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<UnmatchedOrderRef[]>([])
  const [loading, setLoading] = useState(false)

  const load = async (): Promise<void> => {
    try {
      setLoading(true)
      setItems(await fetchUnmatchedOrderRefs('pending'))
    } catch {
      // 未登录/网络异常时静默，不打扰
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  const dismiss = async (id: number): Promise<void> => {
    try {
      await dismissUnmatchedOrderRef(id)
      setItems((prev) => prev.filter((x) => x.id !== id))
    } catch {
      /* 失败保留，下次刷新再试 */
    }
  }

  const confirm = async (id: number, orderId: number): Promise<void> => {
    try {
      await confirmUnmatchedOrderRef(id, orderId)
      setItems((prev) => prev.filter((x) => x.id !== id))
    } catch {
      /* 失败保留，下次刷新再试 */
    }
  }

  const count = items.length

  return (
    <div className="relative">
      <button
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) load()
        }}
        className="relative w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-low transition-colors"
        title="待确认订单号"
      >
        <span className="material-symbols-outlined text-amber-600" style={{ fontSize: '20px' }}>report_problem</span>
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] leading-4 text-center font-semibold">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 w-96 max-h-[28rem] overflow-auto bg-white border border-border-subtle rounded-lg shadow-lg z-50">
            <div className="px-4 py-2.5 border-b border-border-subtle flex items-center justify-between sticky top-0 bg-white">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-amber-600 text-[18px]">report_problem</span>
                <span className="text-body-lg font-semibold text-text-main">待确认订单号</span>
              </div>
              <span className="text-body-sm text-text-muted">{count} 条异常</span>
            </div>
            {count === 0 ? (
              <div className="px-4 py-8 text-center text-body-sm text-text-muted">
                {loading ? '加载中…' : '没有待处理的异常单号'}
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {items.map((it) => (
                  <li key={it.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-body-sm font-medium text-text-main truncate" title={it.conversationName}>
                          {it.conversationName || '(无会话名)'}
                        </p>
                        <p className="text-body-sm text-text-muted mt-0.5">
                          {it.candidateKind === 'tail8' ? '订单尾号' : '订单号'}{' '}
                          <span className="font-mono text-text-main">{it.candidate}</span>
                          {' · '}
                          {it.channel === 'wxwork' ? '企微' : '微信'}
                          {it.seenCount > 1 ? ` · 出现 ${it.seenCount} 次` : ''}
                        </p>
                        <p className="text-body-sm text-amber-600 mt-0.5">
                          {it.reason === 'ambiguous'
                            ? '多个订单并列，需人工确认'
                            : it.reason === 'name_mismatch'
                              ? '订单号匹配上但客户名对不上，需人工确认'
                              : it.candidateKind === 'tail8'
                                ? '短尾号格式正确，但找不到对应订单'
                                : '找不到对应订单，需人工确认'}
                        </p>
                        {it.candidateOrders && it.candidateOrders.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {it.candidateOrders.map((o) => (
                              <div
                                key={o.id}
                                className="rounded-md border border-border-subtle bg-surface-bg px-2 py-1.5 flex items-center justify-between gap-2"
                              >
                                <div className="min-w-0">
                                  <div className="text-body-sm text-text-main truncate">
                                    {o.customerName || '未命名'} · <span className="font-mono-data">{o.sourceOrderNo}</span>
                                  </div>
                                  <div className="text-[11px] text-text-muted truncate">
                                    {o.applicationNo ? `申请号 ${o.applicationNo} · ` : ''}
                                    {o.ccodApplyNo ? `CCOD ${o.ccodApplyNo} · ` : ''}
                                    {o.status || '无状态'}
                                  </div>
                                </div>
                                <button
                                  onClick={() => confirm(it.id, o.id)}
                                  className="shrink-0 text-body-sm text-primary px-2 py-1 rounded hover:bg-primary-container/10"
                                >
                                  确认关联
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => dismiss(it.id)}
                        className="shrink-0 text-body-sm text-text-muted hover:text-primary px-2 py-1 rounded hover:bg-surface-container-low"
                      >
                        标记已处理
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 右上角订单跟进提醒铃铛：展示当前员工未处理的待办备忘与系统提醒。
 */
function ReminderTodoBell(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<OrderReminder[]>([])
  const [loading, setLoading] = useState(false)

  const load = async (): Promise<void> => {
    try {
      setLoading(true)
      const res = await fetchOrderReminders({ status: 'pending' })
      setItems(res)
    } catch {
      // 未登录/网络异常时静默
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 20_000)
    const handleUpdate = (): void => {
      load()
    }
    window.addEventListener('huanyu-reminders-updated', handleUpdate)
    return () => {
      clearInterval(t)
      window.removeEventListener('huanyu-reminders-updated', handleUpdate)
    }
  }, [])

  const count = items.length

  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copy = (value: string, key: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!value) return
    void navigator.clipboard?.writeText(value)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1200)
  }

  const handleOpenOrder = (orderNo: string, e?: React.MouseEvent): void => {
    e?.stopPropagation()
    if (!orderNo) return
    const cleanNo = orderNo.trim()
    setOpen(false)
    if (window.api?.openOrderFromReminder) {
      void window.api.openOrderFromReminder(cleanNo)
    } else {
      window.dispatchEvent(
        new CustomEvent('huanyu-navigate-order', { detail: { orderNo: cleanNo } })
      )
    }
  }

  const handleDone = async (id: number): Promise<void> => {
    try {
      await doneOrderReminder(id)
      setItems((prev) => prev.filter((x) => x.id !== id))
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
    } catch (err) {
      console.error('[ReminderTodoBell] handleDone failed:', err)
    }
  }

  const handleSnooze = async (id: number): Promise<void> => {
    try {
      await snoozeOrderReminder(id, 10)
      setItems((prev) => prev.filter((x) => x.id !== id))
      window.dispatchEvent(new CustomEvent('huanyu-reminders-updated'))
    } catch (err) {
      console.error('[ReminderTodoBell] handleSnooze failed:', err)
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) load()
        }}
        className="relative w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-low transition-colors"
        title="待办提醒"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>notifications</span>
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-white text-[10px] leading-4 text-center font-semibold animate-pulse">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 w-96 max-h-[28rem] overflow-auto bg-white border border-border-subtle rounded-lg shadow-lg z-50">
            <div className="px-4 py-2.5 border-b border-border-subtle flex items-center justify-between sticky top-0 bg-white">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-primary text-[18px]">alarm</span>
                <span className="text-body-lg font-semibold text-text-main">待办提醒</span>
              </div>
              <span className="text-body-sm text-text-muted">{count} 条待办</span>
            </div>
            {count === 0 ? (
              <div className="px-4 py-8 text-center text-body-sm text-text-muted">
                {loading ? '加载中…' : '暂无待处理提醒'}
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {items.map((it) => {
                  const tag = it.type === 'manual' ? '手工备忘' : '系统提醒'
                  const timeStr = it.remind_time || it.remindTime
                  const isDue = Boolean(timeStr && new Date(timeStr) <= new Date())
                  const hasOrderInContent =
                    it.content?.includes('订单号:') ||
                    it.content?.includes('订单号：') ||
                    it.content?.includes('单号:') ||
                    it.content?.includes('单号：')
                  const fallbackOrderNo = it.order_no || it.orderNo

                  return (
                    <li key={it.id} className="px-4 py-3 hover:bg-surface-bg/50 transition-colors">
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <span
                              className={`inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-semibold ${
                                tag === '手工备忘'
                                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                  : 'bg-red-50 text-error border border-red-200'
                              }`}
                            >
                              {tag}
                            </span>
                            <span className="text-[11px] text-text-muted">
                              {(() => {
                                if (!timeStr) return ''
                                const d = new Date(timeStr)
                                if (isNaN(d.getTime())) return String(timeStr)
                                const y = d.getFullYear()
                                const m = String(d.getMonth() + 1).padStart(2, '0')
                                const day = String(d.getDate()).padStart(2, '0')
                                const hh = String(d.getHours()).padStart(2, '0')
                                const mm = String(d.getMinutes()).padStart(2, '0')
                                const ss = String(d.getSeconds()).padStart(2, '0')
                                return `${y}-${m}-${day} ${hh}:${mm}:${ss}`
                              })()}
                            </span>
                            {isDue && (
                              <span className="text-[10px] text-error font-semibold animate-pulse">· 已到期</span>
                            )}
                          </div>
                          <div className="space-y-1 text-[13px] leading-relaxed text-text-main font-normal">
                            {(() => {
                              const normalized = (it.content || '').replace(/\\n/g, '\n')
                              const lines = normalized.split('\n').filter(Boolean)
                              return lines.map((line, idx) => {
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
                                            onClick={(e) => handleOpenOrder(val, e)}
                                            className="font-mono text-primary hover:underline font-medium break-all text-left cursor-pointer transition-colors"
                                            title="点击在工作台中搜索此订单"
                                          >
                                            {val}
                                          </button>
                                          <IconCopyButton
                                            title={`复制订单号 ${val}`}
                                            copied={copiedKey === `bell-${it.id}-${idx}`}
                                            onClick={(e) => copy(val, `bell-${it.id}-${idx}`, e)}
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
                              })
                            })()}
                          </div>
                          {!hasOrderInContent && fallbackOrderNo && (
                            <div className="flex items-start text-[13px] pt-1 border-t border-border-subtle/50 mt-1">
                              <span className="w-[72px] shrink-0 whitespace-nowrap text-text-muted">订单号：</span>
                              <div className="flex-1 flex items-center gap-1.5 min-w-0">
                                <button
                                  type="button"
                                  onClick={(e) => handleOpenOrder(fallbackOrderNo, e)}
                                  className="font-mono text-primary hover:underline font-medium break-all text-left cursor-pointer transition-colors"
                                  title="点击在工作台中搜索此订单"
                                >
                                  {fallbackOrderNo}
                                </button>
                                <IconCopyButton
                                  title={`复制订单号 ${fallbackOrderNo}`}
                                  copied={copiedKey === `bell-fallback-${it.id}`}
                                  onClick={(e) => copy(fallbackOrderNo, `bell-fallback-${it.id}`, e)}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0 pt-0.5">
                          <button
                            type="button"
                            onClick={() => handleSnooze(it.id)}
                            className="p-1 rounded text-text-muted hover:text-primary hover:bg-surface-container"
                            title="延后 10 分钟"
                          >
                            <span className="material-symbols-outlined text-[17px]">snooze</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDone(it.id)}
                            className="p-1 rounded text-text-muted hover:text-action-green hover:bg-green-50"
                            title="标记已完成"
                          >
                            <span className="material-symbols-outlined text-[17px]">check_circle</span>
                          </button>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function IconBtn({ icon, title }: { icon: string; title: string }): React.JSX.Element {
  return (
    <button
      className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-low transition-colors"
      title={title}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>{icon}</span>
    </button>
  )
}

function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(getTheme())
  return (
    <button
      onClick={(e) => setTheme(toggleTheme(e))}
      className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-low transition-colors"
      title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
        {theme === 'dark' ? 'light_mode' : 'dark_mode'}
      </span>
    </button>
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
