import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type PetMode = 'idle' | 'dragover' | 'working' | 'done' | 'unknown' | 'candidates'
type Candidate = { orderId: number; sourceOrderNo: string; customerName: string; hospital: string | null; department: string | null; appointmentDate: string | null }

function Pet(): React.JSX.Element {
  const [mode, setMode] = useState<PetMode>('idle')
  const [message, setMessage] = useState('把图片拖给我吧')
  const [candidates, setCandidates] = useState<Candidate[]>([])

  useEffect(() => {
    const unsubscribe = window.api.onPetStatus((status) => {
      setMode(status.state)
      setMessage(status.message)
      setCandidates((status.candidates ?? []) as Candidate[])
    })
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault()
      event.dataTransfer!.dropEffect = 'copy'
      setMode('dragover')
      setMessage('收到啦，松开手吧')
    }
    const onDragLeave = (event: DragEvent): void => {
      if (event.relatedTarget === null) {
        setMode('idle')
        setMessage('把图片拖给我吧')
      }
    }
    const onDrop = async (event: DragEvent): Promise<void> => {
      event.preventDefault()
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) {
        setMode('unknown')
        setMessage('嗯…我没有接到文件')
        return
      }
      const first = files[0]
      const filePath = window.api.getPathForFile(first)
      if (!filePath) {
        setMode('unknown')
        setMessage('嗯…我没有拿到这个文件')
        return
      }
      setMode('working')
      setMessage('让我看一看这张图片…')
      const result = await window.api.petDropFiles([filePath])
      setMode(result.state)
      setMessage(result.message)
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
    }
  }, [])

  return (
    <main className={`pet-shell pet-${mode}`}>
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
                setMessage('好，我保存到这个订单…')
                void window.api.petSelectOrder(candidate.orderId).then((result) => {
                  setMode(result.state)
                  setMessage(result.message)
                  setCandidates((result.candidates ?? []) as Candidate[])
                }).catch((error: unknown) => {
                  setMode('unknown')
                  setMessage(error instanceof Error ? error.message : '订单保存失败了')
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
