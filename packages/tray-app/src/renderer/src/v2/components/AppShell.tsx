import { useEffect, useRef, useState, type ReactNode } from 'react'
import { initials } from '../lib/orderMapping'
import { getTheme, toggleTheme, type Theme } from '../lib/theme'
import {
  fetchUnmatchedOrderRefs,
  dismissUnmatchedOrderRef,
  confirmUnmatchedOrderRef,
  type UnmatchedOrderRef
} from '../api'
import StatusBar from './StatusBar'
import type { Session } from '../api'

export type NavKey = 'claim' | 'workbench' | 'customers' | 'knowledge' | 'dashboard' | 'debug' | 'settings'

const NAV: { key: NavKey; label: string }[] = [
  { key: 'claim', label: '待申领' },
  { key: 'workbench', label: '工作台' },
  { key: 'customers', label: '客户档案' },
  { key: 'knowledge', label: '知识库' },
  { key: 'dashboard', label: '数据看板' },
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
  children
}: {
  active: NavKey
  onNavigate: (k: NavKey) => void
  session: Session
  onLogout: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="h-full flex flex-col bg-surface-bg text-text-main overflow-hidden">
      {/* 顶部导航 */}
      <header className="h-16 shrink-0 bg-white border-b border-border-subtle shadow-sm flex justify-between items-center px-6 z-50">
        <div className="flex items-center gap-8 h-full">
          <div className="flex items-center gap-2 text-primary font-bold">
            <span className="material-symbols-outlined filled text-2xl">health_and_safety</span>
            <span className="text-h2-header">智能寰宇</span>
          </div>
          <nav className="hidden md:flex gap-6 items-center h-full">
            {NAV.map((n) => {
              const on = n.key === active
              return (
                <button
                  key={n.key}
                  onClick={() => onNavigate(n.key)}
                  className={
                    'h-full flex items-center text-body-lg border-b-2 transition-colors ' +
                    (on
                      ? 'text-primary font-semibold border-primary'
                      : 'text-text-muted border-transparent hover:text-primary')
                  }
                >
                  {n.label}
                </button>
              )
            })}
          </nav>
        </div>

        <div className="flex items-center gap-0.5">
          <ThemeToggle />
          <NotificationBell />
          <IconBtn icon="help" title="帮助" />
          <button
            onClick={() => onNavigate('settings')}
            className={
              'p-1.5 hover:bg-surface-container-low rounded-full transition-colors ' +
              (active === 'settings' ? 'text-primary bg-surface-container-low' : 'text-text-muted')
            }
            title="设置"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '19px' }}>settings</span>
          </button>
          <UserMenu session={session} onLogout={onLogout} />
        </div>
      </header>

      {/* 业务内容区 */}
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>

      {/* 底部状态栏：后端 / Chrome 插件 / 移动端 App */}
      <StatusBar session={session} />
    </div>
  )
}

/**
 * 右上角头像菜单：点击展开/收起，点击外部或选择后关闭。
 * （原来用纯 CSS group-hover，头像与菜单间有 8px 空隙，鼠标移过去就隐藏了，点不到"退出登录"。）
 */
function UserMenu({ session, onLogout }: { session: Session; onLogout: () => void }): React.JSX.Element {
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
              onLogout()
            }}
            className="w-full text-left px-3 py-1.5 text-body-sm text-text-main hover:bg-surface-container-low"
          >
            退出登录
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 右上角通知铃铛：展示"识别到订单号/短尾号却没关联到订单"的异常（后端 UnmatchedOrderRef，只看 pending）。
 * 角标显示待处理条数；下拉列表里每条可「标记已处理」(后端 reject)。每 60s 轮询一次。
 */
function NotificationBell(): React.JSX.Element {
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
        className="relative p-1.5 text-text-muted hover:bg-surface-container-low rounded-full transition-colors"
        title="通知"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '19px' }}>notifications</span>
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center font-semibold">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 w-96 max-h-[28rem] overflow-auto bg-white border border-border-subtle rounded-lg shadow-lg z-50">
            <div className="px-4 py-2.5 border-b border-border-subtle flex items-center justify-between sticky top-0 bg-white">
              <span className="text-body-lg font-semibold text-text-main">待确认订单号</span>
              <span className="text-body-sm text-text-muted">{count} 条</span>
            </div>
            {count === 0 ? (
              <div className="px-4 py-8 text-center text-body-sm text-text-muted">
                {loading ? '加载中…' : '没有待处理的异常'}
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
                                    {o.applyNo ? `申请号 ${o.applyNo} · ` : ''}
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

function IconBtn({ icon, title }: { icon: string; title: string }): React.JSX.Element {
  return (
    <button className="p-1.5 text-text-muted hover:bg-surface-container-low rounded-full transition-colors" title={title}>
      <span className="material-symbols-outlined" style={{ fontSize: '19px' }}>{icon}</span>
    </button>
  )
}

function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(getTheme())
  return (
    <button
      onClick={(e) => setTheme(toggleTheme(e))}
      className="p-1.5 text-text-muted hover:bg-surface-container-low rounded-full transition-colors"
      title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '19px' }}>
        {theme === 'dark' ? 'light_mode' : 'dark_mode'}
      </span>
    </button>
  )
}
