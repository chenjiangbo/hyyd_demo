import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { getRemoteDictionaryPool } from '../db/remoteDictionary.js'

export interface MasterSaveInput {
  hospital?: string | null
  hospitalAddress?: string | null
  department?: string | null
  doctor?: string | null
  escortList?: Array<{ escortName?: string; phone?: string }>
}

export interface MasterSaveCreation {
  type: 'hospital' | 'address' | 'department' | 'doctor' | 'escort'
  name: string
  parent?: string
}

export interface MasterSaveResolution {
  hospital: string | null
  hospitalAddress: string | null
  department: string | null
  doctor: string | null
  escortIds: Array<string | null>
  creations: MasterSaveCreation[]
}

type Db = Pick<PoolConnection, 'execute'>
type Row = RowDataPacket & Record<string, unknown>
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const invalid = /^(未明确|未知|暂无|无|待定|待确认|不详|空|未填写|待补|随便|待选|未显示医生姓名|none|null|undefined|\/|-)$/i

function validName(value: string, label: string): void {
  if (value.length < 2 || invalid.test(value) || /^\d+$/.test(value)) throw new Error(`${label}名称无效，请核对后保存`)
  if (value.length > (label === '医院地址' ? 200 : 100)) throw new Error(`${label}名称过长，请核对后保存`)
}

async function rows(db: Db, sql: string, values: any[]): Promise<Row[]> {
  const [result] = await db.execute<RowDataPacket[]>(sql, values)
  return result as Row[]
}

function one(found: Row[], label: string): Row | null {
  if (found.length > 1) throw new Error(`${label}存在多条匹配档案，请从下拉列表选择准确记录`)
  return found[0] ?? null
}

async function byIdThenName(db: Db, idSql: string, idValues: unknown[], nameSql: string, nameValues: unknown[], label: string): Promise<Row | null> {
  const id = one(await rows(db, idSql, idValues), label)
  return id ?? one(await rows(db, nameSql, nameValues), label)
}

async function nextId(db: Db, table: 'f_hy_yywh' | 'f_hy_ys' | 'f_hy_pzr', width: number): Promise<string> {
  const result = await rows(db, `SELECT MAX(CAST(id AS UNSIGNED)) AS n FROM ${table}`, [])
  return String(Number(result[0]?.n ?? 0) + 1).padStart(width, '0')
}

