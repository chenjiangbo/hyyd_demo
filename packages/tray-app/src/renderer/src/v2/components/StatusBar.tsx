import { useEffect, useState } from 'react'
import { fetchPresence, getBackendUrl, type Presence, type Session } from '../api'

/**
 * 底部状态栏：后端 / Chrome 插件(含泰康保活) / 移动端 App 的连接状态。
 * 轮询 /api/v1/me/presence —— 拿得到=后端在线，并带回插件/泰康/移动端状态。
 */
type Dot = 'ok' | 'warn' | 'bad' | 'idle'
const DOT_CLASS: Record<Dot, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  idle: 'bg-slate-400'
}

export default function StatusBar({ session }: { session: Session }): React.JSX.Element {
  const [presence, setPresence] = useState<Presence | null>(null)
  const [backendOk, setBackendOk] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const p = await fetchPresence()
        if (!alive) return
        setPresence(p)
        setBackendOk(true)
      } catch {
        if (!alive) return
        setBackendOk(false)
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  // 后端
  const backend: { dot: Dot; text: string } =
    backendOk === null
      ? { dot: 'idle', text: '后端连接中…' }
      : backendOk
        ? { dot: 'ok', text: '后端已连接' }
        : { dot: 'bad', text: '后端无响应' }

  // Chrome 插件（+ 泰康页 + 保活）
  let ext: { dot: Dot; text: string; title?: string }
  if (!backendOk) {
    ext = { dot: 'idle', text: 'Chrome 插件 —' }
  } else if (!presence?.extConnected) {
    ext = { dot: 'bad', text: 'Chrome 插件未连接' }
  } else if (presence.tokenOk === false) {
    ext = { dot: 'bad', text: '泰康登录失效，请重登', title: presence.tokenReason || '' }
  } else if (!presence.taikangTabOpen) {
    ext = { dot: 'warn', text: 'Chrome 插件在线·未开泰康' }
  } else {
    ext = { dot: 'ok', text: 'Chrome 插件在线' }
  }

  // 移动端 App（心跳 / 近期通话上传）
  const mobileLastSeen = presence?.mobileLastSeenAt
    ? new Date(presence.mobileLastSeenAt).toLocaleTimeString('zh-CN')
    : '无'
  const mobileTitle = `最后联系: ${mobileLastSeen} · 来源: ${presence?.mobileHeartbeatSource ?? '无'}`
  const mobile: { dot: Dot; text: string; title?: string } = !backendOk
    ? { dot: 'idle', text: '移动端 —' }
    : presence?.mobileState === 'active'
      ? { dot: 'ok', text: '移动端活跃', title: mobileTitle }
      : presence?.mobileState === 'background'
        ? { dot: 'warn', text: '移动端后台正常', title: mobileTitle }
        : { dot: 'idle', text: '移动端长时间未联系', title: mobileTitle }

  // 后端 host:port（去掉协议）
  const backendUrl = getBackendUrl()
  const backendHost = backendUrl ? backendUrl.replace(/^https?:\/\//, '') : '未设置'

  return (
    <footer className="shrink-0 h-7 bg-white border-t border-border-subtle px-4 flex items-center justify-between text-text-muted select-none" style={{ fontSize: '12px' }}>
      <div className="flex items-center gap-4">
        <StatusItem dot={backend.dot} text={`${backend.text} · ${backendHost}`} title={backendUrl ?? undefined} />
        <StatusItem dot={ext.dot} text={ext.text} title={ext.title} />
        <StatusItem dot={mobile.dot} text={mobile.text} title={mobile.title} />
      </div>
      <div className="flex items-center gap-3">
        <span>工号 {session.employeeCode}</span>
      </div>
    </footer>
  )
}

function StatusItem({ dot, text, title }: { dot: Dot; text: string; title?: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5" title={title}>
      <span className={`inline-block w-2 h-2 rounded-full ${DOT_CLASS[dot]} ${dot === 'ok' ? 'animate-pulse' : ''}`} />
      {text}
    </span>
  )
}
