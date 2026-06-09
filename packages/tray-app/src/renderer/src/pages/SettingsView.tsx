import { useState } from 'react'
import { getClientConfig, setClientConfig } from '../api/client'

export default function SettingsView(): React.JSX.Element {
  const [backendUrl, setBackendUrl] = useState(getClientConfig().backendUrl)
  const [employeeCode, setEmployeeCode] = useState(getClientConfig().employeeCode)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedCode = employeeCode.trim()
  const codeInvalid = trimmedCode.length === 0
  const codeHasIllegal = /[\s]/.test(employeeCode) && trimmedCode !== employeeCode
  // 简单规则：英数字 + 横线/下划线，1-32 长度。避免员工写中文/空格导致 SOP 出错
  const codePattern = /^[A-Za-z0-9_-]{1,32}$/
  const codeBadPattern = trimmedCode.length > 0 && !codePattern.test(trimmedCode)

  const save = (): void => {
    setError(null)
    if (codeInvalid) {
      setError('员工 ID 必填，不能为空。')
      return
    }
    if (codeBadPattern) {
      setError('员工 ID 只能用英文字母 / 数字 / 横线 / 下划线，长度 1-32。')
      return
    }
    if (!/^https?:\/\//.test(backendUrl)) {
      setError('服务器地址需要 http:// 或 https:// 开头。')
      return
    }
    setClientConfig({ backendUrl, employeeCode: trimmedCode })
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-fg">系统设置</h1>
      <p className="text-sm text-fg-muted mt-1">
        现场采集版需要 <strong>三端（trayapp、Chrome 插件、移动端）员工 ID 完全一致</strong>
        ，否则各端各看各的数据，不通。
      </p>

      <section className="mt-5 bg-surface ring-1 ring-line rounded-md p-5 space-y-4">
        <label className="block">
          <span className="block text-sm font-medium text-fg mb-1">服务器地址</span>
          <input
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
            className="w-full px-3 py-2 bg-bg ring-1 ring-line rounded-md text-sm font-mono text-fg focus:ring-accent outline-none"
            placeholder="http://192.168.x.x:13000"
          />
          <span className="block text-[11px] text-fg-subtle mt-1">
            指向 Mac/服务器上跑 backend 的地址，必须 http(s):// 开头。
          </span>
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-fg mb-1">
            员工 ID <span className="text-danger">*</span>
          </span>
          <input
            value={employeeCode}
            onChange={(e) => setEmployeeCode(e.target.value)}
            className={[
              'w-full px-3 py-2 bg-bg ring-1 rounded-md text-sm font-mono text-fg outline-none',
              codeInvalid || codeBadPattern
                ? 'ring-danger focus:ring-danger'
                : 'ring-line focus:ring-accent'
            ].join(' ')}
            placeholder="w001"
          />
          <span className="block text-[11px] text-fg-subtle mt-1">
            手工填写。必须和 Chrome 插件 popup、移动端里设的员工 ID 完全一致。
            只能用英文字母 / 数字 / 横线 / 下划线。
          </span>
        </label>

        {error && (
          <div className="text-[12px] text-danger bg-red-50 border border-red-200 rounded px-3 py-2">
            ❌ {error}
          </div>
        )}

        {codeHasIllegal && !error && (
          <div className="text-[12px] text-warning">
            ⚠️ 输入里含空格，保存时会自动去掉首尾空格。
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            className="px-4 py-2 text-sm bg-accent text-white hover:bg-accent-strong rounded-md transition-colors"
          >
            保存
          </button>
          {saved && <span className="text-sm text-success">✓ 已保存</span>}
        </div>
      </section>
    </div>
  )
}
