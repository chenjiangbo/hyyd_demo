/**
 * 录音转写调度器
 * 入口: scheduleTranscription(callId)
 *
 * 流程:
 *  1. 等 MinIO 对象就绪（最多 60s）
 *  2. 生成"听悟可访问的"录音 URL（presigned GET，TTL 24h）
 *  3. POST Fun-ASR 提交任务，落 dashscope_task_id
 *  4. 每 30s 轮询任务状态，最长 30min
 *  5. SUCCEEDED 时下载结果 JSON、渲染纯文本、落库
 */
import type { PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import {
  createTranscription,
  getTask,
  downloadTranscription,
  renderTranscriptText,
  type TranscriptionDoc
} from './funAsrClient.js'
import { getEnv } from '../env.js'
import { refreshOrderBrief } from '../jobs/orderBriefRunner.js'

const OBJECT_READY_TIMEOUT_MS = 60_000
const OBJECT_READY_INTERVAL_MS = 2_000
const POLL_INTERVAL_MS = 30_000
const POLL_TIMEOUT_MS = 30 * 60_000

export interface SchedulerDeps {
  prisma: PrismaClient
  /** 内部 MinIO（用于检查对象是否就绪） */
  minioClient: Minio.Client
  /** 对外可达 MinIO（生成给 Fun-ASR 的 presigned URL） */
  minioPublicClient: Minio.Client
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
}

let deps: SchedulerDeps | null = null

export function initScheduler(d: SchedulerDeps): void {
  deps = d
  // 启动恢复：扫一遍 processing 状态、有 task_id 的 call，继续轮询
  void resumePendingTasks()
}

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  if (!deps?.logger) {
    console.log(`[ASR][${level}] ${msg}`)
    return
  }
  deps.logger[level](`[ASR] ${msg}`)
}

/** 等 MinIO 对象就绪（客户端 PUT 上传完成） */
async function waitObjectReady(bucket: string, key: string): Promise<boolean> {
  if (!deps) throw new Error('Scheduler 未初始化')
  const start = Date.now()
  while (Date.now() - start < OBJECT_READY_TIMEOUT_MS) {
    try {
      await deps.minioClient.statObject(bucket, key)
      return true
    } catch {
      // 还没就绪
    }
    await sleep(OBJECT_READY_INTERVAL_MS)
  }
  return false
}

/** 入口：触发指定 callId 的转写 */
export async function scheduleTranscription(callId: number): Promise<void> {
  if (!deps) {
    console.error('[ASR] Scheduler 未初始化，跳过 callId=' + callId)
    return
  }
  const { prisma } = deps
  const recordingsBucket = getEnv().minioBucketRecordings
  try {
    const call = await prisma.call.findUnique({ where: { id: callId } })
    if (!call) {
      log('warn', `callId=${callId} 不存在，跳过`)
      return
    }
    if (!call.recordingOssKey) {
      log('warn', `callId=${callId} 还没有 recordingOssKey，跳过`)
      return
    }
    // 已经在跑 / 已经完成的不重复触发
    if (call.asrStatus === 'processing' && call.dashscopeTaskId) {
      log('info', `callId=${callId} 已在 processing，继续轮询`)
      void pollTask(callId, call.dashscopeTaskId)
      return
    }
    if (call.asrStatus === 'done') {
      log('info', `callId=${callId} 已完成，跳过`)
      return
    }

    // 1. 等对象就绪
    const ready = await waitObjectReady(recordingsBucket, call.recordingOssKey)
    if (!ready) {
      await prisma.call.update({
        where: { id: callId },
        data: { asrStatus: 'failed', asrText: 'MinIO 对象 60s 内未就绪（客户端上传可能失败）' }
      })
      log('error', `callId=${callId} MinIO 对象未就绪`)
      return
    }

    // 2. 生成 24h presigned URL
    const fileUrl = await deps.minioPublicClient.presignedGetObject(
      recordingsBucket,
      call.recordingOssKey,
      24 * 60 * 60
    )

    // 3. 提交任务
    log('info', `callId=${callId} 提交 Fun-ASR 任务，URL=${fileUrl.slice(0, 80)}...`)
    let taskId: string
    try {
      const result = await createTranscription({
        fileUrls: [fileUrl],
        diarizationEnabled: true,
        speakerCount: 2,
        taskKey: `call-${callId}`
      })
      taskId = result.taskId
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await prisma.call.update({
        where: { id: callId },
        data: { asrStatus: 'failed', asrText: '提交转写失败: ' + msg }
      })
      log('error', `callId=${callId} 提交转写失败: ${msg}`)
      return
    }

    await prisma.call.update({
      where: { id: callId },
      data: { asrStatus: 'processing', dashscopeTaskId: taskId }
    })
    log('info', `callId=${callId} 任务已提交 taskId=${taskId}`)

    // 4. 启动轮询（不 await，独立任务）
    void pollTask(callId, taskId)
  } catch (e) {
    log('error', `callId=${callId} 调度异常: ${(e as Error).message}`)
  }
}

