import { useEffect, useState } from 'react'
import { getBackendUrl, setBackendUrl } from '../api'

type CloseBehavior = 'ask' | 'minimize' | 'quit'

interface WindowApi {
  getWindowPreferences?: () => Promise<{ closeBehavior: CloseBehavior }>
  setWindowPreferences?: (prefs: { closeBehavior: CloseBehavior }) => Promise<{ closeBehavior: CloseBehavior }>
}

const OPTIONS: Array<{
  value: CloseBehavior
  title: string
  description: string
  icon: string
}> = [
  {
    value: 'ask',
    title: '每次询问',
    description: '点击关闭时提示退出应用或最小化到托盘。',
    icon: 'help'
  },
  {
    value: 'minimize',
    title: '最小化到托盘',
    description: '关闭窗口后应用继续运行，采集功能不中断。',
    icon: 'keyboard_arrow_down'
  },
  {
    value: 'quit',
    title: '退出应用',
    description: '关闭窗口时结束客户端和后台采集进程。',
    icon: 'power_settings_new'
  }
]

function getWindowApi(): WindowApi | null {
  return (window as unknown as { api?: WindowApi }).api ?? null
}

export default function SettingsPage(): React.JSX.Element {
  const api = getWindowApi()
  const [backendUrl, setBackendUrlInput] = useState(getBackendUrl() ?? '')
  const [backendSaved, setBackendSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null)
  const [testMsg, setTestMsg] = useState('')
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('ask')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<CloseBehavior | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!api?.getWindowPreferences) {
      setLoading(false)
      return
    }
    api.getWindowPreferences()
      .then((prefs) => {
        if (!alive) return
        setCloseBehavior(prefs.closeBehavior)
        setError(null)
      })
      .catch((e) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : '读取窗口设置失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [api])

  function save(value: CloseBehavior): void {
    if (!api?.setWindowPreferences) return
    setSaving(value)
    api.setWindowPreferences({ closeBehavior: value })
      .then((prefs) => {
        setCloseBehavior(prefs.closeBehavior)
        setError(null)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '保存窗口设置失败')
      })
      .finally(() => setSaving(null))
  }

  async function testBackend(): Promise<void> {
    const url = backendUrl.trim().replace(/\/+$/, '')
    if (!url) {
      setTestResult('fail')
      setTestMsg('请先填写服务器地址')
      return
    }
    setTesting(true)
    setTestResult(null)
    setTestMsg('')
    try {
      const ctrl = new AbortController()
      const timer = window.setTimeout(() => ctrl.abort(), 5000)
      const res = await fetch(`${url}/health`, { signal: ctrl.signal })
      window.clearTimeout(timer)
      if (res.ok) {
        setTestResult('ok')
        setTestMsg('连接正常')
      } else {
        setTestResult('fail')
        setTestMsg(`服务器有响应但返回 ${res.status}`)
      }
    } catch {
      setTestResult('fail')
      setTestMsg('连不上：请检查地址是否正确、服务器是否已启动、两台机器是否在同一网络')
    } finally {
      setTesting(false)
    }
  }

  function saveBackendUrl(e: React.FormEvent): void {
    e.preventDefault()
    try {
      const normalized = setBackendUrl(backendUrl)
      setBackendUrlInput(normalized)
      setBackendSaved(true)
      setError(null)
      window.setTimeout(() => setBackendSaved(false), 1800)
    } catch (err) {
      setBackendSaved(false)
      setError(err instanceof Error ? err.message : '保存后端地址失败')
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-surface-bg">
      <div className="mx-auto max-w-3xl p-6">
        <div className="mb-5">
          <h1 className="text-h2-header text-text-main">设置</h1>
          <p className="mt-1 text-body-sm text-text-muted">调整客户端窗口和采集相关行为。</p>
        </div>

        <section className="mb-4 rounded-lg border border-border-subtle bg-white">
          <div className="border-b border-border-subtle px-4 py-3">
            <h2 className="text-h3-title text-text-main">后端连接</h2>
          </div>

          <form className="p-4" onSubmit={saveBackendUrl}>
            <label className="block text-label-caps text-text-muted uppercase" htmlFor="backendUrl">
              后端地址
            </label>
            <div className="mt-1 flex gap-2">
              <div className="relative min-w-0 flex-1">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-outline" style={{ fontSize: '19px' }}>dns</span>
                </div>
                <input
                  id="backendUrl"
                  type="text"
                  value={backendUrl}
                  onChange={(e) => setBackendUrlInput(e.target.value)}
                  placeholder="http://192.168.x.x:13000"
                  className="block w-full pl-10 pr-3 py-2.5 border border-outline-variant rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-trust-blue focus:border-transparent text-body-md text-text-main transition-colors duration-200"
                />
              </div>
              <button
                type="button"
                onClick={testBackend}
                disabled={testing}
                className="shrink-0 rounded-lg border border-outline-variant bg-surface px-4 py-2 text-body-md font-medium text-text-main hover:bg-surface-container-low transition-colors disabled:opacity-50"
              >
                {testing ? '测试中…' : '测试'}
              </button>
              <button
                type="submit"
                className="shrink-0 rounded-lg bg-primary px-4 py-2 text-body-md font-semibold text-white hover:bg-trust-blue transition-colors"
              >
                保存
              </button>
            </div>
            <p className="mt-2 text-body-sm text-text-muted">
              数据服务器地址。修改后建议先点「测试」确认能连通，再保存。
            </p>
            {testResult && (
              <div
                className={
                  'mt-2 flex items-center gap-1.5 text-body-sm ' +
                  (testResult === 'ok' ? 'text-success' : 'text-error')
                }
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                  {testResult === 'ok' ? 'check_circle' : 'error'}
                </span>
                {testMsg}
              </div>
            )}
            {backendSaved && (
              <div className="mt-2 flex items-center gap-1.5 text-body-sm text-success">
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>check_circle</span>
                已保存，采集上传和页面请求会使用新地址。
              </div>
            )}
          </form>
        </section>

        <section className="rounded-lg border border-border-subtle bg-white">
          <div className="border-b border-border-subtle px-4 py-3">
            <h2 className="text-h3-title text-text-main">关闭窗口行为</h2>
          </div>

          <div className="p-4 space-y-3">
            {loading ? (
              <div className="flex items-center gap-2 text-body-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin" style={{ fontSize: '18px' }}>progress_activity</span>
                正在读取设置…
              </div>
            ) : (
              OPTIONS.map((option) => {
                const selected = option.value === closeBehavior
                const pending = saving === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => save(option.value)}
                    className={
                      'w-full rounded-lg border px-3 py-3 text-left transition-colors flex items-start gap-3 ' +
                      (selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border-subtle bg-surface-bg hover:bg-surface-container-low')
                    }
                  >
                    <span className={'material-symbols-outlined mt-0.5 ' + (selected ? 'text-primary' : 'text-text-muted')} style={{ fontSize: '20px' }}>
                      {option.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-body-md font-semibold text-text-main">{option.title}</span>
                      <span className="mt-0.5 block text-body-sm text-text-muted">{option.description}</span>
                    </span>
                    <span className="shrink-0 h-5 w-5 rounded-full border border-border-subtle flex items-center justify-center bg-white">
                      {pending ? (
                        <span className="material-symbols-outlined animate-spin text-text-muted" style={{ fontSize: '14px' }}>progress_activity</span>
                      ) : selected ? (
                        <span className="material-symbols-outlined text-primary" style={{ fontSize: '15px' }}>check</span>
                      ) : null}
                    </span>
                  </button>
                )
              })
            )}

            {error && (
              <div className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">
                {error}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
