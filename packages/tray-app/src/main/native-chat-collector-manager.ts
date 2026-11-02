import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync, rmdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { app, shell } from 'electron'
import type { NativeChatCollectionConfig, NativeChatCollectionRule, NativeChatMessage } from '@huanyu/shared-types'
import { resolveWxworkContext, resolveWxworkContextAtRoot, type WxworkContext } from './wxwork-context'
import { NativeChatReadLogThrottle } from './native-chat-read-log-throttle'
import { applyAttachmentUploadLimit, MAX_ATTACHMENT_BYTES } from './native-chat-attachment-limit'
import { reconcileConversationPendingMedia } from './native-chat-pending-media'

type Channel = 'wechat' | 'wxwork'
type Session = {
  channel: Channel
  accountId: string
  sourceConversationId: string
  title: string | null
  kind: 'group' | 'single' | 'service' | 'unknown'
  sourceMetadata?: Record<string, unknown> | null
}
type CollectorEvent =
  | { event: 'ready'; channel: Channel; accountId: string; sessions: Session[] }
  | { event: 'sessions'; sessions: Session[] }
  | { event: 'message_batch'; channel: Channel; accountId: string; sourceConversationId: string; sortSeq?: number; cursorAfter?: string; messages: NativeChatMessage[] }
  | {
      event: 'source_read_started' | 'source_read_result' | 'source_encode_started' | 'source_encode_progress' |
        'source_encode_completed' | 'source_attachment_resolve_started' | 'source_attachment_resolve_completed'
      channel: 'wechat'
      accountId: string
      sourceConversationId: string
      title?: string | null
      isInitialHistory?: boolean
      sourceRowCount?: number
      elapsedMs?: number
      processedRowCount?: number
      currentSourceMessageId?: string
      sourceMessageId?: string
      rowIndex?: number
      kind?: string
      normalizedMessageCount?: number
    }
  | { event: 'source_read_result'; channel: 'wechat'; accountId?: string; sourceConversationId: string; isInitialHistory: boolean; sourceRowCount: number; title?: string | null; elapsedMs?: number }
  | { event: 'source_scan_progress'; channel: 'wxwork'; stage: string; [key: string]: unknown }
  | { event: 'cursor_checkpoint'; channel: Channel; accountId: string; sourceConversationId: string; cursorAfter: string }
  | { event: 'initial_history_complete'; channel: Channel; accountId: string; sourceConversationId: string; cursorAfter: string; sourceRowsProcessedThisRun: number }
  | { event: 'media_batch'; channel: 'wechat'; accountId: string; sourceConversationId: string; mediaSourceMessageId: string; messages: NativeChatMessage[] }
  | { event: 'fatal' | 'error'; accountId?: string; stage?: string; message?: string; sourceConversationId?: string; sourceMessageId?: string; title?: string; repeatCount?: number }
  | { event: 'subscribed'; conversationIds: string[] }
type DiscoveryEvent = Extract<CollectorEvent, { event: 'ready' | 'sessions' }>
type CursorMap = Record<string, string>
type PendingMediaMap = Record<string, Record<string, string[]>>
type InitialHistoryState = { version: 1; legacyCursorsMigrated: boolean; pendingCutoffs: Record<string, number>; completed: string[] }
export type NativePendingImageMatch = {
  attachmentId: number
  messageId: number
  fileName: string | null
  imageUrl: string
  occurredAt: string
  channel: string
  senderName: string | null
  applicationNo: string | null
  description: string
  candidateApplications: Array<{
    applicationNo: string
    programEvidence: string[]
    orders: Array<{
      orderId: number
      sourceOrderNo: string
      customerName: string
      serviceType: string | null
      hospital: string | null
      department: string | null
      doctor: string | null
      appointmentDate: string | null
      status: string
    }>
  }>
  applicationDecision: string
  orderDecision: string
  reason: string
}
export type CollectorHealthState = 'waiting' | 'starting' | 'running' | 'error'
export type CollectorHealth = { state: CollectorHealthState; detail: string; updatedAt: string }
export type NativeChatCollectorHealth = { wechat: CollectorHealth; wxwork: CollectorHealth; logPath: string }

const CONFIG_REFRESH_MS = 30_000
const MAX_RETRIES = 5
const DISCOVERY_RETRY_DELAYS_MS = [5_000, 15_000] as const
const DISCOVERY_MAX_ATTEMPTS = DISCOVERY_RETRY_DELAYS_MS.length + 1
const DISCOVERY_BATCH_SIZE = 200
const DISCOVERY_FULL_SYNC_MS = 5 * 60_000
const CURSOR_FILE = 'native-chat-cursors.json'
const INITIAL_HISTORY_PAGE_SIZE = 200
const INITIAL_HISTORY_DAYS = 30
const MEDIA_RETRY_MAX_AGE_MS = 30 * 24 * 60 * 60_000
const PENDING_MEDIA_FILE = 'native-chat-pending-media.json'
const SUBSCRIPTIONS_FILE = 'native-chat-subscriptions.json'
const COLLECTION_RULES_FILE = 'native-chat-collection-rules.json'
const DISCOVERY_PROGRESS_FILE = 'native-chat-discovery-progress.json'
const INITIAL_HISTORY_FILE = 'native-chat-initial-history.json'

class BackendResponseError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}

function cursorKey(session: Pick<Session, 'channel' | 'accountId' | 'sourceConversationId'>): string {
  return [session.channel, session.accountId, session.sourceConversationId].join('\u001f')
}

function stableDiscoveryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableDiscoveryValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'lastTime')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, stableDiscoveryValue(item)]))
}

type SessionActivity = 'recent' | 'inactive' | 'unknown'

export function sessionActivity(session: Session, now = Date.now()): SessionActivity {
  const metadata = session.sourceMetadata
  if (!metadata || metadata.activityStatus === 'unknown') return 'unknown'
  if (metadata.activityStatus === 'no_messages') return 'inactive'
  const raw = metadata.lastTime
  const value = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(value) || value <= 0) return 'unknown'
  const timestampMs = value < 100_000_000_000 ? value * 1_000 : value
  if (!Number.isSafeInteger(timestampMs)) return 'unknown'
  return timestampMs >= now - INITIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000 ? 'recent' : 'inactive'
}

export function discoveryFingerprint(session: Session): string {
  return JSON.stringify({
    channel: session.channel,
    accountId: session.accountId,
    sourceConversationId: session.sourceConversationId,
    title: session.title,
    activity: sessionActivity(session),
    kind: session.kind,
    sourceMetadata: stableDiscoveryValue(session.sourceMetadata ?? null)
  })
}

function matchesRule(rule: NativeChatCollectionRule, session: Session): boolean {
  if (!rule.enabled || (rule.channel !== 'both' && rule.channel !== session.channel)) return false
  const title = session.title?.trim().toLocaleLowerCase() ?? ''
  const value = rule.value.trim().toLocaleLowerCase()
  if (rule.match === 'source_id') return rule.value === session.sourceConversationId
  if (rule.match === 'title_exact') return title === value
  if (rule.match === 'title_regex') return new RegExp(rule.value, 'i').test(session.title ?? '')
  return title.includes(value)
}

function expireOldPendingMedia(messages: NativeChatMessage[]): NativeChatMessage[] {
  const now = Date.now()
  return messages.map((message) => {
    if (!Array.isArray(message.attachments) || message.attachments.length === 0) return message
    const occurredAt = Date.parse(message.occurredAt)
    const waitingAttachments = message.attachments.filter((attachment) => {
      if (attachment.sourceMetadata?.terminal === true) return false
      if (attachment.kind === 'image' && attachment.sourceMetadata?.nonThumbnailState !== 'available') return true
      return !attachment.localPath && ['not_downloaded', 'ambiguous'].includes(attachment.state)
    })
    if (waitingAttachments.length === 0) return message
    if (!Number.isFinite(occurredAt)) throw new Error(`待补附件消息缺少有效时间：${message.sourceMessageId}`)
    if (now - occurredAt < MEDIA_RETRY_MAX_AGE_MS) return message

    return {
      ...message,
      attachments: message.attachments.map((attachment) => {
        if (!waitingAttachments.includes(attachment)) return attachment
        const sourceMetadata = {
          ...(attachment.sourceMetadata ?? {}),
          resolutionState: 'retry_expired_30_days' as const,
          terminal: true,
          ...(attachment.kind === 'image' ? { nonThumbnailState: 'expired' as const } : {})
        }
        return {
          ...attachment,
          ...(attachment.localPath ? {} : { state: 'not_found' as const }),
          sourceMetadata
        }
      })
    }
  })
}

function parseCursorFile(path: string): CursorMap {
  if (!existsSync(path)) return {}
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地消息游标文件格式错误')
  const cursors: CursorMap = {}
  for (const [key, cursor] of Object.entries(value)) {
    if (!key || typeof cursor !== 'string') throw new Error('本地消息游标文件包含无效记录')
    cursors[key] = cursor
  }
  return cursors
}

function parsePendingMediaFile(path: string): PendingMediaMap {
  if (!existsSync(path)) return {}
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地待补采附件清单格式错误')
  const pending: PendingMediaMap = {}
  for (const [conversationKey, rows] of Object.entries(value)) {
    if (!conversationKey || !rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('本地待补采附件清单包含无效会话')
    const messages: Record<string, string[]> = {}
    for (const [messageId, attachmentIds] of Object.entries(rows)) {
      if (!messageId || !Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== 'string' || !id)) {
        throw new Error('本地待补采附件清单包含无效附件标识')
      }
      messages[messageId] = [...new Set(attachmentIds)]
    }
    pending[conversationKey] = messages
  }
  return pending
}

