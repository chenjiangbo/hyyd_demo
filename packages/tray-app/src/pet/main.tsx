import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type PetMode = 'idle' | 'dragover' | 'working' | 'done' | 'unknown' | 'candidates'
type Candidate = { orderId: number; sourceOrderNo: string; customerName: string; hospital: string | null; department: string | null; appointmentDate: string | null }

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
  const [mode, setMode] = useState<PetMode>('idle')
  const [message, setMessage] = useState('把图片拖给我吧')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [speaking, setSpeaking] = useState(false)
  const speakingTimer = useRef<number | null>(null)

  const announce = (nextMessage: string): void => {
    setMessage(nextMessage)
    setSpeaking(true)
    if (speakingTimer.current !== null) window.clearTimeout(speakingTimer.current)
    speakingTimer.current = window.setTimeout(() => {
      setSpeaking(false)
      speakingTimer.current = null
    }, 1800)
  }

  useEffect(() => {
    const unsubscribe = window.api.onPetStatus((status) => {
      setMode(status.state)
      announce(status.message)
      setCandidates((status.candidates ?? []) as Candidate[])
    })
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer!.dropEffect = 'copy'
      setMode('dragover')
      announce('收到啦，松开手吧')
    }
    const onDragLeave = (event: DragEvent): void => {
      if (event.relatedTarget === null) {
        setMode('idle')
        announce('把图片拖给我吧')
      }
    }
    const onDrop = async (event: DragEvent): Promise<void> => {
      event.preventDefault()
      event.stopPropagation()
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
        setMode('unknown')
        announce('嗯…我没有接到文件')
        return
      }
      setMode('working')
      announce('让我看一看这张图片…')
      const result = await window.api.petDropFiles([paths[0]])
      setMode(result.state)
      announce(result.message)
      setCandidates((result.candidates ?? []) as Candidate[])
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      unsubscribe()
      if (speakingTimer.current !== null) window.clearTimeout(speakingTimer.current)
    }
  }, [])

  return (
    <main className={`pet-shell pet-${mode} ${speaking ? 'pet-speaking' : ''}`}>
      <button className="pet-close" type="button" aria-label="隐藏精灵" onClick={() => window.api.hidePet()}>
        ×
      </button>
      <div className="pet-aura" aria-hidden="true" />
      <div className="pet-antenna" aria-hidden="true"><i /></div>
      <div className="pet-body">
        <div className="pet-screen"><span>{mode === 'working' ? '...' : mode === 'done' ? 'OK' : 'NULL'}</span></div>
        <div className="pet-arm pet-arm-left" aria-hidden="true" />
        <div className="pet-arm pet-arm-right" aria-hidden="true" />
        <div className="pet-feet" aria-hidden="true"><i /><i /></div>
      </div>
      <div className="pet-message">{message}</div>
      {mode === 'candidates' && candidates.length > 0 && (
        <div className="pet-candidates">
          {candidates.map((candidate, index) => (
            <button
              className="pet-candidate"
              key={candidate.orderId}
              type="button"
              onClick={() => {
                setMode('working')
                announce('好，我保存到这个订单…')
                void window.api.petSelectOrder(candidate.orderId).then((result) => {
                  setMode(result.state)
                  announce(result.message)
                  setCandidates((result.candidates ?? []) as Candidate[])
                }).catch((error: unknown) => {
                  setMode('unknown')
                  announce(error instanceof Error ? error.message : '订单保存失败了')
                })
              }}
            >
              <strong>{index === 0 ? '可能的订单 · ' : ''}{candidate.customerName || '未识别患者'}</strong>
              <span>{candidate.hospital || '医院待确认'} · {candidate.department || '科室待确认'}</span>
              <small>{candidate.sourceOrderNo}</small>
            </button>
          ))}
        </div>
      )}
    </main>
  )
}

createRoot(document.getElementById('pet-root')!).render(
  <StrictMode><Pet /></StrictMode>
)
