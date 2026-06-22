import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchMaterials,
  fetchOrderAggregate,
  fetchOrderDetail,
  addTextMaterial,
  addImageMaterial,
  deleteMaterial,
  fetchOrderBrief,
  refreshOrderBrief,
  type Material,
  type Order,
  type OrderAttachment,
  type OrderCall,
  type OrderMessage,
  type OrderDetailResponse,
  type OrderBrief
} from '../api'
import { bizType, sourceStyle, stageIndexOf, LIFECYCLE_STAGES } from '../lib/orderMapping'

type LifecycleStageKey = 'claimed' | 'communication' | 'delivery' | 'settlement' | 'ending'
type LifecycleEventKind = 'status' | 'manual_note' | 'image' | 'message' | 'call' | 'ai_summary'

interface LifecycleEvent {
  id: string
  stage: LifecycleStageKey
  kind: LifecycleEventKind
  title: string
  summary?: string
  occurredAt: string
  imageUrl?: string | null
  channel?: 'wechat' | 'wxwork' | 'manual' | 'call'
  senderType?: 'self' | 'other' | 'system' | 'unknown'
  senderName?: string | null
  call?: OrderCall
}

const STAGE_KEYS: LifecycleStageKey[] = ['claimed', 'communication', 'delivery', 'settlement', 'ending']

/**
 * 订单详情（聚焦全屏视图）：顶部返回+面包屑+信息chip+状态；
 * 左中=服务生命周期阶段轴（含过程数据）；右侧=数据补录 / AI关键信息 标签页。
 */
export default function OrderDetailPage({
  order,
  onBack
}: {
  order: Order
  onBack: () => void
}): React.JSX.Element {
  const [materials, setMaterials] = useState<Material[]>([])
  const [materialsError, setMaterialsError] = useState<string | null>(null)
  const [captureEvents, setCaptureEvents] = useState<LifecycleEvent[]>([])
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [callEvents, setCallEvents] = useState<LifecycleEvent[]>([])
  const [callError, setCallError] = useState<string | null>(null)
  const [detailResp, setDetailResp] = useState<OrderDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const stage = stageIndexOf(order)
  const src = sourceStyle(order)
  const lifecycleEvents = useMemo(
    () => buildLifecycleEvents(materials, captureEvents, callEvents),
    [materials, captureEvents, callEvents]
  )

  const reload = useCallback(() => {
    if (order.id <= 0) {
      setMaterials([])
      setMaterialsError(null)
      return Promise.resolve()
    }
    return fetchMaterials(order.id)
      .then((list) => {
        setMaterials(list)
        setMaterialsError(null)
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : '加载素材失败'
        setMaterialsError(msg)
        throw e
      })
  }, [order.id])

  useEffect(() => {
    void reload().catch(() => undefined)
  }, [reload])

  useEffect(() => {
    let alive = true
    if (order.id <= 0) {
      setDetailResp(null)
      setDetailError(null)
      return
    }
    setDetailLoading(true)
    fetchOrderDetail(order.id)
      .then((resp) => {
        if (!alive) return
        setDetailResp(resp)
        setDetailError(null)
      })
      .catch((e) => {
        if (!alive) return
        setDetailResp(null)
        setDetailError(e instanceof Error ? e.message : '加载订单详情失败')
      })
      .finally(() => {
        if (alive) setDetailLoading(false)
      })
    return () => {
      alive = false
    }
  }, [order.id])

  // 通话 + 采集消息都来自后端聚合接口：消息已跨帧去重、按 sortTime 排好（时间链），
  // 不再读本地采集库（本地只剩整帧去重，不再保留成品消息）。
  useEffect(() => {
    let alive = true
    if (order.id <= 0) {
      setCallEvents([])
      setCallError(null)
      setCaptureEvents([])
      setCaptureError(null)
      return
    }
    fetchOrderAggregate(order.id)
      .then((resp) => {
        if (!alive) return
        setCallEvents(buildCallLifecycleEvents(resp.calls ?? []))
        setCallError(null)
        setCaptureEvents(buildBackendMessageEvents(resp.messages ?? []))
        setCaptureError(null)
      })
      .catch((e) => {
        if (!alive) return
        const msg = e instanceof Error ? e.message : '加载订单聚合数据失败'
        setCallEvents([])
        setCallError(msg)
        setCaptureEvents([])
        setCaptureError(msg)
      })
    return () => {
      alive = false
    }
  }, [order.id])

  return (
    <div className="h-full flex flex-col bg-surface-bg text-text-main overflow-hidden">
      {/* 顶部：返回 + 面包屑 + 信息 chip + 状态 */}
      <header className="h-16 shrink-0 flex items-center justify-between px-6 bg-white border-b border-border-subtle shadow-sm z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="p-2 rounded-full hover:bg-surface-container-low text-text-muted hover:text-text-main transition-colors"
            title="返回"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>arrow_back</span>
          </button>
          <div className="h-6 w-px bg-border-subtle" />
          <nav className="flex items-center text-body-sm text-text-muted gap-1.5 min-w-0">
            <button onClick={onBack} className="hover:text-primary transition-colors">工作台</button>
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>chevron_right</span>
            <span className="text-text-main font-semibold truncate font-mono-data">{order.sourceOrderNo}</span>
          </nav>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <InfoChip label="客户" value={order.customerName} />
          <InfoChip label="业务类型" value={bizType(order)} />
          <InfoChip
            label="来源"
            value={
              <span className={'inline-flex items-center gap-0.5 ' + src.text}>
                <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>verified</span>
                {src.label}
              </span>
            }
          />
          <InfoChip
            label="医院 / 科室"
            value={order.hospital ? order.hospital + (order.dept ? ` / ${order.dept}` : '') : '—'}
          />
          <span className="ml-2 px-3 py-1.5 bg-primary-container/15 text-primary rounded-full text-body-sm font-semibold whitespace-nowrap">
            {order.status}
          </span>
        </div>
      </header>

      {/* 主体：左中生命周期 + 右侧面板 */}
      <main className="flex-1 flex overflow-hidden min-h-0">
        {/* 左/中：服务生命周期 */}
        <section className="flex-1 overflow-y-auto p-8">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-h2-header mb-8">服务生命周期</h2>
            <div className="relative pl-1">
              {LIFECYCLE_STAGES.map((name, i) => (
                <LifecycleStep
                  key={name}
                  name={name}
                  stageKey={STAGE_KEYS[i]}
                  index={i}
                  current={stage}
                  isLast={i === LIFECYCLE_STAGES.length - 1}
                  timestamp={STAGE_KEYS[i] === 'claimed' ? order.claimedAt || order.createdAt || order.updatedAt : null}
                  events={lifecycleEvents.filter((event) => event.stage === STAGE_KEYS[i])}
                  error={STAGE_KEYS[i] === 'communication' ? [materialsError, captureError, callError].filter(Boolean).join('；') || null : null}
                />
              ))}
            </div>
          </div>
        </section>

        {/* 右：订单详情 / 数据补录 / AI 关键信息 */}
        <RightPanel
          order={order}
          detailResp={detailResp}
          detailLoading={detailLoading}
          detailError={detailError}
          materials={materials}
          onReload={reload}
        />
      </main>
    </div>
  )
}

