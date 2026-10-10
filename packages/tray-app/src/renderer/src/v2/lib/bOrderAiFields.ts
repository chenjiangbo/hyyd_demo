import type { OrderAiFieldCandidate } from '../api'

/** Each rule names one B form value, not merely a similarly worded order field. */
type FieldRule = { property: string; candidate: string; labels: string[]; options?: readonly string[]; date?: 'date' | 'datetime'; number?: boolean }

const expertSituationOptions = ['客户首诊点名', '非我司安排的首诊，需复诊', '非我司安排的手术；需复诊', '特殊疾病，仅此专家对症', '我司安排的专家推荐的专家', '其他']

const rules: Record<string, FieldRule[]> = {
  'outpatientPlan.planForm': [
    { property: 'province', candidate: 'service_province', labels: ['省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'hospital', candidate: 'hospital', labels: ['选择医院', '医院'] },
    { property: 'department', candidate: 'department', labels: ['科室', '科室名称'] },
    { property: 'doctor', candidate: 'doctor', labels: ['医生', '医生姓名'] }
  ],
  'outpatientPlan.expertForm': [
    { property: 'province', candidate: 'service_province', labels: ['省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'expertType', candidate: 'expert_type', labels: ['点名专家类型'], options: ['普通专家', '特殊专家'] },
    { property: 'hospital', candidate: 'hospital', labels: ['选择医院'] },
    { property: 'department', candidate: 'department', labels: ['科室名称'] },
    { property: 'doctor', candidate: 'doctor', labels: ['医生姓名'] },
    { property: 'title', candidate: 'doctor_title', labels: ['医生职称'], options: ['主任医师', '副主任医师'] },
    { property: 'price', candidate: 'special_expert_price', labels: ['点名专家价格'], number: true },
    { property: 'situation', candidate: 'special_expert_situation', labels: ['点名情况'], options: expertSituationOptions }
  ],
  'hospital.expertForm': [
    { property: 'province', candidate: 'service_province', labels: ['省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'expertType', candidate: 'expert_type', labels: ['点名专家类型'], options: ['普通专家', '特殊专家'] },
    { property: 'hospital', candidate: 'hospital', labels: ['选择医院', '医院名称'] },
    { property: 'department', candidate: 'department', labels: ['科室名称'] },
    { property: 'doctor', candidate: 'doctor', labels: ['医生姓名'] },
    { property: 'title', candidate: 'doctor_title', labels: ['医生职称'], options: ['主任医师', '副主任医师'] },
    { property: 'price', candidate: 'special_expert_price', labels: ['点名专家价格'], number: true },
    { property: 'situation', candidate: 'special_expert_situation', labels: ['点名情况'], options: expertSituationOptions }
  ],
  'inpatient.expertForm': [
    { property: 'province', candidate: 'service_province', labels: ['省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'expertType', candidate: 'expert_type', labels: ['点名专家类型'], options: ['普通专家', '特殊专家'] },
    { property: 'hospital', candidate: 'hospital', labels: ['选择医院'] },
    { property: 'department', candidate: 'department', labels: ['科室名称'] },
    { property: 'doctor', candidate: 'doctor', labels: ['医生姓名'] },
    { property: 'title', candidate: 'doctor_title', labels: ['医生职称'], options: ['主任医师', '副主任医师'] },
    { property: 'price', candidate: 'special_expert_price', labels: ['点名专家价格'], number: true },
    { property: 'situation', candidate: 'special_expert_situation', labels: ['点名情况'], options: expertSituationOptions }
  ],
  'urgent.assignmentForm': [
    { property: 'province', candidate: 'service_province', labels: ['省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'hospital', candidate: 'hospital', labels: ['选择医院'] },
    { property: 'hospitalAddress', candidate: 'hospital_address', labels: ['医院地址'] },
    { property: 'item', candidate: 'inspection_item', labels: ['检查项目'], options: ['B超', '彩超', 'CT（除外PET-CT、SPECT）', '核磁（除外PET-MRI）', '超声心动', '普通胃镜', '普通肠镜', '普通胃肠镜', '无痛胃镜', '无痛肠镜', '无痛胃肠镜', '肾脏穿刺', '腰椎穿刺'] },
    { property: 'escort', candidate: 'escort_name', labels: ['陪诊人员'] },
    { property: 'contact', candidate: 'escort_phone', labels: ['陪诊人员联系方式'] }
  ],
  'urgent.specialForm': [
    { property: 'province', candidate: 'service_province', labels: ['省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'hospital', candidate: 'hospital', labels: ['选择医院'] },
    { property: 'item', candidate: 'inspection_item', labels: ['特殊检查项目'] },
    { property: 'price', candidate: 'special_inspection_price', labels: ['特殊项目价格(元)'], number: true },
    { property: 'situation', candidate: 'special_inspection_situation', labels: ['特殊情况'], options: ['特殊医院', '非常规项目', '其他'] }
  ],
  'outpatientAssignment.form': [
    { property: 'province', candidate: 'service_province', labels: ['省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'hospital', candidate: 'hospital', labels: ['就诊医院', '选择医院'] },
    { property: 'hospitalAddress', candidate: 'hospital_address', labels: ['医院地址'] },
    { property: 'escort', candidate: 'escort_name', labels: ['陪诊人员'] },
    { property: 'contact', candidate: 'escort_phone', labels: ['陪诊人员联系方式'] },
    { property: 'appointmentAt', candidate: 'outpatient_appointment_time', labels: ['预约就诊时间'], date: 'datetime' },
    { property: 'appointmentSuccessAt', candidate: 'outpatient_booking_success_time', labels: ['预约成功时间'], date: 'datetime' }
  ],
  'hospital.assignmentForm': [
    { property: 'province', candidate: 'service_province', labels: ['省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'hospital', candidate: 'hospital', labels: ['医院'] },
    { property: 'hospitalAddress', candidate: 'hospital_address', labels: ['医院地址'] },
    { property: 'department', candidate: 'department', labels: ['科室'] },
    { property: 'doctor', candidate: 'doctor', labels: ['医生姓名'] },
    { property: 'doctorTitle', candidate: 'doctor_title', labels: ['医生职称'], options: ['主任医师', '副主任医师'] },
    { property: 'escort', candidate: 'escort_name', labels: ['陪诊人员'] },
    { property: 'contact', candidate: 'escort_phone', labels: ['陪诊人员联系方式'] }
  ],
  'hospitalCareAssignment.form': [
    { property: 'province', candidate: 'service_province', labels: ['省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'hospital', candidate: 'hospital', labels: ['医院'] },
    { property: 'hospitalAddress', candidate: 'hospital_address', labels: ['医院地址'] },
    { property: 'department', candidate: 'department', labels: ['科室'] },
    { property: 'careStartDate', candidate: 'caregiver_start_time', labels: ['预计护工开启时间'], date: 'date' }
  ],
  'urgentEscort.form': [
    { property: 'waitingAddress', candidate: 'inspection_location', labels: ['候诊地址'] },
    { property: 'appointmentTime', candidate: 'inspection_booking_time', labels: ['预约检查时间'], date: 'datetime' },
    { property: 'appointmentSuccessTime', candidate: 'inspection_appointment_success_time', labels: ['预约成功时间'], date: 'datetime' },
    { property: 'actualCheckTime', candidate: 'inspection_actual_time', labels: ['实际检查时间'], date: 'datetime' }
  ],
  'hospitalEscort.form': [
    { property: 'admissionNo', candidate: 'admission_no', labels: ['住院单号'] },
    { property: 'appointmentTime', candidate: 'hospitalization_appointment_time', labels: ['约住院时间'], date: 'datetime' },
    { property: 'actualAdmissionTime', candidate: 'actual_admission_time', labels: ['实际住院时间'], date: 'datetime' },
    { property: 'dischargeTime', candidate: 'discharge_time', labels: ['出院时间'], date: 'datetime' },
    { property: 'admissionType', candidate: 'admission_type', labels: ['住院类型'] },
    { property: 'diagnosis', candidate: 'diagnosis_result', labels: ['诊断结论'] },
    { property: 'icd10', candidate: 'icd10_code', labels: ['ICD10编码'] },
    { property: 'admissionSummary', candidate: 'admission_summary', labels: ['住院总结'] },
    { property: 'revisitTime', candidate: 'revisit_time', labels: ['复诊时间'], date: 'datetime' }
  ],
  'registrationService.form': [
    { property: 'hospitalAddress', candidate: 'hospital_address', labels: ['医院地址'] },
    { property: 'latestTicketAt', candidate: 'latest_ticket_time', labels: ['最晚取号时间'], date: 'datetime' },
    { property: 'doctorName', candidate: 'doctor', labels: ['医生姓名'] },
    { property: 'doctorLevel', candidate: 'doctor_title', labels: ['医生级别'], options: ['主任医师', '副主任医师'] }
  ],
  'medicalTransport.form': [
    { property: 'originProvince', candidate: 'transport_origin_province', labels: ['实际出发地省'] },
    { property: 'originCity', candidate: 'transport_origin_city', labels: ['实际出发地市'] },
    { property: 'originDistrict', candidate: 'transport_origin_district', labels: ['实际出发地区'] },
    { property: 'originAddress', candidate: 'transport_origin_address', labels: ['实际出发地详细地址'] },
    { property: 'destinationProvince', candidate: 'transport_destination_province', labels: ['实际到达地省'] },
    { property: 'destinationCity', candidate: 'transport_destination_city', labels: ['实际到达地市'] },
    { property: 'destinationDistrict', candidate: 'transport_destination_district', labels: ['实际到达地区'] },
    { property: 'destinationAddress', candidate: 'transport_destination_address', labels: ['实际到达地详细地址'] },
    { property: 'serviceTime', candidate: 'transport_service_time', labels: ['实际服务时间'], date: 'datetime' },
    { property: 'distance', candidate: 'transport_distance', labels: ['起止距离（公里）'], options: ['100-200Km', '50-100Km', '30-50Km', '20-30Km', '10-20Km', '5-10Km', '0-5Km'] },
    { property: 'sameCity', candidate: 'transport_same_city', labels: ['是否同城'], options: ['是', '否'] },
    { property: 'transport', candidate: 'transport_mode', labels: ['交通工具'], options: ['火车', '飞机', '其他'] },
    { property: 'vehicle', candidate: 'transport_vehicle', labels: ['车型'], options: ['商务车', '救护车'] },
    { property: 'escortName', candidate: 'transport_escort_name', labels: ['陪诊姓名'] },
    { property: 'escortPhone', candidate: 'transport_escort_phone', labels: ['陪诊联系电话'] },
    { property: 'ticketAmount', candidate: 'transport_ticket_amount', labels: ['累计购票金额（元）'], number: true }
  ],
  'mdtService.form': [
    { property: 'diagnosis', candidate: 'mdt_diagnosis', labels: ['疾病诊断'] },
    { property: 'diseaseSummary', candidate: 'mdt_disease_summary', labels: ['疾病简介'] },
    { property: 'expertAdvice', candidate: 'mdt_expert_advice', labels: ['专家咨询建议'] }
  ],
  'mdtService.planDraft': [
    { property: 'hospital', candidate: 'hospital', labels: ['医院', '医院名称'] },
    { property: 'department', candidate: 'department', labels: ['科室', '就诊科室'] },
    { property: 'doctor', candidate: 'doctor', labels: ['医生', '就诊医生'] },
    { property: 'title', candidate: 'doctor_title', labels: ['医生职称', '职称'], options: ['主任医师', '副主任医师'] }
  ],
  'outpatientEscort.form': [
    { property: 'summary', candidate: 'escort_service_summary', labels: ['门诊小结'] }
  ],
  'sharedService.form': [
    { property: 'hospital', candidate: 'hospital', labels: ['医院'] },
    { property: 'address', candidate: 'hospital_address', labels: ['医院地址'] },
    { property: 'department', candidate: 'department', labels: ['科室'] },
    { property: 'expert', candidate: 'doctor', labels: ['专家'] }
  ],
  'hospitalCareEscort.form': [
    { property: 'feedback', candidate: 'caregiver_feedback', labels: ['服务反馈'] }
  ],
  'hospitalCareEscort.feedback': [
    { property: '$value', candidate: 'caregiver_feedback', labels: ['服务反馈'] }
  ],
  'fullProcess.newOutpatientModal.form': [
    { property: 'province', candidate: 'service_province', labels: ['省', '地域选择：省'] },
    { property: 'city', candidate: 'service_city', labels: ['市'] },
    { property: 'hospital', candidate: 'hospital', labels: ['就诊医院', '医院名称'] },
    { property: 'department', candidate: 'department', labels: ['就诊科室'] },
    { property: 'doctor', candidate: 'doctor', labels: ['就诊医生'] },
    { property: 'title', candidate: 'doctor_title', labels: ['医生职称', '职称'], options: ['主任医师', '副主任医师'] },
    { property: 'hospitalAddress', candidate: 'hospital_address', labels: ['医院地址'] },
    { property: 'appointmentAt', candidate: 'outpatient_appointment_time', labels: ['预约就诊时间'], date: 'datetime' },
    { property: 'successAt', candidate: 'outpatient_booking_success_time', labels: ['预约成功时间'], date: 'datetime' }
  ]
}

export function bOrderAiRules(key: string): readonly FieldRule[] { return rules[key] ?? [] }

export function bOrderAiKeysForServiceTab(serviceType: string, tabCode: string): readonly string[] {
  if (tabCode === 'plan') {
    if (['全程门诊', '全流程', '单次门诊', '电话问诊'].includes(serviceType)) return ['outpatientPlan.planForm', 'outpatientPlan.expertForm']
    if (serviceType === 'MDT服务') return ['mdtService.planDraft']
  }
  if (tabCode === 'assignment') {
    if (serviceType.includes('检查加急')) return ['urgent.assignmentForm', 'urgent.specialForm']
    if (serviceType === '住院') return ['hospital.assignmentForm', 'hospital.expertForm']
    if (serviceType === '住院护工协助') return ['hospitalCareAssignment.form']
    if (['全程门诊', '单次门诊', '电话问诊'].includes(serviceType)) return ['outpatientAssignment.form']
  }
  if (tabCode === 'service-record') {
    if (serviceType.includes('检查加急')) return ['urgentEscort.form']
    if (serviceType === '住院') return ['hospitalEscort.form']
    if (serviceType === '挂号协助') return ['registrationService.form']
    if (serviceType === '住院护工协助') return ['hospitalCareEscort.feedback']
    if (serviceType === '就医接送') return ['medicalTransport.form']
    if (serviceType === 'MDT服务') return ['mdtService.form']
    if (serviceType === '共享流程') return ['sharedService.form']
    if (serviceType === '全流程') return ['inpatient.expertForm', 'outpatientEscort.form', 'fullProcess.newOutpatientModal.form']
    if (['全程门诊', '单次门诊', '电话问诊'].includes(serviceType)) return ['outpatientEscort.form']
  }
  return []
}

export function bOrderAiKeysForSubmit(serviceType: string, tabCode: string, validationKey: string): readonly string[] {
  if (validationKey === 'urgent.assignment.validated') return ['urgent.assignmentForm']
  if (validationKey === 'hospital.assignment.validated') return ['hospital.assignmentForm']
  if (validationKey !== 'form.validated') return []
  if (tabCode === 'assignment') {
    if (serviceType === '住院') return ['hospital.assignmentForm']
    if (serviceType === '住院护工协助') return ['hospitalCareAssignment.form']
    if (['全程门诊', '单次门诊', '电话问诊'].includes(serviceType)) return ['outpatientAssignment.form']
  }
  if (tabCode === 'service-record') {
    if (serviceType.includes('检查加急')) return ['urgentEscort.form']
    if (serviceType === '住院') return ['hospitalEscort.form']
    if (serviceType === '挂号协助') return ['registrationService.form']
    if (serviceType === '就医接送') return ['medicalTransport.form']
    if (serviceType === 'MDT服务') return ['mdtService.form']
    if (serviceType === '共享流程') return ['sharedService.form']
    if (serviceType === '住院护工协助') return ['hospitalCareEscort.feedback']
    if (['全程门诊', '单次门诊', '电话问诊'].includes(serviceType)) return ['outpatientEscort.form']
  }
  return []
}

export function usableBOrderAiCandidate(candidate: OrderAiFieldCandidate | undefined): candidate is OrderAiFieldCandidate {
  return Boolean(candidate && candidate.candidateType === 'new_or_confirmed' && candidate.evidence?.length && candidate.value.trim())
}

function candidateValue(candidate: OrderAiFieldCandidate, rule: FieldRule): string | null {
  const raw = candidate.value.trim()
  const value = rule.date === 'datetime'
    ? (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) ? raw.replace(' ', 'T') : '')
    : rule.date === 'date' ? (/^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '') : raw
  if (!value || (rule.options && !rule.options.includes(value))) return null
  if (rule.number && !/^\d+(?:\.\d{1,2})?$/.test(value.replace(/[￥¥,，\s]/g, ''))) return null
  if (rule.number) return value.replace(/[￥¥,，\s]/g, '')
  return value
}

export function overlayBOrderAi<T>(key: string, formal: T, candidates: readonly OrderAiFieldCandidate[], dismissedIds: ReadonlySet<number> = new Set()): { value: T; filled: Record<string, OrderAiFieldCandidate> } {
  if (typeof formal === 'string') {
    if (formal.trim()) return { value: formal, filled: {} }
    const rule = bOrderAiRules(key).find((item) => item.property === '$value')
    const candidate = rule && candidates.find((item) => item.fieldCode === rule.candidate)
    if (!rule || !usableBOrderAiCandidate(candidate) || dismissedIds.has(candidate.id)) return { value: formal, filled: {} }
    const value = candidateValue(candidate, rule)
    return value ? { value: value as T, filled: { $value: candidate } } : { value: formal, filled: {} }
  }
  if (!formal || typeof formal !== 'object' || Array.isArray(formal)) return { value: formal, filled: {} }
  const result = { ...formal } as Record<string, unknown>
  const filled: Record<string, OrderAiFieldCandidate> = {}
  for (const rule of bOrderAiRules(key)) {
    const current = result[rule.property]
    if (current != null && String(current).trim()) continue
    const candidate = candidates.find((item) => item.fieldCode === rule.candidate)
    if (!usableBOrderAiCandidate(candidate) || dismissedIds.has(candidate.id)) continue
    const value = candidateValue(candidate, rule)
    if (!value) continue
    result[rule.property] = value
    filled[rule.property] = candidate
  }
  return { value: result as T, filled }
}

export function bOrderAiCandidateForLabel(
  key: string,
  property: string,
  candidate: OrderAiFieldCandidate
): readonly string[] {
  const rule = bOrderAiRules(key).find((item) => item.property === property && item.candidate === candidate.fieldCode)
  return rule?.labels ?? []
}
