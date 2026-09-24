import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import type { PrismaClient } from '@prisma/client'
import { getEnv } from './env.js'

let pushPool: Pool | null = null

function mysqlWriterPool(): Pool {
  if (pushPool) return pushPool
  const env = getEnv()
  // 开发/历史环境中远端字典库与寰宇订单 MySQL 是同一库；保留兼容回退，
  // 但生产应显式使用 HUANYU_PUSH_DB_* 和最小写权限账号。
  const host = env.huanyuPushDbHost ?? env.remoteDictDbHost
  const portRaw = env.huanyuPushDbPort ?? env.remoteDictDbPort
  const database = env.huanyuPushDbName ?? env.remoteDictDbName
  const user = env.huanyuPushDbUser ?? env.remoteDictDbUser
  const password = env.huanyuPushDbPassword ?? env.remoteDictDbPassword
  const ssl = env.huanyuPushDbSsl ?? env.remoteDictDbSsl
  const missing = [
    ['HUANYU_PUSH_DB_HOST', host], ['HUANYU_PUSH_DB_PORT', portRaw], ['HUANYU_PUSH_DB_NAME', database],
    ['HUANYU_PUSH_DB_USER', user], ['HUANYU_PUSH_DB_PASSWORD', password]
  ].filter(([, value]) => !value).map(([name]) => name)
  if (missing.length) throw new Error(`寰宇 MySQL 推送未配置：缺少 ${missing.join('、')}`)
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HUANYU_PUSH_DB_PORT 必须是有效端口')
  pushPool = mysql.createPool({
    host, port, database, user, password,
    waitForConnections: true, connectionLimit: 3, queueLimit: 0, multipleStatements: false,
    ssl: ssl?.toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined
  })
  return pushPool
}

const ORDER_COLUMNS = [
  'DDBH', 'DD_state', 'BDQD', 'BDQD_DDBH', 'BDQD_DDBH2', 'BDQD_XF', 'BDQD_DJR', 'BDQD_DJR2',
  'BDQD_FWXM', 'DDJE', 'KHJL', 'JZR_XM', 'JZR_ZJLX', 'JZR_ZJHM', 'JZR_XB', 'JZR_NL', 'JZR_LXDH',
  'JZR_JSMC', 'JZR_JSGX', 'JZR_JSLXFS', 'JZR_JB', 'JZR_BZ', 'H_NAME', 'H_ADDRESS', 'H_KS', 'H_YS',
  'DDFWBZ', 'BBQ_XQ', 'DATE_XQ', 'BBQ_YD', 'DATE_YD', 'BBQ_QDFW', 'DATE_QDFW', 'BBQ_FK', 'DATE_FK',
  'BBQ_FW', 'DATE_FW', 'PZR', 'PZXJ', 'KPBH', 'HKBH', 'BDYH', 'YYQDLX', 'SLR', 'xtsj_',
  'expectedProvince', 'expectedCity', 'expectedHospital', 'expectedDepartment', 'medicare', 'registerPayStatus',
  'lastQueuingTime', 'messageUrl', 'registerAmount', 'advanceRegisterAmount', 'isAdvancePay', 'refundCustAmount',
  'medicareType', 'isTaiKang', 'aliPayTradeNo', 'expert_level'
] as const

/** 泰康挂号协助详情页始终以远端 MySQL 为准、推送时也不得反向覆盖的字段。 */
export const REGISTRATION_ASSIST_REMOTE_AUTHORITATIVE_COLUMNS = [
  'advanceRegisterAmount',
  'registerPayStatus',
  'refundCustAmount',
  'aliPayTradeNo',
  'medicare',
  'messageUrl'
] as const

const ESCORT_COLUMNS = ['DDBH', 'PZR', 'BBQ_FW', 'ZJ', 'xtsj'] as const
const ATTACHMENT_COLUMNS = [
  'DDBH', 'TP_A', 'TP_B', 'TP_C', 'TP_D', 'TP_E', 'TP_F', 'TP_G', 'TP_H', 'TP_I', 'TP_J',
  'FIELD12_', 'FIELD13_', 'FIELD14_', 'FIELD15_', 'FIELD16_', 'FIELD17_', 'FIELD18_', 'FIELD19_', 'FIELD20_'
] as const

