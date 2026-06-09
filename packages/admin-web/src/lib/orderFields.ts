// 泰康 detailJson.recommendations 字段的中文标签映射。
// 来源：tray-app OrderDetailModal.tsx 已做过的语义化标签。
// 已知字段给中文 + 分组；未知字段在页面里原样 key=value 展示（并标注"原始值"）。

export interface FieldGroup {
  group: string
  fields: Array<{ key: string; label: string }>
}

export const ORDER_FIELD_GROUPS: FieldGroup[] = [
  {
    group: '基本信息',
    fields: [
      { key: 'subOrderNo', label: '泰康订单号' },
      { key: 'applyNo', label: '申请号' },
      { key: 'crmApplyNo', label: 'CRM 申请号' },
      { key: 'patientName', label: '就诊人' },
      { key: 'sex', label: '性别' },
      { key: 'birthday', label: '生日' },
      { key: 'cardType', label: '证件类型' },
      { key: 'paMobile', label: '联系电话' },
      { key: 'cusLevel', label: '客户等级' },
      { key: 'relationship', label: '客户关系' }
    ]
  },
  {
    group: '保单 / 投保',
    fields: [
      { key: 'insurName', label: '投保人' },
      { key: 'insurNo', label: '保单号' },
      { key: 'insurBrhName', label: '保单机构' },
      { key: 'ecpPhone', label: '紧急联系电话' },
      { key: 'patEcpRelationship', label: '与投保人关系' },
      { key: 'socSecNo', label: '社保号' }
    ]
  },
  {
    group: '意向就诊',
    fields: [
      { key: 'intendHos', label: '意向医院' },
      { key: 'intendCity', label: '意向城市' },
      { key: 'intendDept', label: '意向科室' },
      { key: 'intendDoc', label: '意向医生' },
      { key: 'intendDocTitle', label: '医生职称' },
      { key: 'intendDate', label: '就诊日期' },
      { key: 'suspectDisease', label: '疑似疾病' },
      { key: 'approveDetail', label: '确诊情况' },
      { key: 'approveDiseaseDesc', label: '确诊详情' }
    ]
  },
  {
    group: '服务信息',
    fields: [
      { key: 'visitingHospital', label: '服务医院' },
      { key: 'visitingCity', label: '服务城市' },
      { key: 'departureAddress', label: '出发地' },
      { key: 'visitingHospitalDetailAddress', label: '服务详址' },
      { key: 'accompanyFamilyMembersName', label: '家属姓名' },
      { key: 'accompanyFamilyMembersMobile', label: '家属电话' },
      { key: 'estimateOutHospitalDate', label: '预计出院' }
    ]
  },
  {
    group: '产品 / 方案',
    fields: [
      { key: 'serviceItemName', label: '服务项' },
      { key: 'subPlanName', label: '子方案' },
      { key: 'packetName', label: '套餐' },
      { key: 'planName', label: '方案' },
      { key: 'planAlias', label: '方案别名' },
      { key: 'productName', label: '产品' },
      { key: 'labelName', label: '标签' }
    ]
  },
  {
    group: '状态 / 时间',
    fields: [
      { key: 'orderStateName', label: '订单状态' },
      { key: 'stageName', label: '当前阶段' },
      { key: 'servStateName', label: '服务状态' },
      { key: 'applyWayDesc', label: '申请方式' },
      { key: 'applicationDate', label: '申请时间' },
      { key: 'mmgrApplyDate', label: '受理时间' },
      { key: 'startDate', label: '服务开始' }
    ]
  }
]

// 所有已知 key 的集合，用于挑出"未知字段"。
export const KNOWN_KEYS = new Set(
  ORDER_FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key))
)

// 值是否算"空"（不展示）
export function isEmptyVal(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
}
