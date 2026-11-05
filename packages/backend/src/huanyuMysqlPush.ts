import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import type { PrismaClient } from '@prisma/client'
import { getEnv } from './env.js'
import { randomUUID } from 'node:crypto'
import { getRemoteDictionaryPool } from './db/remoteDictionary.js'

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
    waitForConnections: true, connectionLimit: 3, queueLimit: 0, multipleStatements: false, timezone: '+08:00',
    ssl: ssl?.toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined
  })
  pushPool.on('connection', (connection) => {
    void connection.query("SET time_zone = '+08:00'")
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

/**
 * 泰康挂号协助详情页始终以远端 MySQL 为准、推送时也不得反向覆盖的字段。
 * refundCustAmount 是 ABI 退款成功后先落本地 PostgreSQL、再由人工确认推送回远端的字段，
 * 因此不在此远端权威字段集合中。
 */
export const REGISTRATION_ASSIST_REMOTE_AUTHORITATIVE_COLUMNS = [
  'advanceRegisterAmount',
  'registerPayStatus',
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

const POSTGRES_NUMERIC_COLUMNS = new Set([
  'DDJE',
  'JZR_NL',
  'registerAmount',
  'advanceRegisterAmount',
  'refundCustAmount'
])

function postgresUpsertSql(table: string, columns: readonly string[], key: string): string {
  // 表名和列名都来自本文件的固定白名单，绝不接受外部输入。
  const quoted = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`
  const columnSql = columns.map(quoted).join(', ')
  const placeholders = columns.map((col, index) => {
    if (table === 'HY_FACT_DDCX_NEW' && POSTGRES_NUMERIC_COLUMNS.has(col)) {
      return `CASE WHEN $${index + 1}::text = '' THEN NULL ELSE $${index + 1}::numeric END`
    }
    return `$${index + 1}`
  }).join(', ')
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

/** 只查远端对应的 B 端订单号，不回拉或写入本地寰宇表。 */
export async function findHuanyuOrderNoOnMysqlByChannelOrderNo(channelOrderNo: string): Promise<string | null> {
  const lookupNo = channelOrderNo.trim()
  if (!lookupNo) return null
  const connection = await mysqlWriterPool().getConnection()
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT \`DDBH\` FROM \`HY_FACT_DDCX_NEW\` WHERE \`BDQD_DDBH\` = ? ORDER BY \`xtsj_\` DESC, \`DDBH\` DESC LIMIT 1`,
      [lookupNo]
    )
    const ddbh = rows[0]?.DDBH == null ? '' : String(rows[0].DDBH).trim()
    return ddbh || null
  } finally {
    connection.release()
  }
}

/** 查询该 B 端订单关联的全部寰宇服务单号，供复诊/复制单场景建立一对多关联。 */
export async function findHuanyuOrderNosOnMysqlByChannelOrderNo(channelOrderNo: string): Promise<string[]> {
  const lookupNo = channelOrderNo.trim()
  if (!lookupNo) return []
  const connection = await mysqlWriterPool().getConnection()
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT DISTINCT \`DDBH\` FROM \`HY_FACT_DDCX_NEW\` WHERE \`BDQD_DDBH\` = ? ORDER BY \`xtsj_\` ASC, \`DDBH\` ASC`,
      [lookupNo]
    )
    return rows.map((row) => String(row.DDBH ?? '').trim()).filter(Boolean)
  } finally {
    connection.release()
  }
}

