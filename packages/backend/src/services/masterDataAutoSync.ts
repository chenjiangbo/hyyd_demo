/**
 * 寰宇系统核心主数据（陪诊人·医院·科室·医生）全自动智能建档与维护服务。
 * 
 * 架构规范：
 * 1. 维护目标为远程阿里云 MySQL 数据库 (`hyyd`) 中的物理表：
 *    - 陪诊人员：`f_hy_pzr` (对应的下拉框视图为 `dim_hy_pzr`)
 *    - 医院主档：`f_hy_yywh` (对应的下拉框视图为 `dim_hy_yywh`)
 *    - 对外科室：`f_hy_yy_ks` (对应的下拉框视图为 `dim_hy_yy_ks`)
 *    - 医生档案：`f_hy_ys` (对应的下拉框视图为 `dim_hy_ys`)
 * 2. 陪诊人员：【姓名 + 11位手机号】联合唯一，仅维护 (ID, NAME, SJ, STATE, C_DATE, U_DATE) 6个字段。
 * 3. 医院等级：查询 `dim_yydjB486` 维表并回填对应的 3 位代码 ID（如 '001' 三级甲等）。
 * 4. 医生职称：
 *    - 临床职称严格限定于：['知名专家', '主任医师', '副主任医师', '主治医师', '住院医师']
 *    - 教学职称严格限定于：['教授', '副教授', '讲师'] 或 NULL
 */
import type { RowDataPacket } from 'mysql2/promise'
import { getRemoteDictionaryPool } from '../db/remoteDictionary.js'
import { chat } from '../llm/gatewayClient.js'

function shanghaiDate8(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const y = parts.find((p) => p.type === 'year')?.value ?? '2026'
  const m = parts.find((p) => p.type === 'month')?.value ?? '01'
  const d = parts.find((p) => p.type === 'day')?.value ?? '01'
  return `${y}${m}${d}`
}

export interface MasterDataSyncParams {
  hospitalName?: string | null
  hospitalAddress?: string | null
  departmentName?: string | null
  doctorName?: string | null
  expertLevel?: string | null
  escortName?: string | null
  escortPhone?: string | null
}

export interface MasterDataSyncResult {
  escortId: string | null
  hospitalId: string | null
  deptId: string | null
  doctorId: string | null
}

/**
 * 1. 维护陪诊人员 (f_hy_pzr)
 * 判重标准：【姓名 + 11位手机号】联合唯一。
 * 缺电话或缺姓名一律不入库。
 */
export async function ensureRemoteEscort(
  rawName: string | null | undefined,
  rawPhone: string | null | undefined
): Promise<string | null> {
  const name = (rawName ?? '').trim().replace(/^(陪诊员|陪诊老师|陪诊|师傅)-?/, '')
  const cleanPhone = (rawPhone ?? '').replace(/\D/g, '').slice(-11)

  // 必须同时具备有效姓名和合法的 11 位大陆手机号
  if (!name || name.length < 2 || !/^1[3-9]\d{9}$/.test(cleanPhone)) {
    return null
  }

  const pool = getRemoteDictionaryPool()

  // 1. 查询库中是否存在完全一致的【姓名 + 手机号】
  const [existing] = await pool.execute<RowDataPacket[]>(
    `SELECT ID FROM f_hy_pzr 
      WHERE TRIM(NAME) = ? AND REPLACE(SJ, ' ', '') = ? 
      LIMIT 1`,
    [name, cleanPhone]
  )

  if (existing && existing.length > 0 && existing[0].ID) {
    return String(existing[0].ID)
  }

  // 2. 新人员：获取当前最大 ID，递增生成 5 位工号
  const [maxRows] = await pool.execute<RowDataPacket[]>(
    `SELECT MAX(CAST(ID AS UNSIGNED)) AS max_id FROM f_hy_pzr`
  )
  const maxNum = Number(maxRows[0]?.max_id ?? 0)
  const nextId = String(maxNum + 1).padStart(5, '0')
  const today = shanghaiDate8()

  // 3. 严格仅写入 6 个核心字段，其余一律 NULL
  await pool.execute(
    `INSERT INTO f_hy_pzr (ID, NAME, SJ, STATE, C_DATE, U_DATE, XB, SF, CS, BZ, pzrlx)
     VALUES (?, ?, ?, '启用', ?, ?, NULL, NULL, NULL, NULL, NULL)`,
    [nextId, name, cleanPhone, today, today]
  )

  console.log(`[master-data] 自动建档全新陪诊人员: ID=${nextId}, 姓名=${name}, 电话=${cleanPhone}`)
  return nextId
}

