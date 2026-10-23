import ChangePasswordModal from './components/ChangePasswordModal'
import { useEffect, useState } from 'react'
import LoginPage from './pages/LoginPage'
import WorkbenchKanban, { clearOrdersCache, type ApplicationGroup } from './pages/WorkbenchKanban'
import ApplicationDetailPage, { HuanyuOrderCreatePage } from './pages/ApplicationDetailPage'
import OrderDetailPage from './pages/OrderDetailPage'
import SidecarDebugPage from './pages/SidecarDebugPage'
import SettingsPage from './pages/SettingsPage'
import ClaimPage from './pages/ClaimPage'
import KnowledgePage from './pages/KnowledgePage'
import CustomersPage from './pages/CustomersPage'
import DictionaryPage from './pages/DictionaryPage'
import AppShell, { type NavKey } from './components/AppShell'
import TitleBar from './components/TitleBar'
import {
  BACKEND_CONFIG_CHANGED,
  clearSession,
  getBackendUrl,
  getSession,
  type Order,
  type Session
} from './api'

/**
 * v2 应用根。顶部为自绘标题栏（无 Windows 原生边框），下方是页面内容。
 * 登录后进入带顶部导航的 AppShell；打开订单时切到聚焦式详情页（无顶部导航）。
 */
export default function App(): React.JSX.Element {
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [session, setSession] = useState<Session | null>(() => {
    if (!getBackendUrl()) {
      clearSession()
      return null
    }
    return getSession()
  })
  const [nav, setNav] = useState<NavKey>('workbench')
  const [openOrder, setOpenOrder] = useState<Order | null>(null)
  const [openApplication, setOpenApplication] = useState<{ group: ApplicationGroup; selectedOrderId?: number } | null>(null)
  const [openHuanyuCreate, setOpenHuanyuCreate] = useState(false)
  const [orderNotice, setOrderNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  // 顶部导航全局搜索（驱动工作台过滤）
  const [search, setSearch] = useState('')
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false)
  const [advancedFilterCount, setAdvancedFilterCount] = useState(0)

  // 登录态用小窗，登录后放大到工作台尺寸
  useEffect(() => {
    window.api?.setWindowStage?.(session ? 'main' : 'login')
    if (session) window.api?.hideWindow?.()
    else window.api?.showWindow?.()
  }, [session])

  useEffect(() => {
    if (!session) return
    const pushConfig = (): void => {
      const backendUrl = getBackendUrl()
      if (!backendUrl) {
        clearSession()
        setSession(null)
        return
      }
      const cfg = { backendUrl, employeeCode: session.employeeCode }
      void window.api?.materialsSetConfig?.(cfg)
      void window.api?.captureSetConfig?.(cfg)
    }
    pushConfig()
    window.addEventListener(BACKEND_CONFIG_CHANGED, pushConfig)
    return () => window.removeEventListener(BACKEND_CONFIG_CHANGED, pushConfig)
  }, [session])

  useEffect(() => {
    if (!orderNotice) return
    const timer = window.setTimeout(() => setOrderNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [orderNotice])

  useEffect(() => {
    const handleOrderNotice = (event: Event): void => {
      const detail = (event as CustomEvent<{ type?: 'success' | 'error'; message?: string }>).detail
      if (!detail?.message || (detail.type !== 'success' && detail.type !== 'error')) return
      setOrderNotice({ type: detail.type, message: detail.message })
    }
    window.addEventListener('huanyu-order-notice', handleOrderNotice)
    return () => window.removeEventListener('huanyu-order-notice', handleOrderNotice)
  }, [])

  // 监听来自桌面右下角提醒浮窗 / 内部提醒组件的"打开订单"点击
  useEffect(() => {
    const handleNavigate = (orderNo: string): void => {
      setOpenOrder(null)
      setOpenApplication(null)
      setOpenHuanyuCreate(false)
      setNav('workbench')
      setSearch(orderNo)
    }

    const cleanup = window.api?.onNavigateOrder?.((orderNo) => {
      handleNavigate(orderNo)
    })

    const handleWebNavigate = (e: Event): void => {
      const customEvent = e as CustomEvent<{ orderNo: string }>
      if (customEvent.detail?.orderNo) {
        handleNavigate(customEvent.detail.orderNo)
      }
    }
    window.addEventListener('huanyu-navigate-order', handleWebNavigate)

    return () => {
      cleanup?.()
      window.removeEventListener('huanyu-navigate-order', handleWebNavigate)
    }
  }, [])

  let content: React.JSX.Element
  if (!session) {
    content = <LoginPage onLoggedIn={setSession} />
  } else if (openOrder) {
    // 详情是聚焦视图，覆盖 AppShell
    content = <OrderDetailPage order={openOrder} onBack={() => setOpenOrder(null)} />
  } else if (openApplication) {
    content = (
      <ApplicationDetailPage
        group={openApplication.group}
        initialOrderId={openApplication.selectedOrderId}
        onBack={() => {
          setOpenApplication(null)
          clearOrdersCache()
          window.dispatchEvent(new CustomEvent('huanyu-orders-updated'))
        }}
      />
    )
  } else if (openHuanyuCreate) {
    content = <HuanyuOrderCreatePage
      onBack={() => setOpenHuanyuCreate(false)}
      onCreated={() => {
        clearOrdersCache()
        window.dispatchEvent(new CustomEvent('huanyu-orders-updated'))
        setOpenHuanyuCreate(false)
      }}
    />
  } else {
    content = (
      <AppShell
        active={nav}
        onNavigate={setNav}
        session={session}
        search={search}
        onSearch={setSearch}
        onToggleAdvancedSearch={() => setShowAdvancedSearch((v) => !v)}
        isAdvancedSearchOpen={showAdvancedSearch}
        activeFilterCount={advancedFilterCount}
        onLogout={() => {
          clearSession()
          setSession(null)
        }}
        onChangePassword={() => setShowPasswordModal(true)}
      >
        <div className={nav === 'workbench' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <WorkbenchKanban
            employeeCode={session.employeeCode}
            query={search}
            showAdvancedSearch={showAdvancedSearch}
            onToggleAdvancedSearch={setShowAdvancedSearch}
            onAdvancedFilterCountChange={setAdvancedFilterCount}
            onOpenApplication={(group, selectedOrderId) => setOpenApplication({ group, selectedOrderId })}
            onCreateHuanyuOrder={() => setOpenHuanyuCreate(true)}
          />
        </div>
        {nav === 'claim' && <ClaimPage />}
        {nav === 'customers' && <CustomersPage onOpenOrder={setOpenOrder} />}
        {nav === 'dictionary' && <DictionaryPage />}
        {nav === 'knowledge' && <KnowledgePage />}
        {nav === 'debug' && <SidecarDebugPage />}
        {nav === 'settings' && <SettingsPage />}
        {nav === 'dashboard' && <Placeholder name={navLabel(nav)} />}
        <ChangePasswordModal
        isOpen={showPasswordModal}
        onClose={() => setShowPasswordModal(false)}
        onSuccessLogout={() => {
          clearSession()
          setSession(null)
        }}
      />
    </AppShell>
    )
  }

  return (
    <div className="relative flex flex-col h-screen overflow-hidden">
      <TitleBar />
      <div className="flex-1 min-h-0">{content}</div>
      {orderNotice && (
        <div role="status" className={`absolute right-5 top-14 z-[100] max-w-[min(560px,calc(100vw-40px))] rounded-md border px-4 py-3 text-body-sm shadow-lg ${
          orderNotice.type === 'success'
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-red-200 bg-red-50 text-red-800'
        }`}>
          {orderNotice.message}
        </div>
      )}
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
