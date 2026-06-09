// ─────────────────────────────────────────────────────────────
// 素材同步 worker（main 进程后台）。
//
// 策略：
//   - 每 10s 扫一轮 pending / pending_delete
//   - 每条最多并发处理 1 个（避免上传抖动 + 简化错误处理）
//   - kick() 让外部触发即时同步（粘贴或删除完立刻触发）
//   - 失败 3 次降级为 failed，UI 手动重试
//
// 配置：backendUrl + employeeCode 由渲染端通过 materials:set-config IPC 推过来。
// 没拿到配置时不发请求（避免启动早期空跑）。
// ─────────────────────────────────────────────────────────────

import type { MaterialStore, MaterialRow } from './material-store'

const TICK_INTERVAL_MS = 10_000
const BATCH_PER_TICK = 5

export interface SyncConfig {
  backendUrl: string   // 例 http://192.168.202.1:13000
  employeeCode: string // 例 W001
}

export class MaterialSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private config: SyncConfig | null = null

  constructor(private readonly store: MaterialStore) {}

  setConfig(cfg: SyncConfig): void {
    this.config = {
      backendUrl: cfg.backendUrl.trim().replace(/\/$/, ''),
      employeeCode: cfg.employeeCode.trim()
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
    // 启动后立刻空跑一次（不阻塞）
    void this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 外部触发：刚 add / delete 完，不必等下一个 tick */
  kick(): void {
    void this.tick()
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    if (!this.config || !this.config.backendUrl || !this.config.employeeCode) return
    this.ticking = true
    try {
      const batch = this.store.pickPending(BATCH_PER_TICK)
      for (const row of batch) {
        await this.processOne(row).catch((e) => {
          console.warn(`[material-sync] #${row.id} 处理异常:`, (e as Error).message)
        })
      }
    } finally {
      this.ticking = false
    }
  }

  private async processOne(row: MaterialRow): Promise<void> {
    if (row.syncStatus === 'pending') {
      await this.upload(row)
    } else if (row.syncStatus === 'pending_delete') {
      await this.remoteDelete(row)
    }
  }

  // ─── 上传 ───
  private async upload(row: MaterialRow): Promise<void> {
    this.store.markSyncing(row.id)
    try {
      const body: Record<string, unknown> = {
        type: row.type,
        clientUuid: row.clientUuid
      }
      if (row.type === 'text') {
        body.textContent = row.textContent ?? ''
      } else if (row.type === 'image') {
        const img = this.store.readImageBase64(row)
        if (!img) {
          throw new Error('本地图片文件丢失')
        }
        body.mimeType = img.mimeType
        body.base64 = img.base64
      }
      const resp = await this.fetchJson(
        `POST`,
        `/api/v1/orders/${row.orderId}/materials`,
        body
      )
      const remoteId = (resp?.data?.id as number | undefined) ?? null
      this.store.markSynced(row.id, remoteId)
      console.log(`[material-sync] ↑ #${row.id} -> remote ${remoteId}`)
    } catch (e) {
      const msg = (e as Error).message
      console.warn(`[material-sync] ↑ #${row.id} 失败: ${msg}`)
      this.store.markFailed(row.id, msg)
    }
  }

  // ─── 远端删除 ───
  private async remoteDelete(row: MaterialRow): Promise<void> {
    if (!row.remoteId) {
      // 已同步状态下被删，但 remoteId 为空——不太可能，兜底直接 tombstone
      this.store.markTombstone(row.id)
      return
    }
    try {
      await this.fetchJson(`DELETE`, `/api/v1/materials/${row.remoteId}`)
      this.store.markTombstone(row.id)
      console.log(`[material-sync] ✕ #${row.id} (remote ${row.remoteId})`)
    } catch (e) {
      const msg = (e as Error).message
      console.warn(`[material-sync] ✕ #${row.id} 失败: ${msg}`)
      this.store.markFailed(row.id, msg)
    }
  }

  // ─── 统一 HTTP 帮手 ───
  private async fetchJson(
    method: 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<any> {
    const cfg = this.config!
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    try {
      const res = await fetch(`${cfg.backendUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Employee-Code': cfg.employeeCode
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
      }
      const ctype = res.headers.get('content-type') || ''
      if (ctype.includes('application/json')) return res.json()
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
