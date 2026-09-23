import { useEffect, useState, useMemo } from 'react'
import { adminApi } from '../api/client'
import type { SystemReminderConfig, SystemReminderRule } from '../api/types'
import { Card, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'

const CATEGORY_STYLES: Record<string, { badge: string; border: string }> = {
  日常提醒: {
    badge: 'bg-emerald-50 text-emerald-800 border-emerald-300',
    border: 'border-emerald-200'
  },
  约住院服务: {
    badge: 'bg-blue-50 text-blue-800 border-blue-300',
    border: 'border-blue-200'
  },
  陪诊服务: {
    badge: 'bg-amber-50 text-amber-800 border-amber-300',
    border: 'border-amber-200'
  },
  住院陪护: {
    badge: 'bg-purple-50 text-purple-800 border-purple-300',
    border: 'border-purple-200'
  }
}

export default function SystemRemindersPage(): React.JSX.Element {
  const [config, setConfig] = useState<SystemReminderConfig | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<string>('全部')

  async function load(): Promise<void> {
    setError(null)
    try {
      setConfig(await adminApi.systemReminderConfig())
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error(String(reason)))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const categories = useMemo(() => {
    if (!config) return ['全部']
    const set = new Set(config.rules.map((r) => r.category))
    return ['全部', ...Array.from(set)]
  }, [config])

  const filteredRules = useMemo(() => {
    if (!config) return []
    if (selectedCategory === '全部') return config.rules
    return config.rules.filter((r) => r.category === selectedCategory)
  }, [config, selectedCategory])

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      <PageHeader
        title="系统提醒说明"
        subtitle="集中展示系统定时提醒、业务流转节点自动预警、桌面弹窗通知样式及员工协同闭环机制。"
      />

      {!config && !error && <LoadingBlock label="正在加载系统提醒说明…" />}
      {error && <ErrorBlock error={error} onRetry={() => void load()} />}

      {config && (
        <div className="space-y-6">
          {/* 1. 核心提醒时点与业务机制全览 */}
          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-5 pb-3.5 border-b border-line">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent-strong text-base font-bold">
                    1
                  </span>
                  全系统提醒机制与触发时点总览
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  覆盖日常录音回传广播、约住院周期跟进、陪诊 7 大时效预警节点（含出工短信与异常即时报警）及住院陪护全周期关怀
                </p>
              </div>
              <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 border border-slate-200">
                共 4 大业务类别 · 11 种精准提醒机制
              </span>
            </div>

            {/* 4 大板块 2x2 全览网格 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4.5">
              {/* 板块 1: 日常提醒 */}
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4.5 shadow-2xs flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-600 text-white text-xs font-bold">
                        日
                      </span>
                      <h3 className="font-bold text-base text-emerald-950">日常录音上传提醒（广播）</h3>
                    </div>
                    <span className="text-xs font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded border border-emerald-300">
                      接收对象：在岗全员
                    </span>
                  </div>
                  <div className="space-y-2.5 text-sm">
                    <div className="rounded-lg bg-white/90 border border-emerald-200/80 p-3 shadow-2xs">
                      <div className="flex items-center gap-2 font-bold text-slate-900 mb-1">
                        <span className="px-2 py-0.5 text-xs font-bold bg-emerald-100 text-emerald-800 rounded">
                          每天 11:30
                        </span>
                        <span>上午录音与通话记录上传提醒</span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        提醒内容：<code className="text-emerald-900 font-medium">请打开手机app上传通话录音和通话记录</code>
                      </p>
                    </div>

                    <div className="rounded-lg bg-white/90 border border-emerald-200/80 p-3 shadow-2xs">
                      <div className="flex items-center gap-2 font-bold text-slate-900 mb-1">
                        <span className="px-2 py-0.5 text-xs font-bold bg-emerald-100 text-emerald-800 rounded">
                          每天 17:30
                        </span>
                        <span>下午录音与通话记录上传提醒</span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        提醒内容：<code className="text-emerald-900 font-medium">请打开手机app上传通话录音和通话记录</code>
                      </p>
                    </div>

                    <div className="rounded-lg bg-emerald-100/50 border border-emerald-200/60 p-2.5 text-xs text-emerald-900">
                      <span className="font-bold">⏱ 失效机制：</span>
                      <span> 仅当天有效。跨天后自动标记为失效，次日打开客户端绝不补发前日提醒。</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 板块 2: 约住院服务 */}
              <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4.5 shadow-2xs flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-600 text-white text-xs font-bold">
                        住
                      </span>
                      <h3 className="font-bold text-base text-blue-950">约住院服务（周期跟进）</h3>
                    </div>
                    <span className="text-xs font-bold text-blue-800 bg-blue-100 px-2 py-0.5 rounded border border-blue-300">
                      接收对象：责任客户经理
                    </span>
                  </div>
                  <div className="space-y-2.5 text-sm">
                    <div className="rounded-lg bg-white/90 border border-blue-200/80 p-3 shadow-2xs">
                      <div className="flex items-center gap-2 font-bold text-slate-900 mb-1">
                        <span className="px-2 py-0.5 text-xs font-bold bg-blue-100 text-blue-800 rounded">
                          每满 3 天 09:00
                        </span>
                        <span>约住院排队跟进提醒</span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        触发条件：步骤处于待处理/进行中且未完成。自激活起每满 3 天上午 09:00 提醒一次。
                      </p>
                      <p className="text-xs text-slate-600 mt-1">
                        提醒内容：<code className="text-blue-900 font-medium">客户意向的住院时间前还没有预约成功，请关注！</code>
                      </p>
                    </div>

                    <div className="rounded-lg bg-blue-100/50 border border-blue-200/60 p-2.5 text-xs text-blue-900">
                      <span className="font-bold">⚙ 去重机制：</span>
                      <span> 按订单与当天日期去重，同一订单在满足周期的当天仅生成 1 次提醒。</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 板块 3: 陪诊服务 (7 大节点) */}
              <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4.5 shadow-2xs">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-600 text-white text-xs font-bold">
                      陪
                    </span>
                    <h3 className="font-bold text-base text-amber-950">陪诊服务（7 个时效节点与闭环预警）</h3>
                  </div>
                  <span className="text-xs font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded border border-amber-300">
                    接收对象：责任客户经理
                  </span>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-amber-100 text-amber-900 rounded shrink-0">
                        前置满 1 小时
                      </span>
                      <span>① 陪诊人员未落实预警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      前置完成满 1 小时未指派陪诊人（库表+AI均无）。提醒：<code className="text-amber-900 font-medium">陪诊人员没有落实，请关注！</code>
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-rose-100 text-rose-800 rounded shrink-0">
                        前天 11:00
                      </span>
                      <span>② 出工确认短信异常/无号码报警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      11:00 下发短信成功则等待反馈；若发送失败或无有效手机号，<code className="text-rose-900 font-medium">立即向客户经理报警</code>，促人工介入。
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-amber-100 text-amber-900 rounded shrink-0">
                        前天 13:00
                      </span>
                      <span>③ 陪诊人员未第1次反馈预警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      门禁：须 11:00 成功发短信。截至 13:00 仍未反馈提醒：<code className="text-amber-900 font-medium">陪诊人员没有第一次反馈信息，请关注！</code>
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-red-100 text-red-800 rounded shrink-0">
                        前天 实时
                      </span>
                      <span>④ 前一天反馈【无法出工】预警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      陪诊员前一天明确反馈无法出工。提醒：<code className="text-red-900 font-medium">陪诊人员反馈【无法出工】（原因：xxx），请立即处理！</code>
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-rose-100 text-rose-800 rounded shrink-0">
                        当天 07:00
                      </span>
                      <span>⑤ 当天打卡短信异常/无号码紧急报警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      07:00 下发打卡短信成功则等待反馈；若发送失败或无手机号，<code className="text-rose-900 font-medium">立即紧急报警</code>通知客户经理！
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-amber-100 text-amber-900 rounded shrink-0">
                        当天 07:20
                      </span>
                      <span>⑥ 当天未反馈出工信息预警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      门禁：须 07:00 成功发短信。截至 07:20 仍未打卡提醒：<code className="text-amber-900 font-medium">陪诊人员没有第一次反馈信息，请关注！</code>
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-red-100 text-red-800 rounded shrink-0">
                        当天 实时紧急
                      </span>
                      <span>⑦ 当天反馈【无法出工】极速报警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      陪诊员当天反馈无法出工。提醒：<code className="text-red-900 font-medium">陪诊人员当天反馈【无法出工】（原因：xxx），请紧急处理！</code>
                    </p>
                  </div>
                </div>
              </div>

              {/* 板块 4: 住院陪护 */}
              <div className="rounded-xl border border-purple-200 bg-purple-50/40 p-4.5 shadow-2xs flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-purple-600 text-white text-xs font-bold">
                        护
                      </span>
                      <h3 className="font-bold text-base text-purple-950">住院陪护（护工服务流转）</h3>
                    </div>
                    <span className="text-xs font-bold text-purple-800 bg-purple-100 px-2 py-0.5 rounded border border-purple-300">
                      接收对象：责任客户经理
                    </span>
                  </div>
                  <div className="space-y-2.5 text-sm">
                    <div className="rounded-lg bg-white/90 border border-purple-200/80 p-3 shadow-2xs">
                      <div className="flex items-center gap-2 font-bold text-slate-900 mb-1">
                        <span className="px-2 py-0.5 text-xs font-bold bg-purple-100 text-purple-800 rounded">
                          每满 2 天 09:00
                        </span>
                        <span>确认护工开始时间提醒</span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        触发条件：客户入院后护工进场时间未确定，自激活起每满 2 天上午 09:00 提醒。
                      </p>
                      <p className="text-xs text-slate-600 mt-1">
                        提醒内容：<code className="text-purple-900 font-medium">客户处于住院期间，请定期关注客户满意度情况！</code>
                      </p>
                    </div>

                    <div className="rounded-lg bg-white/90 border border-purple-200/80 p-3 shadow-2xs">
                      <div className="flex items-center gap-2 font-bold text-slate-900 mb-1">
                        <span className="px-2 py-0.5 text-xs font-bold bg-purple-100 text-purple-800 rounded">
                          结束前 2 工作日 09:00
                        </span>
                        <span>住院陪护结束前 2 工作日提醒</span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        触发条件：根据护工结束日期自动扣除周末与法定节假日，提前 2 个工作日上午 09:00 提醒。
                      </p>
                      <p className="text-xs text-slate-600 mt-1">
                        提醒内容：<code className="text-purple-900 font-medium">客户出院时间到了，请关注客户后续行程！</code>
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* 2. 提醒业务规则明细 */}
          <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-6 pb-4 border-b border-line">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent-strong text-base font-bold">
                    2
                  </span>
                  系统业务提醒规则明细
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  全流程覆盖日常录音上传、住院排队、陪诊派单及护工到期预警
                </p>
              </div>

              {/* 分类筛选标签 */}
              <div className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 p-1 text-sm">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      selectedCategory === cat
                        ? 'bg-surface text-accent-strong shadow-2xs font-bold'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* 规则卡片列表 */}
            <div className="space-y-5">
              {filteredRules.map((rule, idx) => (
                <RuleDetailCard key={idx} rule={rule} index={idx + 1} />
              ))}
            </div>
          </Card>

          {/* 3. 桌面端悬浮通知与交互动作 */}
          <Card className="p-6">
            <h2 className="text-lg font-bold text-slate-900 mb-2 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent-strong text-base font-bold">
                3
              </span>
              桌面端悬浮通知与交互操作
            </h2>
            <p className="text-sm text-slate-600 mb-5 leading-relaxed">
              {config.clientNotification.display}
            </p>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-line bg-surface-2/60 p-4.5 shadow-2xs">
                <div className="font-bold text-base text-slate-900 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-100 text-blue-700 text-sm">
                    🔍
                  </span>
                  点击单号 / 一键复制
                </div>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                  单号高亮可点击，点击直接在工作台过滤定位该订单；点击复制图标可快速复制单号到剪贴板。
                </p>
              </div>

              <div className="rounded-xl border border-line bg-surface-2/60 p-4.5 shadow-2xs">
                <div className="font-bold text-base text-slate-900 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-100 text-amber-700 text-sm">
                    ⏱
                  </span>
                  延迟 10 分钟
                </div>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                  若员工正在通话或忙碌中，点击后系统将在 10 分钟后再次弹窗提醒，避免遗漏。
                </p>
              </div>

              <div className="rounded-xl border border-line bg-surface-2/60 p-4.5 shadow-2xs">
                <div className="font-bold text-base text-slate-900 flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 text-sm">
                    ✓
                  </span>
                  标记已完成
                </div>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                  员工核实并处理完毕后点击，该提醒归档为已完成状态，弹窗自动关闭并形成业务闭环。
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

function RuleDetailCard({ rule, index }: { rule: SystemReminderRule; index: number }): React.JSX.Element {
  const theme = CATEGORY_STYLES[rule.category] || {
    badge: 'bg-surface-2 text-slate-700 border-line',
    border: 'border-line'
  }

  // 渲染真实的弹窗多行字段结构
  const renderFormattedPopupContent = (rawContent: string) => {
    const lines = rawContent.replace(/\\n/g, '\n').split('\n').filter(Boolean)
    return (
      <div className="space-y-1.5 text-[13px] leading-relaxed">
        {lines.map((line, idx) => {
          const colonIdx = line.indexOf(':') > -1 ? line.indexOf(':') : line.indexOf('：')
          if (colonIdx > -1) {
            const label = line.slice(0, colonIdx).trim()
            const val = line.slice(colonIdx + 1).trim()
            const isOrderField = label.includes('单号') || label.includes('订单')

            return (
              <div key={idx} className="flex items-start text-xs sm:text-[13px]">
                <span className="w-18 shrink-0 text-slate-500 font-medium">{label}：</span>
                {isOrderField ? (
                  <div className="flex-1 flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-blue-600 font-bold hover:underline cursor-pointer">
                      {val}
                    </span>
                    <span className="text-slate-400 text-[10px] bg-slate-100 px-1 py-0.5 rounded border border-slate-200">
                      复制
                    </span>
                  </div>
                ) : (
                  <span className="flex-1 font-bold text-slate-900">{val}</span>
                )}
              </div>
            )
          }
          return (
            <div key={idx} className="font-bold text-slate-900">
              {line}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className={`rounded-xl border ${theme.border} bg-surface p-5 shadow-2xs hover:shadow-xs transition-shadow`}>
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 pb-3 mb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-xs font-bold text-slate-600 border border-line">
            {index}
          </span>
          <span className={`rounded-md border px-2.5 py-0.5 text-xs font-bold ${theme.badge}`}>
            {rule.category}
          </span>
          <h3 className="font-bold text-base text-slate-900">{rule.name}</h3>
        </div>

        {/* 接收对象 */}
        <div className="flex items-center gap-1.5 text-sm bg-slate-100 text-slate-800 font-medium px-3 py-1 rounded-lg border border-slate-200">
          <span className="text-slate-500">接收对象：</span>
          <strong className="text-slate-900 font-bold">{rule.target}</strong>
        </div>
      </div>

      {/* 左右分栏：左侧技术判定规则与防重机制，右侧真实弹窗样式预览 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* 左侧：技术匹配与触发规则 (7 列) */}
        <div className="lg:col-span-7 space-y-3">
          {/* 触发时机 */}
          <div>
            <div className="font-bold text-xs text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1.5">
              <span>⏱</span> 触发时机与时点
            </div>
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5 text-sm font-bold text-slate-900 leading-relaxed">
              {rule.trigger}
            </div>
          </div>

          {/* 技术匹配条件清单 */}
          <div>
            <div className="font-bold text-xs text-slate-500 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
              <span>⚙️</span> 技术匹配与判定规则
            </div>
            <div className="rounded-lg bg-slate-50/70 border border-slate-200/80 p-3 space-y-2">
              {(rule.technicalConditions || []).map((cond, cIdx) => (
                <div key={cIdx} className="flex items-start gap-2 text-sm text-slate-800 leading-relaxed">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong text-[11px] font-bold mt-0.5">
                    {cIdx + 1}
                  </span>
                  <span>{cond}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 防重机制 */}
          {rule.dedupeRule && (
            <div className="rounded-lg bg-amber-50/60 border border-amber-200/70 p-2.5 text-xs text-amber-950 flex items-start gap-2">
              <span className="font-bold text-amber-900 shrink-0 mt-0.5">🛡 幂等去重规则：</span>
              <span className="leading-relaxed text-amber-900/90">{rule.dedupeRule}</span>
            </div>
          )}
        </div>

        {/* 右侧：100% 真实还原桌面端弹窗浮窗样式 (5 列) */}
        <div className="lg:col-span-5">
          <div className="font-bold text-xs text-slate-500 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
            <span>💬</span> 桌面端弹窗预览（与实际客户端 100% 一致）
          </div>

          {/* 桌面端弹窗卡片外观 */}
          <div
            className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-lg relative overflow-hidden"
            style={{
              boxShadow: '0 12px 28px -6px rgba(0, 0, 0, 0.15), 0 0 1px rgba(0,0,0,0.1)'
            }}
          >
            {/* 顶部状态栏 */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-2 mb-2">
              <div className="flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-red-50 text-red-700 border border-red-200">
                  <span>⚠️</span> 系统提醒
                </span>
                <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-bold bg-red-100 text-red-700 animate-pulse">
                  待处理
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-slate-400">
                <span className="text-xs font-medium">刚刚</span>
                <span className="text-xs font-bold hover:text-slate-600 cursor-pointer">✕</span>
              </div>
            </div>

            {/* 中间内容区域（真实解析展示多行内容） */}
            <div className="my-2 bg-slate-50 p-2.5 rounded-lg border border-slate-200/80">
              {renderFormattedPopupContent(rule.content)}
            </div>

            {/* 底部操作按钮 */}
            <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 gap-2">
              <button
                type="button"
                className="flex-1 rounded-lg border border-slate-200 bg-slate-50 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-100"
              >
                延后 10 分钟
              </button>
              <button
                type="button"
                className="flex-1 rounded-lg bg-emerald-600 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-emerald-700"
              >
                已完成
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

