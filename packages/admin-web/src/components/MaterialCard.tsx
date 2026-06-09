import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { MaterialItem } from '../api/types'
import { fmtTime, fmtBytes } from '../lib/format'

// 单条素材展示：文本（300 字截断 + 展开）/ 图片缩略图（点开 lightbox）。
export function MaterialCard({
  m,
  onOpenImage,
  showOrder = true,
  showEmployee = false
}: {
  m: MaterialItem
  onOpenImage?: (url: string) => void
  showOrder?: boolean
  showEmployee?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex gap-3 py-3 border-b border-line last:border-0">
      {/* 类型图标 */}
      <div className="shrink-0 w-7 text-center text-fg-subtle pt-0.5">
        {m.type === 'image' ? '🖼' : '✎'}
      </div>

      <div className="min-w-0 flex-1">
        {/* 元信息行 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-subtle mb-1">
          <span>{fmtTime(m.createdAt)}</span>
          {showEmployee && m.employee && <span>· {m.employee.name}</span>}
          {showOrder && m.order && (
            <Link to={`/orders/${m.order.id}`} className="text-accent-strong hover:underline">
              · {m.order.customerName}
              {m.order.customerPhone ? ` ${m.order.customerPhone}` : ''}（{m.order.sourceOrderNo}）
            </Link>
          )}
        </div>

        {/* 内容 */}
        {m.type === 'image' ? (
          m.imageUrl ? (
            <img
              src={m.imageUrl}
              alt="素材图片"
              onClick={() => onOpenImage?.(m.imageUrl!)}
              className="max-h-40 rounded-md border border-line cursor-zoom-in object-cover"
            />
          ) : (
            <div className="text-xs text-fg-subtle">图片不可用</div>
          )
        ) : (
          <div className="text-sm text-fg whitespace-pre-wrap break-words">
            {expanded || !m.textTruncated ? m.textPreview : `${m.textPreview}…`}
            {m.textTruncated && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="ml-1 text-xs text-accent-strong hover:underline"
              >
                {expanded ? '收起' : '展开全部'}
              </button>
            )}
          </div>
        )}
        {m.type === 'image' && m.byteSize && (
          <div className="text-xs text-fg-subtle mt-0.5">{fmtBytes(m.byteSize)}</div>
        )}
      </div>
    </div>
  )
}
