// 主题系统：system / light / dark 三态切换；偏好持久化到 localStorage。
// 通过给 <html> 加/去 `.dark` 来切换，所有 CSS 变量随之联动。
import { useEffect, useState, useCallback } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'hyyd.theme.preference'

function readPreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system'
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

function resolveEffective(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return pref
}

function applyToDom(effective: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (effective === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
  root.dataset.theme = effective
}

/**
 * 在 main.tsx 中尽早调用一次，避免首屏闪烁。
 */
export function bootstrapTheme(): void {
  applyToDom(resolveEffective(readPreference()))
}

export interface UseThemeResult {
  preference: ThemePreference
  effective: 'light' | 'dark'
  setPreference: (p: ThemePreference) => void
}

export function useTheme(): UseThemeResult {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)
  const [effective, setEffective] = useState<'light' | 'dark'>(() =>
    resolveEffective(readPreference())
  )

  const setPreference = useCallback((p: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, p)
    setPreferenceState(p)
    const eff = resolveEffective(p)
    setEffective(eff)
    applyToDom(eff)
  }, [])

  // 跟随系统时，监听系统切换
  useEffect(() => {
    if (preference !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => {
      const eff = resolveEffective('system')
      setEffective(eff)
      applyToDom(eff)
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [preference])

  return { preference, effective, setPreference }
}
