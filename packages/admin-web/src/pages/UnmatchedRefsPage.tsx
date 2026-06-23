import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { adminApi } from '../api/client'
import { Card, PageHeader, LoadingBlock, ErrorBlock, EmptyBlock } from '../components/ui'
import { Lightbox } from '../components/Lightbox'
import { fmtTimeFull, fmtRelative } from '../lib/format'

const REASON_LABEL: Record<string, string> = {
  no_match: '匹配不到订单',
  ambiguous: '并列多单',
  name_mismatch: '姓名对不上'
}
const REASON_TONE: Record<string, string> = {
  no_match: 'bg-danger/10 text-danger',
  ambiguous: 'bg-warning/10 text-warning',
  name_mismatch: 'bg-warning/10 text-warning'
}

const KIND_LABEL: Record<string, string> = {
  fwyy: '服务预约号',
  cod: '订单号',
  ccod: '重疾绿通号',
  od: '订单号',
  unknown: '未知格式'
}

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'pending', label: '待确认' },
  { key: 'confirmed', label: '已确认' },
  { key: 'rejected', label: '已忽略' }
]

export default function UnmatchedRefsPage(): React.JSX.Element {
  const [status, setStatus] = useState('pending')
  const [lightbox, setLightbox] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['unmatched-refs', status],
    queryFn: () => adminApi.unmatchedRefs(status),
    refetchInterval: 20_000
  })

  return (
    <div>
      <PageHeader
        title="待确认订单号"
        subtitle="采到了订单号但挂不上订单的会话 · 确认/忽略由员工在桌面端处理，这里只做监控"
      />

      {/* 状态切换 */}
      <div className="flex gap-1 mb-3">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
              status === t.key
                ? 'bg-accent-soft text-accent-strong font-medium'
                : 'text-fg-muted hover:bg-surface-2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.length === 0 ? (
        <EmptyBlock label={status === 'pending' ? '没有待确认的订单号，采集关联正常 ✓' : '暂无记录'} />
      ) : (
        <div className="space-y-2.5">
          {q.data.map((r) => (
            <Card key={r.id} className="p-4">
              <div className="flex gap-4">
                {/* 截图缩略 */}
                {r.screenshotUrl && (
                  <img
                    src={r.screenshotUrl}
                    alt="截图"
                    onClick={() => setLightbox(r.screenshotUrl)}
                    className="w-24 h-24 object-cover rounded-md border border-line cursor-zoom-in shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-base font-semibold">{r.candidate}</code>
                    <span className="text-xs text-fg-subtle">{KIND_LABEL[r.candidateKind] ?? r.candidateKind}</span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${REASON_TONE[r.reason] ?? 'bg-surface-2 text-fg-muted'}`}
                    >
                      {REASON_LABEL[r.reason] ?? r.reason}
                    </span>
                    {r.seenCount > 1 && (
                      <span className="text-xs text-fg-subtle">出现 {r.seenCount} 次</span>
                    )}
                  </div>

                  <div className="mt-1.5 text-sm text-fg-muted">
                    会话「<span className="text-fg">{r.conversationName}</span>」 ·{' '}
                    {r.channel === 'wxwork' ? '企微' : '微信'} · 员工{' '}
                    {r.employee ? (
                      <Link to={`/employees/${r.employee.id}`} className="hover:text-accent-strong">
                        {r.employee.name}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </div>

                  {/* ambiguous 时列出并列的候选订单 */}
                  {r.candidateOrders.length > 0 && (
                    <div className="mt-1.5 text-xs text-fg-muted">
                      并列订单：
                      {r.candidateOrders.map((o, i) => (
                        <span key={o.id}>
                          {i > 0 && '、'}
                          <Link to={`/orders/${o.id}`} className="text-accent-strong hover:underline">
                            {o.sourceOrderNo}（{o.customerName}）
                          </Link>
                        </span>
                      ))}
                    </div>
                  )}
                  {r.reason === 'no_match' && r.bestDist != null && (
                    <div className="mt-1 text-xs text-fg-subtle">最近编辑距离 {r.bestDist}（超阈值）</div>
                  )}

                  <div className="mt-1.5 text-xs text-fg-subtle">
                    采集 {fmtTimeFull(r.capturedAt)} · 更新 {fmtRelative(r.updatedAt)}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
