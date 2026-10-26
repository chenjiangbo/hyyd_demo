import { useEffect, useRef } from 'react'
import './PetBubble.css'

export interface Candidate {
  orderId: number
  sourceOrderNo: string
  customerName: string
  hospital: string | null
  department: string | null
  appointmentDate: string | null
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
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'radio' | 'checkbox'
  value: string | number | boolean
  placeholder?: string
  hint?: string
  required?: boolean
  readOnly?: boolean
  options?: Array<{ value: string; label: string }>
  error?: string
  validation?: { rule: 'required' | 'phone' | 'id-card' | 'date'; message: string }
}

export interface PetFormSection {
  id: string
  title: string
  fieldIds: string[]
}

export type PetPanel =
  | { kind: 'speech'; text: string; actions?: PetAction[] }
  | { kind: 'progress'; text: string; progress?: number }
  | { kind: 'error'; text: string; actions?: PetAction[] }
  | { kind: 'candidate-list'; title: string; items: Candidate[] }
  | {
      kind: 'form'
      id: string
      title: string
      description?: string
      sections?: PetFormSection[]
      fields: PetField[]
      actions: PetAction[]
      submitState?: 'idle' | 'submitting' | 'success' | 'error'
    }

interface PetBubbleProps {
  panel: PetPanel
  onAction?: (actionId: string) => void
  onSelectCandidate?: (orderId: number) => void
  onFieldChange?: (fieldId: string, value: string) => void
  onSizeChange?: (size: { width: number; height: number }) => void
}

function Actions({ actions, onAction }: { actions: PetAction[]; onAction?: (actionId: string) => void }): React.JSX.Element | null {
  if (actions.length === 0) return null
  return (
    <div className="pet-bubble__actions">
      {actions.map((action) => (
        <button key={action.id} className={`pet-bubble__action pet-bubble__action--${action.tone ?? 'secondary'}`} type="button" disabled={action.disabled || action.loading} onClick={() => onAction?.(action.id)}>
          {action.loading ? '处理中…' : action.label}
        </button>
      ))}
    </div>
  )
}

function Field({ field, onFieldChange }: { field: PetField; onFieldChange?: (fieldId: string, value: string) => void }): React.JSX.Element {
  const common = {
    id: field.id,
    name: field.id,
    placeholder: field.placeholder,
    readOnly: field.readOnly,
    required: field.required,
    'aria-invalid': Boolean(field.error),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onFieldChange?.(field.id, event.target.value)
  }

  let control: React.JSX.Element
  if (field.type === 'textarea') {
    control = <textarea {...common} value={String(field.value)} rows={3} />
  } else if (field.type === 'select') {
    control = <select {...common} value={String(field.value)}><option value="">请选择</option>{(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  } else if (field.type === 'radio') {
    control = <span className="pet-bubble__choices">{(field.options ?? []).map((option) => <label key={option.value} className="pet-bubble__choice"><input type="radio" name={field.id} value={option.value} checked={String(field.value) === option.value} onChange={() => onFieldChange?.(field.id, option.value)} />{option.label}</label>)}</span>
  } else if (field.type === 'checkbox') {
    control = <label className="pet-bubble__checkbox"><input type="checkbox" checked={Boolean(field.value)} disabled={field.readOnly} onChange={(event) => onFieldChange?.(field.id, String(event.target.checked))} /><span>{field.placeholder ?? field.label}</span></label>
  } else {
    control = <input {...common} type={field.type} value={String(field.value)} />
  }

  return <label className={`pet-bubble__field pet-bubble__field--${field.type}`}>{field.type !== 'checkbox' && <span>{field.label}{field.required ? ' *' : ''}</span>}{control}{field.hint && <small>{field.hint}</small>}{field.error && <small className="pet-bubble__field-error">{field.error}</small>}</label>
}

function FormFields({ panel, onFieldChange }: { panel: Extract<PetPanel, { kind: 'form' }>; onFieldChange?: (fieldId: string, value: string) => void }): React.JSX.Element {
  const fieldsById = new Map(panel.fields.map((field) => [field.id, field]))
  if (!panel.sections?.length) return <div className="pet-bubble__form-body"><div className="pet-bubble__fields">{panel.fields.map((field) => <Field key={field.id} field={field} onFieldChange={onFieldChange} />)}</div></div>
  return <div className="pet-bubble__form-body">{panel.sections.map((section) => <fieldset className="pet-bubble__form-section" key={section.id}><legend>{section.title}</legend><div className="pet-bubble__fields">{section.fieldIds.map((fieldId) => { const field = fieldsById.get(fieldId); return field ? <Field key={field.id} field={field} onFieldChange={onFieldChange} /> : null })}</div></fieldset>)}</div>
}

export function PetBubble({ panel, onAction, onSelectCandidate, onFieldChange, onSizeChange }: PetBubbleProps): React.JSX.Element {
  const bubbleRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const element = bubbleRef.current
    if (!element || !onSizeChange) return
    const report = (): void => onSizeChange({ width: element.scrollWidth, height: element.scrollHeight })
    const observer = new ResizeObserver(report)
    observer.observe(element)
    report()
    return () => observer.disconnect()
  }, [onSizeChange, panel])

  return (
    <section ref={bubbleRef} className={`pet-bubble pet-bubble--${panel.kind}`} role="status" aria-live="polite">
      <span className="pet-bubble__tail" aria-hidden="true" />
      {panel.kind === 'speech' && <><p className="pet-bubble__text">{panel.text}</p><Actions actions={panel.actions ?? []} onAction={onAction} /></>}
      {panel.kind === 'progress' && <><p className="pet-bubble__text">{panel.text}</p>{panel.progress !== undefined && <div className="pet-bubble__progress" aria-label={`处理进度 ${panel.progress}%`}><span style={{ width: `${Math.max(0, Math.min(100, panel.progress))}%` }} /></div>}</>}
      {panel.kind === 'error' && <><p className="pet-bubble__text">{panel.text}</p><Actions actions={panel.actions ?? []} onAction={onAction} /></>}
      {panel.kind === 'candidate-list' && <><h2 className="pet-bubble__title">{panel.title}</h2><div className="pet-bubble__candidate-list">{panel.items.map((candidate, index) => <button className="pet-bubble__candidate" key={candidate.orderId} type="button" onClick={() => onSelectCandidate?.(candidate.orderId)}><strong>{index === 0 ? '可能的订单 · ' : ''}{candidate.customerName || '未识别患者'}</strong><span>{candidate.hospital || '医院待确认'} · {candidate.department || '科室待确认'}</span><small>{candidate.sourceOrderNo}</small></button>)}</div></>}
      {panel.kind === 'form' && <><div className="pet-bubble__form-header"><h2 className="pet-bubble__title">{panel.title}</h2>{panel.description && <p className="pet-bubble__description">{panel.description}</p>}</div><FormFields panel={panel} onFieldChange={onFieldChange} /><Actions actions={panel.actions} onAction={onAction} /></>}
    </section>
  )
}
