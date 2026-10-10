import type { PrismaClient } from '@prisma/client'
import type { OrderWorkflow } from './workflow/serviceWorkflow.js'

export interface BOrderFormTabDefinition {
  code: string
  name: string
}

const tabsByServiceType: Record<string, BOrderFormTabDefinition[]> = {
  '全程门诊': [{ code: 'claim', name: '申领' }, { code: 'plan', name: '确认方案' }, { code: 'assignment', name: '分配陪诊' }, { code: 'service-record', name: '陪诊录入' }],
  '全流程': [{ code: 'claim', name: '申领' }, { code: 'plan', name: '确认方案' }, { code: 'assignment', name: '分配陪诊' }, { code: 'service-record', name: '陪诊录入' }],
  '单次门诊': [{ code: 'claim', name: '申领' }, { code: 'plan', name: '确认方案' }, { code: 'assignment', name: '分配陪诊' }, { code: 'service-record', name: '陪诊录入' }],
  '电话问诊': [{ code: 'claim', name: '申领' }, { code: 'plan', name: '确认方案' }, { code: 'assignment', name: '分配陪诊' }, { code: 'service-record', name: '陪诊录入' }],
  '检查加急': [{ code: 'claim', name: '申领' }, { code: 'assignment', name: '分配陪诊' }, { code: 'service-record', name: '陪诊录入' }],
  '住院': [{ code: 'claim', name: '申领' }, { code: 'assignment', name: '分配陪诊' }, { code: 'service-record', name: '陪诊录入' }],
  '住院护工协助': [{ code: 'claim', name: '申领' }, { code: 'assignment', name: '分配陪诊' }, { code: 'service-record', name: '陪诊录入' }],
  '就医接送': [{ code: 'claim', name: '申领' }, { code: 'service-record', name: '服务录入' }],
  '共享流程': [{ code: 'claim', name: '申领' }, { code: 'service-record', name: '服务录入' }],
  'MDT服务': [{ code: 'claim', name: '申领' }, { code: 'plan', name: '确认方案' }, { code: 'service-record', name: '服务录入' }],
  '挂号协助': [{ code: 'claim', name: '申领' }, { code: 'plan', name: '确认方案' }, { code: 'service-record', name: '服务录入' }]
}

export function bOrderFormDefinitions(serviceType: string): { serviceTypeKey: string; tabs: BOrderFormTabDefinition[] } | null {
  const serviceTypeKey = Object.keys(tabsByServiceType).sort((a, b) => b.length - a.length)
    .find((type) => serviceType === type || serviceType.includes(type))
  if (!serviceTypeKey) return null
  return {
    serviceTypeKey,
    tabs: [...tabsByServiceType[serviceTypeKey]!, { code: 'communication', name: '沟通记录' }, { code: 'check-companion', name: '检查陪同信息' }]
  }
}

export async function ensureBOrderFormInstance(
  prisma: PrismaClient,
  workflow: OrderWorkflow,
  employeeId?: number | null
): Promise<{ serviceTypeKey: string; templateId: bigint; instanceId: bigint; tabs: BOrderFormTabDefinition[] } | null> {
  const definitions = bOrderFormDefinitions(workflow.serviceType)
  if (!definitions) return null
  const { serviceTypeKey, tabs } = definitions
  const templateCode = `b-order-${serviceTypeKey}`
  const templateRows = await prisma.$queryRaw<Array<{ id: bigint; version: number }>>`
    INSERT INTO b_order_form_templates (code, version, name, service_type, status, schema_json)
    VALUES (${templateCode}, 1, ${`${serviceTypeKey} B端服务表单`}, ${serviceTypeKey}, 'active', ${JSON.stringify({ source: 'service-flow-ui' })}::jsonb)
    ON CONFLICT (code, version) DO UPDATE SET code = b_order_form_templates.code
    RETURNING id, version
  `
  const template = templateRows[0]!
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index]!
    const tabRows = await prisma.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO b_order_form_tabs (template_id, code, name, sort_order, is_required, status)
      VALUES (${template.id}, ${tab.code}, ${tab.name}, ${index + 1}, ${tab.code !== 'claim' && !['communication', 'check-companion'].includes(tab.code)}, 'active')
      ON CONFLICT (template_id, code) DO UPDATE SET code = b_order_form_tabs.code
      RETURNING id
    `
    await prisma.$executeRaw`
      INSERT INTO b_order_form_fields (tab_id, code, label, data_type, storage_kind, sort_order, status)
      VALUES (${tabRows[0]!.id}, 'payload', '阶段表单数据', 'json', 'scalar', 1, 'active')
      ON CONFLICT (tab_id, code) DO NOTHING
    `
  }
  const instances = await prisma.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO b_order_form_instances (
      operation_id, template_id, template_code, template_version, status,
      template_snapshot_json, started_by_employee_id
    ) VALUES (
      ${workflow.operationId}, ${template.id}, ${templateCode}, ${template.version}, 'draft',
      ${JSON.stringify(tabs)}::jsonb, ${employeeId ?? null}
    )
    ON CONFLICT (operation_id, template_id, instance_no) DO UPDATE SET template_id = EXCLUDED.template_id
    RETURNING id
  `
  const instanceId = instances[0]!.id
  for (const tab of tabs) {
    const tabRows = await prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM b_order_form_tabs WHERE template_id = ${template.id} AND code = ${tab.code}
    `
    await prisma.$executeRaw`
      INSERT INTO b_order_form_tab_data (form_instance_id, tab_id, tab_code, tab_name)
      VALUES (${instanceId}, ${tabRows[0]!.id}, ${tab.code}, ${tab.name})
      ON CONFLICT (form_instance_id, tab_code) DO NOTHING
    `
  }
  return { serviceTypeKey, templateId: template.id, instanceId, tabs }
}
