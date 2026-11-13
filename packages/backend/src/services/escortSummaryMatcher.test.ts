import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import type * as Minio from 'minio'
import { processEscortSummaryJob, selectEscortCandidate } from './escortSummaryMatcher.js'

async function run() {
  assert.equal(selectEscortCandidate([{ orderId: 1, confidence: 70 }, { orderId: 2, confidence: 69 }], [1, 2]), 1)
  assert.equal(selectEscortCandidate([{ orderId: 1, confidence: 69 }, { orderId: 2, confidence: 68 }], [1, 2]), null)
  assert.equal(selectEscortCandidate([{ orderId: 1, confidence: 80 }, { orderId: 2, confidence: 80 }], [1, 2]), null)
  assert.throws(() => selectEscortCandidate([{ orderId: 1, confidence: 90 }], [1, 2]))
  const order = (id: number) => ({ id, sourceOrderNo: `COD${id}`, customerName: '张某', customerPhone: '13800000000', hospital: '协和医院', dept: '内科', doctor: '医生', rawJson: { crmApplyNo: `fwyy${id}` }, detailJson: {} })
  const updates: string[] = []
  const prisma = {
    nativeChatMessage: { findUnique: async () => ({ id: 1, text: '陪诊小结：患者张某，客户电话13800000000', orderId: null, applicationNo: null, applicationLinkStatus: 'unmatched', conversation: {} }) },
    $queryRaw: async () => [order(1), order(2)],
    $executeRaw: async (sql: TemplateStringsArray) => { updates.push(sql.join('?')); return 1 }
  } as unknown as PrismaClient
  let calls = 0
  let triggered = 0
  const deps = {
    config: async () => ({ textAnalysisModel: 'test', textAnalysisProvider: 'dashscope' as const }),
    chat: async () => ({ model: 'test', content: ++calls === 1 ? JSON.stringify({ isSummary: true, escortSummary: '服务经过：就诊完成。', patientName: '张某', patientPhone: '13800000000', hospital: '协和医院' }) : JSON.stringify({ scores: [{ orderId: 1, confidence: 71 }, { orderId: 2, confidence: 70 }] }) }),
    trigger: async (_prisma: unknown, _minio: unknown, id: number) => { triggered = id; return { skipped: false, fieldExtractionSucceeded: true } }
  }
  await processEscortSummaryJob(prisma, {} as Minio.Client, 1, deps as never)
  assert.equal(calls, 2)
  assert.equal(triggered, 1)
  assert.ok(updates.some((sql) => sql.includes("application_link_source='escort_summary'")))
  assert.ok(updates.some((sql) => sql.includes("status='matched'")))
  // A real-world format has an intended hospital only in nested Taikang details;
  // missing order phone must not prevent name plus hospital matching.
  let singleCalls = 0
  let singleTriggered = 0
  const singlePrisma = {
    nativeChatMessage: { findUnique: async () => ({ id: 2, text: '就诊人：林刚\n医院：中国医学科学院北京协和医院\n陪诊小结：服务结束', orderId: null, applicationNo: null, applicationLinkStatus: 'unmatched', conversation: {} }) },
    $queryRaw: async () => [{ ...order(48), customerName: '林刚', customerPhone: null, hospital: null, rawJson: { crmApplyNo: 'fwyy1564315180736503808' }, detailJson: { recommendations: { intendHos: '北京协和医院' } } }],
    $executeRaw: async () => 1
  } as unknown as PrismaClient
  const singleDeps = {
    ...deps,
    chat: async () => { singleCalls++; return { model: 'test', content: JSON.stringify({ isSummary: true, escortSummary: '服务经过：就诊完成。', patientName: '林刚', hospital: '中国医学科学院北京协和医院' }) } },
    trigger: async (_prisma: unknown, _minio: unknown, id: number) => { singleTriggered = id; return { skipped: false, fieldExtractionSucceeded: true } }
  }
  await processEscortSummaryJob(singlePrisma, {} as Minio.Client, 2, singleDeps as never)
  assert.equal(singleCalls, 1)
  assert.equal(singleTriggered, 48)
  let falseTriggered = false
  const falseDeps = {
    ...deps,
    chat: async () => ({ model: 'test', content: JSON.stringify({ isSummary: false }) }),
    trigger: async () => { falseTriggered = true; return { skipped: false, fieldExtractionSucceeded: true } }
  }
  await processEscortSummaryJob(prisma, {} as Minio.Client, 1, falseDeps as never)
  assert.equal(falseTriggered, false)
  assert.ok(updates.some((sql) => sql.includes("status='not_summary'")))
  const noOrders = { ...singlePrisma, $queryRaw: async () => [] } as unknown as PrismaClient
  let unmatchedRecorded = false
  ;(noOrders as unknown as { $executeRaw: (sql: TemplateStringsArray) => Promise<number> }).$executeRaw = async (sql) => { unmatchedRecorded ||= sql.join('?').includes("status='unmatched'"); return 1 }
  singleTriggered = 0
  await processEscortSummaryJob(noOrders, {} as Minio.Client, 2, singleDeps as never)
  assert.equal(singleTriggered, 0)
  assert.equal(unmatchedRecorded, true)
  const weakPrisma = {
    ...singlePrisma,
    $queryRaw: async () => [{ ...order(48), customerName: '林刚', customerPhone: null, hospital: null, dept: null, doctor: null, rawJson: { crmApplyNo: 'fwyy1564315180736503808' }, detailJson: {} }],
    $executeRaw: async () => 1
  } as unknown as PrismaClient
  singleTriggered = 0
  await processEscortSummaryJob(weakPrisma, {} as Minio.Client, 2, singleDeps as never)
  assert.equal(singleTriggered, 0, '只有姓名时不能因为候选唯一就关联')
  console.log('陪诊小结候选评分和匹配处理通过')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
