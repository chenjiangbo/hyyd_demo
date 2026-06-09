/**
 * 管理员登录态。
 * - 挂载时调 /me 探测当前 cookie 是否有效。
 * - 监听 client 派发的 'admin-unauthorized'（任意请求 401）→ 立刻置未登录，弹登录窗。
 */
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { adminApi, UNAUTHORIZED_EVENT } from '../api/client'

type AuthStatus = 'checking' | 'authed' | 'anon'

interface AuthContextValue {
  status: AuthStatus
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('checking')

  // 首次探测
  useEffect(() => {
    let cancelled = false
    adminApi
      .me()
      .then(() => !cancelled && setStatus('authed'))
      .catch(() => !cancelled && setStatus('anon'))
    return () => {
      cancelled = true
    }
  }, [])

  // 任意请求 401 → 置未登录
  useEffect(() => {
    const onUnauth = (): void => setStatus('anon')
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauth)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauth)
  }, [])

  const login = useCallback(async (password: string) => {
    await adminApi.login(password)
    setStatus('authed')
  }, [])

  const logout = useCallback(async () => {
    await adminApi.logout().catch(() => undefined)
    setStatus('anon')
  }, [])

  return <AuthContext.Provider value={{ status, login, logout }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
