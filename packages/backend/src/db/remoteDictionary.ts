import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import { getEnv } from '../env.js'

export interface HuanyuChannelOption {
  id: string
  name: string
}

export interface HuanyuChannelProductOption extends HuanyuChannelOption {
  internalLevelOne: string
  internalLevelTwo: string
  price: string
}

export interface HuanyuHospitalDepartmentOption extends HuanyuChannelOption {
  internalLevelOne: string
  internalLevelTwo: string
}

export interface HuanyuDoctorOption extends HuanyuChannelOption {
  expertLevel: string
}

export interface HuanyuEscortOption extends HuanyuChannelOption {
  escortType: string
  phone: string
  area: string
}

let dictionaryPool: Pool | null = null

function readOnlyPool(): Pool {
  if (dictionaryPool) return dictionaryPool

  const env = getEnv()
  const required = {
    REMOTE_DICT_DB_HOST: env.remoteDictDbHost,
    REMOTE_DICT_DB_PORT: env.remoteDictDbPort,
    REMOTE_DICT_DB_NAME: env.remoteDictDbName,
    REMOTE_DICT_DB_USER: env.remoteDictDbUser,
    REMOTE_DICT_DB_PASSWORD: env.remoteDictDbPassword
  }
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`远端字典库未配置：缺少 ${missing.join('、')}`)
  }

  const port = Number(env.remoteDictDbPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('REMOTE_DICT_DB_PORT 必须是 1-65535 之间的端口号')
  }

  dictionaryPool = mysql.createPool({
    host: env.remoteDictDbHost,
    port,
    database: env.remoteDictDbName,
    user: env.remoteDictDbUser,
    password: env.remoteDictDbPassword,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    multipleStatements: false,
    ssl: env.remoteDictDbSsl?.toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined
  })
  return dictionaryPool
}

function searchTerm(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 100) : ''
}

/**
 * 远端字典库访问约束：本文件仅保留固定的参数化 SELECT；不接收 SQL 片段、表名或排序字段。
 * 建议 REMOTE_DICT_DB_USER 同时配置为数据库层面的只读账号，以形成第二道保障。
 */
export async function listHuanyuChannels(rawSearch: unknown): Promise<HuanyuChannelOption[]> {
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM dim_hy_qd
      WHERE (? = '' OR CAST(id AS CHAR) LIKE CONCAT('%', ?, '%') OR name LIKE CONCAT('%', ?, '%'))
      ORDER BY id
      LIMIT 100`,
    [search, search, search]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuChannelProducts(channelId: unknown, rawSearch: unknown): Promise<HuanyuChannelProductOption[]> {
  let channel = searchTerm(channelId).slice(0, 4)
  if (!channel) return []
  if (!/^\d{4}$/.test(channel)) {
    const [cRows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id FROM dim_hy_qd WHERE name = ? OR id = ? LIMIT 1`,
      [channel, channel]
    )
    if (cRows[0]?.id) channel = String(cRows[0].id)
  }
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name, nbyjcp, nbejcp, CPJG AS price
       FROM dim_hy_qd_cp
      WHERE LEFT(CAST(id AS CHAR), 4) = ?
        AND (? = '' OR name LIKE CONCAT('%', ?, '%'))
      ORDER BY id
      LIMIT 100`,
    [channel, search, search]
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    internalLevelOne: String(row.nbyjcp ?? ''),
    internalLevelTwo: String(row.nbejcp ?? ''),
    price: row.price == null ? '' : String(row.price)
  }))
}

/**
 * 按展示名称精确取渠道码值。用于泰康订单自动落寰宇订单时的固定映射，
 * 不使用模糊匹配，避免相近名称被误写入订单。
 */
export async function findHuanyuChannelByName(name: string): Promise<HuanyuChannelOption | null> {
  const target = searchTerm(name)
  if (!target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM dim_hy_qd
      WHERE name = ?
      ORDER BY id
      LIMIT 1`,
    [target]
  )
  const row = rows[0]
  return row ? { id: String(row.id), name: String(row.name ?? '') } : null
}

