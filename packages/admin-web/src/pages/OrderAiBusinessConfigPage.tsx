import { useEffect, useMemo, useState } from 'react'
import {
  adminApi,
  type OrderAiBusinessConfig,
  type OrderAiBusinessConfigResponse,
  type OrderAiBusinessStage,
  type OrderAiBusinessType
} from '../api/client'
import { Card, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'

function lines(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean)
}

function lineText(values: string[]): string {
  return values.join('\n')
}

function TextArea({ value, onChange, placeholder, rows = 3 }: { value: string; onChange: (value: string) => void; placeholder: string; rows?: number }): React.JSX.Element {
  return <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={rows} className="w-full rounded border border-line bg-transparent p-2 text-sm leading-6 outline-none focus:border-accent" />
}

function FieldSelector({
  fields,
  selected,
  onChange
}: {
  fields: OrderAiBusinessConfigResponse['fields']
  selected: string[]
  onChange: (value: string[]) => void
}): React.JSX.Element {
  const selectedSet = new Set(selected)
  const groups = useMemo(() => {
    const result = new Map<string, OrderAiBusinessConfigResponse['fields']>()
    for (const field of fields) {
      const group = field.serviceTypes.length === 1 ? field.serviceTypes[0] : '通用字段'
      result.set(group, [...(result.get(group) ?? []), field])
    }
    return Array.from(result.entries())
  }, [fields])
  return <div className="space-y-4">
    {groups.map(([group, groupFields]) => <div key={group}>
      <div className="mb-1 text-xs font-semibold text-fg-muted">{group}</div>
      <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
        {groupFields.map((field) => <label key={field.code} className="flex items-start gap-2 rounded px-1 py-1 text-sm hover:bg-surface-2">
          <input type="checkbox" checked={selectedSet.has(field.code)} onChange={(event) => {
            const next = event.target.checked ? [...selected, field.code] : selected.filter((code) => code !== field.code)
            onChange(Array.from(new Set(next)))
          }} className="mt-1" />
          <span>{field.label}<span className="ml-1 font-mono text-[11px] text-fg-subtle">{field.code}</span>{field.requiresConfirmation && <span className="ml-1 text-warning">需确认</span>}</span>
        </label>)}
      </div>
    </div>)}
  </div>
}

