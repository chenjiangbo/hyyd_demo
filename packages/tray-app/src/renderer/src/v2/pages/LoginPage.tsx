import { useState } from 'react'
import { login, saveSession, type Session } from '../api'
import { loginHeroUrl } from '../assets/loginHero'

export default function LoginPage({
  onLoggedIn
}: {
  onLoggedIn: (s: Session) => void
}): React.JSX.Element {
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [remember, setRemember] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const me = await login(account)
      const session = { employeeCode: me.employeeCode, displayName: me.displayName }
      if (remember) saveSession(session)
      onLoggedIn(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-surface-bg text-on-surface h-full flex overflow-hidden selection:bg-trust-blue selection:text-white">
      <main className="w-full h-full flex flex-col md:flex-row overflow-hidden bg-surface">
        {/* 左侧品牌区：医院走廊配图（base64 本地内联，不依赖远程资源） */}
        <section className="hidden md:flex md:w-[42%] relative bg-on-primary-fixed items-center justify-center overflow-hidden">
          <img alt="" className="absolute inset-0 w-full h-full object-cover" src={loginHeroUrl} />
          {/* 底部压暗渐变，保证白字可读 */}
          <div className="absolute inset-0 bg-gradient-to-t from-on-primary-fixed/95 via-on-primary-fixed/30 to-transparent" />
          <div className="relative z-10 p-8 flex flex-col justify-end h-full w-full text-white">
            <div className="mb-auto mt-6 flex items-center gap-3">
              <span className="material-symbols-outlined filled text-3xl">health_and_safety</span>
              <span className="text-h2-header tracking-tight">智能寰宇</span>
            </div>
            <div className="space-y-3 max-w-sm">
              <h1 className="text-h1-display text-white">智能寰宇 · 医疗服务工作台</h1>
              <p className="text-body-lg text-primary-fixed opacity-90">
                以精准与 AI 驱动的服务调度，为医患协调提供顺畅高效的全程支持。
              </p>
            </div>
            <div className="mt-8 flex items-center gap-3 text-primary-fixed text-body-sm">
              <span className="material-symbols-outlined text-base">verified</span>
              <span>服务于医疗服务专员团队</span>
            </div>
          </div>
        </section>

        {/* 右侧登录表单 */}
        <section className="w-full md:w-[58%] flex flex-col bg-surface px-7 py-6 md:px-10 md:py-8 justify-between h-full relative z-10 overflow-hidden">
          {/* 移动端 Logo */}
          <div className="md:hidden flex items-center gap-2 mb-8 text-trust-blue">
            <span className="material-symbols-outlined filled text-3xl">health_and_safety</span>
            <span className="text-h2-header">智能寰宇</span>
          </div>

          <div className="w-full max-w-sm mx-auto my-auto space-y-5">
            <div className="space-y-1.5">
              <h2 className="text-h1-display text-text-main">欢迎回来</h2>
              <p className="text-body-md text-text-muted">登录智能寰宇工作台，继续您的医患协调工作。</p>
            </div>

            <form className="space-y-4" onSubmit={handleSubmit}>
              {/* 工号 */}
              <div className="space-y-1">
                <label className="block text-label-caps text-text-muted uppercase" htmlFor="account">
                  工作账号（工号）
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <span className="material-symbols-outlined text-outline">person</span>
                  </div>
                  <input
                    id="account"
                    type="text"
                    autoFocus
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    placeholder="如 w001"
                    className="block w-full pl-10 pr-3 py-2.5 border border-outline-variant rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-trust-blue focus:border-transparent text-body-md text-text-main transition-colors duration-200"
                  />
                </div>
              </div>

              {/* 密码（当前后端无密码体系，暂不校验） */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="block text-label-caps text-text-muted uppercase" htmlFor="password">
                    密码
                  </label>
                  <span className="text-body-sm text-text-muted/70">暂未启用</span>
                </div>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <span className="material-symbols-outlined text-outline">lock</span>
                  </div>
                  <input
                    id="password"
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="block w-full pl-10 pr-10 py-2.5 border border-outline-variant rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-trust-blue focus:border-transparent text-body-md text-text-main transition-colors duration-200"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd((v) => !v)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-outline hover:text-text-main focus:outline-none"
                  >
                    <span className="material-symbols-outlined">
                      {showPwd ? 'visibility_off' : 'visibility'}
                    </span>
                  </button>
                </div>
              </div>

              {/* 记住登录 */}
              <div className="flex items-center">
                <input
                  id="remember-me"
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 accent-trust-blue border-outline-variant rounded cursor-pointer"
                />
                <label htmlFor="remember-me" className="ml-2 block text-body-sm text-text-main cursor-pointer">
                  保持登录状态
                </label>
              </div>

              <div className="min-h-9">
                {error && (
                  <div className="flex items-center gap-2 text-body-sm text-error bg-error/5 border border-error/20 rounded-lg px-3 py-1.5">
                    <span className="material-symbols-outlined text-base">error</span>
                    {error}
                  </div>
                )}
              </div>

              {/* 主按钮 */}
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center items-center gap-2 py-2.5 px-4 rounded-lg shadow-sm text-h3-title text-white bg-trust-blue hover:bg-primary focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-trust-blue transition-all duration-200 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {loading && (
                  <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
                )}
                {loading ? '登录中…' : '登 录'}
              </button>

              {/* SSO（未接入） */}
              <div className="relative mt-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border-subtle" />
                </div>
                <div className="relative flex justify-center">
                  <span className="px-2 bg-surface text-body-sm text-text-muted">或</span>
                </div>
              </div>
              <button
                type="button"
                disabled
                title="暂未接入"
                className="w-full flex justify-center items-center gap-2 py-2.5 px-4 border border-outline-variant rounded-lg text-body-md text-text-muted bg-surface opacity-60 cursor-not-allowed"
              >
                <span className="material-symbols-outlined">corporate_fare</span>
                企业微信 SSO 登录（暂未接入）
              </button>
            </form>
          </div>

          {/* 页脚 */}
          <div className="mt-5 pt-4 border-t border-border-subtle text-center">
            <p className="text-body-sm text-text-muted">© 2026 寰宇医道. 保留所有权利.</p>
            <div className="mt-2 space-x-4">
              <a className="text-body-sm text-text-muted hover:text-text-main transition-colors" href="#">隐私政策</a>
              <span className="text-border-subtle">|</span>
              <a className="text-body-sm text-text-muted hover:text-text-main transition-colors" href="#">服务条款</a>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
