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

export function getRemoteDictionaryPool(): Pool {
  return readOnlyPool()
}

function searchTerm(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 100) : ''
}

/**
 * 远端字典库访问约束：本文件仅保留固定的参数化 SELECT；不接收 SQL 片段、表名或排序字段。
 * 建议 REMOTE_DICT_DB_USER 同时配置为数据库层面的只读账号，以形成第二道保障。
 */
export async function listHuanyuChannels(rawSearch: unknown, currentId?: unknown): Promise<HuanyuChannelOption[]> {
  const search = searchTerm(rawSearch)
  const current = searchTerm(currentId)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM dim_hy_qd
      WHERE (? != '' AND (CAST(id AS CHAR) = ? OR name = ?))
         OR (? = '' OR CAST(id AS CHAR) LIKE CONCAT('%', ?, '%') OR name LIKE CONCAT('%', ?, '%'))
      ORDER BY (CASE WHEN ? != '' AND (CAST(id AS CHAR) = ? OR name = ?) THEN 0 ELSE 1 END), id
      LIMIT 100`,
    [current, current, current, search, search, search, current, current, current]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuChannelProducts(channelId: unknown, rawSearch: unknown, currentId?: unknown): Promise<HuanyuChannelProductOption[]> {
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
  const current = searchTerm(currentId)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name, nbyjcp, nbejcp, CPJG AS price
       FROM dim_hy_qd_cp
      WHERE LEFT(CAST(id AS CHAR), 4) = ?
        AND (
          (? != '' AND (CAST(id AS CHAR) = ? OR name = ?))
          OR (? = '' OR name LIKE CONCAT('%', ?, '%'))
        )
      ORDER BY (CASE WHEN ? != '' AND (CAST(id AS CHAR) = ? OR name = ?) THEN 0 ELSE 1 END), id
      LIMIT 100`,
    [channel, current, current, current, search, search, current, current, current]
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

/** 按渠道码值精确读取渠道，用于校验后台保存的业务映射仍指向有效维表项。 */
export async function findHuanyuChannelById(id: string): Promise<HuanyuChannelOption | null> {
  const target = searchTerm(id)
  if (!target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM dim_hy_qd
      WHERE CAST(id AS CHAR) = ?
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

const channelProductMemCache = new Map<string, { item: HuanyuChannelProductOption | null; expiresAt: number }>()

/**
 * 批量按 B 端渠道服务项目码值读取产品维表信息。列表页批量渲染时使用，
 * 内置 10 分钟内存缓存，避免对字典库产生高频重复查询。
 */
export async function findHuanyuChannelProductsByIds(ids: unknown[]): Promise<Map<string, HuanyuChannelProductOption>> {
  const result = new Map<string, HuanyuChannelProductOption>()
  const cleanIds = Array.from(new Set(ids.map(searchTerm).filter(Boolean))) as string[]
  if (cleanIds.length === 0) return result

  const now = Date.now()
  const missingIds: string[] = []
  for (const id of cleanIds) {
    const cached = channelProductMemCache.get(id)
    if (cached && cached.expiresAt > now) {
      if (cached.item) result.set(id, cached.item)
    } else {
      missingIds.push(id)
    }
  }

  if (missingIds.length > 0) {
    try {
      const placeholders = missingIds.map(() => '?').join(', ')
      const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
        `SELECT CAST(id AS CHAR) AS id, name, nbyjcp, nbejcp, CPJG AS price
           FROM dim_hy_qd_cp
          WHERE CAST(id AS CHAR) IN (${placeholders})`,
        missingIds
      )
      const foundIds = new Set<string>()
      for (const row of rows) {
        const item: HuanyuChannelProductOption = {
          id: String(row.id),
          name: String(row.name ?? ''),
          internalLevelOne: String(row.nbyjcp ?? ''),
          internalLevelTwo: String(row.nbejcp ?? ''),
          price: row.price == null ? '' : String(row.price)
        }
        foundIds.add(item.id)
        result.set(item.id, item)
        channelProductMemCache.set(item.id, { item, expiresAt: now + 10 * 60 * 1000 })
      }
      for (const id of missingIds) {
        if (!foundIds.has(id)) {
          channelProductMemCache.set(id, { item: null, expiresAt: now + 2 * 60 * 1000 })
        }
      }
    } catch {
      // 容错处理
    }
  }

  return result
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
export async function listHuanyuBdUsers(rawSearch: unknown, currentId?: unknown): Promise<HuanyuChannelOption[]> {
  const search = searchTerm(rawSearch)
  const current = searchTerm(currentId)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(userid_ AS CHAR) AS id, CAPTION_ AS name
       FROM dim_bdyh
      WHERE (? != '' AND (CAST(userid_ AS CHAR) = ? OR CAPTION_ = ?))
         OR (? = '' OR CAST(userid_ AS CHAR) LIKE CONCAT('%', ?, '%') OR CAPTION_ LIKE CONCAT('%', ?, '%'))
      ORDER BY (CASE WHEN ? != '' AND (CAST(userid_ AS CHAR) = ? OR CAPTION_ = ?) THEN 0 ELSE 1 END), userid_
      LIMIT 200`,
    [current, current, current, search, search, search, current, current, current]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuHospitals(rawSearch: unknown, currentId?: unknown): Promise<HuanyuChannelOption[]> {
  const search = searchTerm(rawSearch)
  const current = searchTerm(currentId)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM dim_hy_yywh
      WHERE (? != '' AND (CAST(id AS CHAR) = ? OR name = ?))
         OR (? = '' OR CAST(id AS CHAR) LIKE CONCAT('%', ?, '%') OR name LIKE CONCAT('%', ?, '%'))
      ORDER BY (CASE WHEN ? != '' AND (CAST(id AS CHAR) = ? OR name = ?) THEN 0 ELSE 1 END), id
      LIMIT 200`,
    [current, current, current, search, search, search, current, current, current]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuHospitalAddresses(hospitalId: unknown, rawSearch: unknown, currentId?: unknown): Promise<HuanyuChannelOption[]> {
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
  const current = searchTerm(currentId)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(DZ_ID AS CHAR) AS id, ADDRESS AS name
       FROM dim_yydz_20240307
      WHERE LEFT(CAST(DZ_ID AS CHAR), 4) = ?
        AND (
          (? != '' AND (CAST(DZ_ID AS CHAR) = ? OR ADDRESS = ?))
          OR (? = '' OR ADDRESS LIKE CONCAT('%', ?, '%'))
        )
      ORDER BY (CASE WHEN ? != '' AND (CAST(DZ_ID AS CHAR) = ? OR ADDRESS = ?) THEN 0 ELSE 1 END), DZ_ID
      LIMIT 200`,
    [hospital, current, current, current, search, search, current, current, current]
  )
  return rows.map((row) => ({ id: String(row.id), name: String(row.name ?? '') }))
}

export async function listHuanyuHospitalDepartments(hospitalId: unknown, rawSearch: unknown, currentId?: unknown): Promise<HuanyuHospitalDepartmentOption[]> {
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
  const current = searchTerm(currentId)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(ks.ID AS CHAR) AS id,
            ks.NAME AS name,
            COALESCE(kswh.name, '') AS internalLevelOne,
            COALESCE(xfks.name, '') AS internalLevelTwo
       FROM dim_hy_yy_ks AS ks
       LEFT JOIN dim_hy_kswh AS kswh ON CAST(kswh.id AS CHAR) = CAST(ks.ksdl AS CHAR)
       LEFT JOIN dim_hy_xfks AS xfks ON CAST(xfks.id AS CHAR) = CAST(ks.ksxf AS CHAR)
      WHERE CAST(ks.id_yy AS CHAR) = ?
        AND (
          (? != '' AND (CAST(ks.ID AS CHAR) = ? OR ks.NAME = ?))
          OR (? = '' OR ks.NAME LIKE CONCAT('%', ?, '%'))
        )
      ORDER BY (CASE WHEN ? != '' AND (CAST(ks.ID AS CHAR) = ? OR ks.NAME = ?) THEN 0 ELSE 1 END), ks.ID
      LIMIT 200`,
    [hospital, current, current, current, search, search, current, current, current]
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.NAME ?? row.name ?? '').trim(),
    internalLevelOne: String(row.internalLevelOne ?? ''),
    internalLevelTwo: String(row.internalLevelTwo ?? '')
  }))
}

