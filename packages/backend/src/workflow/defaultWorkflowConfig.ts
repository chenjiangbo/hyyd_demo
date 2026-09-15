/** 默认业务步骤配置：仅用于首次初始化配置表，运行时以数据库已发布配置为准。 */
export type WorkflowActivationMode = 'initial' | 'event'
export type DefaultWorkflowStep = {
  code: string
  name: string
  parentCode?: string | null
  kind?: 'step' | 'package'
  sortOrder: number
  isRequired?: boolean
  isRepeatable?: boolean
  activationMode?: WorkflowActivationMode
  triggerEventCode?: string | null
}

export type DefaultWorkflowTemplate = {
  serviceType: string
  code: string
  name: string
  steps: DefaultWorkflowStep[]
}

const base = (withPlan = false): DefaultWorkflowStep[] => [
  { code: 'claim', name: '申领', sortOrder: 10 },
  { code: 'initial_contact', name: '初次沟通', sortOrder: 20 },
  ...(withPlan ? [{ code: 'pre_visit_plan', name: '诊前方案', sortOrder: 30 }] : [])
]
const end: DefaultWorkflowStep = { code: 'end', name: '结束', sortOrder: 1000000 }
const registrationPackage = (sortOrder = 40): DefaultWorkflowStep[] => [
  { code: 'registration_service', name: '挂号就诊服务', kind: 'package', sortOrder },
  { code: 'registration', name: '挂号', parentCode: 'registration_service', sortOrder: sortOrder + 1 },
  { code: 'escort', name: '陪诊', parentCode: 'registration_service', sortOrder: sortOrder + 2 }
]
const registrationOnly = (sortOrder = 40): DefaultWorkflowStep => ({ code: 'registration', name: '挂号', sortOrder })
const packageSteps = (
  code: string,
  name: string,
  firstChildCode: string,
  firstChildName: string,
  secondChildCode: string,
  secondChildName: string,
  sortOrder: number,
  activationMode: WorkflowActivationMode,
  triggerEventCode: string | null,
  isRequired: boolean
): DefaultWorkflowStep[] => [
  { code, name, kind: 'package', sortOrder, activationMode, triggerEventCode, isRepeatable: true, isRequired },
  { code: firstChildCode, name: firstChildName, parentCode: code, sortOrder: sortOrder + 1, activationMode, triggerEventCode },
  { code: secondChildCode, name: secondChildName, parentCode: code, sortOrder: sortOrder + 2, activationMode, triggerEventCode }
]

export const DEFAULT_WORKFLOW_TEMPLATES: DefaultWorkflowTemplate[] = [
  {
    serviceType: '全程门诊', code: 'outpatient_full', name: '全程门诊服务步骤',
    steps: [...base(true), ...registrationPackage(), ...packageSteps('revisit_service', '复诊服务', 'revisit', '复诊', 'revisit_escort', '免费陪诊', 60, 'event', 'revisit_confirmed', false), end]
  },
  {
    serviceType: '全流程', code: 'full_process', name: '全流程服务步骤',
    steps: [
      ...base(true), ...registrationPackage(),
      ...packageSteps('hospital_service', '住院服务', 'hospital_booking', '约住院', 'hospital_companion', '住院陪同', 50, 'event', 'hospital_confirmed', false),
      ...packageSteps('revisit_service', '复诊服务', 'revisit', '复诊', 'revisit_escort', '免费陪诊', 60, 'event', 'revisit_confirmed', false),
      end
    ]
  },
  { serviceType: '单次门诊', code: 'outpatient_once', name: '单次门诊服务步骤', steps: [...base(true), ...registrationPackage(), end] },
  { serviceType: '电话问诊', code: 'phone_consultation', name: '电话问诊服务步骤', steps: [...base(true), ...registrationPackage(), end] },
  { serviceType: 'MDT服务', code: 'mdt', name: 'MDT 服务步骤', steps: [...base(true), ...registrationPackage(), end] },
  { serviceType: '挂号协助', code: 'registration_assistance', name: '挂号协助服务步骤', steps: [...base(true), registrationOnly(), end] },
  {
    serviceType: '检查加急', code: 'urgent_check', name: '检查加急服务步骤',
    steps: [...base(), ...packageSteps('check_service', '检查服务', 'check_booking', '约检查', 'check_companion', '检查陪同', 30, 'initial', null, true), end]
  },
  {
    serviceType: '住院', code: 'hospitalization', name: '住院服务步骤',
    steps: [...base(), ...packageSteps('hospital_service', '住院服务', 'hospital_booking', '约住院', 'hospital_companion', '住院陪同', 30, 'initial', null, true), end]
  },
  { serviceType: '住院护工协助', code: 'hospital_care', name: '住院护工协助步骤', steps: [...base(), { code: 'hospital_care', name: '住院护工', sortOrder: 30 }, end] },
  { serviceType: '就医接送', code: 'medical_transport', name: '就医接送服务步骤', steps: [...base(), { code: 'medical_transport', name: '就医接送', sortOrder: 30 }, end] },
  { serviceType: '共享流程', code: 'shared_process', name: '共享流程服务步骤', steps: [...base(), { code: 'home_care', name: '上门照护', sortOrder: 30 }, end] },
  { serviceType: '未识别服务', code: 'unclassified', name: '未识别服务步骤', steps: [...base(), end] }
]
