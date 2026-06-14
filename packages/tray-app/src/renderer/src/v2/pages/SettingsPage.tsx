import { useEffect, useState } from 'react'

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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-surface-bg">
      <div className="mx-auto max-w-3xl p-6">
        <div className="mb-5">
          <h1 className="text-h2-header text-text-main">设置</h1>
          <p className="mt-1 text-body-sm text-text-muted">调整客户端窗口和采集相关行为。</p>
        </div>

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
