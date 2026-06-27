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
  refreshApplicationBrief,
  refreshOrderBrief,
  type Material,
  type Order,
  type OrderAggregateResponse,
  type OrderAttachment,
  type OrderBrief,
  type OrderCall,
  type CallRecordingUrl,
  type OrderDetailResponse,
  type OrderMessage,
} from '../api'
import { bizChipClass, bizType, LIFECYCLE_STAGES, sourceStyle, stageIndexOf } from '../lib/orderMapping'
import type { ApplicationGroup } from './WorkbenchKanban'

type RightTab = 'detail' | 'entry' | 'ai'
type CaptureTab = 'wxwork' | 'wechat' | 'call'

const CAPTURE_TABS: Array<{ key: CaptureTab; label: string; icon: string; iconColor: string }> = [
  { key: 'wxwork', label: '企微', icon: 'groups', iconColor: 'text-[#2e7bff]' },
  { key: 'wechat', label: '微信', icon: 'chat', iconColor: 'text-[#07c160]' },
  { key: 'call', label: '通话录音', icon: 'call', iconColor: 'text-[#00a3a3]' }
]

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
  onBack
}: {
  group: ApplicationGroup
  onBack: () => void
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState(group.orders[0]?.id ?? 0)
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
      <header className="shrink-0 bg-white border-b border-border-subtle px-5 py-2 z-20">
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
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 flex overflow-hidden">
        <ApplicationIntake order={group.primary} applicationNo={applicationNo} />
        {selectedOrder ? (
          <OrderExecutionPanel
            orders={group.orders}
            selectedOrder={selectedOrder}
            onSelect={setSelectedId}
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
        setError(e instanceof Error ? e.message : '加载申领号聚合信息失败')
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
  onSelect
}: {
  orders: Order[]
  selectedOrder: Order
  onSelect: (id: number) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<RightTab>('detail')
  const [detailResp, setDetailResp] = useState<OrderDetailResponse | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [aggregate, setAggregate] = useState<OrderAggregateResponse | null>(null)
  const [materials, setMaterials] = useState<Material[]>([])
  const selectedIndex = Math.max(0, orders.findIndex((order) => order.id === selectedOrder.id))

  const reloadMaterials = useCallback(() => {
    return fetchMaterials(selectedOrder.id).then(setMaterials)
  }, [selectedOrder.id])

  useEffect(() => {
    let alive = true
    setDetailResp(null)
    setDetailError(null)
    fetchOrderDetail(selectedOrder.id)
      .then((resp) => alive && setDetailResp(resp))
      .catch((e) => alive && setDetailError(e instanceof Error ? e.message : '加载订单详情失败'))
    fetchOrderAggregate(selectedOrder.id)
      .then((resp) => alive && setAggregate(resp))
      .catch(() => alive && setAggregate(null))
    reloadMaterials().catch(() => undefined)
    return () => {
      alive = false
    }
  }, [selectedOrder.id, reloadMaterials])

  return (
    <aside className="w-[40%] min-h-0 bg-white border-l border-border-subtle flex flex-col">
      <div className="shrink-0 border-b border-border-subtle bg-[#fafafa] p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 rounded border border-border-subtle bg-white px-2 py-1 text-[11px] font-bold text-text-main">
            <span className="material-symbols-outlined text-primary" style={{ fontSize: '14px' }}>inventory_2</span>
            {orders.length} 个订单
          </span>
          <select
            value={selectedOrder.id}
            onChange={(event) => onSelect(Number(event.target.value))}
            className="h-7 rounded-sm border border-border-subtle bg-surface-container-high px-2 text-[11px] text-text-main focus:outline-none focus:border-primary"
          >
            {orders.map((order, index) => (
              <option key={order.id} value={order.id}>
                第 {index + 1}/{orders.length} 个 · {bizType(order)}
              </option>
            ))}
          </select>
        </div>
        <div className="bg-white border-l-2 border-primary border-y border-r border-border-subtle p-3 rounded-r shadow-sm">
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
        <PanelTab label="订单详情" active={tab === 'detail'} onClick={() => setTab('detail')} />
        <PanelTab label="数据补录" active={tab === 'entry'} onClick={() => setTab('entry')} />
        <PanelTab label="AI 任务" active={tab === 'ai'} onClick={() => setTab('ai')} />
      </div>
      {tab === 'detail' && (
        <OrderDetailPanel order={selectedOrder} detailResp={detailResp} error={detailError} />
      )}
      {tab === 'entry' && (
        <OrderDataEntryPanel order={selectedOrder} materials={materials} onReload={reloadMaterials} />
      )}
      {tab === 'ai' && (
        <OrderAiTaskPanel order={selectedOrder} aggregate={aggregate} />
      )}
      <div className="shrink-0 border-t border-border-subtle bg-white p-4 flex justify-end gap-3 shadow-[0_-4px_12px_rgba(0,0,0,0.02)]">
        <button disabled className="px-4 py-2 bg-surface-container border border-border-subtle text-text-main text-body-sm font-bold rounded opacity-70">
          Hold Order
        </button>
        <button disabled className="px-4 py-2 bg-primary text-white text-body-sm font-bold rounded inline-flex items-center gap-2 opacity-70">
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>check_circle</span>
          Complete & Next
        </button>
      </div>
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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      {error && <div className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">{error}</div>}
      <div className="rounded-lg border border-border-subtle bg-surface-bg px-3 py-2.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-body-sm font-semibold text-text-main truncate">{order.customerName}</div>
          <CopyText value={order.sourceOrderNo} className="mt-1 text-[11px] text-text-muted font-mono-data max-w-full">
            <span className="truncate">{order.sourceOrderNo}</span>
          </CopyText>
        </div>
        <span className="shrink-0 rounded-md border border-border-subtle bg-white px-2 py-1 text-[11px] text-text-muted">
          {detailResp?.order.detailFetchedAt ? '详情已抓取' : '列表数据'}
        </span>
      </div>
      {groups.map((group) => (
        <DetailGroup key={group.title} title={group.title} rows={group.rows} />
      ))}
      <AttachmentSection items={attachments} />
    </div>
  )
}

function CompactLifecycleTimeline({ order }: { order: Order }): React.JSX.Element {
  const stage = stageIndexOf(order)
  const shortLabels = ['申领', '需求', '交付', '回填', '结束']

  return (
    <div className="relative mt-3 w-full px-1" title={`${bizType(order)} 生命周期 · ${order.status || LIFECYCLE_STAGES[stage]}`}>
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
            <div className="flex min-w-0 flex-col items-center gap-1">
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
        "flex-1 py-3 text-[13px] border-b-2 transition-colors whitespace-nowrap font-['Noto_Sans_SC'] font-black tracking-wide " +
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
      title: '基础信息',
      rows: [
        detailRow('泰康订单号', pick(rec, raw, ['subOrderNo', 'orderId'], order.sourceOrderNo), true),
        detailRow('申请号', pick(rec, raw, ['crmApplyNo']), true),
        detailRow('CCOD 号', pick(rec, raw, ['applyNo']), true),
        detailRow('就诊人', pick(rec, raw, ['patientName'], order.customerName)),
        detailRow('性别', pick(rec, raw, ['sex'])),
        detailRow('生日', pick(rec, raw, ['birthday'])),
        detailRow('证件类型', pick(rec, raw, ['cardType'])),
        detailRow('证件号码', cardId, true),
        detailRow('联系电话', pick(rec, raw, ['paMobile', 'patientMobile', 'patientPhone'], order.customerPhone), true),
        detailRow('客户等级', pick(rec, raw, ['cusLevel'])),
        detailRow('客户关系', pick(rec, raw, ['relationship'])),
        detailRow('是否医保', formatYesNo(pick(rec, raw, ['isSocSec']))),
        detailRow('医保城市', pick(rec, raw, ['medLoc'])),
        detailRow('社保卡号', socSecNo, true)
      ]
    },
    {
      title: '投保 / 联系人',
      rows: [
        detailRow('投保人', pick(rec, raw, ['insurName'])),
        detailRow('保单号', pickPreferUnmasked(rec, raw, ['insurNo']), true),
        detailRow('保单机构', pick(rec, raw, ['insurBrhName'])),
        detailRow('联系人姓名', pick(rec, raw, ['ecpName'])),
        detailRow('联系人手机号', pick(rec, raw, ['ecpPhone']), true),
        detailRow('第二联系人', pick(rec, raw, ['secEcpName'])),
        detailRow('第二联系人手机号', pick(rec, raw, ['secEcpPhone']), true),
        detailRow('与投保人关系', pick(rec, raw, ['patEcpRelationship']))
      ]
    },
    {
      title: '就诊意向',
      rows: [
        detailRow('意向医院', pick(rec, raw, ['intendHos', 'hospital'], order.hospital)),
        detailRow('意向城市', joinValues(pick(rec, raw, ['intendProvince']), pick(rec, raw, ['intendCity']))),
        detailRow('意向科室', pick(rec, raw, ['intendDept', 'dept'], order.dept)),
        detailRow('意向医生', pick(rec, raw, ['intendDoc', 'doctor'], order.doctor)),
        detailRow('医生职称', pick(rec, raw, ['intendDocTitle'])),
        detailRow('就诊日期', joinValues(pick(rec, raw, ['intendDate'], order.intendDate), pick(rec, raw, ['intendDateAmorpm']))),
        detailRow('出险时间', pick(rec, raw, ['acciTime'])),
        detailRow('疑似疾病', pick(rec, raw, ['suspectDisease'])),
        detailRow('确诊情况', pick(rec, raw, ['approveDetail'])),
        detailRow('确诊详情', pick(rec, raw, ['approveDiseaseDesc'])),
        detailRow('审核疾病', pick(rec, raw, ['approveDiseaseName']))
      ]
    },
    {
      title: '服务 / 产品',
      rows: [
        detailRow('业务类型', bizType(order)),
        detailRow('服务项', pick(rec, raw, ['serviceItemName', 'serviceName', 'serviceType', 'itemName'])),
        detailRow('服务医院', pick(rec, raw, ['visitingHospital'])),
        detailRow('服务城市', joinValues(pick(rec, raw, ['visitingProvince']), pick(rec, raw, ['visitingCity']))),
        detailRow('出发地', pick(rec, raw, ['departureAddress'])),
        detailRow('服务详址', pick(rec, raw, ['visitingHospitalDetailAddress'])),
        detailRow('子方案', pick(rec, raw, ['subPlanName'])),
        detailRow('套餐', pick(rec, raw, ['packetName'])),
        detailRow('方案', pick(rec, raw, ['planName'])),
        detailRow('产品', pick(rec, raw, ['productName'])),
        detailRow('标签', pick(rec, raw, ['labelName', 'networkTag']))
      ]
    },
    {
      title: '流程 / 状态',
      rows: [
        detailRow('订单状态', pick(rec, raw, ['orderStateName', 'status'], order.status)),
        detailRow('状态码', pick(rec, raw, ['orderState'], order.orderState), true),
        detailRow('当前阶段', pick(rec, raw, ['stageName'])),
        detailRow('服务状态', pick(rec, raw, ['servStateName'])),
        detailRow('申请方式', pick(rec, raw, ['applyWayDesc'])),
        detailRow('申请时间', pick(rec, raw, ['applicationDate', 'applyTime', 'applyDate'])),
        detailRow('受理时间', pick(rec, raw, ['mmgrApplyDate'])),
        detailRow('服务开始', pick(rec, raw, ['startDate'])),
        detailRow('预计出院', pick(rec, raw, ['estimateOutHospitalDate'])),
        detailRow('备注信息', pick(rec, raw, ['comments', 'comment'])),
        detailRow('审核意见', pick(rec, raw, ['reviewerResult'])),
        detailRow('申领时间', order.claimedAt),
        detailRow('更新时间', order.updatedAt)
      ]
    }
  ].map((group) => ({
    ...group,
    rows: group.rows.filter((row) => row.value)
  })).filter((group) => group.rows.length > 0)
}

function detailRow(label: string, value: unknown, mono = false): DetailRowData {
  return { label, value: normalizeValue(value), mono }
}

function DetailGroup({ title, rows }: { title: string; rows: DetailRowData[] }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border-subtle bg-white p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-primary" />
        <h3 className="text-label-caps text-text-muted">{title}</h3>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {rows.map((row) => (
          <DetailRow key={row.label} row={row} />
        ))}
      </div>
    </section>
  )
}

function DetailRow({ row }: { row: DetailRowData }): React.JSX.Element {
  return (
    <div className="min-w-0 border-b border-border-subtle/70 pb-1.5">
      <div className="text-[11px] text-text-muted truncate">{row.label}</div>
      {row.value ? (
        <CopyText value={row.value} className={'mt-0.5 max-w-full text-body-sm text-text-main ' + (row.mono ? 'font-mono-data' : '')}>
          <span className="break-words">{row.value}</span>
        </CopyText>
      ) : (
        <div className="mt-0.5 text-body-sm text-text-muted">—</div>
      )}
    </div>
  )
}

function AttachmentSection({ items }: { items: OrderAttachment[] }): React.JSX.Element {
  const [preview, setPreview] = useState<OrderAttachment | null>(null)
  const groups = groupAttachments(items)
  return (
    <section className="rounded-lg border border-border-subtle bg-white p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-ai-purple" />
        <h3 className="text-label-caps text-text-muted">附件（{items.length}）</h3>
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle bg-surface-bg px-3 py-6 text-center text-body-sm text-text-muted">
          该订单暂无证件或附件
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
