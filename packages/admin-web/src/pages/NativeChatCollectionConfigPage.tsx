import { useEffect, useState } from 'react'
import { adminApi } from '../api/client'
import type { NativeChatCollectionRule } from '../api/types'
import { Card, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'

let nextRuleId = 1

function createRuleId(): string {
  return `rule-${Date.now()}-${nextRuleId++}`
}

function newRule(): NativeChatCollectionRule {
  return {
    id: createRuleId(),
    enabled: true,
    channel: 'both',
    match: 'title_contains',
    value: ''
  }
}


export default function NativeChatCollectionConfigPage(): React.JSX.Element {
  const [rules, setRules] = useState<NativeChatCollectionRule[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  async function load(): Promise<void> {
    setLoading(true)
    setLoadError(null)
    try {
      const config = await adminApi.nativeChatCollectionConfig()
      setRules(config.rules)
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  function updateRule(index: number, patch: Partial<NativeChatCollectionRule>): void {
    setRules((current) => current.map((rule, i) => i === index ? { ...rule, ...patch } : rule))
    setSaved(false)
  }

  async function save(): Promise<void> {
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      const result = await adminApi.saveNativeChatCollectionConfig({ rules })
      setRules(result.rules)
      setSaved(true)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingBlock />
  if (loadError) return <ErrorBlock error={loadError} onRetry={() => void load()} />

  return (
    <div className="space-y-5">
      <PageHeader title="微信与企微会话采集" subtitle="统一设置适用于所有连接客户端。标题或指定会话 ID 命中任一启用规则后纳入采集。" />
      <Card className="p-5">
        <div className="space-y-4">
          {rules.length === 0 && (
            <div className="rounded-md border border-line bg-surface-2 p-4 text-sm text-fg-muted">
              当前没有启用的采集规则，客户端不会读取会话消息。添加规则并保存后才会开始采集。
            </div>
          )}
          {rules.map((rule, index) => (
            <div key={rule.id} className="grid gap-3 rounded-lg border border-line p-4 md:grid-cols-12">
              <label className="flex items-center gap-2 text-sm md:col-span-1">
                <input type="checkbox" checked={rule.enabled} onChange={(e) => updateRule(index, { enabled: e.target.checked })} />启用
              </label>
              <select className="rounded border border-line bg-surface px-2 py-2 text-sm md:col-span-2" value={rule.channel} onChange={(e) => updateRule(index, { channel: e.target.value as NativeChatCollectionRule['channel'] })}>
                <option value="both">微信和企微</option><option value="wechat">微信</option><option value="wxwork">企微</option>
              </select>
              <select className="rounded border border-line bg-surface px-2 py-2 text-sm md:col-span-2" value={rule.match} onChange={(e) => updateRule(index, { match: e.target.value as NativeChatCollectionRule['match'] })}>
                <option value="source_id">指定会话 ID</option><option value="title_exact">标题完全匹配</option><option value="title_contains">标题包含</option><option value="title_regex">标题表达式</option>
              </select>
              <input className="rounded border border-line bg-surface px-3 py-2 text-sm md:col-span-7" value={rule.value} placeholder={rule.match === 'source_id' ? '粘贴会话 ID' : rule.match === 'title_regex' ? '输入标题匹配表达式' : '输入标题或关键词'} onChange={(e) => updateRule(index, { value: e.target.value })} />
              <button className="text-sm text-danger md:col-span-12 md:justify-self-end" onClick={() => { setRules((current) => current.filter((_, i) => i !== index)); setSaved(false) }}>删除规则</button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="rounded border border-line px-3 py-2 text-sm hover:bg-surface-2" onClick={() => { setRules((current) => [...current, newRule()]); setSaved(false) }}>添加会话规则</button>
            <button className="rounded bg-accent px-4 py-2 text-sm text-white disabled:opacity-50" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存规则'}</button>
            {saved && <span className="text-sm text-success">已保存</span>}
            {saveError && <span className="text-sm text-danger">保存失败：{saveError}</span>}
          </div>
        </div>
      </Card>
    </div>
  )
}
