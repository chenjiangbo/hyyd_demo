import { BACKEND_URL, EMPLOYEE_ID, type Presence } from '../api/client'

interface Props {
  backendOk: boolean | null
  presence?: Presence | null
}

export default function StatusBar({ backendOk, presence }: Props): React.JSX.Element {
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
        <span className="text-slate-400">{BACKEND_URL}</span>
      </div>
      <div className="text-slate-400">员工 #{EMPLOYEE_ID}</div>
    </footer>
  )
}