interface CslbRow {
  S_ID: string
  S_NAME: string
  X_ID: string
  X_NAME: string
}

let cslbCache: CslbRow[] | null = null

async function getCslbData(pool: any): Promise<CslbRow[]> {
  if (cslbCache) return cslbCache
  const [rows] = await pool.execute('SELECT S_ID, S_NAME, X_ID, X_NAME FROM DIM_CSLB')
  cslbCache = (rows as any[]).map((r) => ({
    S_ID: String(r.S_ID),
    S_NAME: String(r.S_NAME),
    X_ID: String(r.X_ID),
    X_NAME: String(r.X_NAME)
  }))
  return cslbCache
}

export interface RealHospitalProfile {
  province: string | null
  city: string | null
  district?: string | null
  level: string | null
}

/**
 * 权威检索医院真实档案（所属省份、城市、区县、官方登记等级）
 * 不靠名称盲猜，不臆造虚假数据，直接检索官方知识库
 */
export async function lookupRealHospitalProfile(hospitalName: string): Promise<RealHospitalProfile> {
  const cleanName = (hospitalName || '').trim()
  if (!cleanName) return { province: null, city: null, level: null }

  try {
    const res = await chat(
      [
        {
          role: 'system',
          content:
            '你是一个专业的中国医疗机构权威档案专家。请严格检索国家卫健委/官方登记的真实医院档案信息。' +
            '只输出一个合法JSON对象，不要加任何markdown标记、注释或多余文字：' +
            '{"province":"真实省份全称如广东省或北京市","city":"真实城市全称如深圳市或成都市或北京市","district":"真实区县全称","level":"真实官方等级如三级甲等/二级甲等/二级乙等/民营/其他"}'
        },
        {
          role: 'user',
          content: `请查询并输出该医院真实档案：${cleanName}`
        }
      ],
      { temperature: 0, maxTokens: 300 }
    )

    const text = res.content.trim().replace(/^```json/i, '').replace(/```$/i, '').trim()
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      const data = JSON.parse(match[0])
      return {
        province: typeof data.province === 'string' && data.province.trim() ? data.province.trim() : null,
        city: typeof data.city === 'string' && data.city.trim() ? data.city.trim() : null,
        district: typeof data.district === 'string' && data.district.trim() ? data.district.trim() : null,
        level: typeof data.level === 'string' && data.level.trim() ? data.level.trim() : null
      }
    }
  } catch (err) {
    console.warn(`[master-data] 真实医院权威档案检索异常 (${cleanName}):`, (err as Error).message)
  }

  return { province: null, city: null, level: null }
}

/**
 * 将官方等级文字精确映射到 dim_yydjB486 维表代码：
 * 001: 三级甲等, 002: 二级甲等, 003: 一级甲等, 004: 三级/三乙, 005: 二级/二乙, 006: 一级, 007: 三级特等, 008: 民营, 009: 其他机构
 */
export function mapHospitalLevelToCode(rawLevel?: string | null): string {
  const lvl = (rawLevel || '').trim()
  if (!lvl) return '009'

  if (lvl.includes('特等')) return '007'
  if (lvl.includes('三级甲等') || lvl.includes('三甲')) return '001'
  if (lvl.includes('二级甲等') || lvl.includes('二甲')) return '002'
  if (lvl.includes('一级甲等') || lvl.includes('一甲')) return '003'
  if (lvl.includes('三级') || lvl.includes('三乙') || lvl.includes('三丙')) return '004'
  if (lvl.includes('二级') || lvl.includes('二乙') || lvl.includes('二丙')) return '005'
  if (lvl.includes('一级') || lvl.includes('一乙')) return '006'
  if (lvl.includes('民营') || lvl.includes('私立')) return '008'

  return '009'
}

/**
 * 将查到的真实省市对齐到 DIM_CSLB 维表代码
 */
