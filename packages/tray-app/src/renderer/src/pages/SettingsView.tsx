import { useState } from 'react'
import { getClientConfig, setClientConfig } from '../api/client'

export default function SettingsView(): React.JSX.Element {
  const [backendUrl, setBackendUrl] = useState(getClientConfig().backendUrl)
  const [employeeCode, setEmployeeCode] = useState(getClientConfig().employeeCode)
  const [saved, setSaved] = useState(false)

  const save = () => {
    setClientConfig({ backendUrl, employeeCode })
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-slate-800">系统设置</h1>
      <p className="text-sm text-slate-500 mt-1">
        现场采集版使用手工员工 ID 关联手机、Chrome 插件和 Tray App。
      </p>

      <section className="mt-5 bg-white border border-slate-200 rounded-md p-5 space-y-4">
        <label className="block">
          <span className="block text-sm font-medium text-slate-700 mb-1">服务器地址</span>
          <input
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
            placeholder="https://api.example.com"
          />
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-slate-700 mb-1">员工 ID</span>
          <input
            value={employeeCode}
            onChange={(e) => setEmployeeCode(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
            placeholder="zhangsan"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-md"
          >
            保存
          </button>
          {saved && <span className="text-sm text-emerald-700">已保存</span>}
        </div>
      </section>
    </div>
  )
}
