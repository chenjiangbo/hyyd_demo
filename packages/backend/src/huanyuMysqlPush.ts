import mysql, { type Pool } from 'mysql2/promise'
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

const ESCORT_COLUMNS = ['DDBH', 'PZR', 'BBQ_FW', 'ZJ', 'xtsj'] as const
const ATTACHMENT_COLUMNS = [
  'DDBH', 'TP_A', 'TP_B', 'TP_C', 'TP_D', 'TP_E', 'TP_F', 'TP_G', 'TP_H', 'TP_I', 'TP_J',
  'FIELD12_', 'FIELD13_', 'FIELD14_', 'FIELD15_', 'FIELD16_', 'FIELD17_', 'FIELD18_', 'FIELD19_', 'FIELD20_'
] as const

function insertSql(table: string, columns: readonly string[], key: string): string {
  const escapedColumns = columns.map((column) => `\`${column}\``).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  const update = columns.filter((column) => column !== key).map((column) => `\`${column}\` = VALUES(\`${column}\`)`).join(', ')
  return `INSERT INTO \`${table}\` (${escapedColumns}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${update}`
}

type MysqlParam = string | number | boolean | Date | Buffer | null

function values(row: Record<string, unknown>, columns: readonly string[]): MysqlParam[] {
  return columns.map((column) => {
    const value = row[column]
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date || Buffer.isBuffer(value)) return value ?? null
    // 当前三张表只应出现标量/bytea；出现意外 JSON 时保留可审计的文本而不是让参数化写入失败。
    return JSON.stringify(value)
  })
}

/**
 * 将本地 PostgreSQL 三张寰宇订单表的当前快照写到远端 MySQL。
 * 此函数没有自动触发入口，只能由“确认推送寰宇订单信息”按钮对应的 API 调用。
 */
export async function pushHuanyuOrderToMysql(prisma: PrismaClient, ddbh: string): Promise<{ escortCount: number }> {
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
    await connection.execute(insertSql('HY_FACT_DDCX_NEW', ORDER_COLUMNS, 'DDBH'), values(order, ORDER_COLUMNS))
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
