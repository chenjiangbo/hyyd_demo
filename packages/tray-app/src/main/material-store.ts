// ─────────────────────────────────────────────────────────────
// 现场采集"粘贴素材"的本地落地层。
//
// 设计目标：
//   1. 本地优先：员工 Ctrl+V 后立刻落本地 sqlite + 文件系统，
//      渲染端 0 等待返回，UI 立即出现新条目。
//   2. 异步同步：sync worker 按 sync_status='pending' 上传到后端
//      (REST POST /api/v1/orders/:id/materials)。
//   3. 幂等：client_uuid 由本地生成，后端 upsert 用 (orderId, clientUuid)
//      作唯一键，离线补传不会双插。
//   4. 软删：删除标记 deleted=1 + sync_status='pending_delete'，
//      sync worker 处理远端 DELETE，成功后再物理删本地。
//
// 不放在 capture-store 里：那个表是截图链路的，跟素材是两个生命周期，
// 解耦后续也好独立维护。
// ─────────────────────────────────────────────────────────────

import Database from 'better-sqlite3'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'

export type MaterialType = 'text' | 'image'
export type MaterialSyncStatus =
  | 'pending'        // 待上传
  | 'syncing'        // 上传中（worker 正在处理）
  | 'synced'         // 已上传
  | 'failed'         // 多次失败，需要手动重试
  | 'pending_delete' // 已被员工删，待远端 DELETE
  | 'tombstone'      // 远端已删（本地保留只为占位，定期 vacuum）

export interface MaterialRow {
  id: number
  orderId: number
  clientUuid: string
  type: MaterialType
  textContent: string | null
  imageLocalPath: string | null
  mimeType: string | null
  byteSize: number | null
  syncStatus: MaterialSyncStatus
  syncAttempts: number
  syncError: string | null
  remoteId: number | null
  remoteUrl: string | null
  createdAt: number
  syncedAt: number | null
}

/** 给渲染端用的扁平形态：图片用 dataURL 直接渲染 */
export interface MaterialViewRow {
  id: number
  orderId: number
  type: MaterialType
  textContent: string | null
  imageDataUrl: string | null  // 本地文件直接读出来转 dataURL
  mimeType: string | null
  byteSize: number | null
  syncStatus: MaterialSyncStatus
  remoteUrl: string | null     // 同步后后端的 presigned URL，可选用
  createdAt: number
}

export class MaterialStore {
  private readonly db: Database.Database
  private readonly imageDir: string

  constructor(
    dbPath = join(app.getPath('userData'), 'materials', 'materials.db'),
    imageDir = join(app.getPath('userData'), 'materials', 'images')
  ) {
    mkdirSync(dirname(dbPath), { recursive: true })
    mkdirSync(imageDir, { recursive: true })
    this.imageDir = imageDir
    this.db = MaterialStore.openResilient(dbPath)
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private static openResilient(dbPath: string): Database.Database {
    const tryOpen = (): Database.Database => {
      const db = new Database(dbPath)
      try {
        db.pragma('journal_mode = WAL')
      } catch {
        db.pragma('journal_mode = DELETE')
      }
      return db
    }
    try {
      return tryOpen()
    } catch (e) {
      console.error('[material-store] 打开 DB 失败，清理重建:', (e as Error).message)
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
          rmSync(`${dbPath}${suffix}`, { force: true })
        } catch {/* */}
      }
      return tryOpen()
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS materials (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id        INTEGER NOT NULL,
        client_uuid     TEXT NOT NULL UNIQUE,
        type            TEXT NOT NULL,
        text_content    TEXT,
        image_local_path TEXT,
        mime_type       TEXT,
        byte_size       INTEGER,
        sync_status     TEXT NOT NULL DEFAULT 'pending',
        sync_attempts   INTEGER NOT NULL DEFAULT 0,
        sync_error      TEXT,
        remote_id       INTEGER,
        remote_url      TEXT,
        created_at      INTEGER NOT NULL,
        synced_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_materials_order ON materials(order_id);
      CREATE INDEX IF NOT EXISTS idx_materials_sync  ON materials(sync_status);
    `)
  }

  // ────────── 写入 ──────────

  /**
   * 落一条文字素材。
   * 返回 view row 给渲染端立刻渲染。
   */
  addText(orderId: number, text: string): MaterialViewRow {
    const clientUuid = randomUUID()
    const now = Date.now()
    const info = this.db
      .prepare(
        `INSERT INTO materials (order_id, client_uuid, type, text_content, byte_size,
                                sync_status, created_at)
         VALUES (?, ?, 'text', ?, ?, 'pending', ?)`
      )
      .run(orderId, clientUuid, text, Buffer.byteLength(text, 'utf-8'), now)
    return this.toViewRow(this.requireRow(Number(info.lastInsertRowid)))
  }

  /**
   * 落一条图片素材。
   * dataUrl 形如 "data:image/png;base64,iVBORw0..."；
   * 我们抠出 mime + base64，写本地文件，DB 只存路径。
   */
  addImage(orderId: number, dataUrl: string): MaterialViewRow {
    const parsed = parseDataUrl(dataUrl)
    if (!parsed) throw new Error('图片 dataURL 解析失败')
    const { mimeType, buffer } = parsed
    const clientUuid = randomUUID()
    const ext = (mimeType.split('/')[1] || 'bin').toLowerCase()
    const orderDir = join(this.imageDir, String(orderId))
    mkdirSync(orderDir, { recursive: true })
    const filePath = join(orderDir, `${clientUuid}.${ext}`)
    writeFileSync(filePath, buffer)
    const now = Date.now()
    const info = this.db
      .prepare(
        `INSERT INTO materials (order_id, client_uuid, type, image_local_path, mime_type,
                                byte_size, sync_status, created_at)
         VALUES (?, ?, 'image', ?, ?, ?, 'pending', ?)`
      )
      .run(orderId, clientUuid, filePath, mimeType, buffer.length, now)
    return this.toViewRow(this.requireRow(Number(info.lastInsertRowid)))
  }

  // ────────── 读出 ──────────

  /** 给渲染端的列表：按 createdAt 倒序，不含 tombstone */
  listForOrder(orderId: number): MaterialViewRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM materials
          WHERE order_id = ? AND sync_status != 'tombstone'
          ORDER BY created_at DESC`
      )
      .all(orderId) as RawRow[]
    return rows.map((r) => this.toViewRow(this.fromRaw(r)))
  }

