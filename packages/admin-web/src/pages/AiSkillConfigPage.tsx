import { useEffect, useMemo, useState } from 'react'
import { adminApi, type AiSkillConfigResponse, type AiSkillEntries, type AiSkillScope } from '../api/client'
import { Card, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'

const TABS: Array<{ value: AiSkillScope; label: string }> = [
  { value: 'common', label: '通用' },
  { value: 'service_type', label: '服务类型' },
  { value: 'step', label: '服务环节' },
  { value: 'field', label: '字段规则' },
  { value: 'task_skills', label: 'AI Skill' }
]

function entryKey(scope: AiSkillScope | 'task_skill', key: string): string {
  return `${scope}:${key}`
}

export default function AiSkillConfigPage(): React.JSX.Element {
  const [data, setData] = useState<AiSkillConfigResponse | null>(null)
  const [entries, setEntries] = useState<AiSkillEntries>({})
  const [scope, setScope] = useState<AiSkillScope>('service_type')
  const [serviceType, setServiceType] = useState('')
  const [stepCode, setStepCode] = useState('')
  const [fieldCode, setFieldCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function load(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const response = await adminApi.aiSkillConfig()
      setData(response)
      setEntries(response.entries)
      setServiceType((current) => current || response.serviceTypes[0]?.value || '')
      setStepCode((current) => current || response.serviceTypes[0]?.steps[0]?.code || '')
      setFieldCode((current) => current || response.fields[0]?.code || '')
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error(String(reason)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const selectedService = data?.serviceTypes.find((item) => item.value === serviceType)
  const availableSteps = selectedService?.steps ?? []
  const availableFields = data?.fields ?? []
  const selectedStep = availableSteps.find((item) => item.code === stepCode) ?? availableSteps[0]
  const selectedField = availableFields.find((item) => item.code === fieldCode) ?? availableFields[0]
  const selectedKey = scope === 'common' ? 'common'
    : scope === 'service_type' ? serviceType
      : scope === 'step' ? (selectedStep?.code ?? '')
        : scope === 'field' ? (selectedField?.code ?? '')
          : ''
  const currentText = entries[entryKey(scope, selectedKey)] ?? ''
  const selectedLabel = scope === 'common' ? '通用配置'
    : scope === 'service_type' ? (selectedService?.label ?? '')
      : scope === 'step' ? (selectedStep?.name ?? '')
        : scope === 'field' ? (selectedField?.label ?? '')
          : 'AI Skill'

  const fieldsBySystem = useMemo(() => ({
    ABI: availableFields.filter((field) => field.system === 'ABI'),
    泰康: availableFields.filter((field) => field.system === '泰康')
  }), [availableFields])

  function updateEntry(entryScope: AiSkillScope | 'task_skill', keyValue: string, value: string): void {
    const key = entryKey(entryScope, keyValue)
    setEntries((current) => {
      const next = { ...current }
      if (value.trim()) next[key] = value
      else delete next[key]
      return next
    })
  }

  async function saveConfig(): Promise<void> {
    setSaving(true)
    setNotice(null)
    try {
      const result = await adminApi.saveAiSkillConfig(entries)
      setEntries(result.entries)
      setNotice('已保存')
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const textArea = <textarea
    value={currentText}
    onChange={(event) => updateEntry(scope, selectedKey, event.target.value)}
    maxLength={20_000}
    rows={16}
    placeholder={scope === 'field'
      ? '说明这个字段应如何判断、什么证据足以填写，以及哪些情况不能填写。'
      : '填写该项业务说明或任务要求。'}
    className="w-full resize-y rounded border border-line bg-transparent p-3 text-sm leading-6 outline-none focus:border-accent"
  />

  return <div className="space-y-5 pb-12">
    <PageHeader
      title="AI Skill 配置"
      right={<button disabled={!data || saving} onClick={() => void saveConfig()} className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? '保存中…' : '保存'}</button>}
    />
    {loading && <LoadingBlock label="正在加载 Skill 配置…" />}
    {error && <ErrorBlock error={error} onRetry={() => void load()} />}
    {notice && <div className="rounded border border-line bg-surface px-3 py-2 text-sm">{notice}</div>}
    {data && !loading && <>
      <div className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((tab) => <button key={`${tab.value}:${tab.label}`} onClick={() => setScope(tab.value)} className={`border-b-2 px-4 py-2 text-sm ${scope === tab.value ? 'border-accent font-medium text-accent-strong' : 'border-transparent text-fg-muted hover:text-fg'}`}>
          {tab.label}
        </button>)}
      </div>

      {scope === 'common' ? <Card className="space-y-6 p-5">
        <div>
          <h2 className="mb-3 text-lg font-semibold">总体业务介绍</h2>
          <textarea value={entries['common:overview'] ?? ''} onChange={(event) => updateEntry('common', 'overview', event.target.value)} maxLength={20_000} rows={10} className="w-full resize-y rounded border border-line bg-transparent p-3 text-sm leading-6 outline-none focus:border-accent" />
        </div>
        <div>
          <h2 className="mb-3 text-lg font-semibold">通用规则</h2>
          <textarea value={entries['common:common'] ?? ''} onChange={(event) => updateEntry('common', 'common', event.target.value)} maxLength={20_000} rows={10} className="w-full resize-y rounded border border-line bg-transparent p-3 text-sm leading-6 outline-none focus:border-accent" />
        </div>
      </Card> : scope === 'task_skills' ? <div className="space-y-4">
        {data.taskSkills.map((skill) => {
          const value = entries[entryKey('task_skill', skill.code)] ?? ''
          return <Card key={skill.code} className="p-5">
            <div className="mb-3"><h2 className="text-lg font-semibold">{skill.label}</h2></div>
            <textarea
              value={value}
              onChange={(event) => updateEntry('task_skill', skill.code, event.target.value)}
              maxLength={20_000}
              rows={12}
              placeholder={`填写${skill.label}任务的 Skill 内容。`}
              className="w-full resize-y rounded border border-line bg-transparent p-3 text-sm leading-6 outline-none focus:border-accent"
            />
            <div className="mt-2 text-right text-xs text-fg-subtle">{value.length.toLocaleString()} / 20,000</div>
          </Card>
        })}
      </div> : <div className={`grid gap-4 ${scope === 'service_type' ? 'lg:grid-cols-[230px_minmax(0,1fr)]' : scope === 'field' ? 'xl:grid-cols-[260px_minmax(0,1fr)]' : 'xl:grid-cols-[210px_230px_minmax(0,1fr)]'}`}>
        {scope !== 'field' && <Card className="h-fit p-3">
          <div className="mb-2 px-2 text-xs font-semibold text-fg-muted">服务类型</div>
          <div className="space-y-1">
            {data.serviceTypes.map((item) => <button key={item.value} onClick={() => {
              setServiceType(item.value)
              if (scope === 'step') setStepCode(item.steps[0]?.code ?? '')
            }} className={`w-full rounded px-3 py-2 text-left text-sm ${serviceType === item.value ? 'bg-accent-soft font-medium text-accent-strong' : 'text-fg-muted hover:bg-surface-2'}`}>{item.label}</button>)}
          </div>
        </Card>}

        {scope === 'service_type' ? <Card className="p-5">
          <div className="mb-4"><div className="text-xs text-fg-muted">服务类型说明</div><h2 className="mt-1 text-lg font-semibold">{selectedService?.label}</h2></div>
          {textArea}
          <div className="mt-2 text-right text-xs text-fg-subtle">{currentText.length.toLocaleString()} / 20,000</div>
        </Card> : <>
          {scope === 'step' ? <Card className="h-fit p-3">
            <div className="mb-2 px-2 text-xs font-semibold text-fg-muted">服务环节</div>
            <div className="space-y-1">
              {availableSteps.map((item) => <button key={item.code} onClick={() => setStepCode(item.code)} className={`flex w-full items-start justify-between gap-2 rounded px-3 py-2 text-left text-sm ${selectedStep?.code === item.code ? 'bg-accent-soft font-medium text-accent-strong' : 'text-fg-muted hover:bg-surface-2'}`}>
                <span>{item.name}</span><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${entries[entryKey('step', item.code)]?.trim() ? 'bg-success' : 'bg-fg-subtle/40'}`} />
              </button>)}
            </div>
          </Card> : <Card className="h-fit p-3">
            <div className="mb-3 px-2 text-xs text-fg-muted">字段归属系统</div>
            <div className="space-y-4">
              {(['ABI', '泰康'] as const).map((system) => <div key={system}>
                <div className="mb-1 px-2 text-xs font-semibold text-fg-muted">{system === 'ABI' ? 'ABI / 寰宇' : '泰康'}</div>
                <div className="space-y-1">
                  {fieldsBySystem[system].map((field) => <button key={field.code} onClick={() => setFieldCode(field.code)} className={`flex w-full items-start justify-between gap-2 rounded px-3 py-2 text-left text-sm ${selectedField?.code === field.code ? 'bg-accent-soft font-medium text-accent-strong' : 'text-fg-muted hover:bg-surface-2'}`}>
                    <span>{field.label}</span><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${entries[entryKey('field', field.code)]?.trim() ? 'bg-success' : 'bg-fg-subtle/40'}`} />
                  </button>)}
                  {fieldsBySystem[system].length === 0 && <p className="px-2 py-1 text-xs text-fg-subtle">暂无字段</p>}
                </div>
              </div>)}
            </div>
          </Card>}
          <Card className="p-5">
            <div className="mb-4">
              <div className="text-xs text-fg-muted">{scope === 'step' ? '服务环节说明' : '字段提取规则'}</div>
              <h2 className="mt-1 text-lg font-semibold">{selectedLabel}</h2>
              {scope === 'step' && <p className="mt-1 text-sm text-fg-muted">同名服务环节在不同服务类型中共用这份说明。</p>}
              {scope === 'field' && selectedField && <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-subtle"><code className="font-mono">{selectedField.code}</code><span className="rounded bg-surface-2 px-2 py-0.5">{selectedField.system === 'ABI' ? 'ABI / 寰宇' : '泰康'}</span><span>适用于：{selectedField.serviceTypes.join('、')}</span></div>}
            </div>
            {textArea}
            <div className="mt-2 text-right text-xs text-fg-subtle">{currentText.length.toLocaleString()} / 20,000</div>
          </Card>
        </>}
      </div>}
    </>}
  </div>
}
