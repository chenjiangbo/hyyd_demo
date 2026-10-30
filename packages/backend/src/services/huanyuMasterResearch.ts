import type { RowDataPacket } from 'mysql2/promise'
import { getRemoteDictionaryPool } from '../db/remoteDictionary.js'
import type { MasterSaveCreation, MasterSaveInput } from './huanyuMasterSave.js'
import { chat } from '../llm/gatewayClient.js'

export interface MasterReviewOption { value: string; label: string; parent?: string }
export interface MasterReviewField {
  id: string
  label: string
  value: string
  options: MasterReviewOption[]
  source?: { label: string; url: string }
}
export interface MasterReviewItem {
  key: string
  type: MasterSaveCreation['type']
  name: string
  parent?: string
  fields: MasterReviewField[]
  address?: string
  phone?: string
  addressSuggestion?: { value: string }
}

type SearchResult = { url?: string; title?: string; content?: string; sourceType?: string; display?: { tags?: string[] } }
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const plain = (value: string): string => value.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim()
const normalized = (value: string): string => value.replace(/[\s·（）()\-—]/g, '').replace(/^中国医学科学院/, '')
const option = (row: RowDataPacket, id = 'id', name = 'name', parent?: string): MasterReviewOption => ({
  value: String(row[id] ?? ''), label: String(row[name] ?? ''), ...(parent ? { parent: String(row[parent] ?? '') } : {})
})
const field = (id: string, label: string, options: MasterReviewOption[], value = '', source?: { label: string; url: string }): MasterReviewField => ({ id, label, options, value, ...(source ? { source } : {}) })

async function searchHaodf(type: 'hospital' | 'doctor', query: string): Promise<SearchResult[]> {
  if (!query || query.length > 120) return []
  try {
    const url = new URL('https://so.haodf.com/index/search')
    url.searchParams.set('type', type)
    url.searchParams.set('kw', query)
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!response.ok) return []
    const html = await response.text()
    if (html.length > 2_000_000) return []
    const state = html.split('window.__INITIAL_STATE__=')[1]?.split(';(function')[0]
    if (!state) return []
    const parsed = JSON.parse(state) as { search?: { data?: { docList?: SearchResult[] } } }
    return Array.isArray(parsed.search?.data?.docList) ? parsed.search.data.docList.slice(0, 20) : []
  } catch { return [] }
}

async function doctorBiography(url: string): Promise<string> {
  // Search results provide the URL. Only a fixed doctor profile path may be fetched.
  if (!/^https:\/\/www\.haodf\.com\/doctor\/\d+\.html$/.test(url)) return ''
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!response.ok) return ''
    const html = await response.text()
    if (html.length > 2_000_000) return ''
    return plain(html.match(/<p class="init-content">([\s\S]*?)<\/p>/)?.[1] ?? '')
  } catch { return '' }
}

function hospitalMatch(result: SearchResult, hospital: string): boolean {
  if (!/^https:\/\/www\.haodf\.com\/hospital\/\d+\.html$/.test(clean(result.url))) return false
  const title = normalized(plain(clean(result.title)))
  const description = normalized(plain(clean(result.content)))
  const target = normalized(hospital)
  return Boolean(target && (title === target || description.includes(`全称${target}`)))
}

function doctorMatch(result: SearchResult, doctor: string, hospital: string, department: string): boolean {
  if (!/^https:\/\/www\.haodf\.com\/doctor\/\d+\.html$/.test(clean(result.url))) return false
  const title = plain(clean(result.title))
  const match = title.match(/^【(.+?)】(.+?)\s*-\s*(.+)$/)
  if (!match || normalized(match[1]) !== normalized(doctor)) return false
  const hospitalTarget = normalized(hospital)
  const hospitalFound = normalized(match[2])
  if (!(hospitalTarget === hospitalFound || hospitalTarget.includes(hospitalFound) || hospitalFound.includes(hospitalTarget))) return false
  const departmentTarget = normalized(department).replace('心血管内科', '心内科')
  const departmentFound = normalized(match[3]).replace('心血管内科', '心内科')
  return Boolean(departmentTarget && (departmentTarget === departmentFound || departmentTarget.includes(departmentFound) || departmentFound.includes(departmentTarget)))
}