/** 按渠道和服务项目展示名称精确取服务项目码值；全程只执行参数化 SELECT。 */
export async function findHuanyuChannelProductByName(channelId: string, name: string): Promise<HuanyuChannelProductOption | null> {
  const channel = searchTerm(channelId).slice(0, 4)
  const target = searchTerm(name)
  if (!channel || !target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name, nbyjcp, nbejcp, CPJG AS price
       FROM dim_hy_qd_cp
      WHERE LEFT(CAST(id AS CHAR), 4) = ?
        AND name = ?
      ORDER BY id
      LIMIT 1`,
    [channel, target]
  )
  const row = rows[0]
  return row
    ? {
        id: String(row.id),
        name: String(row.name ?? ''),
        internalLevelOne: String(row.nbyjcp ?? ''),
        internalLevelTwo: String(row.nbejcp ?? ''),
        price: row.price == null ? '' : String(row.price)
      }
    : null
}

/**
 * 按 B 端渠道服务项目码值读取衍生字段。订单详情页加载时使用该方法，
 * 全程为固定、参数化的只读 SELECT。
 */
export async function findHuanyuChannelProductById(id: unknown): Promise<HuanyuChannelProductOption | null> {
  const target = searchTerm(id)
  if (!target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name, nbyjcp, nbejcp, CPJG AS price
       FROM dim_hy_qd_cp
      WHERE CAST(id AS CHAR) = ?
      LIMIT 1`,
    [target]
  )
  const row = rows[0]
  return row
    ? {
        id: String(row.id),
        name: String(row.name ?? ''),
        internalLevelOne: String(row.nbyjcp ?? ''),
        internalLevelTwo: String(row.nbejcp ?? ''),
        price: row.price == null ? '' : String(row.price)
      }
    : null
}

/** 按 BD 用户码值精确读取名称，供客户经理字段自动带出。 */
export async function findHuanyuBdUserNameByUserId(userId: string): Promise<string | null> {
  const target = searchTerm(userId)
  if (!target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAPTION_ AS name
       FROM dim_bdyh
      WHERE CAST(userid_ AS CHAR) = ?
      ORDER BY userid_
      LIMIT 1`,
    [target]
  )
  return rows[0] ? String(rows[0].name ?? '').trim() || null : null
}

/** BD 用户字典：userid_ 为码值，CAPTION_ 为展示名；仅支持码值/名称模糊搜索。 */
export async function listHuanyuBdUsers(rawSearch: unknown): Promise<HuanyuChannelOption[]> {
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(userid_ AS CHAR) AS id, CAPTION_ AS name
       FROM dim_bdyh
      WHERE (? = '' OR CAST(userid_ AS CHAR) LIKE CONCAT('%', ?, '%') OR CAPTION_ LIKE CONCAT('%', ?, '%'))
      ORDER BY userid_
      LIMIT 500`,
    [search, search, search]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuHospitals(rawSearch: unknown): Promise<HuanyuChannelOption[]> {
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM dim_hy_yywh
      WHERE (? = '' OR CAST(id AS CHAR) LIKE CONCAT('%', ?, '%') OR name LIKE CONCAT('%', ?, '%'))
      ORDER BY id
      LIMIT 1000`,
    [search, search, search]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuHospitalAddresses(hospitalId: unknown, rawSearch: unknown): Promise<HuanyuChannelOption[]> {
  let hospital = searchTerm(hospitalId)
  if (!hospital) return []
  if (!/^\d{4}$/.test(hospital)) {
    const [hRows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id FROM dim_hy_yywh WHERE name = ? OR id = ? LIMIT 1`,
      [hospital, hospital]
    )
    if (hRows[0]?.id) hospital = String(hRows[0].id)
  }
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(DZ_ID AS CHAR) AS id, ADDRESS AS name
       FROM dim_yydz_20240307
      WHERE LEFT(CAST(DZ_ID AS CHAR), 4) = ?
        AND (? = '' OR ADDRESS LIKE CONCAT('%', ?, '%'))
      ORDER BY DZ_ID
      LIMIT 500`,
    [hospital, search, search]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuHospitalDepartments(hospitalId: unknown, rawSearch: unknown): Promise<HuanyuHospitalDepartmentOption[]> {
  let hospital = searchTerm(hospitalId)
  if (!hospital) return []
  if (!/^\d{4}$/.test(hospital)) {
    const [hRows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id FROM dim_hy_yywh WHERE name = ? OR id = ? LIMIT 1`,
      [hospital, hospital]
    )
    if (hRows[0]?.id) hospital = String(hRows[0].id)
  }
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(ks.ID AS CHAR) AS id,
            ks.name,
            COALESCE(kswh.name, '') AS internalLevelOne,
            COALESCE(xfks.name, '') AS internalLevelTwo
       FROM dim_hy_yy_ks AS ks
       LEFT JOIN dim_hy_kswh AS kswh ON CAST(kswh.id AS CHAR) = CAST(ks.ksdl AS CHAR)
       LEFT JOIN dim_hy_xfks AS xfks ON CAST(xfks.id AS CHAR) = CAST(ks.ksxf AS CHAR)
      WHERE CAST(ks.id_yy AS CHAR) = ?
        AND (? = '' OR ks.name LIKE CONCAT('%', ?, '%'))
      ORDER BY ks.ID
      LIMIT 500`,
    [hospital, search, search]
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    internalLevelOne: String(row.internalLevelOne ?? ''),
    internalLevelTwo: String(row.internalLevelTwo ?? '')
  }))
}

export async function listHuanyuHospitalDoctors(hospitalId: unknown, departmentId: unknown, rawSearch: unknown): Promise<HuanyuDoctorOption[]> {
  let hospital = searchTerm(hospitalId)
  let department = searchTerm(departmentId)
  if (!hospital || !department) return []
  if (!/^\d{4}$/.test(hospital)) {
    const [hRows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id FROM dim_hy_yywh WHERE name = ? OR id = ? LIMIT 1`,
      [hospital, hospital]
    )
    if (hRows[0]?.id) hospital = String(hRows[0].id)
  }
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(ID AS CHAR) AS id, name, ZC AS expertLevel
       FROM dim_hy_ys
      WHERE CAST(YY AS CHAR) = ?
        AND (CAST(dwks AS CHAR) = ? OR dwks LIKE CONCAT('%', ?, '%'))
        AND (? = '' OR CAST(ID AS CHAR) LIKE CONCAT('%', ?, '%') OR name LIKE CONCAT('%', ?, '%'))
      ORDER BY ID
      LIMIT 100`,
    [hospital, department, department, search, search, search]
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    expertLevel: String(row.expertLevel ?? '')
  }))
}

export async function listHuanyuEscorts(rawSearch: unknown): Promise<HuanyuEscortOption[]> {
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(pzr.id AS CHAR) AS id,
            pzr.name,
            pzr.pzrlx AS escortType,
            pzr.sj AS phone,
            CONCAT(COALESCE(sf.S_NAME, ''), '-', COALESCE(cs.X_NAME, '')) AS area
       FROM dim_hy_pzr AS pzr
       LEFT JOIN (
         SELECT CAST(S_ID AS CHAR) AS S_ID, MAX(S_NAME) AS S_NAME
           FROM DIM_CSLB
          GROUP BY S_ID
       ) AS sf ON CAST(pzr.sf AS CHAR) = sf.S_ID
       LEFT JOIN (
         SELECT CAST(X_ID AS CHAR) AS X_ID, MAX(X_NAME) AS X_NAME
           FROM DIM_CSLB
          GROUP BY X_ID
       ) AS cs ON CAST(pzr.cs AS CHAR) = cs.X_ID
      WHERE (? = '' OR CAST(pzr.id AS CHAR) LIKE CONCAT('%', ?, '%') OR pzr.name LIKE CONCAT('%', ?, '%'))
      ORDER BY pzr.id
      LIMIT 100`,
    [search, search, search]
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    escortType: String(row.escortType ?? ''),
    phone: String(row.phone ?? ''),
    area: String(row.area ?? '')
  }))
}

