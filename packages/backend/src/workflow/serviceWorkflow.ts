import { Prisma, type PrismaClient } from '@prisma/client'

export type WorkflowSource = 'system' | 'form' | 'ai' | 'manual'
export type WorkflowStepStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'skipped'

type DbClient = PrismaClient | Prisma.TransactionClient

type StepDefinition = {
  code: string
  name: string
  kind?: 'step' | 'package'
  required?: boolean
  repeatable?: boolean
  children?: StepDefinition[]
}

type StoredStep = {
  id: bigint
  operation_id: bigint
  parent_step_id: bigint | null
  step_code: string
  step_name: string
  occurrence_no: number
  sequence_no: number
  step_status: WorkflowStepStatus
  is_required: boolean
  step_kind: 'step' | 'package'
  source_type: WorkflowSource
  source_ref: string | null
  ai_confidence: number | null
  evidence_json: unknown
  planned_at: Date | null
  started_at: Date | null
  completed_at: Date | null
  activated_at: Date | null
  note: string | null
}

type OperationRow = { id: bigint; service_type: string | null }

type WorkflowConfigRow = {
  code: string
  name: string
  parent_code: string | null
  step_kind: 'step' | 'package'
  sort_order: number
  is_required: boolean
  is_repeatable: boolean
  activation_mode: 'initial' | 'event'
  trigger_event_code: string | null
}

export type WorkflowStep = {
  id: number
  parentStepId: number | null
  code: string
  name: string
  occurrenceNo: number
  sequenceNo: number
  status: WorkflowStepStatus
  required: boolean
  kind: 'step' | 'package'
  source: WorkflowSource
  sourceRef: string | null
  aiConfidence: number | null
  evidence: unknown
  plannedAt: string | null
  startedAt: string | null
  completedAt: string | null
  activatedAt: string | null
  note: string | null
  children: WorkflowStep[]
}

export type OrderWorkflow = {
  operationId: number
  serviceType: string
  steps: WorkflowStep[]
}

async function loadWorkflowDefinitions(
  db: DbClient,
  serviceType: string,
  activationMode: 'initial' | 'event',
  triggerEventCode?: string
): Promise<StepDefinition[]> {
  const rows = await db.$queryRaw<WorkflowConfigRow[]>`
    SELECT c.code, c.name, c.parent_code, c.step_kind, c.sort_order, c.is_required,
           c.is_repeatable, c.activation_mode, c.trigger_event_code
    FROM b_order_workflow_templates t
    JOIN b_order_workflow_step_configs c ON c.template_id = t.id
    WHERE t.service_type = ${serviceType}
      AND t.status = 'active'
      AND t.version = (
        SELECT MAX(version) FROM b_order_workflow_templates
        WHERE service_type = ${serviceType} AND status = 'active'
      )
      AND c.status = 'active'
      AND c.activation_mode = ${activationMode}
      ${triggerEventCode ? Prisma.sql`AND c.trigger_event_code = ${triggerEventCode}` : Prisma.empty}
    ORDER BY c.sort_order ASC, c.id ASC
  `
  const definitions = new Map<string, StepDefinition>()
  const roots: StepDefinition[] = []
  for (const row of rows) {
    definitions.set(row.code, {
      code: row.code,
      name: row.name,
      kind: row.step_kind,
      required: row.is_required,
      repeatable: row.is_repeatable,
      children: []
    })
  }
  for (const row of rows) {
    const definition = definitions.get(row.code)!
    if (row.parent_code) definitions.get(row.parent_code)?.children?.push(definition)
    else roots.push(definition)
  }
  return roots
}

async function initialStepsFor(db: DbClient, serviceType: string): Promise<StepDefinition[]> {
  return loadWorkflowDefinitions(db, serviceType, 'initial')
}

