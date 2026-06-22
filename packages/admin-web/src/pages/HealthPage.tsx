import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { Card, PageHeader, LoadingBlock, ErrorBlock, Dot } from '../components/ui'
import { fmtUptime, fmtBytes, fmtRelative } from '../lib/format'

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export default function HealthPage(): React.JSX.Element {
  // 健康页含 MinIO 全量对象遍历，刷新间隔放宽到 15s，避免频繁 list 打 MinIO。
  const q = useQuery({
    queryKey: ['health'],
    queryFn: () => adminApi.health(),
    refetchInterval: 15_000
  })

  return (
    <div>
      <PageHeader title="系统健康" subtitle="后端 / 数据库 / MinIO / WebSocket / ASR / 插件上报 · 每 15 秒刷新" />

      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Card className="p-4">
              <h2 className="text-sm font-medium mb-2">后端进程</h2>
              <Row label="运行时长" value={fmtUptime(q.data.process.uptimeSec)} />
              <Row label="Node 版本" value={q.data.process.nodeVersion} />
              <Row label="PID" value={q.data.process.pid} />
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-medium mb-2">数据库</h2>
              <Row
                label="连接"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Dot color={q.data.db.ok ? 'green' : 'red'} />
                    {q.data.db.ok ? '正常' : '异常'}
                  </span>
                }
              />
              <Row label="订单数" value={q.data.db.rows.order} />
              <Row label="素材数" value={q.data.db.rows.material} />
              <Row label="通话数" value={q.data.db.rows.call} />
              <Row label="附件数" value={q.data.db.rows.attachment} />
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-medium mb-2">MinIO 存储桶</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-fg-subtle border-b border-line">
                    <th className="py-1.5 font-medium">桶</th>
                    <th className="py-1.5 font-medium text-right">对象数</th>
                    <th className="py-1.5 font-medium text-right">占用</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.minio.buckets.map((b) => (
                    <tr key={b.name} className="border-b border-line last:border-0">
                      <td className="py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          <Dot color={b.ok ? 'green' : 'red'} />
                          {b.name}
                        </span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {b.objectCount < 0 ? '—' : b.objectCount}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {b.sizeBytes < 0 ? '—' : fmtBytes(b.sizeBytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card className="p-4">
              <h2 className="text-sm font-medium mb-2">WebSocket / ASR</h2>
              <Row label="WS 连接总数" value={q.data.websocket.total} />
              <Row label="— ext / tray" value={`${q.data.websocket.ext} / ${q.data.websocket.tray}`} />
              <Row label="ASR 待处理 / 处理中" value={`${q.data.asr.pending} / ${q.data.asr.processing}`} />
              <Row
                label="ASR 近 24h 成功率"
                value={
                  q.data.asr.last24h.rate === null ? (
                    <span className="text-fg-subtle">近 24h 无完成任务</span>
                  ) : (
                    <span
                      className={
                        q.data.asr.last24h.rate >= 80
                          ? 'text-success'
                          : q.data.asr.last24h.rate >= 50
                            ? 'text-warning'
                            : 'text-danger'
                      }
                    >
                      {q.data.asr.last24h.rate}%（{q.data.asr.last24h.done}/{q.data.asr.last24h.total}）
                    </span>
                  )
                }
              />
            </Card>
          </div>

          {/* Chrome 插件每员工上报 */}
          <Card className="p-4">
            <h2 className="text-sm font-medium mb-2">Chrome 插件上报情况</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-fg-muted border-b border-line">
                    <th className="py-2 font-medium">员工</th>
                    <th className="py-2 font-medium">插件连接</th>
                    <th className="py-2 font-medium">泰康 token</th>
                    <th className="py-2 font-medium">最近上报</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.extReports.map((r) => (
                    <tr key={r.employeeId} className="border-b border-line last:border-0">
                      <td className="py-2">{r.name}</td>
                      <td className="py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <Dot color={r.extConnected ? 'green' : 'gray'} />
                          <span className="text-xs text-fg-muted">
                            {r.extConnected ? '已连接' : '未连接'}
                          </span>
                        </span>
                      </td>
                      <td className="py-2">
                        {r.tokenOk === null ? (
                          <span className="text-xs text-fg-subtle">未知</span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <Dot color={r.tokenOk ? 'green' : 'red'} />
                            <span className="text-xs text-fg-muted">{r.tokenOk ? '有效' : '失效'}</span>
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-xs text-fg-muted">{fmtRelative(r.lastReportAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
