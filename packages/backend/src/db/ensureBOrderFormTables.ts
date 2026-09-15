import type { PrismaClient } from '@prisma/client'
import { DEFAULT_WORKFLOW_TEMPLATES } from '../workflow/defaultWorkflowConfig.js'

/**
 * B 端订单运营表单的第一版存储结构。
 *
 * 设计边界：
 * - orders.raw_json / detail_json 继续只保存 B 端抓取快照，不写入人工运营数据；
 * - 每张 B 端订单最多有一条 b_order_operations 运营主记录；
 * - 表单定义（模板、Tab、字段）与订单填写数据分离，并且实例保存模板快照，避免以后改模板
 *   导致历史订单无法正确展示；
 * - 单值字段保存在 Tab 级 JSONB，多行数据、附件关联和每次修改的审计记录各自独立落表。
 *
 * 这些表暂由启动检查创建，等表单读写 API 开始接入时再按需要补 Prisma model / migration。
 */
const CREATE_STATEMENTS = [
  // 模板及其版本。code + version 是稳定的业务标识，历史版本不应原地修改。
  `
    CREATE TABLE IF NOT EXISTS b_order_form_templates (
      id BIGSERIAL PRIMARY KEY,
      code VARCHAR(80) NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      name VARCHAR(150) NOT NULL,
      scope VARCHAR(20) NOT NULL DEFAULT 'order' CHECK (scope = 'order'),
      service_type VARCHAR(100),
      description TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'retired')),
      schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      effective_from TIMESTAMPTZ,
      effective_to TIMESTAMPTZ,
      created_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_form_templates_code_version_key UNIQUE (code, version)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_form_templates_active_idx
      ON b_order_form_templates (status, service_type, effective_from DESC);
  `,

  // Tab 是模板内的展示与填写单元；display_condition_json 留给服务类型/字段值驱动的显隐规则。
  `
    CREATE TABLE IF NOT EXISTS b_order_form_tabs (
      id BIGSERIAL PRIMARY KEY,
      template_id BIGINT NOT NULL REFERENCES b_order_form_templates(id) ON DELETE RESTRICT,
      code VARCHAR(80) NOT NULL,
      name VARCHAR(150) NOT NULL,
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      display_condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_required BOOLEAN NOT NULL DEFAULT false,
      is_repeatable BOOLEAN NOT NULL DEFAULT false,
      status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'hidden', 'retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_form_tabs_template_code_key UNIQUE (template_id, code)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_form_tabs_template_sort_idx
      ON b_order_form_tabs (template_id, sort_order, id);
  `,

  // 字段配置不和订单数据混存。所有业务代码引用 code，不依赖会变化的中文 label。
  `
    CREATE TABLE IF NOT EXISTS b_order_form_fields (
      id BIGSERIAL PRIMARY KEY,
      tab_id BIGINT NOT NULL REFERENCES b_order_form_tabs(id) ON DELETE RESTRICT,
      code VARCHAR(80) NOT NULL,
      label VARCHAR(150) NOT NULL,
      data_type VARCHAR(30) NOT NULL,
      storage_kind VARCHAR(20) NOT NULL DEFAULT 'scalar'
        CHECK (storage_kind IN ('scalar', 'row_group')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_required BOOLEAN NOT NULL DEFAULT false,
      is_read_only BOOLEAN NOT NULL DEFAULT false,
      is_filterable BOOLEAN NOT NULL DEFAULT false,
      placeholder VARCHAR(300),
      help_text TEXT,
      default_value_json JSONB,
      options_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      dictionary_key VARCHAR(100),
      validation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      visibility_condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      dependency_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      sync_mapping_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'hidden', 'retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_form_fields_tab_code_key UNIQUE (tab_id, code)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_form_fields_tab_sort_idx
      ON b_order_form_fields (tab_id, sort_order, id);
  `,

  // 一张 B 端订单一条内部运营主记录；外部原始状态和内部状态分开保存。
  `
    CREATE TABLE IF NOT EXISTS b_order_operations (
      id BIGSERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      service_type VARCHAR(100),
      current_step_code VARCHAR(80),
      auto_status VARCHAR(40) NOT NULL DEFAULT '待跟进',
      manual_status VARCHAR(40),
      manual_status_reason TEXT,
      effective_status VARCHAR(40) NOT NULL DEFAULT '待跟进',
      assigned_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      extra_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_operations_order_key UNIQUE (order_id),
      CONSTRAINT b_order_operations_manual_status_reason_check
        CHECK (manual_status IS NULL OR manual_status_reason IS NOT NULL)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_operations_status_idx
      ON b_order_operations (effective_status, current_step_code, updated_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_operations_employee_idx
      ON b_order_operations (assigned_employee_id, effective_status, updated_at DESC);
  `,

  // 服务步骤承载生命周期；occurrence_no 支持复诊等同类步骤重复发生。
  `
    CREATE TABLE IF NOT EXISTS b_order_service_steps (
      id BIGSERIAL PRIMARY KEY,
      operation_id BIGINT NOT NULL REFERENCES b_order_operations(id) ON DELETE CASCADE,
      step_code VARCHAR(80) NOT NULL,
      step_name VARCHAR(150) NOT NULL,
      occurrence_no INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_no > 0),
      sequence_no INTEGER NOT NULL DEFAULT 0,
      step_status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (step_status IN ('pending', 'in_progress', 'completed', 'cancelled', 'skipped')),
      is_required BOOLEAN NOT NULL DEFAULT true,
      planned_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      owner_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_service_steps_operation_code_occurrence_key
        UNIQUE (operation_id, step_code, occurrence_no)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_service_steps_operation_sequence_idx
      ON b_order_service_steps (operation_id, sequence_no, occurrence_no);
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_service_steps_status_idx
      ON b_order_service_steps (step_status, planned_at, completed_at);
  `,
  // 兼容已创建的第一版步骤表：服务包是父节点，子步骤可独立流转；事件与证据用于 AI/表单自动推进的审计。
  `
    ALTER TABLE b_order_service_steps
      ADD COLUMN IF NOT EXISTS parent_step_id BIGINT REFERENCES b_order_service_steps(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS step_kind VARCHAR(20) NOT NULL DEFAULT 'step'
        CHECK (step_kind IN ('step', 'package')),
      ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) NOT NULL DEFAULT 'system'
        CHECK (source_type IN ('system', 'form', 'ai', 'manual')),
      ADD COLUMN IF NOT EXISTS source_ref VARCHAR(160),
      ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(5,4),
      ADD COLUMN IF NOT EXISTS evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_service_steps_parent_idx
      ON b_order_service_steps (parent_step_id, sequence_no, occurrence_no);
  `,
  `
    CREATE TABLE IF NOT EXISTS b_order_workflow_events (
      id BIGSERIAL PRIMARY KEY,
      operation_id BIGINT NOT NULL REFERENCES b_order_operations(id) ON DELETE CASCADE,
      event_code VARCHAR(100) NOT NULL,
      event_key VARCHAR(180) NOT NULL,
      source_type VARCHAR(20) NOT NULL
        CHECK (source_type IN ('form', 'ai', 'manual', 'system')),
      source_ref VARCHAR(160),
      confidence NUMERIC(5,4),
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      applied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_workflow_events_operation_key UNIQUE (operation_id, event_key)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_workflow_events_operation_created_idx
      ON b_order_workflow_events (operation_id, created_at DESC);
  `,

  // 已发布的服务类型—步骤规则。订单实例只能从这里读取，不再依赖页面的静态步骤定义。
  `
    CREATE TABLE IF NOT EXISTS b_order_workflow_templates (
      id BIGSERIAL PRIMARY KEY,
      code VARCHAR(80) NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      name VARCHAR(150) NOT NULL,
      service_type VARCHAR(100) NOT NULL,
      description TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_workflow_templates_code_version_key UNIQUE (code, version),
      CONSTRAINT b_order_workflow_templates_service_version_key UNIQUE (service_type, version)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_workflow_templates_active_idx
      ON b_order_workflow_templates (service_type, status, version DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS b_order_workflow_step_configs (
      id BIGSERIAL PRIMARY KEY,
      template_id BIGINT NOT NULL REFERENCES b_order_workflow_templates(id) ON DELETE CASCADE,
      code VARCHAR(80) NOT NULL,
      name VARCHAR(150) NOT NULL,
      parent_code VARCHAR(80),
      step_kind VARCHAR(20) NOT NULL DEFAULT 'step'
        CHECK (step_kind IN ('step', 'package')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_required BOOLEAN NOT NULL DEFAULT true,
      is_repeatable BOOLEAN NOT NULL DEFAULT false,
      activation_mode VARCHAR(20) NOT NULL DEFAULT 'initial'
        CHECK (activation_mode IN ('initial', 'event')),
      trigger_event_code VARCHAR(100),
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'hidden', 'retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_workflow_step_configs_template_code_key UNIQUE (template_id, code)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_workflow_step_configs_template_sort_idx
      ON b_order_workflow_step_configs (template_id, activation_mode, sort_order, id);
  `,

  // 表单实例在创建时固定模板版本和快照；可不绑定服务步骤，以兼容订单级通用 Tab。
  `
    CREATE TABLE IF NOT EXISTS b_order_form_instances (
      id BIGSERIAL PRIMARY KEY,
      operation_id BIGINT NOT NULL REFERENCES b_order_operations(id) ON DELETE CASCADE,
      service_step_id BIGINT REFERENCES b_order_service_steps(id) ON DELETE SET NULL,
      template_id BIGINT NOT NULL REFERENCES b_order_form_templates(id) ON DELETE RESTRICT,
      template_code VARCHAR(80) NOT NULL,
      template_version INTEGER NOT NULL CHECK (template_version > 0),
      instance_no INTEGER NOT NULL DEFAULT 1 CHECK (instance_no > 0),
      status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'locked', 'void')),
      template_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      submitted_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      submitted_at TIMESTAMPTZ,
      locked_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      locked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_form_instances_operation_template_instance_key
        UNIQUE (operation_id, template_id, instance_no)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_form_instances_operation_idx
      ON b_order_form_instances (operation_id, status, updated_at DESC);
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_form_instances_step_idx
      ON b_order_form_instances (service_step_id, status, updated_at DESC);
  `,

  // 每个 Tab 一份 JSONB，只放该 Tab 的单值字段；字段名使用 field code。
  `
    CREATE TABLE IF NOT EXISTS b_order_form_tab_data (
      id BIGSERIAL PRIMARY KEY,
      form_instance_id BIGINT NOT NULL REFERENCES b_order_form_instances(id) ON DELETE CASCADE,
      tab_id BIGINT REFERENCES b_order_form_tabs(id) ON DELETE SET NULL,
      tab_code VARCHAR(80) NOT NULL,
      tab_name VARCHAR(150) NOT NULL,
      data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      completion_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'completed', 'not_applicable')),
      last_edited_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_form_tab_data_instance_tab_code_key UNIQUE (form_instance_id, tab_code)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_form_tab_data_instance_idx
      ON b_order_form_tab_data (form_instance_id, id);
  `,

  // 表格/重复组件的每一行独立存储，row_group_code 指向字段定义中 storage_kind=row_group 的字段 code。
  `
    CREATE TABLE IF NOT EXISTS b_order_form_rows (
      id BIGSERIAL PRIMARY KEY,
      tab_data_id BIGINT NOT NULL REFERENCES b_order_form_tab_data(id) ON DELETE CASCADE,
      row_group_code VARCHAR(80) NOT NULL,
      row_no INTEGER NOT NULL DEFAULT 1 CHECK (row_no > 0),
      row_status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (row_status IN ('active', 'void')),
      row_data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      updated_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_form_rows_tab_group_row_no_key UNIQUE (tab_data_id, row_group_code, row_no)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_form_rows_tab_group_idx
      ON b_order_form_rows (tab_data_id, row_group_code, row_status, row_no);
  `,

  // 文件本体仍由既有附件/素材表和对象存储管理；此表只描述它被哪个表单字段引用。
  `
    CREATE TABLE IF NOT EXISTS b_order_form_file_links (
      id BIGSERIAL PRIMARY KEY,
      operation_id BIGINT NOT NULL REFERENCES b_order_operations(id) ON DELETE CASCADE,
      form_instance_id BIGINT REFERENCES b_order_form_instances(id) ON DELETE CASCADE,
      tab_data_id BIGINT REFERENCES b_order_form_tab_data(id) ON DELETE CASCADE,
      form_row_id BIGINT REFERENCES b_order_form_rows(id) ON DELETE CASCADE,
      field_code VARCHAR(80),
      file_role VARCHAR(50) NOT NULL DEFAULT 'attachment',
      order_attachment_id INTEGER REFERENCES order_attachments(id) ON DELETE CASCADE,
      material_id INTEGER REFERENCES materials(id) ON DELETE CASCADE,
      created_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_form_file_links_one_file_check
        CHECK (num_nonnulls(order_attachment_id, material_id) = 1)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_form_file_links_operation_idx
      ON b_order_form_file_links (operation_id, form_instance_id, tab_data_id);
  `,

  // 每次保存、提交、锁定或作废都应新增一条记录；snapshot_json 保存提交时的全量表单快照。
  `
    CREATE TABLE IF NOT EXISTS b_order_form_revisions (
      id BIGSERIAL PRIMARY KEY,
      form_instance_id BIGINT NOT NULL REFERENCES b_order_form_instances(id) ON DELETE CASCADE,
      revision_no INTEGER NOT NULL CHECK (revision_no > 0),
      action VARCHAR(20) NOT NULL
        CHECK (action IN ('save', 'submit', 'lock', 'void', 'restore')),
      snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      changed_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      reason TEXT,
      operated_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT b_order_form_revisions_instance_revision_key UNIQUE (form_instance_id, revision_no)
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_form_revisions_instance_created_idx
      ON b_order_form_revisions (form_instance_id, created_at DESC);
  `,

  // AI 按订单产出的分析批次与字段候选值。沟通记录仍然以申请号采集；本组表把
  // “同一申请号上下文、不同订单分别分析”的结果隔离保存，绝不直接写正式订单字段。
  `
    CREATE TABLE IF NOT EXISTS b_order_ai_analysis_runs (
      id BIGSERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      application_no VARCHAR(100),
      model VARCHAR(100) NOT NULL,
      prompt_version VARCHAR(40) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'succeeded'
        CHECK (status IN ('running', 'succeeded', 'failed')),
      source_message_max_id INTEGER,
      source_call_max_id INTEGER,
      source_material_max_id INTEGER,
      raw_result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_ai_analysis_runs_order_created_idx
      ON b_order_ai_analysis_runs (order_id, created_at DESC);
  `,
  `
    CREATE TABLE IF NOT EXISTS b_order_ai_field_candidates (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES b_order_ai_analysis_runs(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      field_code VARCHAR(100) NOT NULL,
      field_label VARCHAR(150) NOT NULL,
      value_text TEXT NOT NULL,
      normalized_value_json JSONB,
      candidate_type VARCHAR(30) NOT NULL DEFAULT 'new_or_confirmed'
        CHECK (candidate_type IN ('new_or_confirmed', 'change_candidate', 'ambiguous')),
      confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
      requires_confirmation BOOLEAN NOT NULL DEFAULT false,
      evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'adopted', 'dismissed', 'superseded')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      adopted_at TIMESTAMPTZ,
      adopted_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_ai_field_candidates_order_field_idx
      ON b_order_ai_field_candidates (order_id, field_code, status, created_at DESC);
  `,

  // 人工确认推送远端 MySQL 时的不可变审计记录；失败可在页面再次点击重试。
  `
    CREATE TABLE IF NOT EXISTS b_order_huanyu_push_logs (
      id BIGSERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      huanyu_order_no VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL CHECK (status IN ('succeeded', 'failed')),
      message TEXT,
      pushed_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `,
  `
    CREATE INDEX IF NOT EXISTS b_order_huanyu_push_logs_order_created_idx
      ON b_order_huanyu_push_logs (order_id, created_at DESC);
  `
]

