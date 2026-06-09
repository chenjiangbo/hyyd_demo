import { useEffect, useState, useCallback } from 'react'

// 全屏图片预览：滚轮缩放，Esc / 点遮罩关闭。
export function Lightbox({
  src,
  onClose
}: {
  src: string | null
  onClose: () => void
}): React.JSX.Element | null {
  const [scale, setScale] = useState(1)

  // 每次打开新图复位缩放
  useEffect(() => {
    setScale(1)
  }, [src])

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    if (!src) return
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src, onKey])

  if (!src) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
      onWheel={(e) => {
        setScale((s) => Math.min(Math.max(s + (e.deltaY < 0 ? 0.15 : -0.15), 0.3), 6))
      }}
    >
      <img
        src={src}
        alt="预览"
        onClick={(e) => e.stopPropagation()}
        style={{ transform: `scale(${scale})` }}
        className="max-h-full max-w-full object-contain transition-transform duration-75 select-none"
        draggable={false}
      />
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white text-2xl leading-none"
        aria-label="关闭"
      >
        ✕
      </button>
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/60">
        滚轮缩放 · Esc 关闭 · {Math.round(scale * 100)}%
      </div>
    </div>
  )
}
