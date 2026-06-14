import { useEffect, useState } from 'react'
import LoginPage from './pages/LoginPage'
import WorkbenchKanban from './pages/WorkbenchKanban'
import OrderDetailPage from './pages/OrderDetailPage'
import SidecarDebugPage from './pages/SidecarDebugPage'
import SettingsPage from './pages/SettingsPage'
import ClaimPage from './pages/ClaimPage'
import KnowledgePage from './pages/KnowledgePage'
import CustomersPage from './pages/CustomersPage'
import AppShell, { type NavKey } from './components/AppShell'
import TitleBar from './components/TitleBar'
import { getBackendUrl, getSession, clearSession, type Session, type Order } from './api'

/**
 * v2 应用根。顶部为自绘标题栏（无 Windows 原生边框），下方是页面内容。
 * 登录后进入带顶部导航的 AppShell；打开订单时切到聚焦式详情页（无顶部导航）。
 */
export default function App(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(getSession())
  const [nav, setNav] = useState<NavKey>('workbench')
  const [openOrder, setOpenOrder] = useState<Order | null>(null)

  useEffect(() => {
    if (!session) return
    const cfg = { backendUrl: getBackendUrl(), employeeCode: session.employeeCode }
    void window.api?.materialsSetConfig?.(cfg)
    void window.api?.captureSetConfig?.(cfg)
  }, [session])

  let content: React.JSX.Element
  if (!session) {
    content = <LoginPage onLoggedIn={setSession} />
  } else if (openOrder) {
    // 详情是聚焦视图，覆盖 AppShell
    content = <OrderDetailPage order={openOrder} onBack={() => setOpenOrder(null)} />
  } else {
    content = (
      <AppShell
        active={nav}
        onNavigate={setNav}
        session={session}
        onLogout={() => {
          clearSession()
          setSession(null)
        }}
      >
        <div className={nav === 'workbench' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <WorkbenchKanban employeeCode={session.employeeCode} onOpenOrder={setOpenOrder} />
        </div>
        {nav === 'claim' && <ClaimPage />}
        {nav === 'customers' && <CustomersPage onOpenOrder={setOpenOrder} />}
        {nav === 'knowledge' && <KnowledgePage />}
        {nav === 'debug' && <SidecarDebugPage />}
        {nav === 'settings' && <SettingsPage />}
        {nav === 'dashboard' && <Placeholder name={navLabel(nav)} />}
      </AppShell>
    )
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TitleBar />
      <div className="flex-1 min-h-0">{content}</div>
    </div>
  )
}

function navLabel(k: NavKey): string {
  return { claim: '待申领', workbench: '工作台', customers: '客户档案', knowledge: '知识库', dashboard: '数据看板', debug: '采集调试', settings: '设置' }[k]
}

function Placeholder({ name }: { name: string }): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
      <span className="material-symbols-outlined text-4xl">construction</span>
      <p className="text-h3-title">{name}</p>
      <p className="text-body-sm">此页面将在后续逐页接入</p>
    </div>
  )
}
