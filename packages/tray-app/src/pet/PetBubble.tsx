import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './PetBubble.css'

export interface Candidate {
  orderId: number
  sourceOrderNo: string
  customerName: string
  hospital: string | null
  department: string | null
  appointmentDate: string | null
}

export interface ImageMatchOrder {
  confidence?: number
  orderId: number
  sourceOrderNo: string
  customerName: string
  serviceType: string | null
  hospital: string | null
  department: string | null
  doctor: string | null
  appointmentDate: string | null
  status: string
}

export interface ImageMatchApplication {
  confidence?: number
  applicationNo: string
  programEvidence: string[]
  orders: ImageMatchOrder[]
}

export interface NativeImageMatch {
  source?: 'chat' | 'drop'
  attachmentId?: number
  imageUrl: string
  occurredAt: string
  channel: string
  senderName: string | null
  applicationNo: string | null
  recommendedApplicationNo?: string | null
  recommendedOrderId?: number | null
  imageType?: string
  typeDescription?: string
  description: string
  visibleText?: string
  candidateApplications: ImageMatchApplication[]
  applicationDecision: string
  orderDecision: string
  reason: string
}

export interface PetAction {
  id: string
  label: string
  tone?: 'primary' | 'secondary' | 'danger'
  action?: 'submit' | 'cancel' | 'retry' | 'custom'
  disabled?: boolean
  loading?: boolean
}

export interface PetField {
  id: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'date' | 'datetime-local' | 'select' | 'radio' | 'checkbox'
  value: string | number | boolean
  placeholder?: string
  hint?: string
  required?: boolean
  readOnly?: boolean
  options?: Array<{ value: string; label: string; price?: string }>
  suggestion?: string
  aiPrefill?: boolean
  originalPhone?: string
  copyable?: boolean
  error?: string
  validation?: { rule: 'required' | 'phone' | 'id-card' | 'date'; message: string }
}

export interface PetFormSection {
  id: string
  title: string
  fieldIds: string[]
  repeatable?: boolean
}

interface MasterReviewField {
  id: string
  label: string
  value: string
  options: Array<{ value: string; label: string; parent?: string }>
  source?: { label: string; url: string }
}
interface MasterReviewItem { key: string; type: string; name: string; parent?: string; address?: string; addressSuggestion?: { value: string }; fields: MasterReviewField[] }

export type PetPanel =
  | { kind: 'speech'; text: string; actions?: PetAction[] }
  | { kind: 'progress'; text: string; progress?: number }
  | { kind: 'error'; text: string; actions?: PetAction[] }
  | { kind: 'candidate-list'; title: string; items: Candidate[] }
  | { kind: 'image-match'; match: NativeImageMatch; selectedApplicationNo: string | null }
  | {
      kind: 'form'
      id: string
      title: string
      description?: string
      sections?: PetFormSection[]
      fields: PetField[]
      actions: PetAction[]
      submitState?: 'idle' | 'submitting' | 'success' | 'error'
      confirmation?: { title: string; creations: Array<{ key: string; type: string; name: string; parent?: string }>; review: MasterReviewItem[] }
      submitMessage?: string
      originalService?: string
      originalAmount?: string
      originalStatus?: string
    }

export type PetLookupKind = 'hospital' | 'address' | 'department' | 'doctor' | 'escort'
export interface PetLookupOption { id: string; name: string; phone?: string }
type PetFieldChange = (fieldId: string, value: string, selectedOption?: PetLookupOption) => void

interface PetBubbleProps {
  panel: PetPanel
  skipEntranceAnimation?: boolean
  onAction?: (actionId: string) => void
  onClose?: () => void
  onSelectCandidate?: (orderId: number) => void
  onFieldChange?: PetFieldChange
  onLookup?: (kind: PetLookupKind, query: string, parent: { hospitalId?: string; departmentId?: string; currentId?: string }) => Promise<PetLookupOption[]>
  onSelectApplication?: (applicationNo: string) => void
  onResolveImageOrder?: (applicationNo: string, orderId: number | null) => void
  onDiscardImageMatch?: () => void
  onPickOtherImageOrder?: () => void
  imageMatchError?: string | null
  onSizeChange?: (size: { width: number; height: number }) => void
  onAddEscortRecord?: () => void
  onRemoveEscortRecord?: (sectionId: string) => void
}

function Actions({ actions, onAction }: { actions: PetAction[]; onAction?: (actionId: string) => void }): React.JSX.Element | null {
  if (actions.length === 0) return null
  return (
    <div className="pet-bubble__actions">
      {actions.map((action) => (
        <button key={action.id} className={`pet-bubble__action pet-bubble__action--${action.tone ?? 'secondary'}${action.loading ? ' pet-bubble__action--loading' : ''}`} type="button" disabled={action.disabled || action.loading} onClick={() => onAction?.(action.id)}>
          {action.loading ? '处理中…' : action.label}
        </button>
      ))}
    </div>
  )
}

