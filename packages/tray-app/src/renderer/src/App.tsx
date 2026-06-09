import { useEffect, useState } from 'react'
import TopNav from './components/TopNav'
import { type ViewKey } from './components/Sidebar'
import StatusBar from './components/StatusBar'
import PresenceBanner from './components/PresenceBanner'
import IntakeView from './pages/IntakeView'
import MyWorkbenchView from './pages/MyWorkbenchView'
import CallsView from './pages/CallsView'
import MessagesView from './pages/MessagesView'
import CaptureDebugView from './pages/CaptureDebugView'
import CaptureVerifyView from './pages/CaptureVerifyView'
import CaptureAiView from './pages/CaptureAiView'
import SettingsView from './pages/SettingsView'
import { api, getClientConfig, type Presence } from './api/client'

function App(): React.JSX.Element {
  // 默认进"我的工作台"。intake/messages/capture-* 路由仍可用，
  // 但不再从 TopNav 暴露入口（现场采集版精简）。
  const [view, setView] = useState<ViewKey>('mine')
  const [backendOk, setBackendOk] = useState<boolean | null>(null)
  const [presence, setPresence] = useState<Presence | null>(null)

  // 把当前 client 配置（backendUrl + employeeCode）推给 main 进程，
  // material-sync worker 用它发请求。每 3s 检查一次（员工在设置里改了就跟）。
  useEffect(() => {
    const push = (): void => {
      const cfg = getClientConfig()
      void window.api?.materialsSetConfig?.(cfg)
    }
    push()
    const t = setInterval(push, 3000)
    return () => clearInterval(t)
  }, [])

  // 后端健康 + presence 轮询
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        await api.health()
        if (!cancelled) setBackendOk(true)
      } catch {
        if (!cancelled) {
          setBackendOk(false)
          setPresence(null)
        }
        return
      }
      try {
        const p = await api.getPresence()
        if (!cancelled) setPresence(p)
      } catch {
        // 忽略，下次再试
      }
    }
    tick()
    const t = setInterval(tick, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  return (
    <div className="flex flex-col h-full bg-bg text-fg">
      <TopNav current={view} onChange={setView} />
      <PresenceBanner presence={presence} backendOk={backendOk} />
      <main className="flex-1 overflow-auto">
        {view === 'intake' && <IntakeView />}
        {view === 'mine' && <MyWorkbenchView />}
        {view === 'calls' && <CallsView />}
        {view === 'messages' && <MessagesView />}
        {view === 'capture-debug' && <CaptureDebugView />}
        {view === 'capture-verify' && <CaptureVerifyView />}
        {view === 'capture-ai' && <CaptureAiView />}
        {view === 'settings' && <SettingsView />}
      </main>
      <StatusBar backendOk={backendOk} presence={presence} />
    </div>
  )
}

export default App
