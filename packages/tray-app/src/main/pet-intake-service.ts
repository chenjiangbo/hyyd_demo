import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { extname, join } from 'path'
import { randomUUID } from 'crypto'

type IntakeConfig = { backendUrl: string; employeeCode: string }
type Candidate = {
  orderId: number
  sourceOrderNo: string
  customerName: string
  hospital: string | null
  department: string | null
  doctor: string | null
  appointmentDate: string | null
  matchedFields: string[]
  score: number
}

type Analysis = {
  proof: { isRegistrationProof: boolean; confidence: number | null; patientName: string | null; hospital: string | null; department: string | null; appointmentDate: string | null }
  programCandidates: Candidate[]
  programMatch: Candidate | null
  aiSuggestion: { orderId: number; confidence: number; matchedFields: string[]; reason: string } | null
  aiCandidateCount: number
}

export type PetIntakeResult =
  | { state: 'done'; message: string }
  | { state: 'unknown'; message: string }
  | { state: 'candidates'; message: string; candidates: Candidate[] }

type PendingIntake = { path: string; mimeType: string; base64: string; analysis: Analysis; candidates: Candidate[] }

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif'
}

export class PetIntakeService {
  private config: IntakeConfig | null = null
  private pending: PendingIntake | null = null
  private readonly inboxDir = join(app.getPath('userData'), 'pet-inbox')

  constructor() {
    mkdirSync(this.inboxDir, { recursive: true })
  }

  setConfig(config: IntakeConfig): void {
    const backendUrl = config.backendUrl.trim().replace(/\/$/, '')
    const employeeCode = config.employeeCode.trim()
    if (!backendUrl || !employeeCode) throw new Error('浮动精灵缺少后台地址或员工登录信息')
    this.config = { backendUrl, employeeCode }
  }

  async processFile(sourcePath: string): Promise<PetIntakeResult> {
    if (!this.config) throw new Error('请先登录客户端')
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error('拖入的文件不存在')
    const ext = extname(sourcePath).toLowerCase()
    const mimeType = EXT_MIME[ext]
    if (!mimeType) return { state: 'unknown', message: '嗯…这个文件我暂时还不会处理' }

    const stagedPath = join(this.inboxDir, `${randomUUID()}${ext}`)
    copyFileSync(sourcePath, stagedPath)
    const base64 = readFileSync(stagedPath).toString('base64')
    let analysis: Analysis
    try {
      analysis = await this.post<Analysis>('/api/v1/registration-proof/analyze', { mimeType, base64 })
    } catch (error) {
      throw new Error(`挂号凭证识别失败：${(error as Error).message}`)
    }

    if (!analysis.proof.isRegistrationProof) {
      return this.finishUnknown(stagedPath, '嗯…这好像不是我现在能处理的文件呢')
    }
    const candidates = analysis.programCandidates
    const orderId = analysis.programMatch?.orderId ?? null
    if (orderId !== null) {
      await this.uploadMaterial(orderId, mimeType, base64)
      this.removeStaged(stagedPath)
      return { state: 'done', message: `收到${analysis.proof.patientName ?? ''}的挂号凭证，已经保存到对应订单啦` }
    }
    const orderedCandidates = analysis.aiSuggestion
      ? [
          ...candidates.filter(candidate => candidate.orderId === analysis.aiSuggestion?.orderId),
          ...candidates.filter(candidate => candidate.orderId !== analysis.aiSuggestion?.orderId)
        ]
      : candidates
    this.pending = { path: stagedPath, mimeType, base64, analysis, candidates: orderedCandidates }
    if (orderedCandidates.length === 0) {
      return { state: 'candidates', message: '我看出像是挂号凭证，但还没有找到对应订单', candidates: [] }
    }
    const message = analysis.aiSuggestion
      ? '我觉得第一个订单最像，请帮我选一下；选中后我会直接保存'
      : '我找到几个可能的订单，请帮我选一下'
    return { state: 'candidates', message, candidates: orderedCandidates }
  }

  async selectOrder(orderId: number): Promise<PetIntakeResult> {
    const pending = this.pending
    if (!pending) throw new Error('当前没有等待选择订单的图片')
    if (!pending.candidates.some(candidate => candidate.orderId === orderId)) {
      throw new Error('选择的订单不在本次识别结果中')
    }
    await this.uploadMaterial(orderId, pending.mimeType, pending.base64)
    this.removeStaged(pending.path)
    this.pending = null
    return { state: 'done', message: '好啦，图片已经保存到你选择的订单了' }
  }

  private async uploadMaterial(orderId: number, mimeType: string, base64: string): Promise<void> {
    await this.post(`/api/v1/orders/${orderId}/materials`, {
      type: 'image',
      clientUuid: randomUUID(),
      mimeType,
      base64
    })
  }

  private finishUnknown(path: string, message: string): PetIntakeResult {
    this.removeStaged(path)
    return { state: 'unknown', message }
  }

  private removeStaged(path: string): void {
    try { rmSync(path, { force: true }) } catch (error) { console.error('[pet] 删除暂存图片失败', error) }
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const config = this.config
    if (!config) throw new Error('客户端未登录')
    const response = await fetch(`${config.backendUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Employee-Code': config.employeeCode },
      body: JSON.stringify(body)
    })
    const payload = await response.json().catch(() => ({})) as { data?: T; error?: string }
    if (!response.ok) throw new Error(payload.error || `后台请求失败（${response.status}）`)
    return (payload.data ?? payload) as T
  }
}
