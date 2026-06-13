import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
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

type SidecarIncoming =
  | { type: 'ready'; protocolVersion: 1 }
  | { type: 'status'; collecting: boolean }
  | CaptureFrameEvent
  | { type: 'error'; message: string }

interface SidecarCommand {
  type: 'start' | 'stop' | 'ping'
  requestId: string
}

export class CaptureSidecarClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private store: CaptureStore | null = null
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
    sidecarPath: null
  }

  // 【临时·调试用】最近若干帧的原始事件环形缓冲（含 sidecar 吐出的 messages/orderNo/conversationKind，
  // 这些字段持久化层暂未消费——见交接文档附录 C）。仅供「采集调试」标签页可视化验证，不落库、重启即清。
  private static readonly DEBUG_RING_MAX = 60
  private debugFrames: CaptureFrameEvent[] = []

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

  getStatus(): CaptureSidecarStatus {
    return { ...this.status }
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
      windowsHide: true
    })

    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk.toString('utf8')))
    this.child.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim()
      if (message) console.error(`[capture-sidecar] ${message}`)
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
      if (!this.store) {
        this.setError('本地采集数据库未初始化')
        return
      }
      // 已放弃 VLM 区域分区方案：不再按帧调用付费 VLM，只把关键帧落库
      const result = this.store.insertFrame(message, null, null)
      this.status.collecting = true
      this.status.mode = 'collecting'
      this.status.lastError = null
      this.status.lastFrameAt = message.capturedAt
      if (result.duplicate) this.status.skippedDuplicateCount += 1
      else this.status.capturedFrameCount += 1
      this.status.lastTextPreview = message.ocr.text.replace(/\s+/g, ' ').slice(0, 120)
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
