/**
 * 管理后台（admin-web）专用 REST + WS 路由。
 *
 * 设计要点（见 docs/寰宇医道_管理后台设计.md §6/§7）：
 * - 全部挂在 /api/v1/admin/* 下，与员工端 API 完全隔离。
 * - 独立鉴权：POST /login 用 ADMIN_PASSWORD 校验 → 签 JWT(HS256, 12h) → httpOnly cookie。
 *   后续所有 /api/v1/admin/* 都要这个 cookie，缺失/失效一律 401。
 * - 管理后台默认只读；服务步骤配置是经校验后允许维护的业务配置。
 * - 大列表一律 keyset 游标分页（按 (createdAt, id) 倒序），不用 offset。
 *
 * 注意：员工端的全局鉴权 hook（routes/api.ts）已放行 /api/v1/admin 前缀，
 * 这里通过本插件作用域内的 preHandler 自行做管理员鉴权。
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { Prisma, PrismaClient } from '@prisma/client'
import * as Minio from 'minio'
import jwt from 'jsonwebtoken'
import { existsSync, statSync, createWriteStream, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import os from 'node:os'
import { activeConnections, mobileSeenMap, presenceMap, trayRestSeenMap } from './api.js'
import { getEnv } from '../env.js'
import { getRecordingPlaybackInfo } from '../audioTranscode.js'
import {
  ORDER_AI_FIELD_DEFINITIONS,
  ORDER_AI_FIELD_PROMPT_VERSION,
  ORDER_AI_OUTPUT_DESCRIPTION,
  ORDER_AI_PROMPT_INPUTS,
  ORDER_AI_PROMPT_RULES
} from '../llm/orderAiExtraction.js'

export const ADMIN_COOKIE = 'hyyd_admin'
const JWT_EXPIRES_IN = '12h'

function getJwtSecret(): string {
  return getEnv().adminJwtSecret
}

// 校验管理员 JWT（给 /ws/admin 握手用）。无效返回 false。
export function verifyAdminToken(token: string | undefined): boolean {
  if (!token) return false
  try {
    jwt.verify(token, getJwtSecret())
    return true
  } catch {
    return false
  }
}

// 把 Date 安全转 ISO；null 透传。
function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

function parseAdminDateParam(value: unknown, label: string): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000+08:00`) : new Date(text)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} 非法`)
  }
  return date
}

function parseAdminEndDateParam(value: unknown, label: string): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000+08:00`)
    if (Number.isNaN(date.getTime())) throw new Error(`${label} 非法`)
    date.setDate(date.getDate() + 1)
    return date
  }
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} 非法`)
  return date
}

function parseBooleanFilter(value: unknown): boolean | null {
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

// 从订单的 rawJson / detailJson 里取"受理/申请号"（泰康 applyNo）。
function applyNoOf(o: { rawJson?: unknown; detailJson?: unknown }): string | null {
  return (
    (o.rawJson as any)?.applyNo ??
    (o.detailJson as any)?.recommendations?.applyNo ??
    null
  )
}

// 遍历某个 bucket，统计对象数与总占用字节。失败/异常返回 -1（前端显示"未知"）。
function bucketStat(
  client: Minio.Client,
  name: string
): Promise<{ objectCount: number; sizeBytes: number }> {
  return new Promise((resolve) => {
    let objectCount = 0
    let sizeBytes = 0
    try {
      const stream = client.listObjectsV2(name, '', true)
      stream.on('data', (o: any) => {
        objectCount++
        sizeBytes += o.size || 0
      })
      stream.on('end', () => resolve({ objectCount, sizeBytes }))
      stream.on('error', () => resolve({ objectCount: -1, sizeBytes: -1 }))
    } catch {
      resolve({ objectCount: -1, sizeBytes: -1 })
    }
  })
}

// 今天 0 点（服务器本地时区）。统计"今日"口径用。
function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

// presence 是否新鲜（30s 内有 ext WS 心跳算在线）
const PRESENCE_FRESH_MS = 30_000
function presenceIsFresh(lastSeenAt: number): boolean {
  return Date.now() - lastSeenAt < PRESENCE_FRESH_MS
}

// Tray 桌面端是否在线：靠 /me/presence REST 心跳，90s 内有一次就算在线。
const TRAY_FRESH_MS = 90_000
function trayInfo(employeeId: number): { online: boolean; lastSeenAt: string | null } {
  const ts = trayRestSeenMap.get(employeeId)
  return {
    online: ts ? Date.now() - ts < TRAY_FRESH_MS : false,
    lastSeenAt: ts ? new Date(ts).toISOString() : null
  }
}

const MOBILE_ACTIVE_WINDOW_MS = 2 * 60_000
const MOBILE_BACKGROUND_WINDOW_MS = 30 * 60_000
function mobileInfo(employeeId: number): {
  online: boolean
  state: 'active' | 'background' | 'needs_open'
  lastSeenAt: string | null
  source: string | null
} {
  const seen = mobileSeenMap.get(employeeId)
  const age = seen ? Date.now() - seen.lastSeenAt : Number.POSITIVE_INFINITY
  const workerHeartbeat = seen?.source === 'work_manager'
  const state =
    age <= MOBILE_ACTIVE_WINDOW_MS && !workerHeartbeat
      ? 'active'
      : age <= MOBILE_BACKGROUND_WINDOW_MS
        ? 'background'
        : 'needs_open'
  return {
    online: state !== 'needs_open',
    state,
    lastSeenAt: seen ? new Date(seen.lastSeenAt).toISOString() : null,
    source: seen?.source ?? null
  }
}

// 员工综合在线 = Chrome 插件 WS 活跃 或 Tray REST 心跳活跃 或移动端近期活跃。
function employeeIsOnline(employeeId: number): boolean {
  const info = presenceMap.get(employeeId)
  const extFresh = info ? presenceIsFresh(info.lastSeenAt) : false
  return extFresh || trayInfo(employeeId).online || mobileInfo(employeeId).online
}

// 列表分页统一页大小（≤ 50，符合验收要求）
const PAGE_SIZE = 50

// keyset 游标编解码：以 (时间戳ms, id) 为锚点，base64url 编码。
function encodeCursor(at: Date, id: number): string {
  return Buffer.from(`${at.getTime()}_${id}`).toString('base64url')
}
function decodeCursor(c: unknown): { ms: number; id: number } | null {
  if (typeof c !== 'string' || !c) return null
  try {
    const [ms, id] = Buffer.from(c, 'base64url').toString().split('_')
    const msN = Number(ms)
    const idN = Number(id)
    if (!Number.isFinite(msN) || !Number.isFinite(idN)) return null
    return { ms: msN, id: idN }
  } catch {
    return null
  }
}

// 生成按 (timeField desc, id desc) 的 keyset where 片段。
function keysetWhere(
  timeField: 'createdAt' | 'startedAt' | 'capturedAt',
  cursor: { ms: number; id: number } | null
): any {
  if (!cursor) return {}
  const d = new Date(cursor.ms)
  return {
    OR: [{ [timeField]: { lt: d } }, { [timeField]: d, id: { lt: cursor.id } }]
  }
}

export function registerAdminRoutes(
  rootFastify: FastifyInstance,
  prisma: PrismaClient,
  minioClient: Minio.Client,
  minioPublicClient: Minio.Client
): void {
  // 用一个封装插件作用域，保证这里加的 preHandler 只作用于 admin 路由。
  rootFastify.register(async (fastify: FastifyInstance) => {
    // ───── 管理员鉴权 preHandler ─────
    fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      // 登录接口本身不需要鉴权
      if (request.url === '/api/v1/admin/login') return

      const token = (request.cookies as Record<string, string> | undefined)?.[ADMIN_COOKIE]
      if (!token) {
        reply.status(401).send({ error: '未登录' })
        return
      }
      try {
        jwt.verify(token, getJwtSecret())
      } catch {
        reply.status(401).send({ error: '登录已过期，请重新登录' })
        return
      }
    })

    // ───── 1. 登录 / 登出 / 当前管理员 ─────
    fastify.post('/api/v1/admin/login', async (request, reply) => {
      const body = (request.body ?? {}) as { password?: string }
      const expected = getEnv().adminPassword
      if (!body.password || body.password !== expected) {
        return reply.status(401).send({ error: '密码错误' })
      }
      const token = jwt.sign({ role: 'admin' }, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN })
      reply.setCookie(ADMIN_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 12 * 60 * 60 // 12h，单位秒
      })
      return reply.send({ data: { ok: true } })
    })

    fastify.post('/api/v1/admin/logout', async (_request, reply) => {
      reply.clearCookie(ADMIN_COOKIE, { path: '/' })
      return reply.send({ data: { ok: true } })
    })

    fastify.get('/api/v1/admin/me', async (_request, reply) => {
      // 能走到这里说明 preHandler 已验证通过
      return reply.send({ data: { role: 'admin' } })
    })

    // 订单 AI 分析配置说明：内容直接由实际提取器导出，避免后台说明与运行规则不一致。
    fastify.get('/api/v1/admin/order-ai-config', async (_request, reply) => {
      const rawTimes = getEnv().orderAiAnalysisTimes ?? '12:00,18:00'
      const times = rawTimes.split(',').map((item) => item.trim()).filter(Boolean)
      return reply.send({
        data: {
          schedule: {
            timeZone: 'Asia/Shanghai（上海时区）',
            times: times.length > 0 ? times : ['12:00', '18:00'],
            setting: 'ORDER_AI_ANALYSIS_TIMES',
            condition: '仅在时点到达且订单自上次分析后存在新的企微消息、微信消息或已完成转写的通话录音时调用；不会因静默、消息条数或转写完成即时自动调用。',
            scope: '沟通记录按申请号聚合；每张订单按自己的服务类型与字段白名单独立分析。页面手动调用入口保留。'
          },
          prompt: {
            version: ORDER_AI_FIELD_PROMPT_VERSION,
            rules: ORDER_AI_PROMPT_RULES,
            inputs: ORDER_AI_PROMPT_INPUTS,
            output: ORDER_AI_OUTPUT_DESCRIPTION
          },
          fields: ORDER_AI_FIELD_DEFINITIONS.map((field) => ({
            code: field.code,
            label: field.label,
            serviceTypes: field.services ?? ['全部服务类型'],
            requiresConfirmation: field.requiresConfirmation === true
          })),
          readRules: [
            'B 端订单与寰宇订单页面均优先展示对应本地 PostgreSQL 正式字段值。',
            '正式字段为空时，页面才可展示本订单最新、待处理的 AI 字段候选值；正式字段已有值时不再用 AI 值覆盖展示。',
            '人工保存后写回本地 PostgreSQL 正式字段，并把对应候选标记为 adopted；之后只展示正式字段值。',
            'change_candidate 与 ambiguous 仅提示人工复核，不自动覆盖正式字段，也不自动推进步骤。',
            '仅字段提取器返回且有明确证据的 workflow_events 可以尝试推进服务步骤；金额、诊断、ICD10 始终需要人工确认。'
          ],
          storage: [
            {
              table: 'b_order_ai_analysis_runs',
              purpose: '一轮订单 AI 分析的批次与可追溯原始结果。',
              fields: 'order_id、application_no、model、prompt_version、status、三类来源水位、raw_result_json、error_message、created_at、completed_at'
            },
            {
              table: 'b_order_ai_field_candidates',
              purpose: 'AI 从该订单沟通中提取的待采纳字段候选值，不直接写正式业务字段。',
              fields: 'run_id、order_id、field_code、field_label、value_text、normalized_value_json、candidate_type、confidence、requires_confirmation、evidence_json、status、adopted_at、adopted_by_employee_id'
            },
            {
              table: 'b_order_huanyu_push_logs',
              purpose: '每次人工确认推送寰宇 MySQL 的成功/失败审计记录。',
              fields: 'order_id、huanyu_order_no、status、message、pushed_by_employee_id、created_at'
            }
          ],
          huanyuPush: {
            action: '寰宇订单页点击“确认推送寰宇订单信息”后才执行，绝不由 AI 分析或保存表单自动触发。',
            target: '远端 MySQL：HY_FACT_DDCX_NEW、fact_hy_pzrxx、hy_d_tp 三张同名寰宇订单表；以本地 PostgreSQL 当前正式快照为来源。',
            notices: [
              '推送前请先核对并保存页面上的正式字段；AI 候选仅供补全和人工确认。',
              'MySQL 写库须配置 HUANYU_PUSH_DB_HOST、HUANYU_PUSH_DB_PORT、HUANYU_PUSH_DB_NAME、HUANYU_PUSH_DB_USER、HUANYU_PUSH_DB_PASSWORD；未单独配置时兼容回退 REMOTE_DICT_DB_*。',
              '生产环境应使用仅允许写入这三张表的最小权限 MySQL 账号；失败后可在页面再次确认重试，结果会写入推送审计表。'
            ]
          }
        }
      })
    })

    // 系统提醒规则与说明：集中汇总定时任务、业务触发条件、客户端通知与防重机制。
    fastify.get('/api/v1/admin/system-reminder-config', async (_request, reply) => {
      return reply.send({
        data: {
          schedule: {
            timeZone: '上海时区（中国标准时间）',
            scanInterval: '系统后台常驻实时扫描（每 30 秒轮询）',
            table: 'order_reminders',
            dailyUploadTimes: ['11:30', '17:30'],
            dailyUploadDescription: '每天上午 11:30 与下午 17:30，系统自动向所有在岗服务人员推送提醒，督促在上下班前后及时在手机端 App 上传通话录音与通话记录。'
          },
          rules: [
            {
              category: '日常提醒',
              name: '通话录音与通话记录上传提醒',
              trigger: '每天 11:30、17:30 两次固定时点到达时自动扫描触发',
              target: '所有在岗服务人员',
              content: '提醒内容: 请打开手机app上传通话录音和通话记录',
              technicalConditions: [
                '匹配当前上海时间处于 11:30~12:00（上午批次 1130）或 17:30~18:00（下午批次 1730）',
                '扫描员工表 employee 中所有启用状态（enabled = 1）的服务人员',
                '为每位在岗员工批量写入 order_no 为 "SYSTEM" 的广播型提醒记录'
              ],
              dedupeRule: '基于 auto:call_upload_reminder:{employeeId}:{YYYY-MM-DD}:{slot} 去重，每位员工在当天同一批次时段内仅推送 1 次。'
            },
            {
              category: '约住院服务',
              name: '约住院排队跟进提醒',
              trigger: '约住院服务进行中，自步骤激活起每满 3 天上午 09:00',
              target: '订单责任客户经理',
              content: '订单号: COD202609150012\n申请时间: 2026-09-14 09:30:00\n提醒内容: 客户意向的住院时间前还没有预约成功，请关注！',
              technicalConditions: [
                '步骤表 b_order_service_steps 中匹配步骤编码 step_code = "hospital_booking"',
                '步骤状态处于待处理 pending 或进行中 in_progress',
                '订单未被取消（status NOT LIKE "%取消%"）且未完结（status != "已完成"）',
                '计算步骤激活时间差 (当前时间 - 激活时间) >= 3 天，且天数满足 3 的倍数（每满 3 天）',
                '当前时间达到上午 09:00 后触发'
              ],
              dedupeRule: '基于 auto:hospital_booking:{sourceOrderNo}:{YYYY-MM-DD} 去重，同一订单在满足周期的当天仅生成 1 次提醒。'
            },
            {
              category: '陪诊服务',
              name: '陪诊未指派人员超时预警',
              trigger: '前置步骤完成满 1 小时仍未指派陪诊员',
              target: '订单责任客户经理',
              content: '订单号: COD202609170038\n申请时间: 2026-09-17 10:15:00\n提醒内容: 陪诊人员没有落实，请关注！',
              technicalConditions: [
                '前置步骤（挂号 registration / 检查预约 check_booking / 约住院 hospital_booking）状态为已完成 completed',
                '前置步骤完成时间 completed_at 满足已满 1 小时（completed_at <= now - 1 hour）且在 3 天内',
                '检查寰宇订单表 HY_FACT_DDCX_NEW.PZR 为空，且陪诊人员关联表 fact_hy_pzrxx 无对应派单记录',
                '订单关联的责任客户经理 assigned_employee_id 存在且订单未取消/未完结'
              ],
              dedupeRule: '基于 auto:escort_unassigned:{sourceOrderNo} 去重，同一订单在未指派状态下全局仅告警 1 次。'
            },
            {
              category: '陪诊服务',
              name: '陪诊前一天出工未反馈预警',
              trigger: '次日就诊的陪诊订单，前一天 11:00 发出通知，截至 13:00 仍未收到出工反馈',
              target: '订单责任客户经理',
              content: '订单号: COD202609170056\n申请时间: 2026-09-16 14:20:00\n提醒内容: 陪诊人员没有第一次反馈信息，请关注！',
              technicalConditions: [
                '订单服务日期（BBQ_FW 或 DATE_FW）等于次日（tomorrow）',
                '陪诊人员（PZR）已指派落实，前一天 11:00 系统已发送确认短信',
                '当前时间到达 13:00（hours >= 13）',
                '在陪诊反馈表 fact_hy_pzfk（feedback_type = "pre_day"）与原系统反馈表中均未查询到反馈确认记录'
              ],
              dedupeRule: '基于 auto:escort_prev_day_unack:{sourceOrderNo}:{YYYY-MM-DD} 去重，同一订单在就诊前一天 13:00 仅触发 1 次。'
            },
            {
              category: '陪诊服务',
              name: '陪诊前一天拒绝出工报警',
              trigger: '次日就诊的陪诊订单，陪诊员在反馈中明确回复【无法出工】',
              target: '订单责任客户经理',
              content: '订单号: COD202609170072\n申请时间: 2026-09-16 16:40:00\n提醒内容: 陪诊人员反馈【无法出工】（原因：家中有急事无法出工），请立即处理！',
              technicalConditions: [
                '订单服务日期为次日（tomorrow）',
                '陪诊反馈表 fact_hy_pzfk 收到前一天反馈（feedback_type = "pre_day"）且出工意向为否（will_attend = false）',
                '提取反馈记录中的具体原因备注 remark，动态拼入告警文案'
              ],
              dedupeRule: '基于 auto:escort_pre_day_reject:{sourceOrderNo}:{YYYY-MM-DD} 去重，收到拒单反馈时立即生成报警。'
            },
            {
              category: '陪诊服务',
              name: '陪诊当天出工未反馈报警',
              trigger: '今日就诊的陪诊订单，当天 07:00 发出通知，截至 07:20 仍未收到出工打卡反馈',
              target: '订单责任客户经理',
              content: '订单号: COD202609170089\n申请时间: 2026-09-16 11:05:00\n提醒内容: 陪诊人员没有第一次反馈信息，请关注！',
              technicalConditions: [
                '订单服务日期等于当日（today）',
                '陪诊人员已指派落实，当天 07:00 系统已发送晨间确认通知',
                '当前时间到达 07:20（hours === 7 && minutes >= 20 或 hours > 7）',
                '在陪诊反馈表 fact_hy_pzfk（feedback_type = "same_day"）与原系统中均无出工反馈记录'
              ],
              dedupeRule: '基于 auto:escort_same_day_unack:{sourceOrderNo}:{YYYY-MM-DD} 去重，同一订单在就诊当天 07:20 仅触发 1 次。'
            },
            {
              category: '陪诊服务',
              name: '陪诊当天拒绝出工紧急报警',
              trigger: '今日就诊的陪诊订单，陪诊员当天反馈【无法出工】',
              target: '订单责任客户经理',
              content: '订单号: COD202609170095\n申请时间: 2026-09-16 18:30:00\n提醒内容: 陪诊人员当天反馈【无法出工】（原因：突发身体不适），请紧急处理！',
              technicalConditions: [
                '订单服务日期为当日（today）',
                '当天反馈表 fact_hy_pzfk 中收到当日打卡拒单（feedback_type = "same_day" 且 will_attend = false）',
                '最高优先级极速报警订单责任客户经理与现场督导'
              ],
              dedupeRule: '基于 auto:escort_same_day_reject:{sourceOrderNo}:{YYYY-MM-DD} 去重，收到当天拒单时即刻触发。'
            },
            {
              category: '住院陪护',
              name: '确认护工开始时间提醒',
              trigger: '客户入院后尚未确定护工进场时间，自激活起每满 2 天上午 09:00',
              target: '订单责任客户经理',
              content: '订单号: COD202609150041\n申请时间: 2026-09-15 08:50:00\n提醒内容: 客户处于住院期间，请定期关注客户满意度情况！',
              technicalConditions: [
                '服务类型为住院护工协助，订单处于未完结状态',
                '护工实际开始时间 care_start_time 仍为空（尚未确定）',
                '自服务步骤激活起天数差 >= 2 天且满足 2 的倍数（每满 2 天）',
                '当前时间达到上午 09:00 后触发'
              ],
              dedupeRule: '基于 auto:care_start_unassigned:{sourceOrderNo}:{YYYY-MM-DD} 去重，同一订单每 2 天在上午 09:00 仅提醒 1 次。'
            },
            {
              category: '住院陪护',
              name: '住院陪护结束前 2 工作日提醒',
              trigger: '护工服务结束日前 2 个工作日（自动扣除法定节假日与周末）上午 09:00',
              target: '订单责任客户经理',
              content: '订单号: COD202609100019\n申请时间: 2026-09-10 15:20:00\n提醒内容: 客户出院时间到了，请关注客户后续行程！',
              technicalConditions: [
                '获取订单护工服务结束日期 care_end_date',
                '调用中国工作日日历算法 subtractWorkdays(care_end_date, 2)，精准扣除法定节假日与调休周末',
                '当前日期达到该目标工作日且时间达到上午 09:00'
              ],
              dedupeRule: '基于 auto:care_end_notify:{sourceOrderNo} 去重，同一订单在结束前 2 工作日全局仅触发 1 次。'
            }
          ],
          clientNotification: {
            display: '电脑桌面右下角独立置顶悬浮弹窗（伴随清脆提示音，不被其他软件遮挡）',
            actions: [
              { name: '点击单号 / 一键复制', detail: '点击单号可直接在后台工作台定位到该订单；点击复制图标可快速复制单号。' },
              { name: '延迟 10 分钟', detail: '若员工正在通话或忙碌中，点击后系统将在 10 分钟后再次提醒。' },
              { name: '标记已完成', detail: '员工核实并处理完毕后点击，该提醒归档并自动关闭弹窗。' }
            ]
          },
          storage: {
            table: 'order_reminders',
            fields: 'id, order_no, employee_id, type, content, remind_time, status, extra_data, created_at, updated_at'
          }
        }
      })
    })

    // 服务步骤配置：订单新建时从已发布配置生成实例，配置的后续编辑不会改写历史订单实例。
    fastify.get('/api/v1/admin/workflow-templates', async (_request, reply) => {
      const templates = await prisma.$queryRaw<Array<{ id: bigint; code: string; version: number; name: string; service_type: string; description: string | null; status: string }>>`
        SELECT id, code, version, name, service_type, description, status
        FROM b_order_workflow_templates
        ORDER BY service_type ASC, version DESC
      `
      const steps = await prisma.$queryRaw<Array<{ id: bigint; template_id: bigint; code: string; name: string; parent_code: string | null; step_kind: string; sort_order: number; is_required: boolean; is_repeatable: boolean; activation_mode: string; trigger_event_code: string | null; status: string }>>`
        SELECT id, template_id, code, name, parent_code, step_kind, sort_order, is_required,
               is_repeatable, activation_mode, trigger_event_code, status
        FROM b_order_workflow_step_configs
        ORDER BY template_id, sort_order, id
      `
      return reply.send({ data: templates.map((template) => ({
        id: Number(template.id), code: template.code, version: template.version, name: template.name,
        serviceType: template.service_type, description: template.description, status: template.status,
        steps: steps.filter((step) => step.template_id === template.id).map((step) => ({
          id: Number(step.id), code: step.code, name: step.name, parentCode: step.parent_code,
          kind: step.step_kind, sortOrder: step.sort_order, required: step.is_required,
          repeatable: step.is_repeatable, activationMode: step.activation_mode,
          triggerEventCode: step.trigger_event_code, status: step.status
        }))
      })) })
    })

    fastify.put<{ Params: { id: string } }>('/api/v1/admin/workflow-templates/:id', async (request, reply) => {
      const templateId = Number(request.params.id)
      if (!Number.isInteger(templateId) || templateId <= 0) return reply.status(400).send({ error: '配置 ID 无效' })
      const body = (request.body ?? {}) as { name?: unknown; description?: unknown; steps?: unknown }
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const rawSteps = Array.isArray(body.steps) ? body.steps : null
      if (!name || !rawSteps?.length) return reply.status(400).send({ error: '配置名称和至少一个步骤不能为空' })
      const steps = rawSteps.map((raw, index) => {
        const step = (raw ?? {}) as Record<string, unknown>
        return {
          code: typeof step.code === 'string' ? step.code.trim() : '', name: typeof step.name === 'string' ? step.name.trim() : '',
          parentCode: typeof step.parentCode === 'string' && step.parentCode.trim() ? step.parentCode.trim() : null,
          kind: step.kind === 'package' ? 'package' : 'step', sortOrder: Number.isInteger(step.sortOrder) ? Number(step.sortOrder) : (index + 1) * 10,
          required: step.required !== false, repeatable: step.repeatable === true,
          activationMode: step.activationMode === 'event' ? 'event' : 'initial',
          triggerEventCode: typeof step.triggerEventCode === 'string' && step.triggerEventCode.trim() ? step.triggerEventCode.trim() : null,
          status: step.status === 'hidden' || step.status === 'retired' ? step.status : 'active'
        }
      })
      const codes = new Set<string>()
      for (const step of steps) {
        if (!/^[a-z][a-z0-9_]{1,79}$/.test(step.code) || !step.name) return reply.status(400).send({ error: '步骤编码须为小写英文、数字或下划线，且名称不能为空' })
        if (codes.has(step.code)) return reply.status(400).send({ error: `步骤编码重复：${step.code}` })
        if (step.activationMode === 'event' && !step.triggerEventCode) return reply.status(400).send({ error: `事件触发步骤“${step.name}”缺少触发事件` })
        codes.add(step.code)
      }
      for (const step of steps) if (step.parentCode && !codes.has(step.parentCode)) return reply.status(400).send({ error: `步骤“${step.name}”的父步骤不存在` })
      const description = typeof body.description === 'string' ? body.description.trim() || null : null
      try {
        await prisma.$transaction(async (tx) => {
          const changed = await tx.$executeRaw`UPDATE b_order_workflow_templates SET name = ${name}, description = ${description}, updated_at = now() WHERE id = ${templateId} AND status = 'active'`
          if (changed === 0) throw new Error('未找到已发布的步骤配置')
          await tx.$executeRaw`DELETE FROM b_order_workflow_step_configs WHERE template_id = ${templateId}`
          for (const step of steps) await tx.$executeRaw`
            INSERT INTO b_order_workflow_step_configs (template_id, code, name, parent_code, step_kind, sort_order, is_required, is_repeatable, activation_mode, trigger_event_code, status)
            VALUES (${templateId}, ${step.code}, ${step.name}, ${step.parentCode}, ${step.kind}, ${step.sortOrder}, ${step.required}, ${step.repeatable}, ${step.activationMode}, ${step.triggerEventCode}, ${step.status})
          `
        })
        return reply.send({ data: { ok: true } })
      } catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : '保存步骤配置失败' })
      }
    })

    // ───── 2. 仪表盘 ─────

    // 2.1 顶部指标卡片 + 当日统计
    fastify.get('/api/v1/admin/dashboard/summary', async (_request, reply) => {
      try {
        const today = startOfToday()

        const [
          ordersTodayRaw,
          materialsToday,
          callsToday,
          callsTodayDone,
          totalEmployees,
          messagesToday,
          unmatchedPending
        ] = await Promise.all([
          // 今日新增订单（按 poolType 分挂号/绿通，poolType 在 rawJson 里）
          prisma.order.findMany({
            where: { createdAt: { gte: today } },
            select: { rawJson: true }
          }),
          prisma.material.groupBy({
            by: ['type'],
            where: { createdAt: { gte: today } },
            _count: { _all: true }
          }),
          prisma.call.count({ where: { startedAt: { gte: today } } }),
          prisma.call.count({ where: { startedAt: { gte: today }, asrStatus: 'done' } }),
          prisma.employee.count(),
          // 今日采集到的结构化聊天消息（按 capturedAt 口径），按 self/other 分
          prisma.message.groupBy({
            by: ['senderType'],
            where: { capturedAt: { gte: today } },
            _count: { _all: true }
          }),
          // 待确认订单号（采到了订单号但关联不上，跨员工 pending 总数）
          prisma.unmatchedOrderRef.count({ where: { status: 'pending' } })
        ])

        // 订单按 poolType 归类
        let orderRegister = 0
        let orderGeneral = 0
        for (const o of ordersTodayRaw) {
          const pool = (o.rawJson as any)?.poolType
          if (pool === 'register') orderRegister++
          else orderGeneral++
        }

        // 素材按 type 归类
        const materialByType: Record<string, number> = { text: 0, image: 0 }
        for (const row of materialsToday) {
          materialByType[row.type] = row._count._all
        }

        // 今日消息按发送方归类（self=坐席自己发 / other=客户 / system=系统提示）
        let msgSelf = 0
        let msgOther = 0
        let msgTotal = 0
        for (const row of messagesToday) {
          const n = row._count._all
          msgTotal += n
          if (row.senderType === 'self') msgSelf += n
          else if (row.senderType === 'other') msgOther += n
        }

        // 在线员工：Chrome 插件 WS 活跃 或 Tray REST 心跳活跃（取并集）
        const onlineIds = new Set<number>()
        for (const [eid, info] of presenceMap.entries()) {
          if (presenceIsFresh(info.lastSeenAt)) onlineIds.add(eid)
        }
        for (const eid of trayRestSeenMap.keys()) {
          if (trayInfo(eid).online) onlineIds.add(eid)
        }
        const onlineEmployees = onlineIds.size

        return reply.send({
          data: {
            orders: {
              total: orderRegister + orderGeneral,
              register: orderRegister,
              general: orderGeneral
            },
            materials: {
              total: (materialByType.text || 0) + (materialByType.image || 0),
              text: materialByType.text || 0,
              image: materialByType.image || 0
            },
            calls: {
              total: callsToday,
              done: callsTodayDone,
              doneRate: callsToday ? Math.round((callsTodayDone / callsToday) * 100) : 0
            },
            employees: {
              online: onlineEmployees,
              total: totalEmployees
            },
            messages: {
              total: msgTotal,
              self: msgSelf,
              other: msgOther
            },
            unmatchedPending
          }
        })
      } catch (err: any) {
        rootFastify.log.error('admin summary 失败:', err)
        return reply.status(500).send({ error: '仪表盘统计失败: ' + err.message })
      }
    })

    // 2.2 近 N 天时序（每日素材量分 type + 每日订单量）
    fastify.get('/api/v1/admin/dashboard/timeseries', async (request, reply) => {
      try {
        const days = Math.min(Math.max(parseInt((request.query as any)?.days ?? '7', 10) || 7, 1), 30)
        const since = new Date()
        since.setHours(0, 0, 0, 0)
        since.setDate(since.getDate() - (days - 1))

        const [materials, orders] = await Promise.all([
          prisma.material.findMany({
            where: { createdAt: { gte: since } },
            select: { type: true, createdAt: true }
          }),
          prisma.order.findMany({
            where: { createdAt: { gte: since } },
            select: { createdAt: true, rawJson: true }
          })
        ])

        // 预生成 days 个桶
        const buckets: Record<string, { date: string; text: number; image: number; orders: number }> = {}
        const dayKeys: string[] = []
        for (let i = 0; i < days; i++) {
          const d = new Date(since)
          d.setDate(since.getDate() + i)
          const key = d.toISOString().slice(0, 10)
          dayKeys.push(key)
          buckets[key] = { date: key, text: 0, image: 0, orders: 0 }
        }
        const keyOf = (d: Date): string => d.toISOString().slice(0, 10)

        for (const m of materials) {
          const b = buckets[keyOf(m.createdAt)]
          if (!b) continue
          if (m.type === 'image') b.image++
          else b.text++
        }
        for (const o of orders) {
          const b = buckets[keyOf(o.createdAt)]
          if (b) b.orders++
        }

        return reply.send({ data: dayKeys.map((k) => buckets[k]) })
      } catch (err: any) {
        rootFastify.log.error('admin timeseries 失败:', err)
        return reply.status(500).send({ error: '时序统计失败: ' + err.message })
      }
    })

    // 2.3 当前告警
    fastify.get('/api/v1/admin/dashboard/alerts', async (_request, reply) => {
      try {
        const employees = await prisma.employee.findMany({
          select: { id: true, name: true, token: true }
        })
        const nameOf = new Map(employees.map((e) => [e.id, e.name]))

        const alerts: Array<{
          level: 'red' | 'yellow'
          kind: string
          message: string
          employeeId?: number
        }> = []

        // 红：泰康 token 失效（presenceMap.tokenOk === false）
        for (const [empId, info] of presenceMap.entries()) {
          if (info.tokenOk === false) {
            alerts.push({
              level: 'red',
              kind: 'token_invalid',
              message: `员工「${nameOf.get(empId) ?? empId}」泰康 token 失效${info.tokenReason ? '：' + info.tokenReason : ''}`,
              employeeId: empId
            })
          }
        }

        // 静默告警：按"消息 + 素材"两类各取最近一次采集时间，合成"最近活跃时间"。
        // 区分两种性质：
        //   · 在线但近 ONLINE_STALE 分钟无任何新采集 → 红（采集疑似卡住，比离线更可疑）
        //   · 离线且 ≥ OFFLINE_SILENCE 小时无新采集 → 黄（员工多半下班/离线，提醒即可）
        const ONLINE_STALE_MIN = 30
        const OFFLINE_SILENCE_HOURS = 6
        const onlineStaleSince = new Date(Date.now() - ONLINE_STALE_MIN * 60_000)
        const offlineSilenceSince = new Date(Date.now() - OFFLINE_SILENCE_HOURS * 3600_000)

        const [lastMaterialByEmp, lastMessageByEmp] = await Promise.all([
          prisma.material.groupBy({ by: ['employeeId'], _max: { createdAt: true } }),
          prisma.message.groupBy({ by: ['employeeId'], _max: { capturedAt: true } })
        ])
        // 合成每员工最近活跃时间（消息/素材取较新者）
        const lastActiveByEmp = new Map<number, Date>()
        const noteLatest = (eid: number, d: Date | null | undefined): void => {
          if (!d) return
          const cur = lastActiveByEmp.get(eid)
          if (!cur || d > cur) lastActiveByEmp.set(eid, d)
        }
        for (const r of lastMaterialByEmp) noteLatest(r.employeeId, r._max.createdAt)
        for (const r of lastMessageByEmp) noteLatest(r.employeeId, r._max.capturedAt)

        for (const [eid, last] of lastActiveByEmp.entries()) {
          const online = employeeIsOnline(eid)
          const name = nameOf.get(eid) ?? eid
          if (online && last < onlineStaleSince) {
            alerts.push({
              level: 'red',
              kind: 'online_stale',
              message: `员工「${name}」在线但近 ${ONLINE_STALE_MIN} 分钟无任何新采集（疑似采集卡住）`,
              employeeId: eid
            })
          } else if (!online && last < offlineSilenceSince) {
            const hours = Math.floor((Date.now() - last.getTime()) / 3600_000)
            alerts.push({
              level: 'yellow',
              kind: 'offline_silence',
              message: `员工「${name}」已离线，约 ${hours} 小时无新采集`,
              employeeId: eid
            })
          }
        }

        // 黄：待确认订单号（采到订单号但关联不上，需人工/客户确认绑定）
        const unmatchedPending = await prisma.unmatchedOrderRef.count({ where: { status: 'pending' } })
        if (unmatchedPending > 0) {
          alerts.push({
            level: 'yellow',
            kind: 'unmatched_refs',
            message: `有 ${unmatchedPending} 条订单号待确认（判为客户会话但未关联到订单）`
          })
        }

        // 黄：asrStatus=failed 的通话数
        const asrFailed = await prisma.call.count({ where: { asrStatus: 'failed' } })
        if (asrFailed > 0) {
          alerts.push({
            level: 'yellow',
            kind: 'asr_failed',
            message: `有 ${asrFailed} 条通话转写失败（asrStatus=failed）`
          })
        }

        return reply.send({ data: alerts })
      } catch (err: any) {
        rootFastify.log.error('admin alerts 失败:', err)
        return reply.status(500).send({ error: '告警查询失败: ' + err.message })
      }
    })

    // ───── 3. 员工 ─────

    // 3.1 员工列表 + 统计
    fastify.get('/api/v1/admin/employees', async (_request, reply) => {
      try {
        const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000)

        const employees = await prisma.employee.findMany({
          select: { id: true, name: true, token: true, phone: true },
          orderBy: { id: 'asc' }
        })

        // 聚合各类计数（一次性 groupBy，避免 N+1）
        const [orderCounts, weekOrderCounts, materialCounts, lastMaterial, callCounts, callDone, callFailed] =
          await Promise.all([
            prisma.order.groupBy({ by: ['assignedEmployeeId'], _count: { _all: true } }),
            prisma.order.groupBy({
              by: ['assignedEmployeeId'],
              where: { createdAt: { gte: weekAgo } },
              _count: { _all: true }
            }),
            prisma.material.groupBy({ by: ['employeeId', 'type'], _count: { _all: true } }),
            prisma.material.groupBy({ by: ['employeeId'], _max: { createdAt: true } }),
            prisma.call.groupBy({ by: ['employeeId'], _count: { _all: true } }),
            prisma.call.groupBy({
              by: ['employeeId'],
              where: { asrStatus: 'done' },
              _count: { _all: true }
            }),
            prisma.call.groupBy({
              by: ['employeeId'],
              where: { asrStatus: 'failed' },
              _count: { _all: true }
            })
          ])

        const orderMap = new Map(orderCounts.map((r) => [r.assignedEmployeeId, r._count._all]))
        const weekOrderMap = new Map(weekOrderCounts.map((r) => [r.assignedEmployeeId, r._count._all]))
        const lastMaterialMap = new Map(lastMaterial.map((r) => [r.employeeId, r._max.createdAt]))
        const callMap = new Map(callCounts.map((r) => [r.employeeId, r._count._all]))
        const callDoneMap = new Map(callDone.map((r) => [r.employeeId, r._count._all]))
        const callFailedMap = new Map(callFailed.map((r) => [r.employeeId, r._count._all]))
        const matTextMap = new Map<number, number>()
        const matImageMap = new Map<number, number>()
        for (const r of materialCounts) {
          if (r.type === 'image') matImageMap.set(r.employeeId, r._count._all)
          else matTextMap.set(r.employeeId, (matTextMap.get(r.employeeId) ?? 0) + r._count._all)
        }

        const data = employees.map((e) => {
          const info = presenceMap.get(e.id)
          const conn = activeConnections.get(e.id)
          const tray = trayInfo(e.id)
          return {
            id: e.id,
            name: e.name,
            token: e.token,
            phone: e.phone,
            online: employeeIsOnline(e.id),
            // ext = Chrome 插件 WS；tray = 桌面端 REST 心跳（无 WS，靠 /me/presence 轮询）
            clients: { ext: !!conn?.ext, tray: tray.online },
            lastSeenAt: info ? new Date(info.lastSeenAt).toISOString() : null,
            tokenOk: info?.tokenOk ?? null,
            tokenLastCheckAt: info?.tokenLastCheckAt ? new Date(info.tokenLastCheckAt).toISOString() : null,
            orderCount: orderMap.get(e.id) ?? 0,
            weekOrderCount: weekOrderMap.get(e.id) ?? 0,
            materialText: matTextMap.get(e.id) ?? 0,
            materialImage: matImageMap.get(e.id) ?? 0,
            lastMaterialAt: iso(lastMaterialMap.get(e.id) ?? null),
            callCount: callMap.get(e.id) ?? 0,
            callDone: callDoneMap.get(e.id) ?? 0,
            callFailed: callFailedMap.get(e.id) ?? 0
          }
        })

        return reply.send({ data })
      } catch (err: any) {
        rootFastify.log.error('admin employees 失败:', err)
        return reply.status(500).send({ error: '员工列表查询失败: ' + err.message })
      }
    })

    // presigned URL 助手（1h 过期，对外用 public 客户端）
    const presign = (bucket: string, key: string): Promise<string> =>
      minioPublicClient.presignedGetObject(bucket, key, 60 * 60)

    // ───── 采集诊断图片 ─────
    fastify.get('/api/v1/admin/capture-diagnostic-images', async (_request, reply) => {
      try {
        const objects = await new Promise<any[]>((resolve, reject) => {
          const rows: any[] = []
          const stream = minioClient.listObjectsV2('capture-diagnostics', 'capture-diagnostics/', true)
          stream.on('data', (object) => rows.push(object))
          stream.on('end', () => resolve(rows))
          stream.on('error', reject)
        })
        const data = await Promise.all(objects.map(async (object) => {
          const key = String(object.name ?? '')
          const match = key.match(/^capture-diagnostics\/emp-(\d+)__app-(.+?)__at-(\d{17})__channel-([^_]+)__conv-(.+?)__[^/]+\.(png|jpg|jpeg|bmp|webp)$/i)
          if (!match) return null
          const capturedAt = parseDiagnosticTimestamp(match[3])
          return {
            objectKey: key,
            employee: { id: Number(match[1]), name: String(match[1]) },
            applicationNo: decodeURIComponent(match[2]),
            channel: match[4],
            conversationName: decodeURIComponent(match[5]),
            capturedAt: capturedAt.toISOString(),
            createdAt: object.lastModified instanceof Date ? object.lastModified.toISOString() : new Date(object.lastModified).toISOString(),
            byteSize: Number(object.size ?? 0),
            imageUrl: await presign('capture-diagnostics', key).catch(() => null)
          }
        }))
        data.sort((a, b) => (a && b ? b.capturedAt.localeCompare(a.capturedAt) : a ? -1 : 1))
        return reply.send({ data: data.filter(Boolean) })
      } catch (err: any) {
        rootFastify.log.error('admin capture diagnostic images 失败:', err)
        return reply.status(500).send({ error: '诊断图片查询失败: ' + err.message })
      }
    })

    fastify.delete<{ Params: { '*': string } }>('/api/v1/admin/capture-diagnostic-images/*', async (request, reply) => {
      const key = request.params['*']
      if (!key.startsWith('capture-diagnostics/')) return reply.status(400).send({ error: '图片路径非法' })
      try {
        await minioClient.removeObject('capture-diagnostics', key)
        return reply.send({ data: { ok: true } })
      } catch (err: any) {
        rootFastify.log.error('admin capture diagnostic image 删除失败:', err)
        return reply.status(500).send({ error: '诊断图片删除失败: ' + err.message })
      }
    })

    function parseDiagnosticTimestamp(value: string): Date {
      const year = Number(value.slice(0, 4))
      const month = Number(value.slice(4, 6))
      const day = Number(value.slice(6, 8))
      const hour = Number(value.slice(8, 10))
      const minute = Number(value.slice(10, 12))
      const second = Number(value.slice(12, 14))
      const millis = Number(value.slice(14, 17))
      const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis))
      if (Number.isNaN(date.getTime())) throw new Error('诊断图片文件名时间非法')
      return date
    }

    // 把一条 material 序列化给前端：文本截断 300 字，图片附 presigned URL。
    const serializeMaterial = async (m: {
      id: number
      orderId: number
      employeeId: number
      type: string
      textContent: string | null
      minioBucket: string | null
      minioKey: string | null
      mimeType: string | null
      byteSize: number | null
      createdAt: Date
    }): Promise<any> => {
      const isImage = m.type === 'image'
      let imageUrl: string | null = null
      if (isImage && m.minioBucket && m.minioKey) {
        imageUrl = await presign(m.minioBucket, m.minioKey).catch(() => null)
      }
      const full = m.textContent ?? ''
      return {
        id: m.id,
        orderId: m.orderId,
        employeeId: m.employeeId,
        type: m.type,
        textPreview: isImage ? null : full.slice(0, 300),
        textTruncated: !isImage && full.length > 300,
        imageUrl,
        mimeType: m.mimeType,
        byteSize: m.byteSize,
        createdAt: m.createdAt.toISOString()
      }
    }

    // ───── 3.2 员工详情卡片 ─────
    fastify.get('/api/v1/admin/employees/:id', async (request, reply) => {
      try {
        const id = parseInt((request.params as any).id, 10)
        if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })

        const emp = await prisma.employee.findUnique({
          where: { id },
          select: { id: true, name: true, token: true, phone: true }
        })
        if (!emp) return reply.status(404).send({ error: '员工不存在' })

        const [orderCount, materialAgg, callAgg, lastMaterial] = await Promise.all([
          prisma.order.count({ where: { assignedEmployeeId: id } }),
          prisma.material.groupBy({ by: ['type'], where: { employeeId: id }, _count: { _all: true } }),
          prisma.call.groupBy({ by: ['asrStatus'], where: { employeeId: id }, _count: { _all: true } }),
          prisma.material.findFirst({
            where: { employeeId: id },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true }
          })
        ])

        const materialByType: Record<string, number> = { text: 0, image: 0 }
        for (const r of materialAgg) materialByType[r.type] = r._count._all
        const callByStatus: Record<string, number> = {}
        let callTotal = 0
        for (const r of callAgg) {
          callByStatus[r.asrStatus] = r._count._all
          callTotal += r._count._all
        }

        const info = presenceMap.get(id)
        const conn = activeConnections.get(id)
        const tray = trayInfo(id)

        return reply.send({
          data: {
            id: emp.id,
            name: emp.name,
            token: emp.token,
            phone: emp.phone,
            presence: {
              online: employeeIsOnline(id),
              extConnected: !!conn?.ext,
              trayConnected: tray.online,
              trayLastSeenAt: tray.lastSeenAt,
              taikangTabOpen: info?.taikangTabOpen ?? false,
              lastSeenAt: info ? new Date(info.lastSeenAt).toISOString() : null,
              tokenOk: info?.tokenOk ?? null,
              tokenReason: info?.tokenReason ?? null,
              tokenLastCheckAt: info?.tokenLastCheckAt ? new Date(info.tokenLastCheckAt).toISOString() : null
            },
            stats: {
              orderCount,
              materialText: materialByType.text || 0,
              materialImage: materialByType.image || 0,
              lastMaterialAt: iso(lastMaterial?.createdAt ?? null),
              callTotal,
              callByStatus
            }
          }
        })
      } catch (err: any) {
        rootFastify.log.error('admin employee detail 失败:', err)
        return reply.status(500).send({ error: '员工详情查询失败: ' + err.message })
      }
    })

    // ───── 3.3 员工名下订单 ─────
    fastify.get('/api/v1/admin/employees/:id/orders', async (request, reply) => {
      try {
        const id = parseInt((request.params as any).id, 10)
        if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })
        const search = ((request.query as any)?.search ?? '').trim()

        const where: any = { assignedEmployeeId: id }
        if (search) {
          where.OR = [
            { sourceOrderNo: { contains: search } },
            { customerName: { contains: search } },
            { customerPhone: { contains: search } },
            { hospital: { contains: search } }
          ]
        }

        const orders = await prisma.order.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            sourceOrderNo: true,
            customerName: true,
            customerPhone: true,
            hospital: true,
            status: true,
            detailFetchedAt: true,
            createdAt: true,
            rawJson: true,
            _count: { select: { attachments: true, materials: true, calls: true } },
            materials: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 }
          }
        })

        const data = orders
          .map((o) => ({
            id: o.id,
            sourceOrderNo: o.sourceOrderNo,
            customerName: o.customerName,
            customerPhone: o.customerPhone,
            hospital: o.hospital,
            status: o.status,
            poolType: (o.rawJson as any)?.poolType ?? null,
            detailFetchedAt: iso(o.detailFetchedAt),
            attachmentCount: o._count.attachments,
            materialCount: o._count.materials,
            callCount: o._count.calls,
            lastMaterialAt: iso(o.materials[0]?.createdAt ?? null),
            createdAt: o.createdAt.toISOString()
          }))
          // 默认按 lastMaterialAt 倒序（无素材的沉底，用 createdAt 兜底）
          .sort((a, b) => {
            const ta = a.lastMaterialAt ?? a.createdAt
            const tb = b.lastMaterialAt ?? b.createdAt
            return tb.localeCompare(ta)
          })

        return reply.send({ data })
      } catch (err: any) {
        rootFastify.log.error('admin employee orders 失败:', err)
        return reply.status(500).send({ error: '员工订单查询失败: ' + err.message })
      }
    })

    // ───── 3.4 员工素材流水（游标分页）─────
    fastify.get('/api/v1/admin/employees/:id/materials', async (request, reply) => {
      try {
        const id = parseInt((request.params as any).id, 10)
        if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })
        const cursor = decodeCursor((request.query as any)?.cursor)

        const rows = await prisma.material.findMany({
          where: { AND: [{ employeeId: id }, keysetWhere('createdAt', cursor)] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PAGE_SIZE + 1,
          include: { order: { select: { id: true, sourceOrderNo: true, customerName: true } } }
        })

        const hasMore = rows.length > PAGE_SIZE
        const page = rows.slice(0, PAGE_SIZE)
        const items = await Promise.all(
          page.map(async (m) => ({
            ...(await serializeMaterial(m)),
            order: m.order
          }))
        )
        const last = page[page.length - 1]
        return reply.send({
          data: { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null }
        })
      } catch (err: any) {
        rootFastify.log.error('admin employee materials 失败:', err)
        return reply.status(500).send({ error: '员工素材查询失败: ' + err.message })
      }
    })

    // ───── 3.4b 员工"有素材的订单"列表（素材页客户切换器用）─────
    // 把该员工的素材按订单聚合，带上客户名/电话/受理编号/素材数/最近时间，
    // 前端做"左边订单列表 + 右边该订单素材"的主从切换。
    fastify.get('/api/v1/admin/employees/:id/material-orders', async (request, reply) => {
      try {
        const id = parseInt((request.params as any).id, 10)
        if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })

        const grouped = await prisma.material.groupBy({
          by: ['orderId'],
          where: { employeeId: id },
          _count: { _all: true },
          _max: { createdAt: true }
        })
        if (grouped.length === 0) return reply.send({ data: [] })

        const orders = await prisma.order.findMany({
          where: { id: { in: grouped.map((g) => g.orderId) } },
          select: {
            id: true,
            sourceOrderNo: true,
            customerName: true,
            customerPhone: true,
            status: true,
            rawJson: true,
            detailJson: true
          }
        })
        const orderMap = new Map(orders.map((o) => [o.id, o]))

        const data = grouped
          .map((g) => {
            const o = orderMap.get(g.orderId)
            return {
              orderId: g.orderId,
              sourceOrderNo: o?.sourceOrderNo ?? String(g.orderId),
              applyNo: o ? applyNoOf(o) : null,
              customerName: o?.customerName ?? '未知',
              customerPhone: o?.customerPhone ?? null,
              status: o?.status ?? null,
              materialCount: g._count._all,
              lastMaterialAt: iso(g._max.createdAt ?? null)
            }
          })
          .sort((a, b) => (b.lastMaterialAt ?? '').localeCompare(a.lastMaterialAt ?? ''))

        return reply.send({ data })
      } catch (err: any) {
        rootFastify.log.error('admin material-orders 失败:', err)
        return reply.status(500).send({ error: '素材订单聚合查询失败: ' + err.message })
      }
    })

    // ───── 3.5 员工通话流水（游标分页）─────
    fastify.get('/api/v1/admin/employees/:id/calls', async (request, reply) => {
      try {
        const id = parseInt((request.params as any).id, 10)
        if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })
        const cursor = decodeCursor((request.query as any)?.cursor)

        const rows = await prisma.call.findMany({
          where: { AND: [{ employeeId: id }, keysetWhere('startedAt', cursor)] },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: PAGE_SIZE + 1,
          include: { order: { select: { id: true, sourceOrderNo: true, customerName: true } } }
        })

        const hasMore = rows.length > PAGE_SIZE
        const page = rows.slice(0, PAGE_SIZE)
        const applicationNos = Array.from(
          new Set(page.map((c) => c.applicationNo).filter((x): x is string => !!x))
        )
        const applicationOrders = applicationNos.length
          ? await prisma.order.findMany({
              where: {
                assignedEmployeeId: id,
                OR: applicationNos.map((applicationNo) => ({
                  rawJson: { path: ['crmApplyNo'], equals: applicationNo }
                }))
              },
              select: { id: true, sourceOrderNo: true, customerName: true, status: true, rawJson: true },
              orderBy: { updatedAt: 'desc' }
            })
          : []
        const ordersByApplicationNo = new Map<string, typeof applicationOrders>()
        for (const order of applicationOrders) {
          const applicationNo = (order.rawJson as any)?.crmApplyNo
          if (!applicationNo) continue
          const arr = ordersByApplicationNo.get(applicationNo) ?? []
          arr.push(order)
          ordersByApplicationNo.set(applicationNo, arr)
        }
        const items = page.map((c) => {
          const asrText = c.asrText ?? null
          const relatedOrders = c.applicationNo
            ? (ordersByApplicationNo.get(c.applicationNo) ?? []).map((o) => ({
                id: o.id,
                sourceOrderNo: o.sourceOrderNo,
                customerName: o.customerName,
                status: o.status
              }))
            : []
          return {
            id: c.id,
            phone: c.phone,
            contactName: c.contactName,
            direction: c.direction,
            callStatus: c.callStatus,
            durationSec: c.durationSec,
            startedAt: c.startedAt.toISOString(),
            applicationNo: c.applicationNo,
            asrStatus: c.asrStatus,
            asrText,
            asrTextPreview: asrText ? asrText.slice(0, 300) : null,
            asrTextTruncated: !!asrText && asrText.length > 300,
            hasRecording: !!c.recordingOssKey,
            order: c.order,
            applicationOrders: relatedOrders
          }
        })
        const last = page[page.length - 1]
        return reply.send({
          data: { items, nextCursor: hasMore && last ? encodeCursor(last.startedAt, last.id) : null }
        })
      } catch (err: any) {
        rootFastify.log.error('admin employee calls 失败:', err)
        return reply.status(500).send({ error: '员工通话查询失败: ' + err.message })
      }
    })

    async function orderIdsMatchingCaptureFilters(filters: {
      hasWechatMessage: boolean | null
      hasWxworkMessage: boolean | null
      hasRecording: boolean | null
    }): Promise<number[] | null> {
      const conditions: Prisma.Sql[] = []
      const messageExists = (channel: string) => Prisma.sql`
        EXISTS (
          SELECT 1
            FROM messages m
           WHERE (m.order_id = o.id OR (
             o.raw_json->>'crmApplyNo' IS NOT NULL
             AND m.application_no = o.raw_json->>'crmApplyNo'
           ))
             AND m.channel = ${channel}
        )
      `
      const recordingExists = Prisma.sql`
        EXISTS (
          SELECT 1
            FROM calls c
           WHERE (c.order_id = o.id OR (
             o.raw_json->>'crmApplyNo' IS NOT NULL
             AND c.application_no = o.raw_json->>'crmApplyNo'
           ))
             AND c.recording_oss_key IS NOT NULL
        )
      `

      if (filters.hasWechatMessage !== null) {
        const exists = messageExists('wechat')
        conditions.push(filters.hasWechatMessage ? exists : Prisma.sql`NOT ${exists}`)
      }
      if (filters.hasWxworkMessage !== null) {
        const exists = messageExists('wxwork')
        conditions.push(filters.hasWxworkMessage ? exists : Prisma.sql`NOT ${exists}`)
      }
      if (filters.hasRecording !== null) {
        conditions.push(filters.hasRecording ? recordingExists : Prisma.sql`NOT ${recordingExists}`)
      }
      if (conditions.length === 0) return null

      const rows = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT o.id
          FROM orders o
         WHERE ${Prisma.join(conditions, ' AND ')}
      `
      return rows.map((row) => row.id)
    }

    async function captureCountsForOrders(orderIds: number[]): Promise<Map<number, {
      wechatMessageCount: number
      wxworkMessageCount: number
      recordingCount: number
    }>> {
      if (orderIds.length === 0) return new Map()
      const rows = await prisma.$queryRaw<Array<{
        id: number
        wechat_message_count: bigint
        wxwork_message_count: bigint
        recording_count: bigint
      }>>`
        SELECT
          o.id,
          COUNT(DISTINCT m.id) FILTER (WHERE m.channel = 'wechat') AS wechat_message_count,
          COUNT(DISTINCT m.id) FILTER (WHERE m.channel = 'wxwork') AS wxwork_message_count,
          COUNT(DISTINCT c.id) FILTER (WHERE c.recording_oss_key IS NOT NULL) AS recording_count
        FROM orders o
        LEFT JOIN messages m
          ON (m.order_id = o.id OR (
            o.raw_json->>'crmApplyNo' IS NOT NULL
            AND m.application_no = o.raw_json->>'crmApplyNo'
          ))
        LEFT JOIN calls c
          ON (c.order_id = o.id OR (
            o.raw_json->>'crmApplyNo' IS NOT NULL
            AND c.application_no = o.raw_json->>'crmApplyNo'
          ))
        WHERE o.id IN (${Prisma.join(orderIds)})
        GROUP BY o.id
      `
      return new Map(rows.map((row) => [row.id, {
        wechatMessageCount: Number(row.wechat_message_count),
        wxworkMessageCount: Number(row.wxwork_message_count),
        recordingCount: Number(row.recording_count)
      }]))
    }

    // ───── 5. 订单浏览（游标分页 + 搜索 + 按员工筛）─────
    fastify.get('/api/v1/admin/orders', async (request, reply) => {
      try {
        const q = request.query as any
        const cursor = decodeCursor(q?.cursor)
        const search = (q?.search ?? '').trim()
        const employeeId = q?.employeeId ? parseInt(q.employeeId, 10) : null
        // poolType: 'register'(挂号) | 'general'(绿通)，存在 rawJson 里，用 Postgres JSON 过滤
        const poolType = q?.poolType === 'register' || q?.poolType === 'general' ? q.poolType : null
        const hasWechatMessage = parseBooleanFilter(q?.hasWechatMessage)
        const hasWxworkMessage = parseBooleanFilter(q?.hasWxworkMessage)
        const hasRecording = parseBooleanFilter(q?.hasRecording)
        const createdFrom = parseAdminDateParam(q?.createdFrom, '申领开始时间')
        const createdTo = parseAdminEndDateParam(q?.createdTo, '申领结束时间')

        const filters: any[] = [keysetWhere('createdAt', cursor)]
        if (Number.isFinite(employeeId)) filters.push({ assignedEmployeeId: employeeId })
        if (poolType) filters.push({ rawJson: { path: ['poolType'], equals: poolType } })
        if (createdFrom || createdTo) {
          filters.push({
            createdAt: {
              ...(createdFrom ? { gte: createdFrom } : {}),
              ...(createdTo ? { lt: createdTo } : {})
            }
          })
        }
        const captureOrderIds = await orderIdsMatchingCaptureFilters({ hasWechatMessage, hasWxworkMessage, hasRecording })
        if (captureOrderIds) {
          filters.push(captureOrderIds.length > 0 ? { id: { in: captureOrderIds } } : { id: -1 })
        }
        if (search) {
          filters.push({
            OR: [
              { sourceOrderNo: { contains: search } },
              { customerName: { contains: search } },
              { customerPhone: { contains: search } },
              { hospital: { contains: search } }
            ]
          })
        }

        const rows = await prisma.order.findMany({
          where: { AND: filters },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PAGE_SIZE + 1,
          select: {
            id: true,
            sourceOrderNo: true,
            customerName: true,
            customerPhone: true,
            hospital: true,
            status: true,
            detailFetchedAt: true,
            createdAt: true,
            rawJson: true,
            assignedEmployee: { select: { id: true, name: true } },
            _count: { select: { attachments: true, materials: true, calls: true } }
          }
        })

        const hasMore = rows.length > PAGE_SIZE
        const page = rows.slice(0, PAGE_SIZE)
        const captureCounts = await captureCountsForOrders(page.map((o) => o.id))
        const items = page.map((o) => ({
          id: o.id,
          sourceOrderNo: o.sourceOrderNo,
          customerName: o.customerName,
          customerPhone: o.customerPhone,
          hospital: o.hospital,
          status: o.status,
          poolType: (o.rawJson as any)?.poolType ?? null,
          detailFetchedAt: iso(o.detailFetchedAt),
          employee: o.assignedEmployee,
          attachmentCount: o._count.attachments,
          materialCount: o._count.materials,
          callCount: o._count.calls,
          wechatMessageCount: captureCounts.get(o.id)?.wechatMessageCount ?? 0,
          wxworkMessageCount: captureCounts.get(o.id)?.wxworkMessageCount ?? 0,
          recordingCount: captureCounts.get(o.id)?.recordingCount ?? 0,
          createdAt: o.createdAt.toISOString()
        }))
        const last = page[page.length - 1]
        return reply.send({
          data: { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null }
        })
      } catch (err: any) {
        rootFastify.log.error('admin orders 失败:', err)
        return reply.status(500).send({ error: '订单浏览查询失败: ' + err.message })
      }
    })

    // ───── 5.1 订单详情聚合（一次返回全部存留数据）─────
    fastify.get('/api/v1/admin/orders/:id/full', async (request, reply) => {
      try {
        const id = parseInt((request.params as any).id, 10)
        if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })

        const order = await prisma.order.findUnique({
          where: { id },
          include: {
            assignedEmployee: { select: { id: true, name: true, token: true } },
            attachments: { orderBy: { createdAt: 'asc' } },
            materials: { orderBy: { createdAt: 'desc' } },
            calls: { orderBy: { startedAt: 'desc' } },
            statusHistory: { orderBy: { recordedAt: 'asc' } }
          }
        })
        if (!order) return reply.status(404).send({ error: '订单不存在' })

        const attachments = await Promise.all(
          order.attachments.map(async (a) => ({
            id: a.id,
            fileType: a.fileType,
            fileName: a.fileName,
            mimeType: a.mimeType,
            byteSize: a.byteSize,
            url: await presign(a.minioBucket, a.minioKey).catch(() => null)
          }))
        )

        const materials = await Promise.all(order.materials.map((m) => serializeMaterial(m)))

        const rec = (order.detailJson as any)?.recommendations ?? null
        const applicationNo = (order.rawJson as any)?.crmApplyNo ?? null

        const orderCalls = await prisma.call.findMany({
          where: {
            OR: [
              { orderId: order.id },
              ...(applicationNo ? [{ applicationNo }] : [])
            ]
          },
          orderBy: { startedAt: 'desc' }
        })

        const calls = orderCalls.map((c) => ({
          id: c.id,
          phone: c.phone,
          contactName: c.contactName,
          direction: c.direction,
          callStatus: c.callStatus,
          durationSec: c.durationSec,
          startedAt: c.startedAt.toISOString(),
          asrStatus: c.asrStatus,
          asrText: c.asrText,
          hasRecording: !!c.recordingOssKey
        }))

        // 结构化聊天时间线：同一申请号可能拆成多张订单，消息按申请号共享展示。
        const orderMessages = await prisma.message.findMany({
          where: {
            OR: [
              { orderId: order.id },
              ...(applicationNo ? [{ applicationNo }] : [])
            ]
          },
          orderBy: [{ sortTime: 'asc' }, { id: 'asc' }],
          take: 1000
        })

        // 结构化消息时间线：self/other/system + 真实聊天时间(chatTime，算不出为 null) + 截图 presigned URL。
        const messages = await Promise.all(
          orderMessages.map(async (m) => ({
            id: m.id,
            channel: m.channel,
            conversationName: m.conversationName,
            senderName: m.senderName,
            senderType: m.senderType,
            kind: m.kind,
            contentText: m.contentText,
            chatTime: iso(m.chatTime),
            sortTime: iso(m.sortTime ?? m.capturedAt),
            capturedAt: m.capturedAt.toISOString(),
            seenCount: m.seenCount,
            screenshotUrl: m.screenshotOssKey
              ? await presign('screenshots', m.screenshotOssKey).catch(() => null)
              : null
          }))
        )

        // AI 滚动简报：整份简报 JSON + 水位时间。前端可直接展示摘要/阶段/待办/风险。
        const brief = {
          json: order.aiBriefJson ?? null,
          updatedAt: iso(order.briefUpdatedAt),
          lastMsgId: order.briefLastMsgId,
          lastCallId: order.briefLastCallId,
          lastMaterialId: order.briefLastMaterialId
        }

        // 订单状态变更历史（按时间正序，构成流转时间线）
        const statusHistory = order.statusHistory.map((h) => ({
          id: h.id,
          orderState: h.orderState,
          orderStateName: h.orderStateName,
          recordedAt: h.recordedAt.toISOString()
        }))

        return reply.send({
          data: {
            order: {
              id: order.id,
              source: order.source,
              sourceOrderNo: order.sourceOrderNo,
              customerName: order.customerName,
              customerPhone: order.customerPhone,
              hospital: order.hospital,
              dept: order.dept,
              doctor: order.doctor,
              status: order.status,
              poolType: (order.rawJson as any)?.poolType ?? null,
              detailFetchedAt: iso(order.detailFetchedAt),
              createdAt: order.createdAt.toISOString(),
              updatedAt: order.updatedAt.toISOString(),
              employee: order.assignedEmployee
            },
            recommendations: rec,
            brief,
            messages,
            attachments,
            materials,
            calls,
            statusHistory,
            rawJson: order.rawJson,
            detailJson: order.detailJson
          }
        })
      } catch (err: any) {
        rootFastify.log.error('admin order full 失败:', err)
        return reply.status(500).send({ error: '订单详情查询失败: ' + err.message })
      }
    })

    // ───── 6. 素材浏览（跨员工，游标分页 + 筛选）─────
    fastify.get('/api/v1/admin/materials', async (request, reply) => {
      try {
        const q = request.query as any
        const cursor = decodeCursor(q?.cursor)
        const employeeId = q?.employeeId ? parseInt(q.employeeId, 10) : null
        const orderId = q?.orderId ? parseInt(q.orderId, 10) : null
        const type = q?.type === 'text' || q?.type === 'image' ? q.type : null
        const search = (q?.search ?? '').trim()

        const filters: any[] = [keysetWhere('createdAt', cursor)]
        if (Number.isFinite(employeeId)) filters.push({ employeeId })
        if (Number.isFinite(orderId)) filters.push({ orderId })
        if (type) filters.push({ type })
        if (search) filters.push({ textContent: { contains: search } })

        const rows = await prisma.material.findMany({
          where: { AND: filters },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PAGE_SIZE + 1,
          include: {
            order: { select: { id: true, sourceOrderNo: true, customerName: true, customerPhone: true } },
            employee: { select: { id: true, name: true } }
          }
        })

        const hasMore = rows.length > PAGE_SIZE
        const page = rows.slice(0, PAGE_SIZE)
        const items = await Promise.all(
          page.map(async (m) => ({
            ...(await serializeMaterial(m)),
            order: m.order,
            employee: m.employee
          }))
        )
        const last = page[page.length - 1]
        return reply.send({
          data: { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null }
        })
      } catch (err: any) {
        rootFastify.log.error('admin materials 失败:', err)
        return reply.status(500).send({ error: '素材浏览查询失败: ' + err.message })
      }
    })

    // ───── 6.1 单条素材详情 ─────
    fastify.get('/api/v1/admin/materials/:id', async (request, reply) => {
      try {
        const id = parseInt((request.params as any).id, 10)
        if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })

        const m = await prisma.material.findUnique({
          where: { id },
          include: {
            order: { select: { id: true, sourceOrderNo: true, customerName: true, status: true } },
            employee: { select: { id: true, name: true } }
          }
        })
        if (!m) return reply.status(404).send({ error: '素材不存在' })

        const isImage = m.type === 'image'
        const imageUrl = isImage && m.minioBucket && m.minioKey
          ? await presign(m.minioBucket, m.minioKey).catch(() => null)
          : null

        return reply.send({
          data: {
            id: m.id,
            type: m.type,
            textContent: isImage ? null : m.textContent, // 详情给全文，不截断
            imageUrl,
            mimeType: m.mimeType,
            byteSize: m.byteSize,
            createdAt: m.createdAt.toISOString(),
            order: m.order,
            employee: m.employee
          }
        })
      } catch (err: any) {
        rootFastify.log.error('admin material detail 失败:', err)
        return reply.status(500).send({ error: '素材详情查询失败: ' + err.message })
      }
    })

    // ───── 7. 通话浏览（跨员工，游标分页 + 筛选）─────
    fastify.get('/api/v1/admin/calls', async (request, reply) => {
      try {
        const q = request.query as any
        const cursor = decodeCursor(q?.cursor)
        const employeeId = q?.employeeId ? parseInt(q.employeeId, 10) : null
        const asrStatus = typeof q?.asrStatus === 'string' && q.asrStatus ? q.asrStatus : null
        // linked: 'true' 只看已关联订单/申请号；'false' 只看完全未关联（孤儿通话）
        const linked = q?.linked === 'true' ? true : q?.linked === 'false' ? false : null

        const filters: any[] = [keysetWhere('startedAt', cursor)]
        if (Number.isFinite(employeeId)) filters.push({ employeeId })
        if (asrStatus) filters.push({ asrStatus })
        if (linked === true) filters.push({ OR: [{ orderId: { not: null } }, { applicationNo: { not: null } }] })
        if (linked === false) filters.push({ orderId: null, applicationNo: null })

        const rows = await prisma.call.findMany({
          where: { AND: filters },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: PAGE_SIZE + 1,
          include: {
            order: { select: { id: true, sourceOrderNo: true, customerName: true } },
            employee: { select: { id: true, name: true } }
          }
        })

        const hasMore = rows.length > PAGE_SIZE
        const page = rows.slice(0, PAGE_SIZE)
        const applicationNos = Array.from(
          new Set(page.map((c) => c.applicationNo).filter((x): x is string => !!x))
        )
        const applicationOrders = applicationNos.length
          ? await prisma.order.findMany({
              where: {
                OR: applicationNos.map((applicationNo) => ({
                  rawJson: { path: ['crmApplyNo'], equals: applicationNo }
                }))
              },
              select: { id: true, sourceOrderNo: true, customerName: true, status: true, rawJson: true },
              orderBy: { updatedAt: 'desc' }
            })
          : []
        const ordersByApplicationNo = new Map<string, typeof applicationOrders>()
        for (const order of applicationOrders) {
          const applicationNo = (order.rawJson as any)?.crmApplyNo
          if (!applicationNo) continue
          const arr = ordersByApplicationNo.get(applicationNo) ?? []
          arr.push(order)
          ordersByApplicationNo.set(applicationNo, arr)
        }
        const items = page.map((c) => {
          const asrText = c.asrText ?? null
          const relatedOrders = c.applicationNo
            ? (ordersByApplicationNo.get(c.applicationNo) ?? []).map((o) => ({
                id: o.id,
                sourceOrderNo: o.sourceOrderNo,
                customerName: o.customerName,
                status: o.status
              }))
            : []
          return {
            id: c.id,
            phone: c.phone,
            contactName: c.contactName,
            direction: c.direction,
            callStatus: c.callStatus,
            durationSec: c.durationSec,
            startedAt: c.startedAt.toISOString(),
            applicationNo: c.applicationNo,
            asrStatus: c.asrStatus,
            asrText,
            asrTextPreview: asrText ? asrText.slice(0, 300) : null,
            asrTextTruncated: !!asrText && asrText.length > 300,
            hasRecording: !!c.recordingOssKey,
            order: c.order,
            applicationOrders: relatedOrders,
            employee: c.employee
          }
        })
        const last = page[page.length - 1]
        return reply.send({
          data: { items, nextCursor: hasMore && last ? encodeCursor(last.startedAt, last.id) : null }
        })
      } catch (err: any) {
        rootFastify.log.error('admin calls 失败:', err)
        return reply.status(500).send({ error: '通话浏览查询失败: ' + err.message })
      }
    })

    // ───── 7.1 通话录音 presigned URL（给 <audio> 播放）─────
    fastify.get('/api/v1/admin/calls/:id/recording-url', async (request, reply) => {
      try {
        const id = parseInt((request.params as any).id, 10)
        if (!Number.isFinite(id)) return reply.status(400).send({ error: 'id 非法' })
        const call = await prisma.call.findUnique({
          where: { id },
          select: { recordingOssKey: true }
        })
        if (!call) return reply.status(404).send({ error: '通话记录不存在' })
        if (!call.recordingOssKey) return reply.status(404).send({ error: '该通话无录音' })
        // 录音 bucket 与员工端一致
        const bucket = getEnv().minioBucketRecordings
        const playback = await getRecordingPlaybackInfo(
          minioClient,
          minioPublicClient,
          bucket,
          id,
          call.recordingOssKey
        )
        return reply.send({ data: playback })
      } catch (err: any) {
        rootFastify.log.error('admin recording-url 失败:', err)
        return reply.status(500).send({ error: '获取录音 URL 失败: ' + err.message })
      }
    })

    // ───── 7.2 采集质量 + 简报健康 ─────
    // 去重命中、时间链还原失败率、识图成功率，以及 AI 简报 已生成/滞后/缺失。
    fastify.get('/api/v1/admin/dashboard/capture-quality', async (_request, reply) => {
      try {
        const today = startOfToday()

        const [msgAgg, chatTimeMissing, imageToday, imageProcessed, msgMaxByOrder] =
          await Promise.all([
            // 今日消息：总条数 + seenCount 之和（差值=被跨帧去重掉的重复截取）
            prisma.message.aggregate({
              where: { capturedAt: { gte: today } },
              _count: { _all: true },
              _sum: { seenCount: true }
            }),
            // 今日非系统消息里算不出真实聊天时间的（时间链还原失败）
            prisma.message.count({
              where: { capturedAt: { gte: today }, chatTime: null, senderType: { not: 'system' } }
            }),
            prisma.material.count({ where: { createdAt: { gte: today }, type: 'image' } }),
            prisma.material.count({
              where: { createdAt: { gte: today }, type: 'image', aiImageProcessedAt: { not: null } }
            }),
            // 有消息的订单 → 取每单最大 Message.id，用于和简报水位比对是否滞后
            prisma.message.groupBy({
              by: ['orderId'],
              where: { orderId: { not: null } },
              _max: { id: true }
            })
          ])

        const msgTotal = msgAgg._count._all
        const seenSum = msgAgg._sum.seenCount ?? 0
        const dedupHit = Math.max(0, seenSum - msgTotal) // 重复截到、被去重合并的次数

        // 简报健康：以 briefUpdatedAt 是否存在判定"已生成"，briefLastMsgId 落后于最大消息 id 判定"滞后"
        const orderIds = msgMaxByOrder
          .map((r) => r.orderId)
          .filter((x): x is number => typeof x === 'number')
        const briefOrders = orderIds.length
          ? await prisma.order.findMany({
              where: { id: { in: orderIds } },
              select: { id: true, briefUpdatedAt: true, briefLastMsgId: true }
            })
          : []
        const briefMap = new Map(briefOrders.map((o) => [o.id, o]))

        let briefGenerated = 0
        let briefStale = 0
        let briefMissing = 0
        for (const row of msgMaxByOrder) {
          const oid = row.orderId
          if (oid == null) continue
          const o = briefMap.get(oid)
          const maxId = row._max.id ?? 0
          if (!o || o.briefUpdatedAt == null) {
            briefMissing++
          } else {
            briefGenerated++
            if ((o.briefLastMsgId ?? 0) < maxId) briefStale++
          }
        }

        return reply.send({
          data: {
            quality: {
              messagesToday: msgTotal,
              dedupHit,
              chatTimeMissing,
              image: {
                today: imageToday,
                processed: imageProcessed,
                successRate: imageToday ? Math.round((imageProcessed / imageToday) * 100) : null
              }
            },
            brief: {
              ordersWithMessages: msgMaxByOrder.length,
              generated: briefGenerated,
              stale: briefStale,
              missing: briefMissing
            }
          }
        })
      } catch (err: any) {
        rootFastify.log.error('admin capture-quality 失败:', err)
        return reply.status(500).send({ error: '采集质量统计失败: ' + err.message })
      }
    })

    // ───── 7.3 每员工采集健康总览 ─────
    // 一行一员工：插件/桌面端在线、最近一次采集时间、近 1h 与今日 消息/素材/通话 计数、token。
    fastify.get('/api/v1/admin/capture/health', async (_request, reply) => {
      try {
        const today = startOfToday()
        const hourAgo = new Date(Date.now() - 3600_000)

        const [
          employees,
          msgToday, msgHour, lastMsg,
          matToday, matHour, lastMat,
          callToday, callHour, lastCall
        ] = await Promise.all([
          prisma.employee.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } }),
          prisma.message.groupBy({ by: ['employeeId'], where: { capturedAt: { gte: today } }, _count: { _all: true } }),
          prisma.message.groupBy({ by: ['employeeId'], where: { capturedAt: { gte: hourAgo } }, _count: { _all: true } }),
          prisma.message.groupBy({ by: ['employeeId'], _max: { capturedAt: true } }),
          prisma.material.groupBy({ by: ['employeeId'], where: { createdAt: { gte: today } }, _count: { _all: true } }),
          prisma.material.groupBy({ by: ['employeeId'], where: { createdAt: { gte: hourAgo } }, _count: { _all: true } }),
          prisma.material.groupBy({ by: ['employeeId'], _max: { createdAt: true } }),
          prisma.call.groupBy({ by: ['employeeId'], where: { startedAt: { gte: today } }, _count: { _all: true } }),
          prisma.call.groupBy({ by: ['employeeId'], where: { startedAt: { gte: hourAgo } }, _count: { _all: true } }),
          prisma.call.groupBy({ by: ['employeeId'], _max: { startedAt: true } })
        ])

        const cnt = (rows: Array<{ employeeId: number; _count: { _all: number } }>): Map<number, number> =>
          new Map(rows.map((r) => [r.employeeId, r._count._all]))
        const maxAt = (rows: Array<{ employeeId: number; _max: Record<string, Date | null> }>, field: string): Map<number, Date> => {
          const m = new Map<number, Date>()
          for (const r of rows) {
            const d = r._max[field]
            if (d) m.set(r.employeeId, d)
          }
          return m
        }

        const mToday = cnt(msgToday), mHour = cnt(msgHour)
        const matT = cnt(matToday), matH = cnt(matHour)
        const cToday = cnt(callToday), cHour = cnt(callHour)
        const lastMsgM = maxAt(lastMsg, 'capturedAt')
        const lastMatM = maxAt(lastMat, 'createdAt')
        const lastCallM = maxAt(lastCall, 'startedAt')

        const rows = employees.map((e) => {
          const info = presenceMap.get(e.id)
          const extOnline = info ? presenceIsFresh(info.lastSeenAt) : false
          const tray = trayInfo(e.id)
          const mobile = mobileInfo(e.id)
          // 最近一次采集 = 消息/素材/通话 最大时间
          let lastCaptureAt: Date | null = null
          for (const d of [lastMsgM.get(e.id), lastMatM.get(e.id), lastCallM.get(e.id)]) {
            if (d && (!lastCaptureAt || d > lastCaptureAt)) lastCaptureAt = d
          }
          return {
            employeeId: e.id,
            name: e.name,
            online: extOnline || tray.online || mobile.online,
            extOnline,
            trayOnline: tray.online,
            trayLastSeenAt: tray.lastSeenAt,
            mobileOnline: mobile.online,
            mobileState: mobile.state,
            mobileLastSeenAt: mobile.lastSeenAt,
            mobileHeartbeatSource: mobile.source,
            lastSeenAt: info ? new Date(info.lastSeenAt).toISOString() : tray.lastSeenAt,
            tokenOk: info?.tokenOk ?? null,
            lastCaptureAt: iso(lastCaptureAt),
            messages: { hour: mHour.get(e.id) ?? 0, today: mToday.get(e.id) ?? 0 },
            materials: { hour: matH.get(e.id) ?? 0, today: matT.get(e.id) ?? 0 },
            calls: { hour: cHour.get(e.id) ?? 0, today: cToday.get(e.id) ?? 0 }
          }
        })

        // 在线优先；其次按最近采集时间倒序（最近活跃的排前）
        rows.sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1
          return (b.lastCaptureAt ?? '').localeCompare(a.lastCaptureAt ?? '')
        })

        return reply.send({ data: rows })
      } catch (err: any) {
        rootFastify.log.error('admin capture/health 失败:', err)
        return reply.status(500).send({ error: '采集健康查询失败: ' + err.message })
      }
    })

    // ───── 7.2 消息浏览（微信/企微，跨员工，游标分页 + 筛选）─────
    fastify.get('/api/v1/admin/messages', async (request, reply) => {
      try {
        const q = request.query as any
        const cursor = decodeCursor(q?.cursor)
        const employeeId = q?.employeeId ? parseInt(q.employeeId, 10) : null
        const channel = typeof q?.channel === 'string' && q.channel ? q.channel : null
        const linked = q?.linked === 'true' ? true : q?.linked === 'false' ? false : null
        const search = typeof q?.search === 'string' && q.search.trim() ? q.search.trim() : null

        const filters: any[] = [keysetWhere('capturedAt', cursor)]
        if (Number.isFinite(employeeId)) filters.push({ employeeId })
        if (channel === 'wechat' || channel === 'wxwork') filters.push({ channel })
        if (linked === true) filters.push({ OR: [{ orderId: { not: null } }, { applicationNo: { not: null } }] })
        if (linked === false) filters.push({ orderId: null, applicationNo: null })
        if (search) {
          filters.push({
            OR: [
              { conversationName: { contains: search, mode: 'insensitive' } },
              { senderName: { contains: search, mode: 'insensitive' } },
              { contentText: { contains: search, mode: 'insensitive' } },
              { applicationNo: { contains: search, mode: 'insensitive' } }
            ]
          })
        }

        const rows = await prisma.message.findMany({
          where: { AND: filters },
          orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
          take: PAGE_SIZE + 1,
          include: {
            order: { select: { id: true, sourceOrderNo: true, customerName: true, status: true } },
            employee: { select: { id: true, name: true } }
          }
        })

        const hasMore = rows.length > PAGE_SIZE
        const page = rows.slice(0, PAGE_SIZE)
        const applicationNos = Array.from(
          new Set(page.map((m) => m.applicationNo).filter((x): x is string => !!x))
        )
        const applicationOrders = applicationNos.length
          ? await prisma.order.findMany({
              where: {
                OR: applicationNos.map((applicationNo) => ({
                  rawJson: { path: ['crmApplyNo'], equals: applicationNo }
                }))
              },
              select: { id: true, sourceOrderNo: true, customerName: true, status: true, rawJson: true },
              orderBy: { updatedAt: 'desc' }
            })
          : []
        const ordersByApplicationNo = new Map<string, typeof applicationOrders>()
        for (const order of applicationOrders) {
          const applicationNo = (order.rawJson as any)?.crmApplyNo
          if (!applicationNo) continue
          const arr = ordersByApplicationNo.get(applicationNo) ?? []
          arr.push(order)
          ordersByApplicationNo.set(applicationNo, arr)
        }

        const items = await Promise.all(
          page.map(async (m) => {
            const relatedOrders = m.applicationNo
              ? (ordersByApplicationNo.get(m.applicationNo) ?? []).map((o) => ({
                  id: o.id,
                  sourceOrderNo: o.sourceOrderNo,
                  customerName: o.customerName,
                  status: o.status
                }))
              : []
            return {
              id: m.id,
              channel: m.channel,
              conversationName: m.conversationName,
              senderName: m.senderName,
              senderType: m.senderType,
              kind: m.kind,
              contentText: m.contentText,
              applicationNo: m.applicationNo,
              chatTime: iso(m.chatTime),
              sortTime: iso(m.sortTime ?? m.capturedAt),
              capturedAt: m.capturedAt.toISOString(),
              seenCount: m.seenCount,
              screenshotUrl: m.screenshotOssKey
                ? await presign('screenshots', m.screenshotOssKey).catch(() => null)
                : null,
              order: m.order,
              applicationOrders: relatedOrders,
              employee: m.employee
            }
          })
        )
        const last = page[page.length - 1]
        return reply.send({
          data: { items, nextCursor: hasMore && last ? encodeCursor(last.capturedAt, last.id) : null }
        })
      } catch (err: any) {
        rootFastify.log.error('admin messages 失败:', err)
        return reply.status(500).send({ error: '消息浏览查询失败: ' + err.message })
      }
    })

    // ───── 7.4 待确认订单号（跨员工）─────
    // 采到订单号但模糊匹配不到(no_match)/并列多单(ambiguous)/名字对不上(name_mismatch)，
    // 列出来让运营看到"采到了但没挂上"的异常。只读，确认/忽略由员工端 tray 做。
    fastify.get('/api/v1/admin/unmatched-order-refs', async (request, reply) => {
      try {
        const status = typeof (request.query as any)?.status === 'string' && (request.query as any).status
          ? (request.query as any).status
          : 'pending'

        const rows = await prisma.unmatchedOrderRef.findMany({
          where: { status },
          orderBy: { updatedAt: 'desc' },
          take: 200,
          include: { employee: { select: { id: true, name: true } } }
        })

        // ambiguous 时 candidateOrderIds 里是并列的订单 id，批量取回订单基本信息
        const allOrderIds = new Set<number>()
        for (const r of rows) {
          const ids = (r.candidateOrderIds as unknown as number[] | null) ?? []
          for (const id of ids) if (typeof id === 'number') allOrderIds.add(id)
        }
        const candOrders = allOrderIds.size
          ? await prisma.order.findMany({
              where: { id: { in: [...allOrderIds] } },
              select: { id: true, sourceOrderNo: true, customerName: true }
            })
          : []
        const candMap = new Map(candOrders.map((o) => [o.id, o]))

        const items = await Promise.all(
          rows.map(async (r) => {
            const ids = (r.candidateOrderIds as unknown as number[] | null) ?? []
            return {
              id: r.id,
              employee: r.employee,
              channel: r.channel,
              conversationName: r.conversationName,
              candidate: r.candidate,
              candidateKind: r.candidateKind,
              reason: r.reason,
              bestDist: r.bestDist,
              candidateOrders: ids.map((id) => candMap.get(id)).filter(Boolean),
              seenCount: r.seenCount,
              status: r.status,
              capturedAt: r.capturedAt.toISOString(),
              createdAt: r.createdAt.toISOString(),
              updatedAt: r.updatedAt.toISOString(),
              screenshotUrl: r.screenshotOssKey
                ? await presign('screenshots', r.screenshotOssKey).catch(() => null)
                : null
            }
          })
        )

        return reply.send({ data: items })
      } catch (err: any) {
        rootFastify.log.error('admin unmatched-order-refs 失败:', err)
        return reply.status(500).send({ error: '待确认订单号查询失败: ' + err.message })
      }
    })

    // ───── 4. 系统健康 ─────
    fastify.get('/api/v1/admin/health', async (_request, reply) => {
      try {
        const since24 = new Date(Date.now() - 24 * 3600_000)
        const [
          orderCount,
          materialCount,
          callCount,
          attachmentCount,
          asrPending,
          asrProcessing,
          asr24Done,
          asr24Failed,
          asr24Manual,
          employees
        ] = await Promise.all([
          prisma.order.count(),
          prisma.material.count(),
          prisma.call.count(),
          prisma.orderAttachment.count(),
          prisma.call.count({ where: { asrStatus: 'pending' } }),
          prisma.call.count({ where: { asrStatus: 'processing' } }),
          // 近 24h 完成转写的终态计数（按 asrFinishedAt）
          prisma.call.count({ where: { asrFinishedAt: { gte: since24 }, asrStatus: 'done' } }),
          prisma.call.count({ where: { asrFinishedAt: { gte: since24 }, asrStatus: 'failed' } }),
          prisma.call.count({ where: { asrFinishedAt: { gte: since24 }, asrStatus: 'requires_manual' } }),
          prisma.employee.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } })
        ])

        const asr24Total = asr24Done + asr24Failed + asr24Manual
        const asr24Rate = asr24Total ? Math.round((asr24Done / asr24Total) * 100) : null

        // WebSocket 连接分布
        let extConns = 0
        let trayConns = 0
        for (const conn of activeConnections.values()) {
          if (conn.ext) extConns++
          if (conn.tray) trayConns++
        }

        // MinIO 各 bucket：存活 + 对象数 + 占用字节
        const buckets = ['order-attachments', 'recordings', 'screenshots', 'materials']
        const bucketStatus = await Promise.all(
          buckets.map(async (name) => {
            const ok = await minioPublicClient.bucketExists(name).catch(() => false)
            if (!ok) return { name, ok, objectCount: -1, sizeBytes: -1 }
            const stat = await bucketStat(minioPublicClient, name)
            return { name, ok, objectCount: stat.objectCount, sizeBytes: stat.sizeBytes }
          })
        )

        // Chrome 插件每员工最近一次上报（来自 WS PRESENCE 心跳）+ token 状态
        const extReports = employees
          .map((e) => {
            const info = presenceMap.get(e.id)
            const conn = activeConnections.get(e.id)
            return {
              employeeId: e.id,
              name: e.name,
              extConnected: !!conn?.ext,
              lastReportAt: info ? new Date(info.lastSeenAt).toISOString() : null,
              tokenOk: info?.tokenOk ?? null,
              tokenLastCheckAt: info?.tokenLastCheckAt
                ? new Date(info.tokenLastCheckAt).toISOString()
                : null
            }
          })
          // 最近上报的排前，从未上报的沉底
          .sort((a, b) => (b.lastReportAt ?? '').localeCompare(a.lastReportAt ?? ''))

        return reply.send({
          data: {
            process: {
              uptimeSec: Math.round(process.uptime()),
              nodeVersion: process.version,
              pid: process.pid
            },
            db: {
              ok: true,
              rows: {
                order: orderCount,
                material: materialCount,
                call: callCount,
                attachment: attachmentCount
              }
            },
            minio: { buckets: bucketStatus },
            websocket: { total: extConns + trayConns, ext: extConns, tray: trayConns },
            asr: {
              pending: asrPending,
              processing: asrProcessing,
              last24h: { done: asr24Done, total: asr24Total, rate: asr24Rate }
            },
            extReports
          }
        })
      } catch (err: any) {
        rootFastify.log.error('admin health 失败:', err)
        return reply.status(500).send({ error: '健康检查失败: ' + err.message })
      }
    })

    // GET /api/v1/admin/app/info - 获取最新 App 安装包状态
    fastify.get('/api/v1/admin/app/info', async (req: FastifyRequest, reply: FastifyReply) => {
      const downloadsDir = join(__dirname, '../../public/downloads')
      if (!existsSync(downloadsDir)) {
        return reply.send({ data: { exists: false } })
      }
      const files = readdirSync(downloadsDir).filter(f => f.toLowerCase().endsWith('.apk'))
      if (files.length === 0) {
        return reply.send({ data: { exists: false } })
      }

      // 获取修改时间最新的一个 apk 安装包
      let latestFile = files[0]
      let latestStat = statSync(join(downloadsDir, latestFile))
      for (let i = 1; i < files.length; i++) {
        const s = statSync(join(downloadsDir, files[i]))
        if (s.mtimeMs > latestStat.mtimeMs) {
          latestFile = files[i]
          latestStat = s
        }
      }

      try {
        const stat = latestStat
        const sizeMb = Number((stat.size / (1024 * 1024)).toFixed(2))

        // 计算可在局域网/公网直接访问该后端的 IP 地址与端口
        const port = getEnv().port || 13000
        let hostIp = '127.0.0.1'
        const reqHost = ((req.headers['x-forwarded-host'] || req.headers.host || '') as string).split(':')[0]
        if (reqHost && reqHost !== 'localhost' && reqHost !== '127.0.0.1') {
          hostIp = reqHost
        } else {
          // 获取本机首选的物理网卡 IPv4 局域网地址（过滤虚拟网卡如 VMware、WSL、Mihomo 等）
          const nets = os.networkInterfaces()
          const isVirtual = (name: string) => /vmware|virtual|wsl|vethernet|hyper-v|docker|tailscale|mihomo|tap|tun/i.test(name)
          const candidates: Array<{ name: string; ip: string }> = []
          for (const [name, iface] of Object.entries(nets)) {
            for (const item of iface || []) {
              if (item.family === 'IPv4' && !item.internal) {
                candidates.push({ name, ip: item.address })
              }
            }
          }
          const best = candidates.find(c => !isVirtual(c.name) && (c.ip.startsWith('192.168.') || c.ip.startsWith('10.') || c.ip.startsWith('172.')))
            || candidates.find(c => !isVirtual(c.name))
            || candidates[0]
          if (best) hostIp = best.ip
        }

        const encodedName = encodeURIComponent(latestFile)
        const downloadUrl = `/download/${encodedName}`
        const mobileDownloadUrl = `http://${hostIp}:${port}/download/${encodedName}`

        return reply.send({
          data: {
            exists: true,
            fileName: latestFile,
            sizeBytes: stat.size,
            sizeMb,
            updatedAt: stat.mtime.toISOString(),
            downloadUrl,
            mobileDownloadUrl
          }
        })
      } catch (e: any) {
        return reply.send({ data: { exists: false, error: e?.message } })
      }
    })

    // POST /api/v1/admin/app/upload - 上传最新的 App 安装包 (.apk)，保留原始文件名并覆盖旧版本
    fastify.post('/api/v1/admin/app/upload', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = await req.file()
        if (!data) {
          return reply.status(400).send({ error: '未接收到上传的文件' })
        }
        if (!data.filename.toLowerCase().endsWith('.apk')) {
          return reply.status(400).send({ error: '上传的文件必须是 Android 安装包 (.apk)' })
        }

        const downloadsDir = join(__dirname, '../../public/downloads')
        if (!existsSync(downloadsDir)) {
          mkdirSync(downloadsDir, { recursive: true })
        }

        // 获取用户上传的原始文件名（过滤非法路径字符）
        const rawName = basename(data.filename || 'app.apk')
        const safeName = rawName.replace(/[/\\?%*:|"<>]/g, '_')

        // 清理目录内历史旧 .apk 文件，保证最新包即当前唯一有效包
        try {
          const oldFiles = readdirSync(downloadsDir).filter(f => f.toLowerCase().endsWith('.apk'))
          for (const f of oldFiles) {
            try { unlinkSync(join(downloadsDir, f)) } catch {}
          }
        } catch {}

        const apkPath = join(downloadsDir, safeName)
        const writeStream = createWriteStream(apkPath)
        await new Promise<void>((resolve, reject) => {
          data.file.pipe(writeStream)
          data.file.on('end', () => resolve())
          data.file.on('error', (err: unknown) => reject(err))
          writeStream.on('error', (err: unknown) => reject(err))
        })

        const stat = statSync(apkPath)
        const sizeMb = Number((stat.size / (1024 * 1024)).toFixed(2))
        const encodedName = encodeURIComponent(safeName)
        const downloadUrl = `/download/${encodedName}`

        return reply.send({
          data: {
            ok: true,
            message: `最新安装包「${safeName}」上传成功`,
            fileName: safeName,
            sizeMb,
            updatedAt: stat.mtime.toISOString(),
            downloadUrl
          }
        })
      } catch (err: any) {
        rootFastify.log.error('上传 App 安装包失败:', err)
        return reply.status(500).send({ error: '上传失败: ' + (err?.message || err) })
      }
    })
  })
}
