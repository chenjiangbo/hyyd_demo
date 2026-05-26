export type ViewKey = 'intake' | 'mine'

interface Props {
  current: ViewKey
  onChange: (v: ViewKey) => void
}

const items: { key: ViewKey; label: string; icon: string }[] = [
  { key: 'intake', label: '申领台', icon: '📥' },
  { key: 'mine', label: '我的工作台', icon: '🗂️' }
]

export default function Sidebar({ current, onChange }: Props): React.JSX.Element {
  return (
    <aside className="w-56 bg-slate-800 text-slate-100 flex flex-col">
      <div className="px-5 py-5 border-b border-slate-700">
        <div className="text-lg font-semibold">寰宇医道</div>
        <div className="text-xs text-slate-400 mt-1">采集工作台</div>
      </div>
      <nav className="flex-1 py-3">
        {items.map((it) => {
          const active = current === it.key
          return (
            <button
              key={it.key}
              onClick={() => onChange(it.key)}
              className={`w-full text-left px-5 py-3 flex items-center gap-3 text-sm transition ${
                active
                  ? 'bg-slate-700 text-white border-l-4 border-emerald-400'
                  : 'text-slate-300 hover:bg-slate-700/50 border-l-4 border-transparent'
              }`}
            >
              <span className="text-base">{it.icon}</span>
              <span>{it.label}</span>
            </button>
          )
        })}
      </nav>
      <div className="px-5 py-3 text-xs text-slate-500 border-t border-slate-700">
        v0.1.0 · MVP
      </div>
    </aside>
  )
}