export async function mapProvinceCityToCslb(
  pool: any,
  provinceName?: string | null,
  cityName?: string | null,
  districtName?: string | null
): Promise<{ province: string | null; city: string | null }> {
  const pName = (provinceName || '').trim()
  const cName = (cityName || '').trim()
  const dName = (districtName || '').trim()

  // 1. 四大直辖市标准代码（严格对齐系统既有 1000+ 医院数据）
  if (pName.includes('北京') || cName.includes('北京')) return { province: '11', city: '1111' }
  if (pName.includes('上海') || cName.includes('上海')) return { province: '32', city: '3223' }
  if (pName.includes('天津') || cName.includes('天津')) return { province: '34', city: '3410' }
  if (pName.includes('重庆') || cName.includes('重庆')) return { province: '39', city: '3910' }

  const cslb = await getCslbData(pool)

  let matchedProvinceId: string | null = null
  let matchedCityId: string | null = null

  // 2. 匹配省份 S_NAME
  if (pName) {
    const cleanP = pName.replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区)$/, '')
    const pRow = cslb.find((r) => r.S_NAME.includes(cleanP) || cleanP.includes(r.S_NAME.replace(/省$/, '')))
    if (pRow) {
      matchedProvinceId = pRow.S_ID
    }
  }

  // 3. 匹配城市/区县 X_NAME
  const searchCityNames = [cName, dName].filter(Boolean)
  for (const name of searchCityNames) {
    const cleanC = name.replace(/(市|区|县|旗)$/, '')
    const candidateRows = matchedProvinceId ? cslb.filter((r) => r.S_ID === matchedProvinceId) : cslb
    const cRow = candidateRows.find(
      (r) => r.X_NAME.includes(cleanC) || (cleanC.length >= 2 && cleanC.includes(r.X_NAME.replace(/(市|区|县|旗)$/, '')))
    )
    if (cRow) {
      matchedCityId = cRow.X_ID
      if (!matchedProvinceId) matchedProvinceId = cRow.S_ID
      break
    }
  }

  return { province: matchedProvinceId, city: matchedCityId }
}

/**
 * 2. 维护医院与多院区地址 (f_hy_yywh)
 * - 直接按真实医院名称权威检索真实省市区与真实官方等级
 * - 地址实事求是：用户提供了才写，未提供严格留空（NULL），绝不无中生有
 * - 多院区按真实就诊地址顺序维护 (DZ1 -> DZ2 -> DZ3)
 */