function parseSubscriptionsFile(path: string): Session[] {
  if (!existsSync(path)) return []
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value)) throw new Error('本地消息订阅文件格式错误')
  for (const session of value) {
    if (!session || typeof session !== 'object' || !['wechat', 'wxwork'].includes(session.channel)
      || typeof session.accountId !== 'string' || !session.accountId
      || typeof session.sourceConversationId !== 'string' || !session.sourceConversationId
      || !(session.title === null || typeof session.title === 'string')
      || !['group', 'single', 'service', 'unknown'].includes(session.kind)) {
      throw new Error('本地消息订阅文件包含无效会话')
    }
  }
  return value as Session[]
}

function parseInitialHistoryState(path: string): InitialHistoryState {
  if (!existsSync(path)) return { version: 1, legacyCursorsMigrated: false, pendingCutoffs: {}, completed: [] }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地首次回补状态文件格式错误')
  const state = value as Partial<InitialHistoryState>
  if (state.version !== 1 || typeof state.legacyCursorsMigrated !== 'boolean'
    || !state.pendingCutoffs || typeof state.pendingCutoffs !== 'object' || Array.isArray(state.pendingCutoffs)
    || !Array.isArray(state.completed) || state.completed.some((key) => typeof key !== 'string' || !key)) {
    throw new Error('本地首次回补状态文件字段无效')
  }
  for (const [key, cutoff] of Object.entries(state.pendingCutoffs)) {
    if (!key || typeof cutoff !== 'number' || !Number.isSafeInteger(cutoff) || cutoff <= 0) {
      throw new Error('本地首次回补状态文件包含无效时间范围')
    }
  }
  return {
    version: 1,
    legacyCursorsMigrated: state.legacyCursorsMigrated,
    pendingCutoffs: { ...state.pendingCutoffs },
    completed: [...new Set(state.completed)]
  }
}

function cursorForSession(channel: Channel, stored: string | undefined): string {
  if (stored !== undefined) return stored
  return channel === 'wechat'
    ? JSON.stringify({ sortSeq: 0, shard: '', localId: 0 })
    : JSON.stringify({ sourceRowId: 0 })
}

export function initialHistoryCursorMatches(channel: Channel, stored: string | undefined, reported: string): boolean {
  return cursorForSession(channel, stored) === reported
}