export async function listHuanyuHospitalDoctors(hospitalId: unknown, departmentId: unknown, rawSearch: unknown, currentId?: unknown): Promise<HuanyuDoctorOption[]> {
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
  // 若传入的是科室名称而非 8 位科室编码，自动逆查对应的科室 ID
  if (!/^\d{8}$/.test(department)) {
    const [ksRows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(ID AS CHAR) AS id FROM dim_hy_yy_ks WHERE id_yy = ? AND (NAME = ? OR id = ?) LIMIT 1`,
      [hospital, department, department]
    )
    if (ksRows[0]?.id) {
      department = String(ksRows[0].id)
    }
  }
  const search = searchTerm(rawSearch)
  const current = searchTerm(currentId)
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(ID AS CHAR) AS id, NAME AS name, ZC AS expertLevel
       FROM dim_hy_ys
      WHERE CAST(YY AS CHAR) = ?
        AND (CAST(dwks AS CHAR) = ? OR dwks LIKE CONCAT('%', ?, '%'))
        AND (
          (? != '' AND (CAST(ID AS CHAR) = ? OR NAME = ?))
          OR (? = '' OR CAST(ID AS CHAR) LIKE CONCAT('%', ?, '%') OR NAME LIKE CONCAT('%', ?, '%'))
        )
      ORDER BY (CASE WHEN ? != '' AND (CAST(ID AS CHAR) = ? OR NAME = ?) THEN 0 ELSE 1 END), ID
      LIMIT 200`,
    [hospital, department, department, current, current, current, search, search, search, current, current, current]
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.NAME ?? row.name ?? '').trim(),
    expertLevel: String(row.expertLevel ?? '')
  }))
}

