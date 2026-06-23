import { useQuery } from '@tanstack/react-query'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend
} from 'recharts'
import { adminApi } from '../api/client'
import { StatCard } from '../components/StatCard'
import { AlertBanner } from '../components/AlertBanner'
import { Card, PageHeader, LoadingBlock, ErrorBlock } from '../components/ui'

// 采集质量/简报健康的单格指标：大数字 + 说明，按 tone 上色。
function QualityStat({
  label,
  value,
  hint,
  tone = 'muted'
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: 'ok' | 'warn' | 'muted'
}): React.JSX.Element {
  const color = tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-fg'
  return (
    <div title={hint}>
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-xs text-fg-muted">{label}</div>
    </div>
  )
}

export default function DashboardPage(): React.JSX.Element {
  // 顶部卡片 + 告警每 10s 刷新；时序数据每 60s。
  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => adminApi.dashboardSummary(),
    refetchInterval: 10_000
  })
  const alerts = useQuery({
    queryKey: ['dashboard', 'alerts'],
    queryFn: () => adminApi.dashboardAlerts(),
    refetchInterval: 10_000
  })
  const series = useQuery({
    queryKey: ['dashboard', 'timeseries', 7],
    queryFn: () => adminApi.dashboardTimeseries(7),
    refetchInterval: 60_000
  })
  const quality = useQuery({
    queryKey: ['dashboard', 'capture-quality'],
    queryFn: () => adminApi.captureQuality(),
    refetchInterval: 30_000
  })

  return (
    <div>
      <PageHeader title="仪表盘" subtitle="每 10 秒自动刷新 · 今日采集全貌" />

      {/* 顶部指标卡片 */}
      {summary.isLoading ? (
        <LoadingBlock />
      ) : summary.error ? (
        <ErrorBlock error={summary.error} onRetry={() => void summary.refetch()} />
      ) : summary.data ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard
            label="今日新增订单"
            value={summary.data.orders.total}
            sub={`挂号 ${summary.data.orders.register} · 绿通 ${summary.data.orders.general}`}
          />
          <StatCard
            label="今日新增素材"
            value={summary.data.materials.total}
            accent
            sub={`文字 ${summary.data.materials.text} · 图片 ${summary.data.materials.image}`}
          />
          <StatCard
            label="今日聊天消息"
            value={summary.data.messages.total}
            sub={`客户 ${summary.data.messages.other} · 坐席 ${summary.data.messages.self}`}
          />
          <StatCard
            label="今日通话"
            value={summary.data.calls.total}
            sub={`转写完成率 ${summary.data.calls.doneRate}%`}
          />
          <StatCard
            label="订单号待确认"
            value={summary.data.unmatchedPending}
            accent={summary.data.unmatchedPending > 0}
            sub={summary.data.unmatchedPending > 0 ? '采到但未挂上订单' : '无待确认'}
          />
          <StatCard
            label="在线员工"
            value={`${summary.data.employees.online} / ${summary.data.employees.total}`}
            sub="WS 活跃 / 总数"
          />
        </div>
      ) : null}

      {/* 图表 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">近 7 天素材采集量</h2>
          {series.isLoading ? (
            <LoadingBlock />
          ) : series.error ? (
            <ErrorBlock error={series.error} onRetry={() => void series.refetch()} />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={series.data ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} tickFormatter={(d) => String(d).slice(5)} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--fg)'
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="text" name="文字" stackId="m" fill="var(--accent)" />
                <Bar dataKey="image" name="图片" stackId="m" fill="var(--info)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">近 7 天新增订单</h2>
          {series.isLoading ? (
            <LoadingBlock />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={series.data ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} tickFormatter={(d) => String(d).slice(5)} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--fg-muted)' }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: 'var(--fg)'
                  }}
                />
                <Bar dataKey="orders" name="订单" fill="var(--accent-strong)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      {/* 采集质量 + 简报健康 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">采集质量（今日）</h2>
          {quality.isLoading ? (
            <LoadingBlock />
          ) : quality.error ? (
            <ErrorBlock error={quality.error} onRetry={() => void quality.refetch()} />
          ) : quality.data ? (
            <div className="grid grid-cols-3 gap-3 text-center">
              <QualityStat
                label="跨帧去重命中"
                value={quality.data.quality.dedupHit}
                hint="重复截到、被合并的次数，越高说明截屏冗余越多"
              />
              <QualityStat
                label="时间链还原失败"
                value={quality.data.quality.chatTimeMissing}
                tone={quality.data.quality.chatTimeMissing > 0 ? 'warn' : 'ok'}
                hint="算不出真实聊天时间的非系统消息条数"
              />
              <QualityStat
                label="识图成功率"
                value={
                  quality.data.quality.image.successRate === null
                    ? '—'
                    : `${quality.data.quality.image.successRate}%`
                }
                tone={
                  quality.data.quality.image.successRate === null
                    ? 'muted'
                    : quality.data.quality.image.successRate >= 80
                      ? 'ok'
                      : 'warn'
                }
                hint={`图片素材 ${quality.data.quality.image.processed}/${quality.data.quality.image.today} 已识图`}
              />
            </div>
          ) : null}
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-medium mb-3">AI 简报健康</h2>
          {quality.isLoading ? (
            <LoadingBlock />
          ) : quality.data ? (
            <div className="grid grid-cols-3 gap-3 text-center">
              <QualityStat
                label="已生成"
                value={`${quality.data.brief.generated} / ${quality.data.brief.ordersWithMessages}`}
                tone="ok"
                hint="有消息的订单中已产出简报的数量"
              />
              <QualityStat
                label="简报滞后"
                value={quality.data.brief.stale}
                tone={quality.data.brief.stale > 0 ? 'warn' : 'ok'}
                hint="有新消息但简报水位未跟上的订单"
              />
              <QualityStat
                label="尚未生成"
                value={quality.data.brief.missing}
                tone={quality.data.brief.missing > 0 ? 'warn' : 'ok'}
                hint="有消息但还没生成过简报的订单"
              />
            </div>
          ) : null}
        </Card>
      </div>

      {/* 告警区 */}
      <div className="mt-4">
        <h2 className="text-sm font-medium mb-2">告警</h2>
        {alerts.isLoading ? (
          <LoadingBlock />
        ) : alerts.error ? (
          <ErrorBlock error={alerts.error} onRetry={() => void alerts.refetch()} />
        ) : (
          <AlertBanner alerts={alerts.data ?? []} />
        )}
      </div>
    </div>
  )
}
