import { useEffect, useState } from 'react'
import { adminApi, type OrderAiConfig } from '../api/client'
import { Card, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h2 className="mb-3 text-base font-semibold">{children}</h2>
}

export default function OrderAiConfigPage(): React.JSX.Element {
  const [config, setConfig] = useState<OrderAiConfig | null>(null)
  const [error, setError] = useState<Error | null>(null)

  async function load(): Promise<void> {
    setError(null)
    try {
      setConfig(await adminApi.orderAiConfig())
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error(String(reason)))
    }
  }

  useEffect(() => { void load() }, [])

  return (
    <div>
      <PageHeader
        title="订单 AI 分析配置"
        subtitle="查看实际生效的千问分析规则、字段白名单、页面取数与寰宇 MySQL 推送边界。"
      />
      {!config && !error && <LoadingBlock label="正在加载订单 AI 分析配置…" />}
      {error && <ErrorBlock error={error} onRetry={() => void load()} />}
      {config && <div className="space-y-4">
        <Card className="p-5">
          <SectionTitle>1. 千问调用时间与触发条件</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {config.schedule.times.map((time) => <span key={time} className="rounded-full bg-accent-soft px-3 py-1 text-sm font-medium text-accent-strong">{time}</span>)}
          </div>
          <div className="mt-3 grid gap-2 text-sm text-fg-muted">
            <p>时区：{config.schedule.timeZone}</p>
            <p>{config.schedule.condition}</p>
            <p>{config.schedule.scope}</p>
            <p className="rounded bg-surface-2 px-3 py-2 text-fg">如需调整时点，请修改后端环境变量 <code>{config.schedule.setting}</code>，例如 <code>12:00,18:00</code>，然后热重启后端服务。</p>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>2. 千问提示词与本版输出字段</SectionTitle>
          <p className="mb-3 text-sm text-fg-muted">提示词版本：<code>{config.prompt.version}</code>。以下内容即字段提取器实际使用的约束；每单会再追加该订单的服务类型字段白名单、当前正式值与沟通时间线。</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-medium">提示词约束</h3>
              <ol className="space-y-2 text-sm text-fg-muted">
                {config.prompt.rules.map((rule, index) => <li key={rule} className="flex gap-2"><span className="text-fg-subtle">{index + 1}.</span><span>{rule}</span></li>)}
              </ol>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium">每单输入与 JSON 输出</h3>
              <ul className="space-y-2 text-sm text-fg-muted">
                {config.prompt.inputs.map((input) => <li key={input}>• {input}</li>)}
              </ul>
              <div className="mt-3 space-y-2 rounded bg-surface-2 p-3 text-sm text-fg-muted">
                <p>{config.prompt.output.candidate}</p>
                <p>{config.prompt.output.event}</p>
              </div>
            </div>
          </div>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-line text-fg-muted"><tr><th className="px-2 py-2 font-medium">字段编码</th><th className="px-2 py-2 font-medium">字段说明</th><th className="px-2 py-2 font-medium">适用服务类型</th><th className="px-2 py-2 font-medium">人工确认</th></tr></thead>
              <tbody>{config.fields.map((field) => <tr key={field.code} className="border-b border-line/70"><td className="px-2 py-2 font-mono text-xs">{field.code}</td><td className="px-2 py-2">{field.label}</td><td className="px-2 py-2 text-fg-muted">{field.serviceTypes.join('、')}</td><td className="px-2 py-2">{field.requiresConfirmation ? <span className="text-warning">必须确认</span> : <span className="text-fg-muted">按候选状态确认</span>}</td></tr>)}</tbody>
            </table>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>3. 订单详情页取数规则</SectionTitle>
          <ol className="space-y-2 text-sm text-fg-muted">
            {config.readRules.map((rule, index) => <li key={rule} className="flex gap-2"><span className="font-medium text-accent-strong">{index + 1}</span><span>{rule}</span></li>)}
          </ol>
        </Card>

        <Card className="p-5">
          <SectionTitle>4. AI 分析与推送审计存储</SectionTitle>
          <div className="grid gap-3 lg:grid-cols-3">
            {config.storage.map((item) => <div key={item.table} className="rounded border border-line bg-surface-2 p-4"><code className="text-sm font-semibold text-accent-strong">{item.table}</code><p className="mt-2 text-sm">{item.purpose}</p><p className="mt-2 text-xs leading-5 text-fg-muted">字段：{item.fields}</p></div>)}
          </div>
          <p className="mt-3 text-sm text-fg-muted">三张表均由后端启动时以 <code>CREATE TABLE IF NOT EXISTS</code> 方式幂等创建，不覆盖已有分析、候选值和审计记录。</p>
        </Card>

        <Card className="p-5">
          <SectionTitle>5. “确认推送寰宇订单信息”注意事项</SectionTitle>
          <p className="text-sm text-fg-muted">{config.huanyuPush.action}</p>
          <p className="mt-2 rounded bg-surface-2 px-3 py-2 text-sm text-fg">{config.huanyuPush.target}</p>
          <ul className="mt-3 space-y-2 text-sm text-fg-muted">
            {config.huanyuPush.notices.map((notice) => <li key={notice}>• {notice}</li>)}
          </ul>
        </Card>
      </div>}
    </div>
  )
}
