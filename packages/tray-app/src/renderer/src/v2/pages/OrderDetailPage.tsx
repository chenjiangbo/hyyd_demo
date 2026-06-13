import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchMaterials,
  addTextMaterial,
  addImageMaterial,
  deleteMaterial,
  type Material,
  type Order
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
  const stage = stageIndexOf(order)
  const src = sourceStyle(order)
  const lifecycleEvents = useMemo(() => buildLifecycleEvents(materials, captureEvents), [materials, captureEvents])

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
    loadCaptureLifecycleEvents(order)
      .then((events) => {
        if (!alive) return
        setCaptureEvents(events)
        setCaptureError(null)
      })
      .catch((e) => {
        if (!alive) return
        setCaptureEvents([])
        setCaptureError(e instanceof Error ? e.message : '加载沟通采集数据失败')
      })
    return () => {
      alive = false
    }
  }, [order])

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
                  error={STAGE_KEYS[i] === 'communication' ? [materialsError, captureError].filter(Boolean).join('；') || null : null}
                />
              ))}
            </div>
          </div>
        </section>

        {/* 右：订单详情 / 数据补录 / AI 关键信息 */}
        <RightPanel order={order} materials={materials} onReload={reload} />
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

function buildLifecycleEvents(materials: Material[], captureEvents: LifecycleEvent[]): LifecycleEvent[] {
  const events: LifecycleEvent[] = []
  for (const m of materials) {
    events.push({
      id: `material-${m.id}`,
      stage: 'communication',
      kind: m.type === 'image' ? 'image' : 'manual_note',
      title: m.type === 'image' ? '沟通截图 / 图片素材' : '手工补录',
      summary: m.type === 'text' ? m.textContent || '' : undefined,
      occurredAt: m.createdAt,
      imageUrl: m.type === 'image' ? m.url : null
    })
  }
  events.push(...captureEvents)

  return events.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime())
}

async function loadCaptureLifecycleEvents(order: Order): Promise<LifecycleEvent[]> {
  const api = window.api
  if (!api?.getCaptureConversations || !api.getCaptureMessages) return []

  const candidates = orderNoCandidates(order)
  if (candidates.length === 0) return []

  const conversations = await api.getCaptureConversations()
  const matched = conversations.filter((conversation) => {
    const orderNo = normalizeOrderNoForMatch(conversation.orderNo)
    return orderNo ? candidates.includes(orderNo) : false
  })
  if (matched.length === 0) return []

  const events: LifecycleEvent[] = []
  const screenshotUrls = new Map<string, string | null>()
  for (const conversation of matched) {
    const messages = await api.getCaptureMessages(conversation.id)
    for (const message of messages) {
      if (message.sourceScreenshotPath && !screenshotUrls.has(message.sourceScreenshotPath)) {
        const url = api.getCaptureScreenshot
          ? await api.getCaptureScreenshot(message.sourceScreenshotPath)
          : null
        screenshotUrls.set(message.sourceScreenshotPath, url)
        events.push({
          id: `capture-shot-${conversation.id}-${message.sourceScreenshotPath}`,
          stage: 'communication',
          kind: 'image',
          title: `${channelLabel(conversation.channel)}截图`,
          occurredAt: message.firstSeenAt,
          imageUrl: url
        })
      }

      events.push({
        id: `capture-message-${message.id}`,
        stage: 'communication',
        kind: message.senderType === 'system' ? 'status' : 'message',
        title: `${channelLabel(conversation.channel)} · ${senderLabel(message)}`,
        summary: message.content,
        occurredAt: message.firstSeenAt
      })
    }
  }
  return events
}

function orderNoCandidates(order: Order): string[] {
  const raw = order.rawJson ?? {}
  const values = [
    order.sourceOrderNo,
    readRaw(raw, 'sourceOrderNo'),
    readRaw(raw, 'subOrderNo'),
    readRaw(raw, 'applyNo'),
    readRaw(raw, 'crmApplyNo'),
    readRaw(raw, 'orderNo'),
    readRaw(raw, 'orderId')
  ]
  return Array.from(new Set(values.map(normalizeOrderNoForMatch).filter(Boolean)))
}

function normalizeOrderNoForMatch(value: string | null | undefined): string {
  return (value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function channelLabel(channel: string): string {
  return channel === 'wxwork' ? '企微' : channel === 'wechat' ? '微信' : channel
}

function senderLabel(message: CaptureMessage): string {
  if (message.senderName) return message.senderName
  if (message.senderType === 'self') return '自己'
  if (message.senderType === 'other') return '对方'
  if (message.senderType === 'system') return '系统'
  return '未知'
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

        {images.length > 0 && (
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

        {textEvents.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {textEvents.map((event) => (
              <LifecycleEventItem key={event.id} event={event} />
            ))}
          </div>
        )}

        {stageKey === 'communication' && !error && events.length === 0 && (
          <p className="mt-2 text-body-sm text-text-muted/70">暂无沟通素材（粘贴的微信消息、图片、通话录音会在这里）</p>
        )}
      </div>
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
  materials,
  onReload
}: {
  order: Order
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
        <OrderInfoPanel order={order} />
      ) : tab === 'entry' ? (
        <DataEntryPanel order={order} materials={materials} onReload={onReload} />
      ) : (
        <AiPanel />
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

function OrderInfoPanel({ order }: { order: Order }): React.JSX.Element {
  const raw = order.rawJson ?? {}
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: '客户姓名', value: order.customerName },
    { label: '客户手机', value: order.customerPhone || readRaw(raw, 'paMobile') || readRaw(raw, 'ecpPhone') },
    { label: '业务类型', value: bizType(order) },
    { label: '来源', value: sourceStyle(order).label },
    { label: '工单号', value: order.sourceOrderNo },
    { label: '泰康状态', value: order.status },
    { label: '状态码', value: order.orderState || readRaw(raw, 'orderState') || readRaw(raw, 'status') },
    { label: '医院', value: order.hospital || readRaw(raw, 'hospital') },
    { label: '科室', value: order.dept || readRaw(raw, 'dept') },
    { label: '医生', value: order.doctor || readRaw(raw, 'doctor') },
    { label: '期望时间', value: order.intendDate || readRaw(raw, 'intendDate') },
    { label: '申请时间', value: readRaw(raw, 'applyTime') || readRaw(raw, 'applicationDate') },
    { label: '申领时间', value: order.claimedAt },
    { label: '更新时间', value: order.updatedAt }
  ]

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      <div className="grid grid-cols-1 gap-2">
        {rows.map((row) => (
          <DetailRow key={row.label} label={row.label} value={row.value} />
        ))}
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-bg px-3 py-2">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="mt-0.5 text-body-sm text-text-main break-words">{value || '—'}</div>
    </div>
  )
}

function readRaw(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
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

function AiPanel(): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center gap-3 text-text-muted">
      <span className="material-symbols-outlined text-ai-purple" style={{ fontSize: '40px' }}>smart_toy</span>
      <p className="text-h3-title text-text-main">AI 关键信息提取</p>
      <p className="text-body-sm max-w-xs">
        接入 AI 后，这里会自动展示从通话录音、微信消息、图片中提取的关键信息（就诊意向、客户诉求、特殊情况等），供你核对后一键回填。
      </p>
      <span className="mt-2 text-label-caps px-2 py-1 bg-surface-container rounded text-text-muted">待接入</span>
    </div>
  )
}
