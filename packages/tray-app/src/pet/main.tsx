import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PetAvatar, type PetVisualState } from './PetAvatar'
import { PetBubble, type Candidate, type NativeImageMatch, type PetLookupOption, type PetPanel } from './PetBubble'
import { orderAmountChange } from './orderAmountRules'
import { applyHospitalSuggestion } from './hospitalSuggestion'
import { OrderPicker } from './OrderPicker'
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
  const [panelResumed, setPanelResumed] = useState(false)
  const committedLookupSelections = useRef<Record<string, string>>({})
  const escortIndexCounter = useRef({ panelId: '', value: 0 })
  const escortSelections = useRef<Record<string, { id: string; phone: string }>>({})
  const [mode, setMode] = useState<PetMode>('idle')
  const [message, setMessage] = useState('把图片拖给我吧')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [nativeImageMatch, setNativeImageMatch] = useState<NativeImageMatch | null>(null)
  const [imageMatchError, setImageMatchError] = useState<string | null>(null)
  const activeImageMatch = useRef<NativeImageMatch | null>(null)
  const imageMatchQueue = useRef<NativeImageMatch[]>([])
  const deferredReminders = useRef<string[]>([])
  const [selectedApplicationNo, setSelectedApplicationNo] = useState<string | null>(null)
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

  const displayImageMatch = (match: NativeImageMatch): void => {
    setImageMatchError(null)
    activeImageMatch.current = match
    setNativeImageMatch(match)
    setSelectedApplicationNo(match.applicationNo)
    setCandidates([])
    setMode('candidates')
    announce('我识别到一张挂号凭证，请确认申领号和订单', true)
  }
  const enqueueImageMatch = (match: NativeImageMatch): void => {
    const key = (value: NativeImageMatch): string => value.source === 'drop' ? 'drop' : `chat:${value.attachmentId}`
    if (activeImageMatch.current && key(activeImageMatch.current) === key(match)) return
    if (imageMatchQueue.current.some((item) => key(item) === key(match))) return
    if (activeImageMatch.current) imageMatchQueue.current.push(match)
    else displayImageMatch(match)
  }
  const finishImageMatch = (): void => {
    activeImageMatch.current = null
    setNativeImageMatch(null)
    setSelectedApplicationNo(null)
    const next = imageMatchQueue.current.shift()
    if (next) displayImageMatch(next)
    else {
      const reminder = deferredReminders.current.splice(0).join('\n')
      if (reminder) {
        setMode('warning')
        announce(reminder, true)
      }
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
      if (status.imageMatch) {
        enqueueImageMatch(status.imageMatch as NativeImageMatch)
        return
      }
      if (activeImageMatch.current) return
      setMode(status.state)
      announce(status.message, status.state === 'done' || status.state === 'unknown' || status.state === 'candidates')
      setCandidates((status.candidates ?? []) as Candidate[])
      if (status.state === 'done' || status.state === 'unknown') {
        setNativeImageMatch(null)
        setSelectedApplicationNo(null)
      }
    })
    const unsubscribeImageMatch = window.api.onPetImageMatch((match) => {
      enqueueImageMatch(match)
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
        const message = error instanceof Error ? error.message : String(error)
        petDebug('drop:ipc-error', { message })
        setMode('unknown')
        announce(message.includes('未启用图片 AI 分析')
          ? '后台暂未开启图片识别功能，请联系管理员'
          : '处理文件时出错了，请稍后再试', true)
        return
      }
      const visualWait = Math.max(0, 900 - (performance.now() - visualStartedAt))
      if (visualWait > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, visualWait))
      petDebug('drop:result', { state: result.state })
      if (receivingTimer.current !== null) {
        window.clearTimeout(receivingTimer.current)
        receivingTimer.current = null
      }
      if (result.imageMatch) {
        enqueueImageMatch(result.imageMatch as NativeImageMatch)
        if (activeImageMatch.current) setMode('candidates')
        return
      }
      if (activeImageMatch.current) {
        setMode('candidates')
        return
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
      unsubscribeImageMatch()
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
        escortSelections.current = {}
        escortIndexCounter.current = { panelId: '', value: 0 }
        setBusinessPanel(null)
        setBusinessPanelVisible(false)
        return
      }
      const nextPanel = value as PetPanel
      if (nextPanel.kind === 'form') {
        if (escortIndexCounter.current.panelId !== nextPanel.id) {
          escortIndexCounter.current = { panelId: nextPanel.id, value: 0 }
          escortSelections.current = Object.fromEntries(nextPanel.fields.flatMap((field) => {
            const match = field.id.match(/^escort-(\d+)-name$/)
            if (!match || !/^\d+$/.test(String(field.value))) return []
            const phone = nextPanel.fields.find((item) => item.id === `escort-${match[1]}-phone`)
            return [[match[1], { id: String(field.value), phone: String(field.originalPhone ?? phone?.value ?? '') }]]
          }))
        }
        for (const section of nextPanel.sections ?? []) escortIndexCounter.current.value = Math.max(escortIndexCounter.current.value, Number(section.id.match(/^escort-(\d+)$/)?.[1] ?? 0))
        if (nextPanel.submitState === 'submitting' && nextPanel.submitMessage?.startsWith('填单完成')) {
          for (const [index, selection] of Object.entries(escortSelections.current)) {
            const phone = nextPanel.fields.find((field) => field.id === `escort-${index}-phone`)
            if (phone) selection.phone = String(phone.value ?? '')
          }
        }
      }
      setPanelResumed(false)
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
    const unsubscribeVisibility = window.api.onPetPanelVisibility((visible) => {
      if (!visible) setPanelResumed(true)
      setBusinessPanelVisible(visible)
    })
    void window.api.getPetPanel().then((value) => { if (!receivedEvent) apply(value) })
    return () => { mounted = false; unsubscribe(); unsubscribeVisibility() }
  }, [])

  useEffect(() => {
    const unsubscribeStatus = window.api.onPetMobileStatus(setMobileStatus)
    const unsubscribeReminder = window.api.onPetReminder((reminder) => {
      if (activeImageMatch.current) {
        deferredReminders.current.push(reminder)
        return
      }
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

  const panel: PetPanel | null = (mode === 'candidates' && nativeImageMatch !== null
    ? { kind: 'image-match', match: nativeImageMatch, selectedApplicationNo }
    : null) ?? (businessPanelVisible ? businessPanel : null) ?? (mode === 'candidates' && candidates.length > 0
    ? { kind: 'candidate-list', title: '请选择这张凭证对应的订单', items: candidates }
    : mode === 'unknown' || mode === 'warning'
      ? { kind: 'error', text: message }
      : mode === 'working' || mode === 'receiving'
        ? { kind: 'progress', text: message }
        : mode === 'done' || speaking
            ? { kind: 'speech', text: message }
            : null)

  const changeBusinessField = (fieldId: string, value: string, selectedOption?: PetLookupOption): void => {
    if (businessPanel?.kind === 'form' && businessPanel.submitState === 'submitting') return
    if (fieldId.startsWith('__hospital_suggestion:')) {
      const target = fieldId.slice('__hospital_suggestion:'.length)
      if (!['hospital', 'hospitalAddress', 'department', 'doctor'].includes(target)) return
      delete committedLookupSelections.current[target]
      setBusinessPanel((current) => current?.kind !== 'form' ? current : { ...current, fields: applyHospitalSuggestion(current.fields, target, value) })
      return
    }
    if (fieldId === '__hospital_suggestion_group') {
      committedLookupSelections.current = {}
      setBusinessPanel((current) => current?.kind !== 'form' ? current : {
        ...current, fields: current.fields.map((field) => ['hospital', 'hospitalAddress', 'department', 'doctor'].includes(field.id)
          ? { ...field, value: field.suggestion ?? '', suggestion: undefined, aiPrefill: Boolean(field.suggestion), hint: undefined }
          : field)
      })
      return
    }
    if (fieldId.startsWith('master:')) {
      setBusinessPanel((current) => {
        if (current?.kind !== 'form' || !current.confirmation) return current
        const match = current.confirmation.review.find((item) => item.fields.some((field) => `master:${item.key}:${field.id}` === fieldId))
        if (!match) return current
        const changedId = fieldId.slice(`master:${match.key}:`.length)
        return { ...current, confirmation: { ...current.confirmation, review: current.confirmation.review.map((item) => item.key !== match.key ? item : {
          ...item, fields: item.fields.map((field) => ({ ...field,
            value: field.id === changedId ? value :
              (changedId === 'province' && field.id === 'city') || (changedId === 'internalOne' && field.id === 'internalTwo') ? '' : field.value
          }))
        }) } }
      })
      return
    }
    const escortName = fieldId.match(/^escort-(\d+)-name$/)
    if (escortName) {
      if (selectedOption) escortSelections.current[escortName[1]] = { id: selectedOption.id, phone: selectedOption.phone ?? '' }
      else if (escortSelections.current[escortName[1]]?.id !== value) delete escortSelections.current[escortName[1]]
    }
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
    } else if (!selectedOption && (fieldId === 'hospital' || fieldId === 'department') && value !== currentValue) {
      resetFields = fieldId === 'hospital' ? ['hospitalAddress', 'department', 'doctor'] : ['doctor']
      delete committedLookupSelections.current[fieldId]
    }
    setBusinessPanel((current) => {
      if (current?.kind !== 'form') return current
      const reset = new Set(resetFields)
      const currentRequest = current.fields.find((field) => field.id === 'requestTime')?.value
      const currentResponse = current.fields.find((field) => field.id === 'responseTime')?.value
      const mirrorResponse = fieldId === 'requestTime' && (!currentResponse || currentResponse === currentRequest)
      const previousStatus = String(current.fields.find((field) => field.id === 'orderStatus')?.value ?? '')
      const serviceField = current.fields.find((field) => field.id === 'channelService')
      const service = fieldId === 'channelService' ? value : String(serviceField?.value ?? '')
      const price = serviceField?.options?.find((option) => option.value === service)?.price ?? ''
      const currentEditable = String(current.fields.find((field) => field.id === 'amountChanged')?.value ?? 'false') === 'true'
      const { amount: nextAmount, editable, cancelled, missingPrice } = orderAmountChange({ fieldId, value, previousStatus, selectedService: service, originalService: current.originalService ?? '', originalAmount: current.originalAmount ?? '', originalStatus: current.originalStatus ?? '', servicePrice: price, editable: currentEditable })
      const editedPhoneIndex = fieldId.match(/^escort-(\d+)-phone$/)?.[1]
      const editedPhonePerson = editedPhoneIndex ? escortSelections.current[editedPhoneIndex]?.id : undefined
      return { ...current, fields: current.fields.map((field) => {
        const phoneIndex = field.id.match(/^escort-(\d+)-phone$/)?.[1]
        if (editedPhonePerson && phoneIndex && escortSelections.current[phoneIndex]?.id === editedPhonePerson) return { ...field, value, aiPrefill: false, suggestion: field.suggestion === value ? undefined : field.suggestion }
        if (field.id === 'orderAmount') return { ...field, value: fieldId === 'orderAmount' ? value : nextAmount ?? String(field.value), readOnly: !editable, error: missingPrice ? '未找到服务项目价格，请核对金额' : fieldId === 'orderAmount' || nextAmount !== undefined ? undefined : field.error }
        if (field.id === 'amountChanged') return { ...field, value: String(editable), readOnly: cancelled }
        if (field.id === fieldId || (mirrorResponse && field.id === 'responseTime')) return { ...field, value, aiPrefill: false, hint: undefined, suggestion: ['hospital', 'hospitalAddress', 'department', 'doctor'].includes(field.id) ? field.suggestion : field.suggestion === value ? undefined : field.suggestion }
        return reset.has(field.id) ? { ...field, value: '', hint: undefined, aiPrefill: false } : field
      }) }
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
      }, escortIndexCounter.current.value) + 1
      escortIndexCounter.current.value = nextIndex
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
      const removedIndex = sectionId.match(/^escort-(\d+)$/)?.[1]
      if (removedIndex) delete escortSelections.current[removedIndex]
      const removed = new Set(section.fieldIds)
      const sections = current.sections.filter((item) => item.id !== sectionId)
      const fields = current.fields.filter((field) => !removed.has(field.id))
      if (!sections.some((item) => item.repeatable)) {
        const index = ++escortIndexCounter.current.value
        const prefix = `escort-${index}`
        fields.push({ id: `${prefix}-date`, label: '服务日期/时间', type: 'datetime-local', value: '', placeholder: '请选择服务日期/时间' }, { id: `${prefix}-name`, label: '陪诊人', type: 'text', value: '', placeholder: '请输入陪诊人' }, { id: `${prefix}-phone`, label: '陪诊电话', type: 'text', value: '', placeholder: '请输入陪诊电话' })
        sections.push({ id: prefix, title: `陪诊服务 ${index}`, fieldIds: [`${prefix}-date`, `${prefix}-name`, `${prefix}-phone`], repeatable: true })
      }
      return { ...current, sections, fields }
    })
  }

  const businessAction = (actionId: string): void => {
    if (!businessPanel || !('id' in businessPanel) || typeof businessPanel.id !== 'string') return
    const fields = businessPanel.kind === 'form'
      ? Object.fromEntries([...businessPanel.fields.map((field) => [field.id, field.value]),
        ...Object.entries(escortSelections.current).flatMap(([index, selection]) => [[`escort-${index}-expected-id`, selection.id], [`escort-${index}-expected-phone`, selection.phone]]),
        ...(businessPanel.confirmation?.review.flatMap((item) => item.fields.map((field) => [`master:${item.key}:${field.id}`, field.value])) ?? [])])
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

  const selectImageApplication = (applicationNo: string): void => {
    setSelectedApplicationNo(applicationNo)
  }

  const resolveImageOrder = (applicationNo: string, orderId: number | null, manualSelection = false): void => {
    const match = nativeImageMatch
    if (!match) return
    setImageMatchError(null)
    if (match.source === 'drop') {
      if (orderId === null) {
        setSelectedApplicationNo(applicationNo)
        announce('申领号已选好，请再确认具体订单；图片暂未上传。')
        return
      }
      setMode('working')
      announce('正在把图片保存到你选定的订单…')
      void window.api.petSelectOrder(orderId, applicationNo, manualSelection).then((result) => {
        setMode(result.state)
        announce(result.message, true)
        finishImageMatch()
      }).catch((error: unknown) => {
        setMode('candidates')
        setImageMatchError(error instanceof Error ? error.message : '图片保存失败')
      })
      return
    }
    if (match.attachmentId === undefined) return
    setMode('working')
    announce('正在保存匹配结果…')
    void window.api.resolveNativeImageMatch({ attachmentId: match.attachmentId, applicationNo, orderId, manualSelection }).then((result) => {
      setMode('done')
      announce(result.message, true)
      finishImageMatch()
    }).catch((error: unknown) => {
      setMode('candidates')
      setImageMatchError(error instanceof Error ? error.message : '保存匹配结果失败')
    })
  }

  const discardImageMatch = (): void => {
    const match = nativeImageMatch
    if (!match) return
    setImageMatchError(null)
    const dismiss = match.source === 'drop' ? window.api.petDiscardPendingImage()
      : match.attachmentId !== undefined ? window.api.dismissNativeImageMatch(match.attachmentId)
        : Promise.reject(new Error('图片编号缺失'))
    void dismiss.then(() => {
      setMode('idle')
      announce('已放弃关联，图片和识别记录会保留。')
      finishImageMatch()
    }).catch((error: unknown) => {
      setMode('candidates')
      setImageMatchError(error instanceof Error ? error.message : '保存结果失败')
    })
  }

  const pickOtherImageOrder = (): void => {
    setImageMatchError(null)
    void window.api.petPickOtherOrder().then((selection) => {
      if (selection) resolveImageOrder(selection.applicationNo, selection.orderId, true)
    }).catch((error: unknown) => setImageMatchError(error instanceof Error ? error.message : '无法打开订单列表'))
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

  const resizeBubble = useCallback((size: { width: number; height: number }): void => {
    void window.api.setPetBubbleSize(size).then((layout) => setBubbleSide(layout.bubbleSide))
  }, [])

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
      {expanded && panel !== null && <PetBubble
        panel={panel}
        onClose={() => { if (panel === businessPanel && businessPanelVisible && businessPanel) void window.api.hidePetPanel(); setMode('idle'); setSpeaking(false) }}
        skipEntranceAnimation={panelResumed && panel === businessPanel}
        onSelectCandidate={selectCandidate}
        onSelectApplication={selectImageApplication}
        onResolveImageOrder={resolveImageOrder}
        onDiscardImageMatch={discardImageMatch}
        onPickOtherImageOrder={pickOtherImageOrder}
        imageMatchError={imageMatchError}
        onFieldChange={changeBusinessField}
        onLookup={lookupOrderDictionary}
        onAction={businessAction}
        onSizeChange={resizeBubble}
        onAddEscortRecord={addBusinessEscortRecord}
        onRemoveEscortRecord={removeBusinessEscortRecord}
      />}
    </main>
  )
}

createRoot(document.getElementById('pet-root')!).render(
  <StrictMode>{new URLSearchParams(window.location.search).has('orderPicker') ? <OrderPicker /> : <Pet />}</StrictMode>
)
