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

  return (
    <div>
      <PageHeader title="仪表盘" subtitle="每 10 秒自动刷新 · 今日采集全貌" />

      {/* 顶部指标卡片 */}
      {summary.isLoading ? (
        <LoadingBlock />
      ) : summary.error ? (
        <ErrorBlock error={summary.error} onRetry={() => void summary.refetch()} />
      ) : summary.data ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
            label="今日通话"
            value={summary.data.calls.total}
            sub={`转写完成率 ${summary.data.calls.doneRate}%`}
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
