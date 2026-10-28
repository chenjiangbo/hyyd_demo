import type { PrismaClient } from '@prisma/client'
import { ensureBOrderFormInstance } from './bOrderForms.js'
import { getOrderWorkflow } from './workflow/serviceWorkflow.js'
import { formatShanghaiDateTime } from './time/shanghaiTime.js'

export type CallForCommunication = {
  id: number
  orderId: number | null
  applicationNo: string | null
  direction: string
  callStatus: string
  durationSec: number
  startedAt: Date
  asrStatus: string
  asrText: string | null
}

function resultForCall(callStatus: string): '致电成功' | '致电失败' {
  return callStatus === 'answered' ? '致电成功' : '致电失败'
}

export async function resolveCallBOrderId(prisma: PrismaClient, call: CallForCommunication): Promise<number | null> {
  if (call.orderId) return call.orderId
  if (!call.applicationNo) return null
  const rows = await prisma.order.findMany({
    where: { rawJson: { path: ['crmApplyNo'], equals: call.applicationNo } },
    select: { id: true },
    take: 2
  })
  return rows.length === 1 ? rows[0]!.id : null
}

/** 将单通电话写入该订单现有的 B 端沟通记录。callId 作为隐藏幂等键，不增加界面字段。 */
export async function saveCallAsBOrderCommunication(
  prisma: PrismaClient,
  call: CallForCommunication,
  options: { summary?: string; fallback?: string; orderId?: number } = {}
): Promise<boolean> {
  const orderId = options.orderId ?? await resolveCallBOrderId(prisma, call)
  if (!orderId) return false

  const result = resultForCall(call.callStatus)
  let content = options.summary?.trim() || ''
  if (!content && result === '致电失败') content = '电话未接通'
  // 电话沟通小结功能已停用；此写入路径不再自动调用模型生成内容。
  if (!content && options.fallback) content = options.fallback.trim()
  if (!content) return false

  const workflow = await getOrderWorkflow(prisma, orderId)
  if (!workflow) return false
  const formInstance = await ensureBOrderFormInstance(prisma, workflow)
  if (!formInstance) return false

  const record = {
    id: -call.id,
    // datetime-local 没有时区信息，保存为北京时间本地格式供沟通记录直接展示。
    time: formatShanghaiDateTime(call.startedAt).replace(' ', 'T'),
    content,
    result,
    sourceCallId: call.id,
    aiGenerated: true
  }

  await prisma.$transaction(async (tx) => {
    const tabRows = await tx.$queryRaw<Array<{ id: bigint; data_json: Record<string, unknown> }>>`
      SELECT id, data_json FROM b_order_form_tab_data
      WHERE form_instance_id = ${formInstance.instanceId} AND tab_code = 'communication'
      FOR UPDATE
    `
    if (!tabRows.length) throw new Error('订单沟通记录表单尚未初始化')
    const tabData = tabRows[0]!
    const storedRecords = tabData.data_json['communication.records']
    const records = Array.isArray(storedRecords) ? [...storedRecords] as Array<Record<string, unknown>> : []
    const existingIndex = records.findIndex((item) => Number(item.sourceCallId) === call.id)
    if (existingIndex >= 0) {
      // 只刷新 AI 自己生成的记录；人工记录不被自动覆盖。
      if (records[existingIndex]!.aiGenerated !== true) return
      records[existingIndex] = { ...records[existingIndex], ...record }
    } else {
      records.push(record)
    }
    records.sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')))
    const nextData = { ...tabData.data_json, 'communication.records': records }
    await tx.$executeRaw`
      UPDATE b_order_form_tab_data
      SET data_json = ${JSON.stringify(nextData)}::jsonb, updated_at = now()
      WHERE id = ${tabData.id}
    `

    const fieldRows = await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM b_order_form_tabs
      WHERE template_id = ${formInstance.templateId} AND code = 'communication'
    `
    if (fieldRows.length) {
      await tx.$executeRaw`
        INSERT INTO b_order_form_fields (tab_id, code, label, data_type, storage_kind, sort_order, status)
        VALUES (${fieldRows[0]!.id}, 'communication.records', '沟通记录', 'json', 'row_group', 10, 'active')
        ON CONFLICT (tab_id, code) DO UPDATE SET storage_kind = 'row_group', data_type = 'json'
      `
      await tx.$executeRaw`
        UPDATE b_order_form_rows SET row_status = 'void', updated_at = now()
        WHERE tab_data_id = ${tabData.id} AND row_group_code = 'communication.records' AND row_no > ${records.length}
      `
      for (let index = 0; index < records.length; index += 1) {
        await tx.$executeRaw`
          INSERT INTO b_order_form_rows (tab_data_id, row_group_code, row_no, row_status, row_data_json)
          VALUES (${tabData.id}, 'communication.records', ${index + 1}, 'active', ${JSON.stringify(records[index])}::jsonb)
          ON CONFLICT (tab_data_id, row_group_code, row_no) DO UPDATE
            SET row_status = 'active', row_data_json = EXCLUDED.row_data_json, updated_at = now()
        `
      }
    }

    await tx.$executeRaw`
      UPDATE b_order_form_instances SET updated_at = now() WHERE id = ${formInstance.instanceId}
    `
    const revisions = await tx.$queryRaw<Array<{ next_no: number }>>`
      SELECT COALESCE(MAX(revision_no), 0)::int + 1 AS next_no
      FROM b_order_form_revisions WHERE form_instance_id = ${formInstance.instanceId}
    `
    const tabs = await tx.$queryRaw<Array<{ tab_code: string; data_json: unknown }>>`
      SELECT tab_code, data_json FROM b_order_form_tab_data
      WHERE form_instance_id = ${formInstance.instanceId} ORDER BY id
    `
    await tx.$executeRaw`
      INSERT INTO b_order_form_revisions (form_instance_id, revision_no, action, snapshot_json, changed_fields_json)
      VALUES (${formInstance.instanceId}, ${revisions[0]!.next_no}, 'save', ${JSON.stringify(Object.fromEntries(tabs.map((tab) => [tab.tab_code, tab.data_json])))}::jsonb,
              ${JSON.stringify(['communication.records'])}::jsonb)
    `
  })
  return true
}

/** 在系统订单 AI 定时调度时，为已转写的电话生成摘要并写入对应 B 端订单。 */
export async function summarizeCallIntoBOrderCommunication(
  prisma: PrismaClient,
  call: CallForCommunication,
  orderId?: number
): Promise<boolean> {
  void prisma
  void call
  void orderId
  return false
}
