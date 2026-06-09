import { useTheme, type ThemePreference } from '../lib/theme'
import { Card, PageHeader } from '../components/ui'

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

export default function SettingsPage(): React.JSX.Element {
  const { preference, setPreference } = useTheme()

  return (
    <div>
      <PageHeader title="设置" />
      <Card className="p-4 max-w-md">
        <h2 className="text-sm font-medium mb-3">主题</h2>
        <div className="flex gap-2">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPreference(opt.value)}
              className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                preference === opt.value
                  ? 'border-accent bg-accent-soft text-accent-strong font-medium'
                  : 'border-line text-fg-muted hover:bg-surface-2'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Card>
    </div>
  )
}
