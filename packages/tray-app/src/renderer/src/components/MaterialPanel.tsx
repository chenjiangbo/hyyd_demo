import { useCallback, useEffect, useRef, useState } from 'react'
// MaterialViewRow / MaterialSyncCounts 是全局类型（见 env.d.ts），preload 暴露的

interface Props {
  orderId: number
}

/**
 * 订单详情模态内的"素材录入"主体。
 *
 * 两条等价的粘贴入口：
 *   1. 顶部「📋 从剪贴板导入」按钮
 *   2. 模态打开期间，本面板根节点监听 paste 事件
 *
 * 一次粘贴可能带多个 ClipboardItem（混合文字 + 图片），每个都各成一条素材。
 * 落地走 main 进程 IPC，立刻返回 view row 追加进时间线；
 * 上传由后台 sync worker 异步处理。
 */
export default function MaterialPanel({ orderId }: Props): React.JSX.Element {
  const [items, setItems] = useState<MaterialViewRow[]>([])
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<string | null>(null) // 短暂提示，如"已粘贴 2 条"
  const [manualOpen, setManualOpen] = useState(false)
  const [manualText, setManualText] = useState('')
  const [counts, setCounts] = useState<MaterialSyncCounts>({
    pending: 0,
    syncing: 0,
    failed: 0,
    pendingDelete: 0
  })
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 初始拉本地条目
  const reload = useCallback(async () => {
    const list = await window.api!.materialsList(orderId)
    setItems(list)
  }, [orderId])

  useEffect(() => {
    void reload()
  }, [reload])

  // 周期刷新：同步状态 + 列表（同步完成后 row.syncStatus 会变）
  useEffect(() => {
    const tick = async (): Promise<void> => {
      try {
        setCounts(await window.api!.materialsStatus(orderId))
        // 只在有"正在/未同步"项时才重拉列表，省一点
        const list = await window.api!.materialsList(orderId)
        setItems(list)
      } catch {/* 忽略 */}
    }
    const t = setInterval(tick, 3000)
    return () => clearInterval(t)
  }, [orderId])

  // ─── 粘贴处理 ───
  // 全部走 Electron 系统剪贴板（IPC），不依赖 navigator.clipboard。
  // 原因：
  //   1) navigator.clipboard.read() 要求 document focused，按钮触发常报
  //      "Document is not focused"
  //   2) 微信/企微复制的图片在 Windows 上是 CF_DIB/CF_BITMAP，
  //      navigator.clipboard 不一定识别，但 Electron 的 nativeImage 能正确读。
  //   3) 一次调用同时拿到 text + image，省一半逻辑。
  const ingestClipboard = useCallback(async () => {
    if (busy) return
    setBusy(true)
    let inserted = 0
    try {
      const { text, imageDataUrl } = await window.api!.clipboardRead()
      if (imageDataUrl) {
        await window.api!.materialsAddImage(orderId, imageDataUrl)
        inserted++
      }
      if (text && text.trim()) {
        await window.api!.materialsAddText(orderId, text.trim())
        inserted++
      }
      if (inserted > 0) {
        setFlash(`已粘贴 ${inserted} 条`)
        setTimeout(() => setFlash(null), 1800)
        await reload()
      } else {
        setFlash('剪贴板里没有可识别的文字或图片')
        setTimeout(() => setFlash(null), 2200)
      }
    } catch (e) {
      setFlash('粘贴失败：' + (e as Error).message)
      setTimeout(() => setFlash(null), 2400)
    } finally {
      setBusy(false)
    }
  }, [orderId, busy, reload])

  // 模态级 Ctrl+V 监听：调用浏览器 paste event 直接读 dataTransfer，
  // 不依赖 navigator.clipboard 权限（更适合 Electron）。
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onPaste = async (e: ClipboardEvent): Promise<void> => {
      // 在 input/textarea 里粘贴时不抢
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
        return
      }
      e.preventDefault()
      // 不走 ClipboardEvent.clipboardData（处理不了微信的图片格式），
      // 转发到 Electron 系统剪贴板读取，逻辑跟按钮触发完全一致。
      await ingestClipboard()
    }
    // 监听到 document 上，模态打开期间整个窗口的 Ctrl+V 都吃下去
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [ingestClipboard])

  // ─── 删除 ───
  const handleDelete = useCallback(
    async (id: number) => {
      if (!confirm('删除这条素材？删除后不可恢复。')) return
      await window.api!.materialsDelete(id)
      await reload()
    },
    [reload]
  )

  const handleRetry = useCallback(async () => {
    await window.api!.materialsRetryFailed()
    setCounts(await window.api!.materialsStatus(orderId))
  }, [])

  // ─── 手工录入（员工自己打字，给微信/电话语音留入口） ───
  const submitManual = useCallback(async () => {
    const text = manualText.trim()
    if (!text) return
    try {
      await window.api!.materialsAddText(orderId, text)
      setManualText('')
      setManualOpen(false)
      setFlash('已录入 1 条')
      setTimeout(() => setFlash(null), 1500)
      await reload()
    } catch (e) {
      setFlash('录入失败：' + (e as Error).message)
      setTimeout(() => setFlash(null), 2400)
    }
  }, [orderId, manualText, reload])

  const cancelManual = useCallback(() => {
    setManualText('')
    setManualOpen(false)
  }, [])

  return (
    <section ref={rootRef} className="px-5 py-4 bg-bg">
      {/* 录入入口 */}
      <div className="ring-1 ring-line rounded-md bg-surface px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void ingestClipboard()}
          disabled={busy}
          className="h-8 px-3 text-[13px] rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          📋 粘贴
        </button>
        <button
          type="button"
          onClick={() => setManualOpen((v) => !v)}
          className="h-8 px-3 text-[13px] rounded bg-surface-2 text-fg ring-1 ring-line hover:bg-surface-3 transition-colors whitespace-nowrap"
        >
          ✏️ 手工录入
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-fg">
            或在本窗口直接按 <kbd className="px-1 py-0.5 text-[11px] bg-surface-2 ring-1 ring-line rounded">Ctrl+V</kbd>
          </div>
          <div className="text-[11px] text-fg-muted mt-0.5">
            微信/企微的文字和图片用「粘贴」；电话或语音通话的关键信息用「手工录入」
          </div>
        </div>
        <SyncDot counts={counts} onRetry={handleRetry} />
      </div>

      {/* 手工录入展开区 */}
      {manualOpen && (
        <div className="mt-2 ring-1 ring-line rounded-md bg-surface p-3">
          <textarea
            autoFocus
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                cancelManual()
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void submitManual()
              }
            }}
            rows={5}
            placeholder="把电话/语音通话里的关键信息写下来。例：客户希望周五上午去医院，已带身份证；提到曾在北医三院就诊过，主诉胸闷……"
            className="w-full px-3 py-2 bg-bg ring-1 ring-line focus:ring-accent rounded text-[13px] text-fg placeholder-fg-subtle outline-none resize-y font-sans"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-fg-subtle">
              <kbd className="px-1 py-0.5 bg-surface-2 ring-1 ring-line rounded">Ctrl/⌘+Enter</kbd> 保存 ·
              <kbd className="ml-1 px-1 py-0.5 bg-surface-2 ring-1 ring-line rounded">Esc</kbd> 取消
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={cancelManual}
                className="h-7 px-3 text-[12px] rounded ring-1 ring-line bg-surface hover:bg-surface-2 text-fg-muted"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitManual()}
                disabled={!manualText.trim()}
                className="h-7 px-3 text-[12px] rounded bg-accent text-white hover:bg-accent-strong disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {flash && (
        <div className="mt-2 text-[12px] text-fg-muted bg-accent-soft/50 ring-1 ring-accent/30 rounded px-3 py-1.5">
          {flash}
        </div>
      )}

      {/* 时间线 */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[12px] font-medium text-fg-muted uppercase tracking-wide">
            素材时间线
          </h3>
          <span className="text-[11px] text-fg-subtle">
            共 {items.length} 条 · 最新在上
          </span>
        </div>

        {items.length === 0 ? (
          <div className="border border-dashed border-line rounded-md py-10 text-center text-[12px] text-fg-subtle">
            还没有素材。粘贴一段聊天文字或截图试试 →
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((m) => (
              <MaterialItem key={m.id} m={m} onDelete={() => handleDelete(m.id)} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ────────────────────────────────────────────────────────────────

function MaterialItem({
  m,
  onDelete
}: {
  m: MaterialViewRow
  onDelete: () => void
}): React.JSX.Element {
  return (
    <li className="bg-surface ring-1 ring-line rounded-md p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] text-fg-muted">
          {m.type === 'text' ? '💬 文字' : '📷 图片'}
        </span>
        <span className="text-[11px] text-fg-subtle">· {formatTime(m.createdAt)}</span>
        <SyncTag status={m.syncStatus} />
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDelete}
          className="text-[12px] px-2 py-0.5 rounded text-fg-muted ring-1 ring-line bg-surface hover:bg-red-50 hover:text-danger hover:ring-danger/40 transition-colors"
          title="删除这条素材"
        >
          🗑 删除
        </button>
      </div>
      {m.type === 'text' ? (
        <pre className="text-[13px] text-fg whitespace-pre-wrap break-words font-sans">
          {m.textContent}
        </pre>
      ) : m.imageDataUrl ? (
        <img
          src={m.imageDataUrl}
          alt="粘贴的图片"
          className="max-h-64 rounded ring-1 ring-line object-contain"
        />
      ) : (
        <div className="text-[12px] text-danger">⚠️ 图片本地文件读取失败</div>
      )}
      {m.byteSize != null && (
        <div className="mt-1 text-[10px] text-fg-subtle text-right">
          {(m.byteSize / 1024).toFixed(0)} KB
        </div>
      )}
    </li>
  )
}

function SyncTag({ status }: { status: MaterialViewRow['syncStatus'] }): React.JSX.Element | null {
  // synced / tombstone 不显示标签，免得视觉太吵
  const map: Partial<Record<MaterialViewRow['syncStatus'], { txt: string; cls: string }>> = {
    pending: { txt: '待同步', cls: 'text-fg-muted bg-surface-2' },
    syncing: { txt: '同步中', cls: 'text-info bg-blue-50' },
    failed: { txt: '失败', cls: 'text-danger bg-red-50' },
    pending_delete: { txt: '待删除', cls: 'text-fg-muted bg-surface-2' }
  }
  const it = map[status]
  if (!it) return null
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${it.cls}`}>{it.txt}</span>
}

function SyncDot({
  counts,
  onRetry
}: {
  counts: MaterialSyncCounts
  onRetry: () => void
}): React.JSX.Element {
  const queueing = counts.pending + counts.syncing + counts.pendingDelete
  if (counts.failed > 0) {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 text-[11px] text-danger ring-1 ring-danger/30 bg-red-50 rounded px-2 py-1 hover:bg-red-100 transition-colors"
        title="点击重新加入同步队列"
      >
        🔴 失败 {counts.failed} · 点击重试
      </button>
    )
  }
  if (queueing > 0) {
    return (
      <span
        className="shrink-0 text-[11px] text-fg-muted bg-surface-2 ring-1 ring-line rounded px-2 py-1"
        title="后台正在上传"
      >
        ⚪ 同步中 {queueing}
      </span>
    )
  }
  return (
    <span
      className="shrink-0 text-[11px] text-success ring-1 ring-line bg-surface-2 rounded px-2 py-1"
      title="所有素材已同步到后端"
    >
      🟢 已同步
    </span>
  )
}

// ───── helpers ─────
function formatTime(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (sameDay) return `今天 ${hm}`
  const md = d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  return `${md} ${hm}`
}

