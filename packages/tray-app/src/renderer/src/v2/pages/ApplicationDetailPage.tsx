import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addImageMaterial,
  addTextMaterial,
  deleteMaterial,
  fetchCallRecordingUrl,
  fetchApplicationBrief,
  fetchMaterials,
  fetchOrderAggregate,
  fetchOrderBrief,
  fetchOrderDetail,
  fetchHuanyuChannelProducts,
  fetchHuanyuChannels,
  fetchHuanyuBookingChannelTypes,
  fetchHuanyuBdUsers,
  fetchHuanyuDocumentTypes,
  fetchHuanyuExpertLevels,
  fetchHuanyuEscorts,
  fetchHuanyuHospitalAddresses,
  fetchHuanyuHospitalDepartments,
  fetchHuanyuHospitalDoctors,
  fetchHuanyuHospitals,
  saveHuanyuOrder,
  getSession,
  refreshApplicationBrief,
  refreshOrderBrief,
  type Material,
  type Order,
  type OrderAggregateResponse,
  type OrderAttachment,
  type OrderBrief,
  type OrderCall,
  type CallRecordingUrl,
  type HuanyuChannelOption,
  type HuanyuChannelProductOption,
  type HuanyuHospitalDepartmentOption,
  type HuanyuDoctorOption,
  type HuanyuEscortOption,
  type OrderDetailResponse,
  type OrderMessage,
} from '../api'
import { bizChipClass, bizType, LIFECYCLE_STAGES, sourceStyle, stageIndexOf } from '../lib/orderMapping'
import { clearOrdersCache, type ApplicationGroup } from './WorkbenchKanban'

type RightTab = 'taikang-detail' | 'huanyu-detail' | 'entry' | 'ai'
type CaptureTab = 'wxwork' | 'wechat' | 'call'

const CAPTURE_TABS: Array<{ key: CaptureTab; label: string; icon: string; iconColor: string }> = [
  { key: 'wxwork', label: '企微', icon: 'groups', iconColor: 'text-[#2e7bff]' },
  { key: 'wechat', label: '微信', icon: 'chat', iconColor: 'text-[#07c160]' },
  { key: 'call', label: '通话录音', icon: 'call', iconColor: 'text-[#00a3a3]' }
]

interface ServiceFlowTab {
  key: string
  label: string
}

const SERVICE_FLOW_TAB_DEFINITIONS: Record<string, ServiceFlowTab[]> = {
  全程门诊: [
    { key: 'claim', label: '申领' },
    { key: 'plan', label: '确认方案' },
    { key: 'assignment', label: '分配陪诊' },
    { key: 'service-record', label: '陪诊录入' }
  ],
  全流程: [
    { key: 'claim', label: '申领' },
    { key: 'plan', label: '确认方案' },
    { key: 'assignment', label: '分配陪诊' },
    { key: 'service-record', label: '陪诊录入' }
  ],
  单次门诊: [
    { key: 'claim', label: '申领' },
    { key: 'plan', label: '确认方案' },
    { key: 'assignment', label: '分配陪诊' },
    { key: 'service-record', label: '陪诊录入' }
  ],
  电话问诊: [
    { key: 'claim', label: '申领' },
    { key: 'plan', label: '确认方案' },
    { key: 'assignment', label: '分配陪诊' },
    { key: 'service-record', label: '陪诊录入' }
  ],
  检查加急: [
    { key: 'claim', label: '申领' },
    { key: 'assignment', label: '分配陪诊' },
    { key: 'service-record', label: '陪诊录入' }
  ],
  住院: [
    { key: 'claim', label: '申领' },
    { key: 'assignment', label: '分配陪诊' },
    { key: 'service-record', label: '陪诊录入' }
  ],
  住院护工协助: [
    { key: 'claim', label: '申领' },
    { key: 'assignment', label: '分配陪诊' },
    { key: 'service-record', label: '陪诊录入' }
  ],
  就医接送: [
    { key: 'claim', label: '申领' },
    { key: 'service-record', label: '服务录入' }
  ],
  共享流程: [
    { key: 'claim', label: '申领' },
    { key: 'service-record', label: '服务录入' }
  ],
  MDT服务: [
    { key: 'claim', label: '申领' },
    { key: 'plan', label: '确认方案' },
    { key: 'service-record', label: '服务录入' }
  ],
  挂号协助: [
    { key: 'claim', label: '申领' },
    { key: 'plan', label: '确认方案' },
    { key: 'service-record', label: '服务录入' }
  ]
}

const SOCIAL_SECURITY_KEYS = [
  'socSecNo',
  'socialSecurityNo',
  'socialSecurityCardNo',
  'socialSecurityCard',
  'socialCardNo',
  'socialCard',
  'medicalInsuranceNo',
  'medicalInsuranceCardNo',
  'medicalCardNo',
  'medicareCardNo',
  'medCardNo',
  'siCardNo',
  'cardNo'
]

function tail8(no: string | null): string | null {
  if (!no) return null
  const compact = no.replace(/\s+/g, '')
  return compact.length >= 8 ? compact.slice(-8) : null
}

