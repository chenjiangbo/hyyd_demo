import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { extname, join } from 'path'
import { randomUUID } from 'crypto'
import type { NativeChatImageMatchApplication, PetDropImageMatch } from '@huanyu/shared-types'

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

export type PetIntakeResult =
  | { state: 'done' | 'unknown'; message: string }
  | { state: 'candidates'; message: string; candidates?: Candidate[]; imageMatch?: PetDropImageMatch }

type PendingIntake = { path: string; mimeType: string; base64: string; imageMatch: PetDropImageMatch }

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
    if (this.pending) {
      return { state: 'candidates', message: '请先处理浮动精灵当前这张待确认的图片', imageMatch: this.pending.imageMatch }
    }
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error('拖入的文件不存在')
    const ext = extname(sourcePath).toLowerCase()
    const mimeType = EXT_MIME[ext]
    if (!mimeType) return { state: 'unknown', message: '嗯…这个文件我暂时还不会处理呢' }

    const stagedPath = join(this.inboxDir, `${randomUUID()}${ext}`)
    copyFileSync(sourcePath, stagedPath)
    const base64 = readFileSync(stagedPath).toString('base64')
    let response: {
      image: {
        imageType: string
        typeDescription: string
        description: string
        visibleText: string
        visibleFields: Array<{ label: string; value: string }>
      }
      registrationMatch: {
        applicationNo: string | null
        applicationDecision: string
        orderId: number | null
        orderDecision: string
        reason: string
        candidateApplications: NativeChatImageMatchApplication[]
      } | null
    }
    try {
      response = await this.post<typeof response>('/api/v1/registration-proof/intake/analyze', { mimeType, base64 })
    } catch (error) {
      this.removeStaged(stagedPath)
      throw new Error(`图片识别失败：${(error as Error).message}`)
    }

    const image = response.image
    if (image.imageType !== '挂号凭证') {
      this.removeStaged(stagedPath)
      const description = [image.typeDescription, image.description, image.visibleText].filter(Boolean).join('；')
      return {
        state: 'done',
        message: `我识别为${image.imageType || '无法判断'}。${description || '暂时没有更多可读内容。'}`
      }
    }
    if (!response.registrationMatch) {
      this.removeStaged(stagedPath)
      throw new Error('图片识别为挂号凭证，但后台没有返回申领号和订单匹配结果')
    }

    const match = response.registrationMatch
    const imageMatch: PetDropImageMatch = {
      source: 'drop',
      imageUrl: `data:${mimeType};base64,${base64}`,
      occurredAt: new Date().toISOString(),
      channel: '浮动精灵',
      senderName: null,
      applicationNo: null,
      recommendedApplicationNo: match.applicationNo,
      recommendedOrderId: match.orderId,
      imageType: image.imageType,
      typeDescription: image.typeDescription,
      description: image.description,
      visibleText: image.visibleText,
      candidateApplications: match.candidateApplications,
      applicationDecision: match.applicationDecision,
      orderDecision: match.orderDecision,
      reason: match.reason
    }
    this.pending = { path: stagedPath, mimeType, base64, imageMatch }
    return {
      state: 'candidates',
      message: match.candidateApplications.length > 0
        ? '我已识别这张挂号凭证，并给出申领号和订单建议，请核对后选择。'
        : '我已识别这张挂号凭证，但暂时没有找到申领号候选；图片尚未上传到任何订单。',
      candidates: [],
      imageMatch
    }
  }

  async selectOrder(orderId: number, applicationNo?: string): Promise<PetIntakeResult> {
    const pending = this.pending
    if (!pending) throw new Error('当前没有等待选择订单的图片')
    const possibleApplications = pending.imageMatch.candidateApplications.filter((candidate) => candidate.orders.some((order) => order.orderId === orderId))
    const confirmedApplicationNo = applicationNo ?? (possibleApplications.length === 1 ? possibleApplications[0].applicationNo : null)
    if (!confirmedApplicationNo) throw new Error('请先确认这张图片所属的申领号')
    const application = pending.imageMatch.candidateApplications.find((candidate) => candidate.applicationNo === confirmedApplicationNo)
    if (!application || !application.orders.some((candidate) => candidate.orderId === orderId)) {
      throw new Error('选择的订单不属于本次确认的申领号')
    }
    await this.uploadMaterial(orderId, pending.mimeType, pending.base64)
    this.removeStaged(pending.path)
    this.pending = null
    return { state: 'done', message: '好啦，图片已经保存到你确认的订单了' }
  }

  discardPending(): void {
    if (!this.pending) return
    this.removeStaged(this.pending.path)
    this.pending = null
  }

  private async uploadMaterial(orderId: number, mimeType: string, base64: string): Promise<void> {
    await this.post(`/api/v1/orders/${orderId}/materials`, {
      type: 'image',
      clientUuid: randomUUID(),
      mimeType,
      base64
    })
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