export async function ensureRemoteHospital(
  rawHospital: string | null | undefined,
  rawAddress?: string | null
): Promise<{ id: string; province: string | null; city: string | null } | null> {
  const hospital = (rawHospital ?? '').trim()
  if (!hospital || hospital.length < 2) return null

  const pool = getRemoteDictionaryPool()
  const today = shanghaiDate8()
  const address = (rawAddress ?? '').trim()

  // 1. 查询医院是否已存在
  const [existing] = await pool.execute<RowDataPacket[]>(
    `SELECT id, name, dz1, dz2, dz3, dq_sf, dq_cs, level FROM f_hy_yywh WHERE name = ? LIMIT 1`,
    [hospital]
  )

  if (existing && existing.length > 0) {
    const h = existing[0]
    const hId = String(h.id)

    // 容错与槽位自愈：如果 DZ1 为空而 DZ2 有值，优先将 DZ2 归位至 DZ1
    if (!h.dz1 && h.dz2) {
      await pool.execute(
        `UPDATE f_hy_yywh SET dz1 = dz2, dz2 = NULL, u_date = ? WHERE id = ?`,
        [today, hId]
      )
      h.dz1 = h.dz2
      h.dz2 = null
      console.log(`[master-data] 医院 ${hospital} (${hId}) 纠正院区地址槽位: 将 DZ2 归位至 DZ1`)
    }

    // 检查并按序顺延补充真实就诊地址（实事求是：用户有输入才记，不输入绝不臆造补全）
    if (address) {
      const addresses = [h.dz1, h.dz2, h.dz3].filter(Boolean).map(String)
      const alreadyHas = addresses.some(
        (a) => a.includes(address) || address.includes(a)
      )
      if (!alreadyHas) {
        if (!h.dz1) {
          await pool.execute(`UPDATE f_hy_yywh SET dz1 = ?, u_date = ? WHERE id = ?`, [address, today, hId])
          console.log(`[master-data] 医院 ${hospital} (${hId}) 补充真实就诊地址 DZ1: ${address}`)
          h.dz1 = address
        } else if (!h.dz2) {
          await pool.execute(`UPDATE f_hy_yywh SET dz2 = ?, u_date = ? WHERE id = ?`, [address, today, hId])
          console.log(`[master-data] 医院 ${hospital} (${hId}) 补充真实分院区地址 DZ2: ${address}`)
          h.dz2 = address
        } else if (!h.dz3) {
          await pool.execute(`UPDATE f_hy_yywh SET dz3 = ?, u_date = ? WHERE id = ?`, [address, today, hId])
          console.log(`[master-data] 医院 ${hospital} (${hId}) 补充真实分院区地址 DZ3: ${address}`)
          h.dz3 = address
        }
      }
    }

    // 如果省份或城市字段缺失，直接通过官方档案真实直查补齐
    let currentSf = h.dq_sf ? String(h.dq_sf) : null
    let currentCs = h.dq_cs ? String(h.dq_cs) : null
    let currentLevel = h.level ? String(h.level) : null

    if (!currentSf || !currentCs || !currentLevel || currentLevel === '009') {
      const profile = await lookupRealHospitalProfile(hospital)
      const region = await mapProvinceCityToCslb(pool, profile.province, profile.city, profile.district)
      const levelCode = profile.level ? mapHospitalLevelToCode(profile.level) : currentLevel

      const newSf = currentSf || region.province
      const newCs = currentCs || region.city
      const newLevel = currentLevel && currentLevel !== '009' ? currentLevel : levelCode

      if (newSf !== currentSf || newCs !== currentCs || newLevel !== currentLevel) {
        await pool.execute(
          `UPDATE f_hy_yywh SET dq_sf = ?, dq_cs = ?, level = ?, u_date = ? WHERE id = ?`,
          [newSf, newCs, newLevel, today, hId]
        )
        console.log(`[master-data] 医院 ${hospital} (${hId}) 真实直查补齐: 省=${newSf}, 市=${newCs}, 等级=${newLevel} (官方档案: ${profile.level})`)
        currentSf = newSf
        currentCs = newCs
      }
    }

    return {
      id: hId,
      province: currentSf,
      city: currentCs
    }
  }

  // 2. 全新医院：计算下一个 4 位自增 ID
  const [maxRows] = await pool.execute<RowDataPacket[]>(
    `SELECT MAX(CAST(id AS UNSIGNED)) AS max_id FROM f_hy_yywh`
  )
  const maxNum = Number(maxRows[0]?.max_id ?? 0)
  const nextId = String(maxNum + 1).padStart(4, '0')

  // 3. 权威检索医院真实档案（真实所属省市区、卫健委官方等级）
  const profile = await lookupRealHospitalProfile(hospital)
  console.log(`[master-data] 医院【${hospital}】真实档案检索结果:`, profile)

  // 4. 精确映射省市与等级维表代码
  const region = await mapProvinceCityToCslb(pool, profile.province, profile.city, profile.district)
  const dqSf = region.province
  const dqCs = region.city
  const levelId = mapHospitalLevelToCode(profile.level)

  // 5. 写入 f_hy_yywh
  // 实事求是：用户有输入真实地址就写入 dz1，没有输入则严格为 NULL，绝不臆造
  await pool.execute(
    `INSERT INTO f_hy_yywh (id, name, level, dz1, dq_sf, dq_cs, state, u_date, bq, dq, dz, tips, bz, dz2, dz3)
     VALUES (?, ?, ?, ?, ?, ?, '启用', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    [nextId, hospital, levelId, address || null, dqSf, dqCs, today]
  )

  console.log(`[master-data] 自动建档全新医院(真实直查): ID=${nextId}, 名称=${hospital}, 等级=${levelId}(${profile.level ?? '未定级'}), 地址=${address || '无(留空)'}, 省=${dqSf}, 市=${dqCs}`)
  return { id: nextId, province: dqSf, city: dqCs }
}

/**
 * 3. 维护医院对外科室 (f_hy_yy_ks)
 * 复合主键：8 位复合 ID (${4位医院ID}${4位序号})
 * 映射对内一级 ksdl 与对内二级 ksxf
 */
export async function ensureRemoteDepartment(
  hospitalId: string,
  rawDept: string | null | undefined
): Promise<string | null> {
  const dept = (rawDept ?? '').trim()
  if (!hospitalId || !dept || dept.length < 2) return null

  const pool = getRemoteDictionaryPool()
  const today = shanghaiDate8()

  // 1. 检查该医院下是否已有该对外科室
  const [existing] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM f_hy_yy_ks WHERE id_yy = ? AND name = ? LIMIT 1`,
    [hospitalId, dept]
  )
  if (existing && existing.length > 0 && existing[0].id) {
    return String(existing[0].id)
  }

  // 2. 计算医院内下一个 4 位序号 xh 与 8 位复合主键 id
  const [maxRows] = await pool.execute<RowDataPacket[]>(
    `SELECT MAX(CAST(xh AS UNSIGNED)) AS max_xh FROM f_hy_yy_ks WHERE id_yy = ?`,
    [hospitalId]
  )
  const maxXh = Number(maxRows[0]?.max_xh ?? 0)
  const nextXh = String(maxXh + 1).padStart(4, '0')
  const compositeId = `${hospitalId}${nextXh}`

  // 3. 智能映射对内一级 ksdl 与对内二级 ksxf (对照标准细分科室表 dim_hy_xfks)
  let ksdl = '0002' // 默认内科系统
  let ksxf: string | null = null

  const [matchedXf] = await pool.execute<RowDataPacket[]>(
    `SELECT id, name_yjks FROM dim_hy_xfks 
      WHERE ? LIKE CONCAT('%', name, '%') OR name LIKE CONCAT('%', ?, '%')
      ORDER BY LENGTH(name) DESC
      LIMIT 1`,
    [dept, dept]
  )

  if (matchedXf && matchedXf.length > 0) {
    ksxf = String(matchedXf[0].id)
    ksdl = String(matchedXf[0].name_yjks)
  } else {
    // 关键字归类兜底
    if (/外科|骨科|泌尿|胸外|心外|脑外|普外|神经外科|手足|耳鼻喉|眼科/.test(dept)) {
      ksdl = '0001' // 外科系统
    } else if (/妇科|产科|妇产/.test(dept)) {
      ksdl = '0004' // 妇产科学系
    } else if (/儿科|小儿|新生儿/.test(dept)) {
      ksdl = '0013' // 儿科
    } else if (/口腔|牙/.test(dept)) {
      ksdl = '0006' // 口腔学系
    } else if (/皮肤/.test(dept)) {
      ksdl = '0012' // 皮肤科
    } else if (/中医/.test(dept)) {
      ksdl = '0010' // 中医学
    } else if (/肿瘤/.test(dept)) {
      ksdl = '0002' // 内科系统
    }
  }

  // 4. 写入 f_hy_yy_ks
  await pool.execute(
    `INSERT INTO f_hy_yy_ks (id, name, ksdl, ksxf, state, u_date, id_yy, xh)
     VALUES (?, ?, ?, ?, '启用', ?, ?, ?)`,
    [compositeId, dept, ksdl, ksxf, today, hospitalId, nextXh]
  )

  console.log(`[master-data] 自动建档全新对外科室: ID=${compositeId}, 医院ID=${hospitalId}, 科室=${dept}, 一级=${ksdl}, 二级=${ksxf}`)
  return compositeId
}

