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
        subtitle="展示自动生成的提醒规则、短信异常、桌面弹窗及关闭方式；员工手工创建的备忘也使用同一待办和弹窗。"
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
                  自动提醒机制与触发时点总览
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  覆盖日常录音上传、约住院周期跟进、陪诊 7 类提醒及住院护工 2 类提醒；手工备忘不计入下方 11 类自动提醒
                </p>
              </div>
              <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 border border-slate-200">
                共 4 大业务类别 · 11 类自动提醒
              </span>
            </div>

            <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              时区：{config.schedule.timeZone}；{config.schedule.scanInterval}；{config.schedule.clientPollInterval || '客户端按需查询到期提醒'}。
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
                      接收对象：所有启用员工
                    </span>
                  </div>
                  <div className="space-y-2.5 text-sm">
                    <div className="rounded-lg bg-white/90 border border-emerald-200/80 p-3 shadow-2xs">
                      <div className="flex items-center gap-2 font-bold text-slate-900 mb-1">
                        <span className="px-2 py-0.5 text-xs font-bold bg-emerald-100 text-emerald-800 rounded">
                          每天 {config.schedule.dailyUploadTimes?.[0] || '11:30'}
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
                          每天 {config.schedule.dailyUploadTimes?.[1] || '17:30'}
                        </span>
                        <span>下午录音与通话记录上传提醒</span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        提醒内容：<code className="text-emerald-900 font-medium">请打开手机app上传通话录音和通话记录</code>
                      </p>
                    </div>

                    <div className="rounded-lg bg-emerald-100/50 border border-emerald-200/60 p-2.5 text-xs text-emerald-900">
                      <span className="font-bold">⏱ 生成与失效：</span>
                      <span> {config.schedule.dailyUploadDescription}</span>
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
                        触发条件：步骤处于待处理/进行中。从步骤激活时间起每满 3 个日历日的周期日 09:00 后提醒；缺少激活时间时按开始、步骤创建、订单创建时间计算，错过周期日不补建。
                      </p>
                      <p className="text-xs text-slate-600 mt-1">
                        提醒内容：<code className="text-blue-900 font-medium">客户意向的住院时间前还没有预约成功，请关注！</code>
                      </p>
                    </div>

                    <div className="rounded-lg bg-blue-100/50 border border-blue-200/60 p-2.5 text-xs text-blue-900">
                      <span className="font-bold">⚙ 去重机制：</span>
                      <span> 每个订单复用一条提醒记录；进入新的 3 天周期时更新并重新提醒。步骤重新开始或基准时间变更时关闭旧周期；订单不再有符合条件的约住院步骤，或订单取消、完结后关闭。</span>
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
                      前置步骤完成满 1 小时后，若正式陪诊明细中仍无非空 PZR 且陪诊步骤待处理或进行中，则提醒；代码只检查非空，不校验人员字典，也不把 AI 候选当作已指派。出现非空 PZR、订单结束或不再存在符合条件的前置和陪诊步骤时关闭；取消单个步骤但其他步骤仍符合条件时不一定关闭。有就诊日期时过日失效，无日期时不按固定天数失效。提醒：<code className="text-amber-900 font-medium">陪诊人员没有落实，请关注！</code>
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-rose-100 text-rose-800 rounded shrink-0">
                        前一天 11:00
                      </span>
                      <span>② 出工确认短信异常/无号码报警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      逐条读取 PZR 非空的正式陪诊明细，以 ZJ 区分安排；服务日期匹配次日的明细分别发送。两套短信模板都配置完整且短信已启用、密钥齐全时才发送；错过 11:00、配置缺失、发送失败或无有效手机号则<code className="text-rose-900 font-medium">提醒客户经理</code>人工联系。发送请求 30 秒超时；中断超过 5 分钟核对明细对应流水，成功则关闭该明细异常提醒，失败或结果未知时提醒人工；不自动补发。
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-amber-100 text-amber-900 rounded shrink-0">
                        前一天 13:00
                      </span>
                      <span>③ 陪诊人员未第1次反馈预警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      门禁：按 ZJ 分别检查正式陪诊明细；日期匹配次日且该明细 11:00 短信发送成功后，13:00 才检查对应陪诊人、服务日和明细的反馈。收到该明细反馈、换人改期或服务日结束后关闭：<code className="text-amber-900 font-medium">陪诊人员没有第一次反馈信息，请关注！</code>
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-red-100 text-red-800 rounded shrink-0">
                        反馈提交触发
                      </span>
                      <span>④ 前一天反馈【无法出工】预警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      前一天“无法出工”反馈提交后核对当前正式陪诊人和次日服务日期，符合条件立即生成；定时扫描只读取当天、当前陪诊人及服务日的反馈。客户端约每 15 秒查询一次，发现后弹窗；后续确认、换人改期或服务日结束后关闭：<code className="text-red-900 font-medium">陪诊人员反馈【无法出工】（原因：xxx），请立即处理！</code>
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
                      逐条读取 PZR 非空的正式陪诊明细，以 ZJ 区分安排；服务日期匹配当日的明细分别发送。两套短信模板都配置完整且短信已启用、密钥齐全时才发送；错过 07:00、配置缺失、发送失败或无有效手机号则<code className="text-rose-900 font-medium">提醒客户经理</code>人工联系。发送请求 30 秒超时；中断超过 5 分钟核对明细对应流水，成功则关闭该明细异常提醒，失败或结果未知时提醒人工；不自动补发。
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
                      门禁：按 ZJ 分别检查正式陪诊明细；日期匹配当日且该明细 07:00 短信发送成功后，07:20 才检查对应陪诊人、服务日和明细的反馈。收到该明细反馈、换人改期或服务日结束后关闭：<code className="text-amber-900 font-medium">陪诊人员没有第一次反馈信息，请关注！</code>
                    </p>
                  </div>

                  <div className="rounded-lg bg-white/90 border border-amber-200/80 p-2.5 shadow-2xs">
                    <div className="flex items-center gap-2 font-bold text-slate-900 text-xs sm:text-sm">
                      <span className="px-1.5 py-0.5 text-[11px] font-bold bg-red-100 text-red-800 rounded shrink-0">
                        反馈提交触发
                      </span>
                      <span>⑦ 当天反馈【无法出工】极速报警</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      当天“无法出工”反馈提交后核对当前正式陪诊人和当日服务日期，符合条件立即生成；定时扫描只读取当天、当前陪诊人及服务日的反馈。客户端约每 15 秒查询一次，发现后弹窗；后续确认、换人改期或服务日结束后关闭：<code className="text-red-900 font-medium">陪诊人员当天反馈【无法出工】（原因：xxx），请紧急处理！</code>
                    </p>
                  </div>
                </div>
                <div className="mt-3 rounded-lg bg-amber-100/60 border border-amber-200/70 p-2.5 text-xs text-amber-950">
                  <span className="font-bold">闭环规则：</span>
                  <span> 陪诊反馈按当前正式人员、服务日期和当天批次识别；提交前重新核对正式 PZR、BBQ_FW 及批次日期，不符合时拒绝提交。旧人员或旧日期的反馈与短信流水不能替新批次作证。换人、改期或步骤结束时关闭对应旧提醒；人工标记完成会关闭当前提醒。</span>
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
                        触发条件：住院护工步骤待处理或进行中，开始时间和日期均未确定；从步骤激活时间起每满 2 个日历日的周期日 09:00 后提醒，缺少激活时间时按订单创建时间计算，错过周期日不补建。开始时间或日期任一补齐、步骤结束、订单取消或完结后自动关闭。
                      </p>
                      <p className="text-xs text-slate-600 mt-1">
                        提醒内容：<code className="text-purple-900 font-medium">护工开始时间尚未确定，请跟进确认！</code>
                      </p>
                    </div>

                    <div className="rounded-lg bg-purple-100/50 border border-purple-200/60 p-2.5 text-xs text-purple-900">
                      <span className="font-bold">⚙ 去重机制：</span>
                      <span> 同一订单复用一条提醒记录；每满 2 天进入新周期时才重新提醒。护工步骤重新开始或基准时间变更时，先关闭旧周期提醒。</span>
                    </div>

                    <div className="rounded-lg bg-white/90 border border-purple-200/80 p-3 shadow-2xs">
                      <div className="flex items-center gap-2 font-bold text-slate-900 mb-1">
                        <span className="px-2 py-0.5 text-xs font-bold bg-purple-100 text-purple-800 rounded">
                          结束前 2 工作日 09:00
                        </span>
                        <span>住院陪护结束前 2 工作日提醒</span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        触发条件：住院护工步骤待处理或进行中；结束日期先取寰宇订单 BBQ_QDFW，为空才取 DATE_QDFW；按已维护的工作日日历倒推 2 个工作日，当天 09:00 后生成一次。日期变更、清空、无法解析、服务日已过、步骤结束或订单取消/完结时关闭旧提醒。后台每年 12 月 1 日至 31 日检查下一年度节假日安排，发布后同步，未发布或异常时次日重试。
                      </p>
                      <p className="text-xs text-slate-600 mt-1">
                        提醒内容：<code className="text-purple-900 font-medium">客户出院时间到了，请关注客户后续行程！</code>
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-700">
              一次性提醒创建时绑定当时的订单责任客户经理；后续更换负责人不会自动迁移已有提醒。周期提醒在下一个符合条件的周期更新接收人。员工手工创建的备忘也进入同一待办和弹窗，但不属于上面的 11 类自动提醒。
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
            {config.clientNotification.validity && (
              <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50/70 px-4 py-3 text-sm text-blue-950">
                <span className="font-bold">提醒关闭与再次弹出：</span>
                <span> {config.clientNotification.validity}</span>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-3">
              {config.clientNotification.actions.map((action, index) => (
                <div key={action.name} className="rounded-xl border border-line bg-surface-2/60 p-4.5 shadow-2xs">
                  <div className="font-bold text-base text-slate-900 flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-100 text-blue-700 text-sm">
                      {['🔍', '⏱', '✓'][index] || '•'}
                    </span>
                    {action.name}
                  </div>
                  <p className="mt-2 text-sm text-slate-600 leading-relaxed">{action.detail}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-700">
              提醒记录：{config.storage.table}（{config.storage.fields}）。
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
            <span>💬</span> 桌面端弹窗预览（样式示意）
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