function InfoChip({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col justify-center px-3 py-1 bg-surface-bg rounded-lg border border-border-subtle max-w-[200px]">
      <span className="text-[10px] text-text-muted">{label}</span>
      <span className="text-body-sm font-semibold text-text-main truncate">{value}</span>
    </div>
  )
}

function buildLifecycleEvents(
  materials: Material[],
  captureEvents: LifecycleEvent[],
  callEvents: LifecycleEvent[]
): LifecycleEvent[] {
  const events: LifecycleEvent[] = []
  for (const m of materials) {
    events.push({
      id: `material-${m.id}`,
      stage: 'communication',
      kind: m.type === 'image' ? 'image' : 'manual_note',
      title: m.type === 'image' ? '沟通截图 / 图片素材' : '手工补录',
      summary: m.type === 'text' ? m.textContent || '' : undefined,
      occurredAt: m.createdAt,
      imageUrl: m.type === 'image' ? m.url : null,
      channel: 'manual'
    })
  }
  events.push(...captureEvents)
  events.push(...callEvents)

  return events.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime())
}

function buildCallLifecycleEvents(calls: OrderCall[]): LifecycleEvent[] {
  return calls.map((call) => ({
    id: `call-${call.id}`,
    stage: 'communication',
    kind: 'call',
    title: callTitle(call),
    summary: call.asrText || undefined,
    occurredAt: call.startedAt,
    channel: 'call',
    call
  }))
}

// 把后端聚合返回的采集消息（已去重、按 sortTime 排好）映射成生命周期事件。
// occurredAt 用 sortTime（= chatTime ?? capturedAt，后端的排序键），保证时间线顺序与后端一致。
// 注：截图是本地 PNG、未上传后端，故这里不再有截图缩略图事件——只展示去重排序后的消息链。
function buildBackendMessageEvents(messages: OrderMessage[]): LifecycleEvent[] {
  return messages.map((m) => {
    const ch: LifecycleEvent['channel'] =
      m.channel === 'wxwork' ? 'wxwork' : m.channel === 'wechat' ? 'wechat' : undefined
    const senderType: LifecycleEvent['senderType'] =
      m.senderType === 'self' || m.senderType === 'other' || m.senderType === 'system'
        ? m.senderType
        : 'unknown'
    const chLabel = ch === 'wxwork' ? '企微' : ch === 'wechat' ? '微信' : '采集'
    const who = senderType === 'system' ? '系统' : senderType === 'self' ? '我' : m.senderName || '对方'
    return {
      id: `msg-${m.id}`,
      stage: 'communication',
      kind: senderType === 'system' ? 'status' : 'message',
      title: `${chLabel} · ${who}`,
      summary: m.contentText,
      occurredAt: m.sortTime ?? m.capturedAt,
      channel: ch,
      senderType,
      senderName: m.senderName
    }
  })
}

function eventIcon(kind: LifecycleEventKind): string {
  switch (kind) {
    case 'status':
      return 'flag'
    case 'image':
      return 'image'
    case 'message':
      return 'forum'
    case 'call':
      return 'call'
    case 'ai_summary':
      return 'smart_toy'
    case 'manual_note':
    default:
      return 'sticky_note_2'
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function callTitle(call: OrderCall): string {
  const contact = call.contactName || call.phone || '未知号码'
  return `${callDirectionLabel(call.direction)} · ${contact} · ${callStatusLabel(call.callStatus)}`
}

function callDirectionLabel(direction: string): string {
  if (direction === 'out' || direction === 'outbound') return '呼出'
  if (direction === 'in' || direction === 'inbound') return '呼入'
  return '通话'
}

function callStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    answered: '已接通',
    missed: '未接',
    rejected: '已拒接',
    outgoing_unanswered: '呼出未接'
  }
  return labels[status] ?? status
}

function formatDuration(seconds: number | null | undefined): string {
  const total = Number(seconds ?? 0)
  if (!Number.isFinite(total) || total <= 0) return '0秒'
  const minutes = Math.floor(total / 60)
  const secs = Math.floor(total % 60)
  if (minutes <= 0) return `${secs}秒`
  return `${minutes}分${secs.toString().padStart(2, '0')}秒`
}

function asrStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '待转写',
    processing: '转写中',
    done: '已转写',
    failed: '转写失败',
    no_recording: '无转写',
    requires_manual: '待人工处理'
  }
  return labels[status] ?? status
}

