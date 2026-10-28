import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { adminApi } from '../api/client'
import type { CaptureHealthRow } from '../api/types'
import { Card, PageHeader, LoadingBlock, ErrorBlock, EmptyBlock, Dot } from '../components/ui'
import { fmtRelative, fmtTimeFull } from '../lib/format'

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

function mobileRuntimeLabel(status: CaptureHealthRow['mobileRuntime']['status']): string {
  switch (status) {
    case 'running_foreground': return '前台运行'
    case 'running_background': return '后台运行'
    case 'stopped': return '采集已停止'
    case 'stale': return '心跳中断'
    case 'legacy': return '旧版心跳'
    case 'unseen': return '未上报'
    default: return '状态未知'
  }
}

function durationText(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}天${hours}小时`
  if (hours > 0) return `${hours}小时${minutes}分`
  return `${minutes}分钟`
}

function mobileEventLabel(type: string): string {
  const labels: Record<string, string> = {
    client_seen: '设备首次上报',
    heartbeat_resumed: '心跳恢复',
    app_backgrounded: '切至后台',
    app_foregrounded: '回到前台',
    collector_started: '启动采集',
    collector_stopped: '停止采集',
    sync_progress: '同步进度变化',
    sync_error: '同步失败',
    recording_upload_confirmed: '录音上传确认成功'
  }
  return labels[type] ?? type
}

function MobileRuntimeCell({
  mobile,
  legacyOnline,
  legacyState
}: {
  mobile: CaptureHealthRow['mobileRuntime']
  legacyOnline: boolean
  legacyState: CaptureHealthRow['mobileState']
}): React.JSX.Element {
  const isRunning = mobile.status === 'running_foreground' || mobile.status === 'running_background'
  const color = isRunning ? 'green' : mobile.status === 'stale' ? 'yellow' : 'gray'
  const label = mobile.status === 'legacy'
    ? legacyOnline ? '旧版心跳在线' : mobileLabel(legacyState)
    : mobileRuntimeLabel(mobile.status)
  const runningDuration = mobile.runningSeconds
  const lastHeartbeatAt = mobile.lastHeartbeatAt

  return (
    <div className="min-w-[220px] max-w-[340px] space-y-1">
      <div className="inline-flex items-center gap-1.5">
        <Dot color={color} />
        <span className="text-xs text-fg-muted">{label}</span>
        {mobile.appVersion && <span className="text-[11px] text-fg-subtle">v{mobile.appVersion}</span>}
      </div>
      {isRunning && runningDuration !== null && (
        <div className="text-[11px] text-fg-subtle">
          {mobile.status === 'running_background' ? '后台运行' : '服务运行'} {durationText(runningDuration)}
        </div>
      )}
      {lastHeartbeatAt && <div className="text-[11px] text-fg-subtle">心跳：{fmtRelative(lastHeartbeatAt)}</div>}
      {mobile.telemetryVersion === 'legacy' && (
        <div className="text-[11px] text-warning">旧版未上报服务运行及上传进度</div>
      )}
      {mobile.telemetryVersion === 'current' && (
        <>
          <div className="text-[11px] text-fg-muted">
            {mobile.syncRunning
              ? `${isRunning ? '正在' : '中断前：'}${mobile.syncStage || '处理中'} · ${mobile.recordingsProcessed}/${mobile.recordingsTotal} · 成功 ${mobile.recordingsUploaded} · 失败 ${mobile.recordingsFailed}${isRunning ? '' : ' · 当前状态未知'}`
              : mobile.status === 'stale'
                ? `最后上报：${mobile.serviceRunning ? '采集服务运行中' : '采集服务未运行'} · 当前状态未知`
                : mobile.serviceRunning && isRunning ? '当前空闲' : '采集服务未运行'}
          </div>
          {mobile.currentRecordingName && (
            <div className="text-[11px] text-fg-subtle truncate" title={mobile.currentRecordingName}>
              {isRunning ? '当前文件：' : '中断时文件：'}{mobile.currentRecordingName}
            </div>
          )}
          {mobile.lastError && (
            <div className="text-[11px] text-danger truncate" title={mobile.lastError}>
              最近错误：{mobile.lastError}
            </div>
          )}
        </>
      )}
      <div className="text-[11px] text-fg-subtle">
        最近录音上传：{mobile.lastRecordingUploadedAt
          ? <span>{fmtTimeFull(mobile.lastRecordingUploadedAt)} · {fmtRelative(mobile.lastRecordingUploadedAt)}</span>
          : '暂无已确认上传'}
      </div>
      {mobile.recentEvents.length > 0 && (
        <div className="text-[10px] text-fg-subtle truncate" title={mobile.recentEvents.map((event) => mobileEventLabel(event.type)).join(' · ')}>
          最近变化：{mobileEventLabel(mobile.recentEvents[0].type)} · {fmtRelative(mobile.recentEvents[0].occurredAt)}
        </div>
      )}
    </div>
  )
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
        subtitle="客户端运行状态与采集进度 · 计数列为「近 1 小时 / 今日」· 每 15 秒刷新"
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
                      <MobileRuntimeCell mobile={r.mobileRuntime} legacyOnline={r.mobileOnline} legacyState={r.mobileState} />
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