export default function ApplicationDetailPage({
  group,
  initialOrderId,
  onBack
}: {
  group: ApplicationGroup
  initialOrderId?: number
  onBack: () => void
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState(() => {
    const initialOrder = group.orders.find((order) => order.id === initialOrderId)
    return initialOrder?.id ?? group.orders[0]?.id ?? 0
  })
  const [communicationOpen, setCommunicationOpen] = useState(false)
  const [headerDetailResp, setHeaderDetailResp] = useState<OrderDetailResponse | null>(null)
  const selectedOrder = group.orders.find((order) => order.id === selectedId) ?? group.orders[0]
  const applicationNo = group.applicationNo ?? group.primary.sourceOrderNo
  const services = useMemo(() => dedupeServices(group.orders), [group.orders])
  const headerFacts = useMemo(() => selectedOrder ? buildHeaderFacts(selectedOrder, headerDetailResp) : [], [selectedOrder, headerDetailResp])
  const hospital = group.orders.find((order) => order.hospital)?.hospital ?? null
  const phone = group.orders.find((order) => order.customerPhone)?.customerPhone ?? null
  const src = sourceStyle(group.primary)
  const dept = group.orders.find((order) => order.dept)?.dept ?? null
  const displayName = group.customerName

  useEffect(() => {
    if (!selectedOrder) {
      setHeaderDetailResp(null)
      return
    }
    let alive = true
    setHeaderDetailResp(null)
    fetchOrderDetail(selectedOrder.id)
      .then((resp) => {
        if (!alive) return
        setHeaderDetailResp(resp)
      })
      .catch(() => {
        if (!alive) return
        setHeaderDetailResp(null)
      })
    return () => {
      alive = false
    }
  }, [selectedOrder?.id])

  return (
    <div className="h-full flex flex-col bg-surface-bg text-text-main overflow-hidden">
      <header className="shrink-0 bg-white border-b border-border-subtle px-5 py-1.5 z-20">
        <div className="flex min-w-0 items-center gap-4">
          <button
            onClick={onBack}
            className="shrink-0 p-2 rounded-full hover:bg-surface-container-low text-text-muted hover:text-primary transition-colors"
            title="返回"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>arrow_back</span>
          </button>

          <nav className="flex min-w-[320px] max-w-[500px] flex-[1_1_460px] items-center text-body-sm text-text-muted gap-1.5">
            <button onClick={onBack} className="shrink-0 whitespace-nowrap hover:text-primary transition-colors">工作台</button>
            <span className="material-symbols-outlined shrink-0" style={{ fontSize: '16px' }}>chevron_right</span>
            <ApplicationNoCopyButtons
              applicationNo={applicationNo}
              customerName={displayName}
              className="text-text-main font-semibold font-mono-data min-w-0"
            />
          </nav>

          <div className="min-w-[280px] flex-[1.2_1_420px] flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-surface-container-high flex items-center justify-center text-text-main font-semibold shrink-0">
              {initialOf(displayName)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <h1 className="text-h2-header truncate">{displayName}</h1>
                <span className={'shrink-0 px-1.5 py-0.5 rounded-sm border text-[11px] font-semibold ' + src.bg + ' ' + src.text}>
                  {src.label}
                </span>
                {services.slice(0, 2).map((service) => (
                  <span key={service.label} className={'shrink-0 px-1.5 py-0.5 rounded-sm border border-current/20 text-[11px] font-semibold ' + bizChipClass(service.order)}>
                    {service.label}
                  </span>
                ))}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-body-sm text-text-muted min-w-0">
                <span className="inline-flex items-center gap-1 min-w-0">
                  <span className="material-symbols-outlined shrink-0" style={{ fontSize: '14px' }}>local_hospital</span>
                  <span className="truncate">{hospital || '医院待定'}{dept ? ` · ${dept}` : ''}</span>
                </span>
                {phone && (
                  <>
                    <span className="shrink-0">•</span>
                    <span className="shrink-0 font-mono-data text-[11px]">{phone}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="ml-auto grid w-[330px] shrink-0 grid-cols-2 items-center gap-1">
            {headerFacts.length > 0 && (
              <>
                {headerFacts.map((fact) => (
                  <HeaderFactPill key={`${fact.icon}-${fact.value}`} fact={fact} />
                ))}
              </>
            )}
            <button
              type="button"
              aria-pressed={communicationOpen}
              onClick={() => setCommunicationOpen((open) => !open)}
              className={
                'col-start-2 inline-flex h-7 items-center justify-center gap-1.5 rounded-full border px-3 text-[11px] font-bold transition-colors ' +
                (communicationOpen
                  ? 'border-primary bg-primary text-white'
                  : 'border-border-subtle bg-white text-text-main hover:border-primary hover:text-primary')
              }
            >
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>forum</span>
              沟通信息
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 flex overflow-hidden">
        {communicationOpen && <ApplicationIntake order={group.primary} applicationNo={applicationNo} />}
        {selectedOrder ? (
          <OrderExecutionPanel
            orders={group.orders}
            selectedOrder={selectedOrder}
            onSelect={setSelectedId}
            communicationOpen={communicationOpen}
            onOrderAreaClick={() => setCommunicationOpen(false)}
          />
        ) : (
          <div className="bg-white border-l border-border-subtle p-6 text-text-muted">没有可展示的订单</div>
        )}
      </main>
    </div>
  )
}

function ApplicationIntake({
  order,
  applicationNo
}: {
  order: Order
  applicationNo: string
}): React.JSX.Element {
  const [aggregate, setAggregate] = useState<OrderAggregateResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchOrderAggregate(order.id)
      .then((resp) => {
        if (!alive) return
        setAggregate(resp)
        setError(null)
      })
      .catch((e) => {
        if (!alive) return
        setAggregate(null)
        setError(e instanceof Error ? e.message : '加载申请号聚合信息失败')
      })
    return () => {
      alive = false
    }
  }, [order.id])

  const messages = aggregate?.messages ?? []
  const calls = aggregate?.calls ?? []

  return (
    <section className="w-[60%] min-h-0 flex flex-col border-r border-border-subtle bg-white">
      {error && <div className="m-3 rounded border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">{error}</div>}
      <ApplicationCapturePanel messages={messages} calls={calls} />
      <div className="shrink-0">
        <ApplicationAiSummaryCard applicationNo={applicationNo} messageCount={messages.length} callCount={calls.length} />
        <div className="px-4 pb-4 flex gap-2 bg-white">
          <div className="flex-1 bg-surface-container-low border border-border-subtle rounded flex items-center px-3 py-2">
            <span className="material-symbols-outlined text-text-muted mr-2" style={{ fontSize: '18px' }}>add_circle</span>
            <input
              disabled
              className="bg-transparent border-none outline-none text-body-sm w-full p-0 text-text-muted placeholder:text-outline"
              placeholder="后续接入患者消息发送..."
            />
          </div>
          <button disabled className="bg-primary text-white px-5 rounded text-body-sm font-bold opacity-60">
            Send
          </button>
        </div>
      </div>
    </section>
  )
}

interface HeaderFact {
  label: string
  value: string
  icon: string
  tone: 'blue' | 'purple' | 'green' | 'amber' | 'cyan'
  copy?: boolean
  copyValue?: string
  iconText?: string
}

function buildHeaderFacts(order: Order, detailResp: OrderDetailResponse | null): HeaderFact[] {
  const raw = ((detailResp?.order.rawJson ?? order.rawJson) ?? {}) as Record<string, unknown>
  const rec = (detailResp?.detail?.recommendations ?? {}) as Record<string, unknown>
  const cardId = pickPreferUnmasked(rec, raw, ['cardId'])
  const socSecNo = pickPreferUnmasked(rec, raw, SOCIAL_SECURITY_KEYS)
  const identityValue = socSecNo || cardId
  const secondContactName = pick(rec, raw, ['secEcpName'])
  const secondContactPhone = pick(rec, raw, ['secEcpPhone'])
  const facts: HeaderFact[] = [
    {
      label: '',
      value: identityValue,
      icon: 'badge',
      tone: 'blue',
      copy: true,
      iconText: socSecNo && socSecNo !== cardId ? '社' : '证'
    },
    {
      label: '',
      value: secondContactName && secondContactPhone ? `${secondContactName} ${secondContactPhone}` : secondContactName || secondContactPhone,
      icon: 'person',
      tone: 'green',
      copy: !!secondContactPhone,
      copyValue: secondContactPhone
    },
    {
      label: '',
      value: pick(rec, raw, ['stageName'], order.status),
      icon: 'flag',
      tone: 'cyan'
    },
    {
      label: '',
      value: pick(rec, raw, ['mmgrApplyDate']),
      icon: 'event_available',
      tone: 'amber',
      iconText: '受'
    }
  ]
  return facts.filter((item) => item.value)
}

function HeaderFactPill({ fact }: { fact: HeaderFact }): React.JSX.Element {
  const toneClass: Record<HeaderFact['tone'], string> = {
    blue: 'text-[#1d4ed8] bg-[#eff6ff] border-[#bfdbfe]',
    purple: 'text-[#6d28d9] bg-[#f5f3ff] border-[#ddd6fe]',
    green: 'text-[#15803d] bg-[#f0fdf4] border-[#bbf7d0]',
    amber: 'text-[#b45309] bg-[#fffbeb] border-[#fde68a]',
    cyan: 'text-[#0e7490] bg-[#ecfeff] border-[#bae6fd]'
  }
  const valueNode = (
    <span className="min-w-0 truncate text-[11px] font-semibold text-text-main">{fact.value}</span>
  )
  return (
    <div className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full border border-border-subtle bg-surface-container-low px-1.5">
      <span className={'inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] font-black ' + toneClass[fact.tone]}>
        {fact.iconText ? fact.iconText : <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>{fact.icon}</span>}
      </span>
      {fact.label && <span className="shrink-0 text-[10px] font-bold text-text-muted">{fact.label}</span>}
      {fact.copy ? (
        <CopyText value={fact.copyValue ?? fact.value} className="min-w-0 text-[11px] font-semibold text-text-main">
          {valueNode}
        </CopyText>
      ) : valueNode}
    </div>
  )
}

function ApplicationCapturePanel({
  messages,
  calls
}: {
  messages: OrderMessage[]
  calls: OrderCall[]
}): React.JSX.Element {
  const [active, setActive] = useState<CaptureTab>('wxwork')
  const counts = {
    wxwork: messages.filter((message) => message.channel === 'wxwork').length,
    wechat: messages.filter((message) => message.channel === 'wechat').length,
    call: calls.length
  }
  const channelMessages = useMemo(
    () => sortMessages(messages.filter((message) => message.channel === active)).slice(-120),
    [active, messages]
  )
  const channelCalls = useMemo(() => sortCalls(calls), [calls])
  const backgroundClass = active === 'wxwork' ? 'bg-[#edf3ff]' : 'bg-[#ededed]'

  return (
    <section className="flex-1 min-h-0 flex flex-col bg-white overflow-hidden">
      <div className="flex border-b border-border-subtle bg-[#fafafa] overflow-x-auto px-4">
        {CAPTURE_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActive(tab.key)}
            className={
              'min-w-[132px] px-4 py-3 text-body-sm border-b-2 transition-colors inline-flex items-center justify-center gap-1.5 font-bold ' +
              (active === tab.key
                ? 'border-primary text-primary bg-white'
                : 'border-transparent text-text-main hover:bg-white')
            }
          >
            <span className={'material-symbols-outlined ' + tab.iconColor} style={{ fontSize: '16px' }}>{tab.icon}</span>
            {tab.label}
            <span className="text-[11px] text-text-muted font-mono-data">{counts[tab.key]}</span>
          </button>
        ))}
      </div>

      <div className={'flex-1 min-h-0 overflow-y-auto px-4 py-4 ' + (active === 'call' ? 'bg-surface-bg' : backgroundClass)}>
        {active === 'call' ? (
          channelCalls.length === 0 ? (
            <div className="h-full flex items-center justify-center text-body-sm text-text-muted/70">暂无通话录音</div>
          ) : (
            <ApplicationCallLogsPanel calls={channelCalls} />
          )
        ) : channelMessages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-body-sm text-text-muted/70">暂无{active === 'wxwork' ? '企微' : '微信'}消息</div>
        ) : (
          <div className="space-y-2">
            {channelMessages.map((message) => (
              <ApplicationChatBubble
                key={message.id}
                message={message}
                channel={active}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function ApplicationChatBubble({
  message,
  channel
}: {
  message: OrderMessage
  channel: Exclude<CaptureTab, 'call'>
}): React.JSX.Element {
  const mine = message.senderType === 'self'
  const system = message.senderType === 'system' || message.kind === 'status'
  const time = formatDateTime(message.sortTime || message.chatTime || message.capturedAt)
  if (system) {
    return (
      <div className="flex justify-center">
        <div className="max-w-[80%] rounded-md bg-black/10 px-2 py-1 text-[11px] text-text-muted whitespace-pre-wrap break-words">
          {message.contentText}
        </div>
      </div>
    )
  }

  return (
    <div className={'flex ' + (mine ? 'justify-end' : 'justify-start')}>
      <div className={'max-w-[78%] flex flex-col ' + (mine ? 'items-end' : 'items-start')}>
        <div className="mb-0.5 text-[11px] text-text-muted max-w-full truncate">
          <span>{message.senderName || (mine ? '我方' : '客户')}</span>
          <span className="ml-1 text-text-muted/70">{time}</span>
          {message.conversationName && <span className="ml-1 text-text-muted/70">{message.conversationName}</span>}
        </div>
        <div
          className={
            'rounded-lg px-3 py-2 text-body-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm ' +
            (mine
              ? (channel === 'wxwork'
                  ? 'bg-[#d8e7ff] text-[#111] rounded-tr-sm border border-[#b9d4ff]'
                  : 'bg-[#95ec69] text-[#111] rounded-tr-sm')
              : 'bg-white text-text-main rounded-tl-sm border border-border-subtle')
          }
        >
          {message.contentText}
        </div>
      </div>
    </div>
  )
}

function ApplicationCallLogsPanel({ calls }: { calls: OrderCall[] }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState(calls[0]?.id ?? 0)
  const selected = calls.find((call) => call.id === selectedId) ?? calls[0]

  useEffect(() => {
    if (!calls.some((call) => call.id === selectedId)) {
      setSelectedId(calls[0]?.id ?? 0)
    }
  }, [calls, selectedId])

  return (
    <div className="grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)] gap-3">
      <div className="min-h-0 overflow-y-auto rounded-lg border border-border-subtle bg-white">
        <div className="sticky top-0 z-10 border-b border-border-subtle bg-surface-container-low px-3 py-2">
          <div className="text-[11px] font-black tracking-wide text-text-main">通话清单</div>
          <div className="text-[10px] text-text-muted">{calls.length} 条录音/通话记录</div>
        </div>
        <div className="p-2 space-y-1.5">
          {calls.map((call) => (
            <CompactCallListItem
              key={call.id}
              call={call}
              active={call.id === selected.id}
              onClick={() => setSelectedId(call.id)}
            />
          ))}
        </div>
      </div>
      <CallTranscriptPane call={selected} />
    </div>
  )
}

function CompactCallListItem({
  call,
  active,
  onClick
}: {
  call: OrderCall
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const answered = call.callStatus === 'answered'
  const directionOut = call.direction === 'out' || call.direction === 'outbound'
  const displayPhone = call.phone || '未知号码'

  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'w-full rounded-md border px-2.5 py-2 text-left transition-colors ' +
        (active
          ? 'border-primary bg-primary-fixed text-text-main shadow-sm'
          : 'border-transparent bg-white hover:border-border-subtle hover:bg-surface-container-low')
      }
    >
      <div className="flex items-center gap-2">
        <span
          className={
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full ' +
            (answered ? 'bg-action-green/12 text-action-green' : 'bg-error/12 text-error')
          }
        >
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
            {directionOut ? 'north_east' : 'south_west'}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-bold text-text-main">{call.contactName || '客户'}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-text-muted">
            <span className="truncate font-mono-data">{displayPhone}</span>
            <span>·</span>
            <span>{formatDuration(call.durationSec)}</span>
          </div>
        </div>
        <span className={'h-2 w-2 shrink-0 rounded-full ' + (call.asrText ? 'bg-action-green' : 'bg-border-subtle')} />
      </div>
      <div className="mt-1 truncate text-[10px] text-text-muted">{formatShortDateTime(call.startedAt)}</div>
    </button>
  )
}

function CallTranscriptPane({ call }: { call: OrderCall }): React.JSX.Element {
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const [recordingInfo, setRecordingInfo] = useState<CallRecordingUrl | null>(null)
  const [recordingError, setRecordingError] = useState<string | null>(null)
  const hasRecording = !!call.recordingOssKey

  useEffect(() => {
    if (!hasRecording) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    setRecordingUrl(null)
    setRecordingInfo(null)
    setRecordingError(null)
    const load = (): void => {
      fetchCallRecordingUrl(call.id)
        .then((resp) => {
          if (!alive) return
          setRecordingInfo(resp)
          setRecordingError(null)
          if (resp.status === 'transcoding') {
            setRecordingUrl(null)
            timer = setTimeout(load, 3000)
            return
          }
          if (resp.status === 'failed') {
            setRecordingUrl(null)
            setRecordingError(resp.message || '录音转码失败')
            return
          }
          setRecordingUrl(resp.url)
        })
        .catch((error) => {
          if (!alive) return
          setRecordingUrl(null)
          setRecordingInfo(null)
          setRecordingError(error instanceof Error ? error.message : '录音地址加载失败')
        })
    }
    load()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [call.id, hasRecording])

  const answered = call.callStatus === 'answered'
  const directionOut = call.direction === 'out' || call.direction === 'outbound'
  const displayPhone = call.phone || '未知号码'

  return (
    <div className="min-h-0 overflow-y-auto rounded-lg border border-border-subtle bg-white">
      <div className="border-b border-border-subtle px-3 py-2">
        <div className="flex items-start gap-2.5">
        <div
          className={
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ' +
            (answered ? 'bg-action-green/10 text-action-green' : 'bg-error/10 text-error')
          }
        >
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
            {directionOut ? 'north_east' : 'south_west'}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <CopyText value={displayPhone} className="min-w-0 text-body-md font-bold text-text-main">
              <span className="truncate">{call.contactName || '客户'} - {displayPhone}</span>
            </CopyText>
            <span
              className={
                'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold ' +
                (answered ? 'bg-action-green/10 text-action-green' : 'bg-error/10 text-error')
              }
            >
              {answered ? '已接通' : '未接通'}
            </span>
            <button className="ml-auto text-text-muted hover:text-primary">
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>more_vert</span>
            </button>
          </div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            {formatShortDateTime(call.startedAt)} · 时长 {formatDuration(call.durationSec)}
          </div>
        </div>
      </div>
      </div>

      <div className="border-b border-border-subtle bg-surface-container-low px-3 py-2">
        {hasRecording && recordingInfo?.status === 'transcoding' ? (
          <div className="h-8 flex items-center gap-2 text-[11px] text-text-muted">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-[#0b4fb3]/40 bg-white text-[#0b4fb3]">
              <span className="material-symbols-outlined animate-spin" style={{ fontSize: '16px' }}>progress_activity</span>
            </span>
            <span>{recordingInfo.message || '录音正在转码，完成后会自动播放'}</span>
          </div>
        ) : hasRecording && recordingUrl && recordingInfo?.browserPlayable !== false ? (
          <CallAudioPlayer src={recordingUrl} fallbackDurationSec={call.durationSec} />
        ) : hasRecording && recordingUrl ? (
          <div className="h-8 flex items-center gap-2 text-[11px] text-text-muted">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-[#0b4fb3]/30 bg-white text-[#0b4fb3]/40">
              <span className="material-symbols-outlined filled" style={{ fontSize: '18px' }}>play_disabled</span>
            </span>
            <span>
              录音格式 {recordingInfo?.format || recordingInfo?.mimeType || '未知'} 浏览器不能直接播放，需要后台转码
            </span>
          </div>
        ) : hasRecording ? (
          <div className="h-8 flex items-center gap-2 text-[11px] text-text-muted">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-[#0b4fb3]/30 bg-white text-[#0b4fb3]/40">
              <span className="material-symbols-outlined filled" style={{ fontSize: '18px' }}>play_arrow</span>
            </span>
            <span>{recordingError || '录音地址加载中...'}</span>
          </div>
        ) : (
          <div className="h-8 flex items-center gap-2 text-[11px] text-text-muted">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-[#0b4fb3]/20 bg-white text-[#0b4fb3]/30">
              <span className="material-symbols-outlined filled" style={{ fontSize: '18px' }}>play_arrow</span>
            </span>
            <span>无录音文件</span>
          </div>
        )}
      </div>

      <div className="p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-h3-title text-text-main">转写文本</h3>
          <span className={'rounded px-2 py-0.5 text-[11px] font-bold ' + (call.asrText ? 'bg-action-green/10 text-action-green' : 'bg-surface-bg text-text-muted')}>
            {call.asrText ? '已转写' : asrStatusLabel(call.asrStatus)}
          </span>
        </div>
        {call.asrText ? (
          <p className="min-h-52 whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-surface-bg px-3 py-3 text-body-sm leading-relaxed text-text-main">
            {call.asrText}
          </p>
        ) : (
          <EmptyText>{asrStatusLabel(call.asrStatus)}</EmptyText>
        )}
      </div>
    </div>
  )
}

function CallAudioPlayer({
  src,
  fallbackDurationSec
}: {
  src: string
  fallbackDurationSec: number
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playRequestRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [starting, setStarting] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(fallbackDurationSec || 0)
  const [error, setError] = useState<string | null>(null)
  const total = duration > 0 ? duration : fallbackDurationSec
  const percent = total > 0 ? Math.min(100, Math.max(0, (current / total) * 100)) : 0

  useEffect(() => {
    playRequestRef.current += 1
    setPlaying(false)
    setStarting(false)
    setCurrent(0)
    setDuration(fallbackDurationSec || 0)
    setError(null)
  }, [src, fallbackDurationSec])

  const toggle = async (): Promise<void> => {
    const audio = audioRef.current
    if (!audio) return
    if (starting) return
    try {
      setError(null)
      if (audio.paused) {
        const requestId = playRequestRef.current + 1
        playRequestRef.current = requestId
        setStarting(true)
        await audio.play()
        if (playRequestRef.current === requestId) {
          setStarting(false)
          setPlaying(true)
        }
      } else {
        playRequestRef.current += 1
        audio.pause()
        setStarting(false)
        setPlaying(false)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : '音频播放失败'
      if (message.includes('interrupted by a call to pause')) {
        setStarting(false)
        return
      }
      setStarting(false)
      setPlaying(false)
      setError(message)
    }
  }

  return (
    <div className="min-h-8">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration
          if (Number.isFinite(value) && value > 0) setDuration(value)
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onPause={() => setPlaying(false)}
        onPlaying={() => {
          setStarting(false)
          setPlaying(true)
        }}
        onEnded={() => {
          playRequestRef.current += 1
          setStarting(false)
          setPlaying(false)
          setCurrent(0)
        }}
        onError={() => {
          playRequestRef.current += 1
          setStarting(false)
          setPlaying(false)
          setError(mediaErrorLabel(audioRef.current))
        }}
      />
      <div className="flex h-8 items-center gap-2.5">
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={starting}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-[#0b4fb3] bg-[#0b4fb3] text-white shadow-sm hover:bg-[#083f91] hover:border-[#083f91] disabled:opacity-70 transition-colors"
          title={playing ? '暂停录音' : starting ? '正在加载录音' : '播放录音'}
        >
          <span className="material-symbols-outlined filled" style={{ fontSize: '17px' }}>
            {playing ? 'pause' : 'play_arrow'}
          </span>
        </button>
        <div className="h-1.5 flex-1 rounded-full bg-[#c6ccdd] overflow-hidden">
          <div className="h-full rounded-full bg-[#0b4fb3]" style={{ width: `${percent}%` }} />
        </div>
        <span className="shrink-0 text-[11px] font-mono-data text-text-muted">
          {formatAudioClock(current)} / {formatAudioClock(total)}
        </span>
      </div>
      {error && (
        <div className="mt-2 text-[11px] text-error">
          {error}
          <span className="ml-1 text-text-muted">({audioUrlHost(src)})</span>
        </div>
      )}
    </div>
  )
}

function ApplicationAiSummaryCard({
  applicationNo,
  messageCount,
  callCount
}: {
  applicationNo: string
  messageCount: number
  callCount: number
}): React.JSX.Element {
  const [brief, setBrief] = useState<OrderBrief | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!applicationNo) return
    let alive = true
    fetchApplicationBrief(applicationNo)
      .then((resp) => {
        if (!alive) return
        setBrief(resp.brief)
        setUpdatedAt(resp.updatedAt)
        setError(null)
      })
      .catch((e) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : '加载申请级 AI 总结失败')
      })
    return () => {
      alive = false
    }
  }, [applicationNo])

  function refresh(): void {
    if (!applicationNo || busy) return
    setBusy(true)
    setError(null)
    refreshApplicationBrief(applicationNo)
      .then((next) => {
        setBrief(next)
        setUpdatedAt(new Date().toISOString())
      })
      .catch((e) => setError(e instanceof Error ? e.message : '刷新申请级 AI 总结失败'))
      .finally(() => setBusy(false))
  }

  return (
    <section className="relative border-t border-ai-accent/20 bg-surface px-4 pt-4 pb-3 shadow-[0_-4px_12px_rgba(76,29,149,0.06)]">
      <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-ai-accent to-transparent opacity-45" />
      <div className="mb-3 flex items-center gap-2">
        <span className="material-symbols-outlined text-ai-accent" style={{ fontSize: '18px' }}>auto_awesome</span>
        <h3 className="text-body-md font-bold text-ai-accent-strong">AI 简报</h3>
        <span className="text-[11px] font-medium text-ai-accent-muted">消息 {messageCount} 条 · 通话 {callCount} 条</span>
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1 text-ai-accent hover:text-ai-accent-strong text-[11px] font-bold disabled:opacity-50"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>refresh</span>
          {busy ? '生成中' : '重新生成'}
        </button>
      </div>

      {error && <div className="mb-3 rounded border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">{error}</div>}
      <div className="rounded-md border border-ai-accent/20 bg-ai-surface px-3 py-2.5">
        {brief?.summary ? (
          <p className="whitespace-pre-wrap text-body-sm font-semibold leading-relaxed text-ai-accent-strong">{brief.summary}</p>
        ) : (
          <p className="text-body-sm text-ai-accent-muted">
            暂无 AI 简报。收到通话转写后会自动生成；微信和企微消息会按既有规则累积后生成。
          </p>
        )}
      </div>
      {updatedAt && <div className="mt-2 text-[11px] text-text-muted">更新于 {formatDateTime(updatedAt)}{brief?.model ? ` · ${brief.model}` : ''}</div>}
    </section>
  )
}

function OrderAiTaskPanel({
  order,
  aggregate
}: {
  order: Order
  aggregate: OrderAggregateResponse | null
}): React.JSX.Element {
  const [brief, setBrief] = useState<OrderBrief | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    fetchOrderBrief(order.id)
      .then((resp) => {
        if (!alive) return
        setBrief(resp.brief)
        setUpdatedAt(resp.updatedAt)
      })
      .catch((e) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : '加载订单 AI 任务失败')
      })
      .finally(() => {
        if (!alive) return
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [order.id])

  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    setError(null)
    refreshOrderBrief(order.id)
      .then((next) => {
        setBrief(next)
        setUpdatedAt(new Date().toISOString())
      })
      .catch((e) => setError(e instanceof Error ? e.message : '刷新订单 AI 任务失败'))
      .finally(() => setRefreshing(false))
  }

  const keyInfoEntries = Object.entries(brief?.keyInfo || {}).filter(([, value]) => !!value)
  const tasks = buildAiTasks(brief, keyInfoEntries)
  const messageCount = aggregate?.messages.length ?? 0
  const callCount = aggregate?.calls.length ?? 0

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-ai-purple font-bold text-body-md">
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>psychology_alt</span>
            订单 AI 任务
          </div>
          <div className="mt-0.5 truncate text-[11px] text-text-muted">
            当前订单 · 消息 {messageCount} 条 · 通话 {callCount} 条
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="shrink-0 inline-flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-[11px] font-bold text-primary hover:bg-primary-fixed disabled:opacity-50"
        >
          <span className={'material-symbols-outlined ' + (refreshing ? 'animate-spin' : '')} style={{ fontSize: '14px' }}>
            {refreshing ? 'progress_activity' : 'refresh'}
          </span>
          {refreshing ? '生成中' : '刷新'}
        </button>
      </div>

      {error && <div className="rounded border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">{error}</div>}

      {loading && !brief ? (
        <div className="rounded-lg border border-dashed border-border-subtle bg-surface-bg px-3 py-8 text-center text-body-sm text-text-muted">
          加载订单 AI 任务...
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle bg-surface-bg px-4 py-8 text-center">
          <span className="material-symbols-outlined text-ai-purple" style={{ fontSize: '32px' }}>task_alt</span>
          <div className="mt-2 text-body-md font-bold text-text-main">暂无 AI 任务</div>
          <div className="mt-1 text-body-sm text-text-muted">采集内容生成后，会把风险、待办和回填信息整理成任务。</div>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {tasks.map((task, index) => (
              <AiTaskItem key={`${task.kind}-${task.title}-${index}`} task={task} />
            ))}
          </div>

          {keyInfoEntries.length > 0 && (
            <section className="rounded-lg border border-border-subtle bg-white">
              <div className="border-b border-border-subtle px-3 py-2 text-label-caps text-text-muted">
                待回填信息
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 p-3 text-body-sm">
                {keyInfoEntries.map(([key, value]) => (
                  <BriefKv key={key} name={key} value={value} />
                ))}
              </dl>
            </section>
          )}

          {updatedAt && (
            <p className="text-center text-[11px] text-text-muted">
              任务生成于 {formatDateTime(updatedAt)}{brief?.model ? ` · ${brief.model}` : ''}
            </p>
          )}
        </>
      )}
    </div>
  )
}

interface AiTask {
  kind: 'risk' | 'action' | 'fill'
  title: string
  detail?: string
}

function buildAiTasks(brief: OrderBrief | null, keyInfoEntries: Array<[string, string | null]>): AiTask[] {
  if (!brief) return []
  const risks = brief.risks.map((risk) => ({ kind: 'risk' as const, title: '处理风险', detail: risk }))
  const actions = brief.nextActions.map((action) => ({ kind: 'action' as const, title: '跟进动作', detail: action }))
  const fills = keyInfoEntries.slice(0, 6).map(([key, value]) => ({
    kind: 'fill' as const,
    title: `回填${key}`,
    detail: value || undefined
  }))
  return [...risks, ...actions, ...fills]
}

function AiTaskItem({ task }: { task: AiTask }): React.JSX.Element {
  const style = {
    risk: {
      icon: 'warning',
      iconClass: 'bg-error/10 text-error border-error/20',
      badgeClass: 'bg-error/10 text-error',
      label: '风险'
    },
    action: {
      icon: 'checklist',
      iconClass: 'bg-primary-fixed text-primary border-primary-fixed-dim',
      badgeClass: 'bg-primary-fixed text-primary',
      label: '待办'
    },
    fill: {
      icon: 'edit_note',
      iconClass: 'bg-action-green/10 text-action-green border-action-green/20',
      badgeClass: 'bg-action-green/10 text-action-green',
      label: '回填'
    }
  }[task.kind]

  return (
    <section className="rounded-lg border border-border-subtle bg-white p-3">
      <div className="flex items-start gap-2">
        <span className={'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ' + style.iconClass}>
          <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>{style.icon}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ' + style.badgeClass}>{style.label}</span>
            <h3 className="truncate text-body-sm font-bold text-text-main">{task.title}</h3>
          </div>
          {task.detail && <p className="mt-1 text-body-sm leading-relaxed text-text-muted">{task.detail}</p>}
        </div>
      </div>
    </section>
  )
}

function BriefKv({ name, value }: { name: string; value: string | null }): React.JSX.Element {
  return (
    <>
      <dt className="whitespace-nowrap text-text-muted">{name}</dt>
      <dd className={value ? 'min-w-0 break-words text-text-main' : 'text-text-muted/50'}>{value || '—'}</dd>
    </>
  )
}

function OrderExecutionPanel({
  orders,
  selectedOrder,
  onSelect,
  communicationOpen,
  onOrderAreaClick
}: {
  orders: Order[]
  selectedOrder: Order
  onSelect: (id: number) => void
  communicationOpen: boolean
  onOrderAreaClick: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<RightTab>('taikang-detail')
  const [detailResp, setDetailResp] = useState<OrderDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [aggregate, setAggregate] = useState<OrderAggregateResponse | null>(null)
  const [materials, setMaterials] = useState<Material[]>([])
  const selectedIndex = Math.max(0, orders.findIndex((order) => order.id === selectedOrder.id))

  const reloadMaterials = useCallback(() => {
    return fetchMaterials(selectedOrder.id).then(setMaterials)
  }, [selectedOrder.id])

  useEffect(() => {
    let alive = true
    setDetailLoading(true)
    setDetailResp(null)
    setDetailError(null)
    fetchOrderDetail(selectedOrder.id)
      .then((resp) => {
        if (!alive) return
        setDetailResp(resp)
        setDetailLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setDetailError(e instanceof Error ? e.message : '加载订单详情失败')
        setDetailLoading(false)
      })
    fetchOrderAggregate(selectedOrder.id)
      .then((resp) => alive && setAggregate(resp))
      .catch(() => alive && setAggregate(null))
    reloadMaterials().catch(() => undefined)
    return () => {
      alive = false
    }
  }, [selectedOrder.id, reloadMaterials])

  return (
    <aside
      onClick={onOrderAreaClick}
      className={
        (communicationOpen ? 'w-[40%] border-l ' : 'w-full ') +
        'min-h-0 bg-white border-border-subtle flex flex-col transition-[width] duration-200'
      }
    >
      <div className="shrink-0 border-b border-border-subtle bg-[#fafafa] px-3 py-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded border border-border-subtle bg-white px-2 py-0.5 text-[11px] font-bold text-text-main">
            <span className="material-symbols-outlined text-primary" style={{ fontSize: '14px' }}>inventory_2</span>
            {orders.length} 个订单
          </span>
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label="订单切换">
            {orders.map((order, index) => {
              const active = order.id === selectedOrder.id
              return (
                <button
                  key={order.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSelect(order.id)}
                  title={`${order.sourceOrderNo} · ${bizType(order)}`}
                  className={
                    'shrink-0 rounded-t-md border border-b-2 px-2.5 py-0.5 text-left text-[11px] transition-colors ' +
                    (active
                      ? 'border-primary border-b-primary bg-white font-bold text-primary'
                      : 'border-border-subtle border-b-transparent bg-surface-container-high text-text-muted hover:bg-white hover:text-text-main')
                  }
                >
                  <span className="block max-w-28 truncate font-mono-data">{order.sourceOrderNo}</span>
                  <span className="block max-w-28 truncate text-[10px] font-normal">第 {index + 1} 单 · {bizType(order)}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="bg-white border-l-2 border-primary border-y border-r border-border-subtle px-3 py-2 rounded-r shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <CopyText value={selectedOrder.sourceOrderNo} className="font-mono-data text-[16px] font-bold text-text-main">
              <span>{selectedOrder.sourceOrderNo}</span>
            </CopyText>
            <span className="shrink-0 text-[10px] text-text-muted">第 {selectedIndex + 1}/{orders.length} 个</span>
          </div>
          <CompactLifecycleTimeline order={selectedOrder} />
        </div>
      </div>

      <div className="flex border-b border-border-subtle bg-[#fafafa]">
        <PanelTab label="B端订单详情" active={tab === 'taikang-detail'} onClick={() => setTab('taikang-detail')} />
        <PanelTab label="寰宇订单详情" active={tab === 'huanyu-detail'} onClick={() => setTab('huanyu-detail')} />
        <PanelTab label="数据补录" active={tab === 'entry'} onClick={() => setTab('entry')} />
        <PanelTab label="AI 任务" active={tab === 'ai'} onClick={() => setTab('ai')} />
      </div>

      {detailLoading ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-12 text-text-muted gap-3">
          <div className="w-8 h-8 border-3 border-primary/25 border-t-primary rounded-full animate-spin" />
          <span className="text-body-sm font-medium">正在拉取最新订单数据…</span>
        </div>
      ) : detailError ? (
        <div className="p-6 m-4 rounded-lg bg-red-50 border border-error/25 text-error text-body-sm flex items-center gap-2">
          <span className="material-symbols-outlined text-error">error</span>
          <span>{detailError}</span>
        </div>
      ) : (
        <>
          {tab === 'taikang-detail' && (
            <OrderDetailPanel order={selectedOrder} detailResp={detailResp} error={detailError} />
          )}
          {tab === 'huanyu-detail' && (
            <HuanyuOrderDetailPanel
              key={selectedOrder.id}
              order={selectedOrder}
              detailResp={detailResp}
            />
          )}
          {tab === 'entry' && (
            <OrderDataEntryPanel order={selectedOrder} materials={materials} onReload={reloadMaterials} />
          )}
          {tab === 'ai' && (
            <OrderAiTaskPanel order={selectedOrder} aggregate={aggregate} />
          )}
        </>
      )}

      {!detailLoading && tab !== 'huanyu-detail' && (
        <div className="shrink-0 border-t border-border-subtle bg-white p-4 flex justify-end gap-3 shadow-[0_-4px_12px_rgba(0,0,0,0.02)]">
          <button disabled className="px-4 py-2 bg-surface-container border border-border-subtle text-text-main text-body-sm font-bold rounded opacity-70">
            Hold Order
          </button>
          <button disabled className="px-4 py-2 bg-primary text-white text-body-sm font-bold rounded inline-flex items-center gap-2 opacity-70">
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>check_circle</span>
            Complete & Next
          </button>
        </div>
      )}
    </aside>
  )
}

function OrderDetailPanel({
  order,
  detailResp,
  error
}: {
  order: Order
  detailResp: OrderDetailResponse | null
  error: string | null
}): React.JSX.Element {
  const raw = (order.rawJson ?? {}) as Record<string, unknown>
  const rec = (detailResp?.detail?.recommendations ?? {}) as Record<string, unknown>
  const groups = buildDetailGroups(order, raw, rec)
  const attachments = detailResp?.attachments ?? []
  const [escortEntryActive, setEscortEntryActive] = useState(false)
  const hasEscortEntryTab = serviceFlowTabsFor(bizType(order).trim()).some((tab) => tab.key === 'service-record' && tab.label === '陪诊录入')

  useEffect(() => {
    setEscortEntryActive(false)
  }, [order.id])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      {error && <div className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">{error}</div>}
      {groups.filter((group) => group.title !== '运营审核信息').map((group) => (
        <BOrderDetailGroup key={group.title} title={group.title} rows={group.rows} />
      ))}
      <AttachmentSection items={attachments} />
      {groups.filter((group) => group.title === '运营审核信息').map((group) => (
        <BOrderDetailGroup key={group.title} title={group.title} rows={group.rows} />
      ))}
      {/* 两个同级组件必须使用不同的 key。订单详情首屏会在多个请求回填后重渲染，
          相同 key 会让 React 的节点协调失去确定性，从而可能重复保留沟通记录区域。 */}
      <CommunicationRecordPanel key={`communication-${order.id}`} />
      <ServiceInformationFlow key={`service-flow-${order.id}`} order={order} onEscortEntryActiveChange={setEscortEntryActive} />
      {hasEscortEntryTab && (
        <div hidden={!escortEntryActive}>
          <CheckCompanionInformationPanel key={`check-companion-${order.id}`} />
        </div>
      )}
    </div>
  )
}

function HuanyuOrderDetailPanel({
  order,
  detailResp,
  onOrderUpdated
}: {
  order: Order
  detailResp?: OrderDetailResponse | null
  onOrderUpdated?: (order: Order) => void
}): React.JSX.Element {
  const detailOrder = (detailResp as any)?.order ?? (detailResp as any)?.data?.order
  const currentOrder = detailOrder
    ? {
        ...order,
        ...detailOrder,
        rawJson: {
          ...(typeof order.rawJson === 'object' && order.rawJson ? order.rawJson : {}),
          ...(typeof detailOrder.rawJson === 'object' && detailOrder.rawJson ? detailOrder.rawJson : {})
        }
      }
    : order

  const formKey = useMemo(() => {
    const raw = (currentOrder.rawJson ?? {}) as Record<string, unknown>
    return `${currentOrder.id}_${currentOrder.updatedAt || ''}_${JSON.stringify(raw)}`
  }, [currentOrder])

  const initialEscorts: HuanyuEscortRow[] = useMemo(() => {
    const list = (currentOrder.rawJson as any)?.escortList
    if (Array.isArray(list) && list.length > 0) {
      return list.map((item: any, idx: number) => ({
        id: idx + 1,
        orderNo: item.orderNo || (currentOrder.rawJson as any)?.orderNo || '',
        serviceDate: escortServiceDateInputValue(item.serviceDate || ''),
        escortName: item.escortName || '',
        escortType: item.escortType || '',
        phone: item.phone || '',
        area: item.area || '',
        sequence: item.sequence || String(idx + 1)
      }))
    }
    return []
  }, [currentOrder])

  return (
    <HuanyuOrderForm
      key={formKey}
      initialForm={buildHuanyuForm(currentOrder)}
      initialEscorts={initialEscorts}
      onSaveSuccess={(savedOrder) => {
        clearOrdersCache()
        window.dispatchEvent(new CustomEvent('huanyu-orders-updated'))
        onOrderUpdated?.(savedOrder)
      }}
    />
  )
}

function isHuanyuCancelledOrderStatus(value: unknown): boolean {
  const status = typeof value === 'string' ? value.trim() : ''
  return status === '已取消' || status === '无责取消'
}

export function HuanyuOrderCreatePage({ onBack, onCreated }: { onBack: () => void; onCreated?: (order: Order) => void }): React.JSX.Element {
  const [initialForm] = useState(() => buildEmptyHuanyuForm())

  return (
    <main className="flex h-full min-h-0 flex-col bg-surface-bg">
      <header className="shrink-0 border-b border-border-subtle bg-white px-6 py-4">
        <div className="mx-auto flex w-full max-w-[1600px] items-center gap-4">
          <button type="button" onClick={onBack} className="flex h-9 w-9 items-center justify-center rounded-md text-text-muted hover:bg-surface-bg hover:text-text-main" title="返回工作台">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div className="min-w-0">
            <h1 className="text-h2-header text-text-main">新建寰宇订单</h1>
            <p className="mt-0.5 text-body-sm text-text-muted">寰宇自建订单，不关联 B 端订单</p>
          </div>
          <div className="ml-auto rounded-md bg-surface-bg px-3 py-2 text-body-sm text-text-muted">
            DDBH：<span className="font-mono-data font-semibold text-text-main">{String(initialForm.orderNo)}</span>
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[1600px] min-h-0 flex-1">
        <HuanyuOrderForm initialForm={initialForm} mode="create" onSaveSuccess={(order) => {
          if (onCreated) {
            onCreated(order)
          } else {
            window.alert('寰宇订单创建成功！')
            onBack()
          }
        }} />
      </div>
    </main>
  )
}

function HuanyuOrderForm({
  initialForm,
  initialEscorts,
  mode = 'detail',
  onSaveSuccess
}: {
  initialForm: Record<string, string | boolean>
  initialEscorts?: HuanyuEscortRow[]
  mode?: 'detail' | 'create'
  onSaveSuccess?: (order: Order) => void
}): React.JSX.Element {
  const currentAccountManager = getSession()?.displayName || getSession()?.employeeCode || ''
  const defaultedInitialForm = {
    ...initialForm,
    accountManager: mode === 'create'
      ? (currentAccountManager || initialForm.accountManager)
      : (initialForm.accountManager || ''),
    ...(initialForm.bookingChannelType === '3' ? { bd: '无' } : {})
  }
  const [form, setForm] = useState(() => (
    isHuanyuCancelledOrderStatus(defaultedInitialForm.orderStatus)
      ? { ...defaultedInitialForm, orderAmount: '0', amountChanged: false }
      : defaultedInitialForm
  ))

  useEffect(() => {
    setForm(
      isHuanyuCancelledOrderStatus(defaultedInitialForm.orderStatus)
        ? { ...defaultedInitialForm, orderAmount: '0', amountChanged: false }
        : defaultedInitialForm
    )
  }, [initialForm])
  const [escortRows, setEscortRows] = useState<HuanyuEscortRow[]>(() => {
    if (initialEscorts && initialEscorts.length > 0) {
      return initialEscorts
    }
    return [
      {
        id: 1,
        orderNo: typeof defaultedInitialForm.orderNo === 'string' ? defaultedInitialForm.orderNo : '',
        serviceDate: escortServiceDateInputValue(typeof defaultedInitialForm.escortServiceDate === 'string' ? defaultedInitialForm.escortServiceDate : ''),
        escortName: typeof defaultedInitialForm.escortName === 'string' ? defaultedInitialForm.escortName : '',
        escortType: typeof defaultedInitialForm.escortType === 'string' ? defaultedInitialForm.escortType : '',
        phone: typeof defaultedInitialForm.escortPhone === 'string' ? defaultedInitialForm.escortPhone : '',
        area: typeof defaultedInitialForm.escortArea === 'string' ? defaultedInitialForm.escortArea : '',
        sequence: typeof defaultedInitialForm.escortSequence === 'string' ? defaultedInitialForm.escortSequence : '1'
      }
    ]
  })
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const isCreate = mode === 'create'
  const initialChannelServiceId = useRef(typeof initialForm.channelService === 'string' ? initialForm.channelService : '')
  const initialOrderAmount = useRef(typeof initialForm.orderAmount === 'string' ? initialForm.orderAmount : '')
  const hasSwitchedAwayFromInitialService = useRef(false)
  const [channelSearch, setChannelSearch] = useState('')
  const [channelOptions, setChannelOptions] = useState<HuanyuChannelOption[]>([])
  const [channelLoading, setChannelLoading] = useState(false)
  const [channelError, setChannelError] = useState<string | null>(null)
  const [serviceSearch, setServiceSearch] = useState('')
  const [serviceOptions, setServiceOptions] = useState<HuanyuChannelProductOption[]>([])
  const [serviceLoading, setServiceLoading] = useState(false)
  const [serviceError, setServiceError] = useState<string | null>(null)
  const [bookingChannelTypeOptions, setBookingChannelTypeOptions] = useState<HuanyuChannelOption[]>([])
  const [documentTypeOptions, setDocumentTypeOptions] = useState<HuanyuChannelOption[]>([])
  const [bdSearch, setBdSearch] = useState('')
  const [bdOptions, setBdOptions] = useState<HuanyuChannelOption[]>([])
  const [bdLoading, setBdLoading] = useState(false)
  const [bdError, setBdError] = useState<string | null>(null)
  const [hospitalSearch, setHospitalSearch] = useState('')
  const [hospitalOptions, setHospitalOptions] = useState<HuanyuChannelOption[]>([])
  const [hospitalLoading, setHospitalLoading] = useState(false)
  const [hospitalError, setHospitalError] = useState<string | null>(null)
  const [addressSearch, setAddressSearch] = useState('')
  const [addressOptions, setAddressOptions] = useState<HuanyuChannelOption[]>([])
  const [addressLoading, setAddressLoading] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [departmentSearch, setDepartmentSearch] = useState('')
  const [departmentOptions, setDepartmentOptions] = useState<HuanyuHospitalDepartmentOption[]>([])
  const [departmentLoading, setDepartmentLoading] = useState(false)
  const [departmentError, setDepartmentError] = useState<string | null>(null)
  const [doctorSearch, setDoctorSearch] = useState('')
  const [doctorOptions, setDoctorOptions] = useState<HuanyuDoctorOption[]>([])
  const [doctorLoading, setDoctorLoading] = useState(false)
  const [doctorError, setDoctorError] = useState<string | null>(null)
  const [expertSearch, setExpertSearch] = useState('')
  const [expertOptions, setExpertOptions] = useState<HuanyuChannelOption[]>([])
  const channelId = typeof form.channel === 'string' ? form.channel : ''
  const hospitalId = typeof form.hospital === 'string' ? form.hospital : ''
  const amountLocked = isHuanyuCancelledOrderStatus(form.orderStatus)
  const bdSelectable = form.bookingChannelType === '1' || form.bookingChannelType === '2'
  const doctorAllowsExpertSelection = typeof form.doctor === 'string' && form.doctor.endsWith('WXSYSXM')

  async function handleSave(): Promise<void> {
    setIsSaving(true)
    setSaveStatus(null)
    try {
      const res = await saveHuanyuOrder({
        mode: isCreate ? 'create' : 'update',
        orderNo: String(form.orderNo || ''),
        orderStatus: String(form.orderStatus || '待处理'),
        channel: String(form.channel || ''),
        channelOrderNo: String(form.channelOrderNo || ''),
        backupOrderNo: String(form.backupOrderNo || ''),
        channelDetail: String(form.channelDetail || ''),
        channelContact: String(form.channelContact || ''),
        channelBackupContact: String(form.channelBackupContact || ''),
        channelService: String(form.channelService || ''),
        internalLevelOne: String(form.internalLevelOne || ''),
        internalLevelTwo: String(form.internalLevelTwo || ''),
        orderAmount: String(form.orderAmount || ''),
        accountManager: String(form.accountManager || currentAccountManager),
        bookingChannelType: String(form.bookingChannelType || ''),
        bd: String(form.bd || ''),
        patientName: String(form.patientName || ''),
        documentType: String(form.documentType || ''),
        documentNo: String(form.documentNo || ''),
        patientGender: String(form.patientGender || ''),
        patientAge: String(form.patientAge || ''),
        patientPhone: String(form.patientPhone || ''),
        familyName: String(form.familyName || ''),
        familyRelation: String(form.familyRelation || ''),
        familyPhone: String(form.familyPhone || ''),
        disease: String(form.disease || ''),
        expectedBookingTime: String(form.expectedBookingTime || ''),
        patientRequest: String(form.patientRequest || ''),
        hospital: String(form.hospital || ''),
        hospitalAddress: String(form.hospitalAddress || ''),
        department: String(form.department || ''),
        internalHospitalLevelOne: String(form.internalHospitalLevelOne || ''),
        internalHospitalLevelTwo: String(form.internalHospitalLevelTwo || ''),
        doctor: String(form.doctor || ''),
        expertLevel: String(form.expertLevel || ''),
        serviceRemark: String(form.serviceRemark || ''),
        tkHospital: String(form.tkHospital || ''),
        tkProvince: String(form.tkProvince || ''),
        tkCity: String(form.tkCity || ''),
        tkDepartment: String(form.tkDepartment || ''),
        requestTime: String(form.requestTime || ''),
        requestDefaultDate: String(form.requestDefaultDate || ''),
        responseTime: String(form.responseTime || ''),
        responseDefaultDate: String(form.responseDefaultDate || ''),
        serviceStartTime: String(form.serviceStartTime || ''),
        serviceStartDefaultDate: String(form.serviceStartDefaultDate || ''),
        bookingFeedbackTime: String(form.bookingFeedbackTime || ''),
        bookingFeedbackDefaultDate: String(form.bookingFeedbackDefaultDate || ''),
        latestTicketTime: String(form.latestTicketTime || ''),
        latestTicketDefaultDate: String(form.latestTicketDefaultDate || ''),
        registrationFee: String(form.registrationFee || ''),
        advancePayment: String(form.advancePayment || ''),
        advanceRegistrationFee: String(form.advanceRegistrationFee || ''),
        advanceRecovered: String(form.advanceRecovered || ''),
        registrationRefund: String(form.registrationRefund || ''),
        alipayAccount: String(form.alipayAccount || ''),
        hasInsurance: String(form.hasInsurance || ''),
        insuranceType: String(form.insuranceType || ''),
        smsLink: String(form.smsLink || ''),
        escortSummary: String(form.escortSummary || ''),
        escortList: escortRows.map((r) => ({
          serviceDate: r.serviceDate,
          escortName: r.escortName,
          escortType: r.escortType,
          phone: r.phone,
          area: r.area,
          sequence: r.sequence
        }))
      })

      if (res.ok) {
        clearOrdersCache()
        if (res.order) {
          const nextOrderNo = (res.order.rawJson as any)?.orderNo || (res.order.rawJson as any)?.DDBH || res.order.sourceOrderNo || ''
          if (nextOrderNo) {
            setForm((current) => ({ ...current, orderNo: nextOrderNo }))
          }
        }
        setSaveStatus({ type: 'success', message: '保存成功！' })
        if (onSaveSuccess) {
          onSaveSuccess(res.order)
        }
      } else {
        setSaveStatus({ type: 'error', message: res.message || '保存失败' })
      }
    } catch (err) {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : '保存失败' })
    } finally {
      setIsSaving(false)
    }
  }

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setChannelLoading(true)
      setChannelError(null)
      fetchHuanyuChannels(channelSearch)
        .then((options) => active && setChannelOptions(options))
        .catch((error: unknown) => active && setChannelError(error instanceof Error ? error.message : 'B端渠道加载失败'))
        .finally(() => active && setChannelLoading(false))
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [channelSearch])

  useEffect(() => {
    if (!channelId) {
      setServiceOptions([])
      setServiceError(null)
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      setServiceLoading(true)
      setServiceError(null)
      fetchHuanyuChannelProducts(channelId, serviceSearch)
        .then((options) => active && setServiceOptions(options))
        .catch((error: unknown) => active && setServiceError(error instanceof Error ? error.message : 'B端渠道服务项目加载失败'))
        .finally(() => active && setServiceLoading(false))
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [channelId, serviceSearch])

  useEffect(() => {
    let active = true
    fetchHuanyuBookingChannelTypes()
      .then((options) => active && setBookingChannelTypeOptions(options))
      .catch(() => active && setBookingChannelTypeOptions([]))
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    fetchHuanyuDocumentTypes()
      .then((options) => active && setDocumentTypeOptions(options))
      .catch(() => active && setDocumentTypeOptions([]))
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!bdSelectable) {
      setBdOptions([])
      setBdError(null)
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      setBdLoading(true)
      setBdError(null)
      fetchHuanyuBdUsers(bdSearch)
        .then((options) => active && setBdOptions(options))
        .catch((error: unknown) => active && setBdError(error instanceof Error ? error.message : 'BD加载失败'))
        .finally(() => active && setBdLoading(false))
    }, 180)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [bdSelectable, bdSearch])

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setHospitalLoading(true)
      setHospitalError(null)
      fetchHuanyuHospitals(hospitalSearch)
        .then((options) => active && setHospitalOptions(options))
        .catch((error: unknown) => active && setHospitalError(error instanceof Error ? error.message : '医院加载失败'))
        .finally(() => active && setHospitalLoading(false))
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [hospitalSearch])

  useEffect(() => {
    if (!hospitalId) {
      setAddressOptions([])
      setDepartmentOptions([])
      setDoctorOptions([])
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      setAddressLoading(true)
      setAddressError(null)
      fetchHuanyuHospitalAddresses(hospitalId, addressSearch)
        .then((options) => active && setAddressOptions(options))
        .catch((error: unknown) => active && setAddressError(error instanceof Error ? error.message : '医院地址加载失败'))
        .finally(() => active && setAddressLoading(false))
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [hospitalId, addressSearch])

  useEffect(() => {
    if (!hospitalId) return
    let active = true
    const timer = window.setTimeout(() => {
      setDepartmentLoading(true)
      setDepartmentError(null)
      fetchHuanyuHospitalDepartments(hospitalId, departmentSearch)
        .then((options) => active && setDepartmentOptions(options))
        .catch((error: unknown) => active && setDepartmentError(error instanceof Error ? error.message : '科室加载失败'))
        .finally(() => active && setDepartmentLoading(false))
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [hospitalId, departmentSearch])

  useEffect(() => {
    if (!hospitalId) return
    let active = true
    const timer = window.setTimeout(() => {
      setDoctorLoading(true)
      setDoctorError(null)
      fetchHuanyuHospitalDoctors(hospitalId, doctorSearch)
        .then((options) => active && setDoctorOptions(options))
        .catch((error: unknown) => active && setDoctorError(error instanceof Error ? error.message : '医生加载失败'))
        .finally(() => active && setDoctorLoading(false))
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [hospitalId, doctorSearch])

  useEffect(() => {
    if (!doctorAllowsExpertSelection) {
      setExpertOptions([])
      return
    }
    let active = true
    fetchHuanyuExpertLevels(expertSearch)
      .then((options) => active && setExpertOptions(options))
      .catch(() => active && setExpertOptions([]))
    return () => { active = false }
  }, [doctorAllowsExpertSelection, expertSearch])

  function changeField(key: string, value: string | boolean): void {
    setForm((current) => {
      if (key === 'orderStatus') {
        const next = { ...current, orderStatus: value }
        return isHuanyuCancelledOrderStatus(value)
          ? { ...next, orderAmount: '0', amountChanged: false }
          : next
      }
      if (key === 'bookingChannelType') {
        if (value === '3') return { ...current, bookingChannelType: value, bd: '无' }
        if (value === '1' || value === '2') {
          return { ...current, bookingChannelType: value, bd: current.bd === '无' ? '' : current.bd }
        }
        return { ...current, bookingChannelType: value, bd: '' }
      }
      // 取消订单不允许开启“金额修改”，避免 UI 状态与只读金额不一致。
      if (key === 'amountChanged' && isHuanyuCancelledOrderStatus(current.orderStatus)) {
        return { ...current, amountChanged: false, orderAmount: '0' }
      }
      return { ...current, [key]: value }
    })
  }

  function selectChannel(nextChannelId: string): void {
    setForm((current) => ({
      ...current,
      channel: nextChannelId,
      channelService: '',
      internalLevelOne: '',
      internalLevelTwo: ''
    }))
    setServiceSearch('')
  }

  function selectChannelService(nextServiceId: string): void {
    const service = serviceOptions.find((item) => item.id === nextServiceId)
    if (!service) return
    const isInitialService = service.id === initialChannelServiceId.current
    if (!isInitialService) hasSwitchedAwayFromInitialService.current = true
    setForm((current) => {
      return {
        ...current,
        channelService: service.id,
        internalLevelOne: service.internalLevelOne,
        internalLevelTwo: service.internalLevelTwo,
        orderAmount: isHuanyuCancelledOrderStatus(current.orderStatus)
          ? '0'
          : isInitialService
            ? hasSwitchedAwayFromInitialService.current ? initialOrderAmount.current : current.orderAmount
            : service.price,
        // 选择或切换服务项目后，价格必须由字典控制，不能手动修改。
        amountChanged: false
      }
    })
  }

  function selectHospital(nextHospitalId: string): void {
    setForm((current) => ({
      ...current,
      hospital: nextHospitalId,
      hospitalAddress: '',
      department: '',
      internalHospitalLevelOne: '',
      internalHospitalLevelTwo: '',
      doctor: '',
      expertLevel: ''
    }))
    setAddressSearch('')
    setDepartmentSearch('')
    setDoctorSearch('')
    setExpertSearch('')
  }

  function selectHospitalDepartment(nextDepartmentId: string): void {
    const department = departmentOptions.find((item) => item.id === nextDepartmentId)
    if (!department) return
    setForm((current) => ({
      ...current,
      department: department.id,
      internalHospitalLevelOne: department.internalLevelOne,
      internalHospitalLevelTwo: department.internalLevelTwo
    }))
  }

  function selectHospitalDoctor(nextDoctorId: string): void {
    const doctor = doctorOptions.find((item) => item.id === nextDoctorId)
    if (!doctor) return
    setForm((current) => ({
      ...current,
      doctor: doctor.id,
      expertLevel: doctor.id.endsWith('WXSYSXM') ? '' : doctor.expertLevel
    }))
    setExpertSearch('')
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto relative flex flex-col">
      {/* 顶部吸顶固定操作栏 */}
      <div className="sticky top-0 z-20 shrink-0 border-b border-border-subtle bg-white/95 px-4 py-2.5 backdrop-blur shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-bold text-text-main">
              {isCreate ? '新建寰宇订单' : `寰宇订单：${form.orderNo || '待生成'}`}
            </span>
            {saveStatus && (
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${
                saveStatus.type === 'success' ? 'bg-green-50 text-action-green border border-action-green/30' : 'bg-red-50 text-error border border-error/30'
              }`}>
                {saveStatus.message}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isCreate ? (
              <button
                type="button"
                disabled={isSaving}
                onClick={handleSave}
                className="rounded-md bg-action-green px-4 py-1.5 text-body-sm font-semibold text-white shadow-sm hover:bg-action-green/90 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <span className="material-symbols-outlined text-[16px]">save</span>
                {isSaving ? '保存中…' : '保存'}
              </button>
            ) : (
              ['保存', '刷新预约模板信息', '数据留痕', '复制订单', '退款', '推送泰康支付失败', '推送泰康支付成功', '确认推送寰宇订单信息'].map((label) => (
                <button
                  key={label}
                  type="button"
                  disabled={label === '保存' && isSaving}
                  onClick={label === '保存' ? handleSave : undefined}
                  className={
                    'rounded-md px-3 py-1.5 text-body-sm font-semibold text-white shadow-sm disabled:opacity-50 transition-colors ' +
                    (label === '确认推送寰宇订单信息'
                      ? 'bg-primary hover:bg-primary/90'
                      : label === '保存'
                        ? 'bg-action-green hover:bg-action-green/90'
                        : 'bg-action-green/90 hover:bg-action-green')
                  }
                >
                  {label === '保存' && isSaving ? '保存中…' : label}
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 表单内容滚动区 */}
      <div className="p-4 space-y-4">
        <HuanyuFormSection title="订单基本信息">
        <HuanyuFormGrid>
          <HuanyuInput label="订单号" value={form.orderNo} onChange={(value) => changeField('orderNo', value)} disabled />
          <HuanyuSelect label="订单状态" value={form.orderStatus} onChange={(value) => changeField('orderStatus', value)} />
          <HuanyuSearchSelect label="B端渠道" value={form.channel} options={channelOptions} loading={channelLoading} error={channelError} onSearch={setChannelSearch} onChange={selectChannel} />
          <HuanyuInput label="B端渠道订单号" value={form.channelOrderNo} onChange={(value) => changeField('channelOrderNo', value)} disabled />
          <HuanyuInput label="备用订单号" value={form.backupOrderNo} onChange={(value) => changeField('backupOrderNo', value)} />
          <HuanyuInput label="B端细分渠道" value={form.channelDetail} onChange={(value) => changeField('channelDetail', value)} />
          <HuanyuInput label="B端对接人" value={form.channelContact} onChange={(value) => changeField('channelContact', value)} />
          <HuanyuInput label="B端对接人（备用）" value={form.channelBackupContact} onChange={(value) => changeField('channelBackupContact', value)} />
          <HuanyuSearchSelect label="B端渠道服务项目" value={form.channelService} options={serviceOptions} loading={serviceLoading} error={serviceError} disabled={!channelId} disabledPlaceholder="请先选择 B端渠道" onSearch={setServiceSearch} onChange={selectChannelService} />
          <HuanyuInput label="内部一级" value={form.internalLevelOne} onChange={(value) => changeField('internalLevelOne', value)} disabled />
          <HuanyuInput label="内部二级" value={form.internalLevelTwo} onChange={(value) => changeField('internalLevelTwo', value)} disabled />
          <HuanyuAmountField value={amountLocked ? '0' : form.orderAmount} editable={Boolean(form.amountChanged)} locked={amountLocked} onChange={(value) => changeField('orderAmount', value)} onEditableChange={(value) => changeField('amountChanged', value)} />
          <HuanyuInput label="客户经理" value={form.accountManager} onChange={(value) => changeField('accountManager', value)} disabled />
          <HuanyuSelect label="预约渠道类型" value={form.bookingChannelType} options={bookingChannelTypeOptions.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => changeField('bookingChannelType', value)} />
          {form.bookingChannelType === '3'
            ? <HuanyuInput label="BD" value="无" onChange={(value) => changeField('bd', value)} disabled />
            : <HuanyuSearchSelect label="BD" value={form.bd} options={bdOptions} loading={bdLoading} error={bdError} disabled={!bdSelectable} disabledPlaceholder="请先选择预约渠道类型为 BD 或公共" onSearch={setBdSearch} onChange={(value) => changeField('bd', value)} />}
        </HuanyuFormGrid>
      </HuanyuFormSection>

      <HuanyuFormSection title="就诊人信息">
        <HuanyuFormGrid>
          <HuanyuInput label="就诊人姓名" value={form.patientName} onChange={(value) => changeField('patientName', value)} disabled={!isCreate} />
          <HuanyuSelect label="证件类型" value={form.documentType} options={documentTypeOptions.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => changeField('documentType', value)} />
          <HuanyuInput label="证件号码" value={form.documentNo} onChange={(value) => changeField('documentNo', value)} />
          <HuanyuSelect label="就诊人性别" value={form.patientGender} options={['男', '女']} onChange={(value) => changeField('patientGender', value)} />
          <HuanyuInput label="就诊人年龄" value={form.patientAge} onChange={(value) => changeField('patientAge', value)} />
          <HuanyuInput label="就诊人联系电话" value={form.patientPhone} onChange={(value) => changeField('patientPhone', value)} />
          <HuanyuInput label="家属姓名" value={form.familyName} onChange={(value) => changeField('familyName', value)} />
          <HuanyuInput label="家属关系" value={form.familyRelation} onChange={(value) => changeField('familyRelation', value)} />
          <HuanyuInput label="家属联系电话" value={form.familyPhone} onChange={(value) => changeField('familyPhone', value)} />
          <HuanyuInput label="就诊人疾病" value={form.disease} onChange={(value) => changeField('disease', value)} />
          <HuanyuInput label="期望预约时间" value={form.expectedBookingTime} onChange={(value) => changeField('expectedBookingTime', value)} />
          <HuanyuInput label="客户就诊需求备注" value={form.patientRequest} onChange={(value) => changeField('patientRequest', value)} wide />
        </HuanyuFormGrid>
      </HuanyuFormSection>

      <HuanyuFormSection title="医院信息">
        <HuanyuFormGrid>
          <HuanyuSearchSelect label="医院" value={form.hospital} options={hospitalOptions} loading={hospitalLoading} error={hospitalError} onSearch={setHospitalSearch} onChange={selectHospital} />
          <HuanyuSearchSelect label="医院地址" value={form.hospitalAddress} options={addressOptions} loading={addressLoading} error={addressError} disabled={!hospitalId} disabledPlaceholder="请先选择医院" onSearch={setAddressSearch} onChange={(value) => changeField('hospitalAddress', value)} />
          <HuanyuSearchSelect label="科室" value={form.department} options={departmentOptions} loading={departmentLoading} error={departmentError} disabled={!hospitalId} disabledPlaceholder="请先选择医院" onSearch={setDepartmentSearch} onChange={selectHospitalDepartment} />
          <HuanyuInput label="内对一级" value={form.internalHospitalLevelOne} onChange={(value) => changeField('internalHospitalLevelOne', value)} disabled />
          <HuanyuInput label="内对二级" value={form.internalHospitalLevelTwo} onChange={(value) => changeField('internalHospitalLevelTwo', value)} disabled />
          <HuanyuSearchSelect label="医生" value={form.doctor} options={doctorOptions} loading={doctorLoading} error={doctorError} disabled={!hospitalId} disabledPlaceholder="请先选择医院" onSearch={setDoctorSearch} onChange={selectHospitalDoctor} />
          {doctorAllowsExpertSelection
            ? <HuanyuSearchSelect label="专家级别" value={form.expertLevel} options={expertOptions} loading={false} error={null} onSearch={setExpertSearch} onChange={(value) => changeField('expertLevel', value)} />
            : <HuanyuInput label="专家级别" value={form.expertLevel} onChange={(value) => changeField('expertLevel', value)} disabled />}
          <HuanyuInput label="订单服务备注" value={form.serviceRemark} onChange={(value) => changeField('serviceRemark', value)} wide />
          <HuanyuInput label="泰康医院" value={form.tkHospital} onChange={(value) => changeField('tkHospital', value)} disabled />
          <HuanyuInput label="泰康省份" value={form.tkProvince} onChange={(value) => changeField('tkProvince', value)} disabled />
          <HuanyuInput label="泰康城市" value={form.tkCity} onChange={(value) => changeField('tkCity', value)} disabled />
          <HuanyuInput label="泰康科室" value={form.tkDepartment} onChange={(value) => changeField('tkDepartment', value)} disabled />
        </HuanyuFormGrid>
      </HuanyuFormSection>

      <HuanyuFormSection title="时间信息">
        <HuanyuTimeInformation form={form} onChange={changeField} />
      </HuanyuFormSection>

      <HuanyuFormSection title="陪诊信息">
        <HuanyuEscortInformationTable
          initialRow={{
            orderNo: typeof form.orderNo === 'string' ? form.orderNo : '',
            serviceDate: escortServiceDateInputValue(typeof form.escortServiceDate === 'string' ? form.escortServiceDate : ''),
            escortName: typeof form.escortName === 'string' ? form.escortName : '',
            escortType: typeof form.escortType === 'string' ? form.escortType : '',
            phone: typeof form.escortPhone === 'string' ? form.escortPhone : '',
            area: typeof form.escortArea === 'string' ? form.escortArea : '',
            sequence: typeof form.escortSequence === 'string' ? form.escortSequence : '1'
          }}
          rows={escortRows}
          onChangeRows={setEscortRows}
        />
      </HuanyuFormSection>

      <HuanyuFormSection title="挂号费及医保信息">
        <HuanyuFormGrid>
          <HuanyuInput label="挂号费金额" value={form.registrationFee} onChange={(value) => changeField('registrationFee', value)} type="number" />
          <HuanyuSelect label="是否垫付" value={form.advancePayment} options={[{ value: '0', label: '否' }, { value: '1', label: '是' }]} onChange={(value) => changeField('advancePayment', value)} />
          <HuanyuInput label="垫付挂号费金额" value={form.advanceRegistrationFee} onChange={(value) => changeField('advanceRegistrationFee', value)} disabled />
          <HuanyuInput label="垫付是否收回" value={form.advanceRecovered} onChange={(value) => changeField('advanceRecovered', value)} disabled />
          <HuanyuInput label="挂号费退款客户金额" value={form.registrationRefund} onChange={(value) => changeField('registrationRefund', value)} disabled />
          <HuanyuInput label="支付宝支付账号" value={form.alipayAccount} onChange={(value) => changeField('alipayAccount', value)} disabled />
          <HuanyuInput label="是否有医保" value={form.hasInsurance} onChange={(value) => changeField('hasInsurance', value)} disabled />
          <HuanyuSelect label="医保类型" value={form.insuranceType} onChange={(value) => changeField('insuranceType', value)} />
          <HuanyuInput label="短信链接" value={form.smsLink} onChange={(value) => changeField('smsLink', value)} disabled />
        </HuanyuFormGrid>
      </HuanyuFormSection>

      <HuanyuFormSection title="预约模板信息（对内）">
        <HuanyuTextarea label="预约模板内容" value={form.internalBookingTemplate} onChange={(value) => changeField('internalBookingTemplate', value)} disabled copyable />
      </HuanyuFormSection>

      <HuanyuFormSection title="预约模板信息（对外）">
        <HuanyuTextarea label="预约模板内容" value={form.externalBookingTemplate} onChange={(value) => changeField('externalBookingTemplate', value)} disabled copyable />
      </HuanyuFormSection>

      <HuanyuFormSection title="陪诊服务小结">
        <HuanyuTextarea label="服务小结" value={form.escortSummary} onChange={(value) => changeField('escortSummary', value)} placeholder="请输入陪诊服务小结" minHeight="min-h-44" />
        <div className="mt-4 border-t border-border-subtle pt-4">
          <div className="mb-3 text-body-sm font-semibold text-text-main">陪诊相关附件上传</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {Array.from({ length: 10 }, (_, index) => (
              <button key={index} type="button" className="flex h-16 items-center justify-center rounded-md border border-dashed border-border-subtle text-text-muted hover:border-primary hover:text-primary" title="附件上传功能后续接入">
                <span className="material-symbols-outlined">attach_file</span>
              </button>
            ))}
          </div>
        </div>
      </HuanyuFormSection>
      </div>
    </div>
  )
}

function generateHuanyuOrderNo(date = new Date()): string {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const random = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('')
  return `HYDD${ymd}${random}`
}

function buildEmptyHuanyuForm(): Record<string, string | boolean> {
  const orderNo = generateHuanyuOrderNo()
  const currentAccountManager = getSession()?.displayName || getSession()?.employeeCode || ''
  return {
    orderNo,
    orderStatus: '',
    channel: '',
    channelOrderNo: '',
    backupOrderNo: '',
    channelDetail: '',
    channelContact: '',
    channelBackupContact: '',
    channelService: '',
    internalLevelOne: '',
    internalLevelTwo: '',
    orderAmount: '',
    amountChanged: false,
    accountManager: currentAccountManager,
    bookingChannelType: '',
    bd: '',
    patientName: '',
    documentType: '',
    documentNo: '',
    patientGender: '',
    patientAge: '',
    patientPhone: '',
    familyName: '',
    familyRelation: '',
    familyPhone: '',
    disease: '',
    expectedBookingTime: '',
    patientRequest: '',
    hospital: '',
    hospitalAddress: '',
    department: '',
    internalHospitalLevelOne: '',
    internalHospitalLevelTwo: '',
    doctor: '',
    expertLevel: '',
    serviceRemark: '',
    tkHospital: '',
    tkProvince: '',
    tkCity: '',
    tkDepartment: '',
    requestTime: '',
    requestDefaultDate: '',
    requestDefaultTime: '',
    responseTime: '',
    responseDefaultDate: '',
    responseDefaultTime: '',
    serviceStartTime: '',
    serviceStartDefaultDate: '',
    serviceStartDefaultTime: '',
    bookingFeedbackTime: '',
    bookingFeedbackDefaultDate: '',
    bookingFeedbackDefaultTime: '',
    latestTicketTime: '',
    latestTicketDefaultDate: '',
    latestTicketDefaultTime: '',
    escortOrderNo: orderNo,
    escortServiceDate: '',
    escortName: '',
    escortType: '',
    escortPhone: '',
    escortArea: '',
    escortSequence: '1',
    registrationFee: '',
    advancePayment: '',
    advanceRegistrationFee: '',
    advanceRecovered: '',
    registrationRefund: '',
    alipayAccount: '',
    hasInsurance: '',
    insuranceType: '',
    smsLink: '',
    internalBookingTemplate: '',
    externalBookingTemplate: '',
    escortSummary: ''
  }
}

function buildHuanyuForm(order: Order): Record<string, string | boolean> {
  const raw = (order.rawJson ?? {}) as Record<string, unknown>
  const value = (keys: string[], fallback?: unknown): string => pick({}, raw, keys, fallback)
  const bookingTime = value(['bookingTime', 'serviceDate', 'appointTime'], order.intendDate)
  const patientName = value(['patientName', 'customerName', 'name'], order.customerName)
  const patientPhone = value(['patientPhone', 'customerPhone', 'phone', 'mobile'], order.customerPhone)
  const hospital = value(['hospital', 'hospitalName', 'intendHos'], order.hospital)
  const department = value(['dept', 'department', 'intendDept'], order.dept)
  const doctor = value(['doctor', 'doctorName', 'intendDoc'], order.doctor)

  const requestTime = toHuanyuDateTimeLocal(value(['requestTime', 'demandTime']))
  const responseTime = toHuanyuDateTimeLocal(value(['responseTime']))
  const serviceStartTime = toHuanyuDateTimeLocal(value(['serviceStartTime']))
  const bookingFeedbackTime = toHuanyuDateTimeLocal(value(['bookingFeedbackTime']))
  const latestTicketTime = toHuanyuDateTimeLocal(value(['latestTicketTime', 'ticketDeadline'], bookingTime))
  const fallbackDefaultDate = value(['defaultDate']).replace(/\D/g, '').slice(0, 8)
  const fallbackDefaultTime = value(['defaultTime'])

  return {
    // 寰宇订单号：若已有维护保存的 DDBH 单号则回显，否则初始留空
    orderNo: value(['orderNo', 'DDBH', 'hyOrderNo', 'hyydOrderNo']),
    orderStatus: value(['orderStatus', 'status'], order.status),
    channel: value(['channel', 'bChannel', 'sourceChannel'], sourceStyle(order).label),
    channelOrderNo: value(['bOrderNo', 'channelOrderNo', 'sourceOrderNo'], order.sourceOrderNo),
    backupOrderNo: value(['backupOrderNo']),
    channelDetail: value(['channelDetail', 'bChannelDetail']),
    channelContact: value(['channelContact', 'bContact']),
    channelBackupContact: value(['channelBackupContact', 'bBackupContact']),
    channelService: value(['channelService', 'serviceProject', 'bizType'], bizType(order)),
    internalLevelOne: value(['internalLevelOne', 'innerLevelOne']),
    internalLevelTwo: value(['internalLevelTwo', 'innerLevelTwo']),
    orderAmount: value(['orderAmount', 'amount', 'price']),
    amountChanged: false,
    accountManager: value(['accountManager', 'customerManager']),
    bookingChannelType: value(['bookingChannelType', 'appointmentChannelType']),
    bd: value(['bd', 'businessDevelopment']),
    patientName,
    documentType: value(['documentType', 'certType', 'idType']),
    documentNo: value(['documentNo', 'certNo', 'idNo', 'idCard']),
    patientGender: value(['gender', 'sex']),
    patientAge: value(['age']),
    patientPhone,
    familyName: value(['familyName', 'contactName']),
    familyRelation: value(['familyRelation', 'relation']),
    familyPhone: value(['familyPhone', 'contactPhone']),
    disease: value(['disease', 'suspectDisease']),
    expectedBookingTime: value(['expectedBookingTime', 'intendDate'], order.intendDate),
    patientRequest: value(['patientRequest', 'comments', 'comment']),
    hospital,
    hospitalAddress: value(['hospitalAddress', 'address']),
    department,
    internalHospitalLevelOne: value(['internalHospitalLevelOne', 'hospitalLevelOne']),
    internalHospitalLevelTwo: value(['internalHospitalLevelTwo', 'hospitalLevelTwo']),
    doctor,
    expertLevel: value(['expertLevel', 'doctorLevel']),
    serviceRemark: value(['serviceRemark', 'orderRemark', 'comments']),
    tkHospital: value(['tkHospital', 'taikangHospital'], hospital),
    tkProvince: value(['tkProvince', 'taikangProvince', 'province']),
    tkCity: value(['tkCity', 'taikangCity', 'city']),
    tkDepartment: value(['tkDepartment', 'taikangDept'], department),
    requestTime,
    requestDefaultDate: huanyuDatePart(requestTime),
    requestDefaultTime: huanyuTimePart(requestTime),
    responseTime,
    responseDefaultDate: huanyuDatePart(responseTime),
    responseDefaultTime: huanyuTimePart(responseTime),
    serviceStartTime,
    serviceStartDefaultDate: huanyuDatePart(serviceStartTime),
    serviceStartDefaultTime: huanyuTimePart(serviceStartTime),
    bookingFeedbackTime,
    bookingFeedbackDefaultDate: huanyuDatePart(bookingFeedbackTime),
    bookingFeedbackDefaultTime: huanyuTimePart(bookingFeedbackTime),
    latestTicketTime,
    latestTicketDefaultDate: huanyuDatePart(latestTicketTime) || fallbackDefaultDate,
    latestTicketDefaultTime: huanyuTimePart(latestTicketTime) || fallbackDefaultTime,
    // 陪诊信息关联寰宇订单号，不使用 B 端渠道订单号；订单号当前由后台生成，前端先留空。
    escortOrderNo: value(['escortOrderNo', 'hyydOrderNo', 'orderNo']),
    escortServiceDate: value(['escortServiceDate', 'serviceDate'], bookingTime),
    escortName: value(['escortName', 'companionName']),
    escortType: value(['escortType', 'companionType']),
    escortPhone: value(['escortPhone', 'companionPhone']),
    escortArea: value(['escortArea', 'area']),
    escortSequence: value(['escortSequence', 'companionSequence']),
    registrationFee: value(['registrationFee']),
    advancePayment: value(['advancePayment']),
    advanceRegistrationFee: value(['advanceRegistrationFee']),
    advanceRecovered: value(['advanceRecovered']),
    registrationRefund: value(['registrationRefund']),
    alipayAccount: value(['alipayAccount']),
    hasInsurance: huanyuInsuranceLabel(value(['hasInsurance', 'medicalInsurance'])),
    insuranceType: value(['insuranceType', 'medicalInsuranceType']),
    smsLink: value(['smsLink']),
    internalBookingTemplate: buildHuanyuBookingTemplate('对内', { channel: value(['channel', 'bChannel'], sourceStyle(order).label), orderNo: value(['orderNo', 'hyydOrderNo'], order.sourceOrderNo), channelOrderNo: value(['bOrderNo', 'channelOrderNo'], order.sourceOrderNo), service: value(['channelService', 'serviceProject'], bizType(order)), patientName, patientPhone, hospital, department, doctor, bookingTime, escortName: value(['escortName', 'companionName']), escortPhone: value(['escortPhone', 'companionPhone']), hospitalAddress: value(['hospitalAddress', 'address']), remark: value(['serviceRemark', 'orderRemark', 'comments']) }),
    externalBookingTemplate: buildHuanyuBookingTemplate('对外', { patientName, patientPhone, hospital, department, doctor, bookingTime, escortName: value(['escortName', 'companionName']), escortPhone: value(['escortPhone', 'companionPhone']), hospitalAddress: value(['hospitalAddress', 'address']), remark: value(['serviceRemark', 'orderRemark', 'comments']) }),
    escortSummary: value(['escortSummary', 'serviceSummary'])
  }
}

function buildHuanyuBookingTemplate(kind: '对内' | '对外', values: Record<string, string>): string {
  const lines = kind === '对内'
    ? [['渠道', values.channel], ['订单号', values.orderNo], ['渠道订单号', values.channelOrderNo], ['服务项目', values.service]]
    : []
  return [...lines, ['就诊人', values.patientName], ['联系电话', values.patientPhone], ['医院', values.hospital], ['科室', values.department], ['医生', values.doctor], ['就诊日期', values.bookingTime], ['陪诊人', values.escortName], ['陪诊人电话', values.escortPhone], ['医院地址', values.hospitalAddress], ['订单服务备注', values.remark]]
    .map(([label, content]) => `${label}：${content || ''}`)
    .join('\n')
}

function huanyuInsuranceLabel(value: string): string {
  if (value === '0') return '无医保'
  if (value === '1') return '有医保'
  return value
}

function toHuanyuDateTimeLocal(value: string): string {
  const match = value.trim().match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})[ T]?(\d{2})?:?(\d{2})?(?::?(\d{2}))?$/)
  if (!match || !match[4] || !match[5]) return ''
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}`
}

function escortServiceDateInputValue(value: string): string {
  const match = value.trim().match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

function huanyuDatePart(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T/)
  return match ? `${match[1]}${match[2]}${match[3]}` : ''
}

function huanyuTimePart(value: string): string {
  const match = value.match(/T(\d{2}:\d{2})(?::(\d{2}))?$/)
  return match ? `${match[1]}:${match[2] || '00'}` : ''
}

function HuanyuFormSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border-subtle bg-white p-4">
      <h3 className="mb-4 text-[17px] font-bold text-primary">{title}</h3>
      {children}
    </section>
  )
}

function HuanyuFormGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">{children}</div>
}

function HuanyuTimeInformation({
  form,
  onChange
}: {
  form: Record<string, string | boolean>
  onChange: (key: string, value: string | boolean) => void
}): React.JSX.Element {
  const rows = [
    { label: '需求时间', timeKey: 'requestTime', dateKey: 'requestDefaultDate', defaultTimeKey: 'requestDefaultTime' },
    { label: '应答时间', timeKey: 'responseTime', dateKey: 'responseDefaultDate', defaultTimeKey: 'responseDefaultTime' },
    { label: '启动服务时间', timeKey: 'serviceStartTime', dateKey: 'serviceStartDefaultDate', defaultTimeKey: 'serviceStartDefaultTime' },
    { label: '预约反馈时间', timeKey: 'bookingFeedbackTime', dateKey: 'bookingFeedbackDefaultDate', defaultTimeKey: 'bookingFeedbackDefaultTime' },
    { label: '最晚取号时间', timeKey: 'latestTicketTime', dateKey: 'latestTicketDefaultDate', defaultTimeKey: 'latestTicketDefaultTime' }
  ]

  return (
    <div className="space-y-3">
      {rows.map(({ label, timeKey, dateKey, defaultTimeKey }) => (
        <div key={timeKey} className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-3">
          <label className="flex min-w-0 items-center gap-2">
            <span className="w-28 shrink-0 text-right text-body-sm font-medium text-text-muted">{label}：</span>
            <input
              type="datetime-local"
              step="1"
              value={typeof form[timeKey] === 'string' ? form[timeKey] : ''}
              onChange={(event) => {
                const nextValue = event.target.value
                onChange(timeKey, nextValue)
                onChange(dateKey, huanyuDatePart(nextValue))
                onChange(defaultTimeKey, huanyuTimePart(nextValue))
              }}
              className="h-9 min-w-0 flex-1 rounded-md border border-border-subtle bg-white px-3 text-body-sm text-text-main outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </label>
          <HuanyuInput label="默认日期" value={form[dateKey]} onChange={(value) => onChange(dateKey, value)} disabled />
          <HuanyuInput label="默认时间" value={form[defaultTimeKey]} onChange={(value) => onChange(defaultTimeKey, value)} disabled />
        </div>
      ))}
    </div>
  )
}

interface HuanyuEscortRow {
  id: number
  orderNo: string
  serviceDate: string
  escortName: string
  escortType: string
  phone: string
  area: string
  sequence: string
}

function HuanyuEscortInformationTable({
  initialRow,
  rows: externalRows,
  onChangeRows
}: {
  initialRow: Omit<HuanyuEscortRow, 'id'>
  rows?: HuanyuEscortRow[]
  onChangeRows?: (rows: HuanyuEscortRow[]) => void
}): React.JSX.Element {
  const [internalRows, setInternalRows] = useState<HuanyuEscortRow[]>(() => [{ id: 1, ...initialRow }])
  const rows = externalRows ?? internalRows
  const setRows = onChangeRows ?? setInternalRows
  const [escortSearch, setEscortSearch] = useState('')
  const [escortOptions, setEscortOptions] = useState<HuanyuEscortOption[]>([])
  const [escortLoading, setEscortLoading] = useState(false)
  const [escortError, setEscortError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setEscortLoading(true)
      setEscortError(null)
      fetchHuanyuEscorts(escortSearch)
        .then((options) => active && setEscortOptions(options))
        .catch((error: unknown) => active && setEscortError(error instanceof Error ? error.message : '陪诊人员加载失败'))
        .finally(() => active && setEscortLoading(false))
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [escortSearch])

  function changeRow(id: number, field: Exclude<keyof HuanyuEscortRow, 'id' | 'orderNo'>, value: string): void {
    if (onChangeRows) {
      onChangeRows(rows.map((row) => row.id === id ? { ...row, [field]: value } : row))
    } else {
      setInternalRows((current) => current.map((row) => row.id === id ? { ...row, [field]: value } : row))
    }
  }

  function addRow(): void {
    const nextRow: HuanyuEscortRow = {
      id: Date.now(),
      orderNo: initialRow.orderNo,
      serviceDate: '',
      escortName: '',
      escortType: '',
      phone: '',
      area: '',
      sequence: String(rows.length + 1)
    }
    if (onChangeRows) {
      onChangeRows([...rows, nextRow])
    } else {
      setInternalRows((current) => [...current, nextRow])
    }
  }

  function selectEscort(rowId: number, escortId: string): void {
    const escort = escortOptions.find((item) => item.id === escortId)
    if (!escort) return
    const updated = rows.map((row) => row.id === rowId ? {
      ...row,
      escortName: escort.id,
      escortType: escort.escortType,
      phone: escort.phone,
      area: escort.area
    } : row)
    if (onChangeRows) {
      onChangeRows(updated)
    } else {
      setInternalRows(updated)
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[980px] w-full border-collapse text-body-sm">
        <thead>
          <tr className="bg-surface-bg text-text-main">
            {['订单号', '服务日期', '陪诊人员', '陪诊人类型', '默认电话', '所在地区', '陪诊人序号'].map((label) => (
              <th key={label} className="border border-border-subtle px-3 py-2 text-center font-semibold whitespace-nowrap">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="border border-border-subtle p-1.5"><input disabled value={row.orderNo} className="h-8 w-full border-0 bg-surface-container px-2 text-center text-text-muted outline-none" /></td>
              <td className="border border-border-subtle p-1.5"><input type="date" value={row.serviceDate} onChange={(event) => changeRow(row.id, 'serviceDate', event.target.value)} className="h-8 w-full bg-white px-2 text-center text-text-main outline-none focus:ring-1 focus:ring-primary" /></td>
              <td className="border border-border-subtle p-1.5"><HuanyuEscortSelectCell value={row.escortName} options={escortOptions} loading={escortLoading} error={escortError} onSearch={setEscortSearch} onChange={(value) => selectEscort(row.id, value)} /></td>
              <td className="border border-border-subtle p-1.5"><input disabled value={row.escortType} className="h-8 w-full border-0 bg-surface-container px-2 text-center text-text-muted outline-none" /></td>
              <td className="border border-border-subtle p-1.5"><input disabled value={row.phone} className="h-8 w-full border-0 bg-surface-container px-2 text-center text-text-muted outline-none" /></td>
              <td className="border border-border-subtle p-1.5"><input disabled value={row.area} className="h-8 w-full border-0 bg-surface-container px-2 text-center text-text-muted outline-none" /></td>
              <td className="border border-border-subtle p-1.5"><input value={row.sequence} onChange={(event) => changeRow(row.id, 'sequence', event.target.value)} className="h-8 w-full bg-white px-2 text-center text-text-main outline-none focus:ring-1 focus:ring-primary" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex justify-end">
        <button type="button" onClick={addRow} className="inline-flex items-center gap-1.5 rounded-md bg-action-green px-3 py-2 text-body-sm font-semibold text-white hover:bg-action-green/90">
          <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>add</span>
          新增陪诊信息
        </button>
      </div>
    </div>
  )
}

function HuanyuEscortSelectCell({
  value,
  options,
  loading,
  error,
  onSearch,
  onChange
}: {
  value: string
  options: HuanyuEscortOption[]
  loading: boolean
  error: string | null
  onSearch: (value: string) => void
  onChange: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = options.find((option) => option.id === value)
  const shownValue = open ? search : selected?.name ?? value

  return (
    <div className="relative min-w-36">
      <input
        value={shownValue}
        placeholder="搜索陪诊人员"
        onFocus={() => {
          setOpen(true)
          setSearch('')
          onSearch('')
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          const next = event.target.value
          setSearch(next)
          onSearch(next)
          setOpen(true)
        }}
        className="h-8 w-full bg-white px-2 text-center text-text-main outline-none focus:ring-1 focus:ring-primary"
      />
      {open && (
        <div className="absolute z-30 mt-1 max-h-48 w-72 overflow-y-auto rounded-md border border-border-subtle bg-white py-1 text-left shadow-lg">
          {loading && <div className="px-3 py-2 text-text-muted">加载中…</div>}
          {!loading && error && <div className="px-3 py-2 text-error">{error}</div>}
          {!loading && !error && options.length === 0 && <div className="px-3 py-2 text-text-muted">暂无匹配数据</div>}
          {!loading && !error && options.map((option) => (
            <button
              key={option.id}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.id)
                setSearch('')
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-bg"
            >
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              <span className="shrink-0 font-mono-data text-[11px] text-text-muted">{option.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function HuanyuInput({
  label,
  value,
  onChange,
  wide = false,
  disabled = false,
  type = 'text'
}: {
  label: string
  value: string | boolean
  onChange: (value: string) => void
  wide?: boolean
  disabled?: boolean
  type?: React.HTMLInputTypeAttribute
}): React.JSX.Element {
  return (
    <label className={'flex min-w-0 items-center gap-2 ' + (wide ? 'md:col-span-2 xl:col-span-4' : '')}>
      <span className="w-28 shrink-0 text-right text-body-sm font-medium text-text-muted">{label}：</span>
      <input type={type} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} className={'h-9 min-w-0 flex-1 rounded-md border border-border-subtle px-3 text-body-sm text-text-main outline-none transition-colors ' + (disabled ? 'cursor-not-allowed bg-surface-container text-text-muted' : 'bg-white focus:border-primary focus:ring-1 focus:ring-primary')} />
    </label>
  )
}

interface HuanyuSelectOption {
  value: string
  label: string
}

interface HuanyuSearchOption {
  id: string
  name: string
}

function HuanyuSearchSelect({
  label,
  value,
  options,
  loading,
  error,
  disabled = false,
  disabledPlaceholder = '请先选择上级字段',
  onSearch,
  onChange
}: {
  label: string
  value: string | boolean
  options: HuanyuSearchOption[]
  loading: boolean
  error: string | null
  disabled?: boolean
  disabledPlaceholder?: string
  onSearch: (value: string) => void
  onChange: (value: string) => void
}): React.JSX.Element {
  const currentValue = typeof value === 'string' ? value : ''
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = options.find((option) => option.id === currentValue)
  const shownValue = open ? search : selected?.name ?? currentValue

  function closeSoon(): void {
    window.setTimeout(() => setOpen(false), 120)
  }

  return (
    <label className="relative flex min-w-0 items-center gap-2">
      <span className="w-28 shrink-0 text-right text-body-sm font-medium text-text-muted">{label}：</span>
      <div className="relative min-w-0 flex-1">
        <input
          value={shownValue}
          disabled={disabled}
          placeholder={disabled ? disabledPlaceholder : '输入名称或码值搜索'}
          onFocus={() => {
            setOpen(true)
            setSearch('')
            onSearch('')
          }}
          onBlur={closeSoon}
          onChange={(event) => {
            const next = event.target.value
            setSearch(next)
            onSearch(next)
            setOpen(true)
          }}
          className={'h-9 min-w-0 w-full rounded-md border border-border-subtle px-3 text-body-sm text-text-main outline-none transition-colors ' + (disabled ? 'cursor-not-allowed bg-surface-container text-text-muted' : 'bg-white focus:border-primary focus:ring-1 focus:ring-primary')}
        />
        {open && !disabled && (
          <div className="absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-border-subtle bg-white py-1 shadow-lg">
            {loading && <div className="px-3 py-2 text-body-sm text-text-muted">加载中…</div>}
            {!loading && error && <div className="px-3 py-2 text-body-sm text-error">{error}</div>}
            {!loading && !error && options.length === 0 && <div className="px-3 py-2 text-body-sm text-text-muted">暂无匹配数据</div>}
            {!loading && !error && options.map((option) => (
              <button
                key={option.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.id)
                  setSearch('')
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm text-text-main hover:bg-surface-bg"
              >
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                <span className="shrink-0 font-mono-data text-[11px] text-text-muted">{option.id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </label>
  )
}

function HuanyuSelect({
  label,
  value,
  options = [],
  onChange
}: {
  label: string
  value: string | boolean
  options?: Array<string | HuanyuSelectOption>
  onChange: (value: string) => void
}): React.JSX.Element {
  const currentValue = typeof value === 'string' ? value : ''
  const normalizedOptions = options.map((option) => typeof option === 'string' ? { value: option, label: option } : option)
  const visibleOptions = currentValue && !normalizedOptions.some((option) => option.value === currentValue)
    ? [{ value: currentValue, label: currentValue }, ...normalizedOptions]
    : normalizedOptions
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="w-28 shrink-0 text-right text-body-sm font-medium text-text-muted">{label}：</span>
      <select value={currentValue} onChange={(event) => onChange(event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border border-border-subtle bg-white px-3 text-body-sm text-text-main outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary">
        {visibleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}

function HuanyuAmountField({
  value,
  editable,
  locked = false,
  onChange,
  onEditableChange
}: {
  value: string | boolean
  editable: boolean
  locked?: boolean
  onChange: (value: string) => void
  onEditableChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-28 shrink-0 text-right text-body-sm font-medium text-text-muted">订单金额：</span>
      <input type="number" inputMode="decimal" step="0.01" disabled={locked || !editable} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} className={'h-9 w-24 shrink-0 rounded-md border border-border-subtle px-3 text-body-sm text-text-main outline-none transition-colors ' + (!locked && editable ? 'bg-white focus:border-primary focus:ring-1 focus:ring-primary' : 'cursor-not-allowed bg-surface-container text-text-muted')} />
      <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-body-sm text-text-main">
        <input type="checkbox" checked={editable} disabled={locked} onChange={(event) => onEditableChange(event.target.checked)} className="h-4 w-4 accent-primary disabled:cursor-not-allowed" />
        金额修改
      </label>
    </div>
  )
}

function HuanyuTextarea({
  label,
  value,
  onChange,
  placeholder = '请输入内容',
  minHeight = 'min-h-36',
  disabled = false,
  copyable = false
}: {
  label: string
  value: string | boolean
  onChange: (value: string) => void
  placeholder?: string
  minHeight?: string
  disabled?: boolean
  copyable?: boolean
}): React.JSX.Element {
  const textValue = typeof value === 'string' ? value : ''
  const [copied, setCopied] = useState(false)

  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="w-28 shrink-0 pt-2 text-right text-body-sm font-medium text-text-muted">{label}：</span>
      <div className="min-w-0 flex-1">
        <textarea disabled={disabled} value={textValue} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={'min-w-0 w-full resize-y rounded-md border border-border-subtle p-3 text-body-sm text-text-main outline-none transition-colors ' + (disabled ? 'cursor-not-allowed bg-surface-container text-text-muted' : 'bg-white focus:border-primary focus:ring-1 focus:ring-primary') + ' ' + minHeight} />
        {copyable && (
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              disabled={!textValue}
              onClick={() => {
                void navigator.clipboard?.writeText(textValue)
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              }}
              className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline disabled:cursor-not-allowed disabled:text-text-muted"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{copied ? 'check' : 'content_copy'}</span>
              {copied ? '已复制' : '复制内容'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function CompactLifecycleTimeline({ order }: { order: Order }): React.JSX.Element {
  const stage = stageIndexOf(order)
  const shortLabels = ['申领', '需求', '交付', '回填', '结束']

  return (
    <div className="relative mt-2 w-full px-1" title={`${bizType(order)} 生命周期 · ${order.status || LIFECYCLE_STAGES[stage]}`}>
      <div className="absolute left-5 right-5 top-4 h-0.5 rounded-full bg-border-subtle" />
      <div
        className="absolute left-5 top-4 h-0.5 rounded-full bg-action-green/55"
        style={{ width: `calc((100% - 2rem) * ${Math.max(0, stage) / (LIFECYCLE_STAGES.length - 1)})` }}
      />
      <div className="relative z-10 grid w-full grid-cols-5">
      {LIFECYCLE_STAGES.map((name, index) => {
        const done = index < stage
        const active = index === stage
        return (
          <div key={name} className="flex min-w-0 justify-center">
            <div className="flex min-w-0 flex-col items-center gap-0.5">
              <span
                className={
                  'flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-black ring-2 transition-all duration-200 ' +
                  (active
                    ? 'bg-primary text-white ring-primary/20 shadow-[0_8px_18px_rgba(37,99,235,0.28)] -translate-y-0.5'
                    : done
                      ? 'bg-action-green text-white ring-action-green/15 shadow-[0_5px_12px_rgba(34,197,94,0.18)]'
                      : 'bg-white text-text-muted ring-border-subtle border border-border-subtle')
                }
              >
                {index + 1}
              </span>
              <span
                className={
                  'max-w-9 truncate text-[10px] font-bold leading-none ' +
                  (active ? 'text-primary' : done ? 'text-action-green' : 'text-text-muted')
                }
              >
                {shortLabels[index]}
              </span>
            </div>
          </div>
        )
      })}
      </div>
    </div>
  )
}

function OrderDataEntryPanel({
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

  async function saveNote(): Promise<void> {
    const text = note.trim()
    if (!text) return
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

  async function onFilePick(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setErr(null)
    try {
      await addImageMaterial(order.id, file.type, await blobToBase64(file))
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
    setErr(null)
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
      <div className="p-4 border-b border-border-subtle shrink-0 space-y-3">
        <div className="rounded-lg bg-surface-bg border border-border-subtle px-3 py-2">
          <div className="text-label-caps text-text-muted">当前补录到订单</div>
          <div className="mt-1 flex items-center gap-2 min-w-0">
            <span className={'shrink-0 text-label-caps px-2 py-0.5 rounded ' + bizChipClass(order)}>{bizType(order)}</span>
            <CopyText value={order.sourceOrderNo} className="min-w-0 text-[11px] text-text-muted font-mono-data">
              <span className="truncate">{order.sourceOrderNo}</span>
            </CopyText>
          </div>
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          placeholder="补录本订单的文字资料..."
          className="w-full bg-surface-bg border border-border-subtle rounded-lg px-3 py-2 text-body-md focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary resize-none"
        />
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-surface-bg border border-border-subtle rounded-lg text-body-sm hover:bg-surface-container-low disabled:opacity-50"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>image</span>
            图片
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFilePick} />
          <button
            onClick={saveNote}
            disabled={busy || !note.trim()}
            className="px-4 py-2 bg-primary text-white rounded-lg text-body-sm font-semibold disabled:opacity-40"
          >
            保存补录
          </button>
        </div>
        {err && <p className="text-body-sm text-error">{err}</p>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
        <div className="text-label-caps text-text-muted">已补录资料（{materials.length}）</div>
        {materials.length === 0 ? (
          <EmptyText>还没有订单级补录资料</EmptyText>
        ) : (
          materials.map((material) => (
            <div key={material.id} className="group rounded-lg border border-border-subtle bg-surface-bg p-3 flex gap-2">
              <span className="material-symbols-outlined text-text-muted shrink-0" style={{ fontSize: '16px' }}>
                {material.type === 'image' ? 'image' : 'sticky_note_2'}
              </span>
              <div className="flex-1 min-w-0">
                {material.type === 'image' && material.url ? (
                  <img src={material.url} alt="补录图片" className="max-h-36 rounded object-contain" />
                ) : (
                  <p className="text-body-sm whitespace-pre-wrap break-words">{material.textContent}</p>
                )}
                <div className="mt-1 text-[11px] text-text-muted">{formatDateTime(material.createdAt)}</div>
              </div>
              <button
                onClick={() => remove(material.id)}
                className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-error transition-opacity"
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

function PanelTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={
        "flex-1 py-2 text-[13px] border-b-2 transition-colors whitespace-nowrap font-['Noto_Sans_SC'] font-black tracking-wide " +
        (active ? 'text-primary border-primary bg-white' : 'text-text-muted border-transparent hover:bg-white')
      }
    >
      {label}
    </button>
  )
}

interface DetailRowData {
  label: string
  value: string
  mono?: boolean
}

interface DetailGroupData {
  title: string
  rows: DetailRowData[]
}

function buildDetailGroups(
  order: Order,
  raw: Record<string, unknown>,
  rec: Record<string, unknown>
): DetailGroupData[] {
  const cardId = pickPreferUnmasked(rec, raw, ['cardId'])
  const socSecNo = pickPreferUnmasked(rec, raw, SOCIAL_SECURITY_KEYS)
  return [
    {
      title: '申请信息',
      rows: [
        detailRow('订单号', pick(rec, raw, ['subOrderNo', 'orderId'], order.sourceOrderNo), true),
        detailRow('申请号', pick(rec, raw, ['crmApplyNo']), true),
        detailRow('服务类型', pick(rec, raw, ['serviceName'], bizType(order))),
        detailRow('网络标签', pick(rec, raw, ['labelName', 'networkTag'])),
        detailRow('方案名称', pick(rec, raw, ['planName'])),
        detailRow('方案别名', pick(rec, raw, ['planAlias'])),
        detailRow('套餐名称', pick(rec, raw, ['packetName'])),
        detailRow('产品名称', pick(rec, raw, ['productName'])),
        detailRow('单元项', pick(rec, raw, ['itemName'])),
        detailRow('结算单元项', pick(rec, raw, ['serviceItemName']))
      ]
    },
    {
      title: '客户信息',
      rows: [
        detailRow('就诊人姓名', pick(rec, raw, ['patientName'], order.customerName)),
        detailRow('性别', pick(rec, raw, ['sex'])),
        detailRow('就诊人出生日期', pick(rec, raw, ['birthday'])),
        detailRow('就诊人证件类型', pick(rec, raw, ['cardType'])),
        detailRow('就诊人证件号码', cardId, true),
        detailRow('保单号', pickPreferUnmasked(rec, raw, ['insurNo']), true),
        detailRow('客户等级', pick(rec, raw, ['cusLevel'])),
        detailRow('是否医保', formatYesNo(pick(rec, raw, ['isSocSec']))),
        detailRow('医保城市', pick(rec, raw, ['medLoc'])),
        detailRow('社保卡号', socSecNo, true),
        detailRow('联系人姓名', pick(rec, raw, ['ecpName'])),
        detailRow('联系人手机号', pick(rec, raw, ['ecpPhone']), true),
        detailRow('第二联系人', pick(rec, raw, ['secEcpName'])),
        detailRow('第二联系人手机号', pick(rec, raw, ['secEcpPhone']), true),
        detailRow('权益所属分公司', pick(rec, raw, ['owner']))
      ]
    },
    {
      title: '意向就诊信息',
      rows: [
        detailRow('疑似疾病类型', pick(rec, raw, ['suspectDisease'])),
        detailRow('意向就诊城市', joinValues(pick(rec, raw, ['intendProvince']), pick(rec, raw, ['intendCity']))),
        detailRow('意向就诊医院', pick(rec, raw, ['intendHos', 'hospital'], order.hospital)),
        detailRow('意向就诊科室', pick(rec, raw, ['intendDept', 'dept'], order.dept)),
        detailRow('意向就诊医生', pick(rec, raw, ['intendDoc', 'doctor'], order.doctor)),
        detailRow('意向就诊医生职称', pick(rec, raw, ['intendDocTitle'])),
        detailRow('意向就诊时间', joinValues(pick(rec, raw, ['intendDate'], order.intendDate), pick(rec, raw, ['intendDateAmorpm']))),
        detailRow('出险时间', pick(rec, raw, ['acciTime'])),
        detailRow('备注信息', pick(rec, raw, ['comments', 'comment']))
      ]
    },
    {
      title: '运营审核信息',
      rows: [
        detailRow('审核疾病类型', pick(rec, raw, ['approveDiseaseType'])),
        detailRow('疾病描述', pick(rec, raw, ['approveDiseaseDesc'])),
        detailRow('审核意见', pick(rec, raw, ['reviewerResult']))
      ]
    }
  ]
}

function detailRow(label: string, value: unknown, mono = false): DetailRowData {
  return { label, value: normalizeValue(value), mono }
}

function BOrderDetailGroup({ title, rows }: { title: string; rows: DetailRowData[] }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface-bg"
        aria-expanded={open}
      >
        <h3 className="text-[16px] font-bold text-text-main">{title}</h3>
        <span className={'material-symbols-outlined text-text-muted transition-transform ' + (open ? 'rotate-180' : '')}>
          expand_more
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-border-subtle px-4 py-4 sm:grid-cols-2 xl:grid-cols-4">
          {rows.map((row) => (
            <BOrderDetailRow key={row.label} row={row} />
          ))}
        </div>
      )}
    </section>
  )
}

function BOrderDetailRow({ row }: { row: DetailRowData }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-body-sm">
      <span className="shrink-0 text-text-muted">{row.label}：</span>
      {row.value ? (
        <CopyText value={row.value} className={'min-w-0 max-w-full font-semibold text-text-main ' + (row.mono ? 'font-mono-data' : '')}>
          <span className="break-words">{row.value}</span>
        </CopyText>
      ) : (
        <span className="min-w-0 text-text-muted">—</span>
      )}
    </div>
  )
}

type CommunicationResult = '成功' | '未接通' | '待跟进' | '其他'

interface LocalCommunicationRecord {
  id: number
  time: string
  content: string
  result: CommunicationResult
}

function CommunicationRecordPanel(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [time, setTime] = useState('')
  const [content, setContent] = useState('')
  const [result, setResult] = useState<CommunicationResult | ''>('')
  const [errors, setErrors] = useState<{ time?: string; content?: string; result?: string }>({})
  const [records, setRecords] = useState<LocalCommunicationRecord[]>([])

  function addRecord(): void {
    const nextErrors = {
      time: time ? undefined : '请选择沟通时间',
      content: content.trim() ? undefined : '请填写沟通内容',
      result: result ? undefined : '请选择沟通结果'
    }
    setErrors(nextErrors)
    if (nextErrors.time || nextErrors.content || nextErrors.result || !result) return

    setRecords((current) => [
      ...current,
      { id: Date.now(), time, content: content.trim(), result }
    ])
    setTime('')
    setContent('')
    setResult('')
    setErrors({})
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface-bg"
        aria-expanded={open}
      >
        <h3 className="text-[16px] font-bold text-text-main">沟通记录</h3>
        <span className={'material-symbols-outlined text-text-muted transition-transform ' + (open ? 'rotate-180' : '')}>
          expand_more
        </span>
      </button>
      {open && (
        <div className="border-t border-border-subtle px-4 py-4">
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_2.2fr_0.8fr_auto] xl:items-start">
            <CommunicationField label="沟通时间" required error={errors.time}>
              <input
                type="datetime-local"
                value={time}
                onChange={(event) => {
                  setTime(event.target.value)
                  setErrors((current) => ({ ...current, time: undefined }))
                }}
                className={inputClass(Boolean(errors.time))}
              />
            </CommunicationField>
            <CommunicationField label="沟通内容" required error={errors.content}>
              <input
                type="text"
                value={content}
                onChange={(event) => {
                  setContent(event.target.value)
                  setErrors((current) => ({ ...current, content: undefined }))
                }}
                placeholder="请输入沟通内容"
                className={inputClass(Boolean(errors.content))}
              />
            </CommunicationField>
            <CommunicationField label="沟通结果" required error={errors.result}>
              <select
                value={result}
                onChange={(event) => {
                  setResult(event.target.value as CommunicationResult | '')
                  setErrors((current) => ({ ...current, result: undefined }))
                }}
                className={inputClass(Boolean(errors.result))}
              >
                <option value="">请选择</option>
                <option value="成功">成功</option>
                <option value="未接通">未接通</option>
                <option value="待跟进">待跟进</option>
                <option value="其他">其他</option>
              </select>
            </CommunicationField>
            <button
              type="button"
              onClick={addRecord}
              className="mt-6 h-9 rounded-md bg-[#078b7c] px-8 text-body-sm font-bold text-white hover:bg-[#06786c]"
            >
              新增
            </button>
          </div>

          {records.length > 0 && (
            <div className="mt-4 space-y-2">
              {records.map((record, index) => (
                <div key={record.id} className="grid grid-cols-[2rem_1fr_2.2fr_0.8fr_auto] items-center gap-3 rounded-md bg-surface-bg px-3 py-3 text-body-sm">
                  <span className="font-semibold text-text-muted">{index + 1}</span>
                  <div className="min-w-0"><span className="text-text-muted">沟通时间：</span><span className="font-semibold text-text-main">{formatCommunicationTime(record.time)}</span></div>
                  <div className="min-w-0 truncate"><span className="text-text-muted">沟通内容：</span><span className="font-semibold text-text-main">{record.content}</span></div>
                  <div className="min-w-0"><span className="text-text-muted">沟通结果：</span><span className="font-semibold text-text-main">{record.result}</span></div>
                  <button
                    type="button"
                    onClick={() => setRecords((current) => current.filter((item) => item.id !== record.id))}
                    className="text-error hover:underline"
                  >
                    × 移除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function CommunicationField({
  label,
  required,
  error,
  children
}: {
  label: string
  required?: boolean
  error?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block min-w-0 text-body-sm text-text-muted">
      <span className="mb-1 block">{label}{required && <span className="ml-0.5 text-error">*</span>}</span>
      {children}
      {error && <span className="mt-1 block text-[11px] text-error">{error}</span>}
    </label>
  )
}

function inputClass(hasError: boolean): string {
  return 'h-9 w-full rounded-md border bg-white px-2.5 text-body-sm text-text-main outline-none transition-colors ' +
    (hasError ? 'border-error focus:ring-1 focus:ring-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')
}

function formatCommunicationTime(value: string): string {
  if (!value) return '—'
  const formatted = value.replace('T', ' ')
  return formatted.length === 16 ? `${formatted}:00` : formatted
}

interface CheckCompanionRecord {
  id: number
  startedAt: string
  endedAt: string
  content: string
}

function CheckCompanionInformationPanel(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [startedAt, setStartedAt] = useState('')
  const [endedAt, setEndedAt] = useState('')
  const [content, setContent] = useState('')
  const [errors, setErrors] = useState<{ startedAt?: string; endedAt?: string; content?: string }>({})
  const [records, setRecords] = useState<CheckCompanionRecord[]>([])

  function resetForm(): void {
    setStartedAt('')
    setEndedAt('')
    setContent('')
    setErrors({})
  }

  function closeModal(): void {
    setModalOpen(false)
    resetForm()
  }

  function addRecord(): void {
    const nextErrors = {
      startedAt: startedAt ? undefined : '请选择检查陪同开始时间',
      endedAt: endedAt ? undefined : '请选择检查陪同结束时间',
      content: content.trim() ? undefined : '请填写陪同内容描述'
    }
    if (startedAt && endedAt && new Date(endedAt).getTime() <= new Date(startedAt).getTime()) {
      nextErrors.endedAt = '结束时间必须晚于开始时间'
    }
    setErrors(nextErrors)
    if (nextErrors.startedAt || nextErrors.endedAt || nextErrors.content) return

    setRecords((current) => [...current, {
      id: Date.now(),
      startedAt,
      endedAt,
      content: content.trim()
    }])
    closeModal()
  }

  function durationInHours(record: CheckCompanionRecord): string {
    const duration = (new Date(record.endedAt).getTime() - new Date(record.startedAt).getTime()) / (60 * 60 * 1000)
    return Number.isInteger(duration) ? String(duration) : duration.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface-bg"
        aria-expanded={open}
      >
        <h3 className="text-[16px] font-bold text-text-main">检查陪同信息</h3>
        <span className={'material-symbols-outlined text-text-muted transition-transform ' + (open ? 'rotate-180' : '')}>expand_more</span>
      </button>
      {open && (
        <div className="border-t border-border-subtle px-4 py-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-body-sm text-error">非门诊当日的陪诊，请记录如下</p>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]"
            >
              添加检查陪同记录
            </button>
          </div>
          <div className="overflow-x-auto rounded-md border border-border-subtle">
            <table className="min-w-[900px] w-full border-collapse text-body-sm">
              <thead className="bg-surface-bg text-text-main">
                <tr>
                  <th className="w-16 border-b border-r border-border-subtle px-3 py-3 text-center font-bold">序号</th>
                  <th className="border-b border-r border-border-subtle px-3 py-3 text-left font-bold">检查陪同开始时间</th>
                  <th className="border-b border-r border-border-subtle px-3 py-3 text-left font-bold">检查陪同结束时间</th>
                  <th className="border-b border-r border-border-subtle px-3 py-3 text-left font-bold">陪同时长（小时）</th>
                  <th className="border-b border-r border-border-subtle px-3 py-3 text-left font-bold">陪同内容描述</th>
                  <th className="w-24 border-b border-border-subtle px-3 py-3 text-center font-bold">操作</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-7 text-center text-text-muted">暂无数据</td></tr>
                ) : records.map((record, index) => (
                  <tr key={record.id} className="bg-white hover:bg-surface-bg">
                    <td className="border-t border-r border-border-subtle px-3 py-3 text-center text-text-muted">{index + 1}</td>
                    <td className="border-t border-r border-border-subtle px-3 py-3 text-text-main">{formatCommunicationTime(record.startedAt)}</td>
                    <td className="border-t border-r border-border-subtle px-3 py-3 text-text-main">{formatCommunicationTime(record.endedAt)}</td>
                    <td className="border-t border-r border-border-subtle px-3 py-3 text-text-main">{durationInHours(record)}</td>
                    <td className="border-t border-r border-border-subtle px-3 py-3 text-text-main">{record.content}</td>
                    <td className="border-t border-border-subtle px-3 py-3 text-center"><button type="button" onClick={() => setRecords((current) => current.filter((item) => item.id !== record.id))} className="text-error hover:underline">删除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="check-companion-modal-title">
          <div className="w-full max-w-[760px] overflow-hidden rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between bg-[#078b7c] px-4 py-3 text-white">
              <h4 id="check-companion-modal-title" className="text-[18px] font-bold">新增检查陪同信息</h4>
              <button type="button" onClick={closeModal} className="material-symbols-outlined rounded p-0.5 hover:bg-white/15" aria-label="关闭">close</button>
            </div>
            <div className="space-y-6 p-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <CommunicationField label="检查陪同开始时间" required error={errors.startedAt}>
                  <input type="datetime-local" step="1" value={startedAt} onChange={(event) => { setStartedAt(event.target.value); setErrors((current) => ({ ...current, startedAt: undefined, endedAt: undefined })) }} className={inputClass(Boolean(errors.startedAt))} />
                </CommunicationField>
                <CommunicationField label="检查陪同结束时间" required error={errors.endedAt}>
                  <input type="datetime-local" step="1" value={endedAt} onChange={(event) => { setEndedAt(event.target.value); setErrors((current) => ({ ...current, endedAt: undefined })) }} className={inputClass(Boolean(errors.endedAt))} />
                </CommunicationField>
              </div>
              <CommunicationField label="陪同内容描述" required error={errors.content}>
                <textarea value={content} onChange={(event) => { setContent(event.target.value); setErrors((current) => ({ ...current, content: undefined })) }} maxLength={1000} placeholder="请输入陪同内容描述" className={'min-h-36 w-full rounded-md border bg-white px-2.5 py-2 text-body-sm text-text-main outline-none ' + (errors.content ? 'border-error focus:ring-1 focus:ring-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')} />
              </CommunicationField>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={closeModal} className="h-10 rounded-md border border-border-subtle bg-white px-6 text-body-sm font-bold text-text-main hover:bg-surface-bg">取消</button>
                <button type="button" onClick={addRecord} className="h-10 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">确定</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function ServiceInformationFlow({ order, onEscortEntryActiveChange }: { order: Order; onEscortEntryActiveChange?: (active: boolean) => void }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const serviceType = bizType(order).trim()
  const tabs = serviceFlowTabsFor(serviceType)
  // 订单进入本页面时已经完成申领，因此从第二个 Tab 开始办理。
  const [activeTabIndex, setActiveTabIndex] = useState(() => tabs.length > 1 ? 1 : 0)
  const completedTabKeys = tabs[0] ? [tabs[0].key] : []
  const activeTab = tabs[activeTabIndex]

  useEffect(() => {
    onEscortEntryActiveChange?.(activeTab?.key === 'service-record' && activeTab.label === '陪诊录入')
  }, [activeTab?.key, activeTab?.label, onEscortEntryActiveChange])

  if (tabs.length === 0) {
    return (
      <section className="overflow-hidden rounded-lg border border-border-subtle bg-white">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface-bg"
          aria-expanded={open}
        >
          <h3 className="text-[16px] font-bold text-text-main">服务信息录入</h3>
          <span className={'material-symbols-outlined text-text-muted transition-transform ' + (open ? 'rotate-180' : '')}>expand_more</span>
        </button>
        {open && (
          <div className="border-t border-border-subtle px-4 py-5 text-body-sm text-text-muted">
            未配置“{serviceType || '未识别业务类型'}”的服务流程。
          </div>
        )}
      </section>
    )
  }

  const isComplete = completedTabKeys.includes(activeTab.key)
  const isReadOnly = isComplete

  function isUnlocked(index: number): boolean {
    return index === 0 || completedTabKeys.includes(tabs[index - 1].key)
  }

  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface-bg"
        aria-expanded={open}
      >
        <div>
          <h3 className="text-[16px] font-bold text-text-main">服务信息录入</h3>
          <p className="mt-0.5 text-[12px] font-normal text-text-muted">服务类型：{serviceType}</p>
        </div>
        <span className={'material-symbols-outlined text-text-muted transition-transform ' + (open ? 'rotate-180' : '')}>expand_more</span>
      </button>
      {open && (
        <div className="border-t border-border-subtle px-4 py-4">
          <div className="flex overflow-x-auto border-b border-border-subtle">
            {tabs.map((tab, index) => {
              const complete = completedTabKeys.includes(tab.key)
              const unlocked = isUnlocked(index)
              const active = activeTabIndex === index
              return (
                <button
                  key={tab.key}
                  type="button"
                  disabled={!unlocked}
                  onClick={() => setActiveTabIndex(index)}
                  className={
                    'relative shrink-0 px-5 py-3 text-body-sm font-semibold transition-colors ' +
                    (active
                      ? 'border-b-2 border-primary text-primary'
                      : unlocked
                        ? 'text-text-main hover:bg-surface-bg'
                        : 'cursor-not-allowed text-text-muted/60')
                  }
                >
                  <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px]">
                    {complete ? <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check</span> : index + 1}
                  </span>
                  {tab.label}
                </button>
              )
            })}
          </div>

          <div className="min-h-36 py-5">
            {tabs.map((tab, index) => (
              <div key={tab.key} hidden={activeTabIndex !== index}>
                <div className="text-body-sm font-semibold text-text-main">{tab.label}</div>
                {tab.key === 'claim' ? (
                  <ClaimInformationView order={order} />
                ) : ['全程门诊', '全流程', '单次门诊', '电话问诊'].includes(serviceType) && tab.key === 'plan' ? (
                  <OutpatientPlanConfirmationForm readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '全流程' && tab.key === 'assignment' ? (
                  <FullProcessAssignmentForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '全流程' && tab.key === 'service-record' ? (
                  <FullProcessEscortEntryForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '单次门诊' && tab.key === 'service-record' ? (
                  <OutpatientEscortEntryForm order={order} readOnly={completedTabKeys.includes(tab.key)} showRevisit={false} showSubmit={false} />
                ) : serviceType === '电话问诊' && tab.key === 'service-record' ? (
                  <PhoneConsultationEscortEntryForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '单次门诊' && tab.key === 'assignment' ? (
                  <SingleOutpatientAssignmentForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '电话问诊' && tab.key === 'assignment' ? (
                  <PhoneConsultationAssignmentForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : ['全程门诊', '全流程', '单次门诊', '电话问诊'].includes(serviceType) && tab.key === 'assignment' ? (
                  <OutpatientAssignmentForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : ['全程门诊', '全流程', '单次门诊', '电话问诊'].includes(serviceType) && tab.key === 'service-record' ? (
                  <OutpatientEscortEntryForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === 'MDT服务' && tab.key === 'plan' ? (
                  <MdtPlanConfirmationForm readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === 'MDT服务' && tab.key === 'service-record' ? (
                  <MdtServiceEntryForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '挂号协助' && tab.key === 'plan' ? (
                  <RegistrationAssistancePlanView order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '挂号协助' && tab.key === 'service-record' ? (
                  <RegistrationAssistanceServiceEntryForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '就医接送' && tab.key === 'service-record' ? (
                  <MedicalTransportServiceEntryForm readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '共享流程' && tab.key === 'service-record' ? (
                  <SharedServiceEntryForm readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '住院护工协助' && tab.key === 'service-record' ? (
                  <HospitalCareEscortEntryForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '住院护工协助' && tab.key === 'assignment' ? (
                  <HospitalCareAssignmentForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '住院' && tab.key === 'assignment' ? (
                  <HospitalAssignmentForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType === '住院' && tab.key === 'service-record' ? (
                  <HospitalEscortEntryForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType.includes('检查加急') && tab.key === 'assignment' ? (
                  <UrgentCheckAssignmentForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : serviceType.includes('检查加急') && tab.key === 'service-record' ? (
                  <UrgentCheckEscortEntryForm order={order} readOnly={completedTabKeys.includes(tab.key)} />
                ) : (
                  <>
                    <p className="mt-2 text-body-sm text-text-muted">
                      当前为流程轮廓，待补充“{tab.label}”的表单字段与说明后在此展示。
                    </p>
                    {completedTabKeys.includes(tab.key) && <p className="mt-2 text-body-sm text-text-muted">查看模式：已完成环节仅可查看，不能修改。</p>}
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
            <span className="text-[12px] text-text-muted">
              {isReadOnly ? '已完成环节仅可查看' : '确认推送 B 端功能暂未接入'}
            </span>
            <button
              type="button"
              title="确认推送 B 端功能暂未接入"
              className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]"
            >
              确认推送B端
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function serviceFlowTabsFor(serviceType: string): ServiceFlowTab[] {
  const exact = SERVICE_FLOW_TAB_DEFINITIONS[serviceType]
  if (exact) return exact

  const matchedType = Object.keys(SERVICE_FLOW_TAB_DEFINITIONS).find((type) => serviceType.includes(type))
  return matchedType ? SERVICE_FLOW_TAB_DEFINITIONS[matchedType] : []
}

function ClaimInformationView({ order }: { order: Order }): React.JSX.Element {
  const claimant = getSession()?.displayName ?? '—'
  return (
    <div className="mt-4 grid grid-cols-1 gap-x-12 gap-y-3 rounded-md bg-surface-bg px-4 py-3 text-body-sm sm:grid-cols-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-text-muted">申领时间：</span>
        <span className="font-semibold text-text-main">{formatClaimedTime(order.claimedAt)}</span>
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-text-muted">申领人：</span>
        <span className="font-semibold text-text-main">{claimant}</span>
      </div>
    </div>
  )
}

function formatClaimedTime(value: string | null): string {
  if (!value) return '—'
  return value.replace('T', ' ').replace(/\.\d+(Z|[+-]\d\d:\d\d)?$/, '').replace(/Z$/, '')
}

function toDateTimeLocal(value: string | null): string {
  if (!value) return ''
  const matched = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  return matched ? `${matched[1]}T${matched[2]}` : ''
}

interface UrgentSpecialCheckFormValue {
  province: string
  city: string
  hospital: string
  item: string
  price: string
  situation: string
}

interface UrgentSpecialCheckRecord extends UrgentSpecialCheckFormValue {
  id: number
  approvalResult: string
  approvalRemark: string
}

interface UrgentAssignmentFormValue {
  province: string
  city: string
  hospital: string
  hospitalAddress: string
  item: string
  escort: string
  contact: string
  suggestion: string
}

const EMPTY_URGENT_SPECIAL_CHECK: UrgentSpecialCheckFormValue = {
  province: '', city: '', hospital: '', item: '', price: '', situation: ''
}

const EMPTY_URGENT_ASSIGNMENT: UrgentAssignmentFormValue = {
  province: '', city: '', hospital: '', hospitalAddress: '', item: '', escort: '', contact: '', suggestion: ''
}

function UrgentCheckAssignmentForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [specialEnabled, setSpecialEnabled] = useState(false)
  const [specialForm, setSpecialForm] = useState<UrgentSpecialCheckFormValue>(EMPTY_URGENT_SPECIAL_CHECK)
  const [specialErrors, setSpecialErrors] = useState<Partial<Record<keyof UrgentSpecialCheckFormValue, string>>>({})
  const [specialRecords, setSpecialRecords] = useState<UrgentSpecialCheckRecord[]>([])
  const [assignmentForm, setAssignmentForm] = useState<UrgentAssignmentFormValue>(EMPTY_URGENT_ASSIGNMENT)
  const [assignmentErrors, setAssignmentErrors] = useState<Partial<Record<keyof UrgentAssignmentFormValue, string>>>({})
  const [assignmentValidated, setAssignmentValidated] = useState(false)

  const changeSpecial = (field: keyof UrgentSpecialCheckFormValue, value: string): void => {
    setSpecialForm((current) => ({ ...current, [field]: value }))
    setSpecialErrors((current) => ({ ...current, [field]: undefined }))
  }

  const changeAssignment = (field: keyof UrgentAssignmentFormValue, value: string): void => {
    setAssignmentForm((current) => ({ ...current, [field]: value }))
    setAssignmentErrors((current) => ({ ...current, [field]: undefined }))
    setAssignmentValidated(false)
  }

  function submitSpecialCheck(): void {
    const required: Array<[keyof UrgentSpecialCheckFormValue, string]> = [
      ['province', '请选择省'],
      ['city', '请选择市'],
      ['hospital', '请选择医院'],
      ['item', '请选择特殊检查项目'],
      ['price', '请填写特殊项目价格'],
      ['situation', '请选择特殊情况']
    ]
    const errors = Object.fromEntries(required.filter(([field]) => !specialForm[field].trim())) as Partial<Record<keyof UrgentSpecialCheckFormValue, string>>
    for (const [field, message] of required) {
      if (!specialForm[field].trim()) errors[field] = message
    }
    setSpecialErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSpecialRecords((current) => [
      ...current,
      {
        ...specialForm,
        id: Date.now(),
        approvalResult: '待审批',
        approvalRemark: ''
      }
    ])
    setSpecialForm(EMPTY_URGENT_SPECIAL_CHECK)
    setSpecialEnabled(false)
  }

  function submitAssignment(): void {
    const required: Array<[keyof UrgentAssignmentFormValue, string]> = [
      ['province', '请选择省'],
      ['city', '请选择市'],
      ['hospital', '请选择医院'],
      ['hospitalAddress', '请选择医院地址'],
      ['item', '请选择检查项目'],
      ['escort', '请选择陪诊人员'],
      ['suggestion', '请填写意见/建议']
    ]
    const errors: Partial<Record<keyof UrgentAssignmentFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!assignmentForm[field].trim()) errors[field] = message
    }
    setAssignmentErrors(errors)
    setAssignmentValidated(Object.keys(errors).length === 0)
  }

  return (
    <div className="mt-4 space-y-6">
      <label className="inline-flex items-center gap-2 text-body-sm font-bold text-[#dc2626]">
        <input
          type="checkbox"
          checked={specialEnabled}
          disabled={readOnly}
          onChange={(event) => setSpecialEnabled(event.target.checked)}
          className="h-4 w-4 accent-primary"
        />
        特殊检查项目
      </label>

      {specialEnabled && (
        <div className="rounded-md border-2 border-[#fb5b5b] p-4">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-5">
            <UrgentSelectField label="省" required value={specialForm.province} error={specialErrors.province} disabled={readOnly} onChange={(value) => changeSpecial('province', value)} />
            <UrgentSelectField label="市" required value={specialForm.city} error={specialErrors.city} disabled={readOnly || !specialForm.province} onChange={(value) => changeSpecial('city', value)} />
            <UrgentSelectField label="选择医院" required value={specialForm.hospital} error={specialErrors.hospital} disabled={readOnly || !specialForm.city} onChange={(value) => changeSpecial('hospital', value)} />
            <UrgentSelectField label="特殊检查项目" required value={specialForm.item} error={specialErrors.item} disabled={readOnly || !specialForm.hospital} onChange={(value) => changeSpecial('item', value)} />
            <CommunicationField label="特殊项目价格(元)" required error={specialErrors.price}>
              <input type="number" min="0" value={specialForm.price} disabled={readOnly || !specialForm.item} onChange={(event) => changeSpecial('price', event.target.value)} placeholder="请输入价格" className={inputClass(Boolean(specialErrors.price)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
            </CommunicationField>
            <UrgentSelectField label="特殊情况" required value={specialForm.situation} error={specialErrors.situation} disabled={readOnly || !specialForm.item} onChange={(value) => changeSpecial('situation', value)} />
          </div>
          {!readOnly && (
            <button type="button" onClick={submitSpecialCheck} className="mt-4 h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">
              提交运营审批
            </button>
          )}
        </div>
      )}

      {specialRecords.length > 0 && (
        <div>
          <h4 className="mb-3 text-[16px] font-bold text-text-main">特殊检查项目列表</h4>
          <div className="overflow-x-auto rounded-md border border-border-subtle">
            <table className="min-w-[1050px] w-full text-left text-body-sm">
              <thead className="bg-surface-bg text-text-muted">
                <tr>
                  {['序号', '省/市', '医院名称', '特殊检查项目', '特殊项目价格(元)', '特殊情况', '备注', '审批结果', '审批备注'].map((title) => <th key={title} className="whitespace-nowrap border-b border-border-subtle px-3 py-2.5 font-semibold">{title}</th>)}
                </tr>
              </thead>
              <tbody>
                {specialRecords.map((record, index) => (
                  <tr key={record.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-3 py-3">{index + 1}</td>
                    <td className="px-3 py-3">{record.province}/{record.city}</td>
                    <td className="px-3 py-3">{record.hospital}</td>
                    <td className="px-3 py-3">{record.item}</td>
                    <td className="px-3 py-3">{record.price}</td>
                    <td className="px-3 py-3">{record.situation}</td>
                    <td className="px-3 py-3">—</td>
                    <td className="px-3 py-3 font-semibold text-status-urgent">{record.approvalResult}</td>
                    <td className="px-3 py-3">{record.approvalRemark || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <label className="inline-flex items-center gap-2 text-body-sm text-text-main">
        <input type="checkbox" disabled={readOnly} className="h-4 w-4 accent-primary" />
        已与客户电话沟通，客户可就诊
      </label>

      <div>
        <h4 className="mb-3 text-[16px] font-bold text-text-main">分配陪诊人员</h4>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
          <UrgentSelectField label="省" required value={assignmentForm.province} error={assignmentErrors.province} disabled={readOnly} onChange={(value) => changeAssignment('province', value)} />
          <UrgentSelectField label="市" required value={assignmentForm.city} error={assignmentErrors.city} disabled={readOnly || !assignmentForm.province} onChange={(value) => changeAssignment('city', value)} />
          <UrgentSelectField label="选择医院" required value={assignmentForm.hospital} error={assignmentErrors.hospital} disabled={readOnly || !assignmentForm.city} onChange={(value) => changeAssignment('hospital', value)} />
          <UrgentSelectField label="医院地址" required value={assignmentForm.hospitalAddress} error={assignmentErrors.hospitalAddress} disabled={readOnly || !assignmentForm.hospital} onChange={(value) => changeAssignment('hospitalAddress', value)} />
          <UrgentSelectField label="检查项目" required value={assignmentForm.item} error={assignmentErrors.item} disabled={readOnly || !assignmentForm.hospital} onChange={(value) => changeAssignment('item', value)} />
          <UrgentSelectField label="选择陪诊人员" required value={assignmentForm.escort} error={assignmentErrors.escort} disabled={readOnly || !assignmentForm.hospital} onChange={(value) => changeAssignment('escort', value)} />
          <CommunicationField label="陪诊人员联系方式" error={assignmentErrors.contact}>
            <input value={assignmentForm.contact} disabled={readOnly} onChange={(event) => changeAssignment('contact', event.target.value)} placeholder="请输入联系方式" className={inputClass(Boolean(assignmentErrors.contact)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <CommunicationField label="发起检查时间">
            <input value={formatClaimedTime(order.createdAt ?? order.updatedAt)} readOnly className={inputClass(false) + ' cursor-not-allowed bg-surface-bg'} />
          </CommunicationField>
          <div className="md:col-span-2 xl:col-span-4">
            <CommunicationField label="意见/建议" required error={assignmentErrors.suggestion}>
              <textarea value={assignmentForm.suggestion} disabled={readOnly} onChange={(event) => changeAssignment('suggestion', event.target.value)} maxLength={1000} placeholder="请输入内容" className={'min-h-24 w-full rounded-md border bg-white px-2.5 py-2 text-body-sm text-text-main outline-none disabled:cursor-not-allowed disabled:bg-surface-bg ' + (assignmentErrors.suggestion ? 'border-error focus:ring-1 focus:ring-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')} />
              <span className="mt-1 block text-right text-[11px] text-text-muted">{assignmentForm.suggestion.length}/1000</span>
            </CommunicationField>
          </div>
        </div>
        {!readOnly && (
          <div className="mt-4 flex items-center justify-end gap-3">
            {assignmentValidated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}
            <button type="button" onClick={submitAssignment} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button>
          </div>
        )}
      </div>
    </div>
  )
}

function UrgentSelectField({
  label,
  required,
  value,
  error,
  disabled,
  onChange
}: {
  label: string
  required?: boolean
  value: string
  error?: string
  disabled?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <CommunicationField label={label} required={required} error={error}>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={inputClass(Boolean(error)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'}>
        <option value="">请选择</option>
      </select>
    </CommunicationField>
  )
}

interface HospitalExpertFormValue {
  expertType: string
  province: string
  city: string
  hospital: string
  department: string
  doctor: string
  title: string
  price: string
  situation: string
}

interface HospitalAssignmentFormValue {
  province: string
  city: string
  hospital: string
  hospitalAddress: string
  escort: string
  contact: string
  department: string
  doctor: string
  doctorTitle: string
  suggestion: string
}

interface OutpatientAssignmentFormValue {
  province: string
  city: string
  hospital: string
  hospitalAddress: string
  waitingAddress: string
  escort: string
  contact: string
  appointmentAt: string
  appointmentSuccessAt: string
  suggestion: string
}

interface OutpatientEscortEntryFormValue {
  arrivalTime: string
  medicineCoordination: string
  coordinationName: string
  summary: string
}

interface OutpatientGuideFormValue {
  item: string
  checkTime: string
  location: string
  notes: string
}

interface OutpatientGuideRecord extends OutpatientGuideFormValue {
  id: number
}

interface OutpatientRevisitFormValue {
  province: string
  city: string
  hospital: string
  department: string
  doctor: string
  title: string
  hospitalAddress: string
  waitingAddress: string
  escort: string
  contact: string
  startedAt: string
  appointmentAt: string
  successAt: string
  suggestion: string
}

interface FullProcessNewOutpatientFormValue {
  province: string
  city: string
  hospital: string
  department: string
  doctor: string
  title: string
  hospitalAddress: string
  waitingAddress: string
  escort: string
  contact: string
  startedAt: string
  appointmentAt: string
  successAt: string
  suggestion: string
}

interface HospitalExpertRecord extends HospitalExpertFormValue {
  id: number
  approvalResult: string
  approvalRemark: string
}

const EMPTY_HOSPITAL_EXPERT: HospitalExpertFormValue = {
  expertType: '', province: '', city: '', hospital: '', department: '', doctor: '', title: '', price: '', situation: ''
}

const EMPTY_HOSPITAL_ASSIGNMENT: HospitalAssignmentFormValue = {
  province: '', city: '', hospital: '', hospitalAddress: '', escort: '', contact: '', department: '', doctor: '', doctorTitle: '', suggestion: ''
}

const EMPTY_OUTPATIENT_ASSIGNMENT: OutpatientAssignmentFormValue = {
  province: '', city: '', hospital: '', hospitalAddress: '', waitingAddress: '', escort: '', contact: '',
  appointmentAt: '', appointmentSuccessAt: '', suggestion: ''
}

const EMPTY_OUTPATIENT_ESCORT_ENTRY: OutpatientEscortEntryFormValue = {
  arrivalTime: '', medicineCoordination: '0', coordinationName: '', summary: ''
}

const EMPTY_OUTPATIENT_GUIDE: OutpatientGuideFormValue = {
  item: '', checkTime: '', location: '', notes: ''
}

const EMPTY_OUTPATIENT_REVISIT: OutpatientRevisitFormValue = {
  province: '', city: '', hospital: '', department: '', doctor: '', title: '', hospitalAddress: '', waitingAddress: '',
  escort: '', contact: '', startedAt: '', appointmentAt: '', successAt: '', suggestion: ''
}

const EMPTY_FULL_PROCESS_NEW_OUTPATIENT: FullProcessNewOutpatientFormValue = {
  province: '', city: '', hospital: '', department: '', doctor: '', title: '', hospitalAddress: '', waitingAddress: '',
  escort: '', contact: '', startedAt: '', appointmentAt: '', successAt: '', suggestion: ''
}

function HospitalAssignmentForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [expertEnabled, setExpertEnabled] = useState(false)
  const [expertForm, setExpertForm] = useState<HospitalExpertFormValue>(EMPTY_HOSPITAL_EXPERT)
  const [expertErrors, setExpertErrors] = useState<Partial<Record<keyof HospitalExpertFormValue, string>>>({})
  const [expertRecords, setExpertRecords] = useState<HospitalExpertRecord[]>([])
  const [assignmentForm, setAssignmentForm] = useState<HospitalAssignmentFormValue>(EMPTY_HOSPITAL_ASSIGNMENT)
  const [assignmentErrors, setAssignmentErrors] = useState<Partial<Record<keyof HospitalAssignmentFormValue, string>>>({})
  const [assignmentValidated, setAssignmentValidated] = useState(false)

  function changeExpert(field: keyof HospitalExpertFormValue, value: string): void {
    setExpertForm((current) => ({ ...current, [field]: value }))
    setExpertErrors((current) => ({ ...current, [field]: undefined }))
  }

  function changeAssignment(field: keyof HospitalAssignmentFormValue, value: string): void {
    setAssignmentForm((current) => ({ ...current, [field]: value }))
    setAssignmentErrors((current) => ({ ...current, [field]: undefined }))
    setAssignmentValidated(false)
  }

  function submitExpert(): void {
    const required: Array<[keyof HospitalExpertFormValue, string]> = [
      ['expertType', '请选择点名专家类型'],
      ['province', '请选择省'],
      ['city', '请选择市'],
      ['hospital', '请选择医院'],
      ['department', '请选择科室名称'],
      ['doctor', '请选择医生姓名'],
      ['title', '请选择医生职称'],
      ['price', '请填写点名专家价格'],
      ['situation', '请选择点名情况']
    ]
    const errors: Partial<Record<keyof HospitalExpertFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!expertForm[field].trim()) errors[field] = message
    }
    setExpertErrors(errors)
    if (Object.keys(errors).length > 0) return

    setExpertRecords((current) => [...current, {
      ...expertForm,
      id: Date.now(),
      approvalResult: '待审批',
      approvalRemark: ''
    }])
    setExpertForm(EMPTY_HOSPITAL_EXPERT)
    setExpertEnabled(false)
  }

  function submitAssignment(): void {
    const required: Array<[keyof HospitalAssignmentFormValue, string]> = [
      ['province', '请选择省'],
      ['city', '请选择市'],
      ['hospital', '请选择医院'],
      ['hospitalAddress', '请选择医院地址'],
      ['escort', '请选择陪诊人员'],
      ['department', '请选择科室'],
      ['doctor', '请选择医生姓名'],
      ['doctorTitle', '请填写医生职称'],
      ['suggestion', '请填写意见/建议']
    ]
    const errors: Partial<Record<keyof HospitalAssignmentFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!assignmentForm[field].trim()) errors[field] = message
    }
    setAssignmentErrors(errors)
    setAssignmentValidated(Object.keys(errors).length === 0)
  }

  return (
    <div className="mt-4 space-y-6">
      <div className="rounded-md border border-error/20 bg-error/10 px-4 py-3 text-body-sm text-error">
        *如医生职称为主任/副主任医师，需先向运营反馈，获批后再行服务，同时，在意见/建议栏留存备注说明
      </div>

      <label className="inline-flex items-center gap-2 text-body-sm font-bold text-[#dc2626]">
        <input type="checkbox" checked={expertEnabled} disabled={readOnly} onChange={(event) => setExpertEnabled(event.target.checked)} className="h-4 w-4 accent-primary" />
        点名专家
      </label>

      {expertEnabled && (
        <div className="rounded-md border-2 border-[#fb5b5b] p-4">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
            <UrgentSelectField label="点名专家类型" required value={expertForm.expertType} error={expertErrors.expertType} disabled={readOnly} onChange={(value) => changeExpert('expertType', value)} />
            <UrgentSelectField label="省" required value={expertForm.province} error={expertErrors.province} disabled={readOnly} onChange={(value) => changeExpert('province', value)} />
            <UrgentSelectField label="市" required value={expertForm.city} error={expertErrors.city} disabled={readOnly || !expertForm.province} onChange={(value) => changeExpert('city', value)} />
            <UrgentSelectField label="选择医院" required value={expertForm.hospital} error={expertErrors.hospital} disabled={readOnly || !expertForm.city} onChange={(value) => changeExpert('hospital', value)} />
            <UrgentSelectField label="科室名称" required value={expertForm.department} error={expertErrors.department} disabled={readOnly || !expertForm.hospital} onChange={(value) => changeExpert('department', value)} />
            <UrgentSelectField label="医生姓名" required value={expertForm.doctor} error={expertErrors.doctor} disabled={readOnly || !expertForm.department} onChange={(value) => changeExpert('doctor', value)} />
            <UrgentSelectField label="医生职称" required value={expertForm.title} error={expertErrors.title} disabled={readOnly || !expertForm.doctor} onChange={(value) => changeExpert('title', value)} />
            <CommunicationField label="点名专家价格" required error={expertErrors.price}>
              <input type="number" min="0" value={expertForm.price} disabled={readOnly || !expertForm.doctor} onChange={(event) => changeExpert('price', event.target.value)} placeholder="请输入价格" className={inputClass(Boolean(expertErrors.price)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
            </CommunicationField>
            <UrgentSelectField label="点名情况" required value={expertForm.situation} error={expertErrors.situation} disabled={readOnly || !expertForm.doctor} onChange={(value) => changeExpert('situation', value)} />
          </div>
          {!readOnly && <button type="button" onClick={submitExpert} className="mt-4 h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交运营审批</button>}
        </div>
      )}

      {expertRecords.length > 0 && (
        <div>
          <h4 className="mb-3 text-[16px] font-bold text-text-main">点名专家列表</h4>
          <div className="overflow-x-auto rounded-md border border-border-subtle">
            <table className="min-w-[1350px] w-full text-left text-body-sm">
              <thead className="bg-surface-bg text-text-muted">
                <tr>
                  {['序号', '点名专家类型', '省/市', '医院名称', '科室名称', '医生姓名', '医生职称', '点名专家价格', '点名情况', '备注', '审批结果', '审批备注'].map((title) => <th key={title} className="whitespace-nowrap border-b border-border-subtle px-3 py-2.5 font-semibold">{title}</th>)}
                </tr>
              </thead>
              <tbody>
                {expertRecords.map((record, index) => (
                  <tr key={record.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-3 py-3">{index + 1}</td>
                    <td className="px-3 py-3">{record.expertType}</td>
                    <td className="px-3 py-3">{record.province}/{record.city}</td>
                    <td className="px-3 py-3">{record.hospital}</td>
                    <td className="px-3 py-3">{record.department}</td>
                    <td className="px-3 py-3">{record.doctor}</td>
                    <td className="px-3 py-3">{record.title}</td>
                    <td className="px-3 py-3">{record.price}</td>
                    <td className="px-3 py-3">{record.situation}</td>
                    <td className="px-3 py-3">—</td>
                    <td className="px-3 py-3 font-semibold text-status-urgent">{record.approvalResult}</td>
                    <td className="px-3 py-3">{record.approvalRemark || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <label className="inline-flex items-center gap-2 text-body-sm text-text-main">
        <input type="checkbox" disabled={readOnly} className="h-4 w-4 accent-primary" />
        已与客户电话沟通，客户可就诊
      </label>

      <div>
        <h4 className="mb-3 text-[16px] font-bold text-text-main">分配陪诊人员</h4>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
          <UrgentSelectField label="省" required value={assignmentForm.province} error={assignmentErrors.province} disabled={readOnly} onChange={(value) => changeAssignment('province', value)} />
          <UrgentSelectField label="市" required value={assignmentForm.city} error={assignmentErrors.city} disabled={readOnly || !assignmentForm.province} onChange={(value) => changeAssignment('city', value)} />
          <UrgentSelectField label="医院" required value={assignmentForm.hospital} error={assignmentErrors.hospital} disabled={readOnly || !assignmentForm.city} onChange={(value) => changeAssignment('hospital', value)} />
          <UrgentSelectField label="医院地址" required value={assignmentForm.hospitalAddress} error={assignmentErrors.hospitalAddress} disabled={readOnly || !assignmentForm.hospital} onChange={(value) => changeAssignment('hospitalAddress', value)} />
          <UrgentSelectField label="选择陪诊人员" required value={assignmentForm.escort} error={assignmentErrors.escort} disabled={readOnly || !assignmentForm.hospital} onChange={(value) => changeAssignment('escort', value)} />
          <CommunicationField label="陪诊人员联系方式">
            <input value={assignmentForm.contact} disabled={readOnly} onChange={(event) => changeAssignment('contact', event.target.value)} placeholder="请输入联系方式" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <CommunicationField label="发起住院时间" required>
            <input value={formatClaimedTime(order.createdAt ?? order.updatedAt)} readOnly className={inputClass(false) + ' cursor-not-allowed bg-surface-bg'} />
          </CommunicationField>
          <UrgentSelectField label="科室" required value={assignmentForm.department} error={assignmentErrors.department} disabled={readOnly || !assignmentForm.hospital} onChange={(value) => changeAssignment('department', value)} />
          <UrgentSelectField label="医生姓名" required value={assignmentForm.doctor} error={assignmentErrors.doctor} disabled={readOnly || !assignmentForm.department} onChange={(value) => changeAssignment('doctor', value)} />
          <CommunicationField label="医生职称" required error={assignmentErrors.doctorTitle}>
            <input value={assignmentForm.doctorTitle} disabled={readOnly || !assignmentForm.doctor} onChange={(event) => changeAssignment('doctorTitle', event.target.value)} placeholder="请输入医生职称" className={inputClass(Boolean(assignmentErrors.doctorTitle)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <div className="md:col-span-2 xl:col-span-4">
            <CommunicationField label="意见/建议" required error={assignmentErrors.suggestion}>
              <textarea value={assignmentForm.suggestion} disabled={readOnly} onChange={(event) => changeAssignment('suggestion', event.target.value)} maxLength={1000} placeholder="请输入内容" className={'min-h-24 w-full rounded-md border bg-white px-2.5 py-2 text-body-sm text-text-main outline-none disabled:cursor-not-allowed disabled:bg-surface-bg ' + (assignmentErrors.suggestion ? 'border-error focus:ring-1 focus:ring-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')} />
              <span className="mt-1 block text-right text-[11px] text-text-muted">{assignmentForm.suggestion.length}/1000</span>
            </CommunicationField>
          </div>
        </div>
        {!readOnly && (
          <div className="mt-4 flex items-center justify-end gap-3">
            {assignmentValidated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}
            <button type="button" onClick={submitAssignment} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button>
          </div>
        )}
      </div>
    </div>
  )
}

interface OutpatientPlanFormValue {
  province: string
  city: string
  hospital: string
  department: string
  doctor: string
}

const EMPTY_OUTPATIENT_PLAN: OutpatientPlanFormValue = {
  province: '', city: '', hospital: '', department: '', doctor: ''
}

function OutpatientPlanConfirmationForm({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const [expertEnabled, setExpertEnabled] = useState(false)
  const [expertForm, setExpertForm] = useState<HospitalExpertFormValue>(EMPTY_HOSPITAL_EXPERT)
  const [expertErrors, setExpertErrors] = useState<Partial<Record<keyof HospitalExpertFormValue, string>>>({})
  const [expertRecords, setExpertRecords] = useState<HospitalExpertRecord[]>([])
  const [planForm, setPlanForm] = useState<OutpatientPlanFormValue>(EMPTY_OUTPATIENT_PLAN)

  function changeExpert(field: keyof HospitalExpertFormValue, value: string): void {
    setExpertForm((current) => ({ ...current, [field]: value }))
    setExpertErrors((current) => ({ ...current, [field]: undefined }))
  }

  function changePlan(field: keyof OutpatientPlanFormValue, value: string): void {
    setPlanForm((current) => ({ ...current, [field]: value }))
  }

  function submitExpert(): void {
    const required: Array<[keyof HospitalExpertFormValue, string]> = [
      ['expertType', '请选择点名专家类型'],
      ['province', '请选择省'],
      ['city', '请选择市'],
      ['hospital', '请选择医院'],
      ['department', '请选择科室名称'],
      ['doctor', '请选择医生姓名'],
      ['title', '请选择医生职称'],
      ['price', '请填写点名专家价格'],
      ['situation', '请选择点名情况']
    ]
    const errors: Partial<Record<keyof HospitalExpertFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!expertForm[field].trim()) errors[field] = message
    }
    setExpertErrors(errors)
    if (Object.keys(errors).length > 0) return

    setExpertRecords((current) => [...current, {
      ...expertForm,
      id: Date.now(),
      approvalResult: '待审批',
      approvalRemark: ''
    }])
    setExpertForm(EMPTY_HOSPITAL_EXPERT)
    setExpertEnabled(false)
  }

  return (
    <div className="mt-4 space-y-6">
      <label className="inline-flex items-center gap-2 text-body-sm font-bold text-[#dc2626]">
        <input type="checkbox" checked={expertEnabled} disabled={readOnly} onChange={(event) => setExpertEnabled(event.target.checked)} className="h-4 w-4 accent-primary" />
        点名专家
      </label>

      {expertEnabled && (
        <div className="rounded-md border-2 border-[#fb5b5b] p-4">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
            <UrgentSelectField label="点名专家类型" required value={expertForm.expertType} error={expertErrors.expertType} disabled={readOnly} onChange={(value) => changeExpert('expertType', value)} />
            <UrgentSelectField label="省" required value={expertForm.province} error={expertErrors.province} disabled={readOnly} onChange={(value) => changeExpert('province', value)} />
            <UrgentSelectField label="市" required value={expertForm.city} error={expertErrors.city} disabled={readOnly || !expertForm.province} onChange={(value) => changeExpert('city', value)} />
            <UrgentSelectField label="选择医院" required value={expertForm.hospital} error={expertErrors.hospital} disabled={readOnly || !expertForm.city} onChange={(value) => changeExpert('hospital', value)} />
            <UrgentSelectField label="科室名称" required value={expertForm.department} error={expertErrors.department} disabled={readOnly || !expertForm.hospital} onChange={(value) => changeExpert('department', value)} />
            <UrgentSelectField label="医生姓名" required value={expertForm.doctor} error={expertErrors.doctor} disabled={readOnly || !expertForm.department} onChange={(value) => changeExpert('doctor', value)} />
            <UrgentSelectField label="医生职称" required value={expertForm.title} error={expertErrors.title} disabled={readOnly || !expertForm.doctor} onChange={(value) => changeExpert('title', value)} />
            <CommunicationField label="点名专家价格" required error={expertErrors.price}>
              <input type="number" min="0" value={expertForm.price} disabled={readOnly || !expertForm.doctor} onChange={(event) => changeExpert('price', event.target.value)} placeholder="请输入价格" className={inputClass(Boolean(expertErrors.price)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
            </CommunicationField>
            <UrgentSelectField label="点名情况" required value={expertForm.situation} error={expertErrors.situation} disabled={readOnly || !expertForm.doctor} onChange={(value) => changeExpert('situation', value)} />
          </div>
          {!readOnly && <button type="button" onClick={submitExpert} className="mt-4 h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交运营审批</button>}
        </div>
      )}

      <div>
        <h4 className="mb-3 text-[16px] font-bold text-text-main">方案选择</h4>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-5">
          <UrgentSelectField label="省" value={planForm.province} disabled={readOnly} onChange={(value) => changePlan('province', value)} />
          <UrgentSelectField label="市" value={planForm.city} disabled={readOnly || !planForm.province} onChange={(value) => changePlan('city', value)} />
          <UrgentSelectField label="医院" value={planForm.hospital} disabled={readOnly || !planForm.city} onChange={(value) => changePlan('hospital', value)} />
          <UrgentSelectField label="科室" value={planForm.department} disabled={readOnly || !planForm.hospital} onChange={(value) => changePlan('department', value)} />
          <UrgentSelectField label="医生姓名" value={planForm.doctor} disabled={readOnly || !planForm.department} onChange={(value) => changePlan('doctor', value)} />
        </div>
        <p className="mt-2 text-[12px] text-text-muted">下拉选项待接入；已按省、市、医院、科室、医生姓名的顺序限制选择。</p>
      </div>

      <div>
        <h4 className="mb-3 text-[16px] font-bold text-text-main">点名专家列表</h4>
        <div className="overflow-x-auto rounded-md border border-border-subtle">
          <table className="min-w-[1350px] w-full text-left text-body-sm">
            <thead className="bg-surface-bg text-text-muted">
              <tr>
                {['序号', '点名专家类型', '省/市', '医院名称', '科室名称', '医生姓名', '医生职称', '点名专家价格', '点名情况', '备注', '审批结果', '审批备注'].map((title) => <th key={title} className="whitespace-nowrap border-b border-border-subtle px-3 py-2.5 font-semibold">{title}</th>)}
              </tr>
            </thead>
            <tbody>
              {expertRecords.length === 0 ? (
                <tr><td colSpan={12} className="px-3 py-8 text-center text-text-muted">暂无点名专家数据</td></tr>
              ) : expertRecords.map((record, index) => (
                <tr key={record.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-3 py-3">{index + 1}</td>
                  <td className="px-3 py-3">{record.expertType}</td>
                  <td className="px-3 py-3">{record.province}/{record.city}</td>
                  <td className="px-3 py-3">{record.hospital}</td>
                  <td className="px-3 py-3">{record.department}</td>
                  <td className="px-3 py-3">{record.doctor}</td>
                  <td className="px-3 py-3">{record.title}</td>
                  <td className="px-3 py-3">{record.price}</td>
                  <td className="px-3 py-3">{record.situation}</td>
                  <td className="px-3 py-3">—</td>
                  <td className="px-3 py-3 font-semibold text-status-urgent">{record.approvalResult}</td>
                  <td className="px-3 py-3">{record.approvalRemark || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/**
 * 全程门诊/全流程/单次门诊/电话问诊共用的分配陪诊录入表单。
 * 当前根据已完成后的查看页面反向生成，选项和提交接口待后续接入。
 */
function OutpatientAssignmentForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [form, setForm] = useState<OutpatientAssignmentFormValue>(EMPTY_OUTPATIENT_ASSIGNMENT)
  const [errors, setErrors] = useState<Partial<Record<keyof OutpatientAssignmentFormValue, string>>>({})
  const [validated, setValidated] = useState(false)

  function changeField(field: keyof OutpatientAssignmentFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
  }

  function submit(): void {
    const required: Array<[keyof OutpatientAssignmentFormValue, string]> = [
      ['province', '请选择就诊省'],
      ['city', '请选择就诊市'],
      ['hospital', '请选择就诊医院'],
      ['hospitalAddress', '请选择医院地址'],
      ['waitingAddress', '请填写候诊地址'],
      ['escort', '请选择陪诊人员'],
      ['contact', '请填写陪诊人员联系方式'],
      ['appointmentAt', '请选择预约就诊时间'],
      ['appointmentSuccessAt', '请选择预约成功时间']
    ]
    const nextErrors: Partial<Record<keyof OutpatientAssignmentFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!form[field].trim()) nextErrors[field] = message
    }
    setErrors(nextErrors)
    setValidated(Object.keys(nextErrors).length === 0)
  }

  const createdAt = order.createdAt ?? order.updatedAt

  return (
    <div className="mt-4 space-y-6">
      <div>
        <h4 className="mb-3 text-[16px] font-bold text-text-main">分配陪诊人员</h4>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
          <UrgentSelectField label="省" required value={form.province} error={errors.province} disabled={readOnly} onChange={(value) => changeField('province', value)} />
          <UrgentSelectField label="市" required value={form.city} error={errors.city} disabled={readOnly || !form.province} onChange={(value) => changeField('city', value)} />
          <UrgentSelectField label="就诊医院" required value={form.hospital} error={errors.hospital} disabled={readOnly || !form.city} onChange={(value) => changeField('hospital', value)} />
          <UrgentSelectField label="医院地址" required value={form.hospitalAddress} error={errors.hospitalAddress} disabled={readOnly || !form.hospital} onChange={(value) => changeField('hospitalAddress', value)} />
          <CommunicationField label="候诊地址" required error={errors.waitingAddress}>
            <input value={form.waitingAddress} disabled={readOnly} onChange={(event) => changeField('waitingAddress', event.target.value)} placeholder="请输入候诊地址" className={inputClass(Boolean(errors.waitingAddress)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <UrgentSelectField label="陪诊人员" required value={form.escort} error={errors.escort} disabled={readOnly || !form.hospital} onChange={(value) => changeField('escort', value)} />
          <CommunicationField label="陪诊人员联系方式" required error={errors.contact}>
            <input value={form.contact} disabled={readOnly} onChange={(event) => changeField('contact', event.target.value)} placeholder="请输入联系方式" className={inputClass(Boolean(errors.contact)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <CommunicationField label="发起门诊时间">
            <input value={formatClaimedTime(createdAt)} readOnly className={inputClass(false) + ' cursor-not-allowed bg-surface-bg'} />
          </CommunicationField>
          <CommunicationField label="预约就诊时间" required error={errors.appointmentAt}>
            <input type="datetime-local" step="1" value={form.appointmentAt} disabled={readOnly} onChange={(event) => changeField('appointmentAt', event.target.value)} className={inputClass(Boolean(errors.appointmentAt)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <CommunicationField label="预约成功时间" required error={errors.appointmentSuccessAt}>
            <input type="datetime-local" step="1" value={form.appointmentSuccessAt} disabled={readOnly} onChange={(event) => changeField('appointmentSuccessAt', event.target.value)} className={inputClass(Boolean(errors.appointmentSuccessAt)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <div className="md:col-span-2 xl:col-span-4">
            <CommunicationField label="建议意见">
              <textarea value={form.suggestion} disabled={readOnly} onChange={(event) => changeField('suggestion', event.target.value)} maxLength={1000} placeholder="请输入内容" className="min-h-24 w-full rounded-md border border-border-subtle bg-white px-2.5 py-2 text-body-sm text-text-main outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:bg-surface-bg" />
              <span className="mt-1 block text-right text-[11px] text-text-muted">{form.suggestion.length}/1000</span>
            </CommunicationField>
          </div>
        </div>
        <p className="mt-2 text-[12px] text-text-muted">当前根据查看页面反向生成；下拉选项、联动和提交接口待后续补充。</p>
        {!readOnly && (
          <div className="mt-4 flex items-center justify-end gap-3">
            {validated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}
            <button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button>
          </div>
        )}
      </div>
    </div>
  )
}

/** 单次门诊分配陪诊：按查看页反推的就诊安排表单，字段与只读展示一一对应。 */
function SingleOutpatientAssignmentForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  return <OutpatientAssignmentForm order={order} readOnly={readOnly} />
}

/** 电话问诊分配陪诊：按只读查看页反推的就诊安排表单。 */
function PhoneConsultationAssignmentForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  return <OutpatientAssignmentForm order={order} readOnly={readOnly} />
}

/** 电话问诊陪诊录入：按已完成查看页反推，增加实际协调名称字段。 */
function PhoneConsultationEscortEntryForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  return <OutpatientEscortEntryForm order={order} readOnly={readOnly} showRevisit={false} showCoordinationName />
}

interface FullProcessAssignmentRecord extends OutpatientAssignmentFormValue {
  id: number
}

/** 全流程门诊的分配陪诊支持同一订单下多条就诊安排。 */
function FullProcessAssignmentForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState<OutpatientAssignmentFormValue>(EMPTY_OUTPATIENT_ASSIGNMENT)
  const [errors, setErrors] = useState<Partial<Record<keyof OutpatientAssignmentFormValue, string>>>({})
  const [records, setRecords] = useState<FullProcessAssignmentRecord[]>([])
  const [validated, setValidated] = useState(false)

  function updateField(field: keyof OutpatientAssignmentFormValue, value: string): void {
    setDraft((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
  }

  function addRecord(): void {
    const required: Array<[keyof OutpatientAssignmentFormValue, string]> = [
      ['province', '请选择就诊省'],
      ['city', '请选择就诊市'],
      ['hospital', '请选择就诊医院'],
      ['hospitalAddress', '请选择医院地址'],
      ['waitingAddress', '请填写候诊地址'],
      ['escort', '请选择陪诊人员'],
      ['contact', '请填写陪诊人员联系方式'],
      ['appointmentAt', '请选择预约就诊时间'],
      ['appointmentSuccessAt', '请选择预约成功时间']
    ]
    const nextErrors: Partial<Record<keyof OutpatientAssignmentFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!draft[field].trim()) nextErrors[field] = message
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    setRecords((current) => [...current, { ...draft, id: Date.now() }])
    setDraft(EMPTY_OUTPATIENT_ASSIGNMENT)
    setValidated(false)
  }

  function submit(): void {
    if (draft.province || draft.city || draft.hospital || draft.hospitalAddress || draft.waitingAddress || draft.escort || draft.contact || draft.appointmentAt || draft.appointmentSuccessAt || draft.suggestion) {
      addRecord()
      return
    }
    setValidated(records.length > 0)
  }

  const disabledClass = ' disabled:cursor-not-allowed disabled:bg-surface-bg'
  const createdAt = order.createdAt ?? order.updatedAt

  return (
    <div className="mt-4 space-y-6">
      <label className="inline-flex items-center gap-2 text-body-sm text-text-main"><input type="checkbox" disabled={readOnly} className="h-4 w-4 accent-primary" />已与客户电话沟通，客户可就诊</label>

      <div className="rounded-md border border-border-subtle bg-surface-bg p-4">
        <div className="mb-3 flex items-center justify-between"><h4 className="text-[16px] font-bold text-text-main">分配陪诊人员</h4><span className="text-[12px] text-text-muted">可添加多条就诊安排</span></div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
          <UrgentSelectField label="省" required value={draft.province} error={errors.province} disabled={readOnly} onChange={(value) => updateField('province', value)} />
          <UrgentSelectField label="市" required value={draft.city} error={errors.city} disabled={readOnly || !draft.province} onChange={(value) => updateField('city', value)} />
          <UrgentSelectField label="就诊医院" required value={draft.hospital} error={errors.hospital} disabled={readOnly || !draft.city} onChange={(value) => updateField('hospital', value)} />
          <UrgentSelectField label="医院地址" required value={draft.hospitalAddress} error={errors.hospitalAddress} disabled={readOnly || !draft.hospital} onChange={(value) => updateField('hospitalAddress', value)} />
          <CommunicationField label="候诊地址" required error={errors.waitingAddress}><input value={draft.waitingAddress} disabled={readOnly} onChange={(event) => updateField('waitingAddress', event.target.value)} placeholder="请输入候诊地址" className={inputClass(Boolean(errors.waitingAddress)) + disabledClass} /></CommunicationField>
          <UrgentSelectField label="陪诊人员" required value={draft.escort} error={errors.escort} disabled={readOnly || !draft.hospital} onChange={(value) => updateField('escort', value)} />
          <CommunicationField label="陪诊人员联系方式" required error={errors.contact}><input value={draft.contact} disabled={readOnly} onChange={(event) => updateField('contact', event.target.value)} placeholder="请输入联系方式" className={inputClass(Boolean(errors.contact)) + disabledClass} /></CommunicationField>
          <CommunicationField label="发起门诊时间"><input value={formatClaimedTime(createdAt)} readOnly className={inputClass(false) + ' cursor-not-allowed bg-white'} /></CommunicationField>
          <CommunicationField label="预约就诊时间" required error={errors.appointmentAt}><input type="datetime-local" step="1" value={draft.appointmentAt} disabled={readOnly} onChange={(event) => updateField('appointmentAt', event.target.value)} className={inputClass(Boolean(errors.appointmentAt)) + disabledClass} /></CommunicationField>
          <CommunicationField label="预约成功时间" required error={errors.appointmentSuccessAt}><input type="datetime-local" step="1" value={draft.appointmentSuccessAt} disabled={readOnly} onChange={(event) => updateField('appointmentSuccessAt', event.target.value)} className={inputClass(Boolean(errors.appointmentSuccessAt)) + disabledClass} /></CommunicationField>
          <div className="md:col-span-2 xl:col-span-2"><CommunicationField label="建议意见"><textarea value={draft.suggestion} disabled={readOnly} onChange={(event) => updateField('suggestion', event.target.value)} maxLength={1000} placeholder="请输入内容" className={'min-h-20 w-full rounded-md border bg-white px-2.5 py-2 text-body-sm text-text-main outline-none disabled:cursor-not-allowed disabled:bg-surface-bg ' + (errors.suggestion ? 'border-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')} /><span className="mt-1 block text-right text-[11px] text-text-muted">{draft.suggestion.length}/1000</span></CommunicationField></div>
        </div>
        {!readOnly && <div className="mt-4 flex justify-end gap-3"><button type="button" onClick={addRecord} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">新增安排</button><button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button></div>}
      </div>

      {records.length > 0 && <div className="space-y-3"><h4 className="text-[16px] font-bold text-text-main">已添加的陪诊安排</h4>{records.map((record, index) => <div key={record.id} className="rounded-md border border-border-subtle bg-surface-bg p-4"><div className="mb-3 flex items-center justify-between"><span className="font-semibold text-text-main">第 {index + 1} 条陪诊安排</span>{!readOnly && <button type="button" onClick={() => setRecords((current) => current.filter((item) => item.id !== record.id))} className="text-error hover:underline">移除</button>}</div><div className="grid grid-cols-1 gap-x-8 gap-y-3 text-body-sm md:grid-cols-2 xl:grid-cols-4"><HeaderFact label="就诊地区" value={[record.province, record.city].filter(Boolean).join('') || '—'} /><HeaderFact label="就诊医院" value={record.hospital || '—'} /><HeaderFact label="医院地址" value={record.hospitalAddress || '—'} /><HeaderFact label="候诊地址" value={record.waitingAddress || '—'} /><HeaderFact label="陪诊人员" value={record.escort || '—'} /><HeaderFact label="陪诊人员联系方式" value={record.contact || '—'} /><HeaderFact label="发起门诊时间" value={formatClaimedTime(createdAt)} /><HeaderFact label="预约就诊时间" value={formatCommunicationTime(record.appointmentAt)} /><HeaderFact label="预约成功时间" value={formatCommunicationTime(record.appointmentSuccessAt)} /><HeaderFact label="建议意见" value={record.suggestion || '无'} /></div></div>)}</div>}
      {validated && <p className="text-right text-body-sm text-status-success">已添加陪诊安排，后台保存功能待接入</p>}
    </div>
  )
}

/**
 * 全程门诊/全流程/单次门诊/电话问诊的陪诊录入表单。
 * 当前仅实现截图中的页面交互，保存、发送和提交接口留待后续接入。
 */
function OutpatientEscortEntryForm({ order, readOnly, showRevisit = true, showSubmit = true, showCoordinationName = false }: { order: Order; readOnly: boolean; showRevisit?: boolean; showSubmit?: boolean; showCoordinationName?: boolean }): React.JSX.Element {
  const [form, setForm] = useState<OutpatientEscortEntryFormValue>(EMPTY_OUTPATIENT_ESCORT_ENTRY)
  const [errors, setErrors] = useState<Partial<Record<keyof OutpatientEscortEntryFormValue, string>>>({})
  const [guideForm, setGuideForm] = useState<OutpatientGuideFormValue>(EMPTY_OUTPATIENT_GUIDE)
  const [guideErrors, setGuideErrors] = useState<Partial<Record<keyof OutpatientGuideFormValue, string>>>({})
  const [guideRecords, setGuideRecords] = useState<OutpatientGuideRecord[]>([])
  const [guideStatus, setGuideStatus] = useState('')
  const [validated, setValidated] = useState(false)
  const [saved, setSaved] = useState(false)
  const [revisitOpen, setRevisitOpen] = useState(false)
  const [revisitForm, setRevisitForm] = useState<OutpatientRevisitFormValue>(() => ({
    ...EMPTY_OUTPATIENT_REVISIT,
    hospital: order.hospital || '',
    department: order.dept || '',
    doctor: order.doctor || ''
  }))
  const [revisitErrors, setRevisitErrors] = useState<Partial<Record<keyof OutpatientRevisitFormValue, string>>>({})
  const [revisitStatus, setRevisitStatus] = useState('')

  function updateForm(field: keyof OutpatientEscortEntryFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
    setSaved(false)
  }

  function updateGuide(field: keyof OutpatientGuideFormValue, value: string): void {
    setGuideForm((current) => ({ ...current, [field]: value }))
    setGuideErrors((current) => ({ ...current, [field]: undefined }))
    setGuideStatus('')
  }

  function addGuideRecord(): void {
    const required: Array<[keyof OutpatientGuideFormValue, string]> = [
      ['item', '请填写检查项目'],
      ['checkTime', '请选择检查时间'],
      ['location', '请填写检查地点'],
      ['notes', '请填写注意事项']
    ]
    const nextErrors: Partial<Record<keyof OutpatientGuideFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!guideForm[field].trim()) nextErrors[field] = message
    }
    setGuideErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    setGuideRecords((current) => [...current, { ...guideForm, id: Date.now() }])
    setGuideForm(EMPTY_OUTPATIENT_GUIDE)
  }

  function submit(): void {
    const nextErrors: Partial<Record<keyof OutpatientEscortEntryFormValue, string>> = {}
    if (!form.arrivalTime.trim()) nextErrors.arrivalTime = '请选择门诊到诊时间'
    if (!form.summary.trim()) nextErrors.summary = '请填写门诊小结'
    setErrors(nextErrors)
    setValidated(Object.keys(nextErrors).length === 0)
  }

  function updateRevisit(field: keyof OutpatientRevisitFormValue, value: string): void {
    setRevisitForm((current) => ({ ...current, [field]: value }))
    setRevisitErrors((current) => ({ ...current, [field]: undefined }))
    setRevisitStatus('')
  }

  function submitRevisit(): void {
    const required: Array<[keyof OutpatientRevisitFormValue, string]> = [
      ['province', '请选择省'],
      ['city', '请选择市'],
      ['hospital', '请选择医院'],
      ['hospitalAddress', '请选择医院地址'],
      ['waitingAddress', '请填写候诊地址'],
      ['startedAt', '请选择发起门诊时间'],
      ['appointmentAt', '请选择预约门诊时间'],
      ['successAt', '请选择预约成功时间']
    ]
    const nextErrors: Partial<Record<keyof OutpatientRevisitFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!revisitForm[field].trim()) nextErrors[field] = message
    }
    setRevisitErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    setRevisitStatus('复诊信息已生成，后台保存功能待接入')
    setRevisitOpen(false)
  }

  const disabledClass = ' disabled:cursor-not-allowed disabled:bg-surface-bg'
  const selectClass = (error?: string): string => inputClass(Boolean(error)) + disabledClass
  const createdAt = order.createdAt ?? order.updatedAt

  return (
    <div className="mt-4 space-y-6">
      <div className="rounded-md border border-border-subtle bg-surface-bg p-4">
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
          <HeaderFact label="门诊状态" value="未完成" />
          <HeaderFact label="预约就诊时间" value="—" />
          <HeaderFact label="就诊医院" value={order.hospital || '—'} />
          <HeaderFact label="医生姓名" value={order.doctor || '—'} />
          <HeaderFact label="就诊地区" value="—" />
          <HeaderFact label="就诊科室" value={order.dept || '—'} />
          <HeaderFact label="医生职称" value="—" />
          <HeaderFact label="发起门诊时间" value={formatClaimedTime(createdAt)} />
          <HeaderFact label="预约成功时间" value="—" />
        </div>
      </div>

      <div className="rounded-md border border-border-subtle bg-surface-bg p-4">
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
          <CommunicationField label="门诊到诊时间" required error={errors.arrivalTime}>
            <input type="datetime-local" step="1" value={form.arrivalTime} disabled={readOnly} onChange={(event) => updateForm('arrivalTime', event.target.value)} className={inputClass(Boolean(errors.arrivalTime)) + disabledClass} />
          </CommunicationField>
          <CommunicationField label="是否提供创新药械协调">
            <select value={form.medicineCoordination} disabled={readOnly} onChange={(event) => updateForm('medicineCoordination', event.target.value)} className={selectClass()}>
              <option value="0">否</option>
              <option value="1">是</option>
            </select>
          </CommunicationField>
          {showCoordinationName && <CommunicationField label="协调创新药械名称"><input value={form.coordinationName} disabled={readOnly || form.medicineCoordination !== '1'} onChange={(event) => updateForm('coordinationName', event.target.value)} placeholder="请输入名称" className={inputClass(false) + disabledClass} /></CommunicationField>}
        </div>

        <div className="mt-7">
          <h4 className="mb-3 text-[16px] font-bold text-text-main">导学信息</h4>
          <div className="grid grid-cols-1 items-end gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-[1.1fr_1.1fr_1.1fr_1.5fr_auto]">
            <CommunicationField label="检查项目" required error={guideErrors.item}>
              <input value={guideForm.item} disabled={readOnly} onChange={(event) => updateGuide('item', event.target.value)} placeholder="请输入检查项目" className={inputClass(Boolean(guideErrors.item)) + disabledClass} />
            </CommunicationField>
            <CommunicationField label="检查时间" required error={guideErrors.checkTime}>
              <input type="datetime-local" step="1" value={guideForm.checkTime} disabled={readOnly} onChange={(event) => updateGuide('checkTime', event.target.value)} className={inputClass(Boolean(guideErrors.checkTime)) + disabledClass} />
            </CommunicationField>
            <CommunicationField label="检查地点" required error={guideErrors.location}>
              <input value={guideForm.location} disabled={readOnly} onChange={(event) => updateGuide('location', event.target.value)} placeholder="请输入检查地点" className={inputClass(Boolean(guideErrors.location)) + disabledClass} />
            </CommunicationField>
            <CommunicationField label="注意事项" required error={guideErrors.notes}>
              <input value={guideForm.notes} disabled={readOnly} onChange={(event) => updateGuide('notes', event.target.value)} placeholder="请输入注意事项" className={inputClass(Boolean(guideErrors.notes)) + disabledClass} />
            </CommunicationField>
            {!readOnly && <button type="button" onClick={addGuideRecord} className="h-9 rounded-md bg-[#078b7c] px-7 text-body-sm font-bold text-white hover:bg-[#06786c]">新增</button>}
          </div>

          <div className="mt-4 overflow-x-auto rounded-md border border-border-subtle bg-white">
            <table className="min-w-[900px] w-full text-left text-body-sm">
              <thead className="bg-surface-bg text-text-muted">
                <tr>{['序号', '检查项目', '检查时间', '检查地点', '注意事项', '操作'].map((title) => <th key={title} className="whitespace-nowrap border-b border-border-subtle px-3 py-2.5 font-semibold">{title}</th>)}</tr>
              </thead>
              <tbody>
                {guideRecords.length === 0 ? <tr><td colSpan={6} className="px-3 py-8 text-center text-text-muted">暂无数据</td></tr> : guideRecords.map((record, index) => (
                  <tr key={record.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-3 py-3">{index + 1}</td><td className="px-3 py-3">{record.item}</td><td className="px-3 py-3">{formatCommunicationTime(record.checkTime)}</td><td className="px-3 py-3">{record.location}</td><td className="px-3 py-3">{record.notes}</td>
                    <td className="px-3 py-3">{!readOnly && <button type="button" onClick={() => setGuideRecords((current) => current.filter((item) => item.id !== record.id))} className="text-error hover:underline">移除</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-end gap-3">
            {guideStatus && <span className="text-body-sm text-status-success">{guideStatus}</span>}
            {!readOnly && <button type="button" onClick={() => setGuideStatus('导学信息已加入待发送列表，后台发送功能待接入')} className="h-9 rounded-md bg-[#078b7c] px-7 text-body-sm font-bold text-white hover:bg-[#06786c]">发送</button>}
          </div>
        </div>

        <div className="mt-7"><CareImageSection title="医疗影像" subtitle="可上传多个影像" /></div>

        <div className="mt-7">
          <CommunicationField label="门诊小结" required error={errors.summary}>
            <textarea value={form.summary} disabled={readOnly} onChange={(event) => updateForm('summary', event.target.value)} maxLength={1000} placeholder="请输入内容" className={'min-h-28 w-full rounded-md border bg-white px-2.5 py-2 text-body-sm text-text-main outline-none disabled:cursor-not-allowed disabled:bg-surface-bg ' + (errors.summary ? 'border-error focus:ring-1 focus:ring-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')} />
            <span className="mt-1 block text-right text-[11px] text-text-muted">{form.summary.length}/1000</span>
          </CommunicationField>
        </div>

        {!readOnly && <div className="mt-4 flex items-center justify-end gap-3">{validated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}{saved && <span className="text-body-sm text-status-success">已记录本地保存状态</span>}<button type="button" onClick={() => setSaved(true)} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">保存</button><button type="button" title="爽约处理功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">爽约</button>{showSubmit && <button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button>}</div>}
      </div>

      {showRevisit && <button type="button" onClick={() => !readOnly && setRevisitOpen(true)} className="flex w-full items-center justify-center rounded-md border border-dashed border-border-subtle bg-surface-bg py-5 text-body-sm font-semibold text-text-muted hover:border-primary hover:text-primary">复诊</button>}
      {revisitStatus && <p className="text-right text-body-sm text-status-success">{revisitStatus}</p>}

      {revisitOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[92vh] w-full max-w-6xl overflow-y-auto rounded-md bg-white shadow-xl">
            <div className="flex items-center justify-between bg-[#078b7c] px-5 py-3 text-white"><h3 className="text-[16px] font-bold">复诊</h3><button type="button" onClick={() => setRevisitOpen(false)} aria-label="关闭" className="text-2xl leading-none">×</button></div>
            <div className="space-y-5 p-5">
              <div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
                {(['province', 'city', 'hospital'] as const).map((field) => {
                  const labels = { province: '地域选择：省', city: '市', hospital: '选择医院' }
                  return <CommunicationField key={field} label={labels[field]} error={revisitErrors[field]}><select value={revisitForm[field]} onChange={(event) => updateRevisit(field, event.target.value)} className={selectClass(revisitErrors[field])}><option value="">请选择</option>{revisitForm[field] && <option value={revisitForm[field]}>{revisitForm[field]}</option>}</select></CommunicationField>
                })}
                {(['department', 'doctor', 'title'] as const).map((field) => {
                  const labels = { department: '科室', doctor: '医生', title: '职称' }
                  return <CommunicationField key={field} label={labels[field]}><select value={revisitForm[field]} disabled className={selectClass()}><option value="">请选择</option>{revisitForm[field] && <option value={revisitForm[field]}>{revisitForm[field]}</option>}</select></CommunicationField>
                })}
                <UrgentSelectField label="医院地址" required value={revisitForm.hospitalAddress} error={revisitErrors.hospitalAddress} onChange={(value) => updateRevisit('hospitalAddress', value)} />
                <CommunicationField label="候诊地址" required error={revisitErrors.waitingAddress}><input value={revisitForm.waitingAddress} onChange={(event) => updateRevisit('waitingAddress', event.target.value)} placeholder="请输入候诊地址" className={inputClass(Boolean(revisitErrors.waitingAddress))} /></CommunicationField>
                <CommunicationField label="陪诊人员"><input value={revisitForm.escort} onChange={(event) => updateRevisit('escort', event.target.value)} placeholder="请输入陪诊人员" className={inputClass(false)} /></CommunicationField>
                <CommunicationField label="陪诊人员联系方式"><input value={revisitForm.contact} onChange={(event) => updateRevisit('contact', event.target.value)} placeholder="请输入联系方式" className={inputClass(false)} /></CommunicationField>
                <CommunicationField label="发起门诊时间" required error={revisitErrors.startedAt}><input type="datetime-local" step="1" value={revisitForm.startedAt} onChange={(event) => updateRevisit('startedAt', event.target.value)} className={inputClass(Boolean(revisitErrors.startedAt))} /></CommunicationField>
                <CommunicationField label="预约门诊时间" required error={revisitErrors.appointmentAt}><input type="datetime-local" step="1" value={revisitForm.appointmentAt} onChange={(event) => updateRevisit('appointmentAt', event.target.value)} className={inputClass(Boolean(revisitErrors.appointmentAt))} /></CommunicationField>
                <CommunicationField label="预约成功时间" required error={revisitErrors.successAt}><input type="datetime-local" step="1" value={revisitForm.successAt} onChange={(event) => updateRevisit('successAt', event.target.value)} className={inputClass(Boolean(revisitErrors.successAt))} /></CommunicationField>
                <div className="md:col-span-2 xl:col-span-3"><CommunicationField label="意见/建议"><textarea value={revisitForm.suggestion} onChange={(event) => updateRevisit('suggestion', event.target.value)} maxLength={1000} placeholder="请输入内容" className="min-h-24 w-full rounded-md border border-border-subtle bg-white px-2.5 py-2 text-body-sm text-text-main outline-none focus:border-primary focus:ring-1 focus:ring-primary" /></CommunicationField></div>
              </div>
              <div className="flex justify-end gap-3"><button type="button" onClick={() => setRevisitOpen(false)} className="h-9 rounded-md border border-border-subtle px-5 text-body-sm text-text-main hover:bg-surface-bg">取消</button><button type="button" onClick={submitRevisit} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button></div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 全流程陪诊录入包含门诊信息和住院信息两个子 Tab。 */
function FullProcessEscortEntryForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'outpatient' | 'inpatient'>('outpatient')
  const [newOutpatientOpen, setNewOutpatientOpen] = useState(false)
  const [newOutpatientRecords, setNewOutpatientRecords] = useState<FullProcessNewOutpatientFormValue[]>([])

  return (
    <div className="mt-4 space-y-5">
      <div className="flex border-b border-border-subtle">
        <button type="button" onClick={() => setActiveTab('outpatient')} className={'px-6 py-3 text-body-sm font-semibold ' + (activeTab === 'outpatient' ? 'border-b-2 border-primary text-primary' : 'text-text-muted')}>门诊信息</button>
        <button type="button" onClick={() => setActiveTab('inpatient')} className={'px-6 py-3 text-body-sm font-semibold ' + (activeTab === 'inpatient' ? 'border-b-2 border-primary text-primary' : 'text-text-muted')}>住院信息</button>
      </div>

      {activeTab === 'outpatient' ? (
        <>
          <OutpatientEscortEntryForm order={order} readOnly={readOnly} />
          <button type="button" onClick={() => !readOnly && setNewOutpatientOpen(true)} className="flex w-full items-center justify-center rounded-md border border-dashed border-border-subtle bg-surface-bg py-5 text-body-sm font-semibold text-text-muted hover:border-primary hover:text-primary">＋新增门诊</button>
          {newOutpatientRecords.length > 0 && <div className="space-y-3"><h4 className="text-[16px] font-bold text-text-main">新增门诊记录</h4>{newOutpatientRecords.map((record, index) => <div key={`${record.hospital}-${index}`} className="rounded-md border border-border-subtle bg-surface-bg p-4"><div className="mb-3 font-semibold text-text-main">第 {index + 1} 条门诊</div><div className="grid grid-cols-1 gap-x-8 gap-y-3 text-body-sm md:grid-cols-2 xl:grid-cols-4"><HeaderFact label="就诊地区" value={[record.province, record.city].filter(Boolean).join('') || '—'} /><HeaderFact label="就诊医院" value={record.hospital || '—'} /><HeaderFact label="医院地址" value={record.hospitalAddress || '—'} /><HeaderFact label="候诊地址" value={record.waitingAddress || '—'} /><HeaderFact label="陪诊人员" value={record.escort || '—'} /><HeaderFact label="陪诊人员联系方式" value={record.contact || '—'} /><HeaderFact label="发起门诊时间" value={formatCommunicationTime(record.startedAt)} /><HeaderFact label="预约就诊时间" value={formatCommunicationTime(record.appointmentAt)} /><HeaderFact label="预约成功时间" value={formatCommunicationTime(record.successAt)} /><HeaderFact label="意见/建议" value={record.suggestion || '无'} /></div></div>)}</div>}
        </>
      ) : (
        <FullProcessInpatientEntryForm order={order} readOnly={readOnly} />
      )}

      {newOutpatientOpen && <FullProcessNewOutpatientModal order={order} onClose={() => setNewOutpatientOpen(false)} onSubmitted={(record) => { setNewOutpatientRecords((current) => [...current, record]); setNewOutpatientOpen(false) }} />}
    </div>
  )
}

function FullProcessInpatientEntryForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [expertEnabled, setExpertEnabled] = useState(false)
  const [expertForm, setExpertForm] = useState<HospitalExpertFormValue>(EMPTY_HOSPITAL_EXPERT)
  const [expertErrors, setExpertErrors] = useState<Partial<Record<keyof HospitalExpertFormValue, string>>>({})
  const [expertSubmitted, setExpertSubmitted] = useState(false)

  function updateExpert(field: keyof HospitalExpertFormValue, value: string): void {
    setExpertForm((current) => ({ ...current, [field]: value }))
    setExpertErrors((current) => ({ ...current, [field]: undefined }))
    setExpertSubmitted(false)
  }

  function submitExpert(): void {
    const required: Array<[keyof HospitalExpertFormValue, string]> = [
      ['expertType', '请选择点名专家类型'], ['province', '请选择省'], ['city', '请选择市'], ['hospital', '请选择医院'],
      ['department', '请选择科室名称'], ['doctor', '请选择医生姓名'], ['title', '请选择医生职称'], ['price', '请填写点名专家价格'], ['situation', '请选择点名情况']
    ]
    const nextErrors: Partial<Record<keyof HospitalExpertFormValue, string>> = {}
    for (const [field, message] of required) if (!expertForm[field].trim()) nextErrors[field] = message
    setExpertErrors(nextErrors)
    setExpertSubmitted(Object.keys(nextErrors).length === 0)
  }

  return (
    <div className="mt-4 space-y-5">
      <div className="rounded-md border border-error/20 bg-error/10 px-4 py-3 text-body-sm text-error">*如医生职称为主任/副主任医师，需先向运营反馈，获批后再行服务，同时，在意见/建议栏留存备注说明</div>
      <label className="inline-flex items-center gap-2 text-body-sm font-bold text-[#dc2626]"><input type="checkbox" checked={expertEnabled} disabled={readOnly} onChange={(event) => setExpertEnabled(event.target.checked)} className="h-4 w-4 accent-primary" />点名专家</label>
      {expertEnabled && <div className="rounded-md border-2 border-[#fb5b5b] p-4"><div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
        <UrgentSelectField label="点名专家类型" required value={expertForm.expertType} error={expertErrors.expertType} disabled={readOnly} onChange={(value) => updateExpert('expertType', value)} />
        <UrgentSelectField label="省" required value={expertForm.province} error={expertErrors.province} disabled={readOnly} onChange={(value) => updateExpert('province', value)} />
        <UrgentSelectField label="市" required value={expertForm.city} error={expertErrors.city} disabled={readOnly || !expertForm.province} onChange={(value) => updateExpert('city', value)} />
        <UrgentSelectField label="医院名称" required value={expertForm.hospital} error={expertErrors.hospital} disabled={readOnly || !expertForm.city} onChange={(value) => updateExpert('hospital', value)} />
        <UrgentSelectField label="科室名称" required value={expertForm.department} error={expertErrors.department} disabled={readOnly || !expertForm.hospital} onChange={(value) => updateExpert('department', value)} />
        <UrgentSelectField label="医生姓名" required value={expertForm.doctor} error={expertErrors.doctor} disabled={readOnly || !expertForm.department} onChange={(value) => updateExpert('doctor', value)} />
        <UrgentSelectField label="医生职称" required value={expertForm.title} error={expertErrors.title} disabled={readOnly || !expertForm.doctor} onChange={(value) => updateExpert('title', value)} />
        <CommunicationField label="点名专家价格" required error={expertErrors.price}><input type="number" min="0" value={expertForm.price} disabled={readOnly || !expertForm.doctor} onChange={(event) => updateExpert('price', event.target.value)} placeholder="请输入价格" className={inputClass(Boolean(expertErrors.price)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField>
        <UrgentSelectField label="点名情况" required value={expertForm.situation} error={expertErrors.situation} disabled={readOnly || !expertForm.doctor} onChange={(value) => updateExpert('situation', value)} />
      </div>{!readOnly && <div className="mt-4 flex items-center gap-3"><button type="button" onClick={submitExpert} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交运营审批</button>{expertSubmitted && <span className="text-body-sm text-status-success">已记录为待审批</span>}</div>}</div>}
      <HospitalEscortEntryForm order={order} readOnly={readOnly} />
    </div>
  )
}

function FullProcessNewOutpatientModal({ order, onClose, onSubmitted }: { order: Order; onClose: () => void; onSubmitted: (record: FullProcessNewOutpatientFormValue) => void }): React.JSX.Element {
  const createdAt = order.createdAt ?? order.updatedAt
  const [form, setForm] = useState<FullProcessNewOutpatientFormValue>(() => ({
    ...EMPTY_FULL_PROCESS_NEW_OUTPATIENT,
    hospital: order.hospital || '',
    department: order.dept || '',
    doctor: order.doctor || '',
    startedAt: toDateTimeLocal(createdAt)
  }))
  const [expertEnabled, setExpertEnabled] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<keyof FullProcessNewOutpatientFormValue, string>>>({})

  function updateField(field: keyof FullProcessNewOutpatientFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
  }

  function submit(): void {
    const required: Array<[keyof FullProcessNewOutpatientFormValue, string]> = [
      ['province', '请选择省'], ['city', '请选择市'], ['hospital', '请选择医院'], ['department', '请选择科室'], ['doctor', '请选择医生'], ['title', '请选择职称'],
      ['hospitalAddress', '请选择医院地址'], ['waitingAddress', '请填写候诊地址'], ['startedAt', '请选择发起门诊时间'], ['appointmentAt', '请选择预约就诊时间'], ['successAt', '请选择预约成功时间']
    ]
    const nextErrors: Partial<Record<keyof FullProcessNewOutpatientFormValue, string>> = {}
    for (const [field, message] of required) if (!form[field].trim()) nextErrors[field] = message
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length === 0) onSubmitted(form)
  }

  const disabledClass = ' disabled:cursor-not-allowed disabled:bg-surface-bg'
  const selectClass = (error?: string): string => inputClass(Boolean(error)) + disabledClass

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[92vh] w-full max-w-6xl overflow-y-auto rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between bg-[#078b7c] px-5 py-3 text-white"><h3 className="text-[16px] font-bold">新增门诊</h3><button type="button" onClick={onClose} aria-label="关闭" className="text-2xl leading-none">×</button></div>
        <div className="space-y-5 p-4">
          <label className="inline-flex items-center gap-2 text-body-sm font-bold text-[#dc2626]"><input type="checkbox" checked={expertEnabled} onChange={(event) => setExpertEnabled(event.target.checked)} className="h-4 w-4 accent-primary" />点名专家</label>
          {expertEnabled && <div className="rounded-md border-2 border-[#fb5b5b] p-3 text-body-sm text-text-muted">点名专家信息表单已展开，具体选项待后续接入。</div>}
          <div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
            <CommunicationField label="地域选择：省" required error={errors.province}><input value={form.province} onChange={(event) => updateField('province', event.target.value)} placeholder="请输入省" className={inputClass(Boolean(errors.province))} /></CommunicationField>
            <CommunicationField label="市" required error={errors.city}><input value={form.city} onChange={(event) => updateField('city', event.target.value)} placeholder="请输入市" className={inputClass(Boolean(errors.city))} /></CommunicationField>
            <CommunicationField label="选择医院" required error={errors.hospital}><input value={form.hospital} onChange={(event) => updateField('hospital', event.target.value)} placeholder="请输入医院" className={inputClass(Boolean(errors.hospital))} /></CommunicationField>
            {(['department', 'doctor', 'title'] as const).map((field) => { const labels = { department: '科室', doctor: '医生', title: '职称' }; return <CommunicationField key={field} label={labels[field]} required error={errors[field]}><select value={form[field]} onChange={(event) => updateField(field, event.target.value)} className={selectClass(errors[field])}><option value="">请选择</option>{form[field] && <option value={form[field]}>{form[field]}</option>}</select></CommunicationField> })}
            <div className="md:col-span-2 xl:col-span-3"><UrgentSelectField label="医院地址" required value={form.hospitalAddress} error={errors.hospitalAddress} onChange={(value) => updateField('hospitalAddress', value)} /></div>
            <CommunicationField label="候诊地址" required error={errors.waitingAddress}><input value={form.waitingAddress} onChange={(event) => updateField('waitingAddress', event.target.value)} placeholder="请输入候诊地址" className={inputClass(Boolean(errors.waitingAddress))} /></CommunicationField>
            <CommunicationField label="陪诊人员"><input value={form.escort} onChange={(event) => updateField('escort', event.target.value)} placeholder="请输入陪诊人员" className={inputClass(false)} /></CommunicationField>
            <CommunicationField label="联系方式"><input value={form.contact} onChange={(event) => updateField('contact', event.target.value)} placeholder="请输入联系方式" className={inputClass(false)} /></CommunicationField>
            <CommunicationField label="发起门诊时间" required error={errors.startedAt}><input type="datetime-local" step="1" value={form.startedAt} readOnly className={inputClass(Boolean(errors.startedAt)) + ' cursor-not-allowed bg-surface-bg'} /></CommunicationField>
            <CommunicationField label="预约就诊时间" required error={errors.appointmentAt}><input type="datetime-local" step="1" value={form.appointmentAt} onChange={(event) => updateField('appointmentAt', event.target.value)} className={inputClass(Boolean(errors.appointmentAt))} /></CommunicationField>
            <CommunicationField label="预约成功时间" required error={errors.successAt}><input type="datetime-local" step="1" value={form.successAt} onChange={(event) => updateField('successAt', event.target.value)} className={inputClass(Boolean(errors.successAt))} /></CommunicationField>
            <div className="md:col-span-2 xl:col-span-3"><CommunicationField label="意见/建议"><textarea value={form.suggestion} onChange={(event) => updateField('suggestion', event.target.value)} maxLength={1000} placeholder="请输入内容" className="min-h-24 w-full rounded-md border border-border-subtle bg-white px-2.5 py-2 text-body-sm text-text-main outline-none focus:border-primary focus:ring-1 focus:ring-primary" /></CommunicationField></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={onClose} className="h-9 rounded-md border border-border-subtle px-5 text-body-sm text-text-main hover:bg-surface-bg">取消</button><button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button></div>
        </div>
      </div>
    </div>
  )
}

interface MedicalTransportFormValue {
  originProvince: string
  originCity: string
  originDistrict: string
  originAddress: string
  destinationProvince: string
  destinationCity: string
  destinationDistrict: string
  destinationAddress: string
  serviceTime: string
  distance: string
  sameCity: string
  transport: string
  vehicle: string
  escortName: string
  escortPhone: string
  returnPassengers: string
  ticketAmount: string
  illnessRemark: string
}

const EMPTY_MEDICAL_TRANSPORT: MedicalTransportFormValue = {
  originProvince: '', originCity: '', originDistrict: '', originAddress: '',
  destinationProvince: '', destinationCity: '', destinationDistrict: '', destinationAddress: '',
  serviceTime: '', distance: '', sameCity: '', transport: '', vehicle: '', escortName: '', escortPhone: '',
  returnPassengers: '', ticketAmount: '', illnessRemark: ''
}

function MedicalTransportServiceEntryForm({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const [form, setForm] = useState<MedicalTransportFormValue>(EMPTY_MEDICAL_TRANSPORT)
  const [errors, setErrors] = useState<Partial<Record<keyof MedicalTransportFormValue, string>>>({})
  const [validated, setValidated] = useState(false)

  function changeField(field: keyof MedicalTransportFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
  }

  function submit(): void {
    const required: Array<[keyof MedicalTransportFormValue, string]> = [
      ['originProvince', '请选择实际出发地省'], ['originCity', '请选择实际出发地市'], ['originDistrict', '请选择实际出发地区'], ['originAddress', '请填写实际出发地详细地址'],
      ['destinationProvince', '请选择实际到达地省'], ['destinationCity', '请选择实际到达地市'], ['destinationDistrict', '请选择实际到达地区'], ['destinationAddress', '请填写实际到达地详细地址'],
      ['serviceTime', '请选择实际服务时间'], ['distance', '请选择起止距离'], ['sameCity', '请选择是否同城'], ['transport', '请选择交通工具'],
      ['vehicle', '请选择车型'], ['escortName', '请填写陪诊姓名'], ['escortPhone', '请填写陪诊联系电话']
    ]
    const nextErrors: Partial<Record<keyof MedicalTransportFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!form[field].trim()) nextErrors[field] = message
    }
    setErrors(nextErrors)
    setValidated(Object.keys(nextErrors).length === 0)
  }

  return (
    <div className="mt-4 space-y-5">
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-8">
        <div className="xl:col-span-3">
          <p className="mb-1.5 text-body-sm text-text-muted">实际出发地 <span className="text-error">*</span></p>
          <div className="grid grid-cols-3 gap-3">
            <UrgentSelectField label="" required value={form.originProvince} error={errors.originProvince} disabled={readOnly} onChange={(value) => changeField('originProvince', value)} />
            <UrgentSelectField label="" required value={form.originCity} error={errors.originCity} disabled={readOnly || !form.originProvince} onChange={(value) => changeField('originCity', value)} />
            <UrgentSelectField label="" required value={form.originDistrict} error={errors.originDistrict} disabled={readOnly || !form.originCity} onChange={(value) => changeField('originDistrict', value)} />
          </div>
        </div>
        <div className="xl:col-span-5">
          <CommunicationField label="详细地址" required error={errors.originAddress}>
            <input value={form.originAddress} disabled={readOnly || !form.originDistrict} onChange={(event) => changeField('originAddress', event.target.value)} placeholder="请输入详细地址" className={inputClass(Boolean(errors.originAddress)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
        </div>

        <div className="xl:col-span-3">
          <p className="mb-1.5 text-body-sm text-text-muted">实际到达地 <span className="text-error">*</span></p>
          <div className="grid grid-cols-3 gap-3">
            <UrgentSelectField label="" required value={form.destinationProvince} error={errors.destinationProvince} disabled={readOnly} onChange={(value) => changeField('destinationProvince', value)} />
            <UrgentSelectField label="" required value={form.destinationCity} error={errors.destinationCity} disabled={readOnly || !form.destinationProvince} onChange={(value) => changeField('destinationCity', value)} />
            <UrgentSelectField label="" required value={form.destinationDistrict} error={errors.destinationDistrict} disabled={readOnly || !form.destinationCity} onChange={(value) => changeField('destinationDistrict', value)} />
          </div>
        </div>
        <div className="xl:col-span-5">
          <CommunicationField label="详细地址" required error={errors.destinationAddress}>
            <input value={form.destinationAddress} disabled={readOnly || !form.destinationDistrict} onChange={(event) => changeField('destinationAddress', event.target.value)} placeholder="请输入详细地址" className={inputClass(Boolean(errors.destinationAddress)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
        </div>

        <HospitalDateTimeField label="实际服务时间" required value={form.serviceTime} error={errors.serviceTime} disabled={readOnly} onChange={(value) => changeField('serviceTime', value)} />
        <UrgentSelectField label="起止距离（公里）" required value={form.distance} error={errors.distance} disabled={readOnly} onChange={(value) => changeField('distance', value)} />
        <UrgentSelectField label="是否同城" required value={form.sameCity} error={errors.sameCity} disabled={readOnly} onChange={(value) => changeField('sameCity', value)} />
        <UrgentSelectField label="交通工具" required value={form.transport} error={errors.transport} disabled={readOnly} onChange={(value) => changeField('transport', value)} />
        <UrgentSelectField label="车型" required value={form.vehicle} error={errors.vehicle} disabled={readOnly} onChange={(value) => changeField('vehicle', value)} />
        <CommunicationField label="陪诊姓名" required error={errors.escortName}>
          <input value={form.escortName} disabled={readOnly} onChange={(event) => changeField('escortName', event.target.value)} placeholder="请输入陪诊姓名" className={inputClass(Boolean(errors.escortName)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
        <CommunicationField label="陪诊联系电话" required error={errors.escortPhone}>
          <input value={form.escortPhone} disabled={readOnly} onChange={(event) => changeField('escortPhone', event.target.value)} placeholder="请输入陪诊联系电话" className={inputClass(Boolean(errors.escortPhone)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
        <CommunicationField label="返程人数（人）">
          <input type="number" min="0" value={form.returnPassengers} disabled={readOnly} onChange={(event) => changeField('returnPassengers', event.target.value)} placeholder="请输入返程人数" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
        <CommunicationField label="累计购票金额（元）">
          <input type="number" min="0" value={form.ticketAmount} disabled={readOnly} onChange={(event) => changeField('ticketAmount', event.target.value)} placeholder="请输入金额" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
        <CommunicationField label="病情备注">
          <input value={form.illnessRemark} disabled={readOnly} onChange={(event) => changeField('illnessRemark', event.target.value)} placeholder="请输入病情备注" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
      </div>

      <CareImageSection title="附件信息" subtitle="请上传车票、机票、地址距离截图 *" />

      {!readOnly && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {validated && <span className="mr-auto text-body-sm text-status-success">必填字段校验通过</span>}
          <button type="button" title="保存功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">保存</button>
          <button type="button" title="发送服务信息功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">发送服务信息</button>
          <button type="button" title="爽约功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">爽约</button>
          <button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button>
        </div>
      )}
    </div>
  )
}

interface SharedServiceFormValue {
  province: string
  city: string
  hospital: string
  address: string
  department: string
  expert: string
  scheduledAt: string
  servicePerson: string
  serviceContact: string
  serviceStart: string
  serviceEnd: string
  remark: string
}

const EMPTY_SHARED_SERVICE: SharedServiceFormValue = {
  province: '', city: '', hospital: '', address: '', department: '', expert: '', scheduledAt: '',
  servicePerson: '', serviceContact: '', serviceStart: '', serviceEnd: '', remark: ''
}

function SharedServiceEntryForm({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const [form, setForm] = useState<SharedServiceFormValue>(EMPTY_SHARED_SERVICE)
  const [errors, setErrors] = useState<Partial<Record<keyof SharedServiceFormValue, string>>>({})
  const [validated, setValidated] = useState(false)

  function changeField(field: keyof SharedServiceFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
  }

  function submit(): void {
    const required: Array<[keyof SharedServiceFormValue, string]> = [
      ['scheduledAt', '请选择预约服务时间'],
      ['serviceStart', '请选择服务开始时间'],
      ['serviceEnd', '请选择服务结束时间']
    ]
    const nextErrors: Partial<Record<keyof SharedServiceFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!form[field].trim()) nextErrors[field] = message
    }
    setErrors(nextErrors)
    setValidated(Object.keys(nextErrors).length === 0)
  }

  return (
    <div className="mt-4 space-y-6">
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <p className="mb-1.5 text-body-sm text-text-muted">地域选择</p>
          <div className="grid grid-cols-2 gap-3">
            <UrgentSelectField label="" value={form.province} disabled={readOnly} onChange={(value) => changeField('province', value)} />
            <UrgentSelectField label="" value={form.city} disabled={readOnly || !form.province} onChange={(value) => changeField('city', value)} />
          </div>
        </div>
        <CommunicationField label="就诊医院">
          <input value={form.hospital} disabled={readOnly} onChange={(event) => changeField('hospital', event.target.value)} placeholder="请输入" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
        <CommunicationField label="就诊地址">
          <input value={form.address} disabled={readOnly} onChange={(event) => changeField('address', event.target.value)} placeholder="请输入" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
        <CommunicationField label="就诊科室">
          <input value={form.department} disabled={readOnly} onChange={(event) => changeField('department', event.target.value)} placeholder="请输入" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
        <CommunicationField label="就诊专家">
          <input value={form.expert} disabled={readOnly} onChange={(event) => changeField('expert', event.target.value)} placeholder="请输入" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
        <HospitalDateTimeField label="预约服务时间" required value={form.scheduledAt} error={errors.scheduledAt} disabled={readOnly} onChange={(value) => changeField('scheduledAt', value)} />
        <CommunicationField label="服务人员">
          <input value={form.servicePerson} disabled={readOnly} onChange={(event) => changeField('servicePerson', event.target.value)} placeholder="请输入" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
        <CommunicationField label="服务人员联系方式">
          <input value={form.serviceContact} disabled={readOnly} onChange={(event) => changeField('serviceContact', event.target.value)} placeholder="请输入" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
        </CommunicationField>
      </div>

      {!readOnly && (
        <div className="flex justify-end">
          <button type="button" title="确认服务方案功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">确认服务方案</button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
        <HospitalDateTimeField label="服务开始时间" required value={form.serviceStart} error={errors.serviceStart} disabled={readOnly} onChange={(value) => changeField('serviceStart', value)} />
        <HospitalDateTimeField label="服务结束时间" required value={form.serviceEnd} error={errors.serviceEnd} disabled={readOnly} onChange={(value) => changeField('serviceEnd', value)} />
      </div>

      <CareImageSection title="影像信息" />

      <CommunicationField label="备注">
        <textarea value={form.remark} disabled={readOnly} onChange={(event) => changeField('remark', event.target.value)} placeholder="请输入内容" className="min-h-24 w-full rounded-md border border-border-subtle bg-white px-2.5 py-2 text-body-sm text-text-main outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:bg-surface-bg" />
      </CommunicationField>

      {!readOnly && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {validated && <span className="mr-auto text-body-sm text-status-success">必填字段校验通过</span>}
          <button type="button" title="爽约功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">爽约</button>
          <button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button>
        </div>
      )}
    </div>
  )
}

function MdtPlanConfirmationForm({ readOnly }: { readOnly: boolean }): React.JSX.Element {
  const [materialModalOpen, setMaterialModalOpen] = useState(false)
  const [materialType, setMaterialType] = useState<'identity' | 'medical'>('identity')
  const [appointmentAt, setAppointmentAt] = useState('')
  const [appointmentError, setAppointmentError] = useState('')
  const [appointmentChecked, setAppointmentChecked] = useState(false)

  function completeAppointment(): void {
    if (!appointmentAt) {
      setAppointmentError('请选择预约服务时间')
      setAppointmentChecked(false)
      return
    }
    setAppointmentError('')
    setAppointmentChecked(true)
  }

  return (
    <div className="mt-4 space-y-8">
      <section className="border-b border-border-subtle pb-8">
        <h4 className="text-[16px] font-bold text-text-main">资料确认</h4>
        <p className="mt-4 text-body-sm text-error">请核实订单附件信息是否完整，如需补充资料请点击右侧补充资料按钮</p>
        {!readOnly && (
          <div className="mt-4 flex flex-wrap justify-end gap-4">
            <button type="button" onClick={() => setMaterialModalOpen(true)} className="h-10 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">补充资料</button>
            <button type="button" title="确认资料完整功能暂未接入" className="h-10 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white">确认资料完整</button>
          </div>
        )}
      </section>

      <section>
        <h4 className="mb-5 text-[16px] font-bold text-text-main">预约服务信息</h4>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="w-full max-w-[430px]">
            <HospitalDateTimeField
              label="预约服务时间"
              required
              value={appointmentAt}
              error={appointmentError}
              disabled={readOnly}
              onChange={(value) => {
                setAppointmentAt(value)
                setAppointmentError('')
                setAppointmentChecked(false)
              }}
            />
          </div>
          {!readOnly && (
            <div className="flex items-center gap-3">
              {appointmentChecked && <span className="text-body-sm text-status-success">预约时间已校验</span>}
              <button type="button" onClick={completeAppointment} className="h-10 rounded-md bg-[#84bdf7] px-6 text-body-sm font-bold text-white hover:bg-[#69a9e8]">预约完成</button>
            </div>
          )}
        </div>
      </section>

      {materialModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label="补充资料">
          <div className="w-full max-w-[1080px] overflow-hidden rounded-md bg-white shadow-2xl">
            <div className="flex items-center justify-between bg-[#079d8a] px-4 py-3 text-[18px] font-bold text-white">
              <span>补充资料</span>
              <button type="button" onClick={() => setMaterialModalOpen(false)} className="material-symbols-outlined rounded p-1 hover:bg-white/15" aria-label="关闭">close</button>
            </div>
            <div className="p-4">
              <div className="flex items-center gap-10 text-[18px]">
                <label className="inline-flex cursor-pointer items-center gap-3 text-[#4299f5]">
                  <input type="radio" checked={materialType === 'identity'} onChange={() => setMaterialType('identity')} className="h-5 w-5 accent-[#4299f5]" />
                  身份证附件
                </label>
                <label className="inline-flex cursor-pointer items-center gap-3 text-text-muted">
                  <input type="radio" checked={materialType === 'medical'} onChange={() => setMaterialType('medical')} className="h-5 w-5 accent-[#4299f5]" />
                  病历资料
                </label>
              </div>
              <div className="mt-6 flex min-h-56 items-start">
                <button type="button" title="附件上传功能暂未接入" className="flex h-56 w-56 items-center justify-center rounded-md border border-dashed border-[#b7c9df] text-[48px] font-light text-text-muted hover:bg-surface-bg">＋</button>
              </div>
              <div className="mt-3 flex items-center justify-between px-4 text-body-sm text-text-muted">
                <span>共 0 条</span>
                <div className="flex items-center gap-6">
                  <span className="rounded border border-border-subtle px-5 py-2">5条/页　⌄</span>
                  <span>‹　 <b className="text-[#078b7c]">1</b>　 ›</span>
                </div>
              </div>
              <p className="mt-4 text-body-sm text-text-muted">支持格式：jpg、jpeg、bmp、gif、png、pdf、zip，单个文件最大20M</p>
              <div className="mt-8 flex justify-center">
                <button type="button" onClick={() => setMaterialModalOpen(false)} className="h-11 rounded-md bg-[#078b7c] px-8 text-body-sm font-bold text-white hover:bg-[#06786c]">确定</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface RegistrationAssistanceServiceEntryValue {
  hospitalAddress: string
  actualVisitAt: string
  latestTicketAt: string
  doctorName: string
  doctorLevel: string
  expert: string
  registrationFeePaid: string
}

const EMPTY_REGISTRATION_SERVICE_ENTRY: RegistrationAssistanceServiceEntryValue = {
  hospitalAddress: '', actualVisitAt: '', latestTicketAt: '', doctorName: '', doctorLevel: '', expert: '0', registrationFeePaid: '0'
}

function RegistrationAssistanceServiceEntryForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [form, setForm] = useState<RegistrationAssistanceServiceEntryValue>(EMPTY_REGISTRATION_SERVICE_ENTRY)
  const [errors, setErrors] = useState<Partial<Record<keyof RegistrationAssistanceServiceEntryValue, string>>>({})
  const [validated, setValidated] = useState(false)

  function updateField(field: keyof RegistrationAssistanceServiceEntryValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
  }

  function submit(): void {
    const required: Array<[keyof RegistrationAssistanceServiceEntryValue, string]> = [
      ['hospitalAddress', '请填写医院地址'], ['actualVisitAt', '请选择实际就诊时间'], ['latestTicketAt', '请选择最晚取号时间']
    ]
    const nextErrors: Partial<Record<keyof RegistrationAssistanceServiceEntryValue, string>> = {}
    for (const [field, message] of required) if (!form[field].trim()) nextErrors[field] = message
    setErrors(nextErrors)
    setValidated(Object.keys(nextErrors).length === 0)
  }

  const selectClass = (error?: string): string => inputClass(Boolean(error)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'
  return (
    <div className="mt-4 space-y-5">
      <div className="rounded-md border border-border-subtle bg-surface-bg p-4"><h4 className="mb-4 text-[16px] font-bold text-text-main">挂号信息</h4><div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-4"><HeaderFact label="就诊地区" value="—" /><HeaderFact label="医院名称" value={order.hospital || '—'} /><HeaderFact label="科室" value={order.dept || '—'} /><HeaderFact label="意向就诊时间" value={formatClaimedTime(order.intendDate)} /></div></div>
      <div className="rounded-md border-2 border-[#fb5b5b] bg-white p-4"><div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-4"><CommunicationField label="医院地址" required error={errors.hospitalAddress}><input value={form.hospitalAddress} disabled={readOnly} onChange={(event) => updateField('hospitalAddress', event.target.value)} placeholder="请输入医院地址" className={inputClass(Boolean(errors.hospitalAddress)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField><CommunicationField label="实际就诊时间" required error={errors.actualVisitAt}><input type="datetime-local" step="1" value={form.actualVisitAt} disabled={readOnly} onChange={(event) => updateField('actualVisitAt', event.target.value)} className={inputClass(Boolean(errors.actualVisitAt)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField><CommunicationField label="最晚取号时间" required error={errors.latestTicketAt}><input type="datetime-local" step="1" value={form.latestTicketAt} disabled={readOnly} onChange={(event) => updateField('latestTicketAt', event.target.value)} className={inputClass(Boolean(errors.latestTicketAt)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField><CommunicationField label="医生姓名"><input value={form.doctorName} disabled={readOnly} onChange={(event) => updateField('doctorName', event.target.value)} placeholder="请输入医生姓名" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField><CommunicationField label="医生级别"><input value={form.doctorLevel} disabled={readOnly} onChange={(event) => updateField('doctorLevel', event.target.value)} placeholder="请输入医生级别" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField><CommunicationField label="是否点名专家"><select value={form.expert} disabled={readOnly} onChange={(event) => updateField('expert', event.target.value)} className={selectClass()}><option value="0">否</option><option value="1">是</option></select></CommunicationField><CommunicationField label="是否支付挂号费"><select value={form.registrationFeePaid} disabled={readOnly} onChange={(event) => updateField('registrationFeePaid', event.target.value)} className={selectClass()}><option value="0">否</option><option value="1">是</option></select></CommunicationField></div><div className="mt-6"><CareImageSection title="影像信息" subtitle="可上传多个影像" /></div>{!readOnly && <div className="mt-5 flex items-center justify-end gap-3">{validated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}<button type="button" title="爽约功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">爽约</button><button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">提交</button></div>}</div>
    </div>
  )
}

interface MdtServiceEntryFormValue {
  serviceStart: string
  serviceEnd: string
  diagnosis: string
  diseaseSummary: string
  expertAdvice: string
}

interface MdtServicePlanFormValue {
  hospital: string
  department: string
  doctor: string
  title: string
  doctorSummary: string
}

const EMPTY_MDT_SERVICE_ENTRY: MdtServiceEntryFormValue = {
  serviceStart: '', serviceEnd: '', diagnosis: '', diseaseSummary: '', expertAdvice: ''
}

const EMPTY_MDT_SERVICE_PLAN: MdtServicePlanFormValue = {
  hospital: '', department: '', doctor: '', title: '', doctorSummary: ''
}

function MdtServiceEntryForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [form, setForm] = useState<MdtServiceEntryFormValue>(EMPTY_MDT_SERVICE_ENTRY)
  const [plan, setPlan] = useState<MdtServicePlanFormValue>(EMPTY_MDT_SERVICE_PLAN)
  const [plans, setPlans] = useState<Array<MdtServicePlanFormValue & { id: number }>>([])
  const [errors, setErrors] = useState<Partial<Record<keyof MdtServiceEntryFormValue, string>>>({})
  const [planErrors, setPlanErrors] = useState<Partial<Record<keyof MdtServicePlanFormValue, string>>>({})
  const [validated, setValidated] = useState(false)

  function updateField(field: keyof MdtServiceEntryFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
  }

  function updatePlan(field: keyof MdtServicePlanFormValue, value: string): void {
    setPlan((current) => ({ ...current, [field]: value }))
    setPlanErrors((current) => ({ ...current, [field]: undefined }))
  }

  function addPlan(): void {
    const required: Array<[keyof MdtServicePlanFormValue, string]> = [
      ['hospital', '请填写医院名称'], ['department', '请填写就诊科室'], ['doctor', '请填写就诊医生'], ['title', '请填写医生职称']
    ]
    const nextErrors: Partial<Record<keyof MdtServicePlanFormValue, string>> = {}
    for (const [field, message] of required) if (!plan[field].trim()) nextErrors[field] = message
    setPlanErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    setPlans((current) => [...current, { ...plan, id: Date.now() }])
    setPlan(EMPTY_MDT_SERVICE_PLAN)
  }

  function submit(): void {
    const required: Array<[keyof MdtServiceEntryFormValue, string]> = [
      ['serviceStart', '请选择服务开始时间'], ['serviceEnd', '请选择服务结束时间'], ['diagnosis', '请填写疾病诊断'], ['diseaseSummary', '请填写疾病简介'], ['expertAdvice', '请填写专家咨询建议']
    ]
    const nextErrors: Partial<Record<keyof MdtServiceEntryFormValue, string>> = {}
    for (const [field, message] of required) if (!form[field].trim()) nextErrors[field] = message
    setErrors(nextErrors)
    setValidated(Object.keys(nextErrors).length === 0)
  }

  const disabledClass = ' disabled:cursor-not-allowed disabled:bg-surface-bg'
  const orderHospital = order.hospital || '—'

  return (
    <div className="mt-4 space-y-6">
      <div className="rounded-md border border-border-subtle bg-surface-bg p-4">
        <p className="mb-4 text-body-sm text-text-muted">订单医院：<span className="font-semibold text-text-main">{orderHospital}</span></p>
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
          <CommunicationField label="服务开始时间" required error={errors.serviceStart}><input type="datetime-local" step="1" value={form.serviceStart} disabled={readOnly} onChange={(event) => updateField('serviceStart', event.target.value)} className={inputClass(Boolean(errors.serviceStart)) + disabledClass} /></CommunicationField>
          <CommunicationField label="服务结束时间" required error={errors.serviceEnd}><input type="datetime-local" step="1" value={form.serviceEnd} disabled={readOnly} onChange={(event) => updateField('serviceEnd', event.target.value)} className={inputClass(Boolean(errors.serviceEnd)) + disabledClass} /></CommunicationField>
          <CommunicationField label="疾病诊断" required error={errors.diagnosis}><input value={form.diagnosis} disabled={readOnly} onChange={(event) => updateField('diagnosis', event.target.value)} placeholder="请输入疾病诊断" className={inputClass(Boolean(errors.diagnosis)) + disabledClass} /></CommunicationField>
          <CommunicationField label="疾病简介" required error={errors.diseaseSummary}><input value={form.diseaseSummary} disabled={readOnly} onChange={(event) => updateField('diseaseSummary', event.target.value)} placeholder="请输入疾病简介" className={inputClass(Boolean(errors.diseaseSummary)) + disabledClass} /></CommunicationField>
        </div>
        <div className="mt-5"><CommunicationField label="专家咨询建议" required error={errors.expertAdvice}><textarea value={form.expertAdvice} disabled={readOnly} onChange={(event) => updateField('expertAdvice', event.target.value)} maxLength={2000} placeholder="请输入专家咨询建议" className={'min-h-28 w-full rounded-md border bg-white px-2.5 py-2 text-body-sm text-text-main outline-none disabled:cursor-not-allowed disabled:bg-surface-bg ' + (errors.expertAdvice ? 'border-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')} /><span className="mt-1 block text-right text-[11px] text-text-muted">{form.expertAdvice.length}/2000</span></CommunicationField></div>
      </div>

      <div>
        <h4 className="mb-3 text-[16px] font-bold text-text-main">服务方案列表</h4>
        {!readOnly && <div className="grid grid-cols-1 items-end gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-[1.1fr_1.1fr_1.1fr_1fr_1.5fr_auto]"><CommunicationField label="医院名称" required error={planErrors.hospital}><input value={plan.hospital} onChange={(event) => updatePlan('hospital', event.target.value)} placeholder="请输入医院名称" className={inputClass(Boolean(planErrors.hospital))} /></CommunicationField><CommunicationField label="就诊科室" required error={planErrors.department}><input value={plan.department} onChange={(event) => updatePlan('department', event.target.value)} placeholder="请输入就诊科室" className={inputClass(Boolean(planErrors.department))} /></CommunicationField><CommunicationField label="就诊医生" required error={planErrors.doctor}><input value={plan.doctor} onChange={(event) => updatePlan('doctor', event.target.value)} placeholder="请输入就诊医生" className={inputClass(Boolean(planErrors.doctor))} /></CommunicationField><CommunicationField label="医生职称" required error={planErrors.title}><input value={plan.title} onChange={(event) => updatePlan('title', event.target.value)} placeholder="请输入医生职称" className={inputClass(Boolean(planErrors.title))} /></CommunicationField><CommunicationField label="医生简介"><input value={plan.doctorSummary} onChange={(event) => updatePlan('doctorSummary', event.target.value)} placeholder="请输入医生简介" className={inputClass(false)} /></CommunicationField><button type="button" onClick={addPlan} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">新增方案</button></div>}
        <div className="mt-4 space-y-2">{plans.length === 0 ? <div className="rounded-md border border-border-subtle bg-surface-bg px-4 py-8 text-center text-body-sm text-text-muted">暂无服务方案数据</div> : plans.map((item, index) => <div key={item.id} className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-md border border-border-subtle bg-surface-bg px-4 py-3 text-body-sm md:grid-cols-2 xl:grid-cols-[0.5fr_1.5fr_1.2fr_1.2fr_1fr_2fr_auto]"><span className="font-semibold text-text-muted">{index + 1}</span><HeaderFact label="医院名称" value={item.hospital} /><HeaderFact label="就诊科室" value={item.department} /><HeaderFact label="就诊医生" value={item.doctor} /><HeaderFact label="医生职称" value={item.title} /><HeaderFact label="医生简介" value={item.doctorSummary || '—'} />{!readOnly && <button type="button" onClick={() => setPlans((current) => current.filter((record) => record.id !== item.id))} className="text-error hover:underline">移除</button>}</div>)}</div>
      </div>

      <div className="flex items-center justify-end gap-3">{validated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}{!readOnly && <><button type="button" title="爽约功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">爽约</button><button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button></>}</div>
      <p className="text-[12px] text-text-muted">数据来源于只读服务录入查看页的字段反推，保存与方案详情接口待后续接入。</p>
    </div>
  )
}

interface RegistrationChangeFormValue {
  province: string
  city: string
  hospital: string
  department: string
  visitDate: string
  visitPeriod: string
}

const EMPTY_REGISTRATION_CHANGE: RegistrationChangeFormValue = {
  province: '', city: '', hospital: '', department: '', visitDate: '', visitPeriod: ''
}

function RegistrationAssistancePlanView({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [changeOpen, setChangeOpen] = useState(false)
  const [changeForm, setChangeForm] = useState<RegistrationChangeFormValue>(() => ({ ...EMPTY_REGISTRATION_CHANGE, hospital: order.hospital || '', department: order.dept || '' }))
  const [errors, setErrors] = useState<Partial<Record<keyof RegistrationChangeFormValue, string>>>({})
  const [status, setStatus] = useState('')

  function updateField(field: keyof RegistrationChangeFormValue, value: string): void {
    setChangeForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setStatus('')
  }

  function confirmChange(): void {
    const required: Array<[keyof RegistrationChangeFormValue, string]> = [
      ['province', '请选择省'], ['city', '请选择市'], ['hospital', '请选择医院'], ['department', '请填写科室'], ['visitDate', '请选择意向就诊时间'], ['visitPeriod', '请选择上午或下午']
    ]
    const nextErrors: Partial<Record<keyof RegistrationChangeFormValue, string>> = {}
    for (const [field, message] of required) if (!changeForm[field].trim()) nextErrors[field] = message
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    setStatus('挂号信息变更已记录，后台同步功能待接入')
    setChangeOpen(false)
  }

  return (
    <div className="mt-4 space-y-5">
      <div className="rounded-md border border-border-subtle bg-surface-bg p-4">
        <div className="mb-4 flex items-center justify-between"><h4 className="text-[16px] font-bold text-text-main">挂号信息</h4><button type="button" onClick={() => setStatus('暂无挂号变更记录')} className="text-body-sm font-semibold text-primary hover:underline">查看变更记录</button></div>
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-4"><HeaderFact label="就诊地区" value="—" /><HeaderFact label="医院名称" value={order.hospital || '—'} /><HeaderFact label="科室" value={order.dept || '—'} /><HeaderFact label="意向就诊时间" value="—" /></div>
        {!readOnly && <div className="mt-5 flex justify-end gap-3"><button type="button" onClick={() => setStatus('挂号信息已确认')} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">确认挂号信息</button><button type="button" onClick={() => setChangeOpen(true)} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">变更挂号信息</button></div>}
        {status && <p className="mt-3 text-right text-body-sm text-status-success">{status}</p>}
      </div>

      {changeOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div className="w-full max-w-4xl overflow-hidden rounded-md bg-white shadow-xl"><div className="flex items-center justify-between bg-[#079d8a] px-5 py-3 text-white"><h3 className="text-[16px] font-bold">变更挂号信息</h3><button type="button" onClick={() => setChangeOpen(false)} aria-label="关闭" className="text-2xl leading-none">×</button></div><div className="space-y-5 p-5"><div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-3"><CommunicationField label="省" required error={errors.province}><select value={changeForm.province} onChange={(event) => updateField('province', event.target.value)} className={inputClass(Boolean(errors.province))}><option value="">请选择</option>{changeForm.province && <option value={changeForm.province}>{changeForm.province}</option>}</select></CommunicationField><CommunicationField label="市" required error={errors.city}><select value={changeForm.city} onChange={(event) => updateField('city', event.target.value)} className={inputClass(Boolean(errors.city))}><option value="">请选择</option>{changeForm.city && <option value={changeForm.city}>{changeForm.city}</option>}</select></CommunicationField><CommunicationField label="医院" required error={errors.hospital}><select value={changeForm.hospital} onChange={(event) => updateField('hospital', event.target.value)} className={inputClass(Boolean(errors.hospital))}><option value="">请选择</option>{changeForm.hospital && <option value={changeForm.hospital}>{changeForm.hospital}</option>}</select></CommunicationField><CommunicationField label="科室" required error={errors.department}><input value={changeForm.department} onChange={(event) => updateField('department', event.target.value)} placeholder="请输入科室" className={inputClass(Boolean(errors.department))} /></CommunicationField><CommunicationField label="意向就诊时间" required error={errors.visitDate}><input type="date" value={changeForm.visitDate} onChange={(event) => updateField('visitDate', event.target.value)} className={inputClass(Boolean(errors.visitDate))} /></CommunicationField><CommunicationField label="时段" required error={errors.visitPeriod}><select value={changeForm.visitPeriod} onChange={(event) => updateField('visitPeriod', event.target.value)} className={inputClass(Boolean(errors.visitPeriod))}><option value="">请选择</option><option value="上午">上午</option><option value="下午">下午</option></select></CommunicationField></div><div className="flex justify-end gap-3"><button type="button" onClick={() => setChangeOpen(false)} className="h-9 rounded-md border border-border-subtle bg-[#e4f5f2] px-6 text-body-sm text-[#078b7c]">关闭</button><button type="button" onClick={confirmChange} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">确认变更</button></div></div></div></div>}
    </div>
  )
}

interface HospitalCareAssignmentFormValue {
  province: string
  city: string
  hospital: string
  hospitalAddress: string
  escort: string
  contact: string
  department: string
  careStartDate: string
  suggestion: string
}

const EMPTY_HOSPITAL_CARE_ASSIGNMENT: HospitalCareAssignmentFormValue = {
  province: '', city: '', hospital: '', hospitalAddress: '', escort: '', contact: '', department: '', careStartDate: '', suggestion: ''
}

function HospitalCareAssignmentForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [form, setForm] = useState<HospitalCareAssignmentFormValue>(EMPTY_HOSPITAL_CARE_ASSIGNMENT)
  const [errors, setErrors] = useState<Partial<Record<keyof HospitalCareAssignmentFormValue, string>>>({})
  const [validated, setValidated] = useState(false)

  function updateField(field: keyof HospitalCareAssignmentFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
  }

  function submit(): void {
    const required: Array<[keyof HospitalCareAssignmentFormValue, string]> = [
      ['province', '请选择省'],
      ['city', '请选择市'],
      ['hospital', '请选择医院'],
      ['hospitalAddress', '请选择医院地址'],
      ['escort', '请选择陪诊人员'],
      ['department', '请选择科室'],
      ['careStartDate', '请选择预计护工开启时间'],
      ['suggestion', '请填写意见/建议']
    ]
    const nextErrors: Partial<Record<keyof HospitalCareAssignmentFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!form[field].trim()) nextErrors[field] = message
    }
    setErrors(nextErrors)
    setValidated(Object.keys(nextErrors).length === 0)
  }

  return (
    <div className="mt-4 space-y-6">
      <label className="inline-flex items-center gap-2 text-body-sm text-text-main">
        <input type="checkbox" disabled={readOnly} className="h-4 w-4 accent-primary" />
        已与客户电话沟通，客户可就诊
      </label>

      <div>
        <h4 className="mb-3 text-[16px] font-bold text-text-main">分配陪诊人员</h4>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
          <UrgentSelectField label="省" required value={form.province} error={errors.province} disabled={readOnly} onChange={(value) => updateField('province', value)} />
          <UrgentSelectField label="市" required value={form.city} error={errors.city} disabled={readOnly || !form.province} onChange={(value) => updateField('city', value)} />
          <UrgentSelectField label="医院" required value={form.hospital} error={errors.hospital} disabled={readOnly || !form.city} onChange={(value) => updateField('hospital', value)} />
          <UrgentSelectField label="医院地址" required value={form.hospitalAddress} error={errors.hospitalAddress} disabled={readOnly || !form.hospital} onChange={(value) => updateField('hospitalAddress', value)} />
          <UrgentSelectField label="选择陪诊人员" required value={form.escort} error={errors.escort} disabled={readOnly || !form.hospital} onChange={(value) => updateField('escort', value)} />
          <CommunicationField label="陪诊人员联系方式">
            <input value={form.contact} disabled={readOnly} onChange={(event) => updateField('contact', event.target.value)} placeholder="请输入联系方式" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <CommunicationField label="发起护工时间">
            <input value={formatClaimedTime(order.createdAt ?? order.updatedAt)} readOnly className={inputClass(false) + ' cursor-not-allowed bg-surface-bg'} />
          </CommunicationField>
          <UrgentSelectField label="科室" required value={form.department} error={errors.department} disabled={readOnly || !form.hospital} onChange={(value) => updateField('department', value)} />
          <CommunicationField label="预计护工开启时间" required error={errors.careStartDate}>
            <input type="date" value={form.careStartDate} disabled={readOnly} onChange={(event) => updateField('careStartDate', event.target.value)} className={inputClass(Boolean(errors.careStartDate)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <div className="md:col-span-2 xl:col-span-4">
            <CommunicationField label="意见/建议" required error={errors.suggestion}>
              <textarea value={form.suggestion} disabled={readOnly} onChange={(event) => updateField('suggestion', event.target.value)} maxLength={1000} placeholder="请输入内容" className={'min-h-28 w-full rounded-md border bg-white px-2.5 py-2 text-body-sm text-text-main outline-none disabled:cursor-not-allowed disabled:bg-surface-bg ' + (errors.suggestion ? 'border-error focus:ring-1 focus:ring-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')} />
              <span className="mt-1 block text-right text-[11px] text-text-muted">{form.suggestion.length}/1000</span>
            </CommunicationField>
          </div>
        </div>
        {!readOnly && (
          <div className="mt-4 flex items-center justify-end gap-3">
            {validated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}
            <button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-6 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button>
          </div>
        )}
      </div>
    </div>
  )
}

interface UrgentEscortEntryFormValue {
  waitingAddress: string
  appointmentTime: string
  appointmentSuccessTime: string
  actualCheckTime: string
  conclusion: string
}

const EMPTY_URGENT_ESCORT_ENTRY: UrgentEscortEntryFormValue = {
  waitingAddress: '', appointmentTime: '', appointmentSuccessTime: '', actualCheckTime: '', conclusion: ''
}

function UrgentCheckEscortEntryForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [form, setForm] = useState<UrgentEscortEntryFormValue>(EMPTY_URGENT_ESCORT_ENTRY)
  const [errors, setErrors] = useState<Partial<Record<keyof UrgentEscortEntryFormValue, string>>>({})
  const [validated, setValidated] = useState(false)

  function updateField(field: keyof UrgentEscortEntryFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
  }

  function submit(): void {
    const required: Array<[keyof UrgentEscortEntryFormValue, string]> = [
      ['waitingAddress', '请填写候诊地址'],
      ['appointmentTime', '请选择预约就诊时间'],
      ['appointmentSuccessTime', '请选择预约成功时间'],
      ['actualCheckTime', '请选择实际检查时间'],
      ['conclusion', '请填写备注']
    ]
    const nextErrors: Partial<Record<keyof UrgentEscortEntryFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!form[field].trim()) nextErrors[field] = message
    }
    setErrors(nextErrors)
    setValidated(Object.keys(nextErrors).length === 0)
  }

  return (
    <div className="mt-4 overflow-hidden rounded-md border border-border-subtle bg-surface-bg">
      <div className="grid grid-cols-1 gap-4 border-b border-border-subtle px-4 py-4 text-body-sm md:grid-cols-3">
        <HeaderFact label="检查项目" value="—" />
        <HeaderFact label="检查医院" value={order.hospital || '—'} />
        <HeaderFact label="发起检查时间" value={formatClaimedTime(order.createdAt ?? order.updatedAt)} />
      </div>

      <div className="space-y-6 px-4 py-5">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
          <CommunicationField label="候诊地址" required error={errors.waitingAddress}>
            <input value={form.waitingAddress} disabled={readOnly} onChange={(event) => updateField('waitingAddress', event.target.value)} placeholder="请输入候诊地址" className={inputClass(Boolean(errors.waitingAddress)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <CommunicationField label="预约就诊时间" required error={errors.appointmentTime}>
            <input type="datetime-local" value={form.appointmentTime} disabled={readOnly} onChange={(event) => updateField('appointmentTime', event.target.value)} className={inputClass(Boolean(errors.appointmentTime)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <CommunicationField label="预约成功时间" required error={errors.appointmentSuccessTime}>
            <input type="datetime-local" value={form.appointmentSuccessTime} disabled={readOnly} onChange={(event) => updateField('appointmentSuccessTime', event.target.value)} className={inputClass(Boolean(errors.appointmentSuccessTime)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <div className="flex items-end">
            <button type="button" title="发送预约信息给客户功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">发送预约信息给客户</button>
          </div>
          <CommunicationField label="实际检查时间" required error={errors.actualCheckTime}>
            <input type="datetime-local" value={form.actualCheckTime} disabled={readOnly} onChange={(event) => updateField('actualCheckTime', event.target.value)} className={inputClass(Boolean(errors.actualCheckTime)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
        </div>

        <div>
          <div className="mb-3 flex items-center gap-3">
            <h4 className="text-[16px] font-bold text-text-main">影像信息</h4>
            <span className="text-body-sm text-error">可上传多个影像</span>
          </div>
          <button type="button" title="影像上传功能暂未接入" className="flex h-40 w-40 items-center justify-center rounded-md border border-dashed border-primary/40 bg-white text-text-muted hover:border-primary hover:text-primary">
            <span className="material-symbols-outlined" style={{ fontSize: '40px' }}>add</span>
          </button>
          <div className="mt-3 flex items-center justify-between text-body-sm text-text-muted">
            <span>共 0 条</span>
            <div className="flex items-center gap-2">
              <button type="button" title="分页功能暂未接入" className="h-8 rounded-md border border-border-subtle bg-white px-3">5条/页</button>
              <button type="button" title="分页功能暂未接入" className="material-symbols-outlined p-1 text-text-muted">chevron_left</button>
              <span className="px-2 font-semibold text-primary">1</span>
              <button type="button" title="分页功能暂未接入" className="material-symbols-outlined p-1 text-text-muted">chevron_right</button>
            </div>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-[16px] font-bold text-text-main">检查结论</h4>
          <CommunicationField label="备注" required error={errors.conclusion}>
            <textarea value={form.conclusion} disabled={readOnly} onChange={(event) => updateField('conclusion', event.target.value)} maxLength={1000} placeholder="请输入内容" className={'min-h-28 w-full rounded-md border bg-white px-2.5 py-2 text-body-sm text-text-main outline-none disabled:cursor-not-allowed disabled:bg-surface-bg ' + (errors.conclusion ? 'border-error focus:ring-1 focus:ring-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')} />
            <span className="mt-1 block text-right text-[11px] text-text-muted">{form.conclusion.length}/1000</span>
          </CommunicationField>
        </div>

        {!readOnly && (
          <div className="flex items-center justify-end gap-3">
            {validated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}
            <button type="button" title="爽约处理功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">爽约</button>
            <button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button>
          </div>
        )}
      </div>
    </div>
  )
}

interface CareServiceRecord {
  id: number
  startTime: string
  endTime: string
  nurseName: string
}

interface HospitalCareEscortFormValue {
  admissionHandledAt: string
  dischargeTime: string
  dischargeDiagnosis: string
  icd10: string
  revisitTime: string
  admissionSummary: string
  serviceSummary: string
}

const EMPTY_HOSPITAL_CARE_ESCORT: HospitalCareEscortFormValue = {
  admissionHandledAt: '', dischargeTime: '', dischargeDiagnosis: '', icd10: '', revisitTime: '', admissionSummary: '', serviceSummary: ''
}

function HospitalCareEscortEntryForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [serviceStart, setServiceStart] = useState('')
  const [serviceEnd, setServiceEnd] = useState('')
  const [nurseName, setNurseName] = useState('')
  const [serviceErrors, setServiceErrors] = useState<{ start?: string; end?: string; nurse?: string }>({})
  const [serviceRecords, setServiceRecords] = useState<CareServiceRecord[]>([])
  const [feedback, setFeedback] = useState('')
  const [feedbackError, setFeedbackError] = useState('')
  const [feedbackRecords, setFeedbackRecords] = useState<Array<{ id: number; content: string }>>([])
  const [form, setForm] = useState<HospitalCareEscortFormValue>({
    ...EMPTY_HOSPITAL_CARE_ESCORT,
    admissionHandledAt: toDateTimeLocal(order.createdAt ?? order.updatedAt)
  })
  const [submitErrors, setSubmitErrors] = useState<{ service?: string; feedback?: string }>({})
  const [validated, setValidated] = useState(false)

  function addService(): void {
    const errors = {
      start: serviceStart ? undefined : '请选择服务开始时间',
      end: serviceEnd ? undefined : '请选择服务结束时间',
      nurse: nurseName.trim() ? undefined : '请填写护工姓名'
    }
    setServiceErrors(errors)
    if (errors.start || errors.end || errors.nurse) return
    setServiceRecords((current) => [...current, { id: Date.now(), startTime: serviceStart, endTime: serviceEnd, nurseName: nurseName.trim() }])
    setServiceStart('')
    setServiceEnd('')
    setNurseName('')
    setSubmitErrors((current) => ({ ...current, service: undefined }))
    setValidated(false)
  }

  function addFeedback(): void {
    if (!feedback.trim()) {
      setFeedbackError('请填写服务反馈')
      return
    }
    setFeedbackRecords((current) => [...current, { id: Date.now(), content: feedback.trim() }])
    setFeedback('')
    setFeedbackError('')
    setSubmitErrors((current) => ({ ...current, feedback: undefined }))
    setValidated(false)
  }

  function updateField(field: keyof HospitalCareEscortFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setValidated(false)
  }

  function submit(): void {
    const errors = {
      service: serviceRecords.length > 0 ? undefined : '请至少添加一条护工服务',
      feedback: feedbackRecords.length > 0 ? undefined : '请至少添加一条服务反馈'
    }
    setSubmitErrors(errors)
    setValidated(!errors.service && !errors.feedback)
  }

  const serviceDays = careServiceDays(serviceRecords)
  return (
    <div className="mt-4 overflow-hidden rounded-md border border-border-subtle bg-surface-bg">
      <div className="grid grid-cols-1 gap-4 border-b border-border-subtle px-4 py-4 text-body-sm md:grid-cols-2 xl:grid-cols-4">
        <HeaderFact label="医院名称" value={order.hospital || '—'} />
        <HeaderFact label="病房科室" value={order.dept || '—'} />
        <HeaderFact label="服务时间" value={serviceDays == null ? '—' : `${serviceDays}天`} />
        <HeaderFact label="预计护工开启时间" value="—" />
      </div>

      <div className="space-y-6 px-4 py-5">
        <HospitalDateTimeField label="办理住院时间" required value={form.admissionHandledAt} disabled={readOnly} onChange={(value) => updateField('admissionHandledAt', value)} />

        <div>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h4 className="text-[16px] font-bold text-text-main">护工服务信息</h4>
            <span className="text-body-sm text-error">一次权益仅支持15天服务，当服务天数已超13天时，请您提示客户。如与事先确认，可使用下一权益，请确保本次服务满15天。</span>
          </div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto]">
            <CommunicationField label="服务开始时间" required error={serviceErrors.start}>
              <input type="datetime-local" value={serviceStart} disabled={readOnly} onChange={(event) => { setServiceStart(event.target.value); setServiceErrors((current) => ({ ...current, start: undefined })) }} className={inputClass(Boolean(serviceErrors.start)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
            </CommunicationField>
            <CommunicationField label="服务结束时间" required error={serviceErrors.end}>
              <input type="datetime-local" value={serviceEnd} disabled={readOnly} onChange={(event) => { setServiceEnd(event.target.value); setServiceErrors((current) => ({ ...current, end: undefined })) }} className={inputClass(Boolean(serviceErrors.end)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
            </CommunicationField>
            <CommunicationField label="护工姓名" required error={serviceErrors.nurse}>
              <input value={nurseName} disabled={readOnly} onChange={(event) => { setNurseName(event.target.value); setServiceErrors((current) => ({ ...current, nurse: undefined })) }} placeholder="请输入护工姓名" className={inputClass(Boolean(serviceErrors.nurse)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
            </CommunicationField>
            {!readOnly && <div className="flex items-end"><button type="button" onClick={addService} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">添加护工服务</button></div>}
          </div>
          {submitErrors.service && <p className="mt-2 text-body-sm text-error">{submitErrors.service}</p>}
          {serviceRecords.length > 0 && (
            <div className="mt-4 space-y-2">
              {serviceRecords.map((record, index) => (
                <div key={record.id} className="grid grid-cols-[2rem_1fr_1fr_1fr_auto] items-center gap-3 rounded-md bg-white px-3 py-3 text-body-sm">
                  <span className="font-semibold text-text-muted">{index + 1}</span>
                  <div><span className="text-text-muted">服务开始时间：</span><span className="font-semibold text-text-main">{formatClaimedTime(record.startTime)}</span></div>
                  <div><span className="text-text-muted">服务结束时间：</span><span className="font-semibold text-text-main">{formatClaimedTime(record.endTime)}</span></div>
                  <div><span className="text-text-muted">护工姓名：</span><span className="font-semibold text-text-main">{record.nurseName}</span></div>
                  {!readOnly && <button type="button" onClick={() => { setServiceRecords((current) => current.filter((item) => item.id !== record.id)); setValidated(false) }} className="text-error hover:underline">× 移除</button>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h4 className="mb-3 text-[16px] font-bold text-text-main">服务反馈信息</h4>
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex-1"><CommunicationField label="服务反馈" required error={feedbackError}><input value={feedback} disabled={readOnly} onChange={(event) => { setFeedback(event.target.value); setFeedbackError('') }} placeholder="请输入服务反馈" className={inputClass(Boolean(feedbackError)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField></div>
            {!readOnly && <button type="button" onClick={addFeedback} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">添加服务反馈</button>}
          </div>
          {submitErrors.feedback && <p className="mt-2 text-body-sm text-error">{submitErrors.feedback}</p>}
          {feedbackRecords.length > 0 && (
            <div className="mt-4 space-y-2">
              {feedbackRecords.map((record, index) => (
                <div key={record.id} className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-md bg-white px-3 py-3 text-body-sm">
                  <span className="font-semibold text-text-muted">{index + 1}</span>
                  <div><span className="text-text-muted">服务反馈：</span><span className="font-semibold text-text-main">{record.content}</span></div>
                  {!readOnly && <button type="button" onClick={() => { setFeedbackRecords((current) => current.filter((item) => item.id !== record.id)); setValidated(false) }} className="text-error hover:underline">× 移除</button>}
                </div>
              ))}
            </div>
          )}
        </div>

        <CareImageSection title="医疗影像" subtitle="可上传多个影像" />
        <CareImageSection title="护工知情同意书" />
        <CareImageSection title="其他" />

        <div>
          <h4 className="mb-3 text-[16px] font-bold text-text-main">出院信息</h4>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
            <HospitalDateTimeField label="出院时间" value={form.dischargeTime} disabled={readOnly} onChange={(value) => updateField('dischargeTime', value)} />
            <CommunicationField label="出院诊断结论"><input value={form.dischargeDiagnosis} disabled={readOnly} onChange={(event) => updateField('dischargeDiagnosis', event.target.value)} placeholder="请输入内容" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField>
            <CommunicationField label="ICD10编码"><input value={form.icd10} disabled={readOnly} onChange={(event) => updateField('icd10', event.target.value)} placeholder="请输入内容" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField>
            <HospitalDateTimeField label="复诊时间" value={form.revisitTime} disabled={readOnly} onChange={(value) => updateField('revisitTime', value)} />
            <div className="md:col-span-2 xl:col-span-4"><CommunicationField label="住院总结"><input value={form.admissionSummary} disabled={readOnly} onChange={(event) => updateField('admissionSummary', event.target.value)} placeholder="请输入内容" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} /></CommunicationField></div>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-[16px] font-bold text-text-main">结论信息</h4>
          <CommunicationField label="服务小结"><textarea value={form.serviceSummary} disabled={readOnly} onChange={(event) => updateField('serviceSummary', event.target.value)} maxLength={1000} placeholder="请输入内容" className="min-h-24 w-full rounded-md border border-border-subtle bg-white px-2.5 py-2 text-body-sm text-text-main outline-none disabled:cursor-not-allowed disabled:bg-surface-bg" /></CommunicationField>
        </div>

        {!readOnly && <div className="flex items-center justify-end gap-3">{validated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}<button type="button" title="爽约处理功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">爽约</button><button type="button" title="保存功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white">保存</button><button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button></div>}
      </div>
    </div>
  )
}

function CareImageSection({ title, subtitle }: { title: string; subtitle?: string }): React.JSX.Element {
  return (
    <div>
      <div className="mb-3 flex items-center gap-3"><h4 className="text-[16px] font-bold text-text-main">{title}</h4>{subtitle && <span className="text-body-sm text-error">{subtitle}</span>}</div>
      <button type="button" title="上传功能暂未接入" className="flex h-28 w-28 items-center justify-center rounded-md border border-dashed border-primary/40 bg-white text-text-muted hover:border-primary hover:text-primary"><span className="material-symbols-outlined" style={{ fontSize: '32px' }}>add</span></button>
      <div className="mt-3 flex items-center justify-between text-body-sm text-text-muted"><span>共 0 条</span><div className="flex items-center gap-2"><button type="button" title="分页功能暂未接入" className="h-8 rounded-md border border-border-subtle bg-white px-3">5条/页</button><span className="px-2 font-semibold text-primary">1</span></div></div>
    </div>
  )
}

function careServiceDays(records: CareServiceRecord[]): string | null {
  const hours = records.reduce((total, record) => {
    const start = new Date(record.startTime).getTime()
    const end = new Date(record.endTime).getTime()
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? total + (end - start) / 3_600_000 : total
  }, 0)
  return hours > 0 ? (hours / 24).toFixed(2).replace(/\.00$/, '') : null
}

interface HospitalEscortEntryFormValue {
  admissionNo: string
  appointmentTime: string
  appointmentSuccessTime: string
  actualAdmissionTime: string
  dischargeTime: string
  medicineCoordination: string
  diagnosis: string
  icd10: string
  revisitTime: string
  admissionType: string
  admissionSummary: string
}

const EMPTY_HOSPITAL_ESCORT_ENTRY: HospitalEscortEntryFormValue = {
  admissionNo: '', appointmentTime: '', appointmentSuccessTime: '', actualAdmissionTime: '', dischargeTime: '', medicineCoordination: '否', diagnosis: '', icd10: '', revisitTime: '', admissionType: '', admissionSummary: ''
}

function HospitalEscortEntryForm({ order, readOnly }: { order: Order; readOnly: boolean }): React.JSX.Element {
  const [form, setForm] = useState<HospitalEscortEntryFormValue>(EMPTY_HOSPITAL_ESCORT_ENTRY)
  const [errors, setErrors] = useState<Partial<Record<keyof HospitalEscortEntryFormValue, string>>>({})
  const [validated, setValidated] = useState(false)

  function updateField(field: keyof HospitalEscortEntryFormValue, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setValidated(false)
  }

  function submit(): void {
    const required: Array<[keyof HospitalEscortEntryFormValue, string]> = [
      ['admissionNo', '请填写住院单号'],
      ['appointmentTime', '请选择预约就诊时间'],
      ['appointmentSuccessTime', '请选择预约成功时间'],
      ['actualAdmissionTime', '请选择实际住院时间'],
      ['dischargeTime', '请选择出院时间'],
      ['diagnosis', '请填写诊断结论'],
      ['admissionType', '请选择住院类型'],
      ['admissionSummary', '请填写住院总结']
    ]
    const nextErrors: Partial<Record<keyof HospitalEscortEntryFormValue, string>> = {}
    for (const [field, message] of required) {
      if (!form[field].trim()) nextErrors[field] = message
    }
    setErrors(nextErrors)
    setValidated(Object.keys(nextErrors).length === 0)
  }

  return (
    <div className="mt-4 overflow-hidden rounded-md border border-border-subtle bg-surface-bg">
      <div className="grid grid-cols-1 gap-4 border-b border-border-subtle px-4 py-4 text-body-sm md:grid-cols-2 xl:grid-cols-4">
        <HeaderFact label="医院名称" value={order.hospital || '—'} />
        <HeaderFact label="病房科室" value={order.dept || '—'} />
        <HeaderFact label="主管医生" value={order.doctor || '—'} />
        <HeaderFact label="发起住院时间" value={formatClaimedTime(order.createdAt ?? order.updatedAt)} />
      </div>

      <div className="space-y-6 px-4 py-5">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
          <CommunicationField label="住院单号" required error={errors.admissionNo}>
            <input value={form.admissionNo} disabled={readOnly} onChange={(event) => updateField('admissionNo', event.target.value)} placeholder="请输入住院单号" className={inputClass(Boolean(errors.admissionNo)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
          </CommunicationField>
          <HospitalDateTimeField label="预约就诊时间" required value={form.appointmentTime} error={errors.appointmentTime} disabled={readOnly} onChange={(value) => updateField('appointmentTime', value)} />
          <HospitalDateTimeField label="预约成功时间" required value={form.appointmentSuccessTime} error={errors.appointmentSuccessTime} disabled={readOnly} onChange={(value) => updateField('appointmentSuccessTime', value)} />
          <HospitalDateTimeField label="实际住院时间" required value={form.actualAdmissionTime} error={errors.actualAdmissionTime} disabled={readOnly} onChange={(value) => updateField('actualAdmissionTime', value)} />
          <HospitalDateTimeField label="出院时间" required value={form.dischargeTime} error={errors.dischargeTime} disabled={readOnly} onChange={(value) => updateField('dischargeTime', value)} />
          <CommunicationField label="是否提供创新药械协调">
            <select value={form.medicineCoordination} disabled={readOnly} onChange={(event) => updateField('medicineCoordination', event.target.value)} className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'}>
              <option value="否">否</option>
              <option value="是">是</option>
            </select>
          </CommunicationField>
        </div>

        <div>
          <div className="mb-3 flex items-center gap-3">
            <h4 className="text-[16px] font-bold text-text-main">影像信息</h4>
            <span className="text-body-sm text-error">可上传多个影像</span>
          </div>
          <button type="button" title="影像上传功能暂未接入" className="flex h-40 w-40 items-center justify-center rounded-md border border-dashed border-primary/40 bg-white text-text-muted hover:border-primary hover:text-primary">
            <span className="material-symbols-outlined" style={{ fontSize: '40px' }}>add</span>
          </button>
          <div className="mt-3 flex items-center justify-between text-body-sm text-text-muted">
            <span>共 0 条</span>
            <div className="flex items-center gap-2">
              <button type="button" title="分页功能暂未接入" className="h-8 rounded-md border border-border-subtle bg-white px-3">5条/页</button>
              <button type="button" title="分页功能暂未接入" className="material-symbols-outlined p-1 text-text-muted">chevron_left</button>
              <span className="px-2 font-semibold text-primary">1</span>
              <button type="button" title="分页功能暂未接入" className="material-symbols-outlined p-1 text-text-muted">chevron_right</button>
            </div>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-[16px] font-bold text-text-main">结论信息</h4>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="md:col-span-2 xl:col-span-4">
              <CommunicationField label="诊断结论" required error={errors.diagnosis}>
                <input value={form.diagnosis} disabled={readOnly} onChange={(event) => updateField('diagnosis', event.target.value)} placeholder="请输入内容" className={inputClass(Boolean(errors.diagnosis)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
              </CommunicationField>
            </div>
            <div className="md:col-span-2 xl:col-span-4">
              <CommunicationField label="ICD10编码">
                <input value={form.icd10} disabled={readOnly} onChange={(event) => updateField('icd10', event.target.value)} placeholder="请输入内容" className={inputClass(false) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
              </CommunicationField>
            </div>
            <HospitalDateTimeField label="复诊时间" value={form.revisitTime} disabled={readOnly} onChange={(value) => updateField('revisitTime', value)} />
            <UrgentSelectField label="住院类型" required value={form.admissionType} error={errors.admissionType} disabled={readOnly} onChange={(value) => updateField('admissionType', value)} />
            <div className="md:col-span-2 xl:col-span-4">
              <CommunicationField label="住院总结" required error={errors.admissionSummary}>
                <textarea value={form.admissionSummary} disabled={readOnly} onChange={(event) => updateField('admissionSummary', event.target.value)} maxLength={1000} placeholder="请输入内容" className={'min-h-28 w-full rounded-md border bg-white px-2.5 py-2 text-body-sm text-text-main outline-none disabled:cursor-not-allowed disabled:bg-surface-bg ' + (errors.admissionSummary ? 'border-error focus:ring-1 focus:ring-error' : 'border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary')} />
                <span className="mt-1 block text-right text-[11px] text-text-muted">{form.admissionSummary.length}/1000</span>
              </CommunicationField>
            </div>
          </div>
        </div>

        {!readOnly && (
          <div className="flex items-center justify-end gap-3">
            {validated && <span className="text-body-sm text-status-success">必填字段校验通过</span>}
            <button type="button" title="爽约处理功能暂未接入" className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">爽约</button>
            <button type="button" onClick={submit} className="h-9 rounded-md bg-[#078b7c] px-5 text-body-sm font-bold text-white hover:bg-[#06786c]">提交</button>
          </div>
        )}
      </div>
    </div>
  )
}

function HospitalDateTimeField({
  label,
  required,
  value,
  error,
  disabled,
  onChange
}: {
  label: string
  required?: boolean
  value: string
  error?: string
  disabled?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <CommunicationField label={label} required={required} error={error}>
      <input type="datetime-local" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={inputClass(Boolean(error)) + ' disabled:cursor-not-allowed disabled:bg-surface-bg'} />
    </CommunicationField>
  )
}

function HeaderFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 text-text-muted">{label}：</span>
      <span className="truncate font-semibold text-text-main">{value}</span>
    </div>
  )
}

function AttachmentSection({ items }: { items: OrderAttachment[] }): React.JSX.Element {
  const [preview, setPreview] = useState<OrderAttachment | null>(null)
  const [open, setOpen] = useState(true)
  const groups = groupAttachments(items)
  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface-bg"
        aria-expanded={open}
      >
        <h3 className="text-[16px] font-bold text-text-main">附件信息</h3>
        <span className={'material-symbols-outlined text-text-muted transition-transform ' + (open ? 'rotate-180' : '')}>
          expand_more
        </span>
      </button>
      {open && (items.length === 0 ? (
        <div className="border-t border-border-subtle px-4 py-5 text-body-sm text-text-muted">—</div>
      ) : (
        <div className="space-y-5 border-t border-border-subtle px-4 py-4">
          {groups.map((group) => (
            <div key={group.fileType}>
              <div className="mb-2 text-body-sm text-text-muted">
                <span className="font-semibold text-text-main">{fileTypeLabel(group.fileType)}</span>
                <span className="ml-1.5">（{group.items.length} 张）</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
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
      ))}
      {preview && (
        <ImagePreviewOverlay src={preview.url} alt={preview.fileName} onClose={() => setPreview(null)} />
      )}
    </section>
  )
}

function ImagePreviewOverlay({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }): React.JSX.Element {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setDragging(false)
    dragRef.current = null
  }, [src])

  const zoom = (next: number): void => {
    const clamped = Math.min(5, Math.max(0.5, next))
    setScale(clamped)
    if (clamped <= 1) setOffset({ x: 0, y: 0 })
  }

  const reset = (): void => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-white/10 bg-black/45 px-2 py-1.5 text-white shadow-lg backdrop-blur"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            zoom(scale - 0.25)
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-white/15"
          title="缩小"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>remove</span>
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            reset()
          }}
          className="min-w-14 rounded px-2 py-1 text-[12px] font-mono-data hover:bg-white/15"
          title="恢复原始大小"
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            zoom(scale + 0.25)
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-white/15"
          title="放大"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add</span>
        </button>
      </div>
      <div
        className="relative h-full w-full overflow-hidden"
        onWheel={(event) => {
          event.preventDefault()
          zoom(scale + (event.deltaY < 0 ? 0.15 : -0.15))
        }}
        onPointerMove={(event) => {
          if (!dragging || !dragRef.current) return
          setOffset({
            x: dragRef.current.ox + event.clientX - dragRef.current.x,
            y: dragRef.current.oy + event.clientY - dragRef.current.y
          })
        }}
        onPointerUp={() => {
          setDragging(false)
          dragRef.current = null
        }}
        onPointerLeave={() => {
          setDragging(false)
          dragRef.current = null
        }}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute -right-3 -top-3 h-8 w-8 rounded-full bg-white text-text-main shadow flex items-center justify-center"
          title="关闭"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
        </button>
        <img
          src={src}
          alt={alt}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={reset}
          onPointerDown={(event) => {
            if (scale <= 1) return
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
            setDragging(true)
          }}
          className={
            'absolute left-1/2 top-1/2 max-h-[86vh] max-w-[92vw] rounded-lg bg-white object-contain select-none shadow-2xl ' +
            (scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in')
          }
          style={{
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
            transformOrigin: 'center center',
            transition: dragging ? 'none' : 'transform 120ms ease-out'
          }}
        />
      </div>
    </div>
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
    '40': '身份证信息（身份证附件）',
    '41': '社保卡信息（社保卡附件）',
    '5000': '病历信息（病历附件）',
    '5001': '其他附件信息',
    '5002': '补充资料',
    '100': '影像资料',
    '99': '历史资料',
    '5010': '服务结果',
    '5008': '回填资料',
    '5009': '过程资料'
  }
  return labels[type] ?? `类型 ${type}`
}

function CopyText({
  value,
  className,
  children
}: {
  value: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={`复制 ${value}`}
      onClick={(event) => {
        event.stopPropagation()
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      className={'inline-flex items-center gap-1 text-left hover:text-trust-blue transition-colors ' + (className || '')}
    >
      {children}
      <span className={'material-symbols-outlined shrink-0 ' + (copied ? 'text-action-green' : 'text-text-muted')} style={{ fontSize: '13px' }}>
        {copied ? 'check' : 'content_copy'}
      </span>
    </button>
  )
}

function ApplicationNoCopyButtons({
  applicationNo,
  customerName,
  className
}: {
  applicationNo: string | null
  customerName: string
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState<string | null>(null)
  const tail = tail8(applicationNo)

  const copy = (value: string): void => {
    void navigator.clipboard?.writeText(value)
    setCopied(value)
    setTimeout(() => setCopied(null), 1200)
  }

  if (!applicationNo) return <span className={'text-text-muted ' + (className || '')}>申请号: —</span>

  return (
    <div className={'inline-flex items-center gap-1 min-w-0 ' + (className || '')}>
      <span className="truncate">申请号: {applicationNo}</span>
      <SmallCopyButton
        icon="content_copy"
        title={`复制完整申请号 ${applicationNo}`}
        copied={copied === applicationNo}
        onClick={() => copy(applicationNo)}
      />
      {tail && (
        <SmallCopyButton
          icon="tag"
          title={`复制 ${customerName}#${tail}`}
          copied={copied === `${customerName}#${tail}`}
          onClick={() => copy(`${customerName}#${tail}`)}
        />
      )}
    </div>
  )
}

function SmallCopyButton({
  icon,
  title,
  copied,
  onClick
}: {
  icon: 'content_copy' | 'tag'
  title: string
  copied: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded border border-border-subtle bg-white text-[#6f7f95] hover:border-primary-fixed-dim hover:bg-primary-fixed hover:text-primary"
    >
      {copied ? (
        <span className="material-symbols-outlined text-action-green" style={{ fontSize: '12px' }}>check</span>
      ) : icon === 'tag' ? (
        <span className="text-[11px] leading-none font-black">#</span>
      ) : (
        <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>content_copy</span>
      )}
    </button>
  )
}

function EmptyText({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border-subtle bg-surface-bg px-3 py-6 text-center text-body-sm text-text-muted">
      {children}
    </div>
  )
}

function dedupeServices(orders: Order[]): Array<{ label: string; count: number; order: Order }> {
  const map = new Map<string, { label: string; count: number; order: Order }>()
  for (const order of orders) {
    const label = bizType(order)
    const existing = map.get(label)
    if (existing) existing.count += 1
    else map.set(label, { label, count: 1, order })
  }
  return [...map.values()]
}

function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed ? trimmed[0] : '?'
}

function pick(rec: Record<string, unknown>, raw: Record<string, unknown>, keys: string[], fallback?: unknown): string {
  for (const key of keys) {
    const recValue = normalizeValue(rec[key])
    if (recValue) return recValue
    const rawValue = normalizeValue(raw[key])
    if (rawValue) return rawValue
  }
  return normalizeValue(fallback)
}

function pickPreferUnmasked(rec: Record<string, unknown>, raw: Record<string, unknown>, keys: string[], fallback?: unknown): string {
  const candidates: string[] = []
  for (const key of keys) {
    candidates.push(normalizeValue(rec[key]), normalizeValue(raw[key]))
  }
  const unmasked = candidates.find((value) => value && !value.includes('*'))
  if (unmasked) return unmasked
  return candidates.find(Boolean) || normalizeValue(fallback)
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function joinValues(...values: string[]): string {
  return values.map((value) => value.trim()).filter(Boolean).join(' / ')
}

function formatYesNo(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  if (raw === '1' || raw === 'true' || raw === '是') return '是'
  if (raw === '0' || raw === 'false' || raw === '否') return '否'
  return raw
}

function formatDateTime(value: string | null): string {
  if (!value || value === '—') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN')
}

function formatShortDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const now = new Date()
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`
  return `${date.getMonth() + 1}-${date.getDate()} ${time}`
}

function sortMessages(messages: OrderMessage[]): OrderMessage[] {
  return [...messages].sort((a, b) => messageTime(a) - messageTime(b))
}

function sortCalls(calls: OrderCall[]): OrderCall[] {
  return [...calls].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
}

function messageTime(message: OrderMessage): number {
  const value = message.sortTime || message.chatTime || message.capturedAt
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

function formatDuration(seconds: number | null | undefined): string {
  const total = Number(seconds ?? 0)
  if (!Number.isFinite(total) || total <= 0) return '0秒'
  const minutes = Math.floor(total / 60)
  const secs = Math.floor(total % 60)
  if (minutes <= 0) return `${secs}秒`
  return `${minutes}分${secs.toString().padStart(2, '0')}秒`
}

function formatAudioClock(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(seconds ?? 0)))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

function mediaErrorLabel(audio: HTMLAudioElement | null): string {
  const code = audio?.error?.code
  if (code === MediaError.MEDIA_ERR_ABORTED) return '音频加载被中断'
  if (code === MediaError.MEDIA_ERR_NETWORK) return '音频网络加载失败'
  if (code === MediaError.MEDIA_ERR_DECODE) return '音频解码失败'
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return '音频地址或格式不受支持'
  return '音频文件无法播放'
}

function audioUrlHost(value: string): string {
  try {
    const url = new URL(value)
    return url.host
  } catch {
    return '未知地址'
  }
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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const value = String(reader.result)
      resolve(value.includes(',') ? value.split(',')[1] : value)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
