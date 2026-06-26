import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { CallItem } from '../api/types'
import { adminApi } from '../api/client'
import { fmtTime, fmtDuration } from '../lib/format'
import { AsrBadge, DirectionLabel } from './badges'

// 单条通话：元信息 + 点开播放录音（按需取 presigned URL）+ 转写预览。
export function CallCard({
  c,
  showOrder = true,
  showEmployee = false
}: {
  c: CallItem
  showOrder?: boolean
  showEmployee?: boolean
}): React.JSX.Element {
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [audioErr, setAudioErr] = useState<string | null>(null)
  const [expandedTranscript, setExpandedTranscript] = useState(false)

  const loadAudio = async (): Promise<void> => {
    setLoadingAudio(true)
    setAudioErr(null)
    try {
      const { url } = await adminApi.callRecordingUrl(c.id)
      setAudioUrl(url)
    } catch (e) {
      setAudioErr(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoadingAudio(false)
    }
  }

  const highlight = c.asrStatus !== 'done' && c.asrStatus !== 'no_recording'
  const applicationOrders = c.applicationOrders ?? []
  const linkedByApplication = applicationOrders.length > 0 || !!c.applicationNo
  // 未关联订单/申请号的通话：左侧红色竖条 + 浅红底，一眼能挑出来
  const unlinked = showOrder && !c.order && !linkedByApplication

  return (
    <div
      className={`py-3 pl-3 border-b border-line last:border-0 ${
        unlinked ? 'border-l-2 border-l-danger bg-danger/5' : highlight ? 'bg-warning/5' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium tabular-nums">{c.phone}</span>
        {c.contactName && <span className="text-fg-muted text-xs">{c.contactName}</span>}
        <DirectionLabel direction={c.direction} />
        <span className="text-xs text-fg-subtle">· {fmtDuration(c.durationSec)}</span>
        <span className="text-xs text-fg-subtle">· {fmtTime(c.startedAt)}</span>
        <AsrBadge status={c.asrStatus} />
        {showEmployee && c.employee && (
          <span className="text-xs text-fg-subtle">· {c.employee.name}</span>
        )}
        {showOrder && c.order && (
          <Link
            to={`/orders/${c.order.id}`}
            className="text-xs text-accent-strong hover:underline"
          >
            · {c.order.customerName}（{c.order.sourceOrderNo}）
          </Link>
        )}
        {showOrder && !c.order && applicationOrders.length > 0 && (
          <>
            <span className="text-xs rounded px-1.5 py-0.5 bg-accent-soft text-accent-strong font-medium">
              关联 {applicationOrders.length} 单
            </span>
            {applicationOrders.map((order) => (
              <Link
                key={order.id}
                to={`/orders/${order.id}`}
                className="text-xs text-accent-strong hover:underline"
              >
                · {order.customerName}（{order.sourceOrderNo}）
              </Link>
            ))}
          </>
        )}
        {showOrder && !c.order && applicationOrders.length === 0 && c.applicationNo && (
          <span className="text-xs rounded px-1.5 py-0.5 bg-accent-soft text-accent-strong font-medium">
            已关联申请号 {c.applicationNo}
          </span>
        )}
        {showOrder && !c.order && !linkedByApplication && (
          <span className="text-xs rounded px-1.5 py-0.5 bg-danger/15 text-danger font-medium">
            未关联订单
          </span>
        )}
      </div>

      {/* 转写预览 */}
      {c.asrTextPreview && (
        <div className="mt-1.5">
          <p className="text-sm text-fg-muted whitespace-pre-wrap break-words">
            {expandedTranscript && c.asrText ? c.asrText : c.asrTextPreview}
          </p>
          {c.asrTextTruncated && (
            <button
              type="button"
              onClick={() => setExpandedTranscript((v) => !v)}
              className="mt-1 text-xs text-accent-strong hover:underline"
            >
              {expandedTranscript ? '收起' : '更多'}
            </button>
          )}
        </div>
      )}

      {/* 录音播放 */}
      {c.hasRecording && (
        <div className="mt-2">
          {audioUrl ? (
            <audio controls src={audioUrl} className="h-8 w-full max-w-md" />
          ) : (
            <button
              onClick={() => void loadAudio()}
              disabled={loadingAudio}
              className="text-xs px-2.5 py-1 rounded-md border border-line text-fg-muted hover:bg-surface-2 disabled:opacity-50"
            >
              {loadingAudio ? '加载录音…' : '▶ 播放录音'}
            </button>
          )}
          {audioErr && <span className="ml-2 text-xs text-danger">{audioErr}</span>}
        </div>
      )}
    </div>
  )
}