/** 轮询任务直到完成 / 失败 / 超时 */
async function pollTask(callId: number, taskId: string): Promise<void> {
  if (!deps) return
  const { prisma } = deps
  const start = Date.now()

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS)
    let info
    try {
      info = await getTask(taskId)
    } catch (e) {
      log('warn', `callId=${callId} 轮询失败（继续重试）: ${(e as Error).message}`)
      continue
    }

    if (info.taskStatus === 'SUCCEEDED') {
      const transcriptionUrl = info.results?.[0]?.transcription_url
      if (!transcriptionUrl) {
        await prisma.call.update({
          where: { id: callId },
          data: {
            asrStatus: 'failed',
            asrText: 'Fun-ASR 返回 SUCCEEDED 但没有 transcription_url',
            asrResultJson: info.raw as any
          }
        })
        log('error', `callId=${callId} 缺 transcription_url`)
        return
      }
      let doc: TranscriptionDoc
      try {
        doc = await downloadTranscription(transcriptionUrl)
      } catch (e) {
        await prisma.call.update({
          where: { id: callId },
          data: { asrStatus: 'failed', asrText: '下载转写结果失败: ' + (e as Error).message }
        })
        log('error', `callId=${callId} 下载转写失败: ${(e as Error).message}`)
        return
      }
      // 只按 speaker_id 区分说话人（说话人 0 / 1 / …），不臆测身份（谁是员工、谁是客户）
      const text = renderTranscriptText(doc)
      const updated = await prisma.call.update({
        where: { id: callId },
        data: {
          asrStatus: 'done',
          asrText: text,
          asrResultJson: doc as any,
          asrFinishedAt: new Date()
        }
      })
      log('info', `callId=${callId} ✅ 转写完成，文本 ${text.length} 字`)
      // 转写完成是高价值新内容 → 立刻让 LLM 重跑一次该订单的全量总结（force）。
      if (updated.orderId) {
        try {
          await refreshOrderBrief(prisma, deps.minioClient, updated.orderId, { force: true })
          log('info', `callId=${callId} 转写完成已触发订单 ${updated.orderId} 简报重算`)
        } catch (e) {
          log('warn', `callId=${callId} 转写后触发简报失败: ${(e as Error).message}`)
        }
      }
      return
    }

    if (info.taskStatus === 'FAILED') {
      const errMsg =
        info.results?.[0]?.message ||
        info.raw?.output?.message ||
        '未知失败原因'
      await prisma.call.update({
        where: { id: callId },
        data: { asrStatus: 'failed', asrText: 'Fun-ASR 任务失败: ' + errMsg, asrResultJson: info.raw as any }
      })
      log('error', `callId=${callId} Fun-ASR FAILED: ${errMsg}`)
      return
    }

    // PENDING / RUNNING → 继续
    log('info', `callId=${callId} 状态: ${info.taskStatus}`)
  }

  // 超时
  await prisma.call.update({
    where: { id: callId },
    data: { asrStatus: 'requires_manual', asrText: `轮询 ${POLL_TIMEOUT_MS / 60000} 分钟未完成，需人工跟进 taskId=${taskId}` }
  })
  log('warn', `callId=${callId} 轮询超时 taskId=${taskId}`)
}

/** 启动时恢复 processing 状态的任务 */
async function resumePendingTasks(): Promise<void> {
  if (!deps) return
  const calls = await deps.prisma.call.findMany({
    where: { asrStatus: 'processing', dashscopeTaskId: { not: null } }
  })
  if (calls.length === 0) return
  log('info', `恢复 ${calls.length} 个未完成的转写任务`)
  for (const c of calls) {
    void pollTask(c.id, c.dashscopeTaskId!)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