// ─── 生命周期单步 ───────────────────────────────────────
function LifecycleStep({
  name,
  stageKey,
  index,
  current,
  isLast,
  timestamp,
  events,
  error
}: {
  name: string
  stageKey: LifecycleStageKey
  index: number
  current: number
  isLast: boolean
  timestamp: string | null
  events: LifecycleEvent[]
  error: string | null
}): React.JSX.Element {
  const done = index < current
  const isCurrent = index === current
  const images = events.filter((event) => event.kind === 'image' && event.imageUrl)
  const textEvents = events.filter((event) => event.kind !== 'image')

  return (
    <div className={'relative flex gap-5 ' + (isLast ? '' : 'pb-8')}>
      {/* 竖线 */}
      {!isLast && (
        <div
          className={'absolute left-[15px] top-8 bottom-0 w-px ' + (done ? 'bg-trust-blue' : 'bg-border-subtle')}
        />
      )}
      {/* 节点 */}
      <div className="relative z-10 shrink-0 mt-0.5">
        {done ? (
          <div className="w-8 h-8 rounded-full bg-trust-blue text-white flex items-center justify-center border-2 border-white shadow-sm">
            <span className="material-symbols-outlined filled" style={{ fontSize: '16px' }}>check</span>
          </div>
        ) : isCurrent ? (
          <div className="relative">
            <div className="absolute inset-0 rounded-full bg-trust-blue opacity-20 animate-ping" />
            <div className="w-8 h-8 rounded-full bg-white border-2 border-trust-blue flex items-center justify-center relative z-10">
              <div className="w-3 h-3 rounded-full bg-trust-blue" />
            </div>
          </div>
        ) : (
          <div className="w-8 h-8 rounded-full bg-white border-2 border-outline-variant flex items-center justify-center">
            <div className="w-2 h-2 rounded-full bg-outline-variant" />
          </div>
        )}
      </div>

      {/* 内容 */}
      <div className="flex-1 min-w-0">
        <div className={'pt-1.5 ' + (done || isCurrent ? '' : 'opacity-60')}>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={'text-h3-title ' + (isCurrent ? 'text-primary' : done ? 'text-text-main' : 'text-text-muted')}>
              {name}
            </h3>
            {timestamp && <span className="text-body-sm text-text-muted">{formatDateTime(timestamp)}</span>}
            {isCurrent && (
              <span className="text-label-caps px-2 py-0.5 bg-trust-blue text-white rounded">进行中</span>
            )}
          </div>
        </div>

        {error && (
          <div className="mt-3 bg-error/10 border border-error/20 text-error rounded-lg px-3 py-2 text-body-sm">
            {error}
          </div>
        )}

        {stageKey === 'communication' ? (
          <CommunicationPanel events={events} />
        ) : images.length > 0 && (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {images.slice(0, 8).map((event) => (
              <button
                key={event.id}
                className="shrink-0 w-20 h-16 rounded-lg overflow-hidden border border-border-subtle bg-white"
                title={event.title}
              >
                <img src={event.imageUrl || ''} alt={event.title} className="w-full h-full object-cover" />
              </button>
            ))}
            {images.length > 8 && (
              <div className="shrink-0 w-20 h-16 rounded-lg border border-border-subtle bg-surface-container-low flex items-center justify-center text-body-sm text-text-muted">
                +{images.length - 8}
              </div>
            )}
          </div>
        )}

        {stageKey !== 'communication' && textEvents.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {textEvents.map((event) => (
              <LifecycleEventItem key={event.id} event={event} />
            ))}
          </div>
        )}

      </div>
    </div>
  )
}

// 标签只有 微信/企微/电话/人工录入（各看各的，默认微信）；标签和消息列表下方固定一张
// AI 总结卡（非白底），把所有渠道一起总结——不用切标签也能看到全局要点。
type CommunicationFilter = 'wechat' | 'wxwork' | 'call' | 'manual'

const COMM_TABS: Array<{ key: CommunicationFilter; label: string; icon: string; iconColor: string }> = [
  { key: 'wechat', label: '微信', icon: 'chat', iconColor: 'text-[#07c160]' },
  { key: 'wxwork', label: '企微', icon: 'groups', iconColor: 'text-[#2e7bff]' },
  { key: 'call', label: '电话', icon: 'call', iconColor: 'text-[#00a3a3]' },
  { key: 'manual', label: '人工录入', icon: 'edit_note', iconColor: 'text-[#f59e0b]' }
]

