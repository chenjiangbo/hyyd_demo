import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { mkdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import type { CaptureLayoutResult } from './capture-layout-service'
import type { CaptureFrameEvent } from './capture-types'

export interface InsertFrameResult {
  frameId: number
  duplicate: boolean
  threadId: number | null
  messageBlockId: number | null
}

interface ExtractedMessage {
  content: string
  senderType: 'self' | 'other' | 'system' | 'unknown'
  senderName?: string | null
  bbox: { left: number; top: number; right: number; bottom: number } | null
}

interface ExtractedLine extends ExtractedMessage {
  leftEdge: number
  rightEdge: number
  lineHeight: number
}

export class CaptureStore {
  private readonly db: Database.Database

  constructor(dbPath = join(app.getPath('userData'), 'capture', 'capture.db')) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = CaptureStore.openResilient(dbPath)
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  /**
   * 健壮地打开 SQLite：
   * 1. 先按 WAL 模式打开（性能好）
   * 2. WAL 在某些文件系统（VM 共享盘、网络盘）会报 SQLITE_IOERR_TRUNCATE，
   *    此时降级到 DELETE 日志模式（兼容性最好）
   * 3. 若 db 文件本身损坏/被锁导致打开失败，删掉 db 及其 -wal/-shm 残留后重建
   */
  private static openResilient(dbPath: string): Database.Database {
    const tryOpen = (): Database.Database => {
      const db = new Database(dbPath)
      try {
        db.pragma('journal_mode = WAL')
      } catch (e) {
        // WAL 不被当前文件系统支持 → 退回 DELETE 模式
        console.warn('[capture-store] WAL 模式不可用，降级为 DELETE 模式:', (e as Error).message)
        db.pragma('journal_mode = DELETE')
      }
      return db
    }

    try {
      return tryOpen()
    } catch (e) {
      console.error('[capture-store] 打开数据库失败，清理残留后重建:', (e as Error).message)
      // 删掉可能损坏/锁死的 db 主文件和 WAL/SHM 边车文件
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
          rmSync(`${dbPath}${suffix}`, { force: true })
        } catch {
          /* 忽略删除失败 */
        }
      }
      // 重建一次；这次仍失败就让它抛出去（真·磁盘满/权限问题）
      return tryOpen()
    }
  }

  /** 会话列表（按渠道过滤，最近活跃在前） */
  listThreads(channel?: string): CaptureThreadRow[] {
    const sql = `
      SELECT t.id, t.channel, t.thread_key, t.conversation_title, t.normalized_title,
             t.phone, t.order_no, t.conversation_kind, t.is_group, t.classification, t.first_seen_at, t.last_seen_at,
             t.message_count,
             (
               SELECT mb.content FROM message_blocks mb
                WHERE mb.thread_id = t.id
                ORDER BY mb.last_seen_at DESC LIMIT 1
             ) AS last_message_preview
        FROM conversation_threads t
       ${channel ? 'WHERE t.channel = ?' : ''}
       ORDER BY t.last_seen_at DESC
    `
    const rows = channel
      ? (this.db.prepare(sql).all(channel) as any[])
      : (this.db.prepare(sql).all() as any[])
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      threadKey: r.thread_key,
      conversationTitle: r.conversation_title,
      phone: r.phone,
      orderNo: r.order_no ?? null,
      conversationKind: r.conversation_kind ?? null,
      isGroup: !!r.is_group,
      classification: r.classification,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      messageCount: r.message_count ?? 0,
      lastMessagePreview: (r.last_message_preview || '').slice(0, 40)
    }))
  }

  /** 某会话的消息块（按时间正序） */
  listMessageBlocks(threadId: number): CaptureMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, sender_type, sender_name, content, first_seen_at, last_seen_at,
                seen_count, source_screenshot_path
           FROM message_blocks
          WHERE thread_id = ?
          ORDER BY first_seen_at ASC, id ASC`
      )
      .all(threadId) as any[]
    return rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      senderType: r.sender_type,
      senderName: r.sender_name ?? null,
      content: r.content,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      seenCount: r.seen_count ?? 1,
      sourceScreenshotPath: r.source_screenshot_path ?? null
    }))
  }

  /** 调试用：最近的采集帧（含 OCR 块 + 关联 layout 版本） */
  listRecentFrames(channel: string | undefined, limit = 30): CaptureFrameDebugRow[] {
    const sql = `
      SELECT id, channel, captured_at, window_width, window_height, window_show_state,
             screenshot_path, ocr_status, ocr_text, ocr_blocks_json,
             layout_version_id, frame_status
        FROM capture_frames
       ${channel ? 'WHERE channel = ?' : ''}
       ORDER BY captured_at DESC, id DESC
       LIMIT ?
    `
    const rows = channel
      ? (this.db.prepare(sql).all(channel, limit) as any[])
      : (this.db.prepare(sql).all(limit) as any[])
    return rows.map((r) => {
      let blocks: Array<{ text: string; bbox: { x: number; y: number; width: number; height: number }; confidence?: number | null }> = []
      try {
        blocks = JSON.parse(r.ocr_blocks_json || '[]')
      } catch {
        blocks = []
      }
      return {
        id: r.id,
        channel: r.channel,
        capturedAt: r.captured_at,
        windowWidth: r.window_width,
        windowHeight: r.window_height,
        windowShowState: r.window_show_state,
        screenshotPath: r.screenshot_path,
        ocrStatus: r.ocr_status,
        ocrText: r.ocr_text ?? '',
        ocrBlocks: blocks,
        layoutVersionId: r.layout_version_id ?? null,
        frameStatus: r.frame_status
      }
    })
  }

  /** 调试用：某个 layout 版本的区域矩形 + VLM 原始返回 */
  getLayoutVersion(id: number): CaptureLayoutDebugRow | null {
    const r = this.db
      .prepare(
        `SELECT id, channel, window_width, window_height, window_show_state, trigger_reason,
                vlm_model, vlm_confidence, vlm_raw_response,
                sidebar_rect_json, title_rect_json, chat_rect_json, input_rect_json, created_at
           FROM layout_versions WHERE id = ?`
      )
      .get(id) as any
    if (!r) return null
    const parse = (s: string): any => {
      try {
        return JSON.parse(s)
      } catch {
        return null
      }
    }
    return {
      id: r.id,
      channel: r.channel,
      windowWidth: r.window_width,
      windowHeight: r.window_height,
      windowShowState: r.window_show_state,
      triggerReason: r.trigger_reason,
      vlmModel: r.vlm_model ?? null,
      vlmConfidence: r.vlm_confidence ?? null,
      vlmRawResponse: r.vlm_raw_response ?? null,
      regions: {
        sidebar: parse(r.sidebar_rect_json),
        title: parse(r.title_rect_json),
        chat: parse(r.chat_rect_json),
        input: parse(r.input_rect_json)
      },
      createdAt: r.created_at
    }
  }

  close(): void {
    this.db.close()
  }

  insertFrame(
    frame: CaptureFrameEvent,
    layoutVersionId: number | null = null,
    layout: CaptureLayoutResult | null = null
  ): InsertFrameResult {
    const ocrTextHash = hashText(frame.ocr.text)
    const duplicate = this.isDuplicateFrame(frame, ocrTextHash)
    const row = this.db
      .prepare(
        `
        INSERT INTO capture_frames (
          channel, process_name, window_title, captured_at,
          window_left, window_top, window_width, window_height, window_show_state,
          screenshot_path, image_hash, ocr_text_hash, layout_version_id,
          ocr_engine, ocr_status, ocr_text, ocr_blocks_json,
          frame_status, created_at
        )
        VALUES (
          @channel, @processName, @windowTitle, @capturedAt,
          @windowLeft, @windowTop, @windowWidth, @windowHeight, @windowShowState,
          @screenshotPath, @imageHash, @ocrTextHash, @layoutVersionId,
          @ocrEngine, @ocrStatus, @ocrText, @ocrBlocksJson,
          @frameStatus, @createdAt
        )
        `
      )
      .run({
        channel: frame.channel,
        processName: frame.processName,
        windowTitle: frame.windowTitle ?? null,
        capturedAt: frame.capturedAt,
        windowLeft: frame.window.left,
        windowTop: frame.window.top,
        windowWidth: frame.window.width,
        windowHeight: frame.window.height,
        windowShowState: frame.window.showState,
        screenshotPath: frame.screenshotPath,
        imageHash: frame.imageHash ?? null,
        ocrTextHash,
        layoutVersionId,
        ocrEngine: frame.ocr.engine,
        ocrStatus: frame.ocr.status,
        ocrText: frame.ocr.text,
        ocrBlocksJson: JSON.stringify(frame.ocr.blocks),
        frameStatus: duplicate ? 'skipped_duplicate' : frame.ocr.status === 'success' ? 'captured' : 'ocr_failed',
        createdAt: new Date().toISOString()
      })

    const frameId = Number(row.lastInsertRowid)
    const hasStructuredMessages = frame.messages?.some((message) => normalizeMessageContent(message.text)) ?? false
    if (duplicate || frame.ocr.status !== 'success' || (!frame.ocr.text.trim() && !hasStructuredMessages)) {
      return { frameId, duplicate, threadId: null, messageBlockId: null }
    }

    const threadId = this.upsertConversationThread(frame, layout)
    const messageBlockId = this.insertMessageBlocks(frame, frameId, threadId, layout)
    return { frameId, duplicate, threadId, messageBlockId }
  }

  insertLayoutVersion(
    frame: CaptureFrameEvent,
    triggerReason: string,
    layout: CaptureLayoutResult
  ): number {
    const row = this.db
      .prepare(
        `
        INSERT INTO layout_versions (
          channel, process_name, window_width, window_height, window_show_state,
          trigger_reason, vlm_model, vlm_confidence, vlm_raw_response,
          sidebar_rect_json, title_rect_json, chat_rect_json, input_rect_json,
          is_active, created_at
        )
        VALUES (
          @channel, @processName, @windowWidth, @windowHeight, @windowShowState,
          @triggerReason, @vlmModel, @vlmConfidence, @vlmRawResponse,
          @sidebarRectJson, @titleRectJson, @chatRectJson, @inputRectJson,
          1, @createdAt
        )
        `
      )
      .run({
        channel: frame.channel,
        processName: frame.processName,
        windowWidth: frame.window.width,
        windowHeight: frame.window.height,
        windowShowState: frame.window.showState,
        triggerReason,
        vlmModel: layout.model,
        vlmConfidence: layout.confidence,
        vlmRawResponse: layout.rawResponse,
        sidebarRectJson: JSON.stringify(layout.regions.sidebar),
        titleRectJson: JSON.stringify(layout.regions.title),
        chatRectJson: JSON.stringify(layout.regions.chat),
        inputRectJson: JSON.stringify(layout.regions.input),
        createdAt: new Date().toISOString()
      })
    return Number(row.lastInsertRowid)
  }

  private isDuplicateFrame(frame: CaptureFrameEvent, ocrTextHash: string): boolean {
    const latest = this.db
      .prepare(
        `
        SELECT image_hash, ocr_text_hash
        FROM capture_frames
        WHERE channel = @channel
          AND process_name = @processName
          AND COALESCE(window_title, '') = COALESCE(@windowTitle, '')
        ORDER BY captured_at DESC, id DESC
        LIMIT 1
        `
      )
      .get({
        channel: frame.channel,
        processName: frame.processName,
        windowTitle: frame.windowTitle ?? null
      }) as { image_hash: string | null; ocr_text_hash: string | null } | undefined

    if (!latest) return false
    return Boolean(frame.imageHash && latest.image_hash === frame.imageHash && latest.ocr_text_hash === ocrTextHash)
  }

  private upsertConversationThread(frame: CaptureFrameEvent, layout: CaptureLayoutResult | null): number {
    const orderNo = normalizeOrderNo(frame.orderNo)
    const title = normalizeTitle(
      orderNo ||
        extractRegionText(frame, layout?.regions.title) ||
        frame.windowTitle ||
        frame.processName
    )
    const phone = extractPhone(title)
    const threadKey = orderNo ? `order:${orderNo}` : phone ? `phone:${phone}` : `title:${hashText(title)}`
    const conversationKind = frame.conversationKind ?? null
    const now = new Date().toISOString()

    this.db
      .prepare(
        `
        INSERT INTO conversation_threads (
          channel, thread_key, conversation_title, normalized_title, phone,
          order_no, conversation_kind, is_group, classification, first_seen_at, last_seen_at, message_count,
          created_at, updated_at
        )
        VALUES (
          @channel, @threadKey, @conversationTitle, @normalizedTitle, @phone,
          @orderNo, @conversationKind, @isGroup, @classification, @seenAt, @seenAt, 0,
          @now, @now
        )
        ON CONFLICT(channel, thread_key) DO UPDATE SET
          conversation_title = excluded.conversation_title,
          normalized_title = excluded.normalized_title,
          phone = COALESCE(excluded.phone, conversation_threads.phone),
          order_no = COALESCE(excluded.order_no, conversation_threads.order_no),
          conversation_kind = COALESCE(excluded.conversation_kind, conversation_threads.conversation_kind),
          is_group = CASE
            WHEN excluded.conversation_kind = 'group' THEN 1
            WHEN excluded.conversation_kind = 'single' THEN 0
            ELSE conversation_threads.is_group
          END,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
        `
      )
      .run({
        channel: frame.channel,
        threadKey,
        conversationTitle: orderNo || frame.windowTitle || null,
        normalizedTitle: title,
        phone,
        orderNo,
        conversationKind,
        isGroup: conversationKind === 'group' ? 1 : isLikelyGroupTitle(title) ? 1 : 0,
        classification: classifyThread(title, phone),
        seenAt: frame.capturedAt,
        now
      })

    const row = this.db
      .prepare('SELECT id FROM conversation_threads WHERE channel = ? AND thread_key = ?')
      .get(frame.channel, threadKey) as { id: number }
    return row.id
  }

  private insertMessageBlocks(
    frame: CaptureFrameEvent,
    frameId: number,
    threadId: number,
    layout: CaptureLayoutResult | null
  ): number | null {
    const messages = extractStructuredMessages(frame) ?? extractMessages(frame, layout)
    let firstId: number | null = null
    for (const message of messages) {
      const id = this.insertMessageBlock(frame, frameId, threadId, message)
      if (!firstId) firstId = id
    }
    return firstId
  }

  private insertMessageBlock(
    frame: CaptureFrameEvent,
    frameId: number,
    threadId: number,
    message: ExtractedMessage
  ): number | null {
    const content = normalizeMessageContent(message.content)
    if (!content) return null

    const normalizedContent = normalizeContentForHash(content)
    const contentHash = hashText(normalizedContent)
    const dedupeKey = `${threadId}:${message.senderType}:${contentHash}`
    const now = new Date().toISOString()
    const shortTextCutoff = new Date(new Date(frame.capturedAt).getTime() - 2 * 60_000).toISOString()

    const recent = this.db
      .prepare(
        `
        SELECT id, seen_count, source_frame_ids
        FROM message_blocks
        WHERE thread_id = @threadId
          AND dedupe_key = @dedupeKey
          AND first_seen_at >= @shortTextCutoff
        ORDER BY first_seen_at DESC
        LIMIT 1
        `
      )
      .get({ threadId, dedupeKey, shortTextCutoff }) as
      | { id: number; seen_count: number; source_frame_ids: string | null }
      | undefined

    if (recent) {
      const sourceFrameIds = appendFrameId(recent.source_frame_ids, frameId)
      this.db
        .prepare(
          `
          UPDATE message_blocks
          SET last_seen_at = @lastSeenAt,
              seen_count = @seenCount,
              source_frame_ids = @sourceFrameIds,
              updated_at = @updatedAt
          WHERE id = @id
          `
        )
        .run({
          id: recent.id,
          lastSeenAt: frame.capturedAt,
          seenCount: recent.seen_count + 1,
          sourceFrameIds,
          updatedAt: now
        })
      return recent.id
    }

    const row = this.db
      .prepare(
        `
        INSERT INTO message_blocks (
          thread_id, channel, process_name, sender_type, sender_name, content, normalized_content,
          bbox_left, bbox_top, bbox_right, bbox_bottom,
          first_seen_at, last_seen_at, seen_count,
          content_hash, dedupe_key, source_frame_ids, source_screenshot_path,
          ocr_confidence, sender_confidence, created_at, updated_at
        )
        VALUES (
          @threadId, @channel, @processName, @senderType, @senderName, @content, @normalizedContent,
          @bboxLeft, @bboxTop, @bboxRight, @bboxBottom,
          @seenAt, @seenAt, 1,
          @contentHash, @dedupeKey, @sourceFrameIds, @sourceScreenshotPath,
          NULL, NULL, @now, @now
        )
        `
      )
      .run({
        threadId,
        channel: frame.channel,
        processName: frame.processName,
        senderType: message.senderType,
        senderName: message.senderName ?? null,
        content,
        normalizedContent,
        bboxLeft: message.bbox?.left ?? null,
        bboxTop: message.bbox?.top ?? null,
        bboxRight: message.bbox?.right ?? null,
        bboxBottom: message.bbox?.bottom ?? null,
        seenAt: frame.capturedAt,
        contentHash,
        dedupeKey,
        sourceFrameIds: JSON.stringify([frameId]),
        sourceScreenshotPath: frame.screenshotPath,
        now
      })

    this.db.prepare('UPDATE conversation_threads SET message_count = message_count + 1 WHERE id = ?').run(threadId)
    return Number(row.lastInsertRowid)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        process_name TEXT NOT NULL,
        window_title TEXT,
        captured_at TEXT NOT NULL,
        window_left INTEGER,
        window_top INTEGER,
        window_width INTEGER,
        window_height INTEGER,
        window_show_state TEXT,
        screenshot_path TEXT NOT NULL,
        image_hash TEXT,
        phash TEXT,
        ocr_text_hash TEXT,
        chat_text_hash TEXT,
        layout_version_id INTEGER,
        ocr_engine TEXT,
        ocr_status TEXT,
        ocr_text TEXT,
        ocr_blocks_json TEXT,
        frame_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS layout_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        process_name TEXT NOT NULL,
        window_width INTEGER NOT NULL,
        window_height INTEGER NOT NULL,
        window_show_state TEXT,
        trigger_reason TEXT NOT NULL,
        vlm_model TEXT,
        vlm_confidence REAL,
        vlm_raw_response TEXT,
        sidebar_rect_json TEXT NOT NULL,
        title_rect_json TEXT NOT NULL,
        chat_rect_json TEXT NOT NULL,
        input_rect_json TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        conversation_title TEXT,
        normalized_title TEXT,
        phone TEXT,
        order_no TEXT,
        conversation_kind TEXT,
        is_group INTEGER DEFAULT 0,
        classification TEXT,
        first_seen_at TEXT,
        last_seen_at TEXT,
        message_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel, thread_key)
      );

      CREATE TABLE IF NOT EXISTS message_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        process_name TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        sender_name TEXT,
        content TEXT NOT NULL,
        normalized_content TEXT NOT NULL,
        bbox_left INTEGER,
        bbox_top INTEGER,
        bbox_right INTEGER,
        bbox_bottom INTEGER,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        seen_count INTEGER DEFAULT 1,
        content_hash TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        source_frame_ids TEXT,
        source_screenshot_path TEXT,
        ocr_confidence REAL,
        sender_confidence REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES conversation_threads(id)
      );

      CREATE INDEX IF NOT EXISTS idx_capture_frames_captured_at ON capture_frames(captured_at);
      CREATE INDEX IF NOT EXISTS idx_capture_frames_channel_time ON capture_frames(channel, captured_at);
    `)
    this.ensureColumn('message_blocks', 'channel', 'TEXT')
    this.ensureColumn('message_blocks', 'process_name', 'TEXT')
    this.ensureColumn('message_blocks', 'sender_name', 'TEXT')
    this.ensureColumn('conversation_threads', 'order_no', 'TEXT')
    this.ensureColumn('conversation_threads', 'conversation_kind', 'TEXT')
    this.db.exec(`
      UPDATE message_blocks
      SET channel = COALESCE(channel, (
        SELECT conversation_threads.channel
        FROM conversation_threads
        WHERE conversation_threads.id = message_blocks.thread_id
      ), 'unknown')
      WHERE channel IS NULL;

      UPDATE message_blocks
      SET process_name = COALESCE(process_name, CASE channel WHEN 'wxwork' THEN 'WXWork.exe' WHEN 'wechat' THEN 'WeChat.exe' ELSE 'unknown' END)
      WHERE process_name IS NULL;

      CREATE INDEX IF NOT EXISTS idx_message_blocks_channel_time ON message_blocks(channel, first_seen_at);
      CREATE INDEX IF NOT EXISTS idx_message_blocks_thread_time ON message_blocks(thread_id, first_seen_at);
    `)
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (columns.some((row) => row.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export interface CaptureThreadRow {
  id: number
  channel: string
  threadKey: string
  conversationTitle: string | null
  phone: string | null
  orderNo: string | null
  conversationKind: string | null
  isGroup: boolean
  classification: string | null
  firstSeenAt: string | null
  lastSeenAt: string | null
  messageCount: number
  lastMessagePreview: string
}

export interface CaptureMessageRow {
  id: number
  threadId: number
  senderType: 'self' | 'other' | 'system' | 'unknown'
  senderName: string | null
  content: string
  firstSeenAt: string
  lastSeenAt: string
  seenCount: number
  sourceScreenshotPath: string | null
}

export interface CaptureFrameDebugRow {
  id: number
  channel: string
  capturedAt: string
  windowWidth: number
  windowHeight: number
  windowShowState: string
  screenshotPath: string
  ocrStatus: string
  ocrText: string
  ocrBlocks: Array<{
    text: string
    bbox: { x: number; y: number; width: number; height: number }
    confidence?: number | null
  }>
  layoutVersionId: number | null
  frameStatus: string
}

export interface CaptureLayoutDebugRow {
  id: number
  channel: string
  windowWidth: number
  windowHeight: number
  windowShowState: string
  triggerReason: string
  vlmModel: string | null
  vlmConfidence: number | null
  vlmRawResponse: string | null
  regions: {
    sidebar: { x1: number; y1: number; x2: number; y2: number } | null
    title: { x1: number; y1: number; x2: number; y2: number } | null
    chat: { x1: number; y1: number; x2: number; y2: number } | null
    input: { x1: number; y1: number; x2: number; y2: number } | null
  }
  createdAt: string
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim()
}

function extractPhone(text: string): string | null {
  const match = text.match(/(?:\+?86[- ]?)?(1[3-9]\d{9})/)
  return match?.[1] ?? null
}

function isLikelyGroupTitle(title: string): boolean {
  return /群|group|项目|服务|沟通/i.test(title)
}

function classifyThread(title: string, phone: string | null): string {
  if (phone) return 'named_customer'
  if (isLikelyGroupTitle(title)) return 'unknown_group'
  if (title) return 'unknown_private'
  return 'unknown_thread'
}

function normalizeOrderNo(orderNo: string | null | undefined): string | null {
  const value = orderNo?.trim()
  return value ? value : null
}

function normalizeMessageContent(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function normalizeContentForHash(text: string): string {
  return text.replace(/\s+/g, '').replace(/[，。！？；：]/g, (char) => {
    const map: Record<string, string> = {
      '，': ',',
      '。': '.',
      '！': '!',
      '？': '?',
      '；': ';',
      '：': ':'
    }
    return map[char] ?? char
  })
}

function appendFrameId(sourceFrameIds: string | null, frameId: number): string {
  const ids = sourceFrameIds ? (JSON.parse(sourceFrameIds) as number[]) : []
  if (!ids.includes(frameId)) ids.push(frameId)
  return JSON.stringify(ids.slice(-20))
}

function extractStructuredMessages(frame: CaptureFrameEvent): ExtractedMessage[] | null {
  if (!frame.messages?.length) return null
  const messages = frame.messages
    .map((message) => ({
      content: message.text,
      senderType: message.speaker,
      senderName: message.name ?? null,
      bbox: null
    }))
    .filter((message) => Boolean(normalizeMessageContent(message.content)))
  return messages.length > 0 ? messages : null
}

function extractMessages(frame: CaptureFrameEvent, layout: CaptureLayoutResult | null): ExtractedMessage[] {
  if (!layout) {
    return [
      {
        content: frame.ocr.text,
        senderType: 'unknown',
        bbox: null
      }
    ]
  }

  const lines = extractChatLines(frame, layout)
  if (lines.length === 0) return []

  const medianHeight = median(lines.map((line) => line.lineHeight)) || 18
  const messages: ExtractedLine[] = []
  for (const line of lines) {
    const previous = messages[messages.length - 1]
    if (
      previous &&
      previous.senderType === line.senderType &&
      line.bbox &&
      previous.bbox &&
      line.bbox.top - previous.bbox.bottom < medianHeight * 1.2 &&
      Math.abs(line.leftEdge - previous.leftEdge) < medianHeight * 2 &&
      Math.abs(line.rightEdge - previous.rightEdge) < medianHeight * 4
    ) {
      previous.content = `${previous.content}\n${line.content}`
      previous.bbox = {
        left: Math.min(previous.bbox.left, line.bbox.left),
        top: Math.min(previous.bbox.top, line.bbox.top),
        right: Math.max(previous.bbox.right, line.bbox.right),
        bottom: Math.max(previous.bbox.bottom, line.bbox.bottom)
      }
      continue
    }
    messages.push({ ...line })
  }

  return messages
}

function extractChatLines(frame: CaptureFrameEvent, layout: CaptureLayoutResult): ExtractedLine[] {
  const chat = layout.regions.chat
  const blocks = frame.ocr.blocks
    .filter((block) => {
      const centerX = block.bbox.x + block.bbox.width / 2
      const centerY = block.bbox.y + block.bbox.height / 2
      return centerX >= chat.x1 && centerX <= chat.x2 && centerY >= chat.y1 && centerY <= chat.y2
    })
    .sort((a, b) => {
      const dy = a.bbox.y - b.bbox.y
      if (Math.abs(dy) > Math.max(a.bbox.height, b.bbox.height) * 0.7) return dy
      return a.bbox.x - b.bbox.x
    })

  const lines: Array<{ text: string[]; bbox: { left: number; top: number; right: number; bottom: number }; height: number }> = []
  for (const block of blocks) {
    const bbox = {
      left: block.bbox.x,
      top: block.bbox.y,
      right: block.bbox.x + block.bbox.width,
      bottom: block.bbox.y + block.bbox.height
    }
    const previous = lines[lines.length - 1]
    const sameLine =
      previous && Math.abs(bbox.top - previous.bbox.top) <= Math.max(block.bbox.height, previous.height) * 0.7
    if (sameLine) {
      previous.text.push(block.text)
      previous.bbox.left = Math.min(previous.bbox.left, bbox.left)
      previous.bbox.top = Math.min(previous.bbox.top, bbox.top)
      previous.bbox.right = Math.max(previous.bbox.right, bbox.right)
      previous.bbox.bottom = Math.max(previous.bbox.bottom, bbox.bottom)
      previous.height = Math.max(previous.height, block.bbox.height)
    } else {
      lines.push({ text: [block.text], bbox, height: block.bbox.height })
    }
  }

  const chatWidth = chat.x2 - chat.x1
  return lines
    .map((line) => {
      const content = line.text.join(' ').trim()
      return {
        content,
        senderType: inferSenderType(content, line.bbox.left, line.bbox.right, chat.x1, chat.x2, chatWidth),
        bbox: line.bbox,
        leftEdge: line.bbox.left,
        rightEdge: line.bbox.right,
        lineHeight: line.height
      } satisfies ExtractedLine
    })
    .filter((line) => Boolean(line.content))
}

function inferSenderType(
  text: string,
  left: number,
  right: number,
  chatLeft: number,
  chatRight: number,
  chatWidth: number
): 'self' | 'other' | 'system' | 'unknown' {
  if (/^\d{1,2}:\d{2}$|昨天|今天|星期|周[一二三四五六日天]/.test(text)) return 'system'
  if (right > chatRight - chatWidth * 0.22) return 'self'
  if (left < chatLeft + chatWidth * 0.22) return 'other'
  return 'unknown'
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function extractRegionText(
  frame: CaptureFrameEvent,
  region: CaptureLayoutResult['regions']['chat'] | undefined
): string {
  if (!region) return ''
  const blocks = frame.ocr.blocks
    .filter((block) => {
      const centerX = block.bbox.x + block.bbox.width / 2
      const centerY = block.bbox.y + block.bbox.height / 2
      return centerX >= region.x1 && centerX <= region.x2 && centerY >= region.y1 && centerY <= region.y2
    })
    .sort((a, b) => {
      const dy = a.bbox.y - b.bbox.y
      if (Math.abs(dy) > Math.max(a.bbox.height, b.bbox.height) * 0.7) return dy
      return a.bbox.x - b.bbox.x
    })

  const lines: string[] = []
  for (const block of blocks) {
    const previous = blocks[blocks.indexOf(block) - 1]
    if (!previous) {
      lines.push(block.text)
      continue
    }
    const sameLine = Math.abs(block.bbox.y - previous.bbox.y) <= Math.max(block.bbox.height, previous.bbox.height) * 0.7
    if (sameLine) lines[lines.length - 1] = `${lines[lines.length - 1]} ${block.text}`
    else lines.push(block.text)
  }

  return lines.join('\n')
}