export async function listHuanyuEscorts(rawSearch: unknown, currentId?: unknown): Promise<HuanyuEscortOption[]> {
  const search = searchTerm(rawSearch)
  const current = searchTerm(currentId)
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
      WHERE (
        (? != '' AND (CAST(pzr.id AS CHAR) = ? OR pzr.name = ?))
        OR (? = '' OR CAST(pzr.id AS CHAR) LIKE CONCAT('%', ?, '%') OR pzr.name LIKE CONCAT('%', ?, '%') OR pzr.sj LIKE CONCAT('%', ?, '%'))
      )
      ORDER BY (CASE WHEN ? != '' AND (CAST(pzr.id AS CHAR) = ? OR pzr.name = ?) THEN 0 ELSE 1 END), pzr.id
      LIMIT 200`,
    [current, current, current, search, search, search, search, current, current, current]
  )
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    escortType: String(row.escortType ?? ''),
    phone: String(row.phone ?? ''),
    area: String(row.area ?? '')
  }))
}

export async function findHuanyuEscortById(idOrName: string): Promise<HuanyuEscortOption | null> {
  const target = searchTerm(idOrName)
  if (!target) return null
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
      WHERE CAST(pzr.id AS CHAR) = ? OR pzr.name = ?
      LIMIT 1`,
    [target, target]
  )
  const row = rows[0]
  return row ? {
    id: String(row.id),
    name: String(row.name ?? ''),
    escortType: String(row.escortType ?? ''),
    phone: String(row.phone ?? ''),
    area: String(row.area ?? '')
  } : null
}