/** Preview and commit use identical relationship checks. Only commit may write. */
async function resolve(db: Db, input: MasterSaveInput, create: boolean): Promise<MasterSaveResolution> {
  const result: MasterSaveResolution = {
    hospital: null, hospitalAddress: null, department: null, doctor: null,
    escortIds: [], creations: []
  }
  const hospitalValue = clean(input.hospital)
  const addressValue = clean(input.hospitalAddress)
  const departmentValue = clean(input.department)
  const doctorValue = clean(input.doctor)
  const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const datePart = (type: string) => dateParts.find((part) => part.type === type)?.value ?? ''
  const today = `${datePart('year')}${datePart('month')}${datePart('day')}`

  if (!hospitalValue && (addressValue || departmentValue || doctorValue)) throw new Error('请先填写医院')
  if (!departmentValue && doctorValue) throw new Error('请先填写医生所属科室')

  let hospitalName = hospitalValue
  if (hospitalValue) {
    const found = await byIdThenName(db,
      'SELECT id, name FROM dim_hy_yywh WHERE CAST(id AS CHAR) = ? LIMIT 2', [hospitalValue],
      'SELECT id, name FROM dim_hy_yywh WHERE name = ? LIMIT 2', [hospitalValue], '医院')
    if (found) {
      result.hospital = String(found.id)
      hospitalName = String(found.name)
    } else {
      validName(hospitalValue, '医院')
      if ((await rows(db, 'SELECT id FROM f_hy_yywh WHERE name = ? LIMIT 1', [hospitalValue])).length) {
        throw new Error('该医院已有停用档案，请先核对原档案，不能重复建档')
      }
      result.creations.push({ type: 'hospital', name: hospitalValue })
      if (create) {
        const id = await nextId(db, 'f_hy_yywh', 4)
        await db.execute(
          "INSERT INTO f_hy_yywh (id, name, state, u_date) VALUES (?, ?, '启用', ?)",
          [id, hospitalValue, today])
        result.hospital = id
      }
    }
  }

  if (addressValue) {
    if (result.hospital) {
      const found = await byIdThenName(db,
        'SELECT CAST(DZ_ID AS CHAR) AS id, ADDRESS AS name FROM dim_yydz_20240307 WHERE LEFT(CAST(DZ_ID AS CHAR), 4) = ? AND CAST(DZ_ID AS CHAR) = ? LIMIT 2', [result.hospital, addressValue],
        'SELECT CAST(DZ_ID AS CHAR) AS id, ADDRESS AS name FROM dim_yydz_20240307 WHERE LEFT(CAST(DZ_ID AS CHAR), 4) = ? AND ADDRESS = ? LIMIT 2', [result.hospital, addressValue], '医院地址')
      if (found) result.hospitalAddress = String(found.id)
    }
    if (!result.hospitalAddress) {
      validName(addressValue, '医院地址')
      if (result.hospital) {
        const hospital = one(await rows(db,
          'SELECT dz1, dz2, dz3 FROM f_hy_yywh WHERE id = ? LIMIT 2', [result.hospital]), '医院')
        const slot = (['dz1', 'dz2', 'dz3'] as const).find((key) => !clean(hospital?.[key]))
        if (!slot) throw new Error('该医院的三个地址栏均已填写，请先核对医院地址')
        if (create) {
          const [updated] = await db.execute(`UPDATE f_hy_yywh SET ${slot} = ?, u_date = ? WHERE id = ? AND (${slot} IS NULL OR ${slot} = '')`,
            [addressValue, today, result.hospital])
          if (!('affectedRows' in updated) || updated.affectedRows !== 1) throw new Error('医院地址栏已被占用，请重新保存')
          const saved = one(await rows(db,
            'SELECT CAST(DZ_ID AS CHAR) AS id FROM dim_yydz_20240307 WHERE LEFT(CAST(DZ_ID AS CHAR), 4) = ? AND ADDRESS = ? LIMIT 2',
            [result.hospital, addressValue]), '医院地址')
          if (!saved) throw new Error('医院地址已写入，但地址视图未返回 ID，已取消本次建档')
          result.hospitalAddress = String(saved.id)
        }
      }
      result.creations.push({ type: 'address', name: addressValue, parent: hospitalName })
    }
  }

  let departmentName = departmentValue
  if (departmentValue) {
    if (result.hospital) {
      const found = await byIdThenName(db,
        'SELECT CAST(ID AS CHAR) AS id, NAME AS name FROM dim_hy_yy_ks WHERE id_yy = ? AND CAST(ID AS CHAR) = ? LIMIT 2', [result.hospital, departmentValue],
        'SELECT CAST(ID AS CHAR) AS id, NAME AS name FROM dim_hy_yy_ks WHERE id_yy = ? AND NAME = ? LIMIT 2', [result.hospital, departmentValue], '医院科室')
      if (found) {
        result.department = String(found.id)
        departmentName = String(found.name)
      }
    }
    if (!result.department) {
      validName(departmentValue, '科室')
      if (result.hospital && (await rows(db,
        'SELECT id FROM f_hy_yy_ks WHERE id_yy = ? AND name = ? LIMIT 1', [result.hospital, departmentValue])).length) {
        throw new Error('该医院科室已有停用档案，请先核对原档案，不能重复建档')
      }
      result.creations.push({ type: 'department', name: departmentValue, parent: hospitalName })
      if (create && result.hospital) {
        const max = await rows(db, 'SELECT MAX(CAST(xh AS UNSIGNED)) AS n FROM f_hy_yy_ks WHERE id_yy = ?', [result.hospital])
        const xh = String(Number(max[0]?.n ?? 0) + 1).padStart(4, '0')
        const id = `${result.hospital}${xh}`
        await db.execute(
          "INSERT INTO f_hy_yy_ks (id, name, state, u_date, id_yy, xh) VALUES (?, ?, '启用', ?, ?, ?)",
          [id, departmentValue, today, result.hospital, xh])
        result.department = id
      }
    }
  }

  if (doctorValue) {
    if (result.hospital && result.department) {
      if (doctorValue.endsWith('WXSYSXM')) {
        const option = one(await rows(db,
          'SELECT ID AS id FROM dim_hy_ys WHERE CAST(ID AS CHAR) = ? AND CAST(dwks AS CHAR) = ? LIMIT 2',
          [doctorValue, result.department]), '医生')
        if (!option) throw new Error('所选医生不属于当前医院科室，请重新选择')
        result.doctor = String(option.id)
      }
      if (!result.doctor) {
        const scope = "yy = ? AND (dwks = ? OR FIND_IN_SET(?, REPLACE(REPLACE(dwks, '，', ','), ' ', '')) > 0)"
        const found = await byIdThenName(db,
          `SELECT CAST(ID AS CHAR) AS id FROM dim_hy_ys WHERE ${scope} AND CAST(ID AS CHAR) = ? LIMIT 2`,
          [result.hospital, result.department, result.department, doctorValue],
          `SELECT CAST(ID AS CHAR) AS id FROM dim_hy_ys WHERE ${scope} AND NAME = ? LIMIT 2`,
          [result.hospital, result.department, result.department, doctorValue], '医生')
        if (found) result.doctor = String(found.id)
      }
    }
    if (!result.doctor) {
      validName(doctorValue, '医生')
      if (result.hospital && result.department && (await rows(db,
        "SELECT id FROM f_hy_ys WHERE yy = ? AND (dwks = ? OR FIND_IN_SET(?, REPLACE(REPLACE(dwks, '，', ','), ' ', '')) > 0) AND name = ? LIMIT 1",
        [result.hospital, result.department, result.department, doctorValue])).length) {
        throw new Error('该医院科室的医生已有停用档案，请先核对原档案，不能重复建档')
      }
      result.creations.push({ type: 'doctor', name: doctorValue, parent: `${hospitalName} / ${departmentName}` })
      if (create && result.hospital && result.department) {
        const id = await nextId(db, 'f_hy_ys', 5)
        await db.execute(
          "INSERT INTO f_hy_ys (id, name, yy, dwks, state, c_date, u_date) VALUES (?, ?, ?, ?, '启用', ?, ?)",
          [id, doctorValue, result.hospital, result.department, today, today])
        result.doctor = id
      }
    }
  }

  for (const escort of input.escortList ?? []) {
    const value = clean(escort.escortName)
    if (!value) { result.escortIds.push(null); continue }
    let found = one(await rows(db,
      'SELECT CAST(ID AS CHAR) AS id, NAME AS name, SJ AS sj FROM dim_hy_pzr WHERE CAST(ID AS CHAR) = ? LIMIT 2', [value]), '陪诊人员')
    if (!found) {
      const phone = clean(escort.phone).replace(/\D/g, '')
      if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error(`陪诊人员“${value}”需要填写有效手机号`)
      found = one(await rows(db,
        "SELECT CAST(ID AS CHAR) AS id, NAME AS name, SJ AS sj FROM dim_hy_pzr WHERE TRIM(NAME) = ? AND REPLACE(SJ, ' ', '') = ? LIMIT 2",
        [value, phone]), '陪诊人员')
      if (!found) {
        validName(value, '陪诊人员')
        if ((await rows(db,
          "SELECT id FROM f_hy_pzr WHERE TRIM(name) = ? AND REPLACE(sj, ' ', '') = ? LIMIT 1",
          [value, phone])).length) {
          throw new Error(`陪诊人员“${value}”已有停用档案，请先核对原档案，不能重复建档`)
        }
        result.creations.push({ type: 'escort', name: `${value}（${phone}）` })
        if (create) {
          const id = await nextId(db, 'f_hy_pzr', 5)
          await db.execute("INSERT INTO f_hy_pzr (id, name, sj, state, c_date, u_date) VALUES (?, ?, ?, '启用', ?, ?)",
            [id, value, phone, today, today])
          result.escortIds.push(id)
          continue
        }
      }
    }
    result.escortIds.push(found ? String(found.id) : null)
  }
  result.creations = result.creations.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.type === item.type && candidate.name === item.name && candidate.parent === item.parent) === index)
  return result
}

