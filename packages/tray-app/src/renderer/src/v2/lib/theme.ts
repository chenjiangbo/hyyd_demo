/**
 * 主题（浅/深）+ 切换时的"圆形扩散"动画（View Transitions API）。
 * 选择存 localStorage，启动时 initTheme() 应用。切换从点击点扩散，
 * 不支持 startViewTransition / 用户偏好减弱动效时自动退化为瞬切。
 */
export type Theme = 'light' | 'dark'

const KEY = 'hyyd.v2.theme'

export function getTheme(): Theme {
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement
  root.setAttribute('data-theme', t)
  root.classList.toggle('dark', t === 'dark')
  root.style.colorScheme = t
  localStorage.setItem(KEY, t)
}

/** 启动时调用：把上次选择应用到 <html>。 */
export function initTheme(): void {
  applyTheme(getTheme())
}

/**
 * 切换主题，并以点击点为圆心做圆形揭开动画。
 * @param e 触发点击事件（取 clientX/Y 作圆心）
 * @returns 切换后的主题
 */
export function toggleTheme(e?: { clientX: number; clientY: number }): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark'
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> }
  }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (!doc.startViewTransition || reduce || !e) {
    applyTheme(next)
    return next
  }

  const x = e.clientX
  const y = e.clientY
  const endRadius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))

  // 关键：即便 View Transition 机制抛错/不可用，也必须把主题切过去（否则点了没反应）
  try {
    const transition = doc.startViewTransition(() => applyTheme(next))
    transition.ready
      .then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
          {
            duration: 480,
            easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
            pseudoElement: '::view-transition-new(root)'
          }
        )
      })
      .catch(() => undefined)
  } catch {
    applyTheme(next)
  }
  return next
}