export default function OrderAiBusinessConfigPage(): React.JSX.Element {
  const [data, setData] = useState<OrderAiBusinessConfigResponse | null>(null)
  const [draft, setDraft] = useState<OrderAiBusinessConfig | null>(null)
  const [selectedType, setSelectedType] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function load(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const response = await adminApi.orderAiBusinessConfig()
      setData(response)
      setDraft(response.config)
      setSelectedType((current) => current || response.config.orderTypes[0]?.serviceType || '')
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error(String(reason)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const selected = draft?.orderTypes.find((item) => item.serviceType === selectedType) ?? null
  const fieldsForSelected = useMemo(() => {
    if (!data || !selected) return []
    return data.fields.filter((field) => field.serviceTypes.includes(selected.serviceType) || field.serviceTypes.includes('全部服务类型'))
  }, [data, selected])

  function updateCommon(key: keyof OrderAiBusinessConfig['common'], value: string): void {
    setDraft((current) => current ? { ...current, common: { ...current.common, [key]: value } } : current)
  }

  function updateType(patch: Partial<OrderAiBusinessType>): void {
    setDraft((current) => current ? { ...current, orderTypes: current.orderTypes.map((item) => item.serviceType === selectedType ? { ...item, ...patch } : item) } : current)
  }

  function updateStage(index: number, patch: Partial<OrderAiBusinessStage>): void {
    if (!selected) return
    updateType({ stages: selected.stages.map((stage, stageIndex) => stageIndex === index ? { ...stage, ...patch } : stage) })
  }

  async function save(): Promise<OrderAiBusinessConfig | null> {
    if (!draft) return null
    setSaving(true)
    setMessage(null)
    try {
      const result = await adminApi.saveOrderAiBusinessConfig(draft)
      setDraft(result.config)
      setMessage(result.message)
      return result.config
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason))
      return null
    } finally {
      setSaving(false)
    }
  }

  async function generateFile(): Promise<void> {
    const config = await save()
    if (!config) return
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `order-ai-business-config-v${config.version}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setMessage('配置已保存，并已生成 JSON 配置文件')
  }

  return <div className="space-y-5 pb-12">
    <PageHeader title="AI 业务配置" subtitle="业务同事填写订单含义、服务阶段和要提取的字段，保存后可生成提示词配置文件。" right={<div className="flex gap-2"><button disabled={!draft || saving} onClick={() => void save()} className="rounded border border-line px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-50">{saving ? '保存中…' : '保存配置'}</button><button disabled={!draft || saving} onClick={() => void generateFile()} className="rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">生成 JSON 文件</button></div>} />
    {loading && <LoadingBlock label="正在加载 AI 业务配置…" />}
    {error && <ErrorBlock error={error} onRetry={() => void load()} />}
    {draft && data && <>
      {message && <div className={`rounded border px-3 py-2 text-sm ${message.includes('失败') || message.includes('错误') || message.includes('不能') || message.includes('必须') ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>{message}</div>}
      <Card className="p-5">
        <h2 className="mb-1 text-base font-semibold">一、所有业务共用的规则</h2>
        <p className="mb-4 text-sm text-fg-muted">只填写大家都认可的通用规则。订单类型的特殊规则放到下面对应类型中。</p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm font-medium">我们在做什么<TextArea value={draft.common.businessBackground} onChange={(value) => updateCommon('businessBackground', value)} placeholder="例如：寰宇员工通过微信、企微和电话协助客户完成医疗服务，AI 从沟通记录中提取可回填信息。" rows={4} /></label>
          <label className="text-sm font-medium">什么证据才算有效<TextArea value={draft.common.evidenceRules} onChange={(value) => updateCommon('evidenceRules', value)} placeholder="例如：客户明确确认、员工明确反馈已完成，才可判断为确认或完成；只说计划不能算完成。" rows={4} /></label>
          <label className="text-sm font-medium">时间怎么判断<TextArea value={draft.common.timeRules} onChange={(value) => updateCommon('timeRules', value)} placeholder="例如：采集时间可能不准确，优先参考消息中明确提到的实际日期和预约凭证时间。" rows={4} /></label>
          <label className="text-sm font-medium">不同来源冲突时怎么处理<TextArea value={draft.common.sourcePriority} onChange={(value) => updateCommon('sourcePriority', value)} placeholder="例如：正式派单通知优先于普通聊天；无法判断时保留冲突并要求人工确认。" rows={4} /></label>
          <label className="text-sm font-medium md:col-span-2">绝对不能自行推断什么<TextArea value={draft.common.forbiddenInference} onChange={(value) => updateCommon('forbiddenInference', value)} placeholder="例如：不能因为客户想去某医院，就判断医院已经确认；不能把同一申领号下其他订单的信息写入当前订单。" rows={3} /></label>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
        <Card className="h-fit p-4">
          <label className="text-sm font-medium">订单类型<select value={selectedType} onChange={(event) => setSelectedType(event.target.value)} className="mt-2 w-full rounded border border-line bg-transparent p-2 text-sm outline-none focus:border-accent">
            {draft.orderTypes.map((item) => <option key={item.serviceType} value={item.serviceType}>{item.serviceType}</option>)}
          </select></label>
          <p className="mt-3 text-xs leading-5 text-fg-muted">订单类型来自系统现有服务配置，不能在这里新增或改名。</p>
        </Card>
        {selected && <Card className="space-y-5 p-5">
          <div><div className="text-xs text-fg-muted">订单类型</div><h2 className="text-lg font-semibold">{selected.serviceType}</h2></div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium md:col-span-2">这个业务是做什么的<TextArea value={selected.businessMeaning} onChange={(value) => updateType({ businessMeaning: value })} placeholder="用业务同事能理解的话说明服务目的、客户得到什么结果。" rows={4} /></label>
            <label className="text-sm font-medium">包含哪些服务<TextArea value={lineText(selected.includedServices)} onChange={(value) => updateType({ includedServices: lines(value) })} placeholder="每行写一项，例如：挂号、门诊陪诊" /></label>
            <label className="text-sm font-medium">不包含哪些服务<TextArea value={lineText(selected.excludedServices)} onChange={(value) => updateType({ excludedServices: lines(value) })} placeholder="每行写一项，避免 AI 越界判断" /></label>
            <label className="text-sm font-medium">什么算这个订单完成<TextArea value={selected.completionCriteria} onChange={(value) => updateType({ completionCriteria: value })} placeholder="写清楚事实标准，不要只写‘服务完成’。" rows={3} /></label>
            <label className="text-sm font-medium">什么算取消或未完成<TextArea value={selected.cancellationCriteria} onChange={(value) => updateType({ cancellationCriteria: value })} placeholder="写清楚改期、退号和整单取消的区别。" rows={3} /></label>
          </div>

          <div className="border-t border-line pt-4"><h3 className="mb-1 text-sm font-semibold">这个订单要提取哪些字段</h3><p className="mb-3 text-xs text-fg-muted">已按订单类型筛出可用字段，带“需确认”的字段不会自动写入正式表单。</p><FieldSelector fields={fieldsForSelected} selected={selected.selectedFields} onChange={(value) => updateType({ selectedFields: value })} /></div>

          <div className="border-t border-line pt-4"><h3 className="mb-1 text-sm font-semibold">服务阶段</h3><p className="mb-3 text-xs text-fg-muted">阶段名称来自现有服务步骤，只需补充“这个阶段是什么意思、目标是什么、何时算完成”。</p><div className="space-y-4">
            {selected.stages.map((stage, index) => <div key={stage.code} className="rounded border border-line bg-surface-2 p-4">
              <div className="mb-3 flex items-center justify-between"><div className="font-medium">{stage.name}</div><code className="text-[11px] text-fg-subtle">{stage.code}</code></div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-sm">阶段是什么意思<TextArea value={stage.meaning} onChange={(value) => updateStage(index, { meaning: value })} placeholder="例如：员工首次与客户沟通，确认服务需求。" rows={2} /></label>
                <label className="text-sm">这个阶段要达成什么<TextArea value={stage.goal} onChange={(value) => updateStage(index, { goal: value })} placeholder="例如：明确客户要解决的问题和可接受的医院范围。" rows={2} /></label>
                <label className="text-sm">什么事实说明阶段完成<TextArea value={stage.completionCriteria} onChange={(value) => updateStage(index, { completionCriteria: value })} placeholder="写可以从消息或通话中核对的事实。" rows={2} /></label>
                <label className="text-sm">本阶段不能直接下什么结论<TextArea value={stage.forbiddenConclusions} onChange={(value) => updateStage(index, { forbiddenConclusions: value })} placeholder="例如：客户说‘可以看看’不等于已确认预约。" rows={2} /></label>
              </div>
              <label className="mt-3 block text-sm">本阶段重点字段<select multiple value={stage.focusFields} onChange={(event) => updateStage(index, { focusFields: Array.from(event.target.selectedOptions, (option) => option.value) })} className="mt-1 min-h-24 w-full rounded border border-line bg-transparent p-2 text-sm outline-none focus:border-accent">{fieldsForSelected.map((field) => <option key={field.code} value={field.code}>{field.label}</option>)}</select></label>
            </div>)}
          </div>
          </div>
        </Card>}
      </div>
    </>}
  </div>
}
