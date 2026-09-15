import { Prisma, type PrismaClient } from '@prisma/client'

export type WorkflowSource = 'system' | 'form' | 'ai' | 'manual'
export type WorkflowStepStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'skipped'

type DbClient = PrismaClient | Prisma.TransactionClient

type StepDefinition = {
  code: string
  name: string
  kind?: 'step' | 'package'
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

const STEP = (code: string, name: string): StepDefinition => ({ code, name })
const PACKAGE = (code: string, name: string, children: StepDefinition[], repeatable = false): StepDefinition => ({
  code,
  name,
  kind: 'package',
  repeatable,
  children
})

const CLAIM = STEP('claim', '申领')
const INITIAL_CONTACT = STEP('initial_contact', '初次沟通')
const PRE_VISIT_PLAN = STEP('pre_visit_plan', '诊前方案')
const END = STEP('end', '结束')
const REGISTRATION_SERVICE = PACKAGE('registration_service', '挂号就诊服务', [
  STEP('registration', '挂号'),
  STEP('escort', '陪诊')
])
const REGISTRATION_ONLY = STEP('registration', '挂号')
const CHECK_SERVICE = PACKAGE('check_service', '检查服务', [
  STEP('check_booking', '约检查'),
  STEP('check_companion', '检查陪同')
], true)
const HOSPITAL_SERVICE = PACKAGE('hospital_service', '住院服务', [
  STEP('hospital_booking', '约住院'),
  STEP('hospital_companion', '住院陪同')
], true)
const REVISIT_SERVICE = PACKAGE('revisit_service', '复诊服务', [
  STEP('revisit', '复诊'),
  STEP('revisit_escort', '免费陪诊')
], true)
const TRANSPORT = STEP('medical_transport', '就医接送')
const HOSPITAL_CARE = STEP('hospital_care', '住院护工')
const HOME_CARE = STEP('home_care', '上门照护')

/** 订单创建时应实际生成的轨迹；动态服务包不在这里预置。 */
export function initialStepsFor(serviceType: string): StepDefinition[] {
  switch (serviceType) {
    case '全程门诊':
    case '单次门诊':
    case '电话问诊':
    case 'MDT服务':
      return [CLAIM, INITIAL_CONTACT, PRE_VISIT_PLAN, REGISTRATION_SERVICE, END]
    case '全流程':
      return [CLAIM, INITIAL_CONTACT, PRE_VISIT_PLAN, REGISTRATION_SERVICE, END]
    case '挂号协助':
      return [CLAIM, INITIAL_CONTACT, PRE_VISIT_PLAN, REGISTRATION_ONLY, END]
    case '检查加急':
      return [CLAIM, INITIAL_CONTACT, CHECK_SERVICE, END]
    case '住院':
      return [CLAIM, INITIAL_CONTACT, HOSPITAL_SERVICE, END]
    case '住院护工协助':
      return [CLAIM, INITIAL_CONTACT, HOSPITAL_CARE, END]
    case '就医接送':
      return [CLAIM, INITIAL_CONTACT, TRANSPORT, END]
    case '共享流程':
      return [CLAIM, INITIAL_CONTACT, HOME_CARE, END]
    default:
      return [CLAIM, INITIAL_CONTACT, END]
  }
}

/** 当前服务类型可由事件自动追加的服务包。 */
export function flexiblePackageFor(serviceType: string, code: string): StepDefinition | null {
  if (code === 'revisit_service' && ['全程门诊', '全流程'].includes(serviceType)) return REVISIT_SERVICE
  if (code === 'hospital_service' && serviceType === '全流程') return HOSPITAL_SERVICE
  return null
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
      ${status}, ${parentStepId == null}, ${kind}, ${source}, ${sourceRef}, ${confidence},
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
  const definitions = initialStepsFor(serviceType)
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
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, rawJson: true } })
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
        await setStepStatus(tx, operation.id, initialStepsFor(serviceType).some((x) => x.code === 'pre_visit_plan') ? 'pre_visit_plan' : initialStepsFor(serviceType).find((x) => x.code !== 'claim' && x.code !== 'initial_contact' && x.code !== 'end')?.code ?? 'end', 1, 'in_progress', input)
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
      default:
        throw new Error(`不支持的业务流程事件: ${input.code}`)
    }
    if (packageCode && ['hospital_confirmed', 'revisit_confirmed'].includes(input.code)) {
      const definition = flexiblePackageFor(serviceType, packageCode)
      if (!definition) throw new Error(`服务类型“${serviceType}”不支持服务包“${packageCode}”`)
      await appendPackage(tx, operation.id, definition, input)
    }
    await tx.$executeRaw`
      UPDATE b_order_workflow_events SET applied_at = now() WHERE id = ${inserted[0].id}
    `
    return workflowForOperation(tx, operation, serviceType)
  })
}