function gradeFromResult(result: SearchResult, options: MasterReviewOption[]): string {
  const content = plain(clean(result.content))
  const tags = result.display?.tags ?? []
  const grade = content.match(/(?:三级|二级|一级)(?:特等|甲等|乙等)/)?.[0] ??
    (tags.includes('三甲') ? '三级甲等' : tags.includes('二甲') ? '二级甲等' : '')
  return options.find((item) => item.label === grade)?.value ?? ''
}

function locationFromText(address: string, hospitalResult: SearchResult | undefined, regions: MasterReviewOption[], cities: MasterReviewOption[]): { province: string; city: string } {
  const text = `${address} ${plain(clean(hospitalResult?.content))}`
  const provinceNames = [...new Set(regions.map((item) => item.label))].sort((a, b) => b.length - a.length)
  const provinceName = provinceNames.find((name) => text.includes(name)) ??
    provinceNames.find((name) => text.includes(name.replace(/省$|市$|自治区$/, '')))
  const province = regions.find((item) => item.label === provinceName)?.value ?? ''
  const within = cities.filter((item) => item.parent === province)
  const addressAfterProvince = provinceName ? address.replace(provinceName, '') : address
  const cityName = within.map((item) => item.label).sort((a, b) => b.length - a.length).find((name) => addressAfterProvince.includes(name)) ??
    (within.length === 1 ? within[0].label : '')
  return { province, city: within.find((item) => item.label === cityName)?.value ?? '' }
}

function matchInternalDepartment(name: string, options: MasterReviewOption[]): MasterReviewOption | undefined {
  const target = normalized(name).replace('心血管内科', '心内科').replace('心血管外科', '心外科')
  const exact = options.filter((item) => normalized(item.label) === target)
  return exact.length === 1 ? exact[0] : undefined
}