function CommunicationPanel({ events }: { events: LifecycleEvent[] }): React.JSX.Element {
  const [active, setActive] = useState<CommunicationFilter>('wechat')
  const [preview, setPreview] = useState<LifecycleEvent | null>(null)
  const channelEvents = events.filter((event) => (event.channel ?? 'manual') === active)
  const messages = channelEvents.filter((event) => event.kind !== 'image')
  const screenshots = channelEvents.filter((event) => event.kind === 'image' && event.imageUrl)
  const counts = {
    wechat: events.filter((event) => event.channel === 'wechat').length,
    wxwork: events.filter((event) => event.channel === 'wxwork').length,
    call: events.filter((event) => event.channel === 'call').length,
    manual: events.filter((event) => event.channel === 'manual' || !event.channel).length
  }

  return (
    <div className="mt-3 rounded-lg border border-border-subtle bg-surface-container-low overflow-hidden">
      <div className="flex border-b border-border-subtle bg-white overflow-x-auto">
        {COMM_TABS.map((tab) => (
          <CommunicationTab
            key={tab.key}
            label={tab.label}
            icon={tab.icon}
            iconColor={tab.iconColor}
            count={counts[tab.key]}
            active={active === tab.key}
            onClick={() => setActive(tab.key)}
          />
        ))}
      </div>

      <div className="h-72 overflow-y-auto px-3 py-3 bg-[#f3f3f3]">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-body-sm text-text-muted/70">
            暂无沟通记录
          </div>
        ) : (
          <div className="space-y-2">
            {messages.map((event) =>
              event.kind === 'call' ? (
                <CallTimelineItem key={event.id} event={event} />
              ) : (
                <ChatBubble key={event.id} event={event} />
              )
            )}
          </div>
        )}
      </div>

      {/* 固定在标签/列表下方：综合所有渠道的 AI 总结（非白底） */}
      <AiSummaryCard events={events} counts={counts} />

      {screenshots.length > 0 && (
        <div className="border-t border-border-subtle bg-white px-3 py-2">
          <div className="mb-2 text-[11px] font-medium text-text-muted">截图</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {screenshots.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => setPreview(event)}
                className="shrink-0 w-20 h-16 rounded-lg overflow-hidden border border-border-subtle bg-surface-bg hover:border-primary transition-colors"
                title={event.title}
              >
                <img src={event.imageUrl || ''} alt={event.title} className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}

      {preview && (
        <ImagePreviewOverlay
          src={preview.imageUrl || ''}
          alt={preview.title}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
}

// 综合所有渠道的 AI 总结卡（淡紫底，固定在沟通区下方）。AI 接入前先用确定性概览占位。
function AiSummaryCard({
  events,
  counts
}: {
  events: LifecycleEvent[]
  counts: { wechat: number; wxwork: number; call: number; manual: number }
}): React.JSX.Element {
  const textEvents = events.filter((event) => event.kind !== 'image')
  const sorted = [...textEvents].sort(
    (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
  )
  const range =
    sorted.length > 0
      ? `${formatDateTime(sorted[0].occurredAt)} ~ ${formatDateTime(sorted[sorted.length - 1].occurredAt)}`
      : null

  return (
    <div className="border-t border-ai-purple/20 bg-ai-purple/5 px-3 py-3">
      <div className="flex items-center gap-1.5 text-ai-purple font-semibold text-body-sm">
        <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>smart_toy</span>
        AI 沟通总结
        <span className="ml-2 text-[11px] font-normal text-text-muted">（综合全部渠道）</span>
      </div>
      <p className="mt-1.5 text-body-sm text-text-muted leading-relaxed">
        AI 总结即将接入——将综合微信 / 企微 / 电话 / 人工录入，自动提炼本订单的沟通要点与下一步。完整简报见右侧「AI 关键信息」。
      </p>
      <div className="mt-2 text-body-sm text-text-main">
        当前共 {textEvents.length} 条沟通：微信 {counts.wechat} · 企微 {counts.wxwork} · 电话 {counts.call} · 人工录入{' '}
        {counts.manual}
        {range && <span className="text-text-muted">，时间范围 {range}</span>}
      </div>
    </div>
  )
}

// 「AI 总结」标签内容：AI 接入前先占位，下方给一份确定性的"当前沟通概览"（真实条数/时间范围），不骗人。
// 「总体」标签内容：各沟通渠道一张总结卡，让人不用逐个标签翻消息就能看全。
// AI 接入前先用确定性概览占位（条数 + 时间范围 + 最近几条要点）；完整 AI 简报在右侧「AI 关键信息」。
function CommunicationTab({
  label,
  icon,
  iconColor,
  count,
  active,
  onClick
}: {
  label: string
  icon?: string
  iconColor?: string
  count?: number
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'shrink-0 inline-flex items-center gap-1 min-w-[68px] h-10 px-3 text-body-sm border-b-2 transition-colors ' +
        (active
          ? 'border-primary text-text-main font-semibold bg-surface-container-low'
          : 'border-transparent text-text-main/80 hover:bg-surface-container-low')
      }
    >
      {/* 图标用渠道彩色，看起来可点；标签文字用偏深色（不再灰蒙蒙像禁用） */}
      {icon && <span className={'material-symbols-outlined ' + (iconColor ?? '')} style={{ fontSize: '16px' }}>{icon}</span>}
      {label}
      {count !== undefined && <span className="ml-0.5 text-[11px] text-text-muted">{count}</span>}
    </button>
  )
}

function CallTimelineItem({ event }: { event: LifecycleEvent }): React.JSX.Element {
  const call = event.call
  if (!call) return <ChatBubble event={event} />
  const answered = call.callStatus === 'answered'
  return (
    <div className="flex justify-center">
      <div className="w-full rounded-lg border border-border-subtle bg-white px-3 py-2 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-2">
            <span className={'material-symbols-outlined shrink-0 ' + (answered ? 'text-trust-blue' : 'text-warning')} style={{ fontSize: '18px' }}>
              {call.direction === 'out' || call.direction === 'outbound' ? 'call_made' : 'call_received'}
            </span>
            <div className="min-w-0">
              <div className="text-body-sm font-semibold text-text-main truncate">{callTitle(call)}</div>
              <div className="text-[11px] text-text-muted">
                {formatDateTime(call.startedAt)} · {formatDuration(call.durationSec)}
              </div>
            </div>
          </div>
          <div className="shrink-0 text-[11px] text-text-muted">
            {call.recordingOssKey ? '有录音' : '无录音'} · {asrStatusLabel(call.asrStatus)}
          </div>
        </div>
        {call.asrText && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-primary select-none">查看转写文本</summary>
            <p className="mt-1 max-h-32 overflow-y-auto text-body-sm text-text-muted whitespace-pre-wrap break-words">
              {call.asrText}
            </p>
          </details>
        )}
      </div>
    </div>
  )
}

function ChatBubble({ event }: { event: LifecycleEvent }): React.JSX.Element {
  const mine = event.senderType === 'self'
  const system = event.senderType === 'system' || event.kind === 'status'
  if (system) {
    return (
      <div className="flex justify-center">
        <div className="max-w-[80%] rounded-md bg-black/10 px-2 py-1 text-[11px] text-text-muted">
          {event.summary || event.title}
        </div>
      </div>
    )
  }

  return (
    <div className={'flex ' + (mine ? 'justify-end' : 'justify-start')}>
      <div className={'max-w-[78%] flex flex-col ' + (mine ? 'items-end' : 'items-start')}>
        <div className="mb-0.5 text-[11px] text-text-muted">
          {event.senderName || (mine ? '我方' : '客户')}
          <span className="ml-1 text-text-muted/70">{formatDateTime(event.occurredAt)}</span>
        </div>
        <div
          className={
            'rounded-lg px-3 py-2 text-body-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm ' +
            (mine
              ? 'bg-[#95ec69] text-[#111] rounded-tr-sm'
              : 'bg-white text-text-main rounded-tl-sm border border-border-subtle')
          }
        >
          {event.summary || event.title}
        </div>
      </div>
    </div>
  )
}

function ImagePreviewOverlay({
  src,
  alt,
  onClose
}: {
  src: string
  alt: string
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-5 top-5 h-9 w-9 rounded-full bg-white/90 text-text-main flex items-center justify-center hover:bg-white transition-colors"
        title="关闭大图"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>close</span>
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

function LifecycleEventItem({ event }: { event: LifecycleEvent }): React.JSX.Element {
  return (
    <div className="bg-white border border-border-subtle rounded-lg p-3 shadow-sm flex gap-2">
      <span className="material-symbols-outlined text-text-muted shrink-0" style={{ fontSize: '16px' }}>
        {eventIcon(event.kind)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-body-sm font-medium text-text-main truncate">{event.title}</p>
          <span className="text-[11px] text-text-muted/70 shrink-0">{formatDateTime(event.occurredAt)}</span>
        </div>
        {event.summary && (
          <p className="mt-1 text-body-sm text-text-muted whitespace-pre-wrap break-words">{event.summary}</p>
        )}
      </div>
    </div>
  )
}

// ─── 右侧面板 ───────────────────────────────────────────
function RightPanel({
  order,
  detailResp,
  detailLoading,
  detailError,
  materials,
  onReload
}: {
  order: Order
  detailResp: OrderDetailResponse | null
  detailLoading: boolean
  detailError: string | null
  materials: Material[]
  onReload: () => Promise<void>
}): React.JSX.Element {
  const [tab, setTab] = useState<'detail' | 'entry' | 'ai'>('detail')

  return (
    <aside className="w-[400px] shrink-0 bg-white border-l border-border-subtle flex flex-col z-10 shadow-[-4px_0_12px_rgba(0,0,0,0.03)]">
      <div className="flex border-b border-border-subtle shrink-0">
        <PanelTab label="订单详情" active={tab === 'detail'} onClick={() => setTab('detail')} />
        <PanelTab label="数据补录" active={tab === 'entry'} onClick={() => setTab('entry')} />
        <button
          onClick={() => setTab('ai')}
          className={
            'flex-1 py-3.5 text-body-md border-b-2 transition-colors flex items-center justify-center gap-1 ' +
            (tab === 'ai'
              ? 'text-ai-purple font-bold border-ai-purple bg-surface-container-low'
              : 'text-text-muted border-transparent hover:bg-surface-container-low')
          }
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>smart_toy</span>
          AI 关键信息
        </button>
      </div>

      {tab === 'detail' ? (
        <OrderInfoPanel
          order={order}
          detailResp={detailResp}
          loading={detailLoading}
          error={detailError}
        />
      ) : tab === 'entry' ? (
        <DataEntryPanel order={order} materials={materials} onReload={onReload} />
      ) : (
        <AiPanel order={order} />
      )}
    </aside>
  )
}

function PanelTab({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={
        'flex-1 py-3.5 text-body-md border-b-2 transition-colors ' +
        (active
          ? 'text-primary font-bold border-primary bg-surface-container-low'
          : 'text-text-muted border-transparent hover:bg-surface-container-low')
      }
    >
      {label}
    </button>
  )
}

function OrderInfoPanel({
  order,
  detailResp,
  loading,
  error
}: {
  order: Order
  detailResp: OrderDetailResponse | null
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const raw = order.rawJson ?? {}
  const rec = (detailResp?.detail?.recommendations ?? {}) as Record<string, unknown>
  const attachments = detailResp?.attachments ?? []
  const groups = buildDetailGroups(order, raw, rec)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="rounded-lg border border-border-subtle bg-surface-bg px-3 py-2.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-body-sm font-semibold text-text-main truncate">{order.customerName}</p>
          <p className="mt-0.5 text-[11px] text-text-muted font-mono-data truncate">{order.sourceOrderNo}</p>
        </div>
        <span className="shrink-0 px-2 py-1 rounded-md bg-white border border-border-subtle text-[11px] text-text-muted">
          {loading ? '加载中' : detailResp?.order.detailFetchedAt ? '详情已抓取' : '列表数据'}
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">
          {error}
        </div>
      )}

      {groups.map((group) => (
        <DetailGroup key={group.title} title={group.title} rows={group.rows} />
      ))}

      <AttachmentSection items={attachments} loading={loading} />

      <RawDataDisclosure raw={raw} recommendations={rec} />
    </div>
  )
}

interface DetailGroupData {
  title: string
  rows: DetailField[]
}

interface DetailField {
  label: string
  value: React.ReactNode
  keys?: string[]
  mono?: boolean
}

function buildDetailGroups(
  order: Order,
  raw: Record<string, unknown>,
  rec: Record<string, unknown>
): DetailGroupData[] {
  return [
    {
      title: '基础信息',
      rows: [
        field('泰康订单号', pick(rec, raw, ['subOrderNo', 'orderId'], order.sourceOrderNo), ['subOrderNo', 'orderId'], true),
        field('申请号', pick(rec, raw, ['applyNo']), ['applyNo'], true),
        field('CRM 申请号', pick(rec, raw, ['crmApplyNo']), ['crmApplyNo'], true),
        field('就诊人', pick(rec, raw, ['patientName'], order.customerName), ['patientName']),
        field('性别', pick(rec, raw, ['sex']), ['sex']),
        field('生日', pick(rec, raw, ['birthday']), ['birthday']),
        field('证件类型', pick(rec, raw, ['cardType']), ['cardType']),
        field('证件号码', pick(rec, raw, ['cardId']), ['cardId'], true),
        field('联系电话', pick(rec, raw, ['paMobile', 'patientMobile', 'patientPhone'], order.customerPhone), ['paMobile', 'patientMobile', 'patientPhone']),
        field('客户等级', pick(rec, raw, ['cusLevel']), ['cusLevel']),
        field('客户关系', pick(rec, raw, ['relationship']), ['relationship']),
        field('是否医保', formatYesNo(pick(rec, raw, ['isSocSec'])), ['isSocSec']),
        field('医保城市', pick(rec, raw, ['medLoc']), ['medLoc']),
        field('社保卡号', pick(rec, raw, ['socSecNo']), ['socSecNo'], true)
      ]
    },
    {
      title: '投保 / 联系人',
      rows: [
        field('投保人', pick(rec, raw, ['insurName']), ['insurName']),
        field('保单号', pick(rec, raw, ['insurNo']), ['insurNo'], true),
        field('保单机构', pick(rec, raw, ['insurBrhName']), ['insurBrhName']),
        field('联系人姓名', pick(rec, raw, ['ecpName']), ['ecpName']),
        field('联系人手机号', pick(rec, raw, ['ecpPhone']), ['ecpPhone']),
        field('第二联系人', pick(rec, raw, ['secEcpName']), ['secEcpName']),
        field('第二联系人手机号', pick(rec, raw, ['secEcpPhone']), ['secEcpPhone']),
        field('与投保人关系', pick(rec, raw, ['patEcpRelationship']), ['patEcpRelationship'])
      ]
    },
    {
      title: '就诊意向',
      rows: [
        field('意向医院', pick(rec, raw, ['intendHos', 'hospital'], order.hospital), ['intendHos', 'hospital']),
        field('意向城市', joinValues(pick(rec, raw, ['intendProvince']), pick(rec, raw, ['intendCity'])), ['intendProvince', 'intendCity']),
        field('意向科室', pick(rec, raw, ['intendDept', 'dept'], order.dept), ['intendDept', 'dept']),
        field('意向医生', pick(rec, raw, ['intendDoc', 'doctor'], order.doctor), ['intendDoc', 'doctor']),
        field('医生职称', pick(rec, raw, ['intendDocTitle']), ['intendDocTitle']),
        field('就诊日期', joinValues(pick(rec, raw, ['intendDate'], order.intendDate), pick(rec, raw, ['intendDateAmorpm'])), ['intendDate', 'intendDateAmorpm']),
        field('出险时间', pick(rec, raw, ['acciTime']), ['acciTime']),
        field('疑似疾病', pick(rec, raw, ['suspectDisease']), ['suspectDisease']),
        field('疑似疾病类型', pick(rec, raw, ['approveDiseaseType', 'suspectDiseaseCode']), ['approveDiseaseType', 'suspectDiseaseCode']),
        field('确诊情况', pick(rec, raw, ['approveDetail']), ['approveDetail']),
        field('确诊详情', pick(rec, raw, ['approveDiseaseDesc']), ['approveDiseaseDesc']),
        field('审核疾病', pick(rec, raw, ['approveDiseaseName']), ['approveDiseaseName'])
      ]
    },
    {
      title: '服务记录',
      rows: [
        field('服务医院', pick(rec, raw, ['visitingHospital']), ['visitingHospital']),
        field('服务城市', joinValues(pick(rec, raw, ['visitingProvince']), pick(rec, raw, ['visitingCity'])), ['visitingProvince', 'visitingCity']),
        field('出发地', pick(rec, raw, ['departureAddress']), ['departureAddress']),
        field('服务详址', pick(rec, raw, ['visitingHospitalDetailAddress']), ['visitingHospitalDetailAddress']),
        field('家属姓名', pick(rec, raw, ['accompanyFamilyMembersName']), ['accompanyFamilyMembersName']),
        field('家属电话', pick(rec, raw, ['accompanyFamilyMembersMobile']), ['accompanyFamilyMembersMobile']),
        field('预计出院', pick(rec, raw, ['estimateOutHospitalDate']), ['estimateOutHospitalDate']),
        field('备注信息', pick(rec, raw, ['comments', 'comment']), ['comments', 'comment']),
        field('审核意见', pick(rec, raw, ['reviewerResult']), ['reviewerResult'])
      ]
    },
    {
      title: '方案 / 产品',
      rows: [
        field('业务类型', bizType(order), ['serviceType', 'itemName']),
        field('服务项', pick(rec, raw, ['serviceItemName', 'serviceName', 'serviceType', 'itemName']), ['serviceItemName', 'serviceName', 'serviceType', 'itemName']),
        field('子方案', pick(rec, raw, ['subPlanName']), ['subPlanName']),
        field('套餐', pick(rec, raw, ['packetName']), ['packetName']),
        field('方案', pick(rec, raw, ['planName']), ['planName']),
        field('方案别名', pick(rec, raw, ['planAlias']), ['planAlias']),
        field('产品', pick(rec, raw, ['productName']), ['productName']),
        field('标签', pick(rec, raw, ['labelName', 'networkTag']), ['labelName', 'networkTag'])
      ]
    },
    {
      title: '流程 / 状态',
      rows: [
        field('订单状态', pick(rec, raw, ['orderStateName', 'status'], order.status), ['orderStateName', 'status']),
        field('状态码', pick(rec, raw, ['orderState'], order.orderState), ['orderState'], true),
        field('当前阶段', pick(rec, raw, ['stageName']), ['stageName']),
        field('服务状态', pick(rec, raw, ['servStateName']), ['servStateName']),
        field('申请方式', pick(rec, raw, ['applyWayDesc']), ['applyWayDesc']),
        field('申请时间', pick(rec, raw, ['applicationDate', 'applyTime', 'applyDate']), ['applicationDate', 'applyTime', 'applyDate']),
        field('受理时间', pick(rec, raw, ['mmgrApplyDate']), ['mmgrApplyDate']),
        field('服务开始', pick(rec, raw, ['startDate']), ['startDate']),
        field('申领时间', order.claimedAt, []),
        field('更新时间', order.updatedAt, [])
      ]
    }
  ].map((group) => ({
    ...group,
    rows: group.rows.filter((row) => hasValue(row.value))
  })).filter((group) => group.rows.length > 0)
}

function field(label: string, value: React.ReactNode, keys: string[] = [], mono = false): DetailField {
  return { label, value, keys, mono }
}

function DetailGroup({
  title,
  rows,
  dense = false
}: {
  title: string
  rows: DetailField[]
  dense?: boolean
}): React.JSX.Element {
  return (
    <section>
      <h3 className="text-label-caps text-text-muted mb-2">{title}</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {rows.map((row) => (
          <DetailRow key={`${title}-${row.label}`} row={row} dense={dense} />
        ))}
      </div>
    </section>
  )
}

function DetailRow({ row, dense }: { row: DetailField; dense: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0 border-b border-border-subtle/70 pb-1.5">
      <div className="text-[11px] text-text-muted truncate">{row.label}</div>
      <div className={(dense ? 'text-[12px]' : 'text-body-sm') + ' mt-0.5 text-text-main break-words ' + (row.mono ? 'font-mono-data' : '')}>
        {hasValue(row.value) ? row.value : '—'}
      </div>
    </div>
  )
}

function RawDataDisclosure({
  raw,
  recommendations
}: {
  raw: Record<string, unknown>
  recommendations: Record<string, unknown>
}): React.JSX.Element {
  const rawCount = Object.keys(raw).length
  const recCount = Object.keys(recommendations).length
  if (rawCount === 0 && recCount === 0) {
    return <></>
  }

  return (
    <details className="rounded-lg border border-border-subtle bg-surface-bg">
      <summary className="cursor-pointer select-none px-3 py-2 text-body-sm font-medium text-text-muted hover:text-text-main">
        原始数据（调试）
        <span className="ml-2 text-[11px] font-normal text-text-muted/70">
          列表 {rawCount} 项 / 详情 {recCount} 项
        </span>
      </summary>
      <div className="border-t border-border-subtle p-3 space-y-3">
        <RawJsonBlock title="列表接口 rawJson" value={raw} />
        <RawJsonBlock title="详情接口 recommendations" value={recommendations} />
      </div>
    </details>
  )
}

function RawJsonBlock({ title, value }: { title: string; value: Record<string, unknown> }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold text-text-muted">{title}</div>
      <pre className="max-h-64 overflow-auto rounded-md bg-white border border-border-subtle p-2 text-[11px] leading-relaxed text-text-muted font-mono-data whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function AttachmentSection({
  items,
  loading
}: {
  items: OrderAttachment[]
  loading: boolean
}): React.JSX.Element {
  const [preview, setPreview] = useState<OrderAttachment | null>(null)
  const groups = groupAttachments(items)
  return (
    <section>
      <h3 className="text-label-caps text-text-muted mb-2">附件（{items.length}）</h3>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle bg-surface-bg px-3 py-6 text-center text-body-sm text-text-muted">
          {loading ? '正在加载附件…' : '该订单暂无证件或附件'}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.fileType}>
              <div className="mb-1.5 text-[11px] text-text-muted">
                <span className="font-semibold text-text-main">{fileTypeLabel(group.fileType)}</span>
                <span className="ml-1.5">{group.items.length} 张</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setPreview(item)}
                    className="group overflow-hidden rounded-lg border border-border-subtle bg-surface-bg text-left hover:border-primary transition-colors"
                    title={item.fileName}
                  >
                    <div className="aspect-square bg-white overflow-hidden flex items-center justify-center">
                      {item.mimeType.startsWith('image/') ? (
                        <img src={item.url} alt={item.fileName} className="h-full w-full object-cover group-hover:scale-105 transition-transform" />
                      ) : (
                        <span className="material-symbols-outlined text-text-muted">description</span>
                      )}
                    </div>
                    <div className="px-1.5 py-1">
                      <div className="truncate text-[10px] text-text-main">{item.fileName}</div>
                      <div className="text-[10px] text-text-muted">{Math.max(1, Math.round(item.byteSize / 1024))} KB</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {preview && (
        <ImagePreviewOverlay
          src={preview.url}
          alt={preview.fileName}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  )
}

function groupAttachments(items: OrderAttachment[]): Array<{ fileType: string; items: OrderAttachment[] }> {
  const map = new Map<string, OrderAttachment[]>()
  for (const item of items) {
    const group = map.get(item.fileType) ?? []
    group.push(item)
    map.set(item.fileType, group)
  }
  const order = ['40', '41', '5001', '5000', '5002', '100', '99', '5010', '5008', '5009']
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
    })
    .map(([fileType, groupItems]) => ({ fileType, items: groupItems }))
}

function fileTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    '40': '身份证',
    '41': '社保卡',
    '5000': '病历',
    '5001': '其他附件',
    '5002': '补充资料',
    '100': '影像资料',
    '99': '历史资料',
    '5010': '服务结果',
    '5008': '回填资料',
    '5009': '过程资料'
  }
  return labels[type] ?? `类型 ${type}`
}

function pick(
  rec: Record<string, unknown>,
  raw: Record<string, unknown>,
  keys: string[],
  fallback?: React.ReactNode
): React.ReactNode {
  for (const key of keys) {
    const recValue = normalizeDetailValue(rec[key])
    if (recValue) return recValue
    const rawValue = normalizeDetailValue(raw[key])
    if (rawValue) return rawValue
  }
  return fallback ?? ''
}

function normalizeDetailValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function joinValues(...values: React.ReactNode[]): string {
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(' / ')
}

function formatYesNo(value: React.ReactNode): string {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  if (!raw) return ''
  if (raw === '1' || raw === 'true' || raw === '是') return '是'
  if (raw === '0' || raw === 'false' || raw === '否') return '否'
  return raw
}

function hasValue(value: React.ReactNode): boolean {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

/**
 * 数据补录：员工通过「粘贴」（微信文字/图片）和「手工录入」沉淀过程数据；
 * 下方按时间倒序列出已采集素材，可删除。不是表单。
 */
function DataEntryPanel({
  order,
  materials,
  onReload
}: {
  order: Order
  materials: Material[]
  onReload: () => Promise<void>
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const disabled = order.id <= 0 // 模拟单不可写

  async function saveNote(): Promise<void> {
    const text = note.trim()
    if (!text || disabled) return
    setBusy(true)
    setErr(null)
    try {
      await addTextMaterial(order.id, text)
      setNote('')
      await onReload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  // 读剪贴板：优先图片，其次文字
  async function pasteFromClipboard(): Promise<void> {
    if (disabled) return
    setBusy(true)
    setErr(null)
    try {
      let handled = false
      if (navigator.clipboard && 'read' in navigator.clipboard) {
        const items = await navigator.clipboard.read().catch(() => [] as ClipboardItem[])
        for (const item of items) {
          const imgType = item.types.find((t) => t.startsWith('image/'))
          if (imgType) {
            const blob = await item.getType(imgType)
            const base64 = await blobToBase64(blob)
            await addImageMaterial(order.id, imgType, base64)
            handled = true
          }
        }
      }
      if (!handled) {
        const text = await navigator.clipboard.readText().catch(() => '')
        if (text.trim()) {
          await addTextMaterial(order.id, text.trim())
          handled = true
        }
      }
      if (!handled) setErr('剪贴板为空或无法读取（可直接在下方录入框粘贴 Ctrl+V）')
      else await onReload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '粘贴失败')
    } finally {
      setBusy(false)
    }
  }

  // 录入框内 Ctrl+V：捕获图片（文字走默认行为进 textarea）
  async function onPaste(e: React.ClipboardEvent): Promise<void> {
    const imgItem = [...e.clipboardData.items].find((it) => it.type.startsWith('image/'))
    if (imgItem && !disabled) {
      e.preventDefault()
      const file = imgItem.getAsFile()
      if (!file) return
      setBusy(true)
      try {
        const base64 = await blobToBase64(file)
        await addImageMaterial(order.id, file.type, base64)
        await onReload()
      } catch (er) {
        setErr(er instanceof Error ? er.message : '图片粘贴失败')
      } finally {
        setBusy(false)
      }
    }
  }

  async function onFilePick(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file || disabled) return
    setBusy(true)
    try {
      const base64 = await blobToBase64(file)
      await addImageMaterial(order.id, file.type, base64)
      await onReload()
    } catch (er) {
      setErr(er instanceof Error ? er.message : '上传失败')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function remove(id: number): Promise<void> {
    setBusy(true)
    try {
      await deleteMaterial(id)
      await onReload()
    } catch (er) {
      setErr(er instanceof Error ? er.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 录入区 */}
      <div className="p-4 border-b border-border-subtle flex flex-col gap-3 shrink-0">
        <div className="flex gap-2">
          <button
            onClick={pasteFromClipboard}
            disabled={disabled || busy}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-primary text-white rounded-lg text-body-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>content_paste</span>
            粘贴
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={disabled || busy}
            className="flex items-center justify-center gap-1.5 px-3 py-2 bg-surface-bg border border-border-subtle text-text-main rounded-lg text-body-sm font-medium hover:bg-surface-container-low transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>image</span>
            图片
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFilePick} />
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void saveNote()
          }}
          rows={3}
          disabled={disabled}
          placeholder={disabled ? '模拟订单不可录入' : '手工录入要点，或在此 Ctrl+V 粘贴…（⌘/Ctrl+Enter 保存）'}
          className="w-full bg-surface-bg border border-border-subtle rounded-lg px-3 py-2 text-body-md text-text-main caret-primary cursor-default focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all resize-none disabled:opacity-50"
        />
        <button
          onClick={saveNote}
          disabled={disabled || busy || !note.trim()}
          className="self-end px-4 py-1.5 bg-primary text-white rounded-lg text-body-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          保存录入
        </button>
        {err && <p className="text-body-sm text-error">{err}</p>}
      </div>

      {/* 已采集素材列表（倒序） */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2 min-h-0">
        <div className="text-label-caps text-text-muted">已采集素材（{materials.length}）</div>
        {materials.length === 0 ? (
          <p className="text-body-sm text-text-muted/70 py-6 text-center">还没有素材，粘贴或手工录入后会出现在这里</p>
        ) : (
          materials.map((m) => (
            <div key={m.id} className="group bg-surface-bg border border-border-subtle rounded-lg p-3 flex gap-2 relative">
              <span className="material-symbols-outlined text-text-muted shrink-0" style={{ fontSize: '16px' }}>
                {m.type === 'image' ? 'image' : 'sticky_note_2'}
              </span>
              <div className="flex-1 min-w-0">
                {m.type === 'image' && m.url ? (
                  <img src={m.url} alt="素材" className="max-h-32 rounded object-contain" />
                ) : (
                  <p className="text-body-sm text-text-main whitespace-pre-wrap break-words">
                    {m.textContent || '（图片）'}
                  </p>
                )}
                <span className="text-[11px] text-text-muted/70">{new Date(m.createdAt).toLocaleString('zh-CN')}</span>
              </div>
              <button
                onClick={() => remove(m.id)}
                className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-error transition-all shrink-0"
                title="删除"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const s = String(reader.result)
      resolve(s.includes(',') ? s.split(',')[1] : s) // 去掉 data:...;base64, 前缀
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// AI 滚动简报：综合微信/企微消息 + 通话/录音转写，由后端 LLM 产出。
// 打开时读已存简报；可手动"刷新"触发一次 LLM 重算（自动扫描器也会在静默/攒够时刷新）。
function AiPanel({ order }: { order: Order }): React.JSX.Element {
  const [brief, setBrief] = useState<OrderBrief | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (order.id <= 0) return
    let alive = true
    setLoading(true)
    fetchOrderBrief(order.id)
      .then((r) => {
        if (!alive) return
        setBrief(r.brief)
        setUpdatedAt(r.updatedAt)
        setError(null)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : '加载简报失败'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [order.id])

  const doRefresh = (): void => {
    if (order.id <= 0 || refreshing) return
    setRefreshing(true)
    setError(null)
    refreshOrderBrief(order.id)
      .then((b) => {
        setBrief(b)
        setUpdatedAt(new Date().toISOString())
      })
      .catch((e) => setError(e instanceof Error ? e.message : '刷新简报失败'))
      .finally(() => setRefreshing(false))
  }

  if (order.id <= 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-body-sm text-text-muted p-6 text-center">
        模拟订单无 AI 简报
      </div>
    )
  }

  const keyInfoEntries = brief ? Object.entries(brief.keyInfo || {}) : []

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
      {/* 头：刷新 + 更新时间 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-ai-purple font-semibold text-body-md">
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>smart_toy</span>
          AI 滚动简报
        </div>
        <div className="flex items-center gap-2">
          {updatedAt && (
            <span className="text-label-caps text-text-muted">{fmtBriefTime(updatedAt)}</span>
          )}
          <button
            onClick={doRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-body-sm border border-border-subtle text-text-main hover:bg-surface-container-low disabled:opacity-50"
          >
            <span
              className={'material-symbols-outlined ' + (refreshing ? 'animate-spin' : '')}
              style={{ fontSize: '15px' }}
            >
              {refreshing ? 'progress_activity' : 'refresh'}
            </span>
            {refreshing ? '生成中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && <div className="text-body-sm text-red-600 bg-red-50 rounded px-3 py-2">⚠ {error}</div>}

      {loading && !brief ? (
        <div className="text-body-sm text-text-muted py-8 text-center">加载中…</div>
      ) : !brief || (!brief.summary && !brief.stage) ? (
        <div className="flex flex-col items-center justify-center text-center gap-3 text-text-muted py-10">
          <span className="material-symbols-outlined text-ai-purple" style={{ fontSize: '36px' }}>smart_toy</span>
          <p className="text-body-md text-text-main">还没有简报</p>
          <p className="text-body-sm max-w-xs">
            积累微信/企微消息或通话后会自动生成；也可现在手动生成一次。
          </p>
          <button
            onClick={doRefresh}
            disabled={refreshing}
            className="mt-1 inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-ai-purple text-white text-body-sm font-semibold hover:bg-ai-purple/90 disabled:opacity-50"
          >
            <span
              className={'material-symbols-outlined ' + (refreshing ? 'animate-spin' : '')}
              style={{ fontSize: '16px' }}
            >
              {refreshing ? 'progress_activity' : 'auto_awesome'}
            </span>
            {refreshing ? '生成中…' : '生成简报'}
          </button>
        </div>
      ) : (
        <>
          {/* 现状 + 阶段 */}
          <div className="rounded-lg border border-ai-purple/30 bg-ai-purple/5 p-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              {brief.stage && (
                <span className="text-label-caps px-2 py-0.5 rounded-full bg-ai-purple text-white">{brief.stage}</span>
              )}
              {brief.hasOpenIssue && (
                <span className="text-label-caps px-2 py-0.5 rounded-full bg-red-100 text-red-700">⚠ 有未解决问题</span>
              )}
            </div>
            {brief.summary && <p className="text-body-md text-text-main leading-relaxed">{brief.summary}</p>}
            {brief.stageEvidence && <p className="text-body-sm text-text-muted">依据：{brief.stageEvidence}</p>}
          </div>

          {/* 下一步 */}
          {brief.nextActions.length > 0 && (
            <BriefList icon="checklist" title="下一步" items={brief.nextActions} tone="primary" />
          )}
          {/* 风险 */}
          {brief.risks.length > 0 && (
            <BriefList icon="warning" title="风险 / 需关注" items={brief.risks} tone="warn" />
          )}

          {/* 回填关键信息 */}
          <div className="rounded-lg border border-border-subtle bg-white">
            <div className="px-3 py-2 border-b border-border-subtle text-label-caps text-text-muted">
              关键信息（供回填）
            </div>
            <dl className="p-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-body-sm">
              {keyInfoEntries.map(([k, v]) => (
                <BriefKv key={k} k={k} v={v} />
              ))}
            </dl>
          </div>

          <p className="text-label-caps text-text-muted/70 text-center pt-1">
            由 AI 根据采集的消息与通话生成，仅供参考，请核对后使用{brief.model ? ` · ${brief.model}` : ''}
          </p>
        </>
      )}
    </div>
  )
}

function BriefList({
  icon,
  title,
  items,
  tone
}: {
  icon: string
  title: string
  items: string[]
  tone: 'primary' | 'warn'
}): React.JSX.Element {
  const color = tone === 'warn' ? 'text-amber-600' : 'text-primary'
  return (
    <div className="rounded-lg border border-border-subtle bg-white p-3">
      <div className={'flex items-center gap-1.5 text-body-sm font-semibold mb-1.5 ' + color}>
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>{icon}</span>
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="text-body-sm text-text-main flex gap-1.5">
            <span className="text-text-muted">·</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function BriefKv({ k, v }: { k: string; v: string | null }): React.JSX.Element {
  return (
    <>
      <dt className="text-text-muted whitespace-nowrap">{k}</dt>
      <dd className={v ? 'text-text-main' : 'text-text-muted/50'}>{v || '—'}</dd>
    </>
  )
}

function fmtBriefTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `更新于 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
