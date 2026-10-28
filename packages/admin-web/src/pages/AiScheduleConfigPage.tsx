import { useEffect, useState } from 'react'
import { adminApi } from '../api/client'
import type { OrderAiAutomationConfig } from '../api/types'
import { Card, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'

type EditableConfig = Pick<OrderAiAutomationConfig, 'imageAiEnabled' | 'communicationSilenceMinutes'>

export default function AiScheduleConfigPage(): React.JSX.Element {
  const [config, setConfig] = useState<OrderAiAutomationConfig | null>(null)
  const [draft, setDraft] = useState<EditableConfig | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function load(): Promise<void> {
    setError(null)
    try {
      const value = await adminApi.orderAiAutomationConfig()
      setConfig(value)
      setDraft({
        imageAiEnabled: value.imageAiEnabled,
        communicationSilenceMinutes: value.communicationSilenceMinutes
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error(String(reason)))
    }
  }

  useEffect(() => { void load() }, [])

  async function save(): Promise<void> {
    if (!draft || !Number.isInteger(draft.communicationSilenceMinutes)
      || draft.communicationSilenceMinutes < 1 || draft.communicationSilenceMinutes > 60) {
      setError(new Error('微信/企微静默时间请填写 1 到 60 分钟之间的整数'))
      return
    }
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const value = await adminApi.saveOrderAiAutomationConfig(draft)
      setConfig(value)
      setDraft({
        imageAiEnabled: value.imageAiEnabled,
        communicationSilenceMinutes: value.communicationSilenceMinutes
      })
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error(String(reason)))
    } finally {
      setSaving(false)
    }
  }

  if (!config || !draft) {
    return error
      ? <ErrorBlock error={error} onRetry={() => void load()} />
      : <LoadingBlock label="正在加载 AI 自动分析配置…" />
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI 自动分析配置"
        subtitle="设置微信、企微沟通分析的等待时间，以及是否识别采集到的图片。"
        right={(
          <button
            type="button"
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={saving}
            onClick={() => void save()}
          >{saving ? '保存中…' : '保存配置'}</button>
        )}
      />

      {error && <ErrorBlock error={error} onRetry={() => void load()} />}
      {saved && <div role="status" className="rounded border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">配置已保存并生效。</div>}

      <Card className="space-y-5 p-5">
        <section className="flex items-start justify-between gap-5">
          <div>
            <h2 className="text-base font-semibold text-fg">图片 AI 分析</h2>
            <p className="mt-1 max-w-3xl text-sm text-fg-muted">
              开启后，系统会识别微信、企微采集到的清晰图片，也会启用浮动精灵现有的挂号凭证识别流程。关闭后不再启动新的图片 AI 分析，正在进行的模型调用会完成；聊天附件仍会正常采集和保存。
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-fg">
            <input
              type="checkbox"
              className="h-4 w-4 accent-current"
              checked={draft.imageAiEnabled}
              onChange={(event) => {
                setSaved(false)
                setDraft({ ...draft, imageAiEnabled: event.target.checked })
              }}
            />
            启用
          </label>
        </section>

        <section className="border-t border-line pt-5">
          <h2 className="text-base font-semibold text-fg">微信与企微消息分析</h2>
          <p className="mt-1 text-sm text-fg-muted">
            同一申领号下的微信、企微消息合并计算。最后一条新消息到达后，静默达到设定时间再分析该申领号下有新内容的订单。
          </p>
          <label className="mt-4 flex max-w-sm items-center gap-3 text-sm text-fg">
            <span>静默时间</span>
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              className="w-24 rounded border border-line bg-surface px-3 py-2"
              value={draft.communicationSilenceMinutes}
              onChange={(event) => {
                const value = event.target.value === '' ? 0 : Number(event.target.value)
                setSaved(false)
                setDraft({ ...draft, communicationSilenceMinutes: value })
              }}
              aria-label="微信与企微消息静默时间，单位分钟"
            />
            <span>分钟（1–60）</span>
          </label>
          <p className="mt-2 text-xs text-fg-subtle">电话录音转写完成后仍立即分析；手工补录素材仍在静默 3 分钟后分析。</p>
        </section>
      </Card>

      <Card className="space-y-2 p-5">
        <h2 className="text-base font-semibold text-fg">其他自动分析时机</h2>
        <p className="text-sm text-fg-muted">电话：转写内容保存后立即分析。</p>
        <p className="text-sm text-fg-muted">手工补录素材：最后一项素材保存后静默 3 分钟再分析。</p>
        <p className="text-sm text-fg-muted">时间标准：北京时间。</p>
      </Card>
    </div>
  )
}