export async function findHuanyuHospitalById(idOrName: string): Promise<HuanyuChannelOption | null> {
  const target = searchTerm(idOrName)
  if (!target) return null
  // 1. 先按 4 位 ID 精确查
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM dim_hy_yywh
      WHERE CAST(id AS CHAR) = ? OR name = ?
      LIMIT 1`,
    [target, target]
  )
  if (rows[0]) {
    return { id: String(rows[0].id), name: String(rows[0].name ?? '') }
  }

  // 2. 若传入的是名称，尝试全称包含简称查找（例如传入“北京协和医院”匹配到“中国医学科学院北京协和医院”）
  if (target.length >= 4) {
    const [likeRows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id, name
         FROM dim_hy_yywh
        WHERE name LIKE CONCAT('%', ?, '%') OR ? LIKE CONCAT('%', name, '%')
        ORDER BY LENGTH(name) ASC
        LIMIT 1`,
      [target, target]
    )
    if (likeRows[0]) {
      return { id: String(likeRows[0].id), name: String(likeRows[0].name ?? '') }
    }
  }

  return null
}

export async function findHuanyuDepartmentById(id: string): Promise<HuanyuHospitalDepartmentOption | null> {
  const target = searchTerm(id)
  if (!target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(ks.ID AS CHAR) AS id,
            ks.NAME AS name,
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
    name: String(row.NAME ?? row.name ?? '').trim(),
    internalLevelOne: String(row.internalLevelOne ?? ''),
    internalLevelTwo: String(row.internalLevelTwo ?? '')
  } : null
}

export async function findHuanyuDoctorById(id: string): Promise<HuanyuDoctorOption | null> {
  const target = searchTerm(id)
  if (!target) return null
  const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
    `SELECT CAST(ID AS CHAR) AS id, NAME AS name, ZC AS expertLevel
       FROM dim_hy_ys
      WHERE CAST(ID AS CHAR) = ?
      LIMIT 1`,
    [target]
  )
  const row = rows[0]
  return row ? {
    id: String(row.id),
    name: String(row.NAME ?? row.name ?? '').trim(),
    expertLevel: String(row.expertLevel ?? '')
  } : null
}

const doctorIdCache = new Map<string, { ids: string[]; expiresAt: number }>()
const deptIdCache = new Map<string, { ids: string[]; expiresAt: number }>()
const hospitalIdCache = new Map<string, { ids: string[]; expiresAt: number }>()
const productIdCache = new Map<string, { ids: string[]; expiresAt: number }>()

/**
 * 按医生名称（模糊/精确）反查所有匹配的医生维表 ID。
 * 供搜索框输入中文时穿透查询底层可能存为医生编码的订单。
 */
export async function findHuanyuDoctorIdsByName(name: string): Promise<string[]> {
  const target = searchTerm(name)
  if (!target) return []
  const now = Date.now()
  const cached = doctorIdCache.get(target)
  if (cached && cached.expiresAt > now) {
    return cached.ids
  }
  try {
    const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(ID AS CHAR) AS id
         FROM dim_hy_ys
        WHERE NAME LIKE CONCAT('%', ?, '%')
        LIMIT 100`,
      [target]
    )
    const ids = Array.from(new Set(rows.map((r) => String(r.id)).filter(Boolean)))
    doctorIdCache.set(target, { ids, expiresAt: now + 5 * 60 * 1000 })
    return ids
  } catch {
    return []
  }
}

/**
 * 按科室名称（模糊/精确）反查所有匹配的科室维表 ID。
 */
export async function findHuanyuDepartmentIdsByName(name: string): Promise<string[]> {
  const target = searchTerm(name)
  if (!target) return []
  const now = Date.now()
  const cached = deptIdCache.get(target)
  if (cached && cached.expiresAt > now) {
    return cached.ids
  }
  try {
    const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(ID AS CHAR) AS id
         FROM dim_hy_yy_ks
        WHERE NAME LIKE CONCAT('%', ?, '%')
        LIMIT 100`,
      [target]
    )
    const ids = Array.from(new Set(rows.map((r) => String(r.id)).filter(Boolean)))
    deptIdCache.set(target, { ids, expiresAt: now + 5 * 60 * 1000 })
    return ids
  } catch {
    return []
  }
}

