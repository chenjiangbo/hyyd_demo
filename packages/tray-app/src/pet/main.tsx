import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PetAvatar, type PetVisualState } from './PetAvatar'
import { PetBubble, type Candidate, type PetLookupOption, type PetPanel } from './PetBubble'
import './styles.css'

type PetMode = 'idle' | 'dragover' | 'receiving' | 'working' | 'done' | 'unknown' | 'candidates' | 'warning'
type PetDrag = { startX: number; startY: number; windowX: number; windowY: number }
type PetMobileStatus = { state: 'online' | 'stale' | 'unknown'; lastSeenAt: string | null }

function petDebug(event: string, data: Record<string, unknown> = {}): void {
  try {
    window.api.petDebugLog({ event, ...data })
  } catch {
    // 诊断日志不能影响精灵业务流程。
  }
}

function droppedPathFromUri(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('file://')) return null
  try {
    const decoded = decodeURIComponent(trimmed.replace(/^file:\/\//, ''))
    return decoded.replace(/^\/+([A-Za-z]:[\\/])/, '$1') || null
  } catch {
    return null
  }
}

export function Pet(): React.JSX.Element {
  const [businessPanel, setBusinessPanel] = useState<PetPanel | null>(null)
  const [businessPanelVisible, setBusinessPanelVisible] = useState(true)
  const committedLookupSelections = useRef<Record<string, string>>({})
  const [mode, setMode] = useState<PetMode>('idle')
  const [message, setMessage] = useState('把图片拖给我吧')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [speaking, setSpeaking] = useState(false)
  const [bubbleSide, setBubbleSide] = useState<'left' | 'right'>('left')
  const [mobileStatus, setMobileStatus] = useState<PetMobileStatus>({ state: 'unknown', lastSeenAt: null })
  const speakingTimer = useRef<number | null>(null)
  const receivingTimer = useRef<number | null>(null)
  const dragOverRef = useRef(false)
  const petDragRef = useRef<PetDrag | null>(null)

  const announce = (nextMessage: string, talk = false): void => {
    setMessage(nextMessage)
    setSpeaking(talk)
    if (speakingTimer.current !== null) window.clearTimeout(speakingTimer.current)
    if (talk) {
      speakingTimer.current = window.setTimeout(() => {
        setSpeaking(false)
        speakingTimer.current = null
      }, 1800)
    }
  }

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const eyes = document.querySelector<SVGElement>('.pet-avatar__eyes')
    const eyeStyle = eyes ? window.getComputedStyle(eyes) : null
    petDebug('renderer:ready', {
      reducedMotion,
      eyesFound: Boolean(eyes),
      eyeAnimationName: eyeStyle?.animationName ?? null,
      eyeAnimationDuration: eyeStyle?.animationDuration ?? null,
      windowSize: { width: window.innerWidth, height: window.innerHeight }
    })
    const unsubscribe = window.api.onPetStatus((status) => {
      petDebug('status', { state: status.state, hasMessage: Boolean(status.message), candidateCount: status.candidates?.length ?? 0 })
      setMode(status.state)
      announce(status.message, status.state === 'done' || status.state === 'unknown' || status.state === 'candidates')
      setCandidates((status.candidates ?? []) as Candidate[])
    })
    const onDragEnter = (event: DragEvent): void => {
      petDebug('dragenter', { types: Array.from(event.dataTransfer?.types ?? []) })
    }
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer!.dropEffect = 'copy'
      if (!dragOverRef.current) {
        petDebug('dragover:first', { types: Array.from(event.dataTransfer?.types ?? []), effectAllowed: event.dataTransfer?.effectAllowed ?? null })
        dragOverRef.current = true
        setMode('dragover')
        announce('收到啦，松开手吧')
      }
    }
    const onDragLeave = (event: DragEvent): void => {
      petDebug('dragleave', { relatedTarget: event.relatedTarget === null ? null : 'present' })
      if (event.relatedTarget === null) {
        dragOverRef.current = false
        setMode('idle')
        setSpeaking(false)
      }
    }
    const onDrop = async (event: DragEvent): Promise<void> => {
      event.preventDefault()
      event.stopPropagation()
      dragOverRef.current = false
      petDebug('drop:start', { fileCount: event.dataTransfer?.files.length ?? 0, types: Array.from(event.dataTransfer?.types ?? []) })
      if (receivingTimer.current !== null) window.clearTimeout(receivingTimer.current)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const paths = files.map((file) => {
        try {
          return window.api.getPathForFile(file)
        } catch {
          return ''
        }
      }).filter(Boolean)
      if (paths.length === 0) {
        const transfer = event.dataTransfer
        const uriValues = [
          transfer?.getData('text/uri-list') ?? '',
          transfer?.getData('text/plain') ?? ''
        ]
        for (const value of uriValues) {
          const uriPath = value.split(/\r?\n/).map(droppedPathFromUri).find(Boolean)
          if (uriPath) {
            paths.push(uriPath)
            break
          }
        }
      }
      if (paths.length === 0) {
        petDebug('drop:no-path')
        setMode('unknown')
        announce('嗯…我没有接到文件', true)
        return
      }
      setMode('receiving')
      announce('收到文件啦，我开始看一看…')
      petDebug('drop:path-resolved', { pathCount: paths.length })
      const visualStartedAt = performance.now()
      receivingTimer.current = window.setTimeout(() => {
        setMode((current) => current === 'receiving' ? 'working' : current)
        receivingTimer.current = null
      }, 900)
      let result
      try {
        result = await window.api.petDropFiles([paths[0]])
      } catch (error) {
        petDebug('drop:ipc-error', { message: error instanceof Error ? error.message : String(error) })
        setMode('unknown')
        announce('处理文件时出错了，请稍后再试', true)
        return
      }
      const visualWait = Math.max(0, 900 - (performance.now() - visualStartedAt))
      if (visualWait > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, visualWait))
      petDebug('drop:result', { state: result.state })
      if (receivingTimer.current !== null) {
        window.clearTimeout(receivingTimer.current)
        receivingTimer.current = null
      }
      setMode(result.state)
      announce(result.message, result.state === 'done' || result.state === 'unknown' || result.state === 'candidates')
      setCandidates((result.candidates ?? []) as Candidate[])
    }
    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
      unsubscribe()
      if (speakingTimer.current !== null) window.clearTimeout(speakingTimer.current)
      if (receivingTimer.current !== null) window.clearTimeout(receivingTimer.current)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    let receivedEvent = false
    const apply = (value: unknown | null): void => {
      if (!mounted) return
      if (!value || typeof value !== 'object' || typeof (value as { kind?: unknown }).kind !== 'string') {
        committedLookupSelections.current = {}
        setBusinessPanel(null)
        setBusinessPanelVisible(false)
        return
      }
      const nextPanel = value as PetPanel
      if (nextPanel.kind === 'form') {
        committedLookupSelections.current = Object.fromEntries(['hospital', 'department'].flatMap((fieldId) => {
          const field = nextPanel.fields.find((item) => item.id === fieldId)
          return field ? [[fieldId, String(field.value)]] : []
        }))
      } else {
        committedLookupSelections.current = {}
      }
      setBusinessPanel(nextPanel)
      setBusinessPanelVisible(true)
    }
    const unsubscribe = window.api.onPetPanel((value) => { receivedEvent = true; apply(value) })
    const unsubscribeVisibility = window.api.onPetPanelVisibility(setBusinessPanelVisible)
    void window.api.getPetPanel().then((value) => { if (!receivedEvent) apply(value) })
    return () => { mounted = false; unsubscribe(); unsubscribeVisibility() }
  }, [])

  useEffect(() => {
    const unsubscribeStatus = window.api.onPetMobileStatus(setMobileStatus)
    const unsubscribeReminder = window.api.onPetReminder((reminder) => {
      setMode('warning')
      announce(reminder, true)
    })
    return () => {
      unsubscribeStatus()
      unsubscribeReminder()
    }
  }, [])

  // Drag-over stays compact so the drop target does not move under the cursor.
  const expanded = (businessPanelVisible && businessPanel !== null) || (mode !== 'idle' && mode !== 'dragover') || speaking

  const avatarState: PetVisualState = businessPanelVisible && businessPanel ? 'speaking' : mode === 'dragover'
    ? 'dragover'
    : mode === 'receiving'
      ? 'receiving'
      : mode === 'working'
        ? 'working'
        : mode === 'done'
          ? (speaking ? 'speaking' : 'done')
          : mode === 'unknown' || mode === 'warning'
            ? 'unknown'
            : mode === 'candidates'
              ? 'candidates'
              : speaking ? 'speaking' : 'idle'

  const panel: PetPanel | null = (businessPanelVisible ? businessPanel : null) ?? (mode === 'candidates' && candidates.length > 0
    ? { kind: 'candidate-list', title: '请选择这张凭证对应的订单', items: candidates }
    : mode === 'unknown' || mode === 'warning'
      ? { kind: 'error', text: message }
      : mode === 'working' || mode === 'receiving'
        ? { kind: 'progress', text: message }
        : mode === 'done' || speaking
            ? { kind: 'speech', text: message }
            : null)

  const changeBusinessField = (fieldId: string, value: string, selectedOption?: PetLookupOption): void => {
    const currentValue = businessPanel?.kind === 'form'
      ? String(businessPanel.fields.find((field) => field.id === fieldId)?.value ?? '')
      : ''
    let resetFields: string[] = []
    if (selectedOption && (fieldId === 'hospital' || fieldId === 'department')) {
      const previousSelection = committedLookupSelections.current[fieldId] ?? currentValue
      const sameSelection = previousSelection === selectedOption.id || previousSelection === selectedOption.name ||
        currentValue === selectedOption.id || currentValue === selectedOption.name
      if (!sameSelection) resetFields = fieldId === 'hospital' ? ['hospitalAddress', 'department', 'doctor'] : ['doctor']
      committedLookupSelections.current[fieldId] = selectedOption.id
    }
    setBusinessPanel((current) => {
      if (current?.kind !== 'form') return current
      const reset = new Set(resetFields)
      const currentRequest = current.fields.find((field) => field.id === 'requestTime')?.value
      const currentResponse = current.fields.find((field) => field.id === 'responseTime')?.value
      const mirrorResponse = fieldId === 'requestTime' && (!currentResponse || currentResponse === currentRequest)
      return { ...current, fields: current.fields.map((field) => field.id === fieldId || (mirrorResponse && field.id === 'responseTime')
        ? { ...field, value } : reset.has(field.id) ? { ...field, value: '' } : field) }
    })
  }

  const lookupOrderDictionary = useCallback(async (kind: import('./PetBubble').PetLookupKind, query: string, parent: { hospitalId?: string; departmentId?: string; currentId?: string }): Promise<import('./PetBubble').PetLookupOption[]> => {
    const records = (value: unknown): Array<{ id: string; name: string; phone?: string }> => Array.isArray(value) ? value.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const option = item as Record<string, unknown>
      if (typeof option.id !== 'string' && typeof option.id !== 'number') return []
      const id = String(option.id)
      const name = typeof option.name === 'string' ? option.name : id
      const phone = typeof option.phone === 'string' ? option.phone : undefined
      return [{ id, name, phone }]
    }) : []
    let hospitalId = parent.hospitalId ?? ''
    if (['address', 'department', 'doctor'].includes(kind) && hospitalId && !/^\d{4}$/.test(hospitalId)) {
      const matches = records(await window.api.petOrderDictionary('hospital', hospitalId))
      hospitalId = matches.find((item) => item.name === hospitalId || item.id === hospitalId)?.id ?? hospitalId
    }
    let departmentId = parent.departmentId ?? ''
    if (kind === 'doctor' && departmentId && !/^\d{8}$/.test(departmentId)) {
      const matches = records(await window.api.petOrderDictionary('department', departmentId, { hospitalId }))
      departmentId = matches.find((item) => item.name === departmentId || item.id === departmentId)?.id ?? departmentId
    }
    return records(await window.api.petOrderDictionary(kind, query, { hospitalId, departmentId, currentId: parent.currentId }))
  }, [])

  const addBusinessEscortRecord = (): void => {
    setBusinessPanel((current) => {
      if (current?.kind !== 'form' || !current.sections) return current
      const nextIndex = current.sections.reduce((maximum, section) => {
        const match = section.id.match(/^escort-(\d+)$/)
        return match ? Math.max(maximum, Number(match[1])) : maximum
      }, 0) + 1
      const prefix = `escort-${nextIndex}`
      return {
        ...current,
        fields: [...current.fields,
          { id: `${prefix}-date`, label: '服务日期/时间', type: 'datetime-local', value: '', placeholder: '请选择服务日期/时间' },
          { id: `${prefix}-name`, label: '陪诊人', type: 'text', value: '', placeholder: '请输入陪诊人' },
          { id: `${prefix}-phone`, label: '陪诊电话', type: 'text', value: '', placeholder: '请输入陪诊电话' }
        ],
        sections: [...current.sections, { id: prefix, title: `陪诊服务 ${nextIndex}`, fieldIds: [`${prefix}-date`, `${prefix}-name`, `${prefix}-phone`], repeatable: true }]
      }
    })
  }

  const removeBusinessEscortRecord = (sectionId: string): void => {
    setBusinessPanel((current) => {
      if (current?.kind !== 'form' || !current.sections) return current
      const section = current.sections.find((item) => item.id === sectionId && item.repeatable)
      if (!section) return current
      if (current.sections.filter((item) => item.repeatable).length <= 1) return current
      const removed = new Set(section.fieldIds)
      const sections = current.sections.filter((item) => item.id !== sectionId)
      return { ...current, sections, fields: current.fields.filter((field) => !removed.has(field.id)) }
    })
  }

  const businessAction = (actionId: string): void => {
    if (!businessPanel || !('id' in businessPanel) || typeof businessPanel.id !== 'string') return
    const fields = businessPanel.kind === 'form'
      ? Object.fromEntries(businessPanel.fields.map((field) => [field.id, field.value]))
      : undefined
    window.api.sendPetPanelAction({ panelId: businessPanel.id, actionId, fields })
  }

  const selectCandidate = (orderId: number): void => {
    setMode('working')
    announce('好，我保存到这个订单…')
    void window.api.petSelectOrder(orderId).then((result) => {
      setMode(result.state)
      announce(result.message, result.state === 'done' || result.state === 'unknown' || result.state === 'candidates')
      setCandidates((result.candidates ?? []) as Candidate[])
    }).catch((error: unknown) => {
      setMode('unknown')
      announce(error instanceof Error ? error.message : '订单保存失败了', true)
    })
  }

  useEffect(() => {
    void window.api.setPetExpanded(expanded).then((layout) => {
      setBubbleSide(layout.bubbleSide)
    })
  }, [expanded])

  useEffect(() => {
    if (mode !== 'done' && mode !== 'unknown' && mode !== 'warning') return
    const timer = window.setTimeout(() => setMode('idle'), 4000)
    return () => window.clearTimeout(timer)
  }, [mode])

  const resizeBubble = (size: { width: number; height: number }): void => {
    void window.api.setPetBubbleSize(size).then((layout) => setBubbleSide(layout.bubbleSide))
  }

  const mobileStatusTitle = mobileStatus.state === 'online'
    ? `移动端最近有心跳${mobileStatus.lastSeenAt ? `：${new Date(mobileStatus.lastSeenAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : ''}`
    : mobileStatus.state === 'stale'
      ? `移动端心跳已过期${mobileStatus.lastSeenAt ? `，最后时间：${new Date(mobileStatus.lastSeenAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : ''}`
      : '暂时无法确认移动端状态'

  useEffect(() => {
    const onMouseMove = (event: MouseEvent): void => {
      const drag = petDragRef.current
      if (!drag || event.buttons === 0) return
      window.api.movePet(
        Math.round(drag.windowX + event.screenX - drag.startX),
        Math.round(drag.windowY + event.screenY - drag.startY)
      )
    }
    const onMouseUp = (event: MouseEvent): void => {
      if (petDragRef.current) {
        petDebug('mouseup', { screenX: event.screenX, screenY: event.screenY })
        petDragRef.current = null
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const startPetDrag = async (event: React.MouseEvent<HTMLDivElement>): Promise<void> => {
    if (event.button !== 0) return
    petDebug('mousedown', { screenX: event.screenX, screenY: event.screenY })
    event.preventDefault()
    const bounds = await window.api.getPetBounds()
    if (!bounds) {
      petDebug('mousedown:no-bounds')
      return
    }
    petDebug('mousedown:ready', { windowX: bounds.x, windowY: bounds.y })
    petDragRef.current = {
      startX: event.screenX,
      startY: event.screenY,
      windowX: bounds.x,
      windowY: bounds.y
    }
  }

  return (
    <main className={`pet-shell pet-${mode} pet-bubble-${bubbleSide} ${expanded ? 'pet-expanded' : 'pet-idle'} ${speaking ? 'pet-speaking' : ''}`}>
      <div
        className="pet-character"
        onMouseDown={(event) => { void startPetDrag(event) }}
      >
        <PetAvatar state={avatarState} />
        {mobileStatus.state !== 'unknown' && <span className={`pet-mobile-status pet-mobile-status--${mobileStatus.state}`} title={mobileStatusTitle} aria-label={mobileStatusTitle} />}
      </div>
      {expanded && panel !== null && <PetBubble panel={panel} onSelectCandidate={selectCandidate} onFieldChange={changeBusinessField} onLookup={lookupOrderDictionary} onAction={businessAction} onSizeChange={resizeBubble} onAddEscortRecord={addBusinessEscortRecord} onRemoveEscortRecord={removeBusinessEscortRecord} />}
    </main>
  )
}

createRoot(document.getElementById('pet-root')!).render(
  <StrictMode><Pet /></StrictMode>
)
