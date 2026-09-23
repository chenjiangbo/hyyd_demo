import { useEffect, useMemo, useState } from 'react'
import { adminApi, type WorkflowStepConfig, type WorkflowTemplateConfig } from '../api/client'
import { Card, PageHeader } from '../components/ui'

const EVENT_OPTIONS = [
  'hospital_confirmed', 'revisit_confirmed', 'check_confirmed',
  'registration_completed', 'escort_completed', 'check_booking_completed',
  'hospital_booking_completed', 'revisit_completed', 'service_cancelled'
]

const emptyStep = (index: number): WorkflowStepConfig => ({
  code: `new_step_${index + 1}`, name: '新步骤', parentCode: null, kind: 'step', sortOrder: (index + 1) * 10,
  required: true, repeatable: false, activationMode: 'initial', triggerEventCode: null, status: 'active'
})

export default function WorkflowConfigPage(): React.JSX.Element {
  const [templates, setTemplates] = useState<WorkflowTemplateConfig[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<WorkflowTemplateConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function load(): Promise<void> {
    setLoading(true)
    try {
      const data = await adminApi.workflowTemplates()
      setTemplates(data)
      const first = data.find((item) => item.status === 'active') ?? data[0] ?? null
      setSelectedId((current) => current ?? first?.id ?? null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载服务步骤配置失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const selected = useMemo(() => templates.find((item) => item.id === selectedId) ?? null, [templates, selectedId])
  useEffect(() => {
    setDraft(selected ? structuredClone(selected) : null)
    setMessage(null)
  }, [selected])

  function updateStep(index: number, patch: Partial<WorkflowStepConfig>): void {
    setDraft((current) => {
      if (!current) return current
      const steps = current.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step)
      return { ...current, steps }
    })
  }

  async function save(): Promise<void> {
    if (!draft) return
    setSaving(true)
    setMessage(null)
    try {
      await adminApi.saveWorkflowTemplate(draft.id, { name: draft.name, description: draft.description, steps: draft.steps })
      setMessage('已保存。新订单会使用此配置；已有订单步骤不会被覆盖。')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <PageHeader title="服务步骤配置" subtitle="维护服务类型的必选步骤、服务包、父子关系及 AI/表单事件触发规则。" />
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
        <Card className="p-2 h-fit">
          <div className="px-2 py-2 text-xs text-fg-muted">服务类型</div>
          {loading && <div className="px-2 py-3 text-sm text-fg-muted">加载中…</div>}
          {templates.filter((item) => item.status === 'active').map((item) => (
            <button key={item.id} onClick={() => setSelectedId(item.id)} className={`w-full rounded px-2 py-2 text-left text-sm ${item.id === selectedId ? 'bg-accent-soft text-accent-strong font-medium' : 'hover:bg-surface-2 text-fg-muted'}`}>
              {item.serviceType}
            </button>
          ))}
        </Card>
        <Card className="p-4 overflow-x-auto">
          {!draft ? <div className="py-10 text-center text-sm text-fg-muted">请选择服务类型</div> : <>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <div className="text-xs text-fg-muted">服务类型：{draft.serviceType} · 版本 {draft.version}</div>
                <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 w-full border-b border-line bg-transparent py-1 text-lg font-semibold outline-none focus:border-accent" />
              </div>
              <button disabled={saving} onClick={() => void save()} className="rounded bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">{saving ? '保存中…' : '保存配置'}</button>
            </div>
            <textarea value={draft.description ?? ''} onChange={(event) => setDraft({ ...draft, description: event.target.value || null })} placeholder="配置说明（可选）" className="mb-4 min-h-16 w-full rounded border border-line bg-transparent p-2 text-sm outline-none focus:border-accent" />
            {message && <div className={`mb-3 rounded px-3 py-2 text-sm ${message.startsWith('已保存') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{message}</div>}
            <table className="min-w-[1080px] w-full text-left text-xs">
              <thead className="border-b border-line text-fg-muted"><tr>{['步骤编码', '名称', '父步骤', '类型', '排序', '必选', '可重复', '生成方式', '触发事件', ''].map((label) => <th key={label} className="px-1.5 py-2 font-medium">{label}</th>)}</tr></thead>
              <tbody>
                {draft.steps.map((step, index) => <tr key={`${step.code}-${index}`} className="border-b border-line/70">
                  <td className="p-1"><input value={step.code} onChange={(event) => updateStep(index, { code: event.target.value })} className="w-28 rounded border border-line bg-transparent p-1" /></td>
                  <td className="p-1"><input value={step.name} onChange={(event) => updateStep(index, { name: event.target.value })} className="w-24 rounded border border-line bg-transparent p-1" /></td>
                  <td className="p-1"><select value={step.parentCode ?? ''} onChange={(event) => updateStep(index, { parentCode: event.target.value || null })} className="w-28 rounded border border-line bg-transparent p-1"><option value="">— 顶级 —</option>{draft.steps.filter((candidate, candidateIndex) => candidateIndex !== index && candidate.kind === 'package').map((candidate) => <option key={candidate.code} value={candidate.code}>{candidate.name}</option>)}</select></td>
                  <td className="p-1"><select value={step.kind} onChange={(event) => updateStep(index, { kind: event.target.value as WorkflowStepConfig['kind'] })} className="rounded border border-line bg-transparent p-1"><option value="step">步骤</option><option value="package">服务包</option></select></td>
                  <td className="p-1"><input type="number" value={step.sortOrder} onChange={(event) => updateStep(index, { sortOrder: Number(event.target.value) })} className="w-16 rounded border border-line bg-transparent p-1" /></td>
                  <td className="p-1 text-center"><input type="checkbox" checked={step.required} onChange={(event) => updateStep(index, { required: event.target.checked })} /></td>
                  <td className="p-1 text-center"><input type="checkbox" checked={step.repeatable} onChange={(event) => updateStep(index, { repeatable: event.target.checked })} /></td>
                  <td className="p-1"><select value={step.activationMode} onChange={(event) => updateStep(index, { activationMode: event.target.value as WorkflowStepConfig['activationMode'], triggerEventCode: event.target.value === 'initial' ? null : step.triggerEventCode })} className="rounded border border-line bg-transparent p-1"><option value="initial">订单初始化</option><option value="event">事件触发</option></select></td>
                  <td className="p-1"><select disabled={step.activationMode !== 'event'} value={step.triggerEventCode ?? ''} onChange={(event) => updateStep(index, { triggerEventCode: event.target.value || null })} className="w-40 rounded border border-line bg-transparent p-1 disabled:opacity-40"><option value="">请选择</option>{EVENT_OPTIONS.map((eventCode) => <option key={eventCode} value={eventCode}>{eventCode}</option>)}</select></td>
                  <td className="p-1"><button onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, stepIndex) => stepIndex !== index) })} className="text-danger hover:underline">删除</button></td>
                </tr>)}
              </tbody>
            </table>
            <button onClick={() => setDraft({ ...draft, steps: [...draft.steps, emptyStep(draft.steps.length)] })} className="mt-3 rounded border border-line px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-2">+ 添加步骤</button>
          </>}
        </Card>
      </div>
    </div>
  )
}