/**
 * 按医院名称（模糊/精确）反查所有匹配的医院维表 ID。
 */
export async function findHuanyuHospitalIdsByName(name: string): Promise<string[]> {
  const target = searchTerm(name)
  if (!target) return []
  const now = Date.now()
  const cached = hospitalIdCache.get(target)
  if (cached && cached.expiresAt > now) {
    return cached.ids
  }
  try {
    const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id
         FROM dim_hy_yywh
        WHERE name LIKE CONCAT('%', ?, '%')
        LIMIT 100`,
      [target]
    )
    const ids = Array.from(new Set(rows.map((r) => String(r.id)).filter(Boolean)))
    hospitalIdCache.set(target, { ids, expiresAt: now + 5 * 60 * 1000 })
    return ids
  } catch {
    return []
  }
}

/**
 * 按渠道产品/服务项目名称（模糊/精确）反查所有匹配的产品维表 ID。
 */
export async function findHuanyuProductIdsByName(name: string): Promise<string[]> {
  const target = searchTerm(name)
  if (!target) return []
  const now = Date.now()
  const cached = productIdCache.get(target)
  if (cached && cached.expiresAt > now) {
    return cached.ids
  }
  try {
    const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id
         FROM dim_hy_qd_cp
        WHERE name LIKE CONCAT('%', ?, '%')
        LIMIT 100`,
      [target]
    )
    const ids = Array.from(new Set(rows.map((r) => String(r.id)).filter(Boolean)))
    productIdCache.set(target, { ids, expiresAt: now + 5 * 60 * 1000 })
    return ids
  } catch {
    return []
  }
}

const hospitalMemCache = new Map<string, { item: HuanyuChannelOption | null; expiresAt: number }>()
const deptMemCache = new Map<string, { item: HuanyuHospitalDepartmentOption | null; expiresAt: number }>()
const doctorMemCache = new Map<string, { item: HuanyuDoctorOption | null; expiresAt: number }>()

/**
 * 批量按医院 ID 查医院维表信息（带 10 分钟内存缓存）。供列表批量装配使用。
 */
export async function findHuanyuHospitalsByIds(ids: unknown[]): Promise<Map<string, HuanyuChannelOption>> {
  const result = new Map<string, HuanyuChannelOption>()
  const cleanIds = Array.from(new Set(ids.map(searchTerm).filter(Boolean))) as string[]
  if (cleanIds.length === 0) return result

  const now = Date.now()
  const missingIds: string[] = []
  for (const id of cleanIds) {
    const cached = hospitalMemCache.get(id)
    if (cached && cached.expiresAt > now) {
      if (cached.item) result.set(id, cached.item)
    } else {
      missingIds.push(id)
    }
  }

  if (missingIds.length > 0) {
    try {
      const placeholders = missingIds.map(() => '?').join(', ')
      const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
        `SELECT CAST(id AS CHAR) AS id, name
           FROM dim_hy_yywh
          WHERE CAST(id AS CHAR) IN (${placeholders})`,
        missingIds
      )
      const foundIds = new Set<string>()
      for (const row of rows) {
        const item: HuanyuChannelOption = {
          id: String(row.id),
          name: String(row.name ?? '')
        }
        foundIds.add(item.id)
        result.set(item.id, item)
        hospitalMemCache.set(item.id, { item, expiresAt: now + 10 * 60 * 1000 })
      }
      for (const id of missingIds) {
        if (!foundIds.has(id)) {
          hospitalMemCache.set(id, { item: null, expiresAt: now + 2 * 60 * 1000 })
        }
      }
    } catch {
      // 容错处理
    }
  }
  return result
}

/**
 * 批量按科室 ID 查科室维表信息（带 10 分钟内存缓存）。供列表批量装配使用。
 */
