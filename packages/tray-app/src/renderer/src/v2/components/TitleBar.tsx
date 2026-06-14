import { useEffect, useState } from 'react'

// preload 暴露的窗口控制 API（仅 Electron 下存在）
interface WindowApi {
  minimizeWindow?: () => void
  hideWindow?: () => void
  requestWindowClose?: () => Promise<void>
  maximizeToggle?: () => void
  isMaximized?: () => Promise<boolean>
  onMaximizedChanged?: (cb: (m: boolean) => void) => () => void
}

function getWindowApi(): WindowApi | null {
  const api = (window as unknown as { api?: WindowApi }).api
  return api ?? null
}

/**
 * 自绘标题栏：替代 Windows 原生标题栏。
 * - 整条可拖动窗口（app-drag），按钮区排除（app-no-drag）
 * - 右侧三键：macOS 风格交通灯；最小化 / 最大化·还原 / 关闭（关闭行为由设置控制）
 * - 浏览器预览（无 window.api）下不渲染，避免占位
 */
export default function TitleBar(): React.JSX.Element | null {
  const api = getWindowApi()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!api) return
    void api.isMaximized?.().then(setMaximized)
    return api.onMaximizedChanged?.(setMaximized)
  }, [api])

  // 非 Electron 环境（浏览器预览）不显示自绘标题栏
  if (!api) return null

  return (
    <div className="app-drag flex items-center justify-between h-9 shrink-0 select-none bg-surface border-b border-border-subtle">
      {/* 左：品牌标识（双击最大化/还原，沿用原生标题栏习惯） */}
      <div
        onDoubleClick={() => api.maximizeToggle?.()}
        className="flex-1 flex items-center gap-2 pl-3 text-text-main h-full"
      >
        <span className="material-symbols-outlined filled text-lg text-trust-blue">health_and_safety</span>
        <span className="text-body-sm font-medium">智能寰宇 · 采集工作台</span>
      </div>

      {/* 右：macOS 风格窗口按钮 */}
      <div className="app-no-drag group/window-controls flex items-center gap-2 h-full px-3">
        <button
          onClick={() => api.minimizeWindow?.()}
          title="最小化"
          className="relative size-3.5 rounded-full bg-[#ffbd2e] border border-[#dfa123] shadow-sm transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[#ffbd2e]/35"
        >
          <span className="absolute left-1/2 top-1/2 h-0.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#7a5a12] opacity-0 transition-opacity group-hover/window-controls:opacity-80" />
        </button>
        <button
          onClick={() => api.maximizeToggle?.()}
          title={maximized ? '还原' : '最大化'}
          className="relative size-3.5 rounded-full bg-[#28c840] border border-[#1faa35] shadow-sm transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[#28c840]/30"
        >
          <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-[1px] border border-[#0f6d22] opacity-0 transition-opacity group-hover/window-controls:opacity-75" />
        </button>
        <button
          onClick={() => { void api.requestWindowClose?.() }}
          title="关闭"
          className="relative size-3.5 rounded-full bg-[#ff5f57] border border-[#e0443e] shadow-sm transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[#ff5f57]/35"
        >
          <span className="absolute left-1/2 top-1/2 h-1.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-[#7f1714] opacity-0 transition-opacity group-hover/window-controls:opacity-75" />
          <span className="absolute left-1/2 top-1/2 h-1.5 w-0.5 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-[#7f1714] opacity-0 transition-opacity group-hover/window-controls:opacity-75" />
        </button>
      </div>
    </div>
  )
}
