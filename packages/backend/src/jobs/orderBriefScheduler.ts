/**
 * 订单简报自动触发扫描器。
 *
 * 每 TICK 扫一遍：找"自上次跑简报以来有新内容"且满足触发条件的订单 → 调 refreshOrderBrief（全量重算）。
 * 触发条件（任一）：
 *   - 静默：最后一条消息/通话距今 ≥ SILENCE_MIN 分钟（这阵聊完了）。跑完后记号推进到最新，
 *     没有新内容进来就不会再触发，天然不重复。
 *   - 阈值：自上次跑以来新增 ≥ THRESHOLD_COUNT 条**有内容的微信/企微消息**（聊得多，攒够就跑一次）。
 * 注：通话录音转写完成会**立即**触发一次（在 asr/transcribeScheduler 里直接调 refreshOrderBrief），不靠本扫描器。
 * 便宜预过滤（纯时间戳/系统提示/空转写不算数）+ "无营养则只推进记号"在 refreshOrderBrief 内部。
 * 设计见 docs/设计_订单AI滚动简报.md。
 */
import type { PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { refreshOrderBrief } from './orderBriefRunner.js'

const TICK_MS = 60_000 // 每分钟扫一遍
const SILENCE_MIN = 5 // 静默 N 分钟
const THRESHOLD_COUNT = 10 // 新增 K 条
const MAX_PER_TICK = 5 // 每轮最多抽几单，平滑 LLM 负载

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

export function startOrderBriefScheduler(prisma: PrismaClient, minio: Minio.Client): void {
  if (timer) return
  timer = setInterval(() => void tick(prisma, minio), TICK_MS)
  // 启动后延迟一会儿先扫一次（不阻塞启动）
  setTimeout(() => void tick(prisma, minio), 10_000)
}

export function stopOrderBriefScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function tick(prisma: PrismaClient, minio: Minio.Client): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const now = Date.now()
    const silenceCutoff = new Date(now - SILENCE_MIN * 60_000)

    // 每个订单的最新消息/通话(id + 时间)
    const msgAgg = await prisma.message.groupBy({
      by: ['orderId'],
      where: { orderId: { not: null } },
      _max: { id: true, capturedAt: true }
    })
    const callAgg = await prisma.call.groupBy({
      by: ['orderId'],
      where: { orderId: { not: null } },
      _max: { id: true, startedAt: true }
    })
    const matAgg = await prisma.material.groupBy({
      by: ['orderId'],
      _max: { id: true, createdAt: true }
    })

    // 汇总到订单维度
    type Agg = {
      maxMsgId: number
      maxMsgAt: Date | null
      maxCallId: number
      maxCallAt: Date | null
      maxMatId: number
      maxMatAt: Date | null
    }
    const byOrder = new Map<number, Agg>()
    const get = (id: number): Agg => {
      let a = byOrder.get(id)
      if (!a) {
        a = { maxMsgId: 0, maxMsgAt: null, maxCallId: 0, maxCallAt: null, maxMatId: 0, maxMatAt: null }
        byOrder.set(id, a)
      }
      return a
    }
    for (const m of msgAgg) {
      if (m.orderId == null) continue
      const a = get(m.orderId)
      a.maxMsgId = m._max.id ?? 0
      a.maxMsgAt = m._max.capturedAt ?? null
    }
    for (const c of callAgg) {
      if (c.orderId == null) continue
      const a = get(c.orderId)
      a.maxCallId = c._max.id ?? 0
      a.maxCallAt = c._max.startedAt ?? null
    }
    for (const m of matAgg) {
      const a = get(m.orderId)
      a.maxMatId = m._max.id ?? 0
      a.maxMatAt = m._max.createdAt ?? null
    }
    if (byOrder.size === 0) return

    // 取这些订单的水位
    const ids = [...byOrder.keys()]
    const orders = await prisma.order.findMany({
      where: { id: { in: ids } },
      select: { id: true, briefLastMsgId: true, briefLastCallId: true, briefLastMaterialId: true }
    })

    const candidates: number[] = []
    for (const o of orders) {
      const a = byOrder.get(o.id)!
      const wmMsg = o.briefLastMsgId ?? 0
      const wmCall = o.briefLastCallId ?? 0
      const wmMat = o.briefLastMaterialId ?? 0
      const hasNew = a.maxMsgId > wmMsg || a.maxCallId > wmCall || a.maxMatId > wmMat
      if (!hasNew) continue

      const lastAt = Math.max(
        a.maxMsgAt?.getTime() ?? 0,
        a.maxCallAt?.getTime() ?? 0,
        a.maxMatAt?.getTime() ?? 0
      )
      const silent = lastAt > 0 && lastAt <= silenceCutoff.getTime()
      if (silent) {
        // 静默够久 → 跑一次。跑完记号推进到最新，没新内容就不会再被选中（不重复）。
        candidates.push(o.id)
        continue
      }
      // 未静默 → 看是否攒够 K 条**有内容的微信/企微消息**（系统/空消息不计入）
      const newMsgCount = await prisma.message.count({
        where: {
          orderId: o.id,
          id: { gt: wmMsg },
          channel: { in: ['wechat', 'wxwork'] },
          contentText: { not: '' }
        }
      })
      if (newMsgCount >= THRESHOLD_COUNT) candidates.push(o.id)
    }

    let done = 0
    for (const id of candidates) {
      if (done >= MAX_PER_TICK) break
      try {
        const r = await refreshOrderBrief(prisma, minio, id)
        if (r && !r.skipped) done++
      } catch (e) {
        console.warn(`[brief-scheduler] 订单 ${id} 简报刷新失败:`, (e as Error).message)
      }
    }
    if (done > 0) console.log(`[brief-scheduler] 本轮刷新 ${done} 单简报（候选 ${candidates.length}）`)
  } catch (e) {
    console.warn('[brief-scheduler] tick 异常:', (e as Error).message)
  } finally {
    ticking = false
  }
}
