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
    ssl: env.remoteDictDbSsl?.toLowerCase() === 'true' ? {} : undefined
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
  const channel = searchTerm(channelId).slice(0, 4)
  if (!channel) return []
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

/** BD 用户字典：userid_ 为码值，CAPTION_ 为展示名；仅支持码值/名称模糊搜索。 */
export async function listHuanyuBdUsers(rawSearch: unknown): Promise<HuanyuChannelOption[]> {
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(userid_ AS CHAR) AS id, CAPTION_ AS name
       FROM dim_bdyh
      WHERE (? = '' OR CAST(userid_ AS CHAR) LIKE CONCAT('%', ?, '%') OR CAPTION_ LIKE CONCAT('%', ?, '%'))
      ORDER BY userid_
      LIMIT 100`,
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
      LIMIT 100`,
    [search, search, search]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuHospitalAddresses(hospitalId: unknown, rawSearch: unknown): Promise<HuanyuChannelOption[]> {
  const hospital = searchTerm(hospitalId)
  if (!hospital) return []
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(DZ_ID AS CHAR) AS id, ADDRESS AS name
       FROM dim_yydz_20240307
      WHERE LEFT(CAST(DZ_ID AS CHAR), 4) = ?
        AND (? = '' OR ADDRESS LIKE CONCAT('%', ?, '%'))
      ORDER BY DZ_ID
      LIMIT 100`,
    [hospital, search, search]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuHospitalDepartments(hospitalId: unknown, rawSearch: unknown): Promise<HuanyuHospitalDepartmentOption[]> {
  const hospital = searchTerm(hospitalId)
  if (!hospital) return []
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
      LIMIT 100`,
    [hospital, search, search]
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    internalLevelOne: String(row.internalLevelOne ?? ''),
    internalLevelTwo: String(row.internalLevelTwo ?? '')
  }))
}

export async function listHuanyuHospitalDoctors(hospitalId: unknown, rawSearch: unknown): Promise<HuanyuDoctorOption[]> {
  const hospital = searchTerm(hospitalId)
  if (!hospital) return []
  const search = searchTerm(rawSearch)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(ID AS CHAR) AS id, name, ZC AS expertLevel
       FROM dim_hy_ys
      WHERE CAST(YY AS CHAR) = ?
        AND (? = '' OR name LIKE CONCAT('%', ?, '%'))
      ORDER BY ID
      LIMIT 100`,
    [hospital, search, search]
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
       LEFT JOIN DIM_CSLB AS sf ON CAST(pzr.sf AS CHAR) = CAST(sf.S_ID AS CHAR)
       LEFT JOIN DIM_CSLB AS cs ON CAST(pzr.cs AS CHAR) = CAST(cs.X_ID AS CHAR)
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