function SelectField({ field, onFieldChange, showFullValue = false, searchable = false }: { field: PetField; onFieldChange?: PetFieldChange; showFullValue?: boolean; searchable?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [position, setPosition] = useState<React.CSSProperties>({})
  const root = useRef<HTMLDivElement>(null)
  const optionsRoot = useRef<HTMLDivElement>(null)
  const openOptions = (): void => {
    setQuery(null)
    const rect = root.current?.getBoundingClientRect()
    if (!rect) return
    const bounds = root.current?.closest('.pet-bubble--form')?.getBoundingClientRect()
    const top = Math.max(4, bounds?.top ?? 0)
    const bottom = Math.min(window.innerHeight - 4, bounds?.bottom ?? window.innerHeight)
    const below = bottom - rect.bottom - 5
    const above = rect.top - top - 5
    const upward = below < 190 && above > below
    const available = upward ? above : below
    // 空间不足时让菜单覆盖面板内容，避免裁切或改变面板尺寸。
    const overlay = available < 110
    const height = Math.min(190, Math.max(0, bottom - top - 8))
    setPosition(overlay
      ? { position: 'fixed', left: rect.left, width: rect.width, maxHeight: height, top: Math.max(top + 4, Math.min(rect.bottom + 4, bottom - height - 4)) }
      : { position: 'fixed', left: rect.left, width: rect.width, maxHeight: Math.min(190, available), ...(upward ? { top: 'auto', bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) })
    setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => { if (!root.current?.contains(event.target as Node) && !optionsRoot.current?.contains(event.target as Node)) setOpen(false) }
    const closeOnScroll = (event: Event): void => { if (!optionsRoot.current?.contains(event.target as Node)) setOpen(false) }
    const closeOnResize = (): void => setOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', closeOnResize)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('scroll', closeOnScroll, true); window.removeEventListener('resize', closeOnResize) }
  }, [open])
  const selected = field.options?.find((option) => option.value === String(field.value))
  const options = [{ value: '', label: '请选择' }, ...(field.options ?? [])].filter((option) => !query?.trim() || option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <div className="pet-bubble__search-select pet-bubble__choice-select" ref={root}>
    {searchable ? <div className="pet-bubble__editable-select">
      <input id={field.id} name={field.id} role="combobox" aria-label={field.label} aria-autocomplete="list" aria-expanded={open} aria-controls={`${field.id}-options`} placeholder="请选择" value={open && query !== null ? query : (selected?.label ?? String(field.value))} onFocus={(event) => { if (!open) openOptions(); event.currentTarget.select() }} onClick={() => { if (!open) openOptions() }} onChange={(event) => { if (!open) openOptions(); setQuery(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Escape' || event.key === 'Tab') setOpen(false) }} />
      <span className="pet-bubble__select-chevron" aria-hidden="true" />
    </div> : <button type="button" className="pet-bubble__select-trigger" role="combobox" aria-label={field.label} title={showFullValue && field.value ? (selected?.label ?? String(field.value)) : undefined} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${field.id}-options`} onClick={() => { if (open) setOpen(false); else openOptions() }} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
      <span>{selected?.label ?? (String(field.value) || '请选择')}</span><span className="pet-bubble__select-chevron" aria-hidden="true" />
    </button>}
    {open && createPortal(<div ref={optionsRoot} className="pet-bubble__search-options pet-bubble__lookup-portal" style={position} id={`${field.id}-options`} role="listbox" aria-label={field.label}>
      {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={String(field.value) === option.value} onClick={(event) => { event.preventDefault(); setOpen(false); onFieldChange?.(field.id, option.value) }}>{option.label}</button>)}
    </div>, document.body)}
  </div>
}

const TimeWheel = memo(function TimeWheel({ label, value, count, onChange }: { label: string; value: string; count: number; onChange: (value: string) => void }): React.JSX.Element {
  const wheel = useRef<HTMLDivElement>(null)
  const initialValue = useRef(value)
  useEffect(() => {
    if (wheel.current) wheel.current.scrollTop = Number(initialValue.current) * 28
  }, [])
  return <div className="pet-bubble__time-wheel">
    <span>{label}</span>
    <div ref={wheel} role="listbox" aria-label={label} tabIndex={0} onKeyDown={(event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const current = Number(value)
      onChange(String((current + (event.key === 'ArrowUp' ? -1 : 1) + count) % count).padStart(2, '0'))
      if (wheel.current) wheel.current.scrollTop = ((current + (event.key === 'ArrowUp' ? -1 : 1) + count) % count) * 28
    }} onScroll={(event) => {
      const next = Math.max(0, Math.min(count - 1, Math.round(event.currentTarget.scrollTop / 28)))
      if (next !== Number(value)) onChange(String(next).padStart(2, '0'))
    }}>
      <i aria-hidden="true" />
      {Array.from({ length: count }, (_, index) => <button key={index} type="button" role="option" aria-selected={Number(value) === index} className={Number(value) === index ? 'is-selected' : ''} onClick={() => { onChange(String(index).padStart(2, '0')); if (wheel.current) wheel.current.scrollTop = index * 28 }}>{String(index).padStart(2, '0')}</button>)}
      <i aria-hidden="true" />
    </div>
  </div>
})

function DateTimeField({ field, onFieldChange, reserveCopy = false }: { field: PetField; onFieldChange?: PetFieldChange; reserveCopy?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => new Date())
  const [draftDate, setDraftDate] = useState('')
  const [time, setTime] = useState({ hour: '00', minute: '00' })
  const anchor = useRef<HTMLButtonElement>(null)
  const raw = String(field.value)
  const display = raw.replace('T', ' ')
  const pad = (value: number): string => String(value).padStart(2, '0')
  const openPicker = (): void => {
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/)
    const now = new Date()
    setMonth(match ? new Date(Number(match[1]), Number(match[2]) - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1))
    setDraftDate(match ? `${match[1]}-${match[2]}-${match[3]}` : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    setTime(match
      ? { hour: match[4], minute: match[5] }
      : { hour: pad(now.getHours()), minute: pad(now.getMinutes()) })
    setOpen(true)
  }
  const { rect, panelRect } = useMemo(() => ({
    rect: open ? anchor.current?.getBoundingClientRect() : undefined,
    panelRect: open ? anchor.current?.closest('.pet-bubble--form')?.getBoundingClientRect() : undefined
  }), [open])
  const panelBounds = panelRect ?? { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight }
  const pickerWidth = Math.min(286, Math.max(220, panelBounds.width - 16))
  const pickerHeight = Math.min(450, Math.max(220, panelBounds.height - 16))
  const minLeft = panelBounds.left + 8
  const maxLeft = Math.max(minLeft, panelBounds.right - pickerWidth - 8)
  const pickerLeft = Math.max(minLeft, Math.min(rect?.left ?? minLeft, maxLeft))
  const hasRoomBelow = (rect?.bottom ?? panelBounds.top) + pickerHeight <= panelBounds.bottom - 8
  const hasRoomAbove = (rect?.top ?? panelBounds.top) - pickerHeight >= panelBounds.top + 8
  const centeredTop = (rect?.top ?? panelBounds.top) - pickerHeight / 2
  const pickerTop = hasRoomBelow ? (rect?.bottom ?? panelBounds.top) + 4
    : hasRoomAbove ? (rect?.top ?? panelBounds.top) - pickerHeight - 4
      : Math.max(panelBounds.top + 8, Math.min(centeredTop, panelBounds.bottom - pickerHeight - 8))
  const firstDay = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const setHour = useCallback((value: string): void => setTime((current) => current.hour === value ? current : { ...current, hour: value }), [])
  const setMinute = useCallback((value: string): void => setTime((current) => current.minute === value ? current : { ...current, minute: value }), [])
  const apply = (): void => {
    if (!draftDate) return
    const hour = Number(time.hour)
    const minute = Number(time.minute)
    if (hour > 23 || minute > 59) return
    onFieldChange?.(field.id, `${draftDate}T${pad(hour)}:${pad(minute)}:00`)
    setOpen(false)
  }
  return <div className="pet-bubble__input-with-copy">
    <div className="pet-bubble__datetime-input"><input id={field.id} name={field.id} type="text" value={display} placeholder="请选择日期时间" readOnly onPaste={(event) => {
      const text = event.clipboardData.getData('text').trim()
      const match = text.match(/^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})[T\s]+(\d{2}):(\d{2})(?::(\d{2}))?$/)
      if (!match) return
      event.preventDefault()
      const [, year, month, day, hour, minute, seconds = '00'] = match
      const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(seconds))
      if (date.getFullYear() !== Number(year) || date.getMonth() + 1 !== Number(month) || date.getDate() !== Number(day) || date.getHours() !== Number(hour) || date.getMinutes() !== Number(minute) || date.getSeconds() !== Number(seconds)) return
      setOpen(false)
      onFieldChange?.(field.id, `${year}-${month}-${day}T${hour}:${minute}:00`)
    }} aria-label={field.label} aria-invalid={Boolean(field.error)} />
    <button ref={anchor} className="pet-bubble__calendar-icon" type="button" title="选择日期和时间" aria-label={`选择${field.label}`} aria-haspopup="dialog" aria-expanded={open} onClick={openPicker}>▦</button></div>
    {(raw || reserveCopy) && <button type="button" title="复制" disabled={!raw} aria-hidden={!raw} style={!raw ? { visibility: 'hidden' } : undefined} onClick={() => { void navigator.clipboard?.writeText(display) }}>复制</button>}
    {open && createPortal(<>
      <div className="pet-bubble__picker-dismiss" onMouseDown={(event) => { if (event.button === 0) setOpen(false) }} />
      <div className="pet-bubble__datetime-picker" style={{ left: pickerLeft, top: pickerTop, width: pickerWidth, maxHeight: pickerHeight }} role="dialog" aria-label={`选择${field.label}`}>
        <header><button type="button" aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button><strong>{month.getFullYear()} 年 {month.getMonth() + 1} 月</strong><button type="button" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button></header>
        <div className="pet-bubble__calendar-grid">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}{Array.from({ length: firstDay }, (_, index) => <span key={`blank-${index}`} />)}{Array.from({ length: days }, (_, index) => {
          const date = `${month.getFullYear()}-${pad(month.getMonth() + 1)}-${pad(index + 1)}`
          return <button key={date} type="button" className={draftDate === date ? 'is-selected' : ''} onClick={() => setDraftDate(date)}>{index + 1}</button>
        })}</div>
        <div className="pet-bubble__time-wheels"><TimeWheel label="时" value={time.hour} count={24} onChange={setHour} /><TimeWheel label="分" value={time.minute} count={60} onChange={setMinute} /></div>
        <footer><button type="button" onClick={() => { onFieldChange?.(field.id, ''); setOpen(false) }}>清空</button><button type="button" onClick={() => { const now = new Date(); onFieldChange?.(field.id, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`); setOpen(false) }}>现在</button><button type="button" disabled={!draftDate || Number(time.hour) > 23 || Number(time.minute) > 59} onClick={apply}>确定</button></footer>
      </div>
    </>, document.body)}
  </div>
}

function Field({ field, panel, onFieldChange, onLookup }: {
  field: PetField
  panel: Extract<PetPanel, { kind: 'form' }>
  onFieldChange?: PetFieldChange
  onLookup?: PetBubbleProps['onLookup']
}): React.JSX.Element {
  const [lookupOptions, setLookupOptions] = useState<PetLookupOption[]>([])
  const [lookupOpen, setLookupOpen] = useState(false)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupPosition, setLookupPosition] = useState<React.CSSProperties>({})
  const lookupInput = useRef<HTMLInputElement>(null)
  const lookupRequest = useRef(0)
  const fields = new Map(panel.fields.map((item) => [item.id, item]))
  const kind: PetLookupKind | null = field.id === 'hospital' ? 'hospital'
    : field.id === 'hospitalAddress' ? 'address'
      : field.id === 'department' ? 'department'
        : field.id === 'doctor' ? 'doctor'
          : /^escort-\d+-name$/.test(field.id) ? 'escort' : null
  const hospitalValue = String(fields.get('hospital')?.value ?? '')
  const departmentValue = String(fields.get('department')?.value ?? '')
  const initialValue = useRef(String(field.value))
  const lookup = async (query: string, currentId?: string): Promise<void> => {
    if (!kind || !onLookup) return
    const request = ++lookupRequest.current
    setLookupBusy(true)
    try { const options = await onLookup(kind, query, { hospitalId: hospitalValue, departmentId: departmentValue, currentId }); if (request === lookupRequest.current) setLookupOptions(options) }
    catch { if (request === lookupRequest.current) setLookupOptions([]) }
    finally { if (request === lookupRequest.current) setLookupBusy(false) }
  }
  const positionLookup = (): void => {
    const input = lookupInput.current
    if (!input) return
    const rect = input.getBoundingClientRect()
    const bounds = input.closest('.pet-bubble--form')?.getBoundingClientRect()
    const top = Math.max(4, bounds?.top ?? 0)
    const bottom = Math.min(window.innerHeight - 4, bounds?.bottom ?? window.innerHeight)
    const below = bottom - rect.bottom - 5
    const above = rect.top - top - 5
    const upward = below < 120 && above > below
    const height = Math.max(0, Math.min(190, upward ? above : below))
    setLookupPosition({ position: 'fixed', left: rect.left, width: rect.width, maxHeight: height, ...(upward ? { top: 'auto', bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) })
  }
  useEffect(() => {
    if (!lookupOpen) return
    const closeOnScroll = (event: Event): void => {
      if ((event.target as Element | null)?.closest?.('.pet-bubble__lookup-portal')) return
      setLookupOpen(false)
    }
    window.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('resize', positionLookup)
    return () => { window.removeEventListener('scroll', closeOnScroll, true); window.removeEventListener('resize', positionLookup) }
  }, [lookupOpen])
  useEffect(() => {
    if (!kind || !onLookup || !initialValue.current.trim() || String(field.value) !== initialValue.current) return
    let active = true
    void onLookup(kind, '', { hospitalId: hospitalValue, departmentId: departmentValue, currentId: initialValue.current })
      .then((options) => { if (active) setLookupOptions(options) })
      .catch(() => { if (active) setLookupOptions([]) })
    return () => { active = false }
  }, [kind, onLookup, hospitalValue, departmentValue, field.value, panel.id])
  const common = {
    id: field.id,
    name: field.id,
    'aria-label': field.label,
    placeholder: field.placeholder,
    title: (field.readOnly || panel.id.startsWith('order-ai:')) && field.value ? String(field.value) : undefined,
    readOnly: field.readOnly,
    required: field.required,
    'aria-invalid': Boolean(field.error),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onFieldChange?.(field.id, event.target.value)
  }

  let control: React.JSX.Element
  if (field.type === 'textarea' && field.id === 'groupName' && panel.id.startsWith('order-ai:')) {
    control = <div className="pet-bubble__input-with-copy"><input {...common} type="text" value={String(field.value)} />{field.copyable && <button type="button" title="复制" disabled={!String(field.value)} onClick={() => { void navigator.clipboard?.writeText(String(field.value)) }}>复制</button>}</div>
  } else if (field.type === 'textarea') {
    control = <div className="pet-bubble__input-with-copy"><textarea {...common} value={String(field.value)} rows={field.id === 'groupName' ? 1 : 3} />{field.copyable && <button type="button" title="复制" disabled={!String(field.value)} onClick={() => { void navigator.clipboard?.writeText(String(field.value)) }}>复制</button>}</div>
  } else if (field.type === 'select') {
    control = <SelectField field={field} onFieldChange={onFieldChange} showFullValue={panel.id.startsWith('order-ai:')} searchable={field.id === 'channelService' || field.id === 'orderStatus'} />
  } else if (field.type === 'datetime-local') {
    control = <DateTimeField field={field} onFieldChange={onFieldChange} reserveCopy={panel.id.startsWith('order-ai:')} />
  } else if (field.type === 'radio') {
    control = <span className="pet-bubble__choices">{(field.options ?? []).map((option) => <label key={option.value} className="pet-bubble__choice"><input type="radio" name={field.id} value={option.value} checked={String(field.value) === option.value} onChange={() => onFieldChange?.(field.id, option.value)} />{option.label}</label>)}</span>
  } else if (field.type === 'checkbox') {
    control = <label className="pet-bubble__checkbox"><input type="checkbox" checked={field.value === true || field.value === 'true'} disabled={field.readOnly} onChange={(event) => onFieldChange?.(field.id, String(event.target.checked))} /><span>{field.placeholder ?? field.label}</span></label>
  } else if (kind) {
    const selected = lookupOptions.find((option) => option.id === String(field.value) || option.name === String(field.value))
    control = <div className="pet-bubble__search-select">
      <input {...common} title={panel.id.startsWith('order-ai:') ? (selected?.name ?? String(field.value)) || undefined : common.title} placeholder={`请选择或输入${field.label}`} ref={lookupInput} type="text" value={selected?.name ?? String(field.value)} onFocus={() => {
        positionLookup()
        setLookupOpen(true)
        const currentValue = String(field.value)
        void lookup('', currentValue || undefined)
      }} onClick={() => { if (!lookupOpen) { positionLookup(); setLookupOpen(true); void lookup('', String(field.value) || undefined) } }} onBlur={() => window.setTimeout(() => setLookupOpen(false), 200)} onChange={(event) => { onFieldChange?.(field.id, event.target.value); positionLookup(); setLookupOpen(true); void lookup(event.target.value) }} />
      <span className="pet-bubble__lookup-chevron" aria-hidden="true" />
      {lookupOpen && createPortal(<div className="pet-bubble__search-options pet-bubble__lookup-portal" style={lookupPosition}>
        {lookupBusy && <small>加载中…</small>}
        {!lookupBusy && lookupOptions.length === 0 && <small>无匹配项，可手动输入</small>}
        {lookupOptions.map((option) => <button key={option.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => {
          const currentValue = String(field.value)
          if (currentValue !== option.id) onFieldChange?.(field.id, option.id, option)
          if (kind === 'escort' && option.phone) onFieldChange?.(field.id.replace(/-name$/, '-phone'), option.phone)
          setLookupOpen(false)
        }}>{option.name}</button>)}
      </div>, document.body)}
    </div>
  } else {
    control = <div className="pet-bubble__input-with-copy"><input {...common} type={field.type} value={String(field.value)} />
      {field.copyable && <button type="button" title="复制" disabled={!String(field.value)} onClick={() => { void navigator.clipboard?.writeText(String(field.value)) }}>复制</button>}
    </div>
  }

  const hospitalGroup = ['hospital', 'hospitalAddress', 'department', 'doctor'].includes(field.id)
  const orderForm = panel.id.startsWith('order-ai:') && !panel.confirmation
  const source = field.aiPrefill ? 'AI' : field.hint === '泰康意向' ? '意向' : ''
  return <div data-field-id={field.id} data-has-source={Boolean(source)} className={`pet-bubble__field pet-bubble__field--${field.type}${!field.readOnly && !String(field.value ?? '').trim() ? ' pet-bubble__field--empty' : ''}`}>
    {field.type !== 'checkbox' && <span className="pet-bubble__field-label">{field.label}{field.required ? ' *' : ''}</span>}
    {control}
    {orderForm && field.type !== 'checkbox' && source && <span className="pet-bubble__field-source">{source}</span>}
    {!orderForm && field.aiPrefill && <small>AI 建议</small>}
    {field.suggestion && String(field.value).trim() !== field.suggestion.trim() && <small>AI 建议：{field.suggestion} <button type="button" onClick={() => onFieldChange?.(hospitalGroup ? `__hospital_suggestion:${field.id}` : field.id, field.suggestion!)}>填入</button></small>}
    {field.hint && (!orderForm || field.hint !== '泰康意向') && <small>{field.hint}</small>}
    {field.error && <small className="pet-bubble__field-error">{field.error}</small>}
  </div>
}

function FormFields({ panel, onFieldChange, onLookup, onAddEscortRecord, onRemoveEscortRecord }: {
  panel: Extract<PetPanel, { kind: 'form' }>
  onFieldChange?: PetFieldChange
  onLookup?: PetBubbleProps['onLookup']
  onAddEscortRecord?: () => void
  onRemoveEscortRecord?: (sectionId: string) => void
}): React.JSX.Element {
  const fieldsById = new Map(panel.fields.map((field) => [field.id, field]))
  if (!panel.sections?.length) return <div className="pet-bubble__form-body"><div className="pet-bubble__fields">{panel.fields.map((field) => <Field key={`${panel.id}:${field.id}`} field={field} panel={panel} onFieldChange={onFieldChange} onLookup={onLookup} />)}</div></div>
  const escortSections = panel.sections.filter((section) => section.repeatable)
  const orderSections = panel.sections.filter((section) => !section.repeatable)
  const orderAi = panel.id.startsWith('order-ai:')
  return <fieldset className="pet-bubble__form-body" disabled={panel.submitState === 'submitting'}>
    {orderSections.map((section) => <fieldset className={`pet-bubble__form-section pet-bubble__form-section--order pet-bubble__form-section--${section.id}`} key={section.id}>
      <legend>{orderAi && section.id === 'order-info' ? '订单基本信息' : section.title}{!orderAi && section.id === 'order-info' && !section.fieldIds.includes('orderNo') && fieldsById.has('orderNo') && <span className="pet-bubble__order-number">{String(fieldsById.get('orderNo')?.value ?? '')}<button type="button" title="复制订单号" onClick={() => { void navigator.clipboard?.writeText(String(fieldsById.get('orderNo')?.value ?? '')) }}>复制</button></span>}</legend>
      <div className="pet-bubble__fields">{(orderAi && section.id === 'order-info' ? ['orderNo', 'documentNo', 'groupName', 'orderStatus', 'channelService', 'orderAmount', 'amountChanged'] : section.fieldIds).map((fieldId) => {
        const storedField = fieldsById.get(fieldId)
        const field = orderAi && fieldId === 'documentNo' && storedField ? { ...storedField, label: '身份证号', placeholder: '暂无身份证号' } : storedField
        const orderInfo = panel.id.startsWith('order-ai:') && section.id === 'order-info'
        if (!field || (orderInfo && fieldId === 'amountChanged')) return null
        if (orderInfo && fieldId === 'orderAmount') {
          const editable = fieldsById.get('amountChanged')
          return <div className="pet-bubble__amount-group" key={`${panel.id}:${field.id}`}><Field field={field} panel={panel} onFieldChange={onFieldChange} onLookup={onLookup} />{editable && <Field field={editable} panel={panel} onFieldChange={onFieldChange} onLookup={onLookup} />}</div>
        }
        return <Field key={`${panel.id}:${field.id}`} field={field} panel={panel} onFieldChange={onFieldChange} onLookup={onLookup} />
      })}</div>
      {section.id === 'hospital-info' && section.fieldIds.some((fieldId) => fieldsById.get(fieldId)?.suggestion) && <button className="pet-bubble__fill-group" type="button" onClick={() => onFieldChange?.('__hospital_suggestion_group', '')}>填入整组</button>}
    </fieldset>)}
    {escortSections.length > 0 && <fieldset className="pet-bubble__form-section pet-bubble__form-section--escort-cards">
      <legend>陪诊信息</legend>
      {orderAi && <div className="pet-bubble__escort-table-header" aria-hidden="true"><span>服务日期/时间</span><span>陪诊人</span><span>陪诊电话</span><span /></div>}
      <div className="pet-bubble__escort-card-list">{escortSections.map((section, index) => {
        const remove = <button className="pet-bubble__remove-record pet-bubble__remove-record--icon" type="button" title="移除陪诊信息" aria-label={`移除陪诊 ${index + 1}`} onClick={() => onRemoveEscortRecord?.(section.id)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3h4v1.5m-5.5 0 .6 8h5.8l.6-8M6.5 6.5v4.5m3-4.5v4.5" /></svg></button>
        return <article className="pet-bubble__escort-card" key={section.id}>
          {!orderAi && <header><strong>陪诊 {index + 1}</strong>{remove}</header>}
          <div className="pet-bubble__fields">{section.fieldIds.map((fieldId) => { const field = fieldsById.get(fieldId); return field ? <Field key={`${panel.id}:${field.id}`} field={field} panel={panel} onFieldChange={onFieldChange} onLookup={onLookup} /> : null })}{orderAi && remove}</div>
      </article> })}</div>
      <button className="pet-bubble__add-record" type="button" onClick={onAddEscortRecord}>＋ 新增陪诊信息</button>
    </fieldset>}
  </fieldset>
}

function MasterReview({ items, addressValue, onFieldChange }: { items: MasterReviewItem[]; addressValue: string; onFieldChange?: PetFieldChange }): React.JSX.Element {
  const address = items.find((item) => item.type === 'address')
  const hospital = items.find((item) => item.type === 'hospital')
  const visible = items.filter((item) => item.type !== 'address' || !hospital)
  const titles: Record<string, string> = { hospital: '医院', address: '医院', department: '对外科室', doctor: '医生', escort: '陪诊人' }
  return <div className="pet-bubble__master-review" aria-label="核对建档信息">
    <h2>核对建档信息</h2>
    <div className="pet-bubble__master-review-list">{visible.map((item) => {
      const itemAddress = item.type === 'hospital' ? address?.name : item.type === 'address' ? item.name : ''
      const sources = [...new Map(item.fields.flatMap((field) => field.source ? [[field.source.url, field.source]] as const : [])).values()]
      return <section className={`pet-bubble__master-card pet-bubble__master-card--${item.type}`} key={item.key}>
        <div className="pet-bubble__master-identity"><strong>{titles[item.type] ?? item.type}</strong><span>{item.type === 'address' ? item.parent : item.name}</span>{item.type === 'escort' && <small>电话随当前订单使用</small>}{sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">查看{source.label}</a>)}</div>
        <div className="pet-bubble__master-fields">{item.fields.map((reviewField) => {
          const parentId = reviewField.id === 'city' ? 'province' : reviewField.id === 'internalTwo' ? 'internalOne' : ''
          const parent = parentId ? item.fields.find((field) => field.id === parentId)?.value : ''
          const options = parentId ? reviewField.options.filter((option) => option.parent === parent) : reviewField.options
          const id = `master:${item.key}:${reviewField.id}`
          return <label className={`pet-bubble__master-field${reviewField.value ? '' : ' pet-bubble__master-field--empty'}`} key={id}><span>{reviewField.label}</span><SelectField field={{ id, label: reviewField.label, type: 'select', value: reviewField.value, options, placeholder: '请选择' }} onFieldChange={onFieldChange} searchable={item.type === 'hospital' || item.type === 'address' || item.type === 'department'} /></label>
        })}{(item.type === 'hospital' || item.type === 'address') && <div className="pet-bubble__master-address"><span>医院地址</span><span>{addressValue || itemAddress || '未填写'}</span>{item.addressSuggestion && <><span>AI 建议值（请核对院区）</span><span>{item.addressSuggestion.value}</span><div><button type="button" disabled={addressValue === item.addressSuggestion.value} onClick={() => onFieldChange?.('hospitalAddress', item.addressSuggestion!.value)}>{addressValue === item.addressSuggestion.value ? '已采纳' : '采纳建议值'}</button></div></>}</div>}</div>
      </section>
    })}</div>
  </div>
}

export function PetBubble({ panel, skipEntranceAnimation, onAction, onClose, onSelectCandidate, onSelectApplication, onResolveImageOrder, onDiscardImageMatch, onPickOtherImageOrder, imageMatchError, onFieldChange, onLookup, onSizeChange, onAddEscortRecord, onRemoveEscortRecord }: PetBubbleProps): React.JSX.Element {
  const bubbleRef = useRef<HTMLElement>(null)
  const wideOrderForm = panel.kind === 'form' && !panel.confirmation && panel.id?.startsWith('order-ai:')

  useEffect(() => {
    const element = bubbleRef.current
    if (!element || !onSizeChange) return
    let lastWidth = 0
    let lastHeight = 0
    const report = (): void => {
      // Layout尺寸不受弹出动画的 transform 缩放影响，避免窗口按动画中的临时尺寸裁掉底部按钮。
      const width = wideOrderForm ? Math.max(element.offsetWidth, Math.min(660, Math.max(240, window.screen.availWidth - 120))) : element.offsetWidth
      const height = element.offsetHeight
      if (width > 0 && height > 0 && (width !== lastWidth || height !== lastHeight)) {
        lastWidth = width
        lastHeight = height
        onSizeChange({ width, height })
      }
    }
    const observer = new ResizeObserver(report)
    observer.observe(element)
    report()
    return () => observer.disconnect()
  }, [onSizeChange, wideOrderForm])

  return (
    <section ref={bubbleRef} className={`pet-bubble pet-bubble--${panel.kind}${skipEntranceAnimation ? ' pet-bubble--no-entrance' : ''}${panel.kind === 'form' && panel.confirmation ? ' pet-bubble--master-review' : ''}${panel.kind === 'form' && !panel.confirmation && panel.id?.startsWith('order-ai:') ? ' pet-bubble--order-ai' : ''}`} style={panel.kind === 'form' ? ({
      maxHeight: `${Math.max(240, window.screen.availHeight - 54)}px`,
      '--pet-form-body-max-height': `${Math.max(140, window.screen.availHeight - 230)}px`
    } as React.CSSProperties) : panel.kind === 'image-match' ? ({
      maxWidth: `${Math.max(160, window.screen.availWidth - 120)}px`,
      maxHeight: `${Math.max(160, window.screen.availHeight - 90)}px`
    } as React.CSSProperties) : undefined} role="status" aria-live="polite">
      <span className="pet-bubble__tail" aria-hidden="true" />
      <button className="pet-bubble__close" type="button" aria-label="关闭面板" title="关闭" onClick={onClose}>×</button>
      {panel.kind === 'speech' && <><p className="pet-bubble__text">{panel.text}</p><Actions actions={panel.actions ?? []} onAction={onAction} /></>}
      {panel.kind === 'progress' && <><p className="pet-bubble__text">{panel.text}</p>{panel.progress !== undefined && <div className="pet-bubble__progress" aria-label={`处理进度 ${panel.progress}%`}><span style={{ width: `${Math.max(0, Math.min(100, panel.progress))}%` }} /></div>}</>}
      {panel.kind === 'error' && <><p className="pet-bubble__text">{panel.text}</p><Actions actions={panel.actions ?? []} onAction={onAction} /></>}
      {panel.kind === 'candidate-list' && <><h2 className="pet-bubble__title">{panel.title}</h2><div className="pet-bubble__candidate-list">{panel.items.map((candidate, index) => <button className="pet-bubble__candidate" key={candidate.orderId} type="button" onClick={() => onSelectCandidate?.(candidate.orderId)}><strong>{index === 0 ? '可能的订单 · ' : ''}{candidate.customerName || '未识别患者'}</strong><span>{candidate.hospital || '医院待确认'} · {candidate.department || '科室待确认'}</span><small>{candidate.sourceOrderNo}</small></button>)}</div></>}
      {panel.kind === 'form' && (panel.confirmation ? <><MasterReview items={panel.confirmation.review} addressValue={String(panel.fields.find((field) => field.id === 'hospitalAddress')?.value ?? '')} onFieldChange={onFieldChange} />{panel.submitMessage && <p className={`pet-bubble__submit-message pet-bubble__submit-message--${panel.submitState ?? 'idle'}`}>{panel.submitMessage}</p>}<Actions actions={panel.actions} onAction={onAction} /></> : <><div className={`pet-bubble__form-header${panel.title ? '' : ' pet-bubble__form-header--untitled'}`}>{panel.title && <h2 className="pet-bubble__title">{panel.title}</h2>}{panel.description && <p className="pet-bubble__description">{panel.description}</p>}</div><FormFields panel={panel} onFieldChange={onFieldChange} onLookup={onLookup} onAddEscortRecord={onAddEscortRecord} onRemoveEscortRecord={onRemoveEscortRecord} />{panel.submitMessage && <p className={`pet-bubble__submit-message pet-bubble__submit-message--${panel.submitState ?? 'idle'}`}>{panel.submitMessage}</p>}<Actions actions={panel.actions} onAction={onAction} /></>)}
      {panel.kind === 'image-match' && <>
        <h2 className="pet-bubble__title">请确认挂号凭证的归属</h2>
        <img className="pet-bubble__image-preview" src={panel.match.imageUrl} alt="待确认的挂号凭证" />
        {panel.match.typeDescription && <p className="pet-bubble__description">{panel.match.typeDescription}</p>}
        <p className="pet-bubble__description">{panel.match.description}</p>
        {panel.match.visibleText && <details className="pet-bubble__description"><summary>查看图片识别文字</summary><p className="pet-bubble__visible-text">{panel.match.visibleText}</p></details>}
        {panel.selectedApplicationNo === null ? <>
          <p className="pet-bubble__description">请选择对应的申领号</p>
          {panel.match.candidateApplications.length === 0
            ? <p className="pet-bubble__description">暂时没有找到可核对的申领号候选。{panel.match.source === 'drop' ? '这张图片暂存在浮动精灵中，尚未上传到任何订单。' : '图片仍保留在原聊天消息中，请先核对会话关联或图片内容。'}</p>
            : <div className="pet-bubble__candidate-list">{panel.match.candidateApplications.map((application) => {
            const first = application.orders[0]
            return <button className="pet-bubble__candidate" key={application.applicationNo} type="button" onClick={() => onSelectApplication?.(application.applicationNo)}>
              <strong>{application.applicationNo === panel.match.recommendedApplicationNo ? 'AI 建议 · ' : ''}{first?.customerName || '客户姓名待确认'}</strong>
              <span>{first ? [first.serviceType, first.hospital, first.department].filter(Boolean).join(' · ') : '申领号下暂无订单资料'}</span>
              <small>{application.applicationNo} · 共 {application.orders.length} 张订单{typeof application.confidence === 'number' ? ` · AI 匹配度 ${application.confidence}%` : ''}</small>
            </button>
          })}</div>}
        </> : <>
          <p className="pet-bubble__description">申领号：{panel.selectedApplicationNo}。请选择具体订单，确认前不会把图片上传到订单。</p>
          <div className="pet-bubble__candidate-list">{(panel.match.candidateApplications.find((application) => application.applicationNo === panel.selectedApplicationNo)?.orders ?? []).map((order) => <button className="pet-bubble__candidate" key={order.orderId} type="button" onClick={() => onResolveImageOrder?.(panel.selectedApplicationNo!, order.orderId)}>
            <strong>{order.orderId === panel.match.recommendedOrderId ? 'AI 建议 · ' : ''}{order.customerName || '客户姓名待确认'} · {order.serviceType || '服务订单'}</strong>
            <span>{[order.hospital, order.department, order.doctor].filter(Boolean).join(' · ') || '医院和科室待确认'}</span>
            <small>{order.appointmentDate || order.status || order.sourceOrderNo}{typeof order.confidence === 'number' ? ` · AI 匹配度 ${order.confidence}%` : ''}</small>
          </button>)}</div>
          {panel.match.reason && <p className="pet-bubble__description">AI 判断依据：{panel.match.reason}</p>}
        </>}
        {imageMatchError && <p className="pet-bubble__submit-message pet-bubble__submit-message--error" role="alert">{imageMatchError}</p>}
        <div className="pet-bubble__actions">
          <button type="button" className="pet-bubble__action pet-bubble__action--secondary" onClick={onPickOtherImageOrder}>哪个都不是，选择其他订单</button>
          <button type="button" className="pet-bubble__action pet-bubble__action--secondary" onClick={onDiscardImageMatch}>放弃关联</button>
        </div>
      </>}
    </section>
  )
}
