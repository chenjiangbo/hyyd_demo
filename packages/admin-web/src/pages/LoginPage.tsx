import { useState, type FormEvent } from 'react'
import { useAuth } from '../hooks/useAuth'

export default function LoginPage(): React.JSX.Element {
  const { login } = useAuth()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!password) return
    setLoading(true)
    setError(null)
    try {
      await login(password)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-xl border border-line bg-surface p-7 shadow-sm"
      >
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">寰宇医道 · 管理后台</h1>
          <p className="mt-1 text-sm text-fg-muted">采集监控 · 仅管理员可见</p>
        </div>

        <label className="block text-sm text-fg-muted mb-1.5">管理员密码</label>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入密码"
          className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />

        {error && <p className="mt-2 text-sm text-danger">{error}</p>}

        <button
          type="submit"
          disabled={loading || !password}
          className="mt-5 w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50 transition-colors"
        >
          {loading ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
