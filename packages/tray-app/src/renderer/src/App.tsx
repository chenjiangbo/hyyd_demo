import { useEffect, useState } from 'react'
import Sidebar, { type ViewKey } from './components/Sidebar'
import StatusBar from './components/StatusBar'
import IntakeView from './pages/IntakeView'
import MyWorkbenchView from './pages/MyWorkbenchView'
import { api } from './api/client'

function App(): React.JSX.Element {
  const [view, setView] = useState<ViewKey>('intake')
  const [backendOk, setBackendOk] = useState<boolean | null>(null)

  // 启动时 ping 一次后端
  useEffect(() => {
    let cancelled = false
    const check = () =>
      api
        .health()
        .then(() => !cancelled && setBackendOk(true))
        .catch(() => !cancelled && setBackendOk(false))
    check()
    const t = setInterval(check, 15000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  return (
    <div className="flex h-full">
      <Sidebar current={view} onChange={setView} />
      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto">
          {view === 'intake' && <IntakeView />}
          {view === 'mine' && <MyWorkbenchView />}
        </div>
        <StatusBar backendOk={backendOk} />
      </main>
    </div>
  )
}

export default App