function insertSql(table: string, columns: readonly string[], key: string, excludedUpdateColumns: readonly string[] = []): string {
  const escapedColumns = columns.map((column) => `\`${column}\``).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  const excluded = new Set(excludedUpdateColumns)
  const update = columns
    .filter((column) => column !== key && !excluded.has(column))
    .map((column) => `\`${column}\` = VALUES(\`${column}\`)`)
    .join(', ')
  return `INSERT INTO \`${table}\` (${escapedColumns}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${update}`
}

type MysqlParam = string | number | boolean | Date | Buffer | null

function values(row: Record<string, unknown>, columns: readonly string[]): MysqlParam[] {
  return columns.map((column) => {
    const value = row[column]
    if (value == null) return null
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date || Buffer.isBuffer(value)) {
      return value
    }
    if (typeof value === 'bigint') {
      return value.toString()
    }
    // 处理 Prisma.Decimal 等数值对象，提取为纯净字符串而不是 JSON 双引号字符串
    if (typeof value === 'object' && typeof (value as any).toString === 'function') {
      const str = (value as any).toString()
      if (str !== '[object Object]') {
        return str
      }
    }
    // 当前三张表只应出现标量/bytea；出现意外 JSON 时保留可审计的文本而不是让参数化写入失败。
    return JSON.stringify(value)
  })
}

function mysqlColumns(columns: readonly string[]): string {
  return columns.map((column) => `\`${column}\``).join(', ')
}

function postgresUpsertSql(table: string, columns: readonly string[], key: string): string {
  // 表名和列名都来自本文件的固定白名单，绝不接受外部输入。
  const quoted = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`
  const columnSql = columns.map(quoted).join(', ')
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
  const updates = columns
    .filter((column) => column !== key)
    .map((column) => `${quoted(column)} = EXCLUDED.${quoted(column)}`)
    .join(', ')
  return `INSERT INTO ${quoted(table)} (${columnSql}) VALUES (${placeholders}) ON CONFLICT (${quoted(key)}) DO UPDATE SET ${updates}`
}

export interface HuanyuMysqlPullResult {
  found: boolean
  ddbh: string | null
  escortCount: number
  attachmentFound: boolean
}

export interface HuanyuMysqlPushOptions {
  /** 仅从 ON DUPLICATE KEY UPDATE 排除；新建远端行时仍按本地快照完整写入。 */
  excludeOrderUpdateColumns?: readonly string[]
}

/**
 * 以泰康子订单号查询远端寰宇主表；命中后按 DDBH 回拉陪诊明细及附件快照，
 * 并以远端数据为准写入本地 PostgreSQL 三张寰宇表。
 *
 * 此函数严格只读远端 MySQL，不会触发推送或修改远端任何数据。
 */
export async function pullHuanyuOrderFromMysqlByChannelOrderNo(
  prisma: PrismaClient,
  channelOrderNo: string
): Promise<HuanyuMysqlPullResult> {
  const lookupNo = channelOrderNo.trim()
  if (!lookupNo) return { found: false, ddbh: null, escortCount: 0, attachmentFound: false }

  const connection = await mysqlWriterPool().getConnection()
  try {
    const [orderRows] = await connection.execute<RowDataPacket[]>(
      `SELECT ${mysqlColumns(ORDER_COLUMNS)}
         FROM \`HY_FACT_DDCX_NEW\`
        WHERE \`BDQD_DDBH\` = ?
        ORDER BY \`xtsj_\` DESC, \`DDBH\` DESC
        LIMIT 1`,
      [lookupNo]
    )
    const order = orderRows[0]
    const ddbh = order?.DDBH == null ? '' : String(order.DDBH).trim()
    if (!ddbh) return { found: false, ddbh: null, escortCount: 0, attachmentFound: false }

    const [escortRows] = await connection.execute<RowDataPacket[]>(
      `SELECT ${mysqlColumns(ESCORT_COLUMNS)}
         FROM \`fact_hy_pzrxx\`
        WHERE \`DDBH\` = ?
        ORDER BY \`ZJ\` ASC`,
      [ddbh]
    )
    const [attachmentRows] = await connection.execute<RowDataPacket[]>(
      `SELECT ${mysqlColumns(ATTACHMENT_COLUMNS)}
         FROM \`hy_d_tp\`
        WHERE \`DDBH\` = ?
        LIMIT 1`,
      [ddbh]
    )

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        postgresUpsertSql('HY_FACT_DDCX_NEW', ORDER_COLUMNS, 'DDBH'),
        ...values(order as Record<string, unknown>, ORDER_COLUMNS)
      )
      for (const escort of escortRows) {
        await tx.$executeRawUnsafe(
          postgresUpsertSql('fact_hy_pzrxx', ESCORT_COLUMNS, 'ZJ'),
          ...values(escort as Record<string, unknown>, ESCORT_COLUMNS)
        )
      }
      const attachment = attachmentRows[0]
      if (attachment) {
        await tx.$executeRawUnsafe(
          postgresUpsertSql('hy_d_tp', ATTACHMENT_COLUMNS, 'DDBH'),
          ...values(attachment as Record<string, unknown>, ATTACHMENT_COLUMNS)
        )
      }
    })

    return {
      found: true,
      ddbh,
      escortCount: escortRows.length,
      attachmentFound: Boolean(attachmentRows[0])
    }
  } finally {
    connection.release()
  }
}

