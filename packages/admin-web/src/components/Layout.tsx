import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useAdminSocket } from '../hooks/useAdminSocket'
import { useTheme, type ThemePreference } from '../lib/theme'

// 左侧固定窄导航项
const NAV_ITEMS: Array<{ to: string; label: string; icon: string; end?: boolean }> = [
  { to: '/', label: '仪表盘', icon: '◵', end: true },
  { to: '/employees', label: '员工', icon: '☻' },
  { to: '/orders', label: '订单', icon: '▤' },
  { to: '/materials', label: '素材', icon: '✎' },
  { to: '/calls', label: '通话', icon: '☎' },
  { to: '/capture-health', label: '采集健康', icon: '📡' },
  { to: '/unmatched-refs', label: '待确认订单号', icon: '⚠' },
  { to: '/health', label: '系统健康', icon: '✚' },
  { to: '/settings', label: '设置', icon: '⚙' }
]

const THEME_LABELS: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}

export function Layout(): React.JSX.Element {
  const { logout } = useAuth()
  const { preference, setPreference } = useTheme()
  useAdminSocket() // 订阅后端实时推送（新素材/通话 → 仪表盘秒级刷新）

  const cycleTheme = (): void => {
    const order: ThemePreference[] = ['system', 'light', 'dark']
    const next = order[(order.indexOf(preference) + 1) % order.length]
    setPreference(next)
  }

  return (
    <div className="min-h-screen flex bg-bg text-fg">
      {/* 左侧导航 */}
      <aside className="w-52 shrink-0 border-r border-line bg-surface flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-line">
          <span className="text-base font-semibold tracking-tight">寰宇医道</span>
          <span className="ml-2 text-xs text-fg-subtle">管理后台</span>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-accent-soft text-accent-strong font-medium'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                }`
              }
            >
              <span className="w-4 text-center text-base leading-none">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-2 border-t border-line space-y-0.5">
          <button
            onClick={cycleTheme}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-fg-muted hover:bg-surface-2 hover:text-fg transition-colors"
          >
            <span className="w-4 text-center">☀</span>
            {THEME_LABELS[preference]}
          </button>
          <button
            onClick={() => void logout()}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-fg-muted hover:bg-surface-2 hover:text-danger transition-colors"
          >
            <span className="w-4 text-center">⏻</span>
            退出登录
          </button>
        </div>
      </aside>

      {/* 主体区域 */}
      <main className="flex-1 min-w-0 overflow-auto">
        <div className="max-w-[1280px] mx-auto px-6 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