export async function findHuanyuHospitalById(id: string): Promise<HuanyuChannelOption | null> {
  const target = searchTerm(id)
  if (!target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM dim_hy_yywh
      WHERE CAST(id AS CHAR) = ?
      LIMIT 1`,
    [target]
  )
  const row = rows[0]
  return row ? { id: String(row.id), name: String(row.name ?? '') } : null
}

export async function findHuanyuDepartmentById(id: string): Promise<HuanyuHospitalDepartmentOption | null> {
  const target = searchTerm(id)
  if (!target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(ks.ID AS CHAR) AS id,
            ks.name,
            COALESCE(kswh.name, '') AS internalLevelOne,
            COALESCE(xfks.name, '') AS internalLevelTwo
       FROM dim_hy_yy_ks AS ks
       LEFT JOIN dim_hy_kswh AS kswh ON CAST(kswh.id AS CHAR) = CAST(ks.ksdl AS CHAR)
       LEFT JOIN dim_hy_xfks AS xfks ON CAST(xfks.id AS CHAR) = CAST(ks.ksxf AS CHAR)
      WHERE CAST(ks.ID AS CHAR) = ?
      LIMIT 1`,
    [target]
  )
  const row = rows[0]
  return row ? {
    id: String(row.id),
    name: String(row.name ?? ''),
    internalLevelOne: String(row.internalLevelOne ?? ''),
    internalLevelTwo: String(row.internalLevelTwo ?? '')
  } : null
}

export async function findHuanyuDoctorById(id: string): Promise<HuanyuDoctorOption | null> {
  const target = searchTerm(id)
  if (!target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(ID AS CHAR) AS id, name, ZC AS expertLevel
       FROM dim_hy_ys
      WHERE CAST(ID AS CHAR) = ?
      LIMIT 1`,
    [target]
  )
  const row = rows[0]
  return row ? {
    id: String(row.id),
    name: String(row.name ?? ''),
    expertLevel: String(row.expertLevel ?? '')
  } : null
}
