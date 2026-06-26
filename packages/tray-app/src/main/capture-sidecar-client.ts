import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import {
  CaptureAiReconstructor,
  DEFAULT_RECONSTRUCT_MODELS,
  type AiReconstructResult,
  type ReconstructInput
} from './capture-ai-reconstruct'
import { CaptureStore } from './capture-store'
import type { CaptureFrameEvent, CaptureSidecarStatus } from './capture-types'

export interface CaptureShot {
  path: string
  fileName: string
  channel: string
  capturedAt: string | null
}

export interface DiagLogEntry {
  ts: string
  /** sidecar=C# stderr  insert=本地入库  structure=sidecar结构化结果  upload=上报后端  error=异常  info=TS侧系统消息 */
  tag: 'sidecar' | 'insert' | 'structure' | 'upload' | 'error' | 'info'
  msg: string
}

type SidecarIncoming =
  | { type: 'ready'; protocolVersion: 1 }
  | { type: 'status'; collecting: boolean }
  | CaptureFrameEvent
  | { type: 'error'; message: string }

interface SidecarCommand {
  type: 'start' | 'stop' | 'ping'
  requestId: string
}

interface CaptureBackendConfig {
  backendUrl: string
  employeeCode: string
}

export class CaptureSidecarClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private store: CaptureStore | null = null
  private backendConfig: CaptureBackendConfig | null = null
  private buffer = ''
  private status: CaptureSidecarStatus = {
    enabled: process.platform === 'win32',
    running: false,
    collecting: false,
    mode: process.platform === 'win32' ? 'starting' : 'disabled',
    targetApps: ['WXWork.exe', 'WeChat.exe', 'Weixin.exe'],
    lastError: process.platform === 'win32' ? null : '窗口采集只在 Windows 客户端启用',
    lastFrameAt: null,
    capturedFrameCount: 0,
    skippedDuplicateCount: 0,
    lastTextPreview: null,
    sidecarPath: null,
    saveDebug: false
  }

  // 现场验证开关：是否让 sidecar 保存调试数据（截图 + .debug.json）。
  // 持久化到 userData，重启 app 后仍生效；切换时重启 sidecar 让新 env 生效。
  private saveDebug = false

  // 【临时·调试用】最近若干帧的原始事件环形缓冲（含 sidecar 吐出的 messages/orderNo/conversationKind，
  // 这些字段持久化层暂未消费——见交接文档附录 C）。仅供「采集调试」标签页可视化验证，不落库、重启即清。
  private static readonly DEBUG_RING_MAX = 60
  private debugFrames: CaptureFrameEvent[] = []

  // 【调试】过程日志环形缓冲：sidecar stderr + TS 侧 insert/structure/upload 结果，最新在前。
  private static readonly DIAG_LOG_MAX = 500
  private diagLog: DiagLogEntry[] = []

  private addLog(tag: DiagLogEntry['tag'], msg: string): void {
    this.diagLog.unshift({ ts: new Date().toISOString(), tag, msg })
    if (this.diagLog.length > CaptureSidecarClient.DIAG_LOG_MAX) {
      this.diagLog.length = CaptureSidecarClient.DIAG_LOG_MAX
    }
  }

  listDiagLog(limit = CaptureSidecarClient.DIAG_LOG_MAX): DiagLogEntry[] {
    return this.diagLog.slice(0, limit)
  }

  clearDiagLog(): { cleared: number } {
    const cleared = this.diagLog.length
    this.diagLog = []
    return { cleared }
  }

  /** 【调试】最近的原始采集帧（最新在前）。供 capture:debug-frames IPC。 */
  listDebugFrames(limit = CaptureSidecarClient.DEBUG_RING_MAX): CaptureFrameEvent[] {
    return this.debugFrames.slice(0, limit)
  }

  /** 【调试】清空调试环形缓冲（只清内存视图，不动磁盘/数据库）。 */
  clearDebugFrames(): { cleared: number } {
    const cleared = this.debugFrames.length
    this.debugFrames = []
    return { cleared }
  }

  constructor() {
    // 启动时读回"保存采集调试数据"开关，重启 app 后仍生效
    try {
      const raw = readFileSync(this.prefsPath(), 'utf8')
      this.saveDebug = JSON.parse(raw)?.saveDebug === true
    } catch {
      this.saveDebug = false
    }
    this.status.saveDebug = this.saveDebug
  }

  private prefsPath(): string {
    return join(app.getPath('userData'), 'capture-prefs.json')
  }

  private persistPrefs(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(this.prefsPath(), JSON.stringify({ saveDebug: this.saveDebug }), 'utf8')
    } catch (e) {
      console.error('[capture] 保存调试开关偏好失败', e)
    }
  }

  /**
   * 现场验证开关：是否让 sidecar 保存调试数据（截图 + .debug.json）。
   * 切换后立刻重启 sidecar，让新的 HYYD_SAVE_DEBUG env 生效。
   */
  async setSaveDebug(value: boolean): Promise<{ saveDebug: boolean }> {
    if (this.saveDebug === value) return { saveDebug: this.saveDebug }
    this.saveDebug = value
    this.status.saveDebug = value
    this.persistPrefs()
    // 重启 sidecar 应用新 env（仅在本就该跑时）
    if (this.status.enabled) {
      this.stop()
      await this.start()
    }
    return { saveDebug: this.saveDebug }
  }

  getStatus(): CaptureSidecarStatus {
    return { ...this.status }
  }

  setConfig(cfg: CaptureBackendConfig): void {
    const backendUrl = cfg.backendUrl.trim().replace(/\/+$/, '')
    const employeeCode = cfg.employeeCode.trim()
    if (!backendUrl) throw new Error('capture backendUrl 不能为空')
    if (!employeeCode) throw new Error('capture employeeCode 不能为空')
    this.backendConfig = { backendUrl, employeeCode }
    if (this.status.mode === 'error' && this.status.lastError?.includes('未配置后端结构化')) {
      this.status.mode = this.status.collecting ? 'collecting' : 'ready'
      this.status.lastError = null
    }
  }

  // 读 store：采集在跑时复用采集连接，否则惰性开一个独立连接（只做 SELECT）。
  // 这样即使当前没在采集（切到别的应用），界面仍能读到历史会话。
  private readStore: CaptureStore | null = null
  private getReadStore(): CaptureStore {
    if (this.store) return this.store
    if (!this.readStore) this.readStore = new CaptureStore()
    return this.readStore
  }

  /** 给界面读：会话列表（按渠道过滤） */
  listConversations(channel?: string): ReturnType<CaptureStore['listThreads']> {
    try {
      return this.getReadStore().listThreads(channel)
    } catch (e) {
      console.error('[capture] listConversations 失败:', (e as Error).message)
      return []
    }
  }

  /** 给界面读：某会话的消息块 */
  listMessages(threadId: number): ReturnType<CaptureStore['listMessageBlocks']> {
    try {
      return this.getReadStore().listMessageBlocks(threadId)
    } catch (e) {
      console.error('[capture] listMessages 失败:', (e as Error).message)
      return []
    }
  }

  /** 调试：最近采集帧 */
  listFrames(channel: string | undefined, limit = 30): ReturnType<CaptureStore['listRecentFrames']> {
    try {
      return this.getReadStore().listRecentFrames(channel, limit)
    } catch (e) {
      console.error('[capture] listFrames 失败:', (e as Error).message)
      return []
    }
  }

  /** 调试：某 layout 版本 */
  getLayout(id: number): ReturnType<CaptureStore['getLayoutVersion']> {
    try {
      return this.getReadStore().getLayoutVersion(id)
    } catch (e) {
      console.error('[capture] getLayout 失败:', (e as Error).message)
      return null
    }
  }

  /** 调试：把截图读成 data URL 给渲染进程显示 */
  readScreenshotDataUrl(path: string): string | null {
    try {
      const buf = readFileSync(path)
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch (e) {
      console.error('[capture] 读取截图失败:', (e as Error).message)
      return null
    }
  }

  /**
   * 验证用：直接从磁盘列出 sidecar 存下的原始 PNG（不走数据库、不依赖 OCR 是否成功）。
   * 目录：%LOCALAPPDATA%\HyydCaptureSidecar\frames\yyyy-MM-dd\*.png
   * 文件名：{yyyyMMdd-HHmmss-fff}-{channel}-{hash}.png
   */
  listShots(channel: string | undefined, limit = 30): CaptureShot[] {
    try {
      const root = this.framesRoot()
      if (!existsSync(root)) return []
      const shots: Array<{ shot: CaptureShot; mtime: number }> = []
      for (const dateDir of readdirSync(root)) {
        const dirPath = join(root, dateDir)
        let stat: ReturnType<typeof statSync>
        try {
          stat = statSync(dirPath)
        } catch {
          continue
        }
        if (!stat.isDirectory()) continue
        for (const file of readdirSync(dirPath)) {
          if (!file.toLowerCase().endsWith('.png')) continue
          const parts = file.replace(/\.png$/i, '').split('-')
          // [yyyyMMdd, HHmmss, fff, channel, hash]
          const ch = parts.length >= 4 ? parts[3] : 'unknown'
          if (channel && ch !== channel) continue
          const fullPath = join(dirPath, file)
          let mtime = 0
          try {
            mtime = statSync(fullPath).mtimeMs
          } catch {
            continue
          }
          shots.push({
            shot: {
              path: fullPath,
              fileName: file,
              channel: ch,
              // 用文件写入时间（本地时区）显示，避免文件名里 UTC 时间戳造成 8 小时偏差
              capturedAt: formatLocal(mtime)
            },
            mtime
          })
        }
      }
      return shots
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
        .map((s) => s.shot)
    } catch (e) {
      console.error('[capture] listShots 失败:', (e as Error).message)
      return []
    }
  }

  /** 验证用：清空磁盘上所有采集截图（删除 frames 目录下全部 PNG 及空日期目录） */
  clearShots(): { deleted: number } {
    let deleted = 0
    try {
      const root = this.framesRoot()
      if (!existsSync(root)) return { deleted }
      for (const dateDir of readdirSync(root)) {
        const dirPath = join(root, dateDir)
        let stat: ReturnType<typeof statSync>
        try {
          stat = statSync(dirPath)
        } catch {
          continue
        }
        if (!stat.isDirectory()) continue
        for (const file of readdirSync(dirPath)) {
          if (!file.toLowerCase().endsWith('.png')) continue
          try {
            rmSync(join(dirPath, file))
            deleted += 1
          } catch {
            // 文件可能正被 sidecar 占用，跳过
          }
        }
        // 目录空了就删掉
        try {
          if (readdirSync(dirPath).length === 0) rmSync(dirPath, { recursive: true })
        } catch {
          // ignore
        }
      }
    } catch (e) {
      console.error('[capture] clearShots 失败:', (e as Error).message)
    }
    return { deleted }
  }

  /** 验证用：把选中的若干关键帧（按时序）发给多个 AI 模型还原聊天消息 */
  async reconstructAi(
    inputs: ReconstructInput[],
    models?: string[],
    channel?: string
  ): Promise<AiReconstructResult[]> {
    const reconstructor = new CaptureAiReconstructor()
    const list = models && models.length > 0 ? models : DEFAULT_RECONSTRUCT_MODELS
    return reconstructor.reconstruct(inputs, list, channel ?? 'wxwork')
  }

  /**
   * 调试用：对一张磁盘上的 PNG 跑一次完整结构化（一次性拉起 sidecar `--frame-image`），
   * 把结果当成一帧塞进调试环形缓冲，让调试页能像看实时帧一样查看上传图片的分区/气泡/消息。
   * 不入库、不上报。返回该帧（失败返回 null）。
   */
  async runOnImage(imagePath: string, channel = 'wxwork'): Promise<CaptureFrameEvent | null> {
    if (!existsSync(imagePath)) throw new Error(`图片不存在: ${imagePath}`)
    const sidecarPath = this.resolveSidecarPath()
    return await new Promise<CaptureFrameEvent | null>((resolve) => {
      const child = spawn(sidecarPath, ['--frame-image', imagePath, '--channel', channel], {
        windowsHide: true
      })
      let buf = ''
      let frame: CaptureFrameEvent | null = null
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line) {
            try {
              const msg = JSON.parse(line) as { type?: string }
              if (msg.type === 'frame') frame = msg as unknown as CaptureFrameEvent
            } catch {
              /* 非 JSON 行忽略 */
            }
          }
          nl = buf.indexOf('\n')
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const t = chunk.toString('utf8').trim()
        if (t) this.addLog('sidecar', t.replace(/^\d{2}:\d{2}:\d{2}\.\d{3} /, ''))
      })
      child.on('error', (e) => {
        this.addLog('error', `上传图片测试失败: ${e.message}`)
        resolve(null)
      })
      child.on('close', () => {
        if (frame) {
          this.debugFrames.unshift(frame)
          if (this.debugFrames.length > CaptureSidecarClient.DEBUG_RING_MAX) {
            this.debugFrames.length = CaptureSidecarClient.DEBUG_RING_MAX
          }
          this.addLog('structure', `上传图片测试 → "${frame.title ?? ''}" ${frame.messages?.length ?? 0}条消息`)
        }
        resolve(frame)
      })
    })
  }

  private framesRoot(): string {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'HyydCaptureSidecar', 'frames')
  }

  async start(): Promise<void> {
    if (!this.status.enabled) return
    if (this.child) return

    let sidecarPath: string
    try {
      sidecarPath = this.resolveSidecarPath()
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error))
      throw error
    }
    this.status.sidecarPath = sidecarPath
    this.status.mode = 'starting'
    this.store = new CaptureStore()

    this.child = spawn(sidecarPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // 现场验证开关：开=sidecar 保存截图+.debug.json 供调试页查看；关=OCR 用完即删图、不写调试文件
      env: { ...process.env, HYYD_SAVE_DEBUG: this.saveDebug ? '1' : '0' }
    })

    this.addLog('info' as DiagLogEntry['tag'], `sidecar 进程已启动: ${sidecarPath}`)
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk.toString('utf8')))
    this.child.stderr.on('data', (chunk: Buffer) => {
      // C# stderr 已强制设为 UTF-8，直接解码
      const raw = chunk.toString('utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) {
          console.error(`[capture-sidecar] ${trimmed}`)
          // Diag.Line 写入格式为 "HH:mm:ss.fff <message>"，去掉时间戳前缀后存入 diagLog
          // 这样 SidecarDebugPage 的 parseSessions 正则才能从行首匹配关键词
          const msg = trimmed.replace(/^\d{2}:\d{2}:\d{2}\.\d{3} /, '')
          this.addLog('sidecar', msg)
        }
      }
    })
    this.child.on('error', (error) => {
      this.setError(`采集 sidecar 启动失败: ${error.message}`)
    })
    this.child.on('exit', (code, signal) => {
      this.child = null
      this.status.running = false
      this.status.collecting = false
      this.setError(`采集 sidecar 已退出: code=${code} signal=${signal}`)
    })

    this.status.running = true
    this.status.mode = 'ready'
    this.send({ type: 'start', requestId: createRequestId() })
  }

  stop(): void {
    if (this.child) {
      this.send({ type: 'stop', requestId: createRequestId() })
      this.child.kill()
      this.child = null
    }
    this.store?.close()
    this.store = null
    this.status.running = false
    this.status.collecting = false
    if (this.status.enabled) this.status.mode = 'ready'
  }

  private resolveSidecarPath(): string {
    const configuredPath = process.env.HYYD_CAPTURE_SIDECAR_PATH
    if (configuredPath) {
      if (!existsSync(configuredPath)) {
        throw new Error(`HYYD_CAPTURE_SIDECAR_PATH 指向的文件不存在: ${configuredPath}`)
      }
      return configuredPath
    }

    const candidatePaths = app.isPackaged
      ? [join(process.resourcesPath, 'capture-sidecar', 'hyyd-capture-sidecar.exe')]
      : [
          join(process.cwd(), 'resources', 'capture-sidecar', 'hyyd-capture-sidecar.exe'),
          join(app.getAppPath(), 'resources', 'capture-sidecar', 'hyyd-capture-sidecar.exe')
        ]

    const sidecarPath = candidatePaths.find((candidate) => existsSync(candidate))
    if (!sidecarPath) {
      throw new Error(`缺少采集 sidecar: ${candidatePaths.join(' 或 ')}`)
    }
    return sidecarPath
  }

  private send(command: SidecarCommand): void {
    if (!this.child) throw new Error('采集 sidecar 未启动')
    this.child.stdin.write(`${JSON.stringify(command)}\n`)
  }

  private handleStdout(text: string): void {
    this.buffer += text
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line) {
        this.handleMessage(line).catch((error) => {
          this.setError(error instanceof Error ? error.message : String(error))
        })
      }
      newlineIndex = this.buffer.indexOf('\n')
    }
  }

  private async handleMessage(line: string): Promise<void> {
    let message: SidecarIncoming
    try {
      message = JSON.parse(line) as SidecarIncoming
    } catch (error) {
      this.setError(`采集 sidecar 返回非法 JSON: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (message.type === 'ready') {
      this.status.mode = 'ready'
      this.status.lastError = null
      return
    }

    if (message.type === 'status') {
      this.status.collecting = message.collecting
      this.status.mode = message.collecting ? 'collecting' : 'ready'
      return
    }

    if (message.type === 'error') {
      this.setError(message.message)
      return
    }

    if (message.type === 'frame') {
      // 【调试】先入环形缓冲（无论入库成功与否，反映 sidecar 真实输出）
      this.debugFrames.unshift(message)
      if (this.debugFrames.length > CaptureSidecarClient.DEBUG_RING_MAX) {
        this.debugFrames.length = CaptureSidecarClient.DEBUG_RING_MAX
      }
      // 非客户会话过滤掉的帧：sidecar 仍吐出来供调试页看截图/OCR，但不入库、不上报、不结构化。
      if (message.filtered) {
        this.status.lastFrameAt = message.capturedAt
        this.status.lastTextPreview = message.ocr.text.replace(/\s+/g, ' ').slice(0, 120)
        return
      }
      if (!this.store) {
        this.setError('本地采集数据库未初始化')
        return
      }
      // 结构化已在 sidecar 本地完成（分区+拼行+判说话人），直接用成品 messages，后端不再 structure。
      const structuredMessages = message.messages ?? null
      const convName = message.title ?? message.windowTitle ?? message.processName
      this.addLog('structure', `${message.channel} "${convName}" → ${structuredMessages?.length ?? 0}条消息`)
      const result = this.store.insertFrame(message, null, structuredMessages)
      this.status.collecting = true
      this.status.mode = 'collecting'
      this.status.lastError = null
      this.status.lastFrameAt = message.capturedAt
      if (result.duplicate) {
        this.status.skippedDuplicateCount += 1
        this.addLog('insert', `去重·已存在 ${message.channel} "${convName}"`)
      } else {
        this.status.capturedFrameCount += 1
        this.addLog('insert', `新帧 ${message.channel} "${convName}" → ${result.newMessages.length} 条新消息 申请号候选=${result.orderNo ?? '无'}`)
      }
      this.status.lastTextPreview = message.ocr.text.replace(/\s+/g, ' ').slice(0, 120)

      // 整帧没变（chat_text_hash 命中）就不重复上报；变了就把整帧消息(含 system)发后端，
      // 由后端做跨帧单消息去重 + 时间链还原 + 订单关联。
      if (!result.duplicate) {
        void this.uploadFrame(message)
      }
    }
  }

  /**
   * 整帧上报后端（新链路）：把这一帧的全部结构化消息（含 system/时间锚点）原样发给
   * `/api/v1/capture/frame`，由后端做跨帧单消息去重 + 时间链还原 + 订单关联。
   * tray 这边不再做单消息去重，只靠整帧去重（chat_text_hash，见 capture-store）挡掉"同屏没变"的帧、省流量。
   * 失败不影响采集，仅记日志。
   */
  private async uploadFrame(frame: CaptureFrameEvent): Promise<void> {
    if (!this.backendConfig) return
    const { backendUrl, employeeCode } = this.backendConfig
    const messages = (frame.messages ?? []).map((m) => ({
      speaker: m.speaker,
      name: m.name ?? null,
      text: m.text,
      kind: m.kind ?? null
    }))
    if (messages.length === 0) return
    const conversationName = frame.title ?? frame.windowTitle ?? frame.processName
    const body = {
      channel: frame.channel,
      conversationName,
      orderNoCandidate: frame.orderNo ?? undefined,
      capturedAt: frame.capturedAt,
      messages
    }
    try {
      const res = await fetch(`${backendUrl}/api/v1/capture/frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Employee-Code': employeeCode },
        body: JSON.stringify(body)
      })
      const json = (await res.json().catch(() => null)) as {
        data?: { orderId?: number | null; applicationNo?: string | null; created?: number; merged?: number }
        error?: string
      } | null
      const conv = conversationName.replace(/\s+/g, ' ').slice(0, 20)
      if (res.ok && json?.data) {
        const d = json.data
        const linked = d.applicationNo
          ? `关联申请号 ${d.applicationNo}`
          : d.orderId
            ? `已关联内部订单ID ${d.orderId}`
            : '未关联'
        this.addLog(
          'upload',
          `✓ 整帧 "${conv}" 新增消息 ${d.created ?? 0} 条，已存在消息 ${d.merged ?? 0} 条；识别候选=${frame.orderNo ?? '无'} → ${linked}`
        )
      } else {
        const errMsg = `✗ 整帧 "${conv}" → HTTP ${res.status}: ${(json?.error ?? res.statusText).slice(0, 120)}`
        console.error(`[capture] 整帧上报失败: ${errMsg}`)
        this.addLog('upload', errMsg)
      }
    } catch (e) {
      const errMsg = `✗ 整帧上报网络异常: ${(e as Error).message}`
      console.error('[capture] 整帧上报异常:', errMsg)
      this.addLog('upload', errMsg)
    }
  }

  private setError(message: string): void {
    this.status.lastError = message
    this.status.mode = 'error'
    console.error(`[capture-sidecar] ${message}`)
  }
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// 把毫秒时间戳格式化为本地时间 'YYYY-MM-DD HH:mm:ss'
function formatLocal(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}
