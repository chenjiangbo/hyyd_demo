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
  type OrderBrief,
  type OrderCall,
  type OrderDetailResponse,
  type OrderMessage,
} from '../api'
import { bizChipClass, bizType, LIFECYCLE_STAGES, sourceStyle, stageIndexOf } from '../lib/orderMapping'
import type { ApplicationGroup } from './WorkbenchKanban'

type RightTab = 'detail' | 'life' | 'ai' | 'refs' | 'entry'
type CaptureTab = 'wxwork' | 'wechat' | 'call'

const CAPTURE_TABS: Array<{ key: CaptureTab; label: string; icon: string; iconColor: string }> = [
  { key: 'wxwork', label: '企微', icon: 'groups', iconColor: 'text-[#2e7bff]' },
  { key: 'wechat', label: '微信', icon: 'chat', iconColor: 'text-[#07c160]' },
  { key: 'call', label: '通话录音', icon: 'call', iconColor: 'text-[#00a3a3]' }
]

export default function ApplicationDetailPage({
  group,
  onBack
}: {
  group: ApplicationGroup
  onBack: () => void
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState(group.orders[0]?.id ?? 0)
  const selectedOrder = group.orders.find((order) => order.id === selectedId) ?? group.orders[0]
  const applicationNo = group.applicationNo ?? group.primary.sourceOrderNo
  const services = useMemo(() => dedupeServices(group.orders), [group.orders])
  const hospital = group.orders.find((order) => order.hospital)?.hospital ?? null
  const phone = group.orders.find((order) => order.customerPhone)?.customerPhone ?? null
  const src = sourceStyle(group.primary)

  return (
    <div className="h-full flex flex-col bg-surface-bg text-text-main overflow-hidden">
      <header className="shrink-0 bg-white border-b border-border-subtle px-6 py-4 shadow-sm z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="p-2 rounded-full hover:bg-surface-container-low text-text-muted hover:text-text-main transition-colors"
            title="返回"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>arrow_back</span>
          </button>
          <div className="min-w-0 flex-1">
            <nav className="flex items-center text-body-sm text-text-muted gap-1.5 min-w-0">
              <button onClick={onBack} className="hover:text-primary transition-colors">工作台</button>
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>chevron_right</span>
              <CopyText value={applicationNo} className="text-text-main font-semibold font-mono-data min-w-0">
                <span className="truncate">{applicationNo}</span>
              </CopyText>
            </nav>
            <div className="mt-2 flex items-center gap-3 min-w-0">
              <h1 className="text-h2-header truncate">{group.customerName}</h1>
              <span className={'shrink-0 inline-flex items-center gap-0.5 text-body-sm font-medium ' + src.text}>
                <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>verified</span>
                {src.label}
              </span>
              <span className="shrink-0 text-body-sm text-text-muted">{group.orders.length} 个订单</span>
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-[180px_1fr_1fr_2fr] gap-2">
          <TopInfo label="手机号" value={phone} mono />
          <TopInfo label="医院" value={hospital} />
          <TopInfo label="科室" value={group.orders.find((order) => order.dept)?.dept ?? null} />
          <div className="rounded-lg border border-border-subtle bg-surface-bg px-3 py-2 min-w-0">
            <div className="text-[11px] text-text-muted mb-1">服务类型</div>
            <div className="flex flex-wrap gap-1">
              {services.map((service) => (
                <span key={service.label} className={'text-label-caps px-2 py-0.5 rounded ' + bizChipClass(service.order)}>
                  {service.label}{service.count > 1 ? ` x${service.count}` : ''}
                </span>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 grid grid-cols-[minmax(420px,1fr)_minmax(520px,640px)] overflow-hidden">
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
  const latestMessage = newestMessage(messages)
  const latestCall = newestCall(calls)

  return (
    <section className="min-h-0 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-h2-header">申领号信息汇聚</h2>
            <p className="mt-1 text-body-sm text-text-muted font-mono-data">{applicationNo}</p>
          </div>
          <div className="flex gap-2">
            <CountBadge icon="forum" label="消息" count={messages.length} />
            <CountBadge icon="call" label="通话" count={calls.length} />
          </div>
        </div>

        {error && <div className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">{error}</div>}

        <section className="rounded-lg border border-border-subtle bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-h3-title">采集概览</h3>
            <span className="text-label-caps text-text-muted">申请级</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <SummaryMetric label="最近消息" value={latestMessage?.sortTime || latestMessage?.capturedAt || '—'} />
            <SummaryMetric label="最近通话" value={latestCall?.startedAt || '—'} />
            <SummaryMetric label="待拆解订单" value={`${order.customerName} / ${bizType(order)}`} />
          </div>
        </section>

        <ApplicationCapturePanel messages={messages} calls={calls} />
        <ApplicationAiSummaryCard
          applicationNo={applicationNo}
          messageCount={messages.length}
          callCount={calls.length}
        />
      </div>
    </section>
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
    <section className="rounded-lg border border-border-subtle bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-3">
        <h3 className="text-h3-title">具体信息采集</h3>
        <span className="text-label-caps text-text-muted">按渠道分开查看</span>
      </div>
      <div className="flex border-b border-border-subtle bg-white overflow-x-auto">
        {CAPTURE_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActive(tab.key)}
            className={
              'flex-1 min-w-[110px] px-3 py-2.5 text-body-sm border-b-2 transition-colors inline-flex items-center justify-center gap-1.5 ' +
              (active === tab.key
                ? 'border-primary text-primary font-semibold bg-primary-container/10'
                : 'border-transparent text-text-muted hover:bg-surface-container-low')
            }
          >
            <span className={'material-symbols-outlined ' + tab.iconColor} style={{ fontSize: '16px' }}>{tab.icon}</span>
            {tab.label}
            <span className="text-[11px] text-text-muted font-mono-data">{counts[tab.key]}</span>
          </button>
        ))}
      </div>

      <div className={'h-[520px] overflow-y-auto px-4 py-4 ' + backgroundClass}>
        {active === 'call' ? (
          channelCalls.length === 0 ? (
            <div className="h-full flex items-center justify-center text-body-sm text-text-muted/70">暂无通话录音</div>
          ) : (
            <div className="space-y-3">
              {channelCalls.map((call) => <ApplicationCallCard key={call.id} call={call} />)}
            </div>
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

function ApplicationCallCard({ call }: { call: OrderCall }): React.JSX.Element {
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const hasRecording = !!call.recordingOssKey

  useEffect(() => {
    if (!hasRecording) return
    let alive = true
    fetchCallRecordingUrl(call.id)
      .then((resp) => {
        if (alive) setRecordingUrl(resp.url)
      })
      .catch(() => {
        if (alive) setRecordingUrl(null)
      })
    return () => {
      alive = false
    }
  }, [call.id, hasRecording])

  const answered = call.callStatus === 'answered'

  return (
    <div className="rounded-lg border border-border-subtle bg-white px-3 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-2">
          <span className={'material-symbols-outlined shrink-0 mt-0.5 ' + (answered ? 'text-trust-blue' : 'text-warning')} style={{ fontSize: '18px' }}>
            {call.direction === 'out' || call.direction === 'outbound' ? 'call_made' : 'call_received'}
          </span>
          <div className="min-w-0">
            <div className="text-body-sm font-semibold text-text-main truncate">{callTitle(call)}</div>
            <div className="mt-0.5 text-[11px] text-text-muted">
              {formatDateTime(call.startedAt)} · {formatDuration(call.durationSec)}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-[11px] text-text-muted">
          {hasRecording ? '有录音' : '无录音'} · {asrStatusLabel(call.asrStatus)}
        </div>
      </div>

      {hasRecording && recordingUrl && (
        <audio controls preload="metadata" controlsList="nodownload" className="mt-2 w-full h-9">
          <source src={recordingUrl} />
        </audio>
      )}

      {call.asrText ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-primary select-none">查看转写文本</summary>
          <p className="mt-1 max-h-40 overflow-y-auto text-body-sm text-text-muted whitespace-pre-wrap break-words">
            {call.asrText}
          </p>
        </details>
      ) : (
        <div className="mt-2 text-[11px] text-text-muted">暂无转写</div>
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
    <section className="rounded-lg border border-ai-purple/25 bg-ai-purple/5 overflow-hidden">
      <div className="px-4 py-3 border-b border-ai-purple/15 flex items-center gap-2">
        <span className="material-symbols-outlined text-ai-purple" style={{ fontSize: '18px' }}>smart_toy</span>
        <div className="min-w-0">
          <h3 className="text-h3-title text-text-main">AI 沟通总结</h3>
          <p className="mt-0.5 text-[11px] text-text-muted">综合企微、微信消息和通话录音转写</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="ml-auto px-3 py-1.5 rounded-lg bg-ai-purple text-white text-body-sm font-semibold disabled:opacity-50"
        >
          {busy ? '生成中' : '刷新'}
        </button>
      </div>

      <div className="p-4 space-y-3">
        {error && <div className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">{error}</div>}
        {brief?.summary ? (
          <>
            <section className="rounded-lg border border-ai-purple/15 bg-white/80 p-3">
              <div className="text-label-caps text-text-muted">摘要</div>
              <p className="mt-1 text-body-sm text-text-main leading-relaxed whitespace-pre-wrap">{brief.summary}</p>
              {brief.stage && (
                <div className="mt-2 text-body-sm text-text-main">
                  <span className="text-text-muted">当前阶段：</span>{brief.stage}
                  {brief.stageEvidence ? <span className="text-text-muted">（{brief.stageEvidence}）</span> : null}
                </div>
              )}
              {updatedAt && (
                <div className="mt-2 text-[11px] text-text-muted">
                  更新于 {formatDateTime(updatedAt)}{brief.model ? ` · ${brief.model}` : ''}
                </div>
              )}
            </section>
            <InfoList title="下一步" items={brief.nextActions} />
            <InfoList title="风险" items={brief.risks} />
            {Object.values(brief.keyInfo || {}).some((value) => !!value) && (
              <section className="rounded-lg border border-border-subtle bg-white p-3">
                <div className="text-label-caps text-text-muted mb-2">关键信息</div>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(brief.keyInfo || {}).filter(([, value]) => !!value).map(([key, value]) => (
                    <DetailRow key={key} row={detailRow(key, value || '')} />
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="rounded-lg border border-dashed border-ai-purple/25 bg-white/60 px-3 py-5 text-body-sm text-text-muted">
            暂无 AI 总结。当前已采集消息 {messageCount} 条、通话 {callCount} 条；点击“刷新”会按申领号综合生成。
          </div>
        )}
      </div>
    </section>
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
    <aside className="min-h-0 bg-white border-l border-border-subtle flex flex-col shadow-[-4px_0_12px_rgba(0,0,0,0.03)]">
      <div className="shrink-0 border-b border-border-subtle px-4 pt-4">
        <div className="flex gap-2 overflow-x-auto pb-3">
          {orders.map((order) => (
            <button
              key={order.id}
              onClick={() => onSelect(order.id)}
              className={
                'shrink-0 rounded-lg border px-3 py-2 text-left transition-colors min-w-[132px] ' +
                (order.id === selectedOrder.id
                  ? 'border-primary bg-primary-container/15'
                  : 'border-border-subtle bg-surface-bg hover:bg-surface-container-low')
              }
            >
              <div className={'inline-flex text-label-caps px-2 py-0.5 rounded ' + bizChipClass(order)}>{bizType(order)}</div>
              <div className="mt-1 text-[11px] text-text-muted font-mono-data truncate">{order.sourceOrderNo}</div>
            </button>
          ))}
        </div>
        <div className="flex border-t border-border-subtle">
          <PanelTab label="订单详情" active={tab === 'detail'} onClick={() => setTab('detail')} />
          <PanelTab label="生命周期" active={tab === 'life'} onClick={() => setTab('life')} />
          <PanelTab label="AI 提取" active={tab === 'ai'} onClick={() => setTab('ai')} />
          <PanelTab label="共享引用" active={tab === 'refs'} onClick={() => setTab('refs')} />
          <PanelTab label="数据补录" active={tab === 'entry'} onClick={() => setTab('entry')} />
        </div>
      </div>

      {tab === 'detail' && <OrderDetailPanel order={selectedOrder} detailResp={detailResp} error={detailError} />}
      {tab === 'life' && <LifecyclePanel order={selectedOrder} />}
      {tab === 'ai' && <AiExtractPanel order={selectedOrder} />}
      {tab === 'refs' && <SharedRefsPanel aggregate={aggregate} />}
      {tab === 'entry' && <OrderDataEntryPanel order={selectedOrder} materials={materials} onReload={reloadMaterials} />}
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
  const rows: DetailRowData[] = [
    detailRow('泰康订单号', pick(rec, raw, ['subOrderNo', 'orderId'], order.sourceOrderNo), true),
    detailRow('申请号', pick(rec, raw, ['crmApplyNo']), true),
    detailRow('CCOD 号', pick(rec, raw, ['applyNo']), true),
    detailRow('就诊人', pick(rec, raw, ['patientName'], order.customerName)),
    detailRow('联系电话', pick(rec, raw, ['paMobile', 'patientMobile', 'patientPhone'], order.customerPhone), true),
    detailRow('意向医院', pick(rec, raw, ['intendHos', 'hospital'], order.hospital)),
    detailRow('意向科室', pick(rec, raw, ['intendDept', 'dept'], order.dept)),
    detailRow('意向医生', pick(rec, raw, ['intendDoc', 'doctor'], order.doctor)),
    detailRow('社保卡号', pick(rec, raw, ['socSecNo']), true),
    detailRow('证件号码', pick(rec, raw, ['cardId']), true),
    detailRow('服务项', pick(rec, raw, ['serviceItemName', 'serviceName', 'serviceType', 'itemName'], bizType(order))),
    detailRow('订单状态', pick(rec, raw, ['orderStateName', 'status'], order.status))
  ].filter((row) => row.value)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      {error && <div className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">{error}</div>}
      <div className="rounded-lg border border-border-subtle bg-surface-bg px-3 py-2">
        <div className="text-body-sm font-semibold text-text-main">{order.customerName}</div>
        <CopyText value={order.sourceOrderNo} className="mt-1 text-[11px] text-text-muted font-mono-data max-w-full">
          <span className="truncate">{order.sourceOrderNo}</span>
        </CopyText>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {rows.map((row) => (
          <DetailRow key={row.label} row={row} />
        ))}
      </div>
    </div>
  )
}

function LifecyclePanel({ order }: { order: Order }): React.JSX.Element {
  const stage = stageIndexOf(order)
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-5">
      <h3 className="text-h3-title mb-4">{bizType(order)} 生命周期</h3>
      <div className="space-y-3">
        {LIFECYCLE_STAGES.map((name, index) => (
          <div key={name} className="flex gap-3">
            <div
              className={
                'mt-0.5 h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-semibold ' +
                (index <= stage ? 'bg-primary text-white' : 'bg-surface-bg text-text-muted border border-border-subtle')
              }
            >
              {index + 1}
            </div>
            <div className="min-w-0 pb-3 border-b border-border-subtle flex-1">
              <div className="text-body-md font-semibold text-text-main">{name}</div>
              <div className="mt-1 text-body-sm text-text-muted">
                {index === stage ? order.status : index < stage ? '已经过' : '未开始'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AiExtractPanel({ order }: { order: Order }): React.JSX.Element {
  const [brief, setBrief] = useState<OrderBrief | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchOrderBrief(order.id)
      .then((resp) => {
        if (!alive) return
        setBrief(resp.brief)
        setUpdatedAt(resp.updatedAt)
        setError(null)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : '加载 AI 信息失败'))
    return () => {
      alive = false
    }
  }, [order.id])

  function refresh(): void {
    setBusy(true)
    setError(null)
    refreshOrderBrief(order.id)
      .then((next) => {
        setBrief(next)
        setUpdatedAt(new Date().toISOString())
      })
      .catch((e) => setError(e instanceof Error ? e.message : '刷新 AI 信息失败'))
      .finally(() => setBusy(false))
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-h3-title">本订单 AI 提取</h3>
        <button
          onClick={refresh}
          disabled={busy}
          className="px-3 py-1.5 rounded-lg bg-ai-purple text-white text-body-sm font-semibold disabled:opacity-50"
        >
          {busy ? '刷新中' : '刷新'}
        </button>
      </div>
      {error && <div className="rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-body-sm text-error">{error}</div>}
      {!brief ? (
        <EmptyText>暂无 AI 提取结果</EmptyText>
      ) : (
        <>
          <section className="rounded-lg border border-border-subtle bg-surface-bg p-3">
            <div className="text-label-caps text-text-muted">摘要</div>
            <p className="mt-1 text-body-sm text-text-main whitespace-pre-wrap">{brief.summary || '—'}</p>
            {updatedAt && <div className="mt-2 text-[11px] text-text-muted">更新于 {formatDateTime(updatedAt)}</div>}
          </section>
          <InfoList title="下一步" items={brief.nextActions} />
          <InfoList title="风险" items={brief.risks} />
          <section className="rounded-lg border border-border-subtle bg-white p-3">
            <div className="text-label-caps text-text-muted mb-2">关键信息</div>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(brief.keyInfo || {}).map(([key, value]) => (
                <DetailRow key={key} row={detailRow(key, value || '')} />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function SharedRefsPanel({ aggregate }: { aggregate: OrderAggregateResponse | null }): React.JSX.Element {
  const messages = aggregate?.messages ?? []
  const calls = aggregate?.calls ?? []
  const latestMessages = [...messages].reverse().slice(0, 8)
  const latestCalls = [...calls].reverse().slice(0, 6)
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
      <section>
        <h3 className="text-h3-title mb-2">共享消息引用</h3>
        {latestMessages.map((message) => (
          <div key={message.id} className="mb-2 rounded-md bg-surface-bg border border-border-subtle px-3 py-2">
            <div className="text-[11px] text-text-muted">{formatDateTime(message.sortTime || message.capturedAt)} · {message.conversationName}</div>
            <p className="mt-1 text-body-sm text-text-main whitespace-pre-wrap break-words">{message.contentText}</p>
          </div>
        ))}
        {messages.length === 0 && <EmptyText>暂无消息引用</EmptyText>}
      </section>
      <section>
        <h3 className="text-h3-title mb-2">共享通话引用</h3>
        {latestCalls.map((call) => (
          <div key={call.id} className="mb-2 rounded-md bg-surface-bg border border-border-subtle px-3 py-2">
            <div className="text-[11px] text-text-muted">{formatDateTime(call.startedAt)} · {call.contactName || call.phone}</div>
            <p className="mt-1 text-body-sm text-text-main whitespace-pre-wrap break-words">{call.asrText || '暂无转写'}</p>
          </div>
        ))}
        {calls.length === 0 && <EmptyText>暂无通话引用</EmptyText>}
      </section>
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
        'flex-1 py-3 text-body-sm border-b-2 transition-colors whitespace-nowrap ' +
        (active ? 'text-primary font-bold border-primary' : 'text-text-muted border-transparent hover:bg-surface-container-low')
      }
    >
      {label}
    </button>
  )
}

function TopInfo({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-bg px-3 py-2 min-w-0">
      <div className="text-[11px] text-text-muted">{label}</div>
      {value ? (
        <CopyText value={value} className={'mt-1 max-w-full text-body-sm font-semibold ' + (mono ? 'font-mono-data' : '')}>
          <span className="truncate">{value}</span>
        </CopyText>
      ) : (
        <div className="mt-1 text-body-sm text-text-muted">—</div>
      )}
    </div>
  )
}

function CountBadge({ icon, label, count }: { icon: string; label: string; count: number }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-subtle bg-white px-3 py-2 text-text-muted">
      <span className="material-symbols-outlined align-[-3px]" style={{ fontSize: '16px' }}>{icon}</span>
      <span className="ml-1 text-body-sm">{label}</span>
      <span className="ml-1 font-mono-data text-text-main">{count}</span>
    </div>
  )
}

function SummaryMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md bg-surface-bg border border-border-subtle px-3 py-2 min-w-0">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="mt-1 text-body-sm text-text-main truncate">{formatDateTime(value)}</div>
    </div>
  )
}

function InfoList({ title, items }: { title: string; items: string[] }): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border-subtle bg-white p-3">
      <div className="text-label-caps text-text-muted mb-2">{title}</div>
      {items.length === 0 ? (
        <EmptyText>暂无</EmptyText>
      ) : (
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li key={`${title}-${index}`} className="text-body-sm text-text-main flex gap-2">
              <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface DetailRowData {
  label: string
  value: string
  mono?: boolean
}

function detailRow(label: string, value: unknown, mono = false): DetailRowData {
  return { label, value: normalizeValue(value), mono }
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

function pick(rec: Record<string, unknown>, raw: Record<string, unknown>, keys: string[], fallback?: unknown): string {
  for (const key of keys) {
    const recValue = normalizeValue(rec[key])
    if (recValue) return recValue
    const rawValue = normalizeValue(raw[key])
    if (rawValue) return rawValue
  }
  return normalizeValue(fallback)
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function formatDateTime(value: string | null): string {
  if (!value || value === '—') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN')
}

function sortMessages(messages: OrderMessage[]): OrderMessage[] {
  return [...messages].sort((a, b) => messageTime(a) - messageTime(b))
}

function sortCalls(calls: OrderCall[]): OrderCall[] {
  return [...calls].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
}

function newestMessage(messages: OrderMessage[]): OrderMessage | null {
  const sorted = sortMessages(messages)
  return sorted[sorted.length - 1] ?? null
}

function newestCall(calls: OrderCall[]): OrderCall | null {
  const sorted = sortCalls(calls)
  return sorted[sorted.length - 1] ?? null
}

function messageTime(message: OrderMessage): number {
  const value = message.sortTime || message.chatTime || message.capturedAt
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
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