function cursorSortSeq(channel: Channel, cursor: string): number {
  if (channel !== 'wechat') return 0
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch {
    throw new Error('微信本地采集游标不是有效 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('微信本地采集游标格式错误')
  const sortSeq = (value as { sortSeq?: unknown }).sortSeq
  if (typeof sortSeq !== 'number' || !Number.isSafeInteger(sortSeq) || sortSeq < 0) throw new Error('微信本地采集游标缺少有效 sortSeq')
  return sortSeq
}

function wxworkCursorRowId(cursor: string): number {
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch {
    throw new Error('企微本地采集游标不是有效 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('企微本地采集游标格式错误')
  const rowId = (value as { sourceRowId?: unknown }).sourceRowId
  if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId) || rowId < 0) throw new Error('企微本地采集游标缺少有效 sourceRowId')
  return rowId
}

export class NativeChatCollectorManager {
  private readonly readLogThrottle = new NativeChatReadLogThrottle()
  private config: { backendUrl: string; employeeCode: string } | null = null
  private children = new Map<Channel, ChildProcessWithoutNullStreams>()
  private buffers = new Map<Channel, string>()
  private sessions = new Map<string, Session>()
  private selectedSubscriptions: Session[]
  private cursors: CursorMap
  private initialHistoryState: InitialHistoryState
  private pendingMedia: PendingMediaMap
  private refreshTimer: NodeJS.Timeout | null = null
  private refreshing = false
  private stopping = false
  private wxworkContext: WxworkContext | null = null
  private wxworkContextBlocked = false
  private lastWxworkContextError: string | null = null
  private readonly cursorPath = join(app.getPath('userData'), CURSOR_FILE)
  private readonly initialHistoryPath = join(app.getPath('userData'), INITIAL_HISTORY_FILE)
  private readonly pendingMediaPath = join(app.getPath('userData'), PENDING_MEDIA_FILE)
  private readonly subscriptionsPath = join(app.getPath('userData'), SUBSCRIPTIONS_FILE)
  private readonly collectionRulesPath = join(app.getPath('userData'), COLLECTION_RULES_FILE)
  private readonly discoveryProgressPath = join(app.getPath('userData'), DISCOVERY_PROGRESS_FILE)
  private readonly logPath = join(app.getPath('userData'), 'native-chat-collectors.log')
  private health: Record<Channel, CollectorHealth> = {
    wechat: { state: 'waiting', detail: '等待客户端登录配置', updatedAt: new Date().toISOString() },
    wxwork: { state: 'waiting', detail: '等待识别当前企业微信账号', updatedAt: new Date().toISOString() }
  }
  private statusListener: ((status: NativeChatCollectorHealth) => void) | null = null
  private imageMatchListener: ((match: NativePendingImageMatch) => void) | null = null
  private pendingImageMatches = new Map<number, NativePendingImageMatch>()
  private pendingDiscoveryEvents = new Map<Channel, DiscoveryEvent>()
  private discoveryWorkerRunning = false
  private successfulDiscoveryFingerprints = new Map<Channel, Map<string, string>>()
  private lastFullDiscoveryAt = new Map<Channel, number>()
  private discoveryProgress = new Map<Channel, { configVersion: string; confirmed: Map<string, string> }>()
  private activityIssues = new Map<Channel, string[]>()
  private cachedCollectionConfig: NativeChatCollectionConfig | null = null

  constructor() {
    this.cursors = parseCursorFile(this.cursorPath)
    this.initialHistoryState = parseInitialHistoryState(this.initialHistoryPath)
    this.pendingMedia = parsePendingMediaFile(this.pendingMediaPath)
    let resetLegacyWxworkCursors = false
    for (const [key, cursor] of Object.entries(this.cursors)) {
      if (!key.startsWith(`wxwork\u001f`)) continue
      let value: unknown
      try { value = JSON.parse(cursor) } catch { throw new Error('本地企微消息游标不是有效 JSON') }
      if (value && typeof value === 'object' && !Array.isArray(value)
        && typeof (value as { sourceRowId?: unknown }).sourceRowId === 'number') continue
      if (value && typeof value === 'object' && !Array.isArray(value)
        && typeof (value as { occurredAtUnixMs?: unknown }).occurredAtUnixMs === 'number') {
        this.cursors[key] = JSON.stringify({ sourceRowId: 0 })
        resetLegacyWxworkCursors = true
        continue
      }
      throw new Error('本地企微消息游标格式与当前采集器不匹配')
    }
    if (resetLegacyWxworkCursors) {
      console.info('[native-chat] 企微采集游标已切换为源数据库行号，将从历史记录重新校验并按来源 ID 去重')
      this.persistCursors()
    }
    this.selectedSubscriptions = parseSubscriptionsFile(this.subscriptionsPath)
    const now = Date.now()
    const initialCutoff = now - INITIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000
    let historyStateChanged = false
    for (const session of this.selectedSubscriptions) {
      const key = cursorKey(session)
      this.sessions.set(key, session)
      if (!this.initialHistoryState.completed.includes(key) && this.initialHistoryState.pendingCutoffs[key] === undefined) {
        if (this.cursors[key] !== undefined) this.cursors[key] = cursorForSession(session.channel, undefined)
        this.initialHistoryState.pendingCutoffs[key] = initialCutoff
        historyStateChanged = true
      }
    }
    this.initialHistoryState.legacyCursorsMigrated = true
    if (historyStateChanged) {
      this.persistCursors()
      this.persistInitialHistoryState()
    } else if (!existsSync(this.initialHistoryPath)) {
      this.persistInitialHistoryState()
    }
  }

  setConfig(config: { backendUrl: string; employeeCode: string }): void {
    const backendUrl = config.backendUrl.trim().replace(/\/$/, '')
    const employeeCode = config.employeeCode.trim()
    if (!/^https?:\/\//i.test(backendUrl)) throw new Error('消息采集服务地址无效')
    if (!employeeCode) throw new Error('消息采集缺少员工身份')
    const changedIdentity = this.config?.backendUrl !== backendUrl || this.config?.employeeCode !== employeeCode
    this.config = { backendUrl, employeeCode }
    if (changedIdentity) {
      this.successfulDiscoveryFingerprints.clear()
      this.lastFullDiscoveryAt.clear()
      this.pendingDiscoveryEvents.clear()
      this.discoveryProgress.clear()
      this.activityIssues.clear()
      this.restoreCollectionRules()
      this.restoreDiscoveryProgress()
    }
    this.stopping = false
    this.setHealth('wechat', 'starting', '正在启动微信采集程序')
    this.setHealth('wxwork', 'starting', '正在识别企业微信账号并启动采集程序')
    if (process.platform !== 'win32') {
      this.setHealth('wechat', 'error', '消息采集程序仅支持 Windows')
      this.setHealth('wxwork', 'error', '消息采集程序仅支持 Windows')
      return
    }
    this.ensureChildren()
    this.sendSavedSubscriptions()
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refreshSubscriptions()
        void this.refreshPendingImageMatches()
      }, CONFIG_REFRESH_MS)
      this.refreshTimer.unref()
    }
    void this.refreshSubscriptions()
    void this.refreshPendingImageMatches()
  }

  stop(): void {
    this.stopping = true
    this.pendingDiscoveryEvents.clear()
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    for (const [channel, child] of this.children.entries()) {
      this.requestCollectorStop(child, channel)
    }
    this.children.clear()
  }

  getHealth(): NativeChatCollectorHealth {
    return { ...this.health, logPath: this.logPath }
  }

  setStatusListener(listener: (status: NativeChatCollectorHealth) => void): void {
    this.statusListener = listener
    listener(this.getHealth())
  }

  setImageMatchListener(listener: (match: NativePendingImageMatch) => void): void {
    this.imageMatchListener = listener
    for (const match of this.pendingImageMatches.values()) listener(match)
  }

  async resolveImageMatch(attachmentId: number, applicationNo: string, orderId: number | null): Promise<void> {
    await this.post(`/api/v1/native-chat/attachments/${attachmentId}/resolve-image-match`, { applicationNo, orderId })
    this.pendingImageMatches.delete(attachmentId)
  }

  private async refreshPendingImageMatches(): Promise<void> {
    if (!this.config || this.stopping) return
    try {
      const response = await this.get('/api/v1/native-chat/pending-image-matches')
      const items = response.data as NativePendingImageMatch[]
      if (!Array.isArray(items)) throw new Error('后台返回的图片待确认列表格式无效')
      const current = new Map<number, NativePendingImageMatch>()
      for (const item of items) {
        if (!Number.isSafeInteger(item.attachmentId) || !item.imageUrl || !Array.isArray(item.candidateApplications)) {
          throw new Error('后台返回了无效的挂号凭证待确认记录')
        }
        current.set(item.attachmentId, item)
        if (!this.pendingImageMatches.has(item.attachmentId)) this.imageMatchListener?.(item)
      }
      this.pendingImageMatches = current
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log('app', 'error', `挂号凭证待确认列表同步失败：${detail}`)
    }
  }

  async openLog(): Promise<void> {
    if (!existsSync(this.logPath)) {
      mkdirSync(app.getPath('userData'), { recursive: true })
      appendFileSync(this.logPath, '', 'utf8')
    }
    const error = await shell.openPath(app.getPath('userData'))
    if (error) throw new Error(`无法打开消息采集日志目录：${error}`)
  }

  private log(channel: Channel | 'app', event: string, detail: string): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), channel, event, detail })}\n`, 'utf8')
  }

  private logStructured(channel: Channel | 'app', event: string, fields: Record<string, unknown>): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), channel, event, ...fields })}\n`, 'utf8')
  }

  private setHealth(channel: Channel, state: CollectorHealthState, detail: string): void {
    const previous = this.health[channel]
    if (previous.state === state && previous.detail === detail) return
    this.health[channel] = { state, detail, updatedAt: new Date().toISOString() }
    this.log(channel, 'health', `${state}: ${detail}`)
    this.statusListener?.(this.getHealth())
  }

  private resourceRoot(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'native-chat-collectors')
      : join(app.getAppPath(), '..', 'native-chat-collectors')
  }

  private ensureChildren(): void {
    if (process.platform !== 'win32') return
    if (!this.wxworkContextBlocked) {
      try {
        const current = this.wxworkContext
          ? resolveWxworkContextAtRoot(this.wxworkContext.wecomRoot)
          : resolveWxworkContext(app.getPath('documents'))
        if (this.wxworkContext && current.identityKey !== this.wxworkContext.identityKey) {
          this.blockWxworkContext('检测到企业微信切换了当前企业，消息采集已暂停。请重启寰宇医道客户端后继续。')
        } else if (!this.wxworkContext) {
          this.wxworkContext = current
          this.lastWxworkContextError = null
          this.setHealth('wxwork', 'starting', '已识别企业微信账号，正在启动采集程序')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法识别企业微信当前账号。'
        if (this.wxworkContext) this.blockWxworkContext(`无法确认企业微信当前账号，消息采集已暂停。${message}`)
        else this.reportWxworkContextWaiting(message)
      }
    }
    const root = this.resourceRoot()
    const wechatExe = join(root, 'wechat', 'hyyd-wechat-collector.exe')
    const wxworkExe = join(root, 'wxwork', 'hyyd-wxwork-collector.exe')
    const specs: Array<{ channel: Channel; executable: string; args: string[]; requiredFiles: string[] }> = [
      { channel: 'wechat', executable: wechatExe, args: ['--retry-state', join(app.getPath('userData'), 'native-chat', 'wechat-media-retries.json')], requiredFiles: [] }
    ]
    if (!this.wxworkContextBlocked && this.wxworkContext) {
      specs.push({
        channel: 'wxwork',
        executable: wxworkExe,
        args: [
          '--media-dir', join(app.getPath('userData'), 'native-chat', 'wxwork-media'),
          '--source-root', this.wxworkContext.sourceRoot,
          '--account-directory-id', this.wxworkContext.accountDirectoryId
        ],
        requiredFiles: []
      })
    }
    const missing = specs.filter(({ executable, requiredFiles }) =>
      !existsSync(executable) || requiredFiles.some((file) => !existsSync(file))
    )
    if (missing.length) {
      const message = `消息采集程序资源缺失：${missing.map(({ channel }) => channel).join('、')}`
      for (const { channel } of missing) this.setHealth(channel, 'error', message)
      throw new Error(message)
    }
    for (const { channel, executable, args } of specs) {
      if (this.children.has(channel)) continue
      this.setHealth(channel, 'starting', '采集程序已启动，正在等待就绪')
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(executable, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: channel === 'wxwork'
            ? { ...process.env, WECOM_ARCHIVE_SERVER_DATA: join(app.getPath('userData'), 'native-chat', 'wxwork-data') }
            : process.env
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log(channel, 'spawn_failed', message)
        this.setHealth(channel, 'error', `采集程序启动失败：${message}`)
        throw error
      }
      this.children.set(channel, child)
      this.buffers.set(channel, '')
      child.stdin.on('error', (error) => {
        this.log(channel, 'command_pipe_error', error.message)
        if (this.children.get(channel) === child && !this.stopping) {
          this.setHealth(channel, 'error', `采集程序控制通道异常：${error.message}`)
        }
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (part: string) => this.consume(channel, part))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (part: Buffer | string) => {
        const detail = (typeof part === 'string' ? part : part.toString('utf8')).trim()
        if (!detail) return
        this.log(channel, 'stderr', detail)
        const errorLine = detail.split(/\r?\n/).find((line) => /\b(?:ERROR|CRITICAL)\b/.test(line))
        if (errorLine || !/\bWARNING\b/.test(detail)) {
          this.setHealth(channel, 'error', `采集程序报告错误：${errorLine ?? detail}`)
        }
      })
      child.on('error', (error) => {
        this.log(channel, 'spawn_error', error.message)
        this.setHealth(channel, 'error', `采集程序启动失败：${error.message}`)
      })
      child.on('exit', (code, signal) => {
        if (this.children.get(channel) !== child) return
        this.children.delete(channel)
        const detail = `采集程序退出 code=${String(code)} signal=${String(signal)}`
        this.log(channel, 'exit', detail)
        if (!this.stopping) this.setHealth(channel, 'error', detail)
        if (!this.stopping && this.config) setTimeout(() => this.ensureChildren(), 5_000).unref()
      })
    }
  }

  private blockWxworkContext(message: string): void {
    this.wxworkContextBlocked = true
    const child = this.children.get('wxwork')
    if (child) {
      this.children.delete('wxwork')
      this.requestCollectorStop(child, 'wxwork')
    }
    this.sessions.forEach((session, key) => {
      if (session.channel === 'wxwork') this.sessions.delete(key)
    })
    console.error(`[native-chat:wxwork] ${message}`)
    this.setHealth('wxwork', 'error', message)
  }

  private reportWxworkContextWaiting(message: string): void {
    if (this.lastWxworkContextError !== message) {
      this.lastWxworkContextError = message
      console.error(`[native-chat:wxwork] ${message} 识别成功前不会启动企微采集。`)
      this.log('wxwork', 'context_waiting', message)
    }
    this.setHealth('wxwork', 'waiting', `${message}；识别成功后会自动启动采集`)
  }

  private verifyWxworkContext(checkStorageConfiguration = false): boolean {
    if (this.wxworkContextBlocked) return false
    if (!this.wxworkContext) {
      this.blockWxworkContext('无法识别企业微信当前账号，消息采集已暂停。')
      return false
    }
    try {
      const current = checkStorageConfiguration
        ? resolveWxworkContext(app.getPath('documents'))
        : resolveWxworkContextAtRoot(this.wxworkContext.wecomRoot)
      if (current.identityKey !== this.wxworkContext.identityKey) {
        this.blockWxworkContext('检测到企业微信切换了当前企业，消息采集已暂停。请重启寰宇医道客户端后继续。')
        return false
      }
      return true
    } catch (error) {
      this.blockWxworkContext(error instanceof Error ? error.message : '无法确认企业微信当前账号，消息采集已暂停。')
      return false
    }
  }

  private consume(channel: Channel, part: string): void {
    let buffer = (this.buffers.get(channel) ?? '') + part
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let event: CollectorEvent
      try {
        const parsed: unknown = JSON.parse(line)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { event?: unknown }).event !== 'string') {
          throw new Error('collector event must be an object with an event type')
        }
        const eventName = (parsed as { event: string }).event
        if (!['ready', 'sessions', 'message_batch', 'source_read_started', 'source_read_result', 'source_encode_started', 'source_encode_progress', 'source_encode_completed', 'source_attachment_resolve_started', 'source_attachment_resolve_completed', 'source_scan_progress', 'cursor_checkpoint', 'initial_history_complete', 'media_batch', 'fatal', 'error', 'subscribed'].includes(eventName)) {
          throw new Error(`unsupported collector event: ${eventName}`)
        }
        event = parsed as CollectorEvent
      } catch {
        const message = '采集进程返回无效协议数据'
        console.error(`[native-chat:${channel}] ${message}`)
        this.log(channel, 'protocol_error', message)
        this.setHealth(channel, 'error', message)
        const child = this.children.get(channel)
        if (child) child.kill()
        return
      }
      if (event.event === 'source_scan_progress') {
        const { event: _event, channel: _channel, ...fields } = event
        const detail = typeof fields.detail === 'string' ? fields.detail : ''
        const sourceConversationId = typeof fields.sourceConversationId === 'string'
          ? fields.sourceConversationId
          : detail.match(/当前会话 ID：([^。]+)/)?.[1] ?? null
        const session = sourceConversationId
          ? [...this.sessions.values()].find((item) => item.channel === channel && item.sourceConversationId === sourceConversationId)
          : null
        this.logStructured(channel, 'source_scan_progress', {
          ...fields,
          sourceConversationId,
          title: session?.title ?? null
        })
        continue
      }
      if (event.event === 'source_read_result') {
        const session = [...this.sessions.values()].find((item) =>
          item.channel === channel && item.sourceConversationId === event.sourceConversationId
        )
        this.logStructured(channel, 'source_read_result', {
          title: session?.title ?? null,
          sourceConversationId: event.sourceConversationId,
          isInitialHistory: event.isInitialHistory,
          sourceRowCount: event.sourceRowCount,
          elapsedMs: event.elapsedMs ?? null
        })
        continue
      }
      if (event.event === 'source_read_started' || event.event === 'source_encode_started'
        || event.event === 'source_encode_progress' || event.event === 'source_encode_completed'
        || event.event === 'source_attachment_resolve_started' || event.event === 'source_attachment_resolve_completed') {
        const session = this.sessions.get(cursorKey({ channel, accountId: event.accountId, sourceConversationId: event.sourceConversationId }))
        const { event: eventName, channel: _channel, ...fields } = event
        const suppressed = eventName === 'source_read_started' && event.isInitialHistory === false
          ? this.readLogThrottle.take(`started\u001f${channel}\u001f${event.accountId}\u001f${event.sourceConversationId}\u001f${event.isInitialHistory}`)
          : 0
        if (suppressed === null) continue
        this.logStructured(channel, eventName, {
          ...fields,
          title: session?.title ?? event.title ?? null,
          ...(suppressed > 0 ? { suppressedCount: suppressed } : {})
        })
        continue
      }
      if (event.event === 'subscribed') {
        this.logStructured(channel, 'subscription_applied', {
          selectedConversationCount: event.conversationIds.length
        })
        continue
      }
      if (event.event === 'message_batch') {
        const session = this.sessions.get(cursorKey({
          channel,
          accountId: event.accountId,
          sourceConversationId: event.sourceConversationId
        }))
        this.logStructured(channel, 'source_messages_read', {
          title: session?.title ?? null,
          sourceConversationId: event.sourceConversationId,
          cursorAfter: event.cursorAfter ?? event.sortSeq ?? null,
          messageCount: event.messages.length,
          attachmentCount: event.messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0),
          localAttachmentCount: event.messages.reduce((count, message) => count + (message.attachments?.filter((attachment) => Boolean(attachment.localPath)).length ?? 0), 0)
        })
      }
      if (event.event === 'ready' || event.event === 'sessions') {
        this.enqueueDiscoveryEvent(channel, event)
        continue
      }
      void this.handleEventWithRetry(channel, event)
    }
    this.buffers.set(channel, buffer)
  }

  private enqueueDiscoveryEvent(channel: Channel, event: DiscoveryEvent): void {
    // A fresh full directory replaces an older queued one for this channel.
    this.pendingDiscoveryEvents.set(channel, event)
    if (this.discoveryWorkerRunning) return
    this.discoveryWorkerRunning = true
    void this.drainDiscoveryEvents()
  }

  private async drainDiscoveryEvents(): Promise<void> {
    try {
      while (!this.stopping && this.pendingDiscoveryEvents.size > 0) {
        const next = this.pendingDiscoveryEvents.entries().next().value as [Channel, DiscoveryEvent] | undefined
        if (!next) break
        const [channel, event] = next
        this.pendingDiscoveryEvents.delete(channel)
        try {
          await this.processDiscoveryEvent(channel, event)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          this.log(channel, 'discovery_event_error', `${this.eventDescription(event)}；${detail}`)
          this.setHealth(channel, 'error', `会话目录处理失败：${detail}`)
        }
      }
    } finally {
      this.discoveryWorkerRunning = false
      if (!this.stopping && this.pendingDiscoveryEvents.size > 0) {
        this.discoveryWorkerRunning = true
        void this.drainDiscoveryEvents()
      }
    }
  }

  private async processDiscoveryEvent(channel: Channel, event: DiscoveryEvent): Promise<void> {
    if (channel === 'wxwork' && !this.verifyWxworkContext()) return
    if (!Array.isArray(event.sessions)) throw new Error('采集进程会话目录格式错误')
    if (event.event === 'ready' && event.channel !== channel) throw new Error('采集进程就绪事件的平台与进程不一致')
    for (const session of event.sessions) {
      if (session.channel !== channel) throw new Error('采集进程返回的平台与进程不一致')
    }

    const current = new Map(event.sessions.map((session) => [cursorKey(session), discoveryFingerprint(session)]))
    const previous = this.successfulDiscoveryFingerprints.get(channel)
    const fullSyncDue = !previous || event.event === 'ready'
      || Date.now() - (this.lastFullDiscoveryAt.get(channel) ?? 0) >= DISCOVERY_FULL_SYNC_MS
    const changedSessions = previous
      ? event.sessions.filter((session) => previous.get(cursorKey(session)) !== current.get(cursorKey(session)))
      : event.sessions
    this.logStructured(channel, 'discovery_inventory', {
      eventType: event.event,
      discoveredSessionCount: event.sessions.length,
      changedSessionCount: changedSessions.length,
      sessions: changedSessions.map((session) => ({
        title: session.title,
        kind: session.kind,
        accountId: session.accountId,
        sourceConversationId: session.sourceConversationId
      }))
    })
    const sessionsToMatch = fullSyncDue ? event.sessions : changedSessions
    const shouldPostDiscovery = fullSyncDue || changedSessions.length > 0

    if (!shouldPostDiscovery) {
      await this.refreshSubscriptions(event.sessions, channel)
      this.successfulDiscoveryFingerprints.set(channel, current)
      this.setActivityHealth(channel, '会话目录无变化，采集正常')
      this.log(channel, 'discovery_unchanged', `sessions=${event.sessions.length}`)
      return
    }

    let collectionConfig: NativeChatCollectionConfig | null = null
    let collectionConfigError: string | null = null
    let discoverySessions: Session[] = []
    try {
      const response = await this.request('GET', '/api/v1/native-chat/collection-config', undefined, 0)
      const candidate = response.data as NativeChatCollectionConfig
      if (!candidate || !Array.isArray(candidate.rules)) throw new Error('服务端会话采集配置格式错误')
      collectionConfig = candidate
      this.persistCollectionRules(candidate)
      this.updateActivityIssues(event.sessions, candidate, channel)
      const ruleMatches = event.sessions.map((session) => {
        const rule = candidate.rules.find((item) => matchesRule(item, session))
        return { title: session.title, kind: session.kind, sourceConversationId: session.sourceConversationId, matchedRuleId: rule?.id ?? null, activity: sessionActivity(session) }
      })
      const matches = new Set(event.sessions
        .filter((session) => candidate.rules.some((rule) => matchesRule(rule, session))
          && sessionActivity(session) === 'recent')
        .map(cursorKey))
      discoverySessions = sessionsToMatch.filter((session) => matches.has(cursorKey(session)))
      this.logStructured(channel, 'discovery_rule_match', {
        configVersion: candidate.version,
        discoveredSessionCount: event.sessions.length,
        matchedSessionCount: ruleMatches.filter((item) => item.matchedRuleId !== null).length,
        unmatchedSessionCount: ruleMatches.filter((item) => item.matchedRuleId === null).length,
        recentMatchedSessionCount: ruleMatches.filter((item) => item.matchedRuleId !== null && item.activity === 'recent').length,
        inactiveMatchedSessionCount: ruleMatches.filter((item) => item.matchedRuleId !== null && item.activity === 'inactive').length,
        unknownActivitySessionCount: ruleMatches.filter((item) => item.matchedRuleId !== null && item.activity === 'unknown').length,
        sessions: ruleMatches
      })
      if (discoverySessions.length === 0) {
        this.successfulDiscoveryFingerprints.set(channel, current)
        if (fullSyncDue) this.lastFullDiscoveryAt.set(channel, Date.now())
        await this.refreshSubscriptions(event.sessions, channel, collectionConfig)
        this.logStructured(channel, 'discovery_sync', {
          eventType: event.event,
          discoveredSessionCount: event.sessions.length,
          matchedSessionCount: ruleMatches.filter((item) => item.matchedRuleId !== null).length,
          submittedSessionCount: 0,
          status: 'no_recent_matching_sessions'
        })
        this.setActivityHealth(channel, '会话规则已匹配，等待业务会话消息')
        return
      }
    } catch (error) {
      collectionConfigError = error instanceof Error ? error.message : String(error)
      this.logStructured(channel, 'discovery_rule_match', {
        configVersion: null,
        discoveredSessionCount: event.sessions.length,
        matchedSessionCount: null,
        unmatchedSessionCount: null,
        matchingStatus: 'configuration_unavailable',
        error: collectionConfigError
      })
      this.log(channel, 'discovery_deferred', `规则暂不可用，本轮未向后台提交会话目录；继续使用本机已确认的订阅规则：${collectionConfigError}`)
      if (this.cachedCollectionConfig) {
        const prior = new Set(this.selectedSubscriptions.map(cursorKey))
        for (const session of event.sessions) this.sessions.set(cursorKey(session), session)
        const newlyActive = event.sessions.filter((session) => !prior.has(cursorKey(session))
          && sessionActivity(session) === 'recent'
          && this.cachedCollectionConfig!.rules.some((rule) => matchesRule(rule, session)))
        if (newlyActive.length) {
          this.activateConfirmedSessions(newlyActive)
          this.logStructured(channel, 'offline_rules_activated', { count: newlyActive.length, sessions: newlyActive.map((session) => ({ title: session.title, sourceConversationId: session.sourceConversationId })) })
        }
        this.updateActivityIssues(event.sessions, this.cachedCollectionConfig, channel)
      }
      return
    }

    const configVersion = String(collectionConfig!.version)
    let progress = this.discoveryProgress.get(channel)
    if (!progress || progress.configVersion !== configVersion) {
      progress = { configVersion, confirmed: new Map() }
      this.discoveryProgress.set(channel, progress)
    }
    const remaining = discoverySessions.filter((session) => progress!.confirmed.get(cursorKey(session)) !== discoveryFingerprint(session))
    try {
      await this.syncSelectedConversations(remaining, (batch) => {
        this.activateConfirmedSessions(batch)
        for (const session of batch) progress!.confirmed.set(cursorKey(session), discoveryFingerprint(session))
        this.persistDiscoveryProgress()
      }, { channel, total: discoverySessions.length, alreadyConfirmed: discoverySessions.length - remaining.length })
      if (this.stopping) return
      this.successfulDiscoveryFingerprints.set(channel, current)
      if (fullSyncDue) this.lastFullDiscoveryAt.set(channel, Date.now())
      this.discoveryProgress.delete(channel)
      this.persistDiscoveryProgress()
      await this.refreshSubscriptions(event.sessions, channel, collectionConfig ?? undefined, discoverySessions)
      this.setActivityHealth(channel, '采集程序已就绪并已连接后台')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(channel, 'discovery_failed', `${this.eventDescription(event)}；${message}；已确认批次保留，等待重试未完成批次`)
      this.setHealth(channel, 'error', `会话目录同步失败：${message}`)
    }
  }

  private async handleEventWithRetry(channel: Channel, event: CollectorEvent, attempt = 0): Promise<void> {
    try {
      await this.handleEvent(channel, event)
      if (attempt > 0) {
        const detail = `${this.eventDescription(event)}；重试 ${attempt} 次后已处理`
        this.log(channel, 'event_retry_recovered', detail)
        this.setActivityHealth(channel, '采集消息处理已恢复')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const detail = `${this.eventDescription(event)}；${message}`
      console.error(`[native-chat:${channel}] 采集事件处理失败，批次仍未确认：${detail}`)
      if (attempt === 0) {
        this.log(channel, 'event_handler_error', detail)
        this.setHealth(channel, 'error', `采集事件处理失败：${detail}`)
      }
      const delay = Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5)))
      setTimeout(() => void this.handleEventWithRetry(channel, event, attempt + 1), delay).unref()
    }
  }

  private eventDescription(event: CollectorEvent): string {
    if (event.event === 'message_batch') {
      const session = this.sessions.get(cursorKey({
        channel: event.channel,
        accountId: event.accountId,
        sourceConversationId: event.sourceConversationId
      }))
      return `event=message_batch title=${session?.title ?? '未知会话'} conversation=${event.sourceConversationId} messages=${event.messages.length} attachments=${event.messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0)} cursor=${event.cursorAfter ?? event.sortSeq ?? 'missing'}`
    }
    if (event.event === 'media_batch') {
      return `event=media_batch conversation=${event.sourceConversationId} message=${event.mediaSourceMessageId}`
    }
    return `event=${event.event}`
  }

  private async handleEvent(channel: Channel, event: CollectorEvent): Promise<void> {
    if (channel === 'wxwork' && !this.verifyWxworkContext()) return
    if (event.event === 'ready' || event.event === 'sessions') {
      await this.processDiscoveryEvent(channel, event)
      return
    }
    if (event.event === 'cursor_checkpoint') {
      if (event.channel !== channel || typeof event.cursorAfter !== 'string' || !event.cursorAfter) {
        throw new Error('首次采集游标确认格式错误')
      }
      const key = cursorKey({ channel, accountId: event.accountId, sourceConversationId: event.sourceConversationId })
      if (!this.sessions.has(key)) throw new Error('首次采集游标对应的会话尚未登记')
      let value: unknown
      try { value = JSON.parse(event.cursorAfter) } catch { throw new Error('首次采集游标不是有效 JSON') }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('首次采集游标格式错误')
      if (channel === 'wechat') {
        const cursorValue = value as { sortSeq?: unknown; shard?: unknown; localId?: unknown }
        if (typeof cursorValue.sortSeq !== 'number' || !Number.isSafeInteger(cursorValue.sortSeq) || cursorValue.sortSeq < 0
          || typeof cursorValue.shard !== 'string' || typeof cursorValue.localId !== 'number'
          || !Number.isSafeInteger(cursorValue.localId) || cursorValue.localId < 0) {
          throw new Error('微信首次采集游标字段无效')
        }
      } else {
        wxworkCursorRowId(event.cursorAfter)
      }
      const previous = this.cursors[key]
      const previousIsAhead = previous && (channel === 'wxwork'
        ? wxworkCursorRowId(previous) > wxworkCursorRowId(event.cursorAfter)
        : cursorSortSeq(channel, previous) > cursorSortSeq(channel, event.cursorAfter))
      if (!previousIsAhead) {
        this.cursors[key] = event.cursorAfter
        this.persistCursors()
      }
      this.send(channel, {
        type: 'ack',
        sourceConversationId: event.sourceConversationId,
        cursor: event.cursorAfter,
        pendingMediaSourceMessageIds: Object.keys(this.pendingMedia[key] ?? {})
      })
      return
    }
    if (event.event === 'initial_history_complete') {
      if (event.channel !== channel || !Number.isSafeInteger(event.sourceRowsProcessedThisRun) || event.sourceRowsProcessedThisRun < 0) {
        throw new Error('首次历史回补完成事件格式错误')
      }
      const key = cursorKey({ channel, accountId: event.accountId, sourceConversationId: event.sourceConversationId })
      const cutoff = this.initialHistoryState.pendingCutoffs[key]
      if (cutoff === undefined || !this.sessions.has(key)) throw new Error('首次历史回补完成事件对应的会话未处于回补状态')
      if (!initialHistoryCursorMatches(channel, this.cursors[key], event.cursorAfter)) throw new Error('首次历史回补完成游标与客户端已确认游标不一致')
      if (this.cursors[key] === undefined) {
        this.cursors[key] = event.cursorAfter
        this.persistCursors()
      }
      delete this.initialHistoryState.pendingCutoffs[key]
      if (!this.initialHistoryState.completed.includes(key)) this.initialHistoryState.completed.push(key)
      this.persistInitialHistoryState()
      this.send(channel, { type: 'initial_history_complete_ack', sourceConversationId: event.sourceConversationId, cursor: event.cursorAfter })
      this.logStructured(channel, 'initial_history_complete', {
        title: this.sessions.get(key)?.title ?? null,
        sourceConversationId: event.sourceConversationId,
        cutoffEpochMs: cutoff,
        cursorAfter: event.cursorAfter,
        sourceRowsProcessedThisRun: event.sourceRowsProcessedThisRun
      })
      return
    }
    if (event.event === 'message_batch' || event.event === 'media_batch') {
      if (!Array.isArray(event.messages)) throw new Error('采集消息批次格式错误')
      if (event.channel !== channel) throw new Error('采集消息批次的平台与进程不一致')
      if (event.event === 'media_batch' && channel !== 'wechat') throw new Error('只有微信采集进程可以发送附件补采批次')
      const key = cursorKey({ channel, accountId: event.accountId, sourceConversationId: event.sourceConversationId })
      const conversation = this.sessions.get(key)
      if (!conversation) throw new Error('消息批次对应的会话尚未登记')
      const uploadFiles = new Map<string, string>()
      const replaceFiles = new Set<string>()
      const skippedFiles = new Map<string, string>()
      const messages = expireOldPendingMedia(event.messages).map((message) => ({
        ...message,
        attachments: message.attachments?.map((originalAttachment) => {
          const attachment = applyAttachmentUploadLimit(originalAttachment)
          if (attachment.sourceMetadata?.resolutionState === 'upload_size_exceeded') {
            if (originalAttachment.localPath) skippedFiles.set(`${message.sourceMessageId}\u001f${attachment.sourceAttachmentId}`, originalAttachment.localPath)
            this.logStructured(channel, 'attachment_upload_skipped', {
              title: conversation.title,
              sourceConversationId: event.sourceConversationId,
              messageSourceId: message.sourceMessageId,
              sourceAttachmentId: attachment.sourceAttachmentId,
              fileName: attachment.fileName ?? null,
              byteSize: attachment.byteSize ?? null,
              reason: 'upload_size_exceeded'
            })
          }
          if (attachment.localPath) {
            if (!attachment.sourceAttachmentId?.trim()) throw new Error(`本地附件缺少来源 ID：${message.sourceMessageId}`)
            const attachmentKey = `${message.sourceMessageId}\u001f${attachment.sourceAttachmentId}`
            uploadFiles.set(attachmentKey, attachment.localPath)
            if (attachment.kind === 'image' && attachment.sourceMetadata?.rendition === 'non_thumbnail') replaceFiles.add(attachmentKey)
            const { localPath: _localPath, ...metadata } = attachment
            return { ...metadata, state: 'not_downloaded' as const }
          }
          return attachment
        })
      }))
      this.logStructured(channel, 'message_upload_started', {
        title: conversation.title,
        sourceConversationId: event.sourceConversationId,
        messageCount: messages.length,
        attachmentCount: messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0),
        localAttachmentCount: uploadFiles.size
      })
      let response: any
      try {
        response = await this.post('/api/v1/native-chat/ingest', { conversation, messages })
      } catch (error) {
        if (error instanceof BackendResponseError && error.status === 409 && error.code === 'conversation_not_registered') {
          this.logStructured(channel, 'message_waiting_for_discovery', {
            title: conversation.title,
            sourceConversationId: event.sourceConversationId,
            messageCount: messages.length
          })
          await this.syncSelectedConversations([conversation])
          response = await this.post('/api/v1/native-chat/ingest', { conversation, messages })
        } else {
          this.logStructured(channel, 'message_upload_failed', {
            stage: 'ingest_request',
            title: conversation.title,
            sourceConversationId: event.sourceConversationId,
            messageCount: messages.length,
            error: error instanceof Error ? error.message : String(error)
          })
          throw error
        }
      }
      const data = response.data as {
        acknowledged?: boolean
        attachmentRefs?: Array<{ messageSourceId: string; sourceAttachmentId: string; id: number }>
      } | undefined
      if (!data?.acknowledged) throw new Error('服务端未确认消息已入库')
      this.logStructured(channel, 'message_ingest_confirmed', {
        accountId: event.accountId,
        title: conversation.title,
        sourceConversationId: event.sourceConversationId,
        messageCount: messages.length,
        attachmentCount: messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0)
      })
      if (!Array.isArray(data.attachmentRefs)) throw new Error('服务端未返回附件确认列表')
      const expectedAttachmentKeys = new Set<string>()
      for (const message of messages) {
        for (const attachment of message.attachments ?? []) {
          if (!attachment.sourceAttachmentId?.trim()) throw new Error(`消息附件缺少来源 ID：${message.sourceMessageId}`)
          expectedAttachmentKeys.add(`${message.sourceMessageId}\u001f${attachment.sourceAttachmentId}`)
        }
      }
      if (expectedAttachmentKeys.size !== messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0)) {
        throw new Error('消息批次包含重复来源附件 ID')
      }
      if (data.attachmentRefs.length !== expectedAttachmentKeys.size) throw new Error('服务端附件确认数量与消息附件数量不一致')
      const confirmedAttachmentKeys = new Set<string>()
      const confirmedUploads = new Set<string>()
      for (const attachment of data.attachmentRefs) {
        const attachmentKey = `${attachment.messageSourceId}\u001f${attachment.sourceAttachmentId}`
        if (!expectedAttachmentKeys.has(attachmentKey)) throw new Error('服务端确认了本批次不存在的附件')
        if (confirmedAttachmentKeys.has(attachmentKey)) throw new Error('服务端重复确认了一项附件')
        confirmedAttachmentKeys.add(attachmentKey)
        const path = uploadFiles.get(attachmentKey)
        if (path) {
          try {
            const uploadStartedAt = Date.now()
            const uploadBytes = statSync(path).size
            this.logStructured(channel, 'message_attachment_upload_started', {
              accountId: event.accountId,
              title: conversation.title,
              sourceConversationId: event.sourceConversationId,
              attachmentId: attachment.id,
              messageSourceId: attachment.messageSourceId,
              sourceAttachmentId: attachment.sourceAttachmentId,
              byteSize: uploadBytes,
              replaceExisting: replaceFiles.has(attachmentKey)
            })
            const uploadResult = await this.uploadAttachment(attachment.id, path, replaceFiles.has(attachmentKey))
            confirmedUploads.add(attachmentKey)
            this.logStructured(channel, 'message_attachment_upload_completed', {
              accountId: event.accountId,
              title: conversation.title,
              sourceConversationId: event.sourceConversationId,
              attachmentId: attachment.id,
              messageSourceId: attachment.messageSourceId,
              sourceAttachmentId: attachment.sourceAttachmentId,
              byteSize: uploadBytes,
              uploadResult,
              elapsedMs: Date.now() - uploadStartedAt
            })
          } catch (error) {
            this.logStructured(channel, 'message_attachment_upload_failed', {
              title: conversation.title,
              sourceConversationId: event.sourceConversationId,
              attachmentId: attachment.id,
              messageSourceId: attachment.messageSourceId,
              sourceAttachmentId: attachment.sourceAttachmentId,
              error: error instanceof Error ? error.message : String(error)
            })
            throw error
          }
        }
      }
      for (const attachmentKey of uploadFiles.keys()) {
        if (!confirmedAttachmentKeys.has(attachmentKey)) throw new Error('服务端未确认一项本地待上传附件')
      }
      for (const attachmentKey of expectedAttachmentKeys) {
        if (!confirmedAttachmentKeys.has(attachmentKey)) throw new Error('服务端漏确认了一项消息附件')
      }
      this.reconcilePendingMedia(key, messages, confirmedUploads)
      this.persistPendingMedia()
      this.cleanupUploadedFiles(channel, skippedFiles)
      if (event.event === 'media_batch') {
        this.cleanupUploadedFiles(channel, uploadFiles)
        this.send(channel, {
          type: 'media_ack',
          sourceConversationId: event.sourceConversationId,
          sourceMessageId: event.mediaSourceMessageId,
          pendingAttachmentIds: this.pendingMedia[key]?.[event.mediaSourceMessageId] ?? []
        })
        return
      }
      const cursor = event.cursorAfter ?? (event.sortSeq == null ? null : String(event.sortSeq))
      if (cursor == null) throw new Error('消息批次缺少可持久化游标')
      const storedCursor = this.cursors[key]
      this.cursors[key] = channel === 'wxwork' && storedCursor && wxworkCursorRowId(storedCursor) > wxworkCursorRowId(cursor)
        ? storedCursor
        : cursor
      this.persistCursors()
      const initialBackfillCutoff = this.initialHistoryState.pendingCutoffs[key]
      this.logStructured(channel, initialBackfillCutoff === undefined ? 'message_batch_ack' : 'initial_history_page_ack', {
        title: conversation.title,
        sourceConversationId: event.sourceConversationId,
        messageCount: messages.length,
        attachmentCount: messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0),
        cursorAfter: cursor,
        initialHistoryCutoffEpochMs: initialBackfillCutoff ?? null,
        status: 'backend_confirmed'
      })
      this.send(channel, {
        type: 'ack',
        sourceConversationId: event.sourceConversationId,
        cursor,
        sortSeq: event.sortSeq,
        pendingMediaSourceMessageIds: Object.keys(this.pendingMedia[key] ?? {})
      })
      this.cleanupUploadedFiles(channel, uploadFiles)
      return
    }
    if (event.event === 'fatal' || event.event === 'error') {
      const progress = event.stage === 'message_poll'
        ? '游标未推进'
        : event.stage === 'media_recheck'
          ? '附件补查未完成'
          : null
      const detail = [`stage=${event.stage ?? 'unknown'}`, event.message ?? '采集进程未提供错误详情', progress].filter(Boolean).join('；')
      console.error(`[native-chat:${channel}] 采集错误 ${detail}`)
      this.logStructured(channel, event.event, {
        accountId: event.accountId ?? null,
        title: event.title ?? this.sessions.get(cursorKey({ channel, accountId: event.accountId ?? '', sourceConversationId: event.sourceConversationId ?? '' }))?.title ?? null,
        sourceConversationId: event.sourceConversationId ?? null,
        sourceMessageId: event.sourceMessageId ?? null,
        stage: event.stage ?? null,
        repeatCount: event.repeatCount ?? null,
        message: event.message ?? null
      })
      this.setHealth(channel, 'error', detail)
      if (channel === 'wxwork' && event.event === 'fatal') {
        this.blockWxworkContext(`企微采集启动失败，消息采集已暂停。${event.message ?? '请检查企业微信登录状态后重启寰宇医道客户端。'}`)
      }
    }
  }

  private activateConfirmedSessions(batch: Session[]): void {
    const selected = new Map(this.selectedSubscriptions.map((session) => [cursorKey(session), session]))
    let historyChanged = false
    const initialCutoff = Date.now() - INITIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000
    for (const session of batch) {
      const key = cursorKey(session)
      this.sessions.set(key, session)
      selected.set(key, session)
      if (this.initialHistoryState.completed.includes(key) || this.initialHistoryState.pendingCutoffs[key] !== undefined) continue
      this.cursors[key] = cursorForSession(session.channel, undefined)
      this.initialHistoryState.pendingCutoffs[key] = initialCutoff
      historyChanged = true
    }
    if (historyChanged) {
      this.persistCursors()
      this.persistInitialHistoryState()
    }
    this.selectedSubscriptions = [...selected.values()]
    this.persistSubscriptions(this.selectedSubscriptions)
    this.sendSavedSubscriptions()
  }

  private updateActivityIssues(sessions: Session[], config: NativeChatCollectionConfig, channel: Channel): void {
    const unknown = sessions
      .filter((session) => session.channel === channel
        && config.rules.some((rule) => matchesRule(rule, session))
        && sessionActivity(session) === 'unknown')
      .map((session) => `${session.sourceConversationId}:${session.title ?? ''}`)
      .sort()
    const previous = this.activityIssues.get(channel) ?? []
    if (JSON.stringify(previous) !== JSON.stringify(unknown)) {
      this.logStructured(channel, 'session_activity_unknown', { count: unknown.length, sessions: unknown })
    }
    this.activityIssues.set(channel, unknown)
  }

  private setActivityHealth(channel: Channel, normalDetail: string): void {
    const count = this.activityIssues.get(channel)?.length ?? 0
    if (count) this.setHealth(channel, 'error', `${count} 个符合规则的会话无法确认最近消息时间，请查看采集日志`)
    else this.setHealth(channel, 'running', normalDetail)
  }

  private async syncSelectedConversations(
    sessions: Session[],
    onConfirmed?: (batch: Session[]) => void,
    progress?: { channel: Channel; total: number; alreadyConfirmed: number }
  ): Promise<void> {
    if (sessions.length === 0) return
    let syncId = randomUUID()
    let startSnapshot = true
    for (let offset = 0; offset < sessions.length; offset += DISCOVERY_BATCH_SIZE) {
      if (this.stopping) throw new Error('客户端正在退出，目录同步尚未完成')
      const batch = sessions.slice(offset, offset + DISCOVERY_BATCH_SIZE)
      const lastBatch = offset + batch.length === sessions.length
      let lastError: Error | null = null
      let confirmed = false
      for (let attempt = 0; attempt < DISCOVERY_MAX_ATTEMPTS; attempt++) {
        const startedAt = Date.now()
        try {
          const response = await this.request('POST', '/api/v1/native-chat/discovery', {
            sessions: batch, syncId, startSnapshot, lastBatch
          }, 0, 120_000)
          if (response?.data?.discovered !== batch.length || response?.data?.persisted !== batch.length) {
            throw new Error(`会话目录确认数量不符：提交 ${batch.length}，解析 ${String(response?.data?.discovered)}，入库 ${String(response?.data?.persisted)}`)
          }
          startSnapshot = false
          if (this.stopping) throw new Error('客户端正在退出，目录同步尚未完成')
          onConfirmed?.(batch)
          this.logStructured(progress?.channel ?? batch[0].channel, 'discovery_batch_confirmed', {
            batchNumber: Math.floor(offset / DISCOVERY_BATCH_SIZE) + 1,
            batchCount: Math.ceil(sessions.length / DISCOVERY_BATCH_SIZE),
            batchSessionCount: batch.length,
            confirmedSessionCount: (progress?.alreadyConfirmed ?? 0) + offset + batch.length,
            totalSessionCount: progress?.total ?? sessions.length,
            elapsedMs: Date.now() - startedAt,
            attempt: attempt + 1
          })
          confirmed = true
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          this.logStructured(progress?.channel ?? batch[0].channel, 'discovery_batch_failed', {
            batchNumber: Math.floor(offset / DISCOVERY_BATCH_SIZE) + 1,
            batchSessionCount: batch.length,
            confirmedSessionCount: (progress?.alreadyConfirmed ?? 0) + offset,
            totalSessionCount: progress?.total ?? sessions.length,
            attempt: attempt + 1,
            elapsedMs: Date.now() - startedAt,
            error: lastError.message
          })
          if (error instanceof BackendResponseError && error.status === 409 && error.code === 'discovery_snapshot_expired') {
            syncId = randomUUID()
            startSnapshot = true
          } else if (error instanceof BackendResponseError && error.status >= 400 && error.status < 500 && error.status !== 429) {
            break
          }
          if (attempt + 1 < DISCOVERY_MAX_ATTEMPTS) {
            const delay = DISCOVERY_RETRY_DELAYS_MS[attempt] ?? DISCOVERY_RETRY_DELAYS_MS[DISCOVERY_RETRY_DELAYS_MS.length - 1]
            await new Promise((resolve) => setTimeout(resolve, delay))
          }
        }
      }
      if (!confirmed) throw lastError ?? new Error('会话目录批次未得到后台确认')
    }
  }

  private async refreshSubscriptions(discoveredSessions?: Session[], discoveredChannel?: Channel, knownConfig?: NativeChatCollectionConfig, confirmedSessions: Session[] = []): Promise<void> {
    if (this.refreshing || this.stopping || !this.config) return
    if (this.discoveryWorkerRunning && !discoveredSessions) return
    if (process.platform === 'win32' && !this.wxworkContextBlocked) {
      if (this.wxworkContext) this.verifyWxworkContext(true)
      else this.ensureChildren()
    }
    this.refreshing = true
    try {
      const response = knownConfig ? null : await this.get('/api/v1/native-chat/collection-config')
      const config = knownConfig ?? response?.data as NativeChatCollectionConfig
      if (!config || !Array.isArray(config.rules)) throw new Error('服务端会话采集配置格式错误')
      this.persistCollectionRules(config)
      const nextSessions = new Map(this.sessions)
      if (discoveredSessions) {
        nextSessions.forEach((session, key) => {
          if (session.channel === discoveredChannel) nextSessions.delete(key)
        })
        for (const session of discoveredSessions) nextSessions.set(cursorKey(session), session)
      }
      const alreadySelected = new Set(this.selectedSubscriptions.map(cursorKey))
      const availableSessions = [...nextSessions.values()]
      for (const channel of ['wechat', 'wxwork'] as const) this.updateActivityIssues(availableSessions, config, channel)
      const selected = availableSessions.filter((session) => config.rules.some((rule) => matchesRule(rule, session))
        && (alreadySelected.has(cursorKey(session)) || sessionActivity(session) === 'recent'))
      const confirmed = new Set(confirmedSessions.map(cursorKey))
      const newlySelected = selected.filter((session) => !alreadySelected.has(cursorKey(session)) && !confirmed.has(cursorKey(session)))
      await this.syncSelectedConversations(newlySelected, (batch) => this.activateConfirmedSessions(batch))
      let historyChanged = false
      const initialCutoff = Date.now() - INITIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000
      for (const session of selected) {
        const key = cursorKey(session)
        if (this.initialHistoryState.completed.includes(key) || this.initialHistoryState.pendingCutoffs[key] !== undefined) continue
        this.cursors[key] = cursorForSession(session.channel, undefined)
        this.initialHistoryState.pendingCutoffs[key] = initialCutoff
        historyChanged = true
      }
      if (historyChanged) {
        this.persistCursors()
        this.persistInitialHistoryState()
      }
      if (discoveredSessions && discoveredChannel) {
        const matchDetails = discoveredSessions.map((session) => ({
          title: session.title,
          kind: session.kind,
          sourceConversationId: session.sourceConversationId,
          matchedRuleId: config.rules.find((rule) => matchesRule(rule, session))?.id ?? null
        }))
        this.logStructured(discoveredChannel, 'discovery_rule_match_applied', {
          configVersion: config.version,
          discoveredSessionCount: discoveredSessions.length,
          matchedSessionCount: matchDetails.filter((item) => item.matchedRuleId !== null).length,
          unmatchedSessionCount: matchDetails.filter((item) => item.matchedRuleId === null).length,
          sessions: matchDetails
        })
      }
      this.persistSubscriptions(selected)
      this.sessions = nextSessions
      this.selectedSubscriptions = selected
      for (const channel of ['wechat', 'wxwork'] as const) {
        this.send(channel, {
          type: 'subscribe',
          conversations: selected.filter((session) => session.channel === channel).map((session) => ({
            sourceConversationId: session.sourceConversationId,
            cursor: cursorForSession(session.channel, this.cursors[cursorKey(session)]),
            sortSeq: cursorSortSeq(session.channel, cursorForSession(session.channel, this.cursors[cursorKey(session)])),
            ...(this.initialHistoryState.pendingCutoffs[cursorKey(session)] !== undefined
              ? { initialHistoryCutoffEpochMs: this.initialHistoryState.pendingCutoffs[cursorKey(session)], initialHistoryPageSize: INITIAL_HISTORY_PAGE_SIZE }
              : {}),
            pendingMediaSourceMessageIds: Object.keys(this.pendingMedia[cursorKey(session)] ?? {})
          }))
        })
        if (this.activityIssues.get(channel)?.length) this.setActivityHealth(channel, '')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (discoveredSessions && discoveredChannel) {
        this.logStructured(discoveredChannel, 'discovery_rule_match', {
          configVersion: null,
          discoveredSessionCount: discoveredSessions.length,
          matchedSessionCount: null,
          unmatchedSessionCount: null,
          matchingStatus: 'configuration_unavailable',
          error: message,
          sessions: discoveredSessions.map((session) => ({
            title: session.title,
            kind: session.kind,
            sourceConversationId: session.sourceConversationId
          }))
        })
      }
      console.error(`[native-chat] 采集规则同步失败，继续使用上次已确认的会话订阅：${message}`)
      this.log('app', 'subscription_sync_error', message)
      this.sendSavedSubscriptions()
    } finally {
      this.refreshing = false
    }
  }

  private send(channel: Channel, value: Record<string, unknown>): void {
    const child = this.children.get(channel)
    if (!child || child.killed) return
    try {
      child.stdin.write(`${JSON.stringify(value)}\n`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(channel, 'command_pipe_error', detail)
      if (this.children.get(channel) === child && !this.stopping) {
        this.setHealth(channel, 'error', `采集程序控制通道异常：${detail}`)
      }
    }
  }

  private requestCollectorStop(child: ChildProcessWithoutNullStreams, channel: Channel): void {
    try {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end('{"type":"stop"}\n')
      } else {
        this.log(channel, 'stop_command_pipe_closed', '采集器控制通道已关闭，直接结束子进程')
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(channel, 'stop_command_pipe_error', detail)
    }
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }, 2_000)
    forceKill.unref()
  }

  private persistCursors(): void {
    const directory = app.getPath('userData')
    mkdirSync(directory, { recursive: true })
    const temporary = `${this.cursorPath}.partial`
    writeFileSync(temporary, JSON.stringify(this.cursors), 'utf8')
    renameSync(temporary, this.cursorPath)
  }

  private persistInitialHistoryState(): void {
    const directory = app.getPath('userData')
    mkdirSync(directory, { recursive: true })
    const temporary = `${this.initialHistoryPath}.partial`
    writeFileSync(temporary, JSON.stringify(this.initialHistoryState), 'utf8')
    renameSync(temporary, this.initialHistoryPath)
  }

  private sendSavedSubscriptions(): void {
    for (const channel of ['wechat', 'wxwork'] as const) {
      this.send(channel, {
        type: 'subscribe',
        conversations: this.selectedSubscriptions.filter((session) => session.channel === channel).map((session) => {
          const cursor = cursorForSession(session.channel, this.cursors[cursorKey(session)])
          return {
            sourceConversationId: session.sourceConversationId,
            cursor,
            sortSeq: cursorSortSeq(session.channel, cursor),
            ...(this.initialHistoryState.pendingCutoffs[cursorKey(session)] !== undefined
              ? { initialHistoryCutoffEpochMs: this.initialHistoryState.pendingCutoffs[cursorKey(session)], initialHistoryPageSize: INITIAL_HISTORY_PAGE_SIZE }
              : {}),
            pendingMediaSourceMessageIds: Object.keys(this.pendingMedia[cursorKey(session)] ?? {})
          }
        })
      })
    }
  }

  private persistSubscriptions(sessions: Session[]): void {
    const directory = app.getPath('userData')
    mkdirSync(directory, { recursive: true })
    const temporary = `${this.subscriptionsPath}.partial`
    writeFileSync(temporary, JSON.stringify(sessions), 'utf8')
    renameSync(temporary, this.subscriptionsPath)
  }

  private persistCollectionRules(config: NativeChatCollectionConfig): void {
    if (!this.config) throw new Error('消息采集服务尚未配置')
    mkdirSync(app.getPath('userData'), { recursive: true })
    const temporary = `${this.collectionRulesPath}.partial`
    writeFileSync(temporary, JSON.stringify({ version: 1, ...this.config, collectionConfig: config }), 'utf8')
    renameSync(temporary, this.collectionRulesPath)
    this.cachedCollectionConfig = config
  }

  private restoreCollectionRules(): void {
    this.cachedCollectionConfig = null
    if (!this.config || !existsSync(this.collectionRulesPath)) return
    const value: unknown = JSON.parse(readFileSync(this.collectionRulesPath, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地会话采集规则格式错误')
    const data = value as { version?: unknown; backendUrl?: unknown; employeeCode?: unknown; collectionConfig?: NativeChatCollectionConfig }
    if (data.version !== 1) throw new Error('本地会话采集规则版本无效')
    if (data.backendUrl !== this.config.backendUrl || data.employeeCode !== this.config.employeeCode) return
    if (!data.collectionConfig || !Array.isArray(data.collectionConfig.rules)) throw new Error('本地会话采集规则内容无效')
    this.cachedCollectionConfig = data.collectionConfig
  }

  private restoreDiscoveryProgress(): void {
    if (!this.config || !existsSync(this.discoveryProgressPath)) return
    const data = JSON.parse(readFileSync(this.discoveryProgressPath, 'utf8')) as {
      version?: unknown; backendUrl?: unknown; employeeCode?: unknown; channels?: unknown
    }
    if (data.version !== 1 || !data.channels || typeof data.channels !== 'object' || Array.isArray(data.channels)) {
      throw new Error('本机会话目录同步进度格式无效')
    }
    if (data.backendUrl !== this.config.backendUrl || data.employeeCode !== this.config.employeeCode) return
    for (const [channel, raw] of Object.entries(data.channels as Record<string, unknown>)) {
      if ((channel !== 'wechat' && channel !== 'wxwork') || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('本机会话目录同步进度的平台无效')
      }
      const entry = raw as { configVersion?: unknown; confirmed?: unknown }
      if (typeof entry.configVersion !== 'string' || !entry.confirmed || typeof entry.confirmed !== 'object' || Array.isArray(entry.confirmed)) {
        throw new Error('本机会话目录同步进度内容无效')
      }
      const pairs = Object.entries(entry.confirmed as Record<string, unknown>)
      if (pairs.some(([key, value]) => !key || typeof value !== 'string')) throw new Error('本机会话目录确认记录无效')
      this.discoveryProgress.set(channel, { configVersion: entry.configVersion, confirmed: new Map(pairs as Array<[string, string]>) })
    }
  }

  private persistDiscoveryProgress(): void {
    if (!this.config) throw new Error('消息采集服务尚未配置')
    const channels = Object.fromEntries([...this.discoveryProgress].map(([channel, entry]) => [channel, {
      configVersion: entry.configVersion, confirmed: Object.fromEntries(entry.confirmed)
    }]))
    mkdirSync(app.getPath('userData'), { recursive: true })
    const temporary = `${this.discoveryProgressPath}.partial`
    writeFileSync(temporary, JSON.stringify({ version: 1, ...this.config, channels }), 'utf8')
    renameSync(temporary, this.discoveryProgressPath)
  }

  private reconcilePendingMedia(conversationKey: string, messages: NativeChatMessage[], confirmedUploads: ReadonlySet<string>): void {
    const conversation = reconcileConversationPendingMedia(this.pendingMedia[conversationKey] ?? {}, messages, confirmedUploads)
    if (Object.keys(conversation).length) this.pendingMedia[conversationKey] = conversation
    else delete this.pendingMedia[conversationKey]
  }

  private persistPendingMedia(): void {
    const directory = app.getPath('userData')
    mkdirSync(directory, { recursive: true })
    const temporary = `${this.pendingMediaPath}.partial`
    writeFileSync(temporary, JSON.stringify(this.pendingMedia), 'utf8')
    renameSync(temporary, this.pendingMediaPath)
  }

  private cleanupUploadedFiles(channel: Channel, uploadFiles: Map<string, string>): void {
    if (channel !== 'wechat') return
    for (const path of new Set(uploadFiles.values())) {
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch (error) {
        console.error(`[native-chat:wechat] 上传完成的临时附件清理失败：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      try {
        rmdirSync(join(path, '..'))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') {
          console.error(`[native-chat:wechat] 临时附件目录清理失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  private async get(path: string, maxRetries = MAX_RETRIES, timeoutMs = 30_000): Promise<any> {
    return this.request('GET', path, undefined, maxRetries, timeoutMs)
  }

  private async post(path: string, body: unknown, maxRetries = MAX_RETRIES, timeoutMs = 30_000): Promise<any> {
    return this.request('POST', path, body, maxRetries, timeoutMs)
  }

  private async uploadAttachment(id: number, path: string, replace = false): Promise<'already_uploaded' | 'uploaded'> {
    let lastError: Error | null = null
    let stage = 'request_upload_url'
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        stage = 'request_upload_url'
        if (statSync(path).size > MAX_ATTACHMENT_BYTES) throw new Error('附件大小超过 30 MB，无法上传')
        const response = await this.post(`/api/v1/native-chat/attachments/${id}/upload-url`, { replace }, 0)
        const target = response.data as { uploaded?: boolean; storageKey?: string; url?: string }
        if (target.uploaded) return 'already_uploaded'
        if (!target.url || !target.storageKey) throw new Error('服务端未返回附件上传地址')
        const fileSize = statSync(path).size
        const stream = createReadStream(path)
        let putResponse: Response
        try {
          stage = 'upload_file'
          putResponse = await fetch(target.url, {
            method: 'PUT',
            headers: { 'Content-Length': String(fileSize), 'Content-Type': 'application/octet-stream' },
            body: stream as unknown as BodyInit,
            duplex: 'half'
          } as RequestInit)
        } catch (error) {
          stream.destroy()
          throw error
        }
        if (!putResponse.ok) throw new Error(`附件上传失败 HTTP ${putResponse.status}`)
        stage = 'complete_upload'
        await this.post(`/api/v1/native-chat/attachments/${id}/complete`, { storageKey: target.storageKey, replace }, 0)
        return 'uploaded'
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        lastError = new Error(`附件 ${id} 阶段 ${stage} 失败：${message}`)
        if (attempt === MAX_RETRIES) break
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * (2 ** attempt))))
      }
    }
    throw lastError ?? new Error('附件上传失败')
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, maxRetries = MAX_RETRIES, timeoutMs = 30_000): Promise<any> {
    if (!this.config) throw new Error('消息采集服务尚未配置')
    let lastError: Error | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`${this.config.backendUrl}${path}`, {
          method,
          headers: { 'X-Employee-Code': this.config.employeeCode, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal
        })
        const result = await response.json()
        if (!response.ok) {
          throw new BackendResponseError(
            typeof result.error === 'string' ? result.error : `HTTP ${response.status}`,
            response.status,
            typeof result.code === 'string' ? result.code : undefined
          )
        }
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        lastError = error instanceof BackendResponseError
          ? new BackendResponseError(`${method} ${path} 请求失败：${message}`, error.status, error.code)
          : new Error(`${method} ${path} 请求失败：${message}`)
        if (error instanceof BackendResponseError && error.status >= 400 && error.status < 500 && error.status !== 429) break
        if (attempt === maxRetries) break
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * (2 ** attempt))))
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError ?? new Error('消息采集服务请求失败')
  }
}
