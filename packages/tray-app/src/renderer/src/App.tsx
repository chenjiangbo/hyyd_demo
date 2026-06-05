import { useEffect, useState } from 'react'
import Sidebar, { type ViewKey } from './components/Sidebar'
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
import { api, type Presence } from './api/client'

function App(): React.JSX.Element {
  const [view, setView] = useState<ViewKey>('intake')
  const [backendOk, setBackendOk] = useState<boolean | null>(null)
  const [presence, setPresence] = useState<Presence | null>(null)

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
    <div className="flex h-full">
      <Sidebar current={view} onChange={setView} />
      <main className="flex-1 flex flex-col overflow-hidden">
        <PresenceBanner presence={presence} backendOk={backendOk} />
        <div className="flex-1 overflow-auto">
          {view === 'intake' && <IntakeView />}
          {view === 'mine' && <MyWorkbenchView />}
          {view === 'calls' && <CallsView />}
          {view === 'messages' && <MessagesView />}
          {view === 'capture-debug' && <CaptureDebugView />}
          {view === 'capture-verify' && <CaptureVerifyView />}
          {view === 'capture-ai' && <CaptureAiView />}
          {view === 'settings' && <SettingsView />}
        </div>
        <StatusBar backendOk={backendOk} presence={presence} />
      </main>
    </div>
  )
}

export default App
