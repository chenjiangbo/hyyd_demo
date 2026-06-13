import { type ReactNode } from 'react'
import { initials } from '../lib/orderMapping'
import type { Session } from '../api'

export type NavKey = 'claim' | 'workbench' | 'customers' | 'knowledge' | 'dashboard' | 'debug'

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

        <div className="flex items-center gap-2">
          <button className="p-2 text-text-muted hover:bg-surface-container-low rounded-full transition-colors" title="通知">
            <span className="material-symbols-outlined">notifications</span>
          </button>
          <button className="p-2 text-text-muted hover:bg-surface-container-low rounded-full transition-colors" title="帮助">
            <span className="material-symbols-outlined">help</span>
          </button>
          <button className="p-2 text-text-muted hover:bg-surface-container-low rounded-full transition-colors" title="设置">
            <span className="material-symbols-outlined">settings</span>
          </button>
          <div className="group relative">
            <button className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-body-sm font-semibold">
              {initials(session.displayName)}
            </button>
            <div className="absolute right-0 top-10 hidden group-hover:block bg-white border border-border-subtle rounded-lg shadow-lg py-1 min-w-32 z-50">
              <div className="px-3 py-1.5 text-body-sm text-text-muted border-b border-border-subtle">
                {session.displayName}
              </div>
              <button
                onClick={onLogout}
                className="w-full text-left px-3 py-1.5 text-body-sm text-text-main hover:bg-surface-container-low"
              >
                退出登录
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* 业务内容区 */}
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  )
}
