import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { Card, PageHeader, LoadingBlock, ErrorBlock, Dot } from '../components/ui'
import { fmtUptime } from '../lib/format'

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export default function HealthPage(): React.JSX.Element {
  const q = useQuery({
    queryKey: ['health'],
    queryFn: () => adminApi.health(),
    refetchInterval: 5_000
  })

  return (
    <div>
      <PageHeader title="系统健康" subtitle="后端 / 数据库 / MinIO / WebSocket / ASR · 每 5 秒刷新" />

      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error ? (
        <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data ? (
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
            {q.data.minio.buckets.map((b) => (
              <Row
                key={b.name}
                label={b.name}
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Dot color={b.ok ? 'green' : 'red'} />
                    {b.ok ? '在线' : '不可达'}
                  </span>
                }
              />
            ))}
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-medium mb-2">WebSocket / ASR</h2>
            <Row label="WS 连接总数" value={q.data.websocket.total} />
            <Row label="— ext / tray" value={`${q.data.websocket.ext} / ${q.data.websocket.tray}`} />
            <Row label="ASR 待处理" value={q.data.asr.pending} />
            <Row label="ASR 处理中" value={q.data.asr.processing} />
          </Card>
        </div>
      ) : null}
    </div>
  )
}
