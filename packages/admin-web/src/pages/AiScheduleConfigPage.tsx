import { useEffect, useMemo, useState } from 'react'
import { adminApi, type AiScheduleConfig, type UpdateAiSchedulePayload } from '../api/client'
import { Card, Dot, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'

const PRESET_INTERVALS = [
  { label: '每 15 分钟', value: 15 },
  { label: '每 30 分钟（推荐）', value: 30 },
  { label: '每 1 小时', value: 60 }
]

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h2 className="mb-3 text-base font-semibold text-fg">{children}</h2>
}

/** 前端根据参数实时计算时点预览 */
function computePreviewSlots(startTime: string, endTime: string, intervalMinutes: number): string[] {
  const parseMinute = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return (h ?? 0) * 60 + (m ?? 0)
  }
  const formatMinute = (mins: number) => {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  const start = parseMinute(startTime)
  const end = parseMinute(endTime)
  if (isNaN(start) || isNaN(end) || start > end || intervalMinutes <= 0) {
    return []
  }

  const slots: string[] = []
  for (let curr = start; curr <= end; curr += intervalMinutes) {
    slots.push(formatMinute(curr))
  }
  return slots
}

export default function AiScheduleConfigPage(): React.JSX.Element {
  const [data, setData] = useState<AiScheduleConfig | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)

  // 表单状态
  const [enabled, setEnabled] = useState(true)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('21:00')
  const [intervalMinutes, setIntervalMinutes] = useState(30)
  const [isCustomInterval, setIsCustomInterval] = useState(false)
  const [customMinutesInput, setCustomMinutesInput] = useState('30')

  // 提交状态
  const [saving, setSaving] = useState(false)
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null)
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null)

  async function loadData(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const res = await adminApi.aiScheduleConfig()
      setData(res)
      setEnabled(res.config.enabled)
      setStartTime(res.config.startTime)
      setEndTime(res.config.endTime)
      setIntervalMinutes(res.config.intervalMinutes)

      const isPreset = PRESET_INTERVALS.some((p) => p.value === res.config.intervalMinutes)
      setIsCustomInterval(!isPreset)
      setCustomMinutesInput(String(res.config.intervalMinutes))
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
  }, [])

  // 动态实时预览生成的时点
  const previewSlots = useMemo(() => {
    if (!enabled) return []
    return computePreviewSlots(startTime, endTime, intervalMinutes)
  }, [enabled, startTime, endTime, intervalMinutes])

  // 处理预设间隔切换
  const handlePresetChange = (mins: number) => {
    setIsCustomInterval(false)
    setIntervalMinutes(mins)
    setCustomMinutesInput(String(mins))
  }

  // 处理自定义间隔切换
  const handleCustomRadio = () => {
    setIsCustomInterval(true)
    const val = Number(customMinutesInput) || 30
    setIntervalMinutes(val)
  }

  // 处理自定义间隔输入变化
  const handleCustomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setCustomMinutesInput(val)
    const num = Number(val)
    if (!isNaN(num) && num > 0) {
      setIntervalMinutes(num)
    }
  }

  // 恢复推荐默认值
  const handleResetDefault = () => {
    setEnabled(true)
    setStartTime('09:00')
    setEndTime('21:00')
    setIntervalMinutes(30)
    setIsCustomInterval(false)
    setCustomMinutesInput('30')
    setSaveSuccessMsg(null)
    setSaveErrorMsg(null)
  }

  // 提交保存
  const handleSave = async () => {
    setSaveSuccessMsg(null)
    setSaveErrorMsg(null)

    if (startTime > endTime) {
      setSaveErrorMsg('开始时间不能晚于结束时间')
      return
    }
    if (intervalMinutes < 5 || intervalMinutes > 720) {
      setSaveErrorMsg('调用间隔必须在 5 分钟到 720 分钟（12小时）之间')
      return
    }

    setSaving(true)
    try {
      const payload: UpdateAiSchedulePayload = {
        enabled,
        startTime,
        endTime,
        intervalMinutes
      }
      const res = await adminApi.saveAiScheduleConfig(payload)
      setData(res.data)
      setSaveSuccessMsg(res.message || '配置已成功保存并立即生效！')
      setTimeout(() => setSaveSuccessMsg(null), 5000)
    } catch (err) {
      setSaveErrorMsg(err instanceof Error ? err.message : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI 调用时间配置"
        subtitle="集中管理通义千问大模型订单后台增量分析的执行时段与调用频率，保存即时热生效，无需重启后端服务。"
      />

      {loading && <LoadingBlock label="正在获取 AI 调度策略与运行状态…" />}
      {error && <ErrorBlock error={error} onRetry={() => void loadData()} />}

      {!loading && !error && data && (
        <>
          {/* 1. 当前运行状态看板 */}
          <Card className="p-5">
            <SectionTitle>1. 实时运行监控</SectionTitle>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-surface-2 p-4">
                <div className="text-xs text-fg-subtle">调度引擎状态</div>
                <div className="mt-1 flex items-center gap-2 text-base font-semibold">
                  <Dot color={data.config.enabled ? 'green' : 'gray'} />
                  <span>{data.config.enabled ? '正常运行中' : '已暂停'}</span>
                </div>
                <div className="mt-1 text-xs text-fg-muted">{data.timeZone}</div>
              </div>

              <div className="rounded-lg bg-surface-2 p-4">
                <div className="text-xs text-fg-subtle">每日执行频次</div>
                <div className="mt-1 text-base font-semibold text-fg">
                  {data.config.enabled ? `${data.slots.length} 次 / 天` : '0 次（未启用）'}
                </div>
                <div className="mt-1 text-xs text-fg-muted">
                  {data.config.enabled ? `${data.config.startTime} ~ ${data.config.endTime} (每 ${data.config.intervalMinutes}m)` : '定时任务已停用'}
                </div>
              </div>

              <div className="rounded-lg bg-surface-2 p-4">
                <div className="text-xs text-fg-subtle">上次执行时点</div>
                <div className="mt-1 text-base font-semibold text-fg">
                  {data.lastRunSlot || '暂无记录'}
                </div>
                <div className="mt-1 text-xs text-fg-muted">
                  {data.lastRunAt ? new Date(data.lastRunAt).toLocaleTimeString() : '系统启动后尚无批次'}
                </div>
              </div>

              <div className="rounded-lg bg-surface-2 p-4">
                <div className="text-xs text-fg-subtle">预计下次执行</div>
                <div className="mt-1 text-base font-semibold text-accent-strong">
                  {data.nextRunSlot || '无'}
                </div>
                <div className="mt-1 text-xs text-fg-muted">
                  {data.config.enabled ? '准点增量扫描' : '请先启用任务'}
                </div>
              </div>
            </div>
          </Card>

          {/* 2. 调度策略配置表单 */}
          <Card className="p-5">
            <SectionTitle>2. 调整调用策略</SectionTitle>

            {saveSuccessMsg && (
              <div className="mb-4 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
                ✓ {saveSuccessMsg}
              </div>
            )}
            {saveErrorMsg && (
              <div className="mb-4 rounded-md border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-400">
                ⚠ {saveErrorMsg}
              </div>
            )}

            <div className="space-y-5">
              {/* 开关 */}
              <div className="flex items-center gap-3">
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                    className="peer sr-only"
                  />
                  <div className="peer h-6 w-11 rounded-full bg-surface-2 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-line after:bg-white after:transition-all after:content-[''] peer-checked:bg-accent-strong peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
                </label>
                <span className="text-sm font-medium text-fg">
                  {enabled ? '启用后台自动定时批量分析' : '暂停后台自动定时批量分析'}
                </span>
                <span className="text-xs text-fg-muted">（停用后仅保留手动单单分析）</span>
              </div>

              {/* 营业时段选择 */}
              <div className="rounded-lg border border-line bg-surface-2/40 p-4">
                <div className="mb-3 text-sm font-medium text-fg">营业时段范围（上海时区）</div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-fg-muted">从</span>
                    <input
                      type="time"
                      value={startTime}
                      disabled={!enabled}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-fg shadow-sm disabled:opacity-50"
                    />
                  </div>
                  <span className="text-sm text-fg-muted">至</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={endTime}
                      disabled={!enabled}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-fg shadow-sm disabled:opacity-50"
                    />
                    <span className="text-sm text-fg-muted">止</span>
                  </div>
                  <span className="text-xs text-fg-subtle">（夜间时段自动静默，早晨首批将集中处理夜间增量）</span>
                </div>
              </div>

              {/* 运行频次单选 */}
              <div className="rounded-lg border border-line bg-surface-2/40 p-4">
                <div className="mb-3 text-sm font-medium text-fg">调度触发频率</div>
                <div className="flex flex-wrap gap-4">
                  {PRESET_INTERVALS.map((p) => (
                    <label
                      key={p.value}
                      className={`flex cursor-pointer items-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium transition-colors ${
                        !isCustomInterval && intervalMinutes === p.value
                          ? 'border-accent-strong bg-accent-soft text-accent-strong'
                          : 'border-line bg-surface text-fg hover:bg-surface-2'
                      } ${!enabled ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      <input
                        type="radio"
                        name="intervalPreset"
                        disabled={!enabled}
                        checked={!isCustomInterval && intervalMinutes === p.value}
                        onChange={() => handlePresetChange(p.value)}
                        className="sr-only"
                      />
                      <span>{p.label}</span>
                    </label>
                  ))}

                  {/* 自定义频率 */}
                  <label
                    className={`flex cursor-pointer items-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium transition-colors ${
                      isCustomInterval
                        ? 'border-accent-strong bg-accent-soft text-accent-strong'
                        : 'border-line bg-surface text-fg hover:bg-surface-2'
                    } ${!enabled ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <input
                      type="radio"
                      name="intervalPreset"
                      disabled={!enabled}
                      checked={isCustomInterval}
                      onChange={handleCustomRadio}
                      className="sr-only"
                    />
                    <span>自定义</span>
                    <input
                      type="number"
                      min={5}
                      max={720}
                      disabled={!enabled || !isCustomInterval}
                      value={customMinutesInput}
                      onChange={handleCustomInputChange}
                      className="w-16 rounded border border-line bg-surface px-2 py-0.5 text-center text-sm font-medium text-fg disabled:opacity-50"
                    />
                    <span className="text-xs">分钟</span>
                  </label>
                </div>
                <div className="mt-2 text-xs text-fg-subtle">
                  安全防呆限制：调用间隔最小 5 分钟，最大 720 分钟（12小时）。
                </div>
              </div>

              {/* 动态时点预览 */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-medium text-fg">
                    计划执行时点实时预览
                    <span className="ml-2 text-xs font-normal text-fg-muted">
                      {enabled ? `（根据当前设定共 ${previewSlots.length} 个批次）` : '（已停用，不执行任何批次）'}
                    </span>
                  </div>
                </div>
                {enabled ? (
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-line bg-surface p-3">
                    <div className="flex flex-wrap gap-1.5">
                      {previewSlots.map((slot) => (
                        <span
                          key={slot}
                          className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-strong"
                        >
                          {slot}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-fg-subtle">
                    任务处于暂停状态，无计划执行批次。
                  </div>
                )}
              </div>

              {/* 操作按钮区 */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave()}
                  className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? '正在保存并热生效…' : '保存配置并立即生效'}
                </button>

                <button
                  type="button"
                  disabled={saving}
                  onClick={handleResetDefault}
                  className="rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium text-fg transition hover:bg-surface-2 disabled:opacity-50"
                >
                  恢复推荐默认值
                </button>
              </div>
            </div>
          </Card>

          {/* 3. 业务运行与冲突隔离说明 */}
          <Card className="p-5">
            <SectionTitle>3. 调度与调用规则说明</SectionTitle>
            <div className="space-y-2 text-sm text-fg-muted">
              <p>
                • <strong>增量安全机制</strong>：时点到达时，仅扫描分析<strong>自上次分析后存在新的企微/微信文本消息或完成转写录音</strong>的订单。无新内容的订单不会调用千问，不消耗 Token。
              </p>
              <p>
                • <strong>单单手动分析完全独立</strong>：专员在订单详情页随时点击【重新分析】不受此时间限制，即点即查；且手动分析后会自动推进该订单的水位戳，下一个批处理到来时自动跳过，<strong>两者完全互补，绝不冲突</strong>。
              </p>
              <p>
                • <strong>单值时点防重</strong>：引擎采用单值精准防重设计，无论设置为 15 分钟、30 分钟还是 1 小时，每到达一个时点精确触发 1 轮，杜绝重复调用。
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