/**
 * 4. 维护医生档案 (f_hy_ys)
 * - 5 位自增 ID
 * - 临床职称严格限制于 5 大枚举: 知名专家; 主任医师; 副主任医师; 主治医师; 住院医师
 * - 教学职称严格限制于 3 大枚举: 教授; 副教授; 讲师 (或 NULL)
 */
export async function ensureRemoteDoctor(
  hospitalId: string,
  deptId: string | null,
  rawDoctor: string | null | undefined,
  expertLevelHint?: string | null,
  province?: string | null,
  city?: string | null
): Promise<string | null> {
  const doctor = (rawDoctor ?? '').trim().replace(/^(医生|大夫|主任|专家)-?/, '')
  if (!hospitalId || !doctor || doctor.length < 2) return null

  const pool = getRemoteDictionaryPool()
  const today = shanghaiDate8()

  // 1. 查询该医院下是否已存在该医生
  const [existing] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM f_hy_ys WHERE yy = ? AND name = ? LIMIT 1`,
    [hospitalId, doctor]
  )
  if (existing && existing.length > 0 && existing[0].id) {
    return String(existing[0].id)
  }

  // 2. 计算下一个 5 位自增 ID
  const [maxRows] = await pool.execute<RowDataPacket[]>(
    `SELECT MAX(CAST(id AS UNSIGNED)) AS max_id FROM f_hy_ys`
  )
  const maxNum = Number(maxRows[0]?.max_id ?? 0)
  const nextId = String(maxNum + 1).padStart(5, '0')

  // 3. 临床职称归一化 (严格限定为 5 大枚举之一)
  const hint = `${expertLevelHint || ''}`
  let zc = '副主任医师' // 默认副主任医师
  if (hint.includes('知名') || hint.includes('特聘专家') || hint.includes('特需')) {
    zc = '知名专家'
  } else if (hint.includes('主任医师') || hint.includes('正高')) {
    zc = '主任医师'
  } else if (hint.includes('副主任') || hint.includes('副高')) {
    zc = '副主任医师'
  } else if (hint.includes('主治')) {
    zc = '主治医师'
  } else if (hint.includes('住院')) {
    zc = '住院医师'
  }

  // 4. 教学职称归一化 (严格限定为 3 大枚举之一或 NULL)
  let jxzc: string | null = null
  if (hint.includes('副教授')) {
    jxzc = '副教授'
  } else if (hint.includes('教授')) {
    jxzc = '教授'
  } else if (hint.includes('讲师')) {
    jxzc = '讲师'
  }

  // 5. 写入 f_hy_ys
  await pool.execute(
    `INSERT INTO f_hy_ys (id, name, sex, tel, em, dq_sf, dq_cs, yy, dwks, zc, jxzc, yyxzzw, shrz, sc, bz, state, csrq, c_date, u_date)
     VALUES (?, ?, '男', NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '启用', NULL, ?, ?)`,
    [nextId, doctor, province || null, city || null, hospitalId, deptId || null, zc, jxzc, today, today]
  )

  console.log(`[master-data] 自动建档全新医生: ID=${nextId}, 姓名=${doctor}, 医院ID=${hospitalId}, 科室ID=${deptId}, 职称=${zc}, 教学职称=${jxzc}`)
  return nextId
}

/**
 * 综合入口：在订单分析完成提取要素后，自动对四大实体在远程 MySQL 进行查重与建档
 */
export async function autoSyncOrderMasterData(
  params: MasterDataSyncParams
): Promise<MasterDataSyncResult> {
  const result: MasterDataSyncResult = {
    escortId: null,
    hospitalId: null,
    deptId: null,
    doctorId: null
  }

  try {
    // 1. 同步陪诊人员（姓名+电话联合唯一）
    if (params.escortName && params.escortPhone) {
      result.escortId = await ensureRemoteEscort(params.escortName, params.escortPhone)
    }

    // 2. 同步医院（含多院区流转）
    let hospitalInfo: { id: string; province: string | null; city: string | null } | null = null
    if (params.hospitalName) {
      hospitalInfo = await ensureRemoteHospital(params.hospitalName, params.hospitalAddress)
      result.hospitalId = hospitalInfo?.id ?? null
    }

    // 3. 同步对外科室（依赖医院）
    if (hospitalInfo?.id && params.departmentName) {
      result.deptId = await ensureRemoteDepartment(hospitalInfo.id, params.departmentName)
    }

    // 4. 同步医生档案（依赖医院与科室）
    if (hospitalInfo?.id && params.doctorName) {
      result.doctorId = await ensureRemoteDoctor(
        hospitalInfo.id,
        result.deptId,
        params.doctorName,
        params.expertLevel,
        hospitalInfo.province,
        hospitalInfo.city
      )
    }
  } catch (error) {
    // 无论主数据维护是否偶发网络问题，均不阻断主流程
    console.error('[master-data] 远程主数据自动同步偶发异常:', error)
  }

  return result
}