/** 直接在远端寰宇主表创建订单；调用方负责先按泰康订单号查重。 */
export async function createHuanyuOrderOnMysql(row: Record<string, unknown>): Promise<void> {
  const columns = [
    'DDBH', 'DD_state', 'BDQD', 'BDQD_DDBH', 'BDQD_DDBH2', 'BDQD_FWXM', 'DDJE', 'KHJL',
    'JZR_XM', 'JZR_ZJLX', 'JZR_XB', 'JZR_NL', 'JZR_LXDH',
    'JZR_JSMC', 'JZR_JSGX', 'JZR_JSLXFS', 'JZR_JB', 'JZR_BZ',
    'YYQDLX', 'xtsj_'
  ] as const
  const sql = `INSERT INTO \`HY_FACT_DDCX_NEW\` (${columns.map((column) => `\`${column}\``).join(', ')}) VALUES (${columns.map((column) => column === 'xtsj_' ? "DATE_FORMAT(NOW(), '%Y%m%d%H%i%s')" : '?').join(', ')})`
  const connection = await mysqlWriterPool().getConnection()
  try {
    await connection.query("SET time_zone = '+08:00'")
    await connection.execute(sql, values(row, columns.filter((column) => column !== 'xtsj_')))
  } finally {
    connection.release()
  }
}

/** 按关联订单号及渠道订单号共同核验，避免向错误订单补充证件号。 */
export async function readRemoteOrderIdentity(orderNo: string, sourceOrderNo: string): Promise<{ name: string; documentType: string; documentNo: string } | null> {
  const connection = await mysqlWriterPool().getConnection()
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT `JZR_XM`, `JZR_ZJLX`, `JZR_ZJHM` FROM `HY_FACT_DDCX_NEW` WHERE `DDBH` = ? AND `BDQD_DDBH` = ? LIMIT 1',
      [orderNo, sourceOrderNo]
    )
    const row = rows[0]
    return row ? { name: String(row.JZR_XM ?? ''), documentType: String(row.JZR_ZJLX ?? ''), documentNo: String(row.JZR_ZJHM ?? '') } : null
  } finally { connection.release() }
}

/** 精灵按已核对的寰宇订单号读取当前远端证件号码。 */
export async function readRemoteOrderDocumentNo(orderNo: string): Promise<{ documentNo: string } | null> {
  const connection = await mysqlWriterPool().getConnection()
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT `JZR_ZJHM` FROM `HY_FACT_DDCX_NEW` WHERE `DDBH` = ? LIMIT 1', [orderNo]
    )
    return rows[0] ? { documentNo: String(rows[0].JZR_ZJHM ?? '').trim() } : null
  } finally { connection.release() }
}

/** 读取精灵面板所需的远端订单与陪诊记录；不使用本地快照。 */
export async function readRemotePetOrder(orderNo: string): Promise<{ order: Record<string, string>; escorts: Array<{ id: string; escortName: string; escortPhone: string; serviceDate: string }> } | null> {
  const connection = await mysqlWriterPool().getConnection()
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT `JZR_ZJHM`, `DD_state`, `BDQD`, `BDQD_FWXM`, `DDJE`, `H_NAME`, `H_ADDRESS`, `H_KS`, `H_YS`, `BBQ_XQ`, `BBQ_YD`, `BBQ_QDFW`, `BBQ_FK`, `lastQueuingTime` FROM `HY_FACT_DDCX_NEW` WHERE `DDBH` = ? LIMIT 1', [orderNo])
    if (!rows[0]) return null
    const row = rows[0]
    const value = (key: string): string => row[key] == null ? '' : String(row[key]).trim()
    const [escorts] = await connection.execute<RowDataPacket[]>(
      'SELECT `ZJ`, `PZR`, `BBQ_FW` FROM `fact_hy_pzrxx` WHERE `DDBH` = ? ORDER BY `xtsj`, `ZJ`', [orderNo])
    const ids = [...new Set(escorts.map((escort) => String(escort.PZR ?? '').trim()).filter(Boolean))]
    const phones = new Map<string, string>()
    if (ids.length) {
      const [people] = await getRemoteDictionaryPool().execute<RowDataPacket[]>(`SELECT CAST(ID AS CHAR) AS id, SJ AS phone FROM f_hy_pzr WHERE CAST(ID AS CHAR) IN (${ids.map(() => '?').join(',')})`, ids)
      for (const person of people) phones.set(String(person.id).trim(), String(person.phone ?? '').trim())
    }
    return { order: {
      documentNo: value('JZR_ZJHM'), orderStatus: value('DD_state'), channel: value('BDQD'), channelService: value('BDQD_FWXM'), orderAmount: value('DDJE'),
      hospital: value('H_NAME'), hospitalAddress: value('H_ADDRESS'), department: value('H_KS'), doctor: value('H_YS'),
      requestTime: value('BBQ_XQ'), responseTime: value('BBQ_YD'), serviceStartTime: value('BBQ_QDFW'), bookingFeedbackTime: value('BBQ_FK'), latestTicketTime: value('lastQueuingTime')
    }, escorts: escorts.map((escort) => ({ id: String(escort.ZJ ?? '').trim(), escortName: String(escort.PZR ?? '').trim(), escortPhone: phones.get(String(escort.PZR ?? '').trim()) ?? '', serviceDate: String(escort.BBQ_FW ?? '').trim() })) }
  } finally { connection.release() }
}

/** 只在远程值与识别前读取的值完全一致时更新，保护并发人工修改。 */
export async function updateRemoteOrderIdentity(orderNo: string, sourceOrderNo: string, expected: { name: string; documentType: string; documentNo: string }, documentNo: string): Promise<boolean> {
  const connection = await mysqlWriterPool().getConnection()
  try {
    const [result] = await connection.execute<import('mysql2').ResultSetHeader>(
      'UPDATE `HY_FACT_DDCX_NEW` SET `JZR_ZJHM` = ? WHERE `DDBH` = ? AND `BDQD_DDBH` = ? AND BINARY COALESCE(`JZR_ZJHM`, \'\') = BINARY ? AND BINARY COALESCE(`JZR_XM`, \'\') = BINARY ? AND BINARY COALESCE(`JZR_ZJLX`, \'\') = BINARY ?',
      [documentNo, orderNo, sourceOrderNo, expected.documentNo, expected.name, expected.documentType]
    )
    return result.affectedRows === 1
  } finally { connection.release() }
}

export interface HuanyuMysqlPushOptions {
  /** 仅从 ON DUPLICATE KEY UPDATE 排除；新建远端行时仍按本地快照完整写入。 */
  excludeOrderUpdateColumns?: readonly string[]
}

export interface PetHuanyuOrderUpdate {
  orderNo: string
  orderStatus: string
  hospitalId: string | null
  hospitalAddressId: string | null
  departmentId: string | null
  doctorId: string | null
  requestTime: string | null
  responseTime: string | null
  serviceStartTime: string | null
  bookingFeedbackTime: string | null
  latestTicketTime: string | null
  escortList: Array<{ escortId: string; serviceDate: string | null; sequence: string; id?: string }>
  expectedEscorts?: Array<{ id: string; escortId: string; serviceDate: string }>
  expectedOrder?: Record<string, string>
  financial?: { channel: string; originalService: string; originalAmount: string; service: string; amount: string; serviceValidated?: boolean }
}

export async function huanyuOrderExistsOnMysql(orderNo: string): Promise<boolean> {
  const connection = await mysqlWriterPool().getConnection()
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(
      'SELECT `DDBH` FROM `HY_FACT_DDCX_NEW` WHERE `DDBH` = ? LIMIT 1', [orderNo.trim()])
    return rows.length > 0
  } finally {
    connection.release()
  }
}

/** 浮动精灵专用：直接更新远端寰宇表，不读取或写入本地 PostgreSQL 快照。 */
export async function updateHuanyuOrderDirectlyOnMysql(input: PetHuanyuOrderUpdate, connectionOverride?: PoolConnection): Promise<{ escortCount: number; escortIds: string[] }> {
  const orderNo = input.orderNo.trim()
  if (!orderNo) throw new Error('订单号不能为空')
  const connection = connectionOverride ?? await mysqlWriterPool().getConnection()
  try {
    await connection.beginTransaction()
    const [existingRows] = await connection.execute<RowDataPacket[]>(
      'SELECT `DDBH`, `DD_state`, `BDQD`, `BDQD_FWXM`, `DDJE`, `H_NAME`, `H_ADDRESS`, `H_KS`, `H_YS`, `BBQ_XQ`, `BBQ_YD`, `BBQ_QDFW`, `BBQ_FK`, `lastQueuingTime` FROM `HY_FACT_DDCX_NEW` WHERE `DDBH` = ? LIMIT 1 FOR UPDATE', [orderNo])
    if (!existingRows.length) throw new Error(`远端寰宇订单 ${orderNo} 不存在`)

    if (input.expectedOrder) {
      const fields: Record<string, string> = { orderStatus: 'DD_state', hospital: 'H_NAME', hospitalAddress: 'H_ADDRESS', department: 'H_KS', doctor: 'H_YS', requestTime: 'BBQ_XQ', responseTime: 'BBQ_YD', serviceStartTime: 'BBQ_QDFW', bookingFeedbackTime: 'BBQ_FK', latestTicketTime: 'lastQueuingTime' }
      if (Object.entries(fields).some(([key, column]) => String(existingRows[0][column] ?? '').trim() !== String(input.expectedOrder?.[key] ?? '').trim())) throw new Error('订单内容已发生变化，请重新打开订单')
    }

    if (input.financial) {
      const f = input.financial
      const current = existingRows[0]
      const channel = String(current.BDQD ?? '').trim()
      const service = String(current.BDQD_FWXM ?? '').trim()
      const amount = current.DDJE == null ? '' : String(current.DDJE).trim()
      if (channel !== f.channel || service !== f.originalService || (amount === '' ? f.originalAmount !== '' : f.originalAmount === '' || Number(amount) !== Number(f.originalAmount))) throw new Error('订单金额或服务项目已发生变化，请重新打开订单')
      if (f.amount && !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(f.amount)) throw new Error('请输入有效订单金额')
      if (!f.amount && f.originalAmount) throw new Error('请输入有效订单金额')
      if ((input.orderStatus === '已取消' || input.orderStatus === '无责取消') && (!f.amount || Number(f.amount) !== 0)) throw new Error('取消订单的金额必须为零')
      if (f.service !== service) {
        if (!f.service || !channel) throw new Error('请选择有效的服务项目')
        if (!f.amount) throw new Error('服务项目价格为空，请核对订单金额')
        if (!f.serviceValidated) throw new Error('服务项目不属于当前渠道，请重新选择')
      }
      await connection.execute('UPDATE `HY_FACT_DDCX_NEW` SET `BDQD_FWXM` = ?, `DDJE` = ? WHERE `DDBH` = ?', [f.service || null, f.amount || null, orderNo])
    }

    if (!input.expectedEscorts && input.escortList.length > 0) {
      const [unfinished] = await connection.execute<RowDataPacket[]>(
        "SELECT `ZJ` FROM `fact_hy_pzrxx` WHERE `DDBH` = ? AND (`PZR` IS NULL OR TRIM(CAST(`PZR` AS CHAR)) = '') LIMIT 1 FOR UPDATE", [orderNo])
      if (unfinished.length) throw new Error('订单有待安排陪诊的服务日期，请更新客户端后重新打开订单')
    }
    if (input.expectedEscorts) {
      const [current] = await connection.execute<RowDataPacket[]>(
        'SELECT `ZJ`, `PZR`, `BBQ_FW` FROM `fact_hy_pzrxx` WHERE `DDBH` = ? FOR UPDATE', [orderNo])
      const normalize = (items: Array<{ id: string; escortId: string; serviceDate: string }>) => JSON.stringify(items.map((item) => [item.id, item.escortId, item.serviceDate]).sort((a, b) => a[0].localeCompare(b[0])))
      const actual = current.map((row) => ({ id: String(row.ZJ ?? '').trim(), escortId: String(row.PZR ?? '').trim(), serviceDate: String(row.BBQ_FW ?? '').trim() }))
      if (normalize(actual) !== normalize(input.expectedEscorts)) throw new Error('陪诊记录已发生变化，请重新打开订单后再填写')
      const validIds = new Set(actual.map((item) => item.id))
      const selectedIds = input.escortList.map((item) => item.id).filter((id): id is string => Boolean(id))
      if (new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !validIds.has(id))) throw new Error('陪诊记录标识无效，请重新打开订单')
    }

    const writeField = (column: string): string => input.expectedOrder ? '?' : `COALESCE(?, \`${column}\`)`
    await connection.execute(
        `UPDATE \`HY_FACT_DDCX_NEW\` SET
        \`DD_state\` = ?,
        \`H_NAME\` = ${writeField('H_NAME')}, \`H_ADDRESS\` = ${writeField('H_ADDRESS')},
        \`H_KS\` = ${writeField('H_KS')}, \`H_YS\` = ${writeField('H_YS')},
        \`BBQ_XQ\` = ${writeField('BBQ_XQ')}, \`DATE_XQ\` = ${writeField('DATE_XQ')},
        \`BBQ_YD\` = ${writeField('BBQ_YD')}, \`DATE_YD\` = ${writeField('DATE_YD')},
        \`BBQ_QDFW\` = ${writeField('BBQ_QDFW')}, \`DATE_QDFW\` = ${writeField('DATE_QDFW')},
        \`BBQ_FK\` = ${writeField('BBQ_FK')}, \`DATE_FK\` = ${writeField('DATE_FK')},
        \`lastQueuingTime\` = ${writeField('lastQueuingTime')}
       WHERE \`DDBH\` = ?`,
      [input.orderStatus, input.hospitalId, input.hospitalAddressId,
        input.departmentId, input.doctorId,
        input.requestTime, input.requestTime?.slice(0, 8) ?? null,
        input.responseTime, input.responseTime?.slice(0, 8) ?? null,
        input.serviceStartTime, input.serviceStartTime?.slice(0, 8) ?? null,
        input.bookingFeedbackTime, input.bookingFeedbackTime?.slice(0, 8) ?? null,
        input.latestTicketTime,
        orderNo]
    )

    if (!input.expectedEscorts && input.escortList.length > 0) await connection.execute('DELETE FROM `fact_hy_pzrxx` WHERE `DDBH` = ?', [orderNo])
    if (input.expectedEscorts) {
      const retained = new Set(input.escortList.map((item) => item.id).filter(Boolean))
      for (const item of input.expectedEscorts) if (!retained.has(item.id)) {
        await connection.execute('DELETE FROM `fact_hy_pzrxx` WHERE `DDBH` = ? AND `ZJ` = ?', [orderNo, item.id])
      }
    }
    let sequence = 0
    const escortIds: string[] = []
    for (const escort of input.escortList) {
      if (!escort.escortId && (!input.expectedEscorts || (!escort.serviceDate && !escort.id))) continue
      sequence += 1
      const recordId = escort.id || (input.expectedEscorts ? `${orderNo}${randomUUID().replace(/-/g, '').slice(0, 16)}` : `${orderNo}${sequence}`)
      if (input.expectedEscorts && escort.id) {
        await connection.execute('UPDATE `fact_hy_pzrxx` SET `PZR` = ?, `BBQ_FW` = ?, `xtsj` = ? WHERE `DDBH` = ? AND `ZJ` = ?', [escort.escortId || null, escort.serviceDate, String(sequence), orderNo, recordId])
      } else if (input.expectedEscorts) {
        await connection.execute('INSERT INTO `fact_hy_pzrxx` (`DDBH`, `PZR`, `BBQ_FW`, `ZJ`, `xtsj`) VALUES (?, ?, ?, ?, ?)', [orderNo, escort.escortId || null, escort.serviceDate, recordId, String(sequence)])
      } else await connection.execute(
        `INSERT INTO \`fact_hy_pzrxx\` (\`DDBH\`, \`PZR\`, \`BBQ_FW\`, \`ZJ\`, \`xtsj\`)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE \`PZR\` = VALUES(\`PZR\`), \`BBQ_FW\` = VALUES(\`BBQ_FW\`), \`xtsj\` = VALUES(\`xtsj\`)`,
        [orderNo, escort.escortId || null, escort.serviceDate, recordId, String(sequence)]
      )
      escortIds.push(recordId)
    }
    await connection.commit()
    return { escortCount: input.escortList.filter((escort) => Boolean(escort.escortId)).length, escortIds }
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    connection.release()
  }
}

/**
 * 以泰康子订单号查询远端寰宇主表；命中后按 DDBH 回拉陪诊明细及附件快照，
 * 并以远端数据为准写入本地 PostgreSQL 三张寰宇表。
 *
 * 此函数严格只读远端 MySQL，不会触发推送或修改远端任何数据。
 */
export async function pullHuanyuOrderFromMysqlByChannelOrderNo(
  prisma: PrismaClient,
  channelOrderNo: string,
  orderIdToLink?: number
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
      if (orderIdToLink != null) {
        const linked = await tx.order.updateMany({
          where: { id: orderIdToLink, huanyuOrderNo: null },
          data: { huanyuOrderNo: ddbh }
        })
        if (linked.count !== 1) {
          throw new Error(`B 端订单 ${orderIdToLink} 已关联寰宇订单，无法回拉 ${ddbh}`)
        }
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
 * 挂号协助详情每次打开时，从远端主订单刷新五个远端权威字段到本地快照。
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
      .map((column, index) => {
        if (POSTGRES_NUMERIC_COLUMNS.has(column)) {
          return `"${column}" = CASE WHEN $${index + 1}::text = '' THEN NULL ELSE $${index + 1}::numeric END`
        }
        return `"${column}" = $${index + 1}`
      })
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