export async function previewHuanyuMasterSave(input: MasterSaveInput): Promise<MasterSaveResolution> {
  const connection = await getRemoteDictionaryPool().getConnection()
  try { return await resolve(connection, input, false) } finally { connection.release() }
}

export async function commitHuanyuMasterSave(input: MasterSaveInput, confirmedCreations: MasterSaveCreation[] | null): Promise<MasterSaveResolution> {
  const connection = await getRemoteDictionaryPool().getConnection()
  let locked = false
  try {
    // All application writers use the same remote lock; no lock is held while the user reviews the modal.
    const lock = await rows(connection, "SELECT GET_LOCK('hyyd:master-save', 15) AS acquired", [])
    if (Number(lock[0]?.acquired) !== 1) throw new Error('维表正由其他订单维护，请稍后重试保存')
    locked = true
    await connection.beginTransaction()
    const latest = await resolve(connection, input, false)
    if (JSON.stringify(latest.creations) !== JSON.stringify(confirmedCreations ?? [])) {
      throw new Error('维表情况已变化，请重新点击保存并确认最新新增内容')
    }
    const resolved = await resolve(connection, input, true)
    await connection.commit()
    return resolved
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    if (locked) await connection.execute("SELECT RELEASE_LOCK('hyyd:master-save')").catch(() => undefined)
    connection.release()
  }
}