async function aiJson(prompt: string, enableSearch: boolean): Promise<Record<string, unknown>> {
  try {
    const result = await chat([{ role: 'system', content: '只返回合法JSON，不编造信息；不确定的字段返回null。' }, { role: 'user', content: prompt }], { enableSearch, timeoutMs: 25000, maxTokens: 500, temperature: 0 })
    const text = result.content.trim()
    const start = text.indexOf('{'), end = text.lastIndexOf('}')
    if (start < 0 || end < start) return {}
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch (error) {
    console.warn('[维表核对] AI查询失败，候选字段保留为空或使用已有匹配', error instanceof Error ? error.name : 'Error')
    return {}
  }
}

function uniqueOption(name: unknown, options: MasterReviewOption[]): MasterReviewOption | undefined {
  const value = clean(name)
  if (!value) return undefined
  const matches = options.filter((item) => item.label === value)
  return matches.length === 1 ? matches[0] : undefined
}

export async function buildMasterReview(creations: MasterSaveCreation[], input: MasterSaveInput): Promise<MasterReviewItem[]> {
  if (!creations.length) return []
  const pool = getRemoteDictionaryPool()
  const [gradeRows, regionRows, firstRows, secondRows] = await Promise.all([
    pool.execute<RowDataPacket[]>('SELECT CAST(id AS CHAR) AS id, name FROM dim_yydjB486 ORDER BY id'),
    pool.execute<RowDataPacket[]>('SELECT CAST(S_ID AS CHAR) AS provinceId, S_NAME AS provinceName, CAST(X_ID AS CHAR) AS cityId, X_NAME AS cityName FROM DIM_CSLB ORDER BY S_ID, X_ID'),
    pool.execute<RowDataPacket[]>('SELECT CAST(id AS CHAR) AS id, NAME AS name FROM dim_hy_kswh WHERE STATE IS NULL OR STATE != ? ORDER BY id', ['停用']),
    pool.execute<RowDataPacket[]>('SELECT CAST(id AS CHAR) AS id, NAME AS name, CAST(NAME_YJKS AS CHAR) AS parent FROM dim_hy_xfks WHERE STATE IS NULL OR STATE != ? ORDER BY id', ['停用'])
  ])
  const grades = gradeRows[0].map((row) => option(row))
  const provinces = [...new Map(regionRows[0].map((row) => [String(row.provinceId), { value: String(row.provinceId), label: String(row.provinceName) }])).values()]
  const cities = regionRows[0].map((row) => ({ value: String(row.cityId), label: String(row.cityName), parent: String(row.provinceId) }))
  const first = firstRows[0].map((row) => option(row))
  const second = secondRows[0].map((row) => option(row, 'id', 'name', 'parent'))

  let hospitalName = clean(input.hospital)
  let departmentName = clean(input.department)
  if (/^\d+$/.test(hospitalName)) {
    const [found] = await pool.execute<RowDataPacket[]>('SELECT name FROM dim_hy_yywh WHERE CAST(id AS CHAR) = ? LIMIT 1', [hospitalName])
    hospitalName = clean(found[0]?.name) || hospitalName
  }
  if (/^\d+$/.test(departmentName)) {
    const [found] = await pool.execute<RowDataPacket[]>('SELECT NAME AS name FROM dim_hy_yy_ks WHERE CAST(ID AS CHAR) = ? LIMIT 1', [departmentName])
    departmentName = clean(found[0]?.name) || departmentName
  }
  const needsHospital = creations.some((item) => item.type === 'hospital')
  const needsDoctor = creations.some((item) => item.type === 'doctor')
  const needsDepartment = creations.some((item) => item.type === 'department')
  const doctorName = clean(input.doctor)
  const suppliedAddress = clean(input.hospitalAddress)
  // 只有空地址或仅含省市等概括性位置时才建议补全；数字视为已有地址 ID。
  const needsAddress = !suppliedAddress || (!/^\d+$/.test(suppliedAddress) && (suppliedAddress.length < 6 || /^(?:[\u4e00-\u9fa5]{2,12}(?:省|市|自治区|自治州|地区|盟))+$/.test(suppliedAddress)))
  const attributesPromise = (needsHospital || needsDoctor) ? aiJson(
    `联网查询并严格核对同名情况。医院：${JSON.stringify(hospitalName)}；科室：${JSON.stringify(departmentName)}；医生：${JSON.stringify(doctorName)}。` +
    `原始医院地址：${JSON.stringify(suppliedAddress)}。只查询${needsHospital ? '医院等级、省份、城市' : ''}${needsHospital && needsAddress ? '、医院详细地址' : ''}${needsDoctor ? '、医生性别、职称、教学职称' : ''}。` +
    '医生性别只能是男或女，不得根据姓名猜测；职称只能是知名专家、主任医师、副主任医师、主治医师、住院医师；教学职称只能是教授、副教授、讲师。医院如有多个院区且无法确定对应院区，地址返回null；地址只填写来源明确的完整地址。未找到明确资料或不确定时返回null。JSON格式：{"level":null,"province":null,"city":null,"address":null,"sex":null,"title":null,"teachingTitle":null}。', true) : Promise.resolve<Record<string, unknown>>({})
  const departmentPromise = needsDepartment && departmentName && !matchInternalDepartment(departmentName, second) ? aiJson(
    `根据科室名称从以下真实字典选出唯一对应的对内二级科室；不能确定则返回null，不可编造ID。科室：${JSON.stringify(departmentName)}。字典：${JSON.stringify(second.map((item) => ({ id: item.value, name: item.label, parent: item.parent })))}。只返回JSON：{"id":null}。`, false) : Promise.resolve<Record<string, unknown>>({})
  const hospitalResults = creations.some((item) => item.type === 'hospital') && hospitalName ? await searchHaodf('hospital', hospitalName) : []
  const hospitalCandidates = hospitalResults.filter((result) => hospitalMatch(result, hospitalName))
  const hospitalResult = hospitalCandidates.length === 1 ? hospitalCandidates[0] : undefined
  const location = locationFromText(clean(input.hospitalAddress), hospitalResult, provinces, cities)
  const doctorResults = creations.some((item) => item.type === 'doctor') && doctorName && hospitalName && departmentName
    ? await searchHaodf('doctor', `${doctorName} ${hospitalName} ${departmentName}`) : []
  const doctorCandidates = doctorResults.filter((result) => doctorMatch(result, doctorName, hospitalName, departmentName))
  const doctorResult = doctorCandidates.length === 1 ? doctorCandidates[0] : undefined
  const biography = doctorResult?.url ? await doctorBiography(doctorResult.url) : ''
  const sex = biography.match(new RegExp(`^${doctorName}[，,。\\s]+(男|女)[，,。\\s]`))?.[1] ?? ''
  const title = plain(clean(doctorResult?.content)).match(/(知名专家|副主任医师|主任医师|主治医师|住院医师)(?=[,，。\s])/u)?.[1] ?? ''
  const firstClause = biography.split(/[。；;]/, 1)[0] ?? ''
  const teachingCandidates = /师从|导师|跟随/.test(firstClause) ? [] : [...new Set(firstClause.match(/副教授|(?<!副)教授|讲师/gu) ?? [])]
  const teaching = teachingCandidates.length === 1 ? teachingCandidates[0] : ''
  const [attributes, departmentChoice] = await Promise.all([attributesPromise, departmentPromise])
  const gradeName = ({ '三甲': '三级甲等', '二甲': '二级甲等', '一甲': '一级甲等' } as Record<string, string>)[clean(attributes.level)] ?? clean(attributes.level)
  const aiGrade = uniqueOption(gradeName, grades)
  const aiProvince = uniqueOption(attributes.province, provinces)
  const aiCity = aiProvince ? uniqueOption(attributes.city, cities.filter((item) => item.parent === aiProvince.value)) : undefined
  const aiDepartmentId = clean(departmentChoice.id)
  const aiDepartment = second.find((item) => item.value === aiDepartmentId && first.some((parent) => parent.value === item.parent))
  const matchedDepartment = matchInternalDepartment(departmentName, second) ?? aiDepartment

  return creations.map((creation) => {
    const item: MasterReviewItem = { key: creation.key, type: creation.type, name: creation.name, parent: creation.parent, fields: [] }
    if (creation.type === 'hospital') item.fields = [
      field('level', '医院级别', grades, aiGrade?.value ?? (hospitalResult ? gradeFromResult(hospitalResult, grades) : '')),
      field('province', '省份', provinces, aiProvince?.value ?? location.province),
      field('city', '城市', cities, aiProvince ? aiCity?.value ?? '' : location.city)
    ]
    if (creation.type === 'hospital' && needsAddress) {
      const value = clean(attributes.address)
      if (value.length >= 8 && value.length <= 200 && !/[\r\n]/.test(value) && value !== suppliedAddress) item.addressSuggestion = { value }
    }
    if (creation.type === 'address') item.address = creation.name
    if (creation.type === 'department') item.fields = [
      field('internalOne', '对内一级科室', first, matchedDepartment?.parent ?? ''),
      field('internalTwo', '对内二级科室', second, matchedDepartment?.value ?? '')
    ]
    if (creation.type === 'doctor') item.fields = [
      field('sex', '性别', [{ value: '男', label: '男' }, { value: '女', label: '女' }], ['男', '女'].includes(clean(attributes.sex)) ? clean(attributes.sex) : sex),
      field('title', '职称', ['知名专家', '主任医师', '副主任医师', '主治医师', '住院医师'].map((value) => ({ value, label: value })), ['知名专家', '主任医师', '副主任医师', '主治医师', '住院医师'].includes(clean(attributes.title)) ? clean(attributes.title) : title),
      field('teachingTitle', '教学职称', ['教授', '副教授', '讲师'].map((value) => ({ value, label: value })), ['教授', '副教授', '讲师'].includes(clean(attributes.teachingTitle)) ? clean(attributes.teachingTitle) : teaching)
    ]
    if (creation.type === 'escort') item.fields = [
      field('sex', '性别', [{ value: '男', label: '男' }, { value: '女', label: '女' }]),
      field('escortType', '陪诊人类型', [{ value: '本部', label: '本部' }, { value: '外包', label: '外包' }])
    ]
    return item
  })
}
