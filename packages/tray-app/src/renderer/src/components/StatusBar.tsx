import { BACKEND_URL, EMPLOYEE_ID } from '../api/client'

interface Props {
  backendOk: boolean | null
}

export default function StatusBar({ backendOk }: Props): React.JSX.Element {
  const dot =
    backendOk === null
      ? 'bg-slate-400'
      : backendOk
        ? 'bg-emerald-500'
        : 'bg-red-500'
  const text =
    backendOk === null ? '连接中…' : backendOk ? '后端已连接' : '后端无响应'

  return (
    <footer className="border-t border-slate-200 bg-white px-5 py-2 flex items-center justify-between text-xs text-slate-600">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
        <span>{text}</span>
        <span className="text-slate-400">· {BACKEND_URL}</span>
      </div>
      <div className="text-slate-400">员工 #{EMPLOYEE_ID}</div>
    </footer>
  )
}