/**
 * 挂号协助详情每次打开时，从远端主订单刷新六个远端权威字段到本地快照。
 * 远端没有同一 DDBH 时保持本地值不变，以免远端暂不可用影响详情展示。
 */
export async function refreshRegistrationAssistFieldsFromMysql(
  prisma: PrismaClient,
  ddbh: string
): Promise<boolean> {
  const cleanDdbh = ddbh.trim()
  if (!cleanDdbh) return false

  const connection = await mysqlWriterPool().getConnection()
  try {
    const columns = ['DDBH', ...REGISTRATION_ASSIST_REMOTE_AUTHORITATIVE_COLUMNS] as const
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT ${mysqlColumns(columns)}
         FROM \`HY_FACT_DDCX_NEW\`
        WHERE \`DDBH\` = ?
        LIMIT 1`,
      [cleanDdbh]
    )
    const remote = rows[0]
    if (!remote) return false

    const assignments = REGISTRATION_ASSIST_REMOTE_AUTHORITATIVE_COLUMNS
      .map((column, index) => `"${column}" = $${index + 1}`)
      .join(', ')
    await prisma.$executeRawUnsafe(
      `UPDATE "HY_FACT_DDCX_NEW"
          SET ${assignments}
        WHERE "DDBH" = $${REGISTRATION_ASSIST_REMOTE_AUTHORITATIVE_COLUMNS.length + 1}`,
      ...values(remote as Record<string, unknown>, REGISTRATION_ASSIST_REMOTE_AUTHORITATIVE_COLUMNS),
      cleanDdbh
    )
    return true
  } finally {
    connection.release()
  }
}

/**
 * 将本地 PostgreSQL 三张寰宇订单表的当前快照写到远端 MySQL。
 * 此函数没有自动触发入口，只能由“确认推送寰宇订单信息”按钮对应的 API 调用。
 */
export async function pushHuanyuOrderToMysql(
  prisma: PrismaClient,
  ddbh: string,
  options: HuanyuMysqlPushOptions = {}
): Promise<{ escortCount: number }> {
  const [orders, escorts, attachments] = await Promise.all([
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "HY_FACT_DDCX_NEW" WHERE "DDBH" = $1 LIMIT 1`, ddbh),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "fact_hy_pzrxx" WHERE "DDBH" = $1 ORDER BY "ZJ" ASC`, ddbh),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "hy_d_tp" WHERE "DDBH" = $1 LIMIT 1`, ddbh)
  ])
  const order = orders[0]
  if (!order) throw new Error(`本地 PostgreSQL 未找到寰宇订单 ${ddbh}`)

  const connection = await mysqlWriterPool().getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute(
      insertSql('HY_FACT_DDCX_NEW', ORDER_COLUMNS, 'DDBH', options.excludeOrderUpdateColumns),
      values(order, ORDER_COLUMNS)
    )
    // 陪诊明细以本地快照为准；先清掉同订单旧行，再按当前列表完整写入。
    await connection.execute('DELETE FROM `fact_hy_pzrxx` WHERE `DDBH` = ?', [ddbh])
    for (const escort of escorts) {
      await connection.execute(insertSql('fact_hy_pzrxx', ESCORT_COLUMNS, 'ZJ'), values(escort, ESCORT_COLUMNS))
    }
    const attachment = attachments[0]
    if (attachment) {
      await connection.execute(insertSql('hy_d_tp', ATTACHMENT_COLUMNS, 'DDBH'), values(attachment, ATTACHMENT_COLUMNS))
    }
    await connection.commit()
    return { escortCount: escorts.length }
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
}

export async function closeHuanyuMysqlPushPool(): Promise<void> {
  if (!pushPool) return
  const pool = pushPool
  pushPool = null
  await pool.end()
}
