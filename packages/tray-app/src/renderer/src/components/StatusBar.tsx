import { useEffect, useState } from 'react'
import { getClientConfig, type Presence } from '../api/client'

interface Props {
  backendOk: boolean | null
  presence?: Presence | null
}

export default function StatusBar({ backendOk, presence }: Props): React.JSX.Element {
  const [capture, setCapture] = useState<CaptureSidecarStatus | null>(null)
  const [config, setConfig] = useState(getClientConfig())

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (!window.api?.getCaptureStatus) return
      const status = await window.api.getCaptureStatus()
      if (!cancelled) setCapture(status)
    }
    tick().catch(() => {})
    const timer = setInterval(() => tick().catch(() => {}), 5000)
    const configTimer = setInterval(() => setConfig(getClientConfig()), 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
      clearInterval(configTimer)
    }
  }, [])

  const dot =
    backendOk === null
      ? 'bg-slate-400'
      : backendOk
        ? 'bg-emerald-500'
        : 'bg-red-500'
  const text =
    backendOk === null ? '连接中…' : backendOk ? '后端已连接' : '后端无响应'

  // 插件状态
  const extDot = !presence?.extConnected
    ? 'bg-slate-400'
    : presence.taikangTabOpen
      ? 'bg-emerald-500'
      : 'bg-amber-500'
  const extText = !presence?.extConnected
    ? '插件未连接'
    : presence.taikangTabOpen
      ? `插件在线 (${presence.mode === 'pool_reader' ? 'Reader' : 'Worker'})`
      : '插件在线但未打开泰康'

  // 泰康 token 保活状态
  const tokenOk = presence?.tokenOk
  const tokenDot =
    tokenOk === undefined || tokenOk === null
      ? 'bg-slate-400'
      : tokenOk
        ? 'bg-emerald-500'
        : 'bg-red-500'
  const tokenText =
    tokenOk === undefined || tokenOk === null
      ? '泰康登录: 未检测'
      : tokenOk
        ? `泰康登录: 有效${presence?.tokenLastCheckAt ? ` (${new Date(presence.tokenLastCheckAt).toLocaleTimeString('zh-CN')})` : ''}`
        : `泰康登录: 失效 (${presence?.tokenReason ?? '?'})`

  const captureDot = !capture?.enabled
    ? 'bg-slate-400'
    : capture.mode === 'collecting'
      ? 'bg-emerald-500'
      : capture.mode === 'ready' || capture.mode === 'starting'
        ? 'bg-amber-500'
        : 'bg-red-500'
  const captureText = !capture?.enabled
    ? '微信采集: 未启用'
    : capture.mode === 'collecting'
      ? `微信采集: 采集中 (${capture.capturedFrameCount})`
      : capture.mode === 'ready'
        ? '微信采集: 等待微信/企微'
        : capture.mode === 'starting'
          ? '微信采集: 启动中'
          : `微信采集: 异常${capture.lastError ? ` (${capture.lastError})` : ''}`

  const captureTitle =
    capture?.lastTextPreview ?? capture?.lastError ?? captureText

  return (
    <footer className="border-t border-slate-200 bg-white px-5 py-2 flex items-center justify-between text-xs text-slate-600">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
          {text}
        </span>
        <span className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${extDot}`} />
          {extText}
        </span>
        <span className="flex items-center gap-1.5" title={tokenText}>
          <span className={`inline-block w-2 h-2 rounded-full ${tokenDot}`} />
          {tokenText}
        </span>
        <span className="flex items-center gap-1.5 max-w-[280px] truncate" title={captureTitle}>
          <span className={`inline-block w-2 h-2 rounded-full ${captureDot}`} />
          {captureText}
        </span>
        <span className="text-slate-400">{config.backendUrl}</span>
      </div>
      <div className="text-slate-400">员工 {config.employeeCode}</div>
    </footer>
  )
}
