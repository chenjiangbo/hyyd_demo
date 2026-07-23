import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { adminApi } from '../api/client'
import { Card, PageHeader, LoadingBlock, ErrorBlock, EmptyBlock, Dot } from '../components/ui'
import { fmtRelative } from '../lib/format'

// 把"最近一次采集"距今时长上色：>30 分钟标黄、>3 小时标红。
function staleTone(iso: string | null): 'ok' | 'warn' | 'bad' | 'none' {
  if (!iso) return 'none'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff > 3 * 3600_000) return 'bad'
  if (diff > 30 * 60_000) return 'warn'
  return 'ok'
}

const TONE_CLASS: Record<string, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  none: 'text-fg-subtle'
}

// 一格"近1h / 今日"计数
function Count({ hour, today }: { hour: number; today: number }): React.JSX.Element {
  return (
    <span className="tabular-nums">
      <span className={hour > 0 ? 'text-fg font-medium' : 'text-fg-subtle'}>{hour}</span>
      <span className="text-fg-subtle"> / {today}</span>
    </span>
  )
}

function EndpointStatus({
  online,
  label,
  lastSeenAt
}: {
  online: boolean
  label: string
  lastSeenAt?: string | null
}): React.JSX.Element {
  return (
    <div className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5">
        <Dot color={online ? 'green' : 'gray'} />
        <span className="text-xs text-fg-muted">{label}</span>
      </span>
      {lastSeenAt && <span className="text-[11px] text-fg-subtle">{fmtRelative(lastSeenAt)}</span>}
    </div>
  )
}

function mobileLabel(state: 'active' | 'background' | 'needs_open'): string {
  if (state === 'active') return '在线'
  if (state === 'background') return '后台'
  return '需打开'
}

export default function CaptureHealthPage(): React.JSX.Element {
  const q = useQuery({
    queryKey: ['capture-health'],
    queryFn: () => adminApi.captureHealth(),
    refetchInterval: 15_000
  })

  return (
    <div>
      <PageHeader
        title="采集健康"
        subtitle="每员工 Chrome 插件、TrayApp、移动端状态 · 计数列为「近 1 小时 / 今日」· 每 15 秒刷新"
      />

      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.length === 0 ? (
        <EmptyBlock label="暂无员工" />
      ) : (
        <Card className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted border-b border-line">
                <th className="py-2.5 px-4 font-medium">员工</th>
                <th className="py-2.5 px-3 font-medium">Chrome 插件</th>
                <th className="py-2.5 px-3 font-medium">TrayApp</th>
                <th className="py-2.5 px-3 font-medium">移动端</th>
                <th className="py-2.5 px-3 font-medium">最近采集</th>
                <th className="py-2.5 px-3 font-medium">消息 1h/今日</th>
                <th className="py-2.5 px-3 font-medium">素材 1h/今日</th>
                <th className="py-2.5 px-3 font-medium">通话 1h/今日</th>
                <th className="py-2.5 px-3 font-medium">token</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => {
                const tone = staleTone(r.lastCaptureAt)
                // 在线但很久没采集 = 最可疑，整行轻微染色
                const suspicious = r.online && tone === 'bad'
                return (
                  <tr
                    key={r.employeeId}
                    className={`border-b border-line last:border-0 ${suspicious ? 'bg-danger/5' : ''}`}
                  >
                    <td className="py-2.5 px-4">
                      <Link
                        to={`/employees/${r.employeeId}`}
                        className="font-medium hover:text-accent-strong"
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="py-2.5 px-3">
                      <EndpointStatus online={r.extOnline} label={r.extOnline ? '在线' : '离线'} lastSeenAt={r.lastSeenAt} />
                    </td>
                    <td className="py-2.5 px-3">
                      <EndpointStatus online={r.trayOnline} label={r.trayOnline ? '在线' : '未启动'} lastSeenAt={r.trayLastSeenAt} />
                    </td>
                    <td className="py-2.5 px-3">
                      <EndpointStatus
                        online={r.mobileOnline}
                        label={mobileLabel(r.mobileState)}
                        lastSeenAt={r.mobileLastSeenAt}
                      />
                    </td>
                    <td className={`py-2.5 px-3 text-xs ${TONE_CLASS[tone]}`}>
                      {fmtRelative(r.lastCaptureAt)}
                    </td>
                    <td className="py-2.5 px-3">
                      <Count hour={r.messages.hour} today={r.messages.today} />
                    </td>
                    <td className="py-2.5 px-3">
                      <Count hour={r.materials.hour} today={r.materials.today} />
                    </td>
                    <td className="py-2.5 px-3">
                      <Count hour={r.calls.hour} today={r.calls.today} />
                    </td>
                    <td className="py-2.5 px-3">
                      {r.tokenOk === null ? (
                        <span className="text-xs text-fg-subtle">未知</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <Dot color={r.tokenOk ? 'green' : 'red'} />
                          <span className="text-xs text-fg-muted">{r.tokenOk ? '有效' : '失效'}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