  /** sync 状态计数。
   *  传 orderId → 只算该订单的素材（订单详情模态用）；
   *  不传 → 全局计数（StatusBar 用）。
   */
  countByStatus(orderId?: number): { pending: number; syncing: number; failed: number; pendingDelete: number } {
    const rows =
      orderId == null
        ? (this.db
            .prepare(`SELECT sync_status as s, COUNT(*) as n FROM materials GROUP BY sync_status`)
            .all() as { s: string; n: number }[])
        : (this.db
            .prepare(
              `SELECT sync_status as s, COUNT(*) as n FROM materials
                WHERE order_id = ? GROUP BY sync_status`
            )
            .all(orderId) as { s: string; n: number }[])
    const acc = { pending: 0, syncing: 0, failed: 0, pendingDelete: 0 }
    for (const r of rows) {
      if (r.s === 'pending') acc.pending = r.n
      else if (r.s === 'syncing') acc.syncing = r.n
      else if (r.s === 'failed') acc.failed = r.n
      else if (r.s === 'pending_delete') acc.pendingDelete = r.n
    }
    return acc
  }

  // ────────── 给 sync worker 用 ──────────

  pickPending(limit: number): MaterialRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM materials
          WHERE sync_status IN ('pending', 'pending_delete')
          ORDER BY created_at ASC
          LIMIT ?`
      )
      .all(limit) as RawRow[]
    return rows.map((r) => this.fromRaw(r))
  }

  markSyncing(id: number): void {
    this.db.prepare(`UPDATE materials SET sync_status='syncing' WHERE id=?`).run(id)
  }

  markSynced(id: number, remoteId: number | null, remoteUrl: string | null = null): void {
    this.db
      .prepare(
        `UPDATE materials
            SET sync_status='synced', remote_id=?, remote_url=?,
                sync_error=NULL, synced_at=? WHERE id=?`
      )
      .run(remoteId, remoteUrl, Date.now(), id)
  }

  markTombstone(id: number): void {
    // 远端删除成功，本地物理文件可以释放
    const row = this.db.prepare(`SELECT image_local_path FROM materials WHERE id=?`).get(id) as
      | { image_local_path: string | null }
      | undefined
    if (row?.image_local_path && existsSync(row.image_local_path)) {
      try {
        rmSync(row.image_local_path, { force: true })
      } catch {/* */}
    }
    this.db.prepare(`UPDATE materials SET sync_status='tombstone' WHERE id=?`).run(id)
  }

  markFailed(id: number, error: string): void {
    // 重试策略：累计 3 次后变 failed 状态（需手动重试）
    const row = this.db.prepare(`SELECT sync_attempts FROM materials WHERE id=?`).get(id) as
      | { sync_attempts: number }
      | undefined
    const attempts = (row?.sync_attempts ?? 0) + 1
    const nextStatus = attempts >= 3 ? 'failed' : 'pending'
    this.db
      .prepare(
        `UPDATE materials SET sync_status=?, sync_attempts=?, sync_error=? WHERE id=?`
      )
      .run(nextStatus, attempts, error, id)
  }

  /** UI 上"失败 N 条 · 点击重试"按下：把 failed 重置为 pending */
  retryFailed(): number {
    const info = this.db
      .prepare(
        `UPDATE materials SET sync_status='pending', sync_attempts=0, sync_error=NULL
           WHERE sync_status='failed'`
      )
      .run()
    return info.changes
  }

  /**
   * 丢弃所有 failed 素材（用户在 UI 点"丢弃"）。
   * 物理删本地图片文件 + 删 DB 行。不会去后端 DELETE（因为这些根本没同步成功过）。
   * 用于：早期错配置（如 MinIO IP 不对）留下的死循环 failed 行，重试也修不了。
   */
  discardFailed(): number {
    const rows = this.db
      .prepare(`SELECT id, image_local_path FROM materials WHERE sync_status='failed'`)
      .all() as { id: number; image_local_path: string | null }[]
    for (const r of rows) {
      if (r.image_local_path && existsSync(r.image_local_path)) {
        try { rmSync(r.image_local_path, { force: true }) } catch {/* */}
      }
    }
    const info = this.db.prepare(`DELETE FROM materials WHERE sync_status='failed'`).run()
    return info.changes
  }

  // ────────── 删除 ──────────

  /**
   * 软删：
   * - 若还没同步过 → 直接 tombstone + 物理删
   * - 若已同步 → pending_delete，由 sync worker 调 REST DELETE
   */
  softDelete(id: number): void {
    const row = this.db.prepare(`SELECT * FROM materials WHERE id=?`).get(id) as RawRow | undefined
    if (!row) return
    if (row.sync_status === 'synced') {
      this.db.prepare(`UPDATE materials SET sync_status='pending_delete' WHERE id=?`).run(id)
    } else {
      this.markTombstone(id)
    }
  }

  // ────────── 内部 ──────────

  private requireRow(id: number): MaterialRow {
    const r = this.db.prepare(`SELECT * FROM materials WHERE id=?`).get(id) as RawRow | undefined
    if (!r) throw new Error(`material #${id} 不存在`)
    return this.fromRaw(r)
  }

  private fromRaw(r: RawRow): MaterialRow {
    return {
      id: r.id,
      orderId: r.order_id,
      clientUuid: r.client_uuid,
      type: r.type as MaterialType,
      textContent: r.text_content,
      imageLocalPath: r.image_local_path,
      mimeType: r.mime_type,
      byteSize: r.byte_size,
      syncStatus: r.sync_status as MaterialSyncStatus,
      syncAttempts: r.sync_attempts,
      syncError: r.sync_error,
      remoteId: r.remote_id,
      remoteUrl: r.remote_url,
      createdAt: r.created_at,
      syncedAt: r.synced_at
    }
  }

  private toViewRow(row: MaterialRow): MaterialViewRow {
    let imageDataUrl: string | null = null
    if (row.type === 'image' && row.imageLocalPath && existsSync(row.imageLocalPath)) {
      try {
        const buf = readFileSync(row.imageLocalPath)
        imageDataUrl = `data:${row.mimeType || 'image/png'};base64,${buf.toString('base64')}`
      } catch (e) {
        console.warn('[material-store] 读图片失败:', (e as Error).message)
      }
    }
    return {
      id: row.id,
      orderId: row.orderId,
      type: row.type,
      textContent: row.textContent,
      imageDataUrl,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      syncStatus: row.syncStatus,
      remoteUrl: row.remoteUrl,
      createdAt: row.createdAt
    }
  }

  /**
   * 给 sync worker 用：把本地图片读成 base64（不带 dataURL 前缀）。
   * 上传到后端时用 raw base64 + mimeType。
   */
  readImageBase64(row: MaterialRow): { base64: string; mimeType: string } | null {
    if (row.type !== 'image' || !row.imageLocalPath) return null
    if (!existsSync(row.imageLocalPath)) return null
    const buf = readFileSync(row.imageLocalPath)
    return { base64: buf.toString('base64'), mimeType: row.mimeType || 'image/png' }
  }

  /** 给 sync worker 用：拿当前行的最新值（避免 stale） */
  getById(id: number): MaterialRow | null {
    const r = this.db.prepare(`SELECT * FROM materials WHERE id=?`).get(id) as RawRow | undefined
    return r ? this.fromRaw(r) : null
  }
}

// 内部 raw 表示（snake_case）
interface RawRow {
  id: number
  order_id: number
  client_uuid: string
  type: string
  text_content: string | null
  image_local_path: string | null
  mime_type: string | null
  byte_size: number | null
  sync_status: string
  sync_attempts: number
  sync_error: string | null
  remote_id: number | null
  remote_url: string | null
  created_at: number
  synced_at: number | null
}

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return null
  return { mimeType: m[1], buffer: Buffer.from(m[2], 'base64') }
}