export async function findHuanyuDepartmentsByIds(ids: unknown[]): Promise<Map<string, HuanyuHospitalDepartmentOption>> {
  const result = new Map<string, HuanyuHospitalDepartmentOption>()
  const cleanIds = Array.from(new Set(ids.map(searchTerm).filter(Boolean))) as string[]
  if (cleanIds.length === 0) return result

  const now = Date.now()
  const missingIds: string[] = []
  for (const id of cleanIds) {
    const cached = deptMemCache.get(id)
    if (cached && cached.expiresAt > now) {
      if (cached.item) result.set(id, cached.item)
    } else {
      missingIds.push(id)
    }
  }

  if (missingIds.length > 0) {
    try {
      const placeholders = missingIds.map(() => '?').join(', ')
      const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
        `SELECT CAST(ks.ID AS CHAR) AS id,
                ks.NAME AS name,
                COALESCE(kswh.name, '') AS internalLevelOne,
                COALESCE(xfks.name, '') AS internalLevelTwo
           FROM dim_hy_yy_ks AS ks
           LEFT JOIN dim_hy_kswh AS kswh ON CAST(kswh.id AS CHAR) = CAST(ks.ksdl AS CHAR)
           LEFT JOIN dim_hy_xfks AS xfks ON CAST(xfks.id AS CHAR) = CAST(ks.ksxf AS CHAR)
          WHERE CAST(ks.ID AS CHAR) IN (${placeholders})`,
        missingIds
      )
      const foundIds = new Set<string>()
      for (const row of rows) {
        const item: HuanyuHospitalDepartmentOption = {
          id: String(row.id),
          name: String(row.NAME ?? row.name ?? '').trim(),
          internalLevelOne: String(row.internalLevelOne ?? ''),
          internalLevelTwo: String(row.internalLevelTwo ?? '')
        }
        foundIds.add(item.id)
        result.set(item.id, item)
        deptMemCache.set(item.id, { item, expiresAt: now + 10 * 60 * 1000 })
      }
      for (const id of missingIds) {
        if (!foundIds.has(id)) {
          deptMemCache.set(id, { item: null, expiresAt: now + 2 * 60 * 1000 })
        }
      }
    } catch {
      // 容错处理
    }
  }
  return result
}

/**
 * 批量按医生 ID 查医生维表信息（带 10 分钟内存缓存）。供列表批量装配使用。
 */
export async function findHuanyuDoctorsByIds(ids: unknown[]): Promise<Map<string, HuanyuDoctorOption>> {
  const result = new Map<string, HuanyuDoctorOption>()
  const cleanIds = Array.from(new Set(ids.map(searchTerm).filter(Boolean))) as string[]
  if (cleanIds.length === 0) return result

  const now = Date.now()
  const missingIds: string[] = []
  for (const id of cleanIds) {
    const cached = doctorMemCache.get(id)
    if (cached && cached.expiresAt > now) {
      if (cached.item) result.set(id, cached.item)
    } else {
      missingIds.push(id)
    }
  }

  if (missingIds.length > 0) {
    try {
      const placeholders = missingIds.map(() => '?').join(', ')
      const [rows] = await readOnlyPool().execute<RowDataPacket[]>(
        `SELECT CAST(ID AS CHAR) AS id, NAME AS name, ZC AS expertLevel
           FROM dim_hy_ys
          WHERE CAST(ID AS CHAR) IN (${placeholders})`,
        missingIds
      )
      const foundIds = new Set<string>()
      for (const row of rows) {
        const item: HuanyuDoctorOption = {
          id: String(row.id),
          name: String(row.NAME ?? row.name ?? '').trim(),
          expertLevel: String(row.expertLevel ?? '')
        }
        foundIds.add(item.id)
        result.set(item.id, item)
        doctorMemCache.set(item.id, { item, expiresAt: now + 10 * 60 * 1000 })
      }
      for (const id of missingIds) {
        if (!foundIds.has(id)) {
          doctorMemCache.set(id, { item: null, expiresAt: now + 2 * 60 * 1000 })
        }
      }
    } catch {
      // 容错处理
    }
  }
  return result
}


