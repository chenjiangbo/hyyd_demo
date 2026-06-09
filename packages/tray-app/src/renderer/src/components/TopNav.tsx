// 顶部导航栏：左 logo · 中 tab 列表 · 右 主题切换 + 设置入口。
// Claude 风格的极简、低噪音、暖色基调；选中态为白底+细边框"凸起感"。
import { type ViewKey } from './Sidebar'
import { useTheme, type ThemePreference } from '../lib/theme'

interface Props {
  current: ViewKey
  onChange: (v: ViewKey) => void
}

interface TabDef {
  key: ViewKey
  label: string
}

// 主 tab：现场采集版只暴露"工作台 + 通话记录"。
// 其他历史页面（intake/messages/capture-*）代码与路由保留，但不挂在导航上。
// 设置在右侧齿轮入口。
const TABS: TabDef[] = [
  { key: 'mine', label: '我的工作台' },
  { key: 'calls', label: '通话记录' }
]

export default function TopNav({ current, onChange }: Props): React.JSX.Element {
  const { preference, setPreference } = useTheme()

  return (
    <header className="h-12 shrink-0 flex items-center gap-3 px-3 border-b border-line bg-surface">
      {/* 左：logo */}
      <button
        type="button"
        onClick={() => onChange('mine')}
        className="flex items-center gap-2 pl-1 pr-2 h-8 rounded hover:bg-surface-2 transition-colors"
        title="寰宇医道 · 采集工作台"
      >
        <span
          className="w-5 h-5 rounded-md bg-accent flex items-center justify-center text-[10px] font-bold text-white"
          aria-hidden
        >
          寰
        </span>
        <span className="text-sm font-semibold text-fg">寰宇医道</span>
      </button>

      <div className="w-px h-5 bg-line" />

      {/* 中：tab 列表（占满剩余宽度，超出可横向滚动） */}
      <nav className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-1">
          {TABS.map((t) => {
            const active = current === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => onChange(t.key)}
                className={[
                  'h-8 px-3 text-[13px] rounded transition-all whitespace-nowrap',
                  active
                    ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-line'
                    : 'text-fg-muted hover:text-fg hover:bg-surface-2'
                ].join(' ')}
              >
                {t.label}
              </button>
            )
          })}
        </div>
      </nav>

      {/* 右：主题三段控件 + 设置 */}
      <ThemeSwitch value={preference} onChange={setPreference} />

      <button
        type="button"
        onClick={() => onChange('settings')}
        className={[
          'w-8 h-8 flex items-center justify-center rounded transition-colors',
          current === 'settings'
            ? 'bg-surface-2 text-fg ring-1 ring-line'
            : 'text-fg-muted hover:text-fg hover:bg-surface-2'
        ].join(' ')}
        title="系统设置"
        aria-label="系统设置"
      >
        <GearIcon />
      </button>
    </header>
  )
}

// ───── 主题三段切换：跟随系统 / 浅色 / 深色 ─────
function ThemeSwitch({
  value,
  onChange
}: {
  value: ThemePreference
  onChange: (v: ThemePreference) => void
}): React.JSX.Element {
  const items: { key: ThemePreference; icon: React.JSX.Element; title: string }[] = [
    { key: 'system', icon: <MonitorIcon />, title: '跟随系统' },
    { key: 'light', icon: <SunIcon />, title: '浅色' },
    { key: 'dark', icon: <MoonIcon />, title: '深色' }
  ]
  return (
    <div className="h-8 flex items-center bg-surface-2 rounded p-0.5 gap-0.5">
      {items.map((it) => {
        const active = value === it.key
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            title={it.title}
            aria-label={it.title}
            aria-pressed={active}
            className={[
              'w-7 h-7 flex items-center justify-center rounded transition-colors',
              active
                ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                : 'text-fg-muted hover:text-fg'
            ].join(' ')}
          >
            {it.icon}
          </button>
        )
      })}
    </div>
  )
}

// ───── 图标（轻量 inline SVG，避免引第三方包） ─────
function MonitorIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}
function SunIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
      <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
      <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
    </svg>
  )
}
function MoonIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}
function GearIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