async function flexiblePackageFor(db: DbClient, serviceType: string, code: string): Promise<StepDefinition | null> {
  const definitions = await loadWorkflowDefinitions(db, serviceType, 'event', code === 'hospital_service' ? 'hospital_confirmed' : 'revisit_confirmed')
  return definitions.find((definition) => definition.code === code) ?? null
}

function serviceTypeOf(rawJson: unknown): string {
  const raw = (rawJson ?? {}) as Record<string, unknown>
  if (raw.poolType === 'register') return '挂号协助'
  return String(raw.serviceType ?? raw.itemName ?? '').trim() || '未识别服务'
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function toWorkflowStep(row: StoredStep): WorkflowStep {
  return {
    id: Number(row.id),
    parentStepId: row.parent_step_id == null ? null : Number(row.parent_step_id),
    code: row.step_code,
    name: row.step_name,
    occurrenceNo: row.occurrence_no,
    sequenceNo: row.sequence_no,
    status: row.step_status,
    required: row.is_required,
    kind: row.step_kind,
    source: row.source_type,
    sourceRef: row.source_ref,
    aiConfidence: row.ai_confidence == null ? null : Number(row.ai_confidence),
    evidence: row.evidence_json,
    plannedAt: toIso(row.planned_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    activatedAt: toIso(row.activated_at),
    note: row.note,
    children: []
  }
}

async function ensureOperation(db: DbClient, orderId: number, serviceType: string): Promise<OperationRow> {
  const rows = await db.$queryRaw<OperationRow[]>`
    INSERT INTO b_order_operations (order_id, service_type, current_step_code)
    VALUES (${orderId}, ${serviceType}, 'initial_contact')
    ON CONFLICT (order_id) DO UPDATE
      SET service_type = COALESCE(b_order_operations.service_type, EXCLUDED.service_type),
          updated_at = now()
    RETURNING id, service_type
  `
  return rows[0]
}

async function insertDefinition(
  db: DbClient,
  operationId: bigint,
  definition: StepDefinition,
  occurrenceNo: number,
  sequenceNo: number,
  parentStepId: bigint | null,
  source: WorkflowSource,
  sourceRef: string | null,
  confidence: number | null,
  evidence: unknown,
  status: WorkflowStepStatus
): Promise<bigint> {
  const kind = definition.kind ?? 'step'
  const rows = await db.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO b_order_service_steps (
      operation_id, parent_step_id, step_code, step_name, occurrence_no, sequence_no,
      step_status, is_required, step_kind, source_type, source_ref, ai_confidence,
      evidence_json, activated_at, started_at
    ) VALUES (
      ${operationId}, ${parentStepId}, ${definition.code}, ${definition.name}, ${occurrenceNo}, ${sequenceNo},
      ${status}, ${definition.required ?? true}, ${kind}, ${source}, ${sourceRef}, ${confidence},
      ${JSON.stringify(evidence)}::jsonb,
      ${status === 'in_progress' ? new Date() : null}, ${status === 'in_progress' ? new Date() : null}
    )
    ON CONFLICT (operation_id, step_code, occurrence_no) DO UPDATE
      SET parent_step_id = COALESCE(b_order_service_steps.parent_step_id, EXCLUDED.parent_step_id)
    RETURNING id
  `
  return rows[0].id
}

async function seedInitialWorkflow(db: DbClient, operationId: bigint, serviceType: string): Promise<void> {
  // 结束始终位于轨迹最右侧；后续自动识别出的灵活服务包插在它之前。
  await db.$executeRaw`
    UPDATE b_order_service_steps
    SET sequence_no = 1000000
    WHERE operation_id = ${operationId}
      AND step_code = 'end'
      AND sequence_no < 1000000
  `
  const definitions = await initialStepsFor(db, serviceType)
  if (definitions.length === 0) {
    throw new Error(`未找到服务类型“${serviceType}”的已发布步骤配置`)
  }
  for (const [index, definition] of definitions.entries()) {
    const status: WorkflowStepStatus = definition.code === 'claim'
      ? 'completed'
      : definition.code === 'initial_contact'
        ? 'in_progress'
        : 'pending'
    const parentId = await insertDefinition(
      db,
      operationId,
      definition,
      1,
      definition.code === 'end' ? 1000000 : (index + 1) * 10,
      null,
      'system',
      'workflow-template-v1',
      null,
      [],
      status
    )
    for (const child of definition.children ?? []) {
      await insertDefinition(db, operationId, child, 1, (index + 1) * 10 + 1, parentId, 'system', 'workflow-template-v1', null, [], 'pending')
    }
  }
}

async function rowsForOperation(db: DbClient, operationId: bigint): Promise<StoredStep[]> {
  return db.$queryRaw<StoredStep[]>`
    SELECT id, operation_id, parent_step_id, step_code, step_name, occurrence_no, sequence_no,
      step_status, is_required, step_kind, source_type, source_ref, ai_confidence, evidence_json,
      planned_at, started_at, completed_at, activated_at, note
    FROM b_order_service_steps
    WHERE operation_id = ${operationId}
    ORDER BY sequence_no ASC, occurrence_no ASC, id ASC
  `
}

async function workflowForOperation(db: DbClient, operation: OperationRow, serviceType: string): Promise<OrderWorkflow> {
  const rows = await rowsForOperation(db, operation.id)
  const byId = new Map<number, WorkflowStep>()
  const roots: WorkflowStep[] = []
  for (const row of rows) byId.set(Number(row.id), toWorkflowStep(row))
  for (const step of byId.values()) {
    if (step.parentStepId == null) roots.push(step)
    else byId.get(step.parentStepId)?.children.push(step)
  }
  return { operationId: Number(operation.id), serviceType, steps: roots }
}

export async function getOrderWorkflow(prisma: PrismaClient, orderId: number): Promise<OrderWorkflow | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, rawJson: true } })
  if (!order) return null
  const serviceType = serviceTypeOf(order.rawJson)
  return prisma.$transaction(async (tx) => {
    const operation = await ensureOperation(tx, order.id, serviceType)
    await seedInitialWorkflow(tx, operation.id, serviceType)
    return workflowForOperation(tx, operation, serviceType)
  })
}

/** 新订单写入 orders 后立即调用；幂等，不会重置已有步骤状态。 */
export async function initializeOrderWorkflow(prisma: PrismaClient, orderId: number): Promise<void> {
  await getOrderWorkflow(prisma, orderId)
}

export type WorkflowEventInput = {
  code: string
  source: Exclude<WorkflowSource, 'system'>
  sourceRef?: string | null
  confidence?: number | null
  evidence?: unknown
  note?: string | null
  occurrenceNo?: number
}

async function nextOccurrence(db: DbClient, operationId: bigint, code: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ next_occurrence: number }>>`
    SELECT COALESCE(MAX(occurrence_no), 0)::int + 1 AS next_occurrence
    FROM b_order_service_steps
    WHERE operation_id = ${operationId} AND step_code = ${code}
  `
  return rows[0].next_occurrence
}

async function nextSequence(db: DbClient, operationId: bigint): Promise<number> {
  const rows = await db.$queryRaw<Array<{ next_sequence: number }>>`
    SELECT COALESCE(MAX(sequence_no), 0)::int + 10 AS next_sequence
    FROM b_order_service_steps
    WHERE operation_id = ${operationId}
      AND step_code <> 'end'
  `
  return rows[0].next_sequence
}

async function setStepStatus(
  db: DbClient,
  operationId: bigint,
  code: string,
  occurrenceNo: number,
  status: WorkflowStepStatus,
  input: WorkflowEventInput
): Promise<void> {
  await db.$executeRaw`
    UPDATE b_order_service_steps
    SET step_status = ${status},
        source_type = ${input.source},
        source_ref = ${input.sourceRef ?? null},
        ai_confidence = ${input.confidence ?? null},
        evidence_json = ${JSON.stringify(input.evidence ?? [])}::jsonb,
        note = COALESCE(${input.note ?? null}, note),
        activated_at = CASE WHEN ${status} = 'in_progress' THEN now() ELSE activated_at END,
        started_at = CASE WHEN ${status} = 'in_progress' THEN now() ELSE started_at END,
        completed_at = CASE WHEN ${status} = 'completed' THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE operation_id = ${operationId} AND step_code = ${code} AND occurrence_no = ${occurrenceNo}
  `
}

async function refreshPackageStatus(db: DbClient, operationId: bigint, packageCode: string, occurrenceNo: number): Promise<void> {
  const rows = await db.$queryRaw<Array<{ step_status: WorkflowStepStatus }>>`
    SELECT child.step_status
    FROM b_order_service_steps parent
    JOIN b_order_service_steps child ON child.parent_step_id = parent.id
    WHERE parent.operation_id = ${operationId}
      AND parent.step_code = ${packageCode}
      AND parent.occurrence_no = ${occurrenceNo}
  `
  if (rows.length === 0) return
  const status: WorkflowStepStatus = rows.every((row) => row.step_status === 'completed')
    ? 'completed'
    : rows.some((row) => row.step_status === 'in_progress' || row.step_status === 'completed')
      ? 'in_progress'
      : 'pending'
  await db.$executeRaw`
    UPDATE b_order_service_steps
    SET step_status = ${status},
        activated_at = CASE WHEN ${status} = 'in_progress' THEN COALESCE(activated_at, now()) ELSE activated_at END,
        completed_at = CASE WHEN ${status} = 'completed' THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE operation_id = ${operationId} AND step_code = ${packageCode} AND occurrence_no = ${occurrenceNo}
  `
}

async function appendPackage(
  db: DbClient,
  operationId: bigint,
  definition: StepDefinition,
  input: WorkflowEventInput
): Promise<number> {
  const occurrence = await nextOccurrence(db, operationId, definition.code)
  const sequence = await nextSequence(db, operationId)
  const parentId = await insertDefinition(db, operationId, definition, occurrence, sequence, null, input.source, input.sourceRef ?? null, input.confidence ?? null, input.evidence ?? [], 'in_progress')
  const children = definition.children ?? []
  for (const [index, child] of children.entries()) {
    await insertDefinition(
      db,
      operationId,
      child,
      occurrence,
      sequence + index + 1,
      parentId,
      input.source,
      input.sourceRef ?? null,
      input.confidence ?? null,
      input.evidence ?? [],
      index === 0 ? 'in_progress' : 'pending'
    )
  }
  return occurrence
}

/**
 * 将 AI / 表单 / 人工确认的“事实事件”转成步骤变化。
 * 事件先落审计表，再应用；同一 event_key 再次到达时不会重复创建服务包。
 */
export async function applyOrderWorkflowEvent(
  prisma: PrismaClient,
  orderId: number,
  input: WorkflowEventInput
): Promise<OrderWorkflow | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, rawJson: true, huanyuOrderNo: true, sourceOrderNo: true }
  })
  if (!order) return null
  const serviceType = serviceTypeOf(order.rawJson)
  return prisma.$transaction(async (tx) => {
    const operation = await ensureOperation(tx, order.id, serviceType)
    await seedInitialWorkflow(tx, operation.id, serviceType)
    const eventKey = `${input.source}:${input.sourceRef ?? input.code}:${input.code}`.slice(0, 180)
    const inserted = await tx.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO b_order_workflow_events (
        operation_id, event_code, event_key, source_type, source_ref, confidence, payload_json, evidence_json
      ) VALUES (
        ${operation.id}, ${input.code}, ${eventKey}, ${input.source}, ${input.sourceRef ?? null}, ${input.confidence ?? null},
        ${JSON.stringify({ note: input.note ?? null })}::jsonb, ${JSON.stringify(input.evidence ?? [])}::jsonb
      ) ON CONFLICT (operation_id, event_key) DO NOTHING
      RETURNING id
    `
    if (inserted.length === 0) return workflowForOperation(tx, operation, serviceType)

    let packageCode: string | null = null
    let occurrence = 1
    switch (input.code) {
      case 'initial_contact_completed':
        await setStepStatus(tx, operation.id, 'initial_contact', 1, 'completed', input)
        {
          const initialSteps = await initialStepsFor(tx, serviceType)
          const nextStepCode = initialSteps.some((x) => x.code === 'pre_visit_plan')
            ? 'pre_visit_plan'
            : initialSteps.find((x) => x.code !== 'claim' && x.code !== 'initial_contact' && x.code !== 'end')?.code ?? 'end'
          await setStepStatus(tx, operation.id, nextStepCode, 1, 'in_progress', input)
        }
        break
      case 'pre_visit_plan_completed':
        await setStepStatus(tx, operation.id, 'pre_visit_plan', 1, 'completed', input)
        await setStepStatus(tx, operation.id, serviceType === '挂号协助' ? 'registration' : 'registration_service', 1, 'in_progress', input)
        break
      case 'registration_completed':
        await setStepStatus(tx, operation.id, 'registration', 1, 'completed', input)
        if (serviceType !== '挂号协助') {
          await setStepStatus(tx, operation.id, 'escort', 1, 'in_progress', input)
          await refreshPackageStatus(tx, operation.id, 'registration_service', 1)
        }
        break
      case 'escort_completed':
        await setStepStatus(tx, operation.id, 'escort', 1, 'completed', input)
        await refreshPackageStatus(tx, operation.id, 'registration_service', 1)
        break
      case 'check_confirmed':
        // 检查加急在订单创建时已生成检查服务；当前业务矩阵没有为其他
        // 服务类型开放“按识别结果追加检查服务”，避免 AI 误识别后越权加包。
        packageCode = 'check_service'
        occurrence = input.occurrenceNo ?? 1
        const existingCheck = await tx.$queryRaw<Array<{ id: bigint }>>`
          SELECT id FROM b_order_service_steps
          WHERE operation_id = ${operation.id}
            AND step_code = 'check_service'
            AND occurrence_no = ${occurrence}
          LIMIT 1
        `
        if (existingCheck.length === 0) {
          throw new Error(`服务类型“${serviceType}”不支持服务包“check_service”`)
        }
        break
      case 'hospital_confirmed':
        packageCode = 'hospital_service'
        break
      case 'revisit_confirmed':
        packageCode = 'revisit_service'
        break
      case 'check_booking_completed':
        packageCode = 'check_service'
        occurrence = input.occurrenceNo ?? 1
        await setStepStatus(tx, operation.id, 'check_booking', occurrence, 'completed', input)
        await setStepStatus(tx, operation.id, 'check_companion', occurrence, 'in_progress', input)
        await refreshPackageStatus(tx, operation.id, packageCode, occurrence)
        break
      case 'check_companion_completed':
        packageCode = 'check_service'
        occurrence = input.occurrenceNo ?? 1
        await setStepStatus(tx, operation.id, 'check_companion', occurrence, 'completed', input)
        await refreshPackageStatus(tx, operation.id, packageCode, occurrence)
        break
      case 'hospital_booking_completed':
        packageCode = 'hospital_service'
        occurrence = input.occurrenceNo ?? 1
        await setStepStatus(tx, operation.id, 'hospital_booking', occurrence, 'completed', input)
        await setStepStatus(tx, operation.id, 'hospital_companion', occurrence, 'in_progress', input)
        await refreshPackageStatus(tx, operation.id, packageCode, occurrence)
        break
      case 'hospital_companion_completed':
        packageCode = 'hospital_service'
        occurrence = input.occurrenceNo ?? 1
        await setStepStatus(tx, operation.id, 'hospital_companion', occurrence, 'completed', input)
        await refreshPackageStatus(tx, operation.id, packageCode, occurrence)
        break
      case 'revisit_completed':
        packageCode = 'revisit_service'
        occurrence = input.occurrenceNo ?? 1
        await setStepStatus(tx, operation.id, 'revisit', occurrence, 'completed', input)
        await setStepStatus(tx, operation.id, 'revisit_escort', occurrence, 'in_progress', input)
        await refreshPackageStatus(tx, operation.id, packageCode, occurrence)
        break
      case 'revisit_escort_completed':
        packageCode = 'revisit_service'
        occurrence = input.occurrenceNo ?? 1
        await setStepStatus(tx, operation.id, 'revisit_escort', occurrence, 'completed', input)
        await refreshPackageStatus(tx, operation.id, packageCode, occurrence)
        break
      case 'service_cancelled':
        // 1. 将当前订单所有非 end 步骤中处于 pending 或 in_progress 的步骤置为 cancelled
        await tx.$executeRaw`
          UPDATE b_order_service_steps
          SET step_status = 'cancelled',
              updated_at = now()
          WHERE operation_id = ${operation.id}
            AND step_code <> 'end'
            AND step_status IN ('pending', 'in_progress')
        `
        // 2. 将 end 步骤置为 completed（结束）
        await tx.$executeRaw`
          UPDATE b_order_service_steps
          SET step_status = 'completed',
              activated_at = COALESCE(activated_at, now()),
              completed_at = now(),
              source_type = ${input.source},
              source_ref = ${input.sourceRef ?? null},
              ai_confidence = ${input.confidence ?? null},
              evidence_json = ${JSON.stringify(input.evidence ?? [])}::jsonb,
              updated_at = now()
          WHERE operation_id = ${operation.id}
            AND step_code = 'end'
        `
        // 3. 将订单主表 orders 的 status 更新为 '已取消'
        await tx.order.update({
          where: { id: order.id },
          data: { status: '已取消' }
        })
        // 4. 同步更新本地镜像表 HY_FACT_DDCX_NEW 的 DD_state 为 '已取消'
        try {
          const raw = (order.rawJson ?? {}) as Record<string, unknown>
          const huanyuOrderNo = order.huanyuOrderNo || (typeof raw.orderNo === 'string' ? raw.orderNo : null) || (typeof raw.crmApplyNo === 'string' ? raw.crmApplyNo : null)
          const sourceOrderNo = order.sourceOrderNo || (typeof raw.sourceOrderNo === 'string' ? raw.sourceOrderNo : null)
          if (huanyuOrderNo || sourceOrderNo) {
            await tx.$executeRaw`
              UPDATE "HY_FACT_DDCX_NEW"
              SET "DD_state" = '已取消',
                  xtsj_ = now()
              WHERE (${huanyuOrderNo ? Prisma.sql`"DDBH" = ${huanyuOrderNo}` : Prisma.sql`FALSE`})
                 OR (${sourceOrderNo ? Prisma.sql`"BDQD_DDBH" = ${sourceOrderNo}` : Prisma.sql`FALSE`})
            `
          }
        } catch (syncErr) {
          console.warn(`[workflow] 订单 ${order.id} 同步 HY_FACT_DDCX_NEW 取消状态跳过:`, (syncErr as Error).message)
        }
        break
      default:
        throw new Error(`不支持的业务流程事件: ${input.code}`)
    }
    if (packageCode && ['hospital_confirmed', 'revisit_confirmed'].includes(input.code)) {
      const definition = await flexiblePackageFor(tx, serviceType, packageCode)
      if (!definition) throw new Error(`服务类型“${serviceType}”不支持服务包“${packageCode}”`)
      await appendPackage(tx, operation.id, definition, input)
    }
    await tx.$executeRaw`
      UPDATE b_order_workflow_events SET applied_at = now() WHERE id = ${inserted[0].id}
    `
    return workflowForOperation(tx, operation, serviceType)
  })
}