/** 在后端启动时幂等创建运营表单存储表；数据库异常必须上抛，避免服务带着半初始化结构运行。 */
export async function ensureBOrderFormTables(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(CREATE_STATEMENTS.map((statement) => prisma.$executeRawUnsafe(statement)))
  // 默认配置只在首次缺失时写入；管理员后续在后台维护的配置不会被启动过程覆盖。
  for (const template of DEFAULT_WORKFLOW_TEMPLATES) {
    const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO b_order_workflow_templates (code, version, name, service_type, status)
      VALUES (${template.code}, 1, ${template.name}, ${template.serviceType}, 'active')
      ON CONFLICT (service_type, version) DO UPDATE
        SET code = b_order_workflow_templates.code
      RETURNING id
    `
    const templateId = rows[0]!.id
    for (const step of template.steps) {
      await prisma.$executeRaw`
        INSERT INTO b_order_workflow_step_configs (
          template_id, code, name, parent_code, step_kind, sort_order, is_required,
          is_repeatable, activation_mode, trigger_event_code, status
        ) VALUES (
          ${templateId}, ${step.code}, ${step.name}, ${step.parentCode ?? null}, ${step.kind ?? 'step'},
          ${step.sortOrder}, ${step.isRequired ?? true}, ${step.isRepeatable ?? false},
          ${step.activationMode ?? 'initial'}, ${step.triggerEventCode ?? null}, 'active'
        ) ON CONFLICT (template_id, code) DO NOTHING
      `
    }
  }
}
