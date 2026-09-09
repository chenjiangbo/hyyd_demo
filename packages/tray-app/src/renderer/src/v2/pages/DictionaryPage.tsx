import React, { useState } from 'react'
import InternalDepartmentView from './dictionary/InternalDepartmentView'

interface SubDepartmentItem {
  id: string // 数据库物理主键 (NAME_YJKS + xh，如 00010002)
  xh: string // 界面显示/编辑的序号ID (如 0002)
  parentDeptId: string // 所属上级科室ID (NAME_YJKS，如 0001)
  name: string // 科室细分名称
  status: 'enabled' | 'disabled'
  updatedAt: string
}

interface DepartmentItem {
  id: string
  name: string
  desc: string
  status: 'enabled' | 'disabled'
  createdAt: string
  updatedAt: string
  subDepartments: SubDepartmentItem[]
}

interface ExternalDepartmentItem {
  id: string
  name: string
  internalLevel1: string
  internalLevel2: string
  status: 'enabled' | 'disabled'
  updatedAt: string
}

interface HospitalItem {
  id: string
  name: string
  level: string
  tag: string
  province: string
  city: string
  address1: string
  address2: string
  address3: string
  tips: string
  remark: string
  status: 'enabled' | 'disabled'
  updatedAt: string
  externalDepartments?: ExternalDepartmentItem[]
}

// ─── 4. 渠道管理类型 (f_hy_qd + f_hy_cp_qd) ───
interface ChannelProductItem {
  id: string
  xh: string
  channelId: string
  name: string
  price: number | string
  internalLevel1: string
  internalLevel2: string
  status: 'enabled' | 'disabled'
  updatedAt: string
}

interface ChannelItem {
  id: string
  name: string
  status: 'enabled' | 'disabled'
  createdAt: string
  updatedAt: string
  products: ChannelProductItem[]
}

// ─── 5. 对内产品管理类型 (f_hy_cp + f_hy_zcp) ───
interface InternalSubProductItem {
  id: string
  xh: string
  parentProductId: string
  name: string
  price: number | string
  status: 'enabled' | 'disabled'
  updatedAt: string
}

interface InternalProductItem {
  id: string
  name: string
  desc: string
  type: string
  status: 'enabled' | 'disabled'
  createdAt: string
  updatedAt: string
  subProducts: InternalSubProductItem[]
}

// ─── 6. 支付渠道管理类型 (zfqd) ───
interface PaymentChannelItem {
  id: string
  name: string
  hospital: string
  feeRate: number | string
  feeType: string
  remark: string
  status: 'enabled' | 'disabled'
  updatedAt: string
}

// ─── 7. 陪诊人管理类型 (f_hy_pzr) ───
interface EscortItem {
  id: string
  name: string
  gender: '男' | '女'
  phone: string
  provinceCode: string
  cityCode: string
  type: string
  remark: string
  status: 'enabled' | 'disabled'
  createdAt: string
  updatedAt: string
}

interface DoctorItem {
  id: string
  name: string
  gender: '男' | '女'
  birthday: string
  phone: string
  email: string
  province: string
  city: string
  hospital: string
  department: string
  title: string
  teachingTitle: string
  adminPosition: string
  socialPosition: string
  specialty: string
  remark: string
  status: 'enabled' | 'disabled'
  createdAt: string
  updatedAt: string
}

const DEPT_STORAGE_KEY = 'hyyd.v2.dictionary.departments_v4_full'
const HOSP_STORAGE_KEY = 'hyyd.v2.dictionary.hospitals_v2'
const DOCTOR_STORAGE_KEY = 'hyyd.v2.dictionary.doctors_v2'
const CHANNEL_STORAGE_KEY = 'hyyd.v2.dictionary.channels_v1'
const INTERNAL_PRODUCT_STORAGE_KEY = 'hyyd.v2.dictionary.internal_products_v1'
const PAYMENT_CHANNEL_STORAGE_KEY = 'hyyd.v2.dictionary.payment_channels_v1'
const ESCORT_STORAGE_KEY = 'hyyd.v2.dictionary.escorts_v1'

function getTodayString(): string {
  const now = new Date()
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
}

const INITIAL_DEPARTMENTS: DepartmentItem[] = [
  {
    "id": "0001",
    "name": "外科系统",
    "desc": "外科系统",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00010001",
        "xh": "0001",
        "parentDeptId": "0001",
        "name": "基本外科",
        "status": "enabled",
        "updatedAt": "2023年12月25日"
      },
      {
        "id": "00010002",
        "xh": "0002",
        "parentDeptId": "0001",
        "name": "胸外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010003",
        "xh": "0003",
        "parentDeptId": "0001",
        "name": "泌尿外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010004",
        "xh": "0004",
        "parentDeptId": "0001",
        "name": "血管外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010005",
        "xh": "0005",
        "parentDeptId": "0001",
        "name": "神经外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010006",
        "xh": "0006",
        "parentDeptId": "0001",
        "name": "整形外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010007",
        "xh": "0007",
        "parentDeptId": "0001",
        "name": "乳腺外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010008",
        "xh": "0008",
        "parentDeptId": "0001",
        "name": "肝胆外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010009",
        "xh": "0009",
        "parentDeptId": "0001",
        "name": "胰腺外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010010",
        "xh": "0010",
        "parentDeptId": "0001",
        "name": "胃肠外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010011",
        "xh": "0011",
        "parentDeptId": "0001",
        "name": "结直肠外科",
        "status": "enabled",
        "updatedAt": "2023年12月25日"
      },
      {
        "id": "00010012",
        "xh": "0012",
        "parentDeptId": "0001",
        "name": "心外科",
        "status": "enabled",
        "updatedAt": "2023年12月25日"
      },
      {
        "id": "00010013",
        "xh": "0013",
        "parentDeptId": "0001",
        "name": "甲状腺外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00010014",
        "xh": "0014",
        "parentDeptId": "0001",
        "name": "男科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0002",
    "name": "内科系统",
    "desc": "内科系统相关",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00020001",
        "xh": "0001",
        "parentDeptId": "0002",
        "name": "普通内科",
        "status": "enabled",
        "updatedAt": "2023年12月25日"
      },
      {
        "id": "00020002",
        "xh": "0002",
        "parentDeptId": "0002",
        "name": "消化内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00020003",
        "xh": "0003",
        "parentDeptId": "0002",
        "name": "风湿免疫科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00020004",
        "xh": "0004",
        "parentDeptId": "0002",
        "name": "呼吸内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00020005",
        "xh": "0005",
        "parentDeptId": "0002",
        "name": "血液内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00020006",
        "xh": "0006",
        "parentDeptId": "0002",
        "name": "心内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00020007",
        "xh": "0007",
        "parentDeptId": "0002",
        "name": "肾内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00020008",
        "xh": "0008",
        "parentDeptId": "0002",
        "name": "内分泌科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00020009",
        "xh": "0009",
        "parentDeptId": "0002",
        "name": "神经内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00020010",
        "xh": "0010",
        "parentDeptId": "0002",
        "name": "肿瘤内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00020011",
        "xh": "0011",
        "parentDeptId": "0002",
        "name": "感染内科",
        "status": "enabled",
        "updatedAt": "2023年12月25日"
      }
    ]
  },
  {
    "id": "0003",
    "name": "眼科学系",
    "desc": "眼科相关",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00030001",
        "xh": "0001",
        "parentDeptId": "0003",
        "name": "眼综合科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00030002",
        "xh": "0002",
        "parentDeptId": "0003",
        "name": "眼底病科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00030003",
        "xh": "0003",
        "parentDeptId": "0003",
        "name": "角膜科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00030004",
        "xh": "0004",
        "parentDeptId": "0003",
        "name": "斜视与小儿眼科科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00030005",
        "xh": "0005",
        "parentDeptId": "0003",
        "name": "青光眼科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00030006",
        "xh": "0006",
        "parentDeptId": "0003",
        "name": "眼肿瘤科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00030007",
        "xh": "0007",
        "parentDeptId": "0003",
        "name": "眼整形科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00030008",
        "xh": "0008",
        "parentDeptId": "0003",
        "name": "眼外伤科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00030009",
        "xh": "0009",
        "parentDeptId": "0003",
        "name": "白内障科",
        "status": "enabled",
        "updatedAt": "2023年12月13日"
      }
    ]
  },
  {
    "id": "0004",
    "name": "妇产科学系",
    "desc": "妇产相关学科",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00040001",
        "xh": "0001",
        "parentDeptId": "0004",
        "name": "妇科综合",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00040002",
        "xh": "0002",
        "parentDeptId": "0004",
        "name": "妇科肿瘤",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00040003",
        "xh": "0003",
        "parentDeptId": "0004",
        "name": "计划生育科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00040004",
        "xh": "0004",
        "parentDeptId": "0004",
        "name": "妇科内分泌",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00040005",
        "xh": "0005",
        "parentDeptId": "0004",
        "name": "产科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0005",
    "name": "耳鼻喉科",
    "desc": "耳鼻喉头颈相关",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00050001",
        "xh": "0001",
        "parentDeptId": "0005",
        "name": "耳科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00050002",
        "xh": "0002",
        "parentDeptId": "0005",
        "name": "鼻科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00050003",
        "xh": "0003",
        "parentDeptId": "0005",
        "name": "喉科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00050004",
        "xh": "0004",
        "parentDeptId": "0005",
        "name": "头颈外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00050005",
        "xh": "0005",
        "parentDeptId": "0005",
        "name": "耳鼻喉科",
        "status": "enabled",
        "updatedAt": "2023年12月25日"
      }
    ]
  },
  {
    "id": "0006",
    "name": "口腔学系",
    "desc": "口腔",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00060001",
        "xh": "0001",
        "parentDeptId": "0006",
        "name": "牙体牙髓科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060002",
        "xh": "0002",
        "parentDeptId": "0006",
        "name": "牙周科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060003",
        "xh": "0003",
        "parentDeptId": "0006",
        "name": "粘膜科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060004",
        "xh": "0004",
        "parentDeptId": "0006",
        "name": "正畸科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060005",
        "xh": "0005",
        "parentDeptId": "0006",
        "name": "儿童口腔科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060006",
        "xh": "0006",
        "parentDeptId": "0006",
        "name": "修复科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060007",
        "xh": "0007",
        "parentDeptId": "0006",
        "name": "种植科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060008",
        "xh": "0008",
        "parentDeptId": "0006",
        "name": "口腔综合",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060009",
        "xh": "0009",
        "parentDeptId": "0006",
        "name": "口腔外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060010",
        "xh": "0010",
        "parentDeptId": "0006",
        "name": "口腔肿瘤外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00060011",
        "xh": "0011",
        "parentDeptId": "0006",
        "name": "颞下颌关节科",
        "status": "enabled",
        "updatedAt": "2023年12月26日"
      },
      {
        "id": "00060012",
        "xh": "0012",
        "parentDeptId": "0006",
        "name": "口腔正颌",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0007",
    "name": "骨科学系",
    "desc": "骨科",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00070001",
        "xh": "0001",
        "parentDeptId": "0007",
        "name": "骨科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00070002",
        "xh": "0002",
        "parentDeptId": "0007",
        "name": "创伤骨科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00070003",
        "xh": "0003",
        "parentDeptId": "0007",
        "name": "脊柱外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00070004",
        "xh": "0004",
        "parentDeptId": "0007",
        "name": "运动医学科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00070005",
        "xh": "0005",
        "parentDeptId": "0007",
        "name": "骨肿瘤科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00070006",
        "xh": "0006",
        "parentDeptId": "0007",
        "name": "关节外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00070007",
        "xh": "0007",
        "parentDeptId": "0007",
        "name": "小儿骨科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00070008",
        "xh": "0008",
        "parentDeptId": "0007",
        "name": "手外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00070009",
        "xh": "0009",
        "parentDeptId": "0007",
        "name": "足踝外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0008",
    "name": "核医学及放射学系",
    "desc": "核医学，放射，放疗等",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00080001",
        "xh": "0001",
        "parentDeptId": "0008",
        "name": "放疗科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00080002",
        "xh": "0002",
        "parentDeptId": "0008",
        "name": "核医学科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00080003",
        "xh": "0003",
        "parentDeptId": "0008",
        "name": "影像科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00080004",
        "xh": "0004",
        "parentDeptId": "0008",
        "name": "放射科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00080005",
        "xh": "0005",
        "parentDeptId": "0008",
        "name": "放射介入科",
        "status": "enabled",
        "updatedAt": "2025年7月24日"
      }
    ]
  },
  {
    "id": "0009",
    "name": "生殖医学",
    "desc": "生殖",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00090001",
        "xh": "0001",
        "parentDeptId": "0009",
        "name": "生殖医学妇科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00090002",
        "xh": "0002",
        "parentDeptId": "0009",
        "name": "生殖医学男科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0010",
    "name": "中医学",
    "desc": "中医学科",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00100001",
        "xh": "0001",
        "parentDeptId": "0010",
        "name": "中医科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00100002",
        "xh": "0002",
        "parentDeptId": "0010",
        "name": "中医肿瘤内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00100003",
        "xh": "0003",
        "parentDeptId": "0010",
        "name": "中医肾内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00100004",
        "xh": "0004",
        "parentDeptId": "0010",
        "name": "中医心内科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00100005",
        "xh": "0005",
        "parentDeptId": "0010",
        "name": "中医内分泌科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00100006",
        "xh": "0006",
        "parentDeptId": "0010",
        "name": "推拿科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00100007",
        "xh": "0007",
        "parentDeptId": "0010",
        "name": "针灸科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00100008",
        "xh": "0008",
        "parentDeptId": "0010",
        "name": "中医血液科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0011",
    "name": "变态反应科",
    "desc": "变态反应，过敏，哮喘等",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00110001",
        "xh": "0001",
        "parentDeptId": "0011",
        "name": "变态反应科",
        "status": "enabled",
        "updatedAt": "2023年12月25日"
      }
    ]
  },
  {
    "id": "0012",
    "name": "皮肤科",
    "desc": "皮肤性病",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00120001",
        "xh": "0001",
        "parentDeptId": "0012",
        "name": "皮肤科",
        "status": "enabled",
        "updatedAt": "2023年12月26日"
      },
      {
        "id": "00120002",
        "xh": "0002",
        "parentDeptId": "0012",
        "name": "性病科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00120003",
        "xh": "0003",
        "parentDeptId": "0012",
        "name": "激光美容科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00120004",
        "xh": "0004",
        "parentDeptId": "0012",
        "name": "皮肤外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0013",
    "name": "儿科",
    "desc": "儿科医学",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00130001",
        "xh": "0001",
        "parentDeptId": "0013",
        "name": "儿科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00130002",
        "xh": "0002",
        "parentDeptId": "0013",
        "name": "新生儿科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00130003",
        "xh": "0003",
        "parentDeptId": "0013",
        "name": "发育保健科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00130004",
        "xh": "0004",
        "parentDeptId": "0013",
        "name": "儿童泌尿外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00130005",
        "xh": "0005",
        "parentDeptId": "0013",
        "name": "儿童普外科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00130006",
        "xh": "0006",
        "parentDeptId": "0013",
        "name": "儿童血液科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00130007",
        "xh": "0007",
        "parentDeptId": "0013",
        "name": "儿童消化科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00130008",
        "xh": "0008",
        "parentDeptId": "0013",
        "name": "儿童呼吸科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0014",
    "name": "老年医学科",
    "desc": "老年学科",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00140001",
        "xh": "0001",
        "parentDeptId": "0014",
        "name": "老年科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0015",
    "name": "重症医学科",
    "desc": "重症医学",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00150001",
        "xh": "0001",
        "parentDeptId": "0015",
        "name": "重症医学科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0016",
    "name": "心理精神科",
    "desc": "心理精神相关",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00160001",
        "xh": "0001",
        "parentDeptId": "0016",
        "name": "成人精神科",
        "status": "enabled",
        "updatedAt": "2023年12月25日"
      },
      {
        "id": "00160002",
        "xh": "0002",
        "parentDeptId": "0016",
        "name": "儿童精神科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0017",
    "name": "超声医学",
    "desc": "超声医学相关",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00170001",
        "xh": "0001",
        "parentDeptId": "0017",
        "name": "超声诊断科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00170002",
        "xh": "0002",
        "parentDeptId": "0017",
        "name": "超声介入科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0018",
    "name": "麻醉科",
    "desc": "麻醉，疼痛相关",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00180001",
        "xh": "0001",
        "parentDeptId": "0018",
        "name": "麻醉科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      },
      {
        "id": "00180002",
        "xh": "0002",
        "parentDeptId": "0018",
        "name": "疼痛科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0019",
    "name": "康复医学",
    "desc": "康复相关",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00190001",
        "xh": "0001",
        "parentDeptId": "0019",
        "name": "康复医学科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0020",
    "name": "营养科医学",
    "desc": "营养科",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00200001",
        "xh": "0001",
        "parentDeptId": "0020",
        "name": "临床营养科",
        "status": "enabled",
        "updatedAt": "2023年12月9日"
      }
    ]
  },
  {
    "id": "0021",
    "name": "病理科",
    "desc": "病理诊断",
    "status": "enabled",
    "createdAt": "2023年12月9日",
    "updatedAt": "2023年12月9日",
    "subDepartments": [
      {
        "id": "00210001",
        "xh": "0001",
        "parentDeptId": "0021",
        "name": "病理科",
        "status": "enabled",
        "updatedAt": "2023年12月25日"
      }
    ]
  },
  {
    "id": "0022",
    "name": "健康体检管理中心",
    "desc": "体检中心",
    "status": "enabled",
    "createdAt": "2024年1月4日",
    "updatedAt": "2024年1月4日",
    "subDepartments": [
      {
        "id": "00220001",
        "xh": "0001",
        "parentDeptId": "0022",
        "name": "体检中心",
        "status": "enabled",
        "updatedAt": "2024年1月4日"
      }
    ]
  },
  {
    "id": "0023",
    "name": "急诊医学",
    "desc": "急诊",
    "status": "enabled",
    "createdAt": "2024年2月19日",
    "updatedAt": "2024年2月19日",
    "subDepartments": [
      {
        "id": "00230001",
        "xh": "0001",
        "parentDeptId": "0023",
        "name": "急诊",
        "status": "enabled",
        "updatedAt": "2024年2月19日"
      }
    ]
  },
  {
    "id": "0024",
    "name": "多学科",
    "desc": "多学科",
    "status": "enabled",
    "createdAt": "2024年5月28日",
    "updatedAt": "2024年5月28日",
    "subDepartments": [
      {
        "id": "00240001",
        "xh": "0001",
        "parentDeptId": "0024",
        "name": "多学科MDT",
        "status": "enabled",
        "updatedAt": "2024年5月28日"
      }
    ]
  },
  {
    "id": "0025",
    "name": "烧伤医学",
    "desc": "烧伤医学相关",
    "status": "enabled",
    "createdAt": "2025年6月10日",
    "updatedAt": "2025年6月10日",
    "subDepartments": [
      {
        "id": "00250001",
        "xh": "0001",
        "parentDeptId": "0025",
        "name": "烧伤科",
        "status": "enabled",
        "updatedAt": "2025年6月10日"
      }
    ]
  }
]

const INITIAL_EXTERNAL_DEPARTMENTS: ExternalDepartmentItem[] = [
  { id: '0046', name: '罕见病联合门诊 (神经科)', internalLevel1: '内科系统', internalLevel2: '神经内科', status: 'enabled', updatedAt: '2024年3月7日' },
  { id: '0001', name: '普通内科', internalLevel1: '内科系统', internalLevel2: '普通内科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0002', name: '呼吸内科', internalLevel1: '内科系统', internalLevel2: '呼吸内科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0003', name: '心内科', internalLevel1: '内科系统', internalLevel2: '心内科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0004', name: '消化内科', internalLevel1: '内科系统', internalLevel2: '消化内科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0005', name: '感染内科', internalLevel1: '内科系统', internalLevel2: '感染内科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0006', name: '内分泌科', internalLevel1: '内科系统', internalLevel2: '内分泌科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0007', name: '神经内科', internalLevel1: '内科系统', internalLevel2: '神经内科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0008', name: '肾内科', internalLevel1: '内科系统', internalLevel2: '肾内科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0009', name: '肿瘤内科', internalLevel1: '内科系统', internalLevel2: '肿瘤内科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0010', name: '血液内科', internalLevel1: '内科系统', internalLevel2: '血液内科', status: 'enabled', updatedAt: '2024年1月7日' },
  { id: '0011', name: '风湿免疫科', internalLevel1: '内科系统', internalLevel2: '风湿免疫科', status: 'enabled', updatedAt: '2023年12月13日' },
  { id: '0012', name: '基本外科', internalLevel1: '外科系统', internalLevel2: '基本外科', status: 'enabled', updatedAt: '2023年12月25日' },
  { id: '0013', name: '胸外科', internalLevel1: '外科系统', internalLevel2: '胸外科', status: 'enabled', updatedAt: '2023年12月13日' },
  { id: '0014', name: '泌尿外科', internalLevel1: '外科系统', internalLevel2: '泌尿外科', status: 'enabled', updatedAt: '2023年12月13日' },
  { id: '0015', name: '血管外科', internalLevel1: '外科系统', internalLevel2: '血管外科', status: 'enabled', updatedAt: '2023年12月13日' },
  { id: '0016', name: '神经外科', internalLevel1: '外科系统', internalLevel2: '神经外科', status: 'enabled', updatedAt: '2023年12月13日' },
  { id: '0017', name: '整形外科', internalLevel1: '外科系统', internalLevel2: '整形外科', status: 'enabled', updatedAt: '2023年12月13日' },
  { id: '0018', name: '乳腺外科', internalLevel1: '外科系统', internalLevel2: '乳腺外科', status: 'enabled', updatedAt: '2023年12月13日' },
  { id: '0019', name: '肝胆外科', internalLevel1: '外科系统', internalLevel2: '肝胆外科', status: 'enabled', updatedAt: '2023年12月13日' },
  { id: '0020', name: '胰腺外科', internalLevel1: '外科系统', internalLevel2: '胰腺外科', status: 'enabled', updatedAt: '2023年12月13日' },
  { id: '0021', name: '结直肠外科', internalLevel1: '外科系统', internalLevel2: '结直肠外科', status: 'enabled', updatedAt: '2023年12月13日' }
]

const INITIAL_HOSPITALS: HospitalItem[] = [
  {
    id: '0001',
    name: '中国医学科学院肿瘤医院',
    level: '三级甲等',
    tag: '',
    province: '北京市',
    city: '北京市',
    address1: '东院: 北京市朝阳区潘家园南里17号',
    address2: '西院: 北京市西城区大木仓胡同41号',
    address3: '',
    tips: '',
    remark: '',
    status: 'enabled',
    updatedAt: '2026年5月21日',
    externalDepartments: INITIAL_EXTERNAL_DEPARTMENTS
  },
  {
    id: '0002',
    name: '中国医学科学院阜外医院',
    level: '三级甲等',
    tag: '',
    province: '北京市',
    city: '北京市',
    address1: '北京市西城区北礼士路167号',
    address2: '门头沟区双峪西街临1号',
    address3: '',
    tips: '',
    remark: '',
    status: 'enabled',
    updatedAt: '2023年12月12日',
    externalDepartments: INITIAL_EXTERNAL_DEPARTMENTS
  },
  {
    id: '0003',
    name: '中国医学科学院北京协和医院',
    level: '三级甲等',
    tag: '',
    province: '北京市',
    city: '北京市',
    address1: '东院: 北京市东城区东单帅府园1号',
    address2: '三井分院: 北京市朝阳区东四环南路55号',
    address3: '国际医疗部: 北京市东城区王府井帅府园1号',
    tips: '',
    remark: '',
    status: 'enabled',
    updatedAt: '2023年12月12日',
    externalDepartments: INITIAL_EXTERNAL_DEPARTMENTS
  },
  {
    id: '0004',
    name: '中国中医科学院广安门医院',
    level: '三级甲等',
    tag: '',
    province: '北京市',
    city: '北京市',
    address1: '北京市西城区广安门内北线阁5号',
    address2: '南区: 北京市大兴区黄村镇兴丰大街二段138号',
    address3: '第二门诊: 北京市大兴区长阳镇',
    tips: '',
    remark: '',
    status: 'enabled',
    updatedAt: '2023年12月12日',
    externalDepartments: INITIAL_EXTERNAL_DEPARTMENTS
  },
  {
    id: '0005',
    name: '北京大学第一医院',
    level: '三级甲等',
    tag: '',
    province: '北京市',
    city: '北京市',
    address1: '北京市西城区西什库大街8号',
    address2: '大兴院区: 北京市大兴区乐惠路5号、7号',
    address3: '',
    tips: '',
    remark: '',
    status: 'enabled',
    updatedAt: '2023年12月12日',
    externalDepartments: INITIAL_EXTERNAL_DEPARTMENTS
  }
]

// 医生管理初始数据（严格对齐用户最新截图）
const INITIAL_DOCTORS: DoctorItem[] = [
  {
    id: '00001',
    name: '王剑飚',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '北京市',
    city: '北京市',
    hospital: '中国医学科学院北京协和医院',
    department: '呼吸内科',
    title: '知名专家',
    teachingTitle: '教授',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2023年12月13日',
    updatedAt: '2023年12月13日'
  },
  {
    id: '00002',
    name: '樊碧君',
    gender: '女',
    birthday: '',
    phone: '',
    email: '',
    province: '北京市',
    city: '北京市',
    hospital: '中国医学科学院北京协和医院',
    department: '消化内科',
    title: '主任医师',
    teachingTitle: '副教授',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2023年12月13日',
    updatedAt: '2023年12月13日'
  },
  {
    id: '00003',
    name: '刘亚',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '北京市',
    city: '北京市',
    hospital: '中国医学科学院北京协和医院',
    department: '基本外科',
    title: '知名专家',
    teachingTitle: '',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2023年12月15日',
    updatedAt: '2023年12月15日'
  },
  {
    id: '00004',
    name: '李鹏程',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '北京市',
    city: '北京市',
    hospital: '中国医学科学院北京协和医院',
    department: '基本外科',
    title: '副主任医师',
    teachingTitle: '',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2023年12月15日',
    updatedAt: '2023年12月15日'
  },
  {
    id: '00005',
    name: '郭林',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '北京市',
    city: '北京市',
    hospital: '中国医学科学院北京协和医院',
    department: '基本外科',
    title: '副主任医师',
    teachingTitle: '副教授',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2023年12月13日',
    updatedAt: '2023年12月13日'
  },
  {
    id: '00006',
    name: '肖丁培',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '北京市',
    city: '北京市',
    hospital: '中国医学科学院阜外医院',
    department: '心内科',
    title: '副主任医师',
    teachingTitle: '',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2023年12月17日',
    updatedAt: '2023年12月17日'
  },
  {
    id: '00007',
    name: '顾永亮',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '北京市',
    city: '北京市',
    hospital: '中国医学科学院阜外医院',
    department: '心内科',
    title: '副主任医师',
    teachingTitle: '',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2023年12月17日',
    updatedAt: '2023年12月17日'
  },
  {
    id: '00008',
    name: '毕晨旭',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '四川省',
    city: '成都市',
    hospital: '四川大学华西医院',
    department: '胸外科',
    title: '副主任医师',
    teachingTitle: '副教授',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2024年1月2日',
    updatedAt: '2024年1月2日'
  },
  {
    id: '00009',
    name: '周耀东',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '四川省',
    city: '成都市',
    hospital: '四川大学华西医院',
    department: '胸外科',
    title: '副主任医师',
    teachingTitle: '副教授',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2024年1月2日',
    updatedAt: '2024年1月2日'
  },
  {
    id: '00010',
    name: '马珂',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '四川省',
    city: '成都市',
    hospital: '四川大学华西医院',
    department: '骨科',
    title: '副主任医师',
    teachingTitle: '',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2024年1月2日',
    updatedAt: '2024年1月2日'
  },
  {
    id: '00011',
    name: '郭华',
    gender: '男',
    birthday: '',
    phone: '',
    email: '',
    province: '四川省',
    city: '成都市',
    hospital: '四川大学华西医院',
    department: '胸外科',
    title: '副主任医师',
    teachingTitle: '副教授',
    adminPosition: '',
    socialPosition: '',
    specialty: '',
    remark: '',
    status: 'enabled',
    createdAt: '2024年1月2日',
    updatedAt: '2024年1月2日'
  }
]

const INITIAL_CHANNELS: ChannelItem[] = [
  {
    id: '0001',
    name: '支付宝',
    status: 'enabled',
    createdAt: '2023年12月9日',
    updatedAt: '2023年12月9日',
    products: [
      { id: '00010001', xh: '0001', channelId: '0001', name: '全天陪诊(8小时)', price: 498, internalLevel1: '陪诊服务', internalLevel2: '全天陪诊', status: 'enabled', updatedAt: '2023年12月9日' },
      { id: '00010002', xh: '0002', channelId: '0001', name: '半天陪诊(4小时)', price: 298, internalLevel1: '陪诊服务', internalLevel2: '半天陪诊', status: 'enabled', updatedAt: '2023年12月9日' }
    ]
  },
  {
    id: '0002',
    name: '美团',
    status: 'enabled',
    createdAt: '2023年12月9日',
    updatedAt: '2023年12月9日',
    products: [
      { id: '00020001', xh: '0001', channelId: '0002', name: '美团专享-全流程就医陪诊', price: 388, internalLevel1: '陪诊服务', internalLevel2: '全天陪诊', status: 'enabled', updatedAt: '2023年12月9日' }
    ]
  },
  {
    id: '0003',
    name: '抖音',
    status: 'enabled',
    createdAt: '2023年12月15日',
    updatedAt: '2023年12月15日',
    products: [
      { id: '00030001', xh: '0001', channelId: '0003', name: '抖音直播间-半日深度陪诊', price: 268, internalLevel1: '陪诊服务', internalLevel2: '半天陪诊', status: 'enabled', updatedAt: '2023年12月15日' }
    ]
  },
  {
    id: '0004',
    name: '百度健康',
    status: 'enabled',
    createdAt: '2024年1月5日',
    updatedAt: '2024年1月5日',
    products: [
      { id: '00040001', xh: '0001', channelId: '0004', name: '百度专区-专家陪诊服务', price: 588, internalLevel1: '陪诊服务', internalLevel2: '特需陪诊', status: 'enabled', updatedAt: '2024年1月5日' }
    ]
  }
]

const INITIAL_INTERNAL_PRODUCTS: InternalProductItem[] = [
  {
    id: '0001',
    name: '陪诊服务',
    desc: '就医全程陪伴服务',
    type: '服务类',
    status: 'enabled',
    createdAt: '2023年12月9日',
    updatedAt: '2023年12月9日',
    subProducts: [
      { id: '00010001', xh: '0001', parentProductId: '0001', name: '全天陪诊', price: 480, status: 'enabled', updatedAt: '2023年12月9日' },
      { id: '00010002', xh: '0002', parentProductId: '0001', name: '半天陪诊', price: 280, status: 'enabled', updatedAt: '2023年12月9日' },
      { id: '00010003', xh: '0003', parentProductId: '0001', name: '特需陪诊', price: 680, status: 'enabled', updatedAt: '2023年12月9日' }
    ]
  },
  {
    id: '0002',
    name: '代办服务',
    desc: '代跑腿/代取药/代问诊等',
    type: '代办类',
    status: 'enabled',
    createdAt: '2023年12月9日',
    updatedAt: '2023年12月9日',
    subProducts: [
      { id: '00020001', xh: '0001', parentProductId: '0002', name: '代取病历报告', price: 80, status: 'enabled', updatedAt: '2023年12月9日' },
      { id: '00020002', xh: '0002', parentProductId: '0002', name: '代取药开药', price: 100, status: 'enabled', updatedAt: '2023年12月9日' }
    ]
  },
  {
    id: '0003',
    name: '就医绿色通道',
    desc: '特需/绿色通道预约协调',
    type: '通道类',
    status: 'enabled',
    createdAt: '2024年1月10日',
    updatedAt: '2024年1月10日',
    subProducts: [
      { id: '00030001', xh: '0001', parentProductId: '0003', name: '三甲特需加号通道', price: 800, status: 'enabled', updatedAt: '2024年1月10日' }
    ]
  }
]

const INITIAL_PAYMENT_CHANNELS: PaymentChannelItem[] = [
  { id: '0001', name: '微信支付商户号(华西专户)', hospital: '四川大学华西医院', feeRate: 0.6, feeType: '百分比', remark: '华西院区专用微信商户号', status: 'enabled', updatedAt: '2024年1月15日' },
  { id: '0002', name: '支付宝企业收单(协和专户)', hospital: '中国医学科学院北京协和医院', feeRate: 0.55, feeType: '百分比', remark: '北京协和业务结算', status: 'enabled', updatedAt: '2024年1月15日' },
  { id: '0003', name: '银联商务POS渠道', hospital: '四川省人民医院', feeRate: 0.5, feeType: '百分比', remark: '线下刷卡机终端专线', status: 'enabled', updatedAt: '2024年2月1日' },
  { id: '0004', name: '招商银行直联代扣', hospital: '全部医院通用', feeRate: 0.38, feeType: '百分比', remark: '企业网银对公代收付结算', status: 'enabled', updatedAt: '2024年2月10日' }
]

const INITIAL_ESCORTS: EscortItem[] = [
  { id: '00001', name: '张建国', gender: '男', phone: '13812345678', provinceCode: '四川省', cityCode: '成都市', type: '自营', remark: '华西医院金牌陪诊员，熟悉全院科室', status: 'enabled', createdAt: '2023年12月1日', updatedAt: '2023年12月1日' },
  { id: '00002', name: '李梅', gender: '女', phone: '13987654321', provinceCode: '北京市', cityCode: '北京市', type: '自营', remark: '北京协和医院骨干陪诊员，护理学背景', status: 'enabled', createdAt: '2023年12月5日', updatedAt: '2023年12月5日' },
  { id: '00003', name: '王敏', gender: '女', phone: '13700001111', provinceCode: '四川省', cityCode: '成都市', type: '兼职', remark: '省医院兼职陪诊，擅长儿科与妇科', status: 'enabled', createdAt: '2024年1月10日', updatedAt: '2024年1月10日' },
  { id: '00004', name: '刘强', gender: '男', phone: '13666668888', provinceCode: '广东省', cityCode: '广州市', type: '合作', remark: '中山一院合作团队负责人', status: 'enabled', createdAt: '2024年1月12日', updatedAt: '2024年1月12日' },
  { id: '00005', name: '赵丽', gender: '女', phone: '13588889999', provinceCode: '上海市', cityCode: '上海市', type: '自营', remark: '瑞金医院专职陪诊员，持急救证书', status: 'enabled', createdAt: '2024年2月1日', updatedAt: '2024年2月1日' }
]

interface MenuGroup {
  key: string
  title: string
  icon: string
  children: { key: string; label: string; icon: string }[]
}

const MENU_GROUPS: MenuGroup[] = [
  {
    key: 'hospital_manage',
    title: '医院管理',
    icon: 'local_hospital',
    children: [
      { key: 'internal_department', label: '对内科室管理', icon: 'category' },
      { key: 'hospital_manage_sub', label: '医院管理', icon: 'corporate_fare' },
      { key: 'doctor_manage', label: '医生管理', icon: 'medical_information' }
    ]
  },
  {
    key: 'channel_manage',
    title: '渠道管理',
    icon: 'alt_route',
    children: [
      { key: 'channel_manage_sub', label: '渠道管理', icon: 'hub' },
      { key: 'internal_product', label: '对内产品管理', icon: 'inventory_2' },
      { key: 'payment_channel', label: '支付渠道管理', icon: 'payments' }
    ]
  },
  {
    key: 'other_manage',
    title: '其他',
    icon: 'more_horiz',
    children: [
      { key: 'escort_manage', label: '陪诊人管理', icon: 'support_agent' }
    ]
  }
]

interface ConfirmModalConfig {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  type?: 'primary' | 'danger'
  onConfirm: () => void
}

function getStoredDeptList(): DepartmentItem[] {
  try {
    const saved = localStorage.getItem(DEPT_STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed) && parsed.length >= 25 && parsed[0]?.subDepartments?.[0]?.xh) {
        return parsed
      }
    }
  } catch {
    //
  }
  return INITIAL_DEPARTMENTS
}

export default function DictionaryPage(): React.JSX.Element {
  const [activeMenu, setActiveMenu] = useState('doctor_manage')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  // 1. 科室管理主数据 (供医院对外科室联动引用)
  const [deptList] = useState<DepartmentItem[]>(getStoredDeptList)

  // 2. 医院管理主数据
  const [hospList, setHospList] = useState<HospitalItem[]>(() => {
    try {
      const saved = localStorage.getItem(HOSP_STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch {
      //
    }
    return INITIAL_HOSPITALS
  })

  // 3. 医生管理主数据
  const [doctorList, setDoctorList] = useState<DoctorItem[]>(() => {
    try {
      const saved = localStorage.getItem(DOCTOR_STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch {
      //
    }
    return INITIAL_DOCTORS
  })

  // 未保存标记
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  // 医院管理下钻：当前查看对外科室的医院ID
  const [drilldownHospitalId, setDrilldownHospitalId] = useState<string | null>(null)

  // 勾选状态
  const [selectedHospIds, setSelectedHospIds] = useState<string[]>([])
  const [selectedExtDeptIds, setSelectedExtDeptIds] = useState<string[]>([])
  const [selectedDoctorIds, setSelectedDoctorIds] = useState<string[]>([])

  // 医院管理搜索态（草稿 vs 生效）
  const [hospSearchDraft, setHospSearchDraft] = useState('')
  const [appliedHospSearchQuery, setAppliedHospSearchQuery] = useState('')

  // 医院对外科室搜索态（草稿 vs 生效）
  const [extSearchNameDraft, setExtSearchNameDraft] = useState('')
  const [extSearchLevel1Draft, setExtSearchLevel1Draft] = useState('all')
  const [extSearchStatusDraft, setExtSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedExtSearchName, setAppliedExtSearchName] = useState('')
  const [appliedExtSearchLevel1, setAppliedExtSearchLevel1] = useState('all')
  const [appliedExtSearchStatus, setAppliedExtSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  // 医生管理搜索态（草稿 vs 生效）
  const [doctorSearchDraft, setDoctorSearchDraft] = useState('')
  const [appliedDoctorSearchQuery, setAppliedDoctorSearchQuery] = useState('')

// 4. 渠道管理数据 (f_hy_qd + f_hy_cp_qd)
  const [channelList, setChannelList] = useState<ChannelItem[]>(() => {
    try {
      const saved = localStorage.getItem(CHANNEL_STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch {
      //
    }
    return INITIAL_CHANNELS
  })
  const [drilldownChannelId, setDrilldownChannelId] = useState<string | null>(null)
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([])
  const [selectedChannelProductIds, setSelectedChannelProductIds] = useState<string[]>([])
  const [channelSearchDraft, setChannelSearchDraft] = useState('')
  const [appliedChannelSearchQuery, setAppliedChannelSearchQuery] = useState('')
  const [channelProductSearchDraft, setChannelProductSearchDraft] = useState('')
  const [channelProductStatusDraft, setChannelProductStatusDraft] = useState('all')
  const [appliedChannelProductSearch, setAppliedChannelProductSearch] = useState('')
  const [appliedChannelProductStatus, setAppliedChannelProductStatus] = useState('all')

  // 5. 对内产品管理数据 (f_hy_cp + f_hy_zcp)
  const [internalProductList, setInternalProductList] = useState<InternalProductItem[]>(() => {
    try {
      const saved = localStorage.getItem(INTERNAL_PRODUCT_STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch {
      //
    }
    return INITIAL_INTERNAL_PRODUCTS
  })
  const [drilldownInternalProductId, setDrilldownInternalProductId] = useState<string | null>(null)
  const [selectedInternalProductIds, setSelectedInternalProductIds] = useState<string[]>([])
  const [selectedInternalSubProductIds, setSelectedInternalSubProductIds] = useState<string[]>([])
  const [internalProductSearchDraft, setInternalProductSearchDraft] = useState('')
  const [appliedInternalProductSearch, setAppliedInternalProductSearch] = useState('')
  const [internalSubProductSearchDraft, setInternalSubProductSearchDraft] = useState('')
  const [internalSubProductStatusDraft, setInternalSubProductStatusDraft] = useState('all')
  const [appliedInternalSubProductSearch, setAppliedInternalSubProductSearch] = useState('')
  const [appliedInternalSubProductStatus, setAppliedInternalSubProductStatus] = useState('all')

  // 6. 支付渠道管理数据 (zfqd)
  const [paymentChannelList, setPaymentChannelList] = useState<PaymentChannelItem[]>(() => {
    try {
      const saved = localStorage.getItem(PAYMENT_CHANNEL_STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch {
      //
    }
    return INITIAL_PAYMENT_CHANNELS
  })
  const [selectedPaymentChannelIds, setSelectedPaymentChannelIds] = useState<string[]>([])
  const [paymentChannelSearchDraft, setPaymentChannelSearchDraft] = useState('')
  const [paymentChannelStatusDraft, setPaymentChannelStatusDraft] = useState('all')
  const [appliedPaymentChannelSearch, setAppliedPaymentChannelSearch] = useState('')
  const [appliedPaymentChannelStatus, setAppliedPaymentChannelStatus] = useState('all')

  // 7. 陪诊人管理数据 (f_hy_pzr)
  const [escortList, setEscortList] = useState<EscortItem[]>(() => {
    try {
      const saved = localStorage.getItem(ESCORT_STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch {
      //
    }
    return INITIAL_ESCORTS
  })
  const [selectedEscortIds, setSelectedEscortIds] = useState<string[]>([])
  const [escortSearchDraft, setEscortSearchDraft] = useState('')
  const [escortTypeDraft, setEscortTypeDraft] = useState('all')
  const [escortStatusDraft, setEscortStatusDraft] = useState('all')
  const [appliedEscortSearch, setAppliedEscortSearch] = useState('')
  const [appliedEscortType, setAppliedEscortType] = useState('all')
  const [appliedEscortStatus, setAppliedEscortStatus] = useState('all')

  const [saveToast, setSaveToast] = useState<{ text: string; type?: 'success' | 'info' | 'warn' } | null>(null)

  // 二次确认弹窗
  const [confirmModal, setConfirmModal] = useState<ConfirmModalConfig>({
    isOpen: false,
    title: '',
    message: '',
    confirmText: '确定',
    cancelText: '取消',
    type: 'primary',
    onConfirm: () => {}
  })

  const showToast = (text: string, type: 'success' | 'info' | 'warn' = 'success'): void => {
    setSaveToast({ text, type })
    setTimeout(() => setSaveToast(null), 2200)
  }

  const closeConfirmModal = (): void => {
    setConfirmModal((prev) => ({ ...prev, isOpen: false }))
  }

  // 保存持久化二次确认（严格校验唯一性）
  const handleTriggerSave = (): void => {
    // ─── 保存前唯一性与非空强校验 ───
    if (activeMenu === 'hospital_manage_sub') {
      const hospIdSet = new Set<string>()
      for (const h of hospList) {
        const hId = h.id.trim()
        if (!hId) {
          showToast(`医院【${h.name || '未命名'}】的ID不能为空`, 'warn')
          return
        }
        if (hospIdSet.has(hId)) {
          showToast(`保存失败：医院ID【${hId}】重复，不允许保存相同ID`, 'warn')
          return
        }
        hospIdSet.add(hId)

        // 检查对外科室ID唯一性
        const extIdSet = new Set<string>()
        for (const ext of h.externalDepartments || []) {
          const eId = ext.id.trim()
          if (!eId) {
            showToast(`医院【${h.name}】下的对外科室【${ext.name || '未命名'}】ID不能为空`, 'warn')
            return
          }
          if (extIdSet.has(eId)) {
            showToast(`保存失败：医院【${h.name}】下存在重复的对外科室ID【${eId}】`, 'warn')
            return
          }
          extIdSet.add(eId)
        }
      }
    } else if (activeMenu === 'doctor_manage') {
      const docIdSet = new Set<string>()
      for (const doc of doctorList) {
        const docId = doc.id.trim()
        if (!docId) {
          showToast(`医生【${doc.name || '未命名'}】的ID不能为空`, 'warn')
          return
        }
        if (docIdSet.has(docId)) {
          showToast(`保存失败：医生ID【${docId}】重复，不允许保存相同ID`, 'warn')
          return
        }
        docIdSet.add(docId)
      }
    }

    setConfirmModal({
      isOpen: true,
      title: '保存配置确认',
      message: '确定要保存当前所有已编辑和新增的字典数据吗？保存后配置将立即持久化生效。',
      confirmText: '确认保存',
      cancelText: '取消',
      type: 'primary',
      onConfirm: () => {
        closeConfirmModal()
        try {
          if (activeMenu === 'hospital_manage_sub') {
            localStorage.setItem(HOSP_STORAGE_KEY, JSON.stringify(hospList))
          } else if (activeMenu === 'doctor_manage') {
            localStorage.setItem(DOCTOR_STORAGE_KEY, JSON.stringify(doctorList))
          }
          setHasUnsavedChanges(false)
          showToast('保存成功，配置已生效', 'success')
        } catch (e) {
          console.error('Failed to save', e)
          showToast('保存失败', 'warn')
        }
      }
    })
  }

  const toggleGroup = (groupKey: string): void => {
    setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }))
  }

  // ─── 3. 医院管理主表操作 ───
  const handleHospFieldChange = (
    index: number,
    field: keyof HospitalItem,
    value: string
  ): void => {
    const today = getTodayString()
    const next = [...hospList]
    const item = { ...next[index], [field]: value, updatedAt: today }
    next[index] = item
    setHospList(next)
    setHasUnsavedChanges(true)
  }

  const handleAddNewHospital = (): void => {
    const today = getTodayString()
    const maxNum = hospList.reduce((max, item) => {
      const n = parseInt(item.id, 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextId = String(maxNum + 1).padStart(4, '0')

    const newHosp: HospitalItem = {
      id: nextId,
      name: '新增医院名称',
      level: '三级甲等',
      tag: '',
      province: '北京市',
      city: '北京市',
      address1: '北京市',
      address2: '',
      address3: '',
      tips: '',
      remark: '',
      status: 'enabled',
      updatedAt: today,
      externalDepartments: [...INITIAL_EXTERNAL_DEPARTMENTS]
    }

    setHospList([...hospList, newHosp])
    setHasUnsavedChanges(true)
    showToast('已在末尾添加新医院，请编辑后点击「保存」', 'info')
  }

  const handleDeleteSingleHosp = (hospId: string, hospName: string): void => {
    setConfirmModal({
      isOpen: true,
      title: '删除医院确认',
      message: `确定要删除医院【${hospName}】（ID: ${hospId}）吗？`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = hospList.filter((h) => h.id !== hospId)
        setHospList(next)
        setSelectedHospIds((prev) => prev.filter((id) => id !== hospId))
        setHasUnsavedChanges(true)
        showToast(`已删除医院【${hospName}】，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleDeleteSelectedHosps = (): void => {
    if (selectedHospIds.length === 0) {
      showToast('请先勾选需要删除的医院', 'warn')
      return
    }
    const count = selectedHospIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除医院确认',
      message: `确定要删除选中的 ${count} 家医院吗？`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = hospList.filter((h) => !selectedHospIds.includes(h.id))
        setHospList(next)
        setSelectedHospIds([])
        setHasUnsavedChanges(true)
        showToast(`已移除 ${count} 家医院，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleQueryHosps = (): void => {
    setAppliedHospSearchQuery(hospSearchDraft)
    setSelectedHospIds([])
    showToast('已完成查询', 'info')
  }

  // ─── 4. 医院下钻：对外科室操作 ───
  const activeDrilldownHospital = hospList.find((h) => h.id === drilldownHospitalId) || null
  const currentExtDeptList: ExternalDepartmentItem[] = activeDrilldownHospital?.externalDepartments || INITIAL_EXTERNAL_DEPARTMENTS

  const handleExtDeptFieldChange = (
    index: number,
    field: keyof ExternalDepartmentItem,
    value: string
  ): void => {
    if (!activeDrilldownHospital) return
    const today = getTodayString()
    const hospIdx = hospList.findIndex((h) => h.id === activeDrilldownHospital.id)
    if (hospIdx === -1) return

    const nextHospList = [...hospList]
    const targetHosp = { ...nextHospList[hospIdx] }
    const nextExtList = [...(targetHosp.externalDepartments || INITIAL_EXTERNAL_DEPARTMENTS)]
    const extItem = { ...nextExtList[index], [field]: value, updatedAt: today }

    if (field === 'internalLevel1') {
      const matchDept = deptList.find((d) => d.name === value)
      extItem.internalLevel2 = matchDept?.subDepartments[0]?.name || ''
    }

    nextExtList[index] = extItem
    targetHosp.externalDepartments = nextExtList
    targetHosp.updatedAt = today
    nextHospList[hospIdx] = targetHosp

    setHospList(nextHospList)
    setHasUnsavedChanges(true)
  }

  const handleAddNewExtDepartment = (): void => {
    if (!activeDrilldownHospital) return
    const today = getTodayString()
    const hospIdx = hospList.findIndex((h) => h.id === activeDrilldownHospital.id)
    if (hospIdx === -1) return

    const nextHospList = [...hospList]
    const targetHosp = { ...nextHospList[hospIdx] }
    const nextExtList = [...(targetHosp.externalDepartments || INITIAL_EXTERNAL_DEPARTMENTS)]

    const maxNum = nextExtList.reduce((max, item) => {
      const n = parseInt(item.id, 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextId = String(maxNum + 1).padStart(4, '0')

    const newExt: ExternalDepartmentItem = {
      id: nextId,
      name: '新增对外科室',
      internalLevel1: deptList[0]?.name || '内科系统',
      internalLevel2: deptList[0]?.subDepartments[0]?.name || '普通内科',
      status: 'enabled',
      updatedAt: today
    }

    targetHosp.externalDepartments = [...nextExtList, newExt]
    targetHosp.updatedAt = today
    nextHospList[hospIdx] = targetHosp

    setHospList(nextHospList)
    setHasUnsavedChanges(true)
    showToast('已在末尾添加新对外科室，请编辑后点击「保存」', 'info')
  }

  const handleDeleteSingleExtDept = (extId: string, extName: string): void => {
    if (!activeDrilldownHospital) return
    setConfirmModal({
      isOpen: true,
      title: '删除对外科室确认',
      message: `确定要删除对外科室【${extName}】（ID: ${extId}）吗？`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const today = getTodayString()
        const hospIdx = hospList.findIndex((h) => h.id === activeDrilldownHospital.id)
        if (hospIdx === -1) return

        const nextHospList = [...hospList]
        const targetHosp = { ...nextHospList[hospIdx] }
        targetHosp.externalDepartments = (targetHosp.externalDepartments || INITIAL_EXTERNAL_DEPARTMENTS).filter(
          (e) => e.id !== extId
        )
        targetHosp.updatedAt = today
        nextHospList[hospIdx] = targetHosp

        setHospList(nextHospList)
        setSelectedExtDeptIds((prev) => prev.filter((id) => id !== extId))
        setHasUnsavedChanges(true)
        showToast(`已删除对外科室【${extName}】，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleDeleteSelectedExtDepts = (): void => {
    if (!activeDrilldownHospital) return
    if (selectedExtDeptIds.length === 0) {
      showToast('请先勾选需要删除的对外科室', 'warn')
      return
    }
    const count = selectedExtDeptIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除对外科室确认',
      message: `确定要删除选中的 ${count} 个对外科室吗？`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const today = getTodayString()
        const hospIdx = hospList.findIndex((h) => h.id === activeDrilldownHospital.id)
        if (hospIdx === -1) return

        const nextHospList = [...hospList]
        const targetHosp = { ...nextHospList[hospIdx] }
        targetHosp.externalDepartments = (targetHosp.externalDepartments || INITIAL_EXTERNAL_DEPARTMENTS).filter(
          (e) => !selectedExtDeptIds.includes(e.id)
        )
        targetHosp.updatedAt = today
        nextHospList[hospIdx] = targetHosp

        setHospList(nextHospList)
        setSelectedExtDeptIds([])
        setHasUnsavedChanges(true)
        showToast(`已移除 ${count} 个对外科室，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleQueryExtDepts = (): void => {
    setAppliedExtSearchName(extSearchNameDraft)
    setAppliedExtSearchLevel1(extSearchLevel1Draft)
    setAppliedExtSearchStatus(extSearchStatusDraft)
    setSelectedExtDeptIds([])
    showToast('已完成查询', 'info')
  }

  // ─── 5. 医生管理操作 ───
  const handleDoctorFieldChange = (
    index: number,
    field: keyof DoctorItem,
    value: string
  ): void => {
    const today = getTodayString()
    const next = [...doctorList]
    const item = { ...next[index], [field]: value, updatedAt: today }
    next[index] = item
    setDoctorList(next)
    setHasUnsavedChanges(true)
  }

  const handleAddNewDoctor = (): void => {
    const today = getTodayString()
    const maxNum = doctorList.reduce((max, item) => {
      const n = parseInt(item.id, 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextId = String(maxNum + 1).padStart(5, '0')

    const newDoc: DoctorItem = {
      id: nextId,
      name: '新增医生姓名',
      gender: '男',
      birthday: '',
      phone: '',
      email: '',
      province: '北京市',
      city: '北京市',
      hospital: hospList[0]?.name || '中国医学科学院北京协和医院',
      department: '普通内科',
      title: '主治医师',
      teachingTitle: '',
      adminPosition: '',
      socialPosition: '',
      specialty: '',
      remark: '',
      status: 'enabled',
      createdAt: today,
      updatedAt: today
    }

    setDoctorList([...doctorList, newDoc])
    setHasUnsavedChanges(true)
    showToast('已在末尾添加新医生，请编辑后点击「保存」', 'info')
  }

  const handleDeleteSingleDoctor = (docId: string, docName: string): void => {
    setConfirmModal({
      isOpen: true,
      title: '删除医生确认',
      message: `确定要删除医生【${docName}】（ID: ${docId}）吗？`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = doctorList.filter((d) => d.id !== docId)
        setDoctorList(next)
        setSelectedDoctorIds((prev) => prev.filter((id) => id !== docId))
        setHasUnsavedChanges(true)
        showToast(`已删除医生【${docName}】，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleDeleteSelectedDoctors = (): void => {
    if (selectedDoctorIds.length === 0) {
      showToast('请先勾选需要删除的医生', 'warn')
      return
    }
    const count = selectedDoctorIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除医生确认',
      message: `确定要删除选中的 ${count} 位医生吗？`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = doctorList.filter((d) => !selectedDoctorIds.includes(d.id))
        setDoctorList(next)
        setSelectedDoctorIds([])
        setHasUnsavedChanges(true)
        showToast(`已移除 ${count} 位医生，请点击「保存」生效`, 'info')
      }
    })
  }

// ─── 4. 渠道管理操作 (f_hy_qd + f_hy_cp_qd) ───
  const activeDrilldownChannel = channelList.find((c) => c.id === drilldownChannelId) || null

  const handleChannelFieldChange = (index: number, field: keyof ChannelItem, value: string): void => {
    const today = getTodayString()
    const next = [...channelList]
    next[index] = { ...next[index], [field]: value, updatedAt: today }
    setChannelList(next)
    setHasUnsavedChanges(true)
  }

  const handleAddNewChannel = (): void => {
    const today = getTodayString()
    const maxNum = channelList.reduce((max, item) => {
      const n = parseInt(item.id, 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextId = String(maxNum + 1).padStart(4, '0')
    const newChan: ChannelItem = {
      id: nextId,
      name: '新增业务渠道',
      status: 'enabled',
      createdAt: today,
      updatedAt: today,
      products: []
    }
    setChannelList([...channelList, newChan])
    setHasUnsavedChanges(true)
    showToast('已在末尾添加新渠道，请编辑后点击「保存」', 'info')
  }

  const handleDeleteSingleChannel = (channelId: string, channelName: string): void => {
    setConfirmModal({
      isOpen: true,
      title: '删除渠道确认',
      message: `确定要删除渠道【${channelName}】（ID: ${channelId}）吗？删除后对应下属的所有渠道产品也将一并移除。`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = channelList.filter((c) => c.id !== channelId)
        setChannelList(next)
        setSelectedChannelIds((prev) => prev.filter((id) => id !== channelId))
        setHasUnsavedChanges(true)
        showToast(`已删除渠道【${channelName}】，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleDeleteSelectedChannels = (): void => {
    if (selectedChannelIds.length === 0) {
      showToast('请先勾选需要删除的渠道', 'warn')
      return
    }
    const count = selectedChannelIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除渠道确认',
      message: `确定要删除选中的 ${count} 个渠道吗？删除后所选渠道及其产品数据将被移除。`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = channelList.filter((c) => !selectedChannelIds.includes(c.id))
        setChannelList(next)
        setSelectedChannelIds([])
        setHasUnsavedChanges(true)
        showToast(`已移除 ${count} 个渠道，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleQueryChannels = (): void => {
    setAppliedChannelSearchQuery(channelSearchDraft)
    setSelectedChannelIds([])
    showToast('已完成查询', 'info')
  }

  // 渠道产品下钻 (f_hy_cp_qd) 操作
  const handleChannelProductFieldChange = (
    prodIdx: number,
    field: keyof ChannelProductItem,
    value: string | number
  ): void => {
    if (!activeDrilldownChannel) return
    const today = getTodayString()
    const chanIdx = channelList.findIndex((c) => c.id === activeDrilldownChannel.id)
    if (chanIdx === -1) return

    const nextChanList = [...channelList]
    const targetChan = { ...nextChanList[chanIdx] }
    const nextProdList = [...targetChan.products]
    const prodItem = { ...nextProdList[prodIdx], [field]: value, updatedAt: today }

    if (field === 'xh') {
      const pId = targetChan.id
      prodItem.id = `${pId}${value}`
    }

    prodItem.updatedAt = today
    nextProdList[prodIdx] = prodItem
    targetChan.products = nextProdList
    targetChan.updatedAt = today
    nextChanList[chanIdx] = targetChan

    setChannelList(nextChanList)
    setHasUnsavedChanges(true)
  }

  const handleAddNewChannelProduct = (): void => {
    if (!activeDrilldownChannel) return
    const today = getTodayString()
    const chanIdx = channelList.findIndex((c) => c.id === activeDrilldownChannel.id)
    if (chanIdx === -1) return

    const nextChanList = [...channelList]
    const targetChan = { ...nextChanList[chanIdx] }
    const currentProds = targetChan.products || []

    const maxNum = currentProds.reduce((max, item) => {
      const n = parseInt(item.xh || item.id.slice(-4), 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextXh = String(maxNum + 1).padStart(4, '0')
    const nextId = `${targetChan.id}${nextXh}`

    const newProd: ChannelProductItem = {
      id: nextId,
      xh: nextXh,
      channelId: targetChan.id,
      name: '新增渠道产品',
      price: 298,
      internalLevel1: '陪诊服务',
      internalLevel2: '半天陪诊',
      status: 'enabled',
      updatedAt: today
    }

    targetChan.products = [...currentProds, newProd]
    targetChan.updatedAt = today
    nextChanList[chanIdx] = targetChan

    setChannelList(nextChanList)
    setHasUnsavedChanges(true)
    showToast('已在末尾添加新渠道产品，请编辑后点击「保存」', 'info')
  }

  const handleDeleteSingleChannelProduct = (prodId: string, prodName: string): void => {
    if (!activeDrilldownChannel) return
    setConfirmModal({
      isOpen: true,
      title: '删除渠道产品确认',
      message: `确定要删除渠道产品【${prodName}】（ID: ${prodId}）吗？`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const today = getTodayString()
        const chanIdx = channelList.findIndex((c) => c.id === activeDrilldownChannel.id)
        if (chanIdx === -1) return

        const nextChanList = [...channelList]
        const targetChan = { ...nextChanList[chanIdx] }
        targetChan.products = (targetChan.products || []).filter((p) => p.id !== prodId)
        targetChan.updatedAt = today
        nextChanList[chanIdx] = targetChan

        setChannelList(nextChanList)
        setSelectedChannelProductIds((prev) => prev.filter((id) => id !== prodId))
        setHasUnsavedChanges(true)
        showToast(`已删除渠道产品【${prodName}】，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleDeleteSelectedChannelProducts = (): void => {
    if (!activeDrilldownChannel) return
    if (selectedChannelProductIds.length === 0) {
      showToast('请先勾选需要删除的渠道产品', 'warn')
      return
    }
    const count = selectedChannelProductIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除渠道产品确认',
      message: `确定要删除选中的 ${count} 个渠道产品吗？`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const today = getTodayString()
        const chanIdx = channelList.findIndex((c) => c.id === activeDrilldownChannel.id)
        if (chanIdx === -1) return

        const nextChanList = [...channelList]
        const targetChan = { ...nextChanList[chanIdx] }
        targetChan.products = (targetChan.products || []).filter((p) => !selectedChannelProductIds.includes(p.id))
        targetChan.updatedAt = today
        nextChanList[chanIdx] = targetChan

        setChannelList(nextChanList)
        setSelectedChannelProductIds([])
        setHasUnsavedChanges(true)
        showToast(`已移除 ${count} 个渠道产品，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleQueryChannelProducts = (): void => {
    setAppliedChannelProductSearch(channelProductSearchDraft)
    setAppliedChannelProductStatus(channelProductStatusDraft)
    setSelectedChannelProductIds([])
    showToast('已完成查询', 'info')
  }

  // ─── 5. 对内产品管理操作 (f_hy_cp + f_hy_zcp) ───
  const activeDrilldownInternalProduct = internalProductList.find((p) => p.id === drilldownInternalProductId) || null

  const handleInternalProductFieldChange = (
    index: number,
    field: keyof InternalProductItem,
    value: string
  ): void => {
    const today = getTodayString()
    const next = [...internalProductList]
    next[index] = { ...next[index], [field]: value, updatedAt: today }
    setInternalProductList(next)
    setHasUnsavedChanges(true)
  }

  const handleAddNewInternalProduct = (): void => {
    const today = getTodayString()
    const maxNum = internalProductList.reduce((max, item) => {
      const n = parseInt(item.id, 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextId = String(maxNum + 1).padStart(4, '0')
    const newProd: InternalProductItem = {
      id: nextId,
      name: '新增产品大类',
      desc: '产品类别描述',
      type: '服务类',
      status: 'enabled',
      createdAt: today,
      updatedAt: today,
      subProducts: []
    }
    setInternalProductList([...internalProductList, newProd])
    setHasUnsavedChanges(true)
    showToast('已在末尾添加新产品类别，请编辑后点击「保存」', 'info')
  }

  const handleDeleteSingleInternalProduct = (prodId: string, prodName: string): void => {
    setConfirmModal({
      isOpen: true,
      title: '删除产品类别确认',
      message: `确定要删除产品类别【${prodName}】（ID: ${prodId}）吗？删除后对应下属的所有细分产品也将一并移除。`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = internalProductList.filter((p) => p.id !== prodId)
        setInternalProductList(next)
        setSelectedInternalProductIds((prev) => prev.filter((id) => id !== prodId))
        setHasUnsavedChanges(true)
        showToast(`已删除产品类别【${prodName}】，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleDeleteSelectedInternalProducts = (): void => {
    if (selectedInternalProductIds.length === 0) {
      showToast('请先勾选需要删除的产品类别', 'warn')
      return
    }
    const count = selectedInternalProductIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除产品类别确认',
      message: `确定要删除选中的 ${count} 个产品类别吗？删除后所选类别及其细分数据将被移除。`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = internalProductList.filter((p) => !selectedInternalProductIds.includes(p.id))
        setInternalProductList(next)
        setSelectedInternalProductIds([])
        setHasUnsavedChanges(true)
        showToast(`已移除 ${count} 个产品类别，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleQueryInternalProducts = (): void => {
    setAppliedInternalProductSearch(internalProductSearchDraft)
    setSelectedInternalProductIds([])
    showToast('已完成查询', 'info')
  }

  // 细分产品下钻 (f_hy_zcp) 操作
  const handleInternalSubProductFieldChange = (
    subIndex: number,
    field: keyof InternalSubProductItem,
    value: string | number
  ): void => {
    if (!activeDrilldownInternalProduct) return
    const today = getTodayString()
    const pIdx = internalProductList.findIndex((p) => p.id === activeDrilldownInternalProduct.id)
    if (pIdx === -1) return

    const nextList = [...internalProductList]
    const targetProd = { ...nextList[pIdx] }
    const nextSubList = [...targetProd.subProducts]
    const subItem = { ...nextSubList[subIndex], [field]: value, updatedAt: today }

    if (field === 'xh') {
      const pId = subItem.parentProductId || targetProd.id
      subItem.id = `${pId}${value}`
    }

    subItem.updatedAt = today
    nextSubList[subIndex] = subItem
    targetProd.subProducts = nextSubList
    targetProd.updatedAt = today
    nextList[pIdx] = targetProd

    setInternalProductList(nextList)
    setHasUnsavedChanges(true)
  }

  const handleAddNewInternalSubProduct = (): void => {
    if (!activeDrilldownInternalProduct) return
    const today = getTodayString()
    const pIdx = internalProductList.findIndex((p) => p.id === activeDrilldownInternalProduct.id)
    if (pIdx === -1) return

    const nextList = [...internalProductList]
    const targetProd = { ...nextList[pIdx] }
    const currentSubs = targetProd.subProducts || []

    const maxNum = currentSubs.reduce((max, item) => {
      const n = parseInt(item.xh || item.id.slice(-4), 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextXh = String(maxNum + 1).padStart(4, '0')
    const nextId = `${targetProd.id}${nextXh}`

    const newSub: InternalSubProductItem = {
      id: nextId,
      xh: nextXh,
      parentProductId: targetProd.id,
      name: '新增细分产品',
      price: 100,
      status: 'enabled',
      updatedAt: today
    }

    targetProd.subProducts = [...currentSubs, newSub]
    targetProd.updatedAt = today
    nextList[pIdx] = targetProd

    setInternalProductList(nextList)
    setHasUnsavedChanges(true)
    showToast('已在末尾添加新细分产品，请编辑后点击「保存」', 'info')
  }

  const handleDeleteSingleInternalSubProduct = (subId: string, subName: string): void => {
    if (!activeDrilldownInternalProduct) return
    setConfirmModal({
      isOpen: true,
      title: '删除细分产品确认',
      message: `确定要删除细分产品【${subName}】（ID: ${subId}）吗？`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const today = getTodayString()
        const pIdx = internalProductList.findIndex((p) => p.id === activeDrilldownInternalProduct.id)
        if (pIdx === -1) return

        const nextList = [...internalProductList]
        const targetProd = { ...nextList[pIdx] }
        targetProd.subProducts = (targetProd.subProducts || []).filter((s) => s.id !== subId)
        targetProd.updatedAt = today
        nextList[pIdx] = targetProd

        setInternalProductList(nextList)
        setSelectedInternalSubProductIds((prev) => prev.filter((id) => id !== subId))
        setHasUnsavedChanges(true)
        showToast(`已删除细分产品【${subName}】，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleDeleteSelectedInternalSubProducts = (): void => {
    if (!activeDrilldownInternalProduct) return
    if (selectedInternalSubProductIds.length === 0) {
      showToast('请先勾选需要删除的细分产品', 'warn')
      return
    }
    const count = selectedInternalSubProductIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除细分产品确认',
      message: `确定要删除选中的 ${count} 个细分产品吗？`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const today = getTodayString()
        const pIdx = internalProductList.findIndex((p) => p.id === activeDrilldownInternalProduct.id)
        if (pIdx === -1) return

        const nextList = [...internalProductList]
        const targetProd = { ...nextList[pIdx] }
        targetProd.subProducts = (targetProd.subProducts || []).filter((s) => !selectedInternalSubProductIds.includes(s.id))
        targetProd.updatedAt = today
        nextList[pIdx] = targetProd

        setInternalProductList(nextList)
        setSelectedInternalSubProductIds([])
        setHasUnsavedChanges(true)
        showToast(`已移除 ${count} 个细分产品，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleQueryInternalSubProducts = (): void => {
    setAppliedInternalSubProductSearch(internalSubProductSearchDraft)
    setAppliedInternalSubProductStatus(internalSubProductStatusDraft)
    setSelectedInternalSubProductIds([])
    showToast('已完成查询', 'info')
  }

  // ─── 6. 支付渠道管理操作 (zfqd) ───
  const handlePaymentChannelFieldChange = (
    index: number,
    field: keyof PaymentChannelItem,
    value: string | number
  ): void => {
    const today = getTodayString()
    const next = [...paymentChannelList]
    next[index] = { ...next[index], [field]: value, updatedAt: today }
    setPaymentChannelList(next)
    setHasUnsavedChanges(true)
  }

  const handleAddNewPaymentChannel = (): void => {
    const today = getTodayString()
    const maxNum = paymentChannelList.reduce((max, item) => {
      const n = parseInt(item.id, 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextId = String(maxNum + 1).padStart(4, '0')
    const newChan: PaymentChannelItem = {
      id: nextId,
      name: '新增支付渠道',
      hospital: hospList[0]?.name || '全部医院通用',
      feeRate: 0.6,
      feeType: '百分比',
      remark: '',
      status: 'enabled',
      updatedAt: today
    }
    setPaymentChannelList([...paymentChannelList, newChan])
    setHasUnsavedChanges(true)
    showToast('已在末尾添加新支付渠道，请编辑后点击「保存」', 'info')
  }

  const handleDeleteSinglePaymentChannel = (channelId: string, channelName: string): void => {
    setConfirmModal({
      isOpen: true,
      title: '删除支付渠道确认',
      message: `确定要删除支付渠道【${channelName}】（ID: ${channelId}）吗？`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = paymentChannelList.filter((c) => c.id !== channelId)
        setPaymentChannelList(next)
        setSelectedPaymentChannelIds((prev) => prev.filter((id) => id !== channelId))
        setHasUnsavedChanges(true)
        showToast(`已删除支付渠道【${channelName}】，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleDeleteSelectedPaymentChannels = (): void => {
    if (selectedPaymentChannelIds.length === 0) {
      showToast('请先勾选需要删除的支付渠道', 'warn')
      return
    }
    const count = selectedPaymentChannelIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除支付渠道确认',
      message: `确定要删除选中的 ${count} 个支付渠道吗？`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = paymentChannelList.filter((c) => !selectedPaymentChannelIds.includes(c.id))
        setPaymentChannelList(next)
        setSelectedPaymentChannelIds([])
        setHasUnsavedChanges(true)
        showToast(`已移除 ${count} 个支付渠道，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleQueryPaymentChannels = (): void => {
    setAppliedPaymentChannelSearch(paymentChannelSearchDraft)
    setAppliedPaymentChannelStatus(paymentChannelStatusDraft)
    setSelectedPaymentChannelIds([])
    showToast('已完成查询', 'info')
  }

  // ─── 7. 陪诊人管理操作 (f_hy_pzr) ───
  const handleEscortFieldChange = (index: number, field: keyof EscortItem, value: string): void => {
    const today = getTodayString()
    const next = [...escortList]
    next[index] = { ...next[index], [field]: value, updatedAt: today }
    setEscortList(next)
    setHasUnsavedChanges(true)
  }

  const handleAddNewEscort = (): void => {
    const today = getTodayString()
    const maxNum = escortList.reduce((max, item) => {
      const n = parseInt(item.id, 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextId = String(maxNum + 1).padStart(5, '0')
    const newEscort: EscortItem = {
      id: nextId,
      name: '新增陪诊人员',
      gender: '男',
      phone: '',
      provinceCode: '四川省',
      cityCode: '成都市',
      type: '自营',
      remark: '',
      status: 'enabled',
      createdAt: today,
      updatedAt: today
    }
    setEscortList([...escortList, newEscort])
    setHasUnsavedChanges(true)
    showToast('已在末尾添加新陪诊员，请编辑后点击「保存」', 'info')
  }

  const handleDeleteSingleEscort = (escortId: string, escortName: string): void => {
    setConfirmModal({
      isOpen: true,
      title: '删除陪诊人确认',
      message: `确定要删除陪诊人员【${escortName}】（ID: ${escortId}）吗？`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = escortList.filter((e) => e.id !== escortId)
        setEscortList(next)
        setSelectedEscortIds((prev) => prev.filter((id) => id !== escortId))
        setHasUnsavedChanges(true)
        showToast(`已删除陪诊人员【${escortName}】，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleDeleteSelectedEscorts = (): void => {
    if (selectedEscortIds.length === 0) {
      showToast('请先勾选需要删除的陪诊人员', 'warn')
      return
    }
    const count = selectedEscortIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除陪诊人确认',
      message: `确定要删除选中的 ${count} 位陪诊人员吗？`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: () => {
        closeConfirmModal()
        const next = escortList.filter((e) => !selectedEscortIds.includes(e.id))
        setEscortList(next)
        setSelectedEscortIds([])
        setHasUnsavedChanges(true)
        showToast(`已移除 ${count} 位陪诊人员，请点击「保存」生效`, 'info')
      }
    })
  }

  const handleQueryEscorts = (): void => {
    setAppliedEscortSearch(escortSearchDraft)
    setAppliedEscortType(escortTypeDraft)
    setAppliedEscortStatus(escortStatusDraft)
    setSelectedEscortIds([])
    showToast('已完成查询', 'info')
  }

  const handleQueryDoctors = (): void => {
    setAppliedDoctorSearchQuery(doctorSearchDraft)
    setSelectedDoctorIds([])
    showToast('已完成查询', 'info')
  }

  // 过滤数据
  const filteredHosps = hospList.filter(
    (h) =>
      !appliedHospSearchQuery.trim() ||
      h.name.toLowerCase().includes(appliedHospSearchQuery.trim().toLowerCase()) ||
      h.id.toLowerCase().includes(appliedHospSearchQuery.trim().toLowerCase()) ||
      h.address1.toLowerCase().includes(appliedHospSearchQuery.trim().toLowerCase()) ||
      h.level.toLowerCase().includes(appliedHospSearchQuery.trim().toLowerCase())
  )

  const filteredExtDepts = currentExtDeptList.filter((e) => {
    const matchName =
      !appliedExtSearchName.trim() ||
      e.name.toLowerCase().includes(appliedExtSearchName.trim().toLowerCase()) ||
      e.id.toLowerCase().includes(appliedExtSearchName.trim().toLowerCase())
    const matchLevel1 =
      appliedExtSearchLevel1 === 'all' || e.internalLevel1 === appliedExtSearchLevel1
    const matchStatus =
      appliedExtSearchStatus === 'all' || e.status === appliedExtSearchStatus
    return matchName && matchLevel1 && matchStatus
  })

  const filteredDoctors = doctorList.filter(
    (d) =>
      !appliedDoctorSearchQuery.trim() ||
      d.name.toLowerCase().includes(appliedDoctorSearchQuery.trim().toLowerCase()) ||
      d.id.toLowerCase().includes(appliedDoctorSearchQuery.trim().toLowerCase()) ||
      d.hospital.toLowerCase().includes(appliedDoctorSearchQuery.trim().toLowerCase()) ||
      d.department.toLowerCase().includes(appliedDoctorSearchQuery.trim().toLowerCase()) ||
      d.title.toLowerCase().includes(appliedDoctorSearchQuery.trim().toLowerCase())
  )

  const isAllHospsSelected =
    filteredHosps.length > 0 && selectedHospIds.length === filteredHosps.length
  const isAllExtDeptsSelected =
    filteredExtDepts.length > 0 && selectedExtDeptIds.length === filteredExtDepts.length
  const isAllDoctorsSelected =
    filteredDoctors.length > 0 && selectedDoctorIds.length === filteredDoctors.length

// 渠道管理过滤
  const filteredChannels = channelList.filter((c) => {
    const q = appliedChannelSearchQuery.trim().toLowerCase()
    return !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
  })
  const currentChannelProductList = activeDrilldownChannel ? (activeDrilldownChannel.products || []) : []
  const filteredChannelProducts = currentChannelProductList.filter((p) => {
    const q = appliedChannelProductSearch.trim().toLowerCase()
    const matchSearch = !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.xh.toLowerCase().includes(q)
    const matchStatus = appliedChannelProductStatus === 'all' || p.status === appliedChannelProductStatus
    return matchSearch && matchStatus
  })
  const isAllChannelsSelected = filteredChannels.length > 0 && selectedChannelIds.length === filteredChannels.length
  const isAllChannelProductsSelected = filteredChannelProducts.length > 0 && selectedChannelProductIds.length === filteredChannelProducts.length

  // 对内产品管理过滤
  const filteredInternalProducts = internalProductList.filter((p) => {
    const q = appliedInternalProductSearch.trim().toLowerCase()
    return !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)
  })
  const currentInternalSubList = activeDrilldownInternalProduct ? (activeDrilldownInternalProduct.subProducts || []) : []
  const filteredInternalSubProducts = currentInternalSubList.filter((s) => {
    const q = appliedInternalSubProductSearch.trim().toLowerCase()
    const matchSearch = !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.xh.toLowerCase().includes(q)
    const matchStatus = appliedInternalSubProductStatus === 'all' || s.status === appliedInternalSubProductStatus
    return matchSearch && matchStatus
  })
  const isAllInternalProductsSelected = filteredInternalProducts.length > 0 && selectedInternalProductIds.length === filteredInternalProducts.length
  const isAllInternalSubProductsSelected = filteredInternalSubProducts.length > 0 && selectedInternalSubProductIds.length === filteredInternalSubProducts.length

  // 支付渠道过滤
  const filteredPaymentChannels = paymentChannelList.filter((c) => {
    const q = appliedPaymentChannelSearch.trim().toLowerCase()
    const matchSearch = !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || c.hospital.toLowerCase().includes(q) || c.remark.toLowerCase().includes(q)
    const matchStatus = appliedPaymentChannelStatus === 'all' || c.status === appliedPaymentChannelStatus
    return matchSearch && matchStatus
  })
  const isAllPaymentChannelsSelected = filteredPaymentChannels.length > 0 && selectedPaymentChannelIds.length === filteredPaymentChannels.length

  // 陪诊人过滤
  const filteredEscorts = escortList.filter((e) => {
    const q = appliedEscortSearch.trim().toLowerCase()
    const matchSearch = !q || e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q) || e.phone.toLowerCase().includes(q) || e.remark.toLowerCase().includes(q)
    const matchType = appliedEscortType === 'all' || e.type === appliedEscortType
    const matchStatus = appliedEscortStatus === 'all' || e.status === appliedEscortStatus
    return matchSearch && matchType && matchStatus
  })
  const isAllEscortsSelected = filteredEscorts.length > 0 && selectedEscortIds.length === filteredEscorts.length

  const currentActiveItem = MENU_GROUPS.flatMap((g) => g.children).find((c) => c.key === activeMenu)
  const currentActiveGroup = MENU_GROUPS.find((g) => g.children.some((c) => c.key === activeMenu))

  return (
    <div className="flex-1 min-h-0 flex bg-surface-bg text-text-main overflow-hidden relative">
      {/* ─── 二次确认通用对话框 Modal ─── */}
      {confirmModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl border border-border-subtle max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-3.5">
                <div
                  className={
                    'w-10 h-10 rounded-full flex items-center justify-center shrink-0 ' +
                    (confirmModal.type === 'danger'
                      ? 'bg-red-50 text-error'
                      : 'bg-primary/10 text-primary')
                  }
                >
                  <span className="material-symbols-outlined text-[24px]">
                    {confirmModal.type === 'danger' ? 'warning' : 'help'}
                  </span>
                </div>
                <div className="space-y-1">
                  <h3 className="text-h3-title text-text-main font-bold">
                    {confirmModal.title}
                  </h3>
                  <p className="text-body-sm text-text-muted leading-relaxed">
                    {confirmModal.message}
                  </p>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 bg-surface-container-low/60 border-t border-border-subtle flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={closeConfirmModal}
                className="px-4 py-2 bg-white hover:bg-surface-container-low text-text-main border border-border-subtle rounded-lg text-body-sm font-medium transition-colors cursor-pointer"
              >
                {confirmModal.cancelText || '取消'}
              </button>
              <button
                type="button"
                onClick={confirmModal.onConfirm}
                className={
                  'px-4 py-2 text-white rounded-lg text-body-sm font-semibold transition-colors cursor-pointer shadow-xs ' +
                  (confirmModal.type === 'danger'
                    ? 'bg-error hover:bg-error/90'
                    : 'bg-primary hover:bg-primary-container')
                }
              >
                {confirmModal.confirmText || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 左侧树形字典菜单 ─── */}
      <aside className="w-64 shrink-0 bg-white border-r border-border-subtle flex flex-col select-none overflow-y-auto">
        <div className="p-4 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[20px]">menu_book</span>
            <h2 className="text-h3-title text-text-main font-semibold">字典维护</h2>
          </div>
          <span className="text-[11px] text-text-muted bg-surface-container-low px-2 py-0.5 rounded-full border border-border-subtle font-medium">
            7 个模块
          </span>
        </div>

        <div className="p-3 space-y-3">
          {MENU_GROUPS.map((group) => {
            const isCollapsed = !!collapsedGroups[group.key]
            return (
              <div key={group.key} className="space-y-1">
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 text-body-sm font-semibold text-text-muted hover:text-text-main hover:bg-surface-container-low/60 rounded-lg transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px] text-outline">
                      {group.icon}
                    </span>
                    <span>{group.title}</span>
                  </div>
                  <span
                    className="material-symbols-outlined text-[16px] text-outline transform transition-transform duration-200"
                    style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                  >
                    expand_more
                  </span>
                </button>

                {!isCollapsed && (
                  <div className="pl-2 space-y-0.5">
                    {group.children.map((item) => {
                      const isActive = activeMenu === item.key
                      return (
                        <button
                          key={item.key}
                          onClick={() => {
                            setActiveMenu(item.key)
                            setDrilldownHospitalId(null)
                            setDrilldownChannelId(null)
                            setDrilldownInternalProductId(null)
                          }}
                          className={
                            'w-full text-left pl-7 pr-3 py-2 text-body-sm rounded-lg transition-all flex items-center justify-between cursor-pointer ' +
                            (isActive
                              ? 'bg-primary text-white font-semibold shadow-xs'
                              : 'text-text-main hover:bg-surface-container-low hover:text-primary')
                          }
                        >
                          <div className="flex items-center gap-2">
                            <span>{item.label}</span>
                          </div>
                          {isActive && (
                            <span className="material-symbols-outlined text-[16px] text-white/80">
                              chevron_right
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      {/* ─── 右侧内容展示区 ─── */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-surface-bg">
        {/* ══════════════════════════════════════════════════════════
           1. 医生管理页面（对齐用户最新截图）
           ══════════════════════════════════════════════════════════ */}
        {activeMenu === 'doctor_manage' ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
            {/* 顶栏卡片 */}
            <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
              <div>
                <div className="flex items-center gap-2 text-[12px] text-text-muted mb-1">
                  <span>字典维护</span>
                  <span>/</span>
                  <span>医院管理</span>
                  <span>/</span>
                  <span className="text-text-main font-medium">医生管理</span>
                </div>
                <div className="flex items-center gap-3">
                  <h1 className="text-h2-header text-text-main font-bold">医生管理</h1>
                  <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                    共 {doctorList.length} 位医生
                  </span>
                  {hasUnsavedChanges && (
                    <span className="text-[12px] text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                      存在未保存更改
                    </span>
                  )}
                  {saveToast && (
                    <span
                      className={
                        'text-body-sm px-2.5 py-0.5 rounded-full border flex items-center gap-1 animate-in fade-in duration-200 ' +
                        (saveToast.type === 'warn'
                          ? 'text-error bg-red-50 border-red-200'
                          : saveToast.type === 'info'
                            ? 'text-primary bg-primary/10 border-primary/20'
                            : 'text-action-green bg-emerald-50 border-emerald-200')
                      }
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {saveToast.type === 'warn' ? 'error' : saveToast.type === 'info' ? 'info' : 'check_circle'}
                      </span>
                      {saveToast.text}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center flex-wrap gap-3">
                {/* 搜索与查询 */}
                <div className="flex items-center gap-1.5">
                  <div className="relative">
                    <span
                      className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
                      style={{ fontSize: '18px' }}
                    >
                      search
                    </span>
                    <input
                      type="text"
                      placeholder="搜索医生姓名、医院、科室或职称…"
                      value={doctorSearchDraft}
                      onChange={(e) => setDoctorSearchDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleQueryDoctors()
                      }}
                      className="pl-9 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-60 transition-all"
                    />
                  </div>
                  <button
                    onClick={handleQueryDoctors}
                    className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[16px]">search</span>
                    查询
                  </button>
                </div>

                {/* 保存按钮 */}
                <button
                  onClick={handleTriggerSave}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  title="保存所有修改"
                >
                  <span className="material-symbols-outlined text-[18px]">save</span>
                  保存
                </button>

                {/* 删除按钮 */}
                <button
                  onClick={handleDeleteSelectedDoctors}
                  disabled={selectedDoctorIds.length === 0}
                  className={
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                    (selectedDoctorIds.length > 0
                      ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                      : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                  }
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                  删除 {selectedDoctorIds.length > 0 ? `(${selectedDoctorIds.length})` : ''}
                </button>

                {/* 新增医生 */}
                <button
                  onClick={handleAddNewDoctor}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]">add</span>
                  新增医生
                </button>
              </div>
            </div>

            {/* 表格卡片（对齐截图全部 18+ 字段） */}
            <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
              <div className="flex-1 overflow-auto">
                <table className="min-w-[2450px] w-full text-left border-collapse">
                  <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                    <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                      <th className="py-3 px-3 w-12 min-w-[48px] text-center">
                        <input
                          type="checkbox"
                          checked={isAllDoctorsSelected}
                          onChange={() => {
                            if (selectedDoctorIds.length === filteredDoctors.length) {
                              setSelectedDoctorIds([])
                            } else {
                              setSelectedDoctorIds(filteredDoctors.map((d) => d.id))
                            }
                          }}
                          className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                        />
                      </th>
                      <th className="py-3 px-3 w-20 min-w-[80px] text-center">ID</th>
                      <th className="py-3 px-3 w-36 min-w-[140px]">医生名称</th>
                      <th className="py-3 px-3 w-24 min-w-[90px] text-center">性别</th>
                      <th className="py-3 px-3 w-36 min-w-[140px] text-center">出生日期</th>
                      <th className="py-3 px-3 w-44 min-w-[160px]">电话号码</th>
                      <th className="py-3 px-3 w-52 min-w-[200px]">电子邮箱</th>
                      <th className="py-3 px-3 w-32 min-w-[120px] text-center">省份</th>
                      <th className="py-3 px-3 w-32 min-w-[120px] text-center">城市</th>
                      <th className="py-3 px-3 w-64 min-w-[260px]">医院</th>
                      <th className="py-3 px-3 w-40 min-w-[150px]">科室</th>
                      <th className="py-3 px-3 w-36 min-w-[130px] text-center">职称</th>
                      <th className="py-3 px-3 w-32 min-w-[120px] text-center">教学职称</th>
                      <th className="py-3 px-3 w-44 min-w-[160px]">医院行政职务</th>
                      <th className="py-3 px-3 w-44 min-w-[160px]">社会任职</th>
                      <th className="py-3 px-3 w-64 min-w-[260px]">擅长</th>
                      <th className="py-3 px-3 w-48 min-w-[180px]">备注</th>
                      <th className="py-3 px-3 w-28 min-w-[100px] text-center">状态</th>
                      <th className="py-3 px-3 w-40 min-w-[140px] text-center">创建时间</th>
                      <th className="py-3 px-3 w-40 min-w-[140px] text-center">更新时间</th>
                      <th className="py-3 px-3 w-16 min-w-[60px] text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle text-body-sm">
                    {filteredDoctors.length === 0 ? (
                      <tr>
                        <td colSpan={21} className="py-16 text-center text-text-muted">
                          <div className="flex flex-col items-center justify-center gap-2">
                            <span className="material-symbols-outlined text-[36px] text-outline">
                              search_off
                            </span>
                            <span>未找到匹配的医生数据</span>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredDoctors.map((doc, dIdx) => {
                        const originalIndex = doctorList.findIndex((d) => d.id === doc.id)
                        const isChecked = selectedDoctorIds.includes(doc.id)

                        return (
                          <tr
                            key={doc.id + '_' + dIdx}
                            className={
                              'transition-colors ' +
                              (isChecked
                                ? 'bg-primary/5 hover:bg-primary/10'
                                : 'hover:bg-surface-container-low/50')
                            }
                          >
                            {/* 复选框 */}
                            <td className="py-2 px-3 text-center">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => {
                                  setSelectedDoctorIds((prev) =>
                                    prev.includes(doc.id)
                                      ? prev.filter((x) => x !== doc.id)
                                      : [...prev, doc.id]
                                  )
                                }}
                                className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                              />
                            </td>

                            {/* ID */}
                            <td className="py-1.5 px-2 font-mono-data text-center whitespace-nowrap">
                              <input
                                type="text"
                                value={doc.id}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'id', e.target.value)
                                }
                                className="w-full px-1.5 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 医生名称 */}
                            <td className="py-1.5 px-2 whitespace-nowrap">
                              <input
                                type="text"
                                value={doc.name}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'name', e.target.value)
                                }
                                className="w-full px-2 py-1 text-body-sm font-medium text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 性别 */}
                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={doc.gender}
                                onChange={(e) =>
                                  handleDoctorFieldChange(
                                    originalIndex,
                                    'gender',
                                    e.target.value as '男' | '女'
                                  )
                                }
                                className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                              >
                                <option value="男">男</option>
                                <option value="女">女</option>
                              </select>
                            </td>

                            {/* 出生日期 */}
                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <input
                                type="text"
                                value={doc.birthday}
                                placeholder="请选择范围"
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'birthday', e.target.value)
                                }
                                className="w-full px-2 py-1 text-center font-mono-data text-body-sm text-text-main placeholder:text-text-muted/60 bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 电话号码 */}
                            <td className="py-1.5 px-2">
                              <input
                                type="text"
                                value={doc.phone}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'phone', e.target.value)
                                }
                                className="w-full px-2 py-1 font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 电子邮箱 */}
                            <td className="py-1.5 px-2">
                              <input
                                type="text"
                                value={doc.email}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'email', e.target.value)
                                }
                                className="w-full px-2 py-1 font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 省份 */}
                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={doc.province}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'province', e.target.value)
                                }
                                className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                              >
                                <option value="北京市">北京市</option>
                                <option value="四川省">四川省</option>
                                <option value="上海市">上海市</option>
                                <option value="广东省">广东省</option>
                                <option value="浙江省">浙江省</option>
                              </select>
                            </td>

                            {/* 城市 */}
                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={doc.city}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'city', e.target.value)
                                }
                                className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                              >
                                <option value="北京市">北京市</option>
                                <option value="成都市">成都市</option>
                                <option value="上海市">上海市</option>
                                <option value="广州市">广州市</option>
                                <option value="杭州市">杭州市</option>
                              </select>
                            </td>

                            {/* 医院 */}
                            <td className="py-1.5 px-2 whitespace-nowrap">
                              <select
                                value={doc.hospital}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'hospital', e.target.value)
                                }
                                className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer"
                              >
                                {hospList.map((h) => (
                                  <option key={h.id} value={h.name}>
                                    {h.name}
                                  </option>
                                ))}
                              </select>
                            </td>

                            {/* 科室 */}
                            <td className="py-1.5 px-2 whitespace-nowrap">
                              <input
                                type="text"
                                value={doc.department}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'department', e.target.value)
                                }
                                className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 职称 */}
                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={doc.title}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'title', e.target.value)
                                }
                                className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                              >
                                <option value="知名专家">知名专家</option>
                                <option value="主任医师">主任医师</option>
                                <option value="副主任医师">副主任医师</option>
                                <option value="主治医师">主治医师</option>
                                <option value="医师">医师</option>
                              </select>
                            </td>

                            {/* 教学职称 */}
                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={doc.teachingTitle}
                                onChange={(e) =>
                                  handleDoctorFieldChange(
                                    originalIndex,
                                    'teachingTitle',
                                    e.target.value
                                  )
                                }
                                className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                              >
                                <option value="">无</option>
                                <option value="教授">教授</option>
                                <option value="副教授">副教授</option>
                                <option value="讲师">讲师</option>
                              </select>
                            </td>

                            {/* 医院行政职务 */}
                            <td className="py-1.5 px-2">
                              <input
                                type="text"
                                value={doc.adminPosition}
                                onChange={(e) =>
                                  handleDoctorFieldChange(
                                    originalIndex,
                                    'adminPosition',
                                    e.target.value
                                  )
                                }
                                className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 社会任职 */}
                            <td className="py-1.5 px-2">
                              <input
                                type="text"
                                value={doc.socialPosition}
                                onChange={(e) =>
                                  handleDoctorFieldChange(
                                    originalIndex,
                                    'socialPosition',
                                    e.target.value
                                  )
                                }
                                className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 擅长 */}
                            <td className="py-1.5 px-2">
                              <input
                                type="text"
                                value={doc.specialty}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'specialty', e.target.value)
                                }
                                className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 备注 */}
                            <td className="py-1.5 px-2">
                              <input
                                type="text"
                                value={doc.remark}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'remark', e.target.value)
                                }
                                className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            {/* 状态 */}
                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={doc.status}
                                onChange={(e) =>
                                  handleDoctorFieldChange(originalIndex, 'status', e.target.value)
                                }
                                className={
                                  'px-2 py-1 border rounded text-body-sm font-medium focus:outline-none transition-colors cursor-pointer whitespace-nowrap ' +
                                  (doc.status === 'enabled'
                                    ? 'border-border-subtle text-action-green bg-emerald-50/50 hover:border-action-green'
                                    : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                                }
                              >
                                <option value="enabled">启用</option>
                                <option value="disabled">禁用</option>
                              </select>
                            </td>

                            {/* 创建时间：直接干净文本显示 */}
                            <td className="py-2 px-3 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                              {doc.createdAt}
                            </td>

                            {/* 更新时间：直接干净文本显示 */}
                            <td className="py-2 px-3 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                              {doc.updatedAt}
                            </td>

                            {/* 操作：删除 */}
                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => handleDeleteSingleDoctor(doc.id, doc.name)}
                                className="inline-flex items-center justify-center p-1 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                                title="删除该医生"
                              >
                                <span className="material-symbols-outlined text-[18px]">delete</span>
                              </button>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : activeMenu === 'hospital_manage_sub' ? (
          activeDrilldownHospital ? (
            /* ══════════════════════════════════════════════════════════
               2. 医院科室下钻页面（对外科室管理）
               ══════════════════════════════════════════════════════════ */
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
              {/* 顶栏卡片 */}
              <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs space-y-4 shrink-0">
                {/* 面包屑 */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-body-sm">
                    <button
                      onClick={() => setDrilldownHospitalId(null)}
                      className="text-primary hover:text-primary-container font-medium flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                      医院管理
                    </button>
                    <span className="material-symbols-outlined text-[16px] text-outline">
                      chevron_right
                    </span>
                    <span className="text-text-main font-semibold">
                      {activeDrilldownHospital.name} 对外科室
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {hasUnsavedChanges && (
                      <span className="text-[12px] text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        存在未保存更改
                      </span>
                    )}
                    {saveToast && (
                      <span
                        className={
                          'text-body-sm px-3 py-1 rounded-full border flex items-center gap-1 animate-in fade-in duration-200 ' +
                          (saveToast.type === 'warn'
                            ? 'text-error bg-red-50 border-red-200'
                            : saveToast.type === 'info'
                              ? 'text-primary bg-primary/10 border-primary/20'
                              : 'text-action-green bg-emerald-50 border-emerald-200')
                        }
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {saveToast.type === 'warn' ? 'error' : saveToast.type === 'info' ? 'info' : 'check_circle'}
                        </span>
                        {saveToast.text}
                      </span>
                    )}
                  </div>
                </div>

                {/* 搜索条件与操作按钮栏 */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-border-subtle">
                  <div className="flex flex-wrap items-center gap-3 text-body-sm">
                    {/* 科室细分名称输入 */}
                    <div className="flex items-center gap-2">
                      <span className="text-text-main font-medium whitespace-nowrap">科室细分名称</span>
                      <input
                        type="text"
                        value={extSearchNameDraft}
                        onChange={(e) => setExtSearchNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleQueryExtDepts()
                        }}
                        placeholder="输入名称后点击查询…"
                        className="px-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-48 transition-all"
                      />
                    </div>

                    {/* 对内一级科室下拉 */}
                    <div className="flex items-center gap-2">
                      <span className="text-text-main font-medium whitespace-nowrap">对内一级科室</span>
                      <select
                        value={extSearchLevel1Draft}
                        onChange={(e) => setExtSearchLevel1Draft(e.target.value)}
                        className="px-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-36 cursor-pointer"
                      >
                        <option value="all">全部系统</option>
                        {deptList.map((d) => (
                          <option key={d.id} value={d.name}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* 状态下拉 */}
                    <div className="flex items-center gap-2">
                      <span className="text-text-main font-medium whitespace-nowrap">状态</span>
                      <select
                        value={extSearchStatusDraft}
                        onChange={(e) =>
                          setExtSearchStatusDraft(e.target.value as 'all' | 'enabled' | 'disabled')
                        }
                        className="px-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-28 cursor-pointer"
                      >
                        <option value="all">全部</option>
                        <option value="enabled">启用</option>
                        <option value="disabled">禁用</option>
                      </select>
                    </div>

                    {/* 查询按钮 */}
                    <button
                      onClick={handleQueryExtDepts}
                      className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">search</span>
                      查询
                    </button>
                  </div>

                  {/* 核心操作按钮组 */}
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      onClick={handleTriggerSave}
                      className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">save</span>
                      保存
                    </button>

                    <button
                      onClick={handleDeleteSelectedExtDepts}
                      disabled={selectedExtDeptIds.length === 0}
                      className={
                        'inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                        (selectedExtDeptIds.length > 0
                          ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                          : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                      }
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                      删除 {selectedExtDeptIds.length > 0 ? `(${selectedExtDeptIds.length})` : ''}
                    </button>

                    <button
                      onClick={handleAddNewExtDepartment}
                      className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                      title="追加新对外科室到末尾"
                    >
                      <span className="material-symbols-outlined text-[16px]">add</span>
                      新增科室
                    </button>
                  </div>
                </div>
              </div>

              {/* 对外科室大标题与表格容器 */}
              <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
                <div className="py-3 px-6 border-b border-border-subtle bg-surface-container-low/30 text-center">
                  <h2 className="text-[16px] font-bold text-text-main tracking-wide">
                    {activeDrilldownHospital.name} 对外科室
                  </h2>
                </div>

                <div className="flex-1 overflow-auto">
                  <table className="min-w-[1050px] w-full text-left border-collapse">
                    <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                      <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                        <th className="py-3 px-4 w-12 min-w-[48px] text-center">
                          <input
                            type="checkbox"
                            checked={isAllExtDeptsSelected}
                            onChange={() => {
                              if (selectedExtDeptIds.length === filteredExtDepts.length) {
                                setSelectedExtDeptIds([])
                              } else {
                                setSelectedExtDeptIds(filteredExtDepts.map((e) => e.id))
                              }
                            }}
                            className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                          />
                        </th>
                        <th className="py-3 px-4 w-20 min-w-[80px] text-center">ID</th>
                        <th className="py-3 px-4 min-w-[240px]">科室细分名称</th>
                        <th className="py-3 px-4 w-48 min-w-[160px] text-center">对内一级科室</th>
                        <th className="py-3 px-4 w-48 min-w-[160px] text-center">对内二级科室</th>
                        <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                        <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                        <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle text-body-sm">
                      {filteredExtDepts.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-16 text-center text-text-muted">
                            <div className="flex flex-col items-center justify-center gap-2">
                              <span className="material-symbols-outlined text-[36px] text-outline">
                                search_off
                              </span>
                              <span>未找到匹配的对外科室数据</span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filteredExtDepts.map((extItem, eIdx) => {
                          const originalExtIndex = currentExtDeptList.findIndex(
                            (e) => e.id === extItem.id
                          )
                          const isExtChecked = selectedExtDeptIds.includes(extItem.id)
                          const matchedDept = deptList.find((d) => d.name === extItem.internalLevel1)
                          const availableLevel2Options =
                            matchedDept?.subDepartments.map((s) => s.name) || [extItem.internalLevel2]

                          return (
                            <tr
                              key={extItem.id + '_' + eIdx}
                              className={
                                'transition-colors ' +
                                (isExtChecked
                                  ? 'bg-primary/5 hover:bg-primary/10'
                                  : 'hover:bg-surface-container-low/50')
                              }
                            >
                              <td className="py-3 px-4 text-center">
                                <input
                                  type="checkbox"
                                  checked={isExtChecked}
                                  onChange={() => {
                                    setSelectedExtDeptIds((prev) =>
                                      prev.includes(extItem.id)
                                        ? prev.filter((x) => x !== extItem.id)
                                        : [...prev, extItem.id]
                                    )
                                  }}
                                  className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                                />
                              </td>

                              <td className="py-2 px-3 font-mono-data text-center whitespace-nowrap">
                                <input
                                  type="text"
                                  value={extItem.id}
                                  onChange={(e) =>
                                    handleExtDeptFieldChange(originalExtIndex, 'id', e.target.value)
                                  }
                                  className="w-16 px-1.5 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-2 px-3">
                                <input
                                  type="text"
                                  value={extItem.name}
                                  onChange={(e) =>
                                    handleExtDeptFieldChange(originalExtIndex, 'name', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1 text-body-sm font-medium text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-2 px-3 text-center whitespace-nowrap">
                                <select
                                  value={extItem.internalLevel1}
                                  onChange={(e) =>
                                    handleExtDeptFieldChange(
                                      originalExtIndex,
                                      'internalLevel1',
                                      e.target.value
                                    )
                                  }
                                  className="w-full px-2.5 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                                >
                                  {deptList.map((d) => (
                                    <option key={d.id} value={d.name}>
                                      {d.name}
                                    </option>
                                  ))}
                                </select>
                              </td>

                              <td className="py-2 px-3 text-center whitespace-nowrap">
                                <select
                                  value={extItem.internalLevel2}
                                  onChange={(e) =>
                                    handleExtDeptFieldChange(
                                      originalExtIndex,
                                      'internalLevel2',
                                      e.target.value
                                    )
                                  }
                                  className="w-full max-w-[160px] px-2.5 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center mx-auto"
                                >
                                  {availableLevel2Options.map((subName, i) => (
                                    <option key={i} value={subName}>
                                      {subName}
                                    </option>
                                  ))}
                                </select>
                              </td>

                              <td className="py-2 px-3 text-center whitespace-nowrap">
                                <select
                                  value={extItem.status}
                                  onChange={(e) =>
                                    handleExtDeptFieldChange(
                                      originalExtIndex,
                                      'status',
                                      e.target.value
                                    )
                                  }
                                  className={
                                    'px-2.5 py-1 border rounded text-body-sm font-medium focus:outline-none transition-colors cursor-pointer whitespace-nowrap ' +
                                    (extItem.status === 'enabled'
                                      ? 'border-border-subtle text-action-green bg-emerald-50/50 hover:border-action-green'
                                      : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                                  }
                                >
                                  <option value="enabled">启用</option>
                                  <option value="disabled">禁用</option>
                                </select>
                              </td>

                              <td className="py-2.5 px-3 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                                {extItem.updatedAt}
                              </td>

                              <td className="py-2 px-3 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSingleExtDept(extItem.id, extItem.name)}
                                  className="inline-flex items-center justify-center p-1 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                                  title="删除该对外科室"
                                >
                                  <span className="material-symbols-outlined text-[18px]">delete</span>
                                </button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            /* ══════════════════════════════════════════════════════════
               3. 医院管理主表
               ══════════════════════════════════════════════════════════ */
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
              {/* 顶栏卡片 */}
              <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
                <div>
                  <div className="flex items-center gap-2 text-[12px] text-text-muted mb-1">
                    <span>字典维护</span>
                    <span>/</span>
                    <span>医院管理</span>
                    <span>/</span>
                    <span className="text-text-main font-medium">医院管理</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-h2-header text-text-main font-bold">医院管理</h1>
                    <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                      共 {hospList.length} 家医院
                    </span>
                    {hasUnsavedChanges && (
                      <span className="text-[12px] text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        存在未保存更改
                      </span>
                    )}
                    {saveToast && (
                      <span
                        className={
                          'text-body-sm px-2.5 py-0.5 rounded-full border flex items-center gap-1 animate-in fade-in duration-200 ' +
                          (saveToast.type === 'warn'
                            ? 'text-error bg-red-50 border-red-200'
                            : saveToast.type === 'info'
                              ? 'text-primary bg-primary/10 border-primary/20'
                              : 'text-action-green bg-emerald-50 border-emerald-200')
                        }
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {saveToast.type === 'warn' ? 'error' : saveToast.type === 'info' ? 'info' : 'check_circle'}
                        </span>
                        {saveToast.text}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center flex-wrap gap-3">
                  <div className="flex items-center gap-1.5">
                    <div className="relative">
                      <span
                        className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
                        style={{ fontSize: '18px' }}
                      >
                        search
                      </span>
                      <input
                        type="text"
                        placeholder="搜索医院名称、级别或地址…"
                        value={hospSearchDraft}
                        onChange={(e) => setHospSearchDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleQueryHosps()
                        }}
                        className="pl-9 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-56 transition-all"
                      />
                    </div>
                    <button
                      onClick={handleQueryHosps}
                      className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">search</span>
                      查询
                    </button>
                  </div>

                  <button
                    onClick={handleTriggerSave}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    title="保存所有修改"
                  >
                    <span className="material-symbols-outlined text-[18px]">save</span>
                    保存
                  </button>

                  <button
                    onClick={handleDeleteSelectedHosps}
                    disabled={selectedHospIds.length === 0}
                    className={
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                      (selectedHospIds.length > 0
                        ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                        : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                    }
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                    删除 {selectedHospIds.length > 0 ? `(${selectedHospIds.length})` : ''}
                  </button>

                  <button
                    onClick={handleAddNewHospital}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    新增医院
                  </button>
                </div>
              </div>

              {/* 表格卡片 */}
              <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
                <div className="flex-1 overflow-auto">
                  <table className="min-w-[2150px] w-full text-left border-collapse">
                    <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                      <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                        <th className="py-3 px-3 w-12 min-w-[48px] text-center">
                          <input
                            type="checkbox"
                            checked={isAllHospsSelected}
                            onChange={() => {
                              if (selectedHospIds.length === filteredHosps.length) {
                                setSelectedHospIds([])
                              } else {
                                setSelectedHospIds(filteredHosps.map((h) => h.id))
                              }
                            }}
                            className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                          />
                        </th>
                        <th className="py-3 px-3 w-20 min-w-[80px] text-center">ID</th>
                        <th className="py-3 px-3 w-24 min-w-[90px] text-center">操作</th>
                        <th className="py-3 px-3 w-64 min-w-[240px]">医院名称</th>
                        <th className="py-3 px-3 w-36 min-w-[130px] text-center">医院级别</th>
                        <th className="py-3 px-3 w-32 min-w-[120px] text-center">标签</th>
                        <th className="py-3 px-3 w-32 min-w-[120px] text-center">省份</th>
                        <th className="py-3 px-3 w-32 min-w-[120px] text-center">城市</th>
                        <th className="py-3 px-3 w-64 min-w-[260px]">医院地址1</th>
                        <th className="py-3 px-3 w-64 min-w-[260px]">医院地址2</th>
                        <th className="py-3 px-3 w-64 min-w-[240px]">医院地址3</th>
                        <th className="py-3 px-3 w-48 min-w-[180px]">Tips</th>
                        <th className="py-3 px-3 w-48 min-w-[180px]">备注</th>
                        <th className="py-3 px-3 w-28 min-w-[100px] text-center">状态</th>
                        <th className="py-3 px-3 w-40 min-w-[140px] text-center">更新时间</th>
                        <th className="py-3 px-3 w-16 min-w-[60px] text-center">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle text-body-sm">
                      {filteredHosps.length === 0 ? (
                        <tr>
                          <td colSpan={16} className="py-16 text-center text-text-muted">
                            <div className="flex flex-col items-center justify-center gap-2">
                              <span className="material-symbols-outlined text-[36px] text-outline">
                                search_off
                              </span>
                              <span>未找到匹配的医院数据</span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filteredHosps.map((hosp, hIdx) => {
                          const originalIndex = hospList.findIndex((h) => h.id === hosp.id)
                          const isChecked = selectedHospIds.includes(hosp.id)

                          return (
                            <tr
                              key={hosp.id + '_' + hIdx}
                              className={
                                'transition-colors ' +
                                (isChecked
                                  ? 'bg-primary/5 hover:bg-primary/10'
                                  : 'hover:bg-surface-container-low/50')
                              }
                            >
                              <td className="py-2 px-3 text-center">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    setSelectedHospIds((prev) =>
                                      prev.includes(hosp.id)
                                        ? prev.filter((x) => x !== hosp.id)
                                        : [...prev, hosp.id]
                                    )
                                  }}
                                  className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                                />
                              </td>

                              <td className="py-1.5 px-2 font-mono-data text-center whitespace-nowrap">
                                <input
                                  type="text"
                                  value={hosp.id}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'id', e.target.value)
                                  }
                                  className="w-16 px-1.5 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDrilldownHospitalId(hosp.id)
                                    setExtSearchNameDraft('')
                                    setExtSearchLevel1Draft('all')
                                    setExtSearchStatusDraft('all')
                                    setAppliedExtSearchName('')
                                    setAppliedExtSearchLevel1('all')
                                    setAppliedExtSearchStatus('all')
                                    setSelectedExtDeptIds([])
                                  }}
                                  className="inline-flex items-center gap-0.5 px-2.5 py-1 rounded-md text-primary bg-primary/10 hover:bg-primary hover:text-white border border-primary/20 text-[13px] font-medium transition-all cursor-pointer group"
                                  title="下钻查看该医院的对外科室体系"
                                >
                                  <span>科室</span>
                                  <span className="material-symbols-outlined text-[15px] transition-transform group-hover:translate-x-0.5">
                                    chevron_right
                                  </span>
                                </button>
                              </td>

                              <td className="py-1.5 px-2 whitespace-nowrap">
                                <input
                                  type="text"
                                  value={hosp.name}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'name', e.target.value)
                                  }
                                  className="w-full px-2 py-1 text-body-sm font-medium text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <select
                                  value={hosp.level}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'level', e.target.value)
                                  }
                                  className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                                >
                                  <option value="三级甲等">三级甲等</option>
                                  <option value="三级乙等">三级乙等</option>
                                  <option value="三级医院">三级医院</option>
                                  <option value="二级甲等">二级甲等</option>
                                  <option value="二级乙等">二级乙等</option>
                                  <option value="其他">其他</option>
                                </select>
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <select
                                  value={hosp.tag}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'tag', e.target.value)
                                  }
                                  className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                                >
                                  <option value="">无</option>
                                  <option value="重点医院">重点医院</option>
                                  <option value="医保定点">医保定点</option>
                                  <option value="合作示范">合作示范</option>
                                </select>
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <select
                                  value={hosp.province}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'province', e.target.value)
                                  }
                                  className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                                >
                                  <option value="北京市">北京市</option>
                                  <option value="上海市">上海市</option>
                                  <option value="广东省">广东省</option>
                                  <option value="浙江省">浙江省</option>
                                  <option value="江苏省">江苏省</option>
                                  <option value="四川省">四川省</option>
                                </select>
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <select
                                  value={hosp.city}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'city', e.target.value)
                                  }
                                  className="w-full px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center"
                                >
                                  <option value="北京市">北京市</option>
                                  <option value="上海市">上海市</option>
                                  <option value="广州市">广州市</option>
                                  <option value="深圳市">深圳市</option>
                                  <option value="杭州市">杭州市</option>
                                  <option value="成都市">成都市</option>
                                </select>
                              </td>

                              <td className="py-1.5 px-2">
                                <input
                                  type="text"
                                  value={hosp.address1}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'address1', e.target.value)
                                  }
                                  className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2">
                                <input
                                  type="text"
                                  value={hosp.address2}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'address2', e.target.value)
                                  }
                                  className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2">
                                <input
                                  type="text"
                                  value={hosp.address3}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'address3', e.target.value)
                                  }
                                  className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2">
                                <input
                                  type="text"
                                  value={hosp.tips}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'tips', e.target.value)
                                  }
                                  className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2">
                                <input
                                  type="text"
                                  value={hosp.remark}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'remark', e.target.value)
                                  }
                                  className="w-full px-2 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <select
                                  value={hosp.status}
                                  onChange={(e) =>
                                    handleHospFieldChange(originalIndex, 'status', e.target.value)
                                  }
                                  className={
                                    'px-2 py-1 border rounded text-body-sm font-medium focus:outline-none transition-colors cursor-pointer whitespace-nowrap ' +
                                    (hosp.status === 'enabled'
                                      ? 'border-border-subtle text-action-green bg-emerald-50/50 hover:border-action-green'
                                      : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                                  }
                                >
                                  <option value="enabled">启用</option>
                                  <option value="disabled">禁用</option>
                                </select>
                              </td>

                              <td className="py-2 px-3 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                                {hosp.updatedAt}
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSingleHosp(hosp.id, hosp.name)}
                                  className="inline-flex items-center justify-center p-1 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                                  title="删除该医院"
                                >
                                  <span className="material-symbols-outlined text-[18px]">delete</span>
                                </button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )
        ) : activeMenu === 'internal_department' ? (
          <InternalDepartmentView />
        ) : activeMenu === 'channel_manage_sub' ? (
          activeDrilldownChannel ? (
            /* ══════════════════════════════════════════════════════════
               4.1 渠道产品下钻子表 (f_hy_cp_qd)
               ══════════════════════════════════════════════════════════ */
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4 animate-in fade-in duration-150">
              {/* 顶栏卡片 */}
              <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-[12px] text-text-muted">
                    <button
                      type="button"
                      onClick={() => setDrilldownChannelId(null)}
                      className="hover:text-primary transition-colors flex items-center gap-0.5 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[14px]">arrow_back</span>
                      <span>返回渠道列表</span>
                    </button>
                    <span>/</span>
                    <span className="text-text-main font-medium">{activeDrilldownChannel.name}</span>
                    <span>/</span>
                    <span className="text-primary font-medium">渠道产品列表</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-h2-header text-text-main font-bold">
                      {activeDrilldownChannel.name} - 渠道产品
                    </h1>
                    <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                      共 {currentChannelProductList.length} 个渠道产品
                    </span>
                    {hasUnsavedChanges && (
                      <span className="text-[12px] text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        存在未保存更改
                      </span>
                    )}
                    {saveToast && (
                      <span
                        className={
                          'text-body-sm px-2.5 py-0.5 rounded-full border flex items-center gap-1 animate-in fade-in duration-200 ' +
                          (saveToast.type === 'warn'
                            ? 'text-error bg-red-50 border-red-200'
                            : saveToast.type === 'info'
                              ? 'text-primary bg-primary/10 border-primary/20'
                              : 'text-action-green bg-emerald-50 border-emerald-200')
                        }
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {saveToast.type === 'warn' ? 'error' : saveToast.type === 'info' ? 'info' : 'check_circle'}
                        </span>
                        {saveToast.text}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center flex-wrap gap-3">
                  <div className="flex items-center gap-1.5">
                    <div className="relative">
                      <span
                        className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
                        style={{ fontSize: '18px' }}
                      >
                        search
                      </span>
                      <input
                        type="text"
                        placeholder="搜索产品名称、ID或序号…"
                        value={channelProductSearchDraft}
                        onChange={(e) => setChannelProductSearchDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleQueryChannelProducts()
                        }}
                        className="pl-9 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-48 transition-all"
                      />
                    </div>

                    <select
                      value={channelProductStatusDraft}
                      onChange={(e) => setChannelProductStatusDraft(e.target.value)}
                      className="px-2.5 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary transition-all cursor-pointer"
                    >
                      <option value="all">全部状态</option>
                      <option value="enabled">● 启用</option>
                      <option value="disabled">○ 禁用</option>
                    </select>

                    <button
                      type="button"
                      onClick={handleQueryChannelProducts}
                      className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">search</span>
                      查询
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleTriggerSave}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    title="保存所有修改"
                  >
                    <span className="material-symbols-outlined text-[18px]">save</span>
                    保存
                  </button>

                  <button
                    type="button"
                    onClick={handleDeleteSelectedChannelProducts}
                    disabled={selectedChannelProductIds.length === 0}
                    className={
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                      (selectedChannelProductIds.length > 0
                        ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                        : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                    }
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                    删除 {selectedChannelProductIds.length > 0 ? `(${selectedChannelProductIds.length})` : ''}
                  </button>

                  <button
                    type="button"
                    onClick={handleAddNewChannelProduct}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    新增产品
                  </button>
                </div>
              </div>

              {/* 表格卡片 */}
              <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
                <div className="flex-1 overflow-auto">
                  <table className="min-w-[1100px] w-full text-left border-collapse">
                    <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                      <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                        <th className="py-3 px-3 w-12 min-w-[48px] text-center">
                          <input
                            type="checkbox"
                            checked={isAllChannelProductsSelected}
                            onChange={() => {
                              if (selectedChannelProductIds.length === filteredChannelProducts.length) {
                                setSelectedChannelProductIds([])
                              } else {
                                setSelectedChannelProductIds(filteredChannelProducts.map((p) => p.id))
                              }
                            }}
                            className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                          />
                        </th>
                        <th className="py-3 px-3 w-32 min-w-[120px] text-center">物理主键ID</th>
                        <th className="py-3 px-3 w-24 min-w-[90px] text-center">序号ID</th>
                        <th className="py-3 px-3 w-72 min-w-[220px]">渠道产品名称</th>
                        <th className="py-3 px-3 w-32 min-w-[110px] text-center">售价(元)</th>
                        <th className="py-3 px-3 w-44 min-w-[140px] text-center">对标内部大类</th>
                        <th className="py-3 px-3 w-44 min-w-[140px] text-center">对标内部细分</th>
                        <th className="py-3 px-3 w-28 min-w-[100px] text-center">状态</th>
                        <th className="py-3 px-3 w-36 min-w-[130px] text-center">更新时间</th>
                        <th className="py-3 px-3 w-20 min-w-[70px] text-center">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle text-body-sm">
                      {filteredChannelProducts.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="py-16 text-center text-text-muted">
                            <div className="flex flex-col items-center justify-center gap-2">
                              <span className="material-symbols-outlined text-[36px] text-outline">search_off</span>
                              <span>未找到匹配的渠道产品数据</span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filteredChannelProducts.map((prod, pIdx) => {
                          const originalProdIndex = (activeDrilldownChannel.products || []).findIndex(
                            (p) => p.id === prod.id
                          )
                          const isChecked = selectedChannelProductIds.includes(prod.id)

                          return (
                            <tr
                              key={prod.id + '_' + pIdx}
                              className={
                                'transition-colors ' +
                                (isChecked ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-surface-container-low/50')
                              }
                            >
                              <td className="py-2 px-3 text-center">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    setSelectedChannelProductIds((prev) =>
                                      prev.includes(prod.id)
                                        ? prev.filter((x) => x !== prod.id)
                                        : [...prev, prod.id]
                                    )
                                  }}
                                  className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                                />
                              </td>

                              <td className="py-2.5 px-3 text-center font-mono-data text-body-sm text-text-muted bg-surface-container-low/30 whitespace-nowrap">
                                {prod.id}
                              </td>

                              <td className="py-1.5 px-2 font-mono-data text-center whitespace-nowrap">
                                <input
                                  type="text"
                                  value={prod.xh}
                                  onChange={(e) =>
                                    handleChannelProductFieldChange(originalProdIndex, 'xh', e.target.value)
                                  }
                                  className="w-16 px-1.5 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-3 whitespace-nowrap">
                                <input
                                  type="text"
                                  value={prod.name}
                                  onChange={(e) =>
                                    handleChannelProductFieldChange(originalProdIndex, 'name', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1 text-body-sm font-medium text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <input
                                  type="number"
                                  value={prod.price}
                                  onChange={(e) =>
                                    handleChannelProductFieldChange(originalProdIndex, 'price', e.target.value)
                                  }
                                  className="w-24 px-2 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary mx-auto"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <input
                                  type="text"
                                  value={prod.internalLevel1}
                                  onChange={(e) =>
                                    handleChannelProductFieldChange(originalProdIndex, 'internalLevel1', e.target.value)
                                  }
                                  className="w-32 px-2 py-1 text-center text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary mx-auto"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <input
                                  type="text"
                                  value={prod.internalLevel2}
                                  onChange={(e) =>
                                    handleChannelProductFieldChange(originalProdIndex, 'internalLevel2', e.target.value)
                                  }
                                  className="w-32 px-2 py-1 text-center text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary mx-auto"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <select
                                  value={prod.status}
                                  onChange={(e) =>
                                    handleChannelProductFieldChange(
                                      originalProdIndex,
                                      'status',
                                      e.target.value as 'enabled' | 'disabled'
                                    )
                                  }
                                  className={
                                    'px-2.5 py-1 border rounded text-body-sm font-medium focus:outline-none transition-colors cursor-pointer whitespace-nowrap ' +
                                    (prod.status === 'enabled'
                                      ? 'border-border-subtle text-action-green bg-emerald-50/50 hover:border-action-green'
                                      : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                                  }
                                >
                                  <option value="enabled">启用</option>
                                  <option value="disabled">禁用</option>
                                </select>
                              </td>

                              <td className="py-2.5 px-3 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                                {prod.updatedAt}
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSingleChannelProduct(prod.id, prod.name)}
                                  className="inline-flex items-center justify-center p-1 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                                  title="删除该产品"
                                >
                                  <span className="material-symbols-outlined text-[18px]">delete</span>
                                </button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            /* ══════════════════════════════════════════════════════════
               4.2 渠道管理主表 (f_hy_qd)
               ══════════════════════════════════════════════════════════ */
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
              {/* 顶栏卡片 */}
              <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
                <div>
                  <div className="flex items-center gap-2 text-[12px] text-text-muted mb-1">
                    <span>字典维护</span>
                    <span>/</span>
                    <span>渠道管理</span>
                    <span>/</span>
                    <span className="text-text-main font-medium">渠道管理</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-h2-header text-text-main font-bold">渠道管理</h1>
                    <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                      共 {channelList.length} 个业务渠道
                    </span>
                    {hasUnsavedChanges && (
                      <span className="text-[12px] text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        存在未保存更改
                      </span>
                    )}
                    {saveToast && (
                      <span
                        className={
                          'text-body-sm px-2.5 py-0.5 rounded-full border flex items-center gap-1 animate-in fade-in duration-200 ' +
                          (saveToast.type === 'warn'
                            ? 'text-error bg-red-50 border-red-200'
                            : saveToast.type === 'info'
                              ? 'text-primary bg-primary/10 border-primary/20'
                              : 'text-action-green bg-emerald-50 border-emerald-200')
                        }
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {saveToast.type === 'warn' ? 'error' : saveToast.type === 'info' ? 'info' : 'check_circle'}
                        </span>
                        {saveToast.text}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center flex-wrap gap-3">
                  <div className="flex items-center gap-1.5">
                    <div className="relative">
                      <span
                        className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
                        style={{ fontSize: '18px' }}
                      >
                        search
                      </span>
                      <input
                        type="text"
                        placeholder="搜索渠道名称或ID…"
                        value={channelSearchDraft}
                        onChange={(e) => setChannelSearchDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleQueryChannels()
                        }}
                        className="pl-9 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-56 transition-all"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleQueryChannels}
                      className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">search</span>
                      查询
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleTriggerSave}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    title="保存所有修改"
                  >
                    <span className="material-symbols-outlined text-[18px]">save</span>
                    保存
                  </button>

                  <button
                    type="button"
                    onClick={handleDeleteSelectedChannels}
                    disabled={selectedChannelIds.length === 0}
                    className={
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                      (selectedChannelIds.length > 0
                        ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                        : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                    }
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                    删除 {selectedChannelIds.length > 0 ? `(${selectedChannelIds.length})` : ''}
                  </button>

                  <button
                    type="button"
                    onClick={handleAddNewChannel}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    新增渠道
                  </button>
                </div>
              </div>

              {/* 表格卡片 */}
              <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
                <div className="flex-1 overflow-auto">
                  <table className="min-w-[900px] w-full text-left border-collapse">
                    <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                      <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                        <th className="py-3 px-3 w-12 min-w-[48px] text-center">
                          <input
                            type="checkbox"
                            checked={isAllChannelsSelected}
                            onChange={() => {
                              if (selectedChannelIds.length === filteredChannels.length) {
                                setSelectedChannelIds([])
                              } else {
                                setSelectedChannelIds(filteredChannels.map((c) => c.id))
                              }
                            }}
                            className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                          />
                        </th>
                        <th className="py-3 px-3 w-24 min-w-[90px] text-center">ID</th>
                        <th className="py-3 px-3 w-32 min-w-[120px] text-center">操作</th>
                        <th className="py-3 px-4 w-72 min-w-[220px]">渠道名称</th>
                        <th className="py-3 px-3 w-28 min-w-[100px] text-center">状态</th>
                        <th className="py-3 px-4 w-40 min-w-[140px] text-center">创建时间</th>
                        <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                        <th className="py-3 px-3 w-20 min-w-[70px] text-center">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle text-body-sm">
                      {filteredChannels.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-16 text-center text-text-muted">
                            <div className="flex flex-col items-center justify-center gap-2">
                              <span className="material-symbols-outlined text-[36px] text-outline">search_off</span>
                              <span>未找到匹配的渠道数据</span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filteredChannels.map((chan, cIdx) => {
                          const originalIndex = channelList.findIndex((c) => c.id === chan.id)
                          const isChecked = selectedChannelIds.includes(chan.id)

                          return (
                            <tr
                              key={chan.id + '_' + cIdx}
                              className={
                                'transition-colors ' +
                                (isChecked ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-surface-container-low/50')
                              }
                            >
                              <td className="py-2 px-3 text-center">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    setSelectedChannelIds((prev) =>
                                      prev.includes(chan.id)
                                        ? prev.filter((x) => x !== chan.id)
                                        : [...prev, chan.id]
                                    )
                                  }}
                                  className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                                />
                              </td>

                              <td className="py-1.5 px-2 font-mono-data text-center whitespace-nowrap">
                                <input
                                  type="text"
                                  value={chan.id}
                                  onChange={(e) =>
                                    handleChannelFieldChange(originalIndex, 'id', e.target.value)
                                  }
                                  className="w-20 px-1.5 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDrilldownChannelId(chan.id)
                                    setChannelProductSearchDraft('')
                                    setChannelProductStatusDraft('all')
                                    setAppliedChannelProductSearch('')
                                    setAppliedChannelProductStatus('all')
                                    setSelectedChannelProductIds([])
                                  }}
                                  className="inline-flex items-center gap-0.5 px-2.5 py-1 rounded-md text-primary bg-primary/10 hover:bg-primary hover:text-white border border-primary/20 text-[13px] font-medium transition-all cursor-pointer group"
                                  title="查看下属渠道产品"
                                >
                                  <span>渠道产品</span>
                                  <span className="material-symbols-outlined text-[15px] transition-transform group-hover:translate-x-0.5">
                                    chevron_right
                                  </span>
                                </button>
                              </td>

                              <td className="py-1.5 px-3 whitespace-nowrap">
                                <input
                                  type="text"
                                  value={chan.name}
                                  onChange={(e) =>
                                    handleChannelFieldChange(originalIndex, 'name', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1 text-body-sm font-medium text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <select
                                  value={chan.status}
                                  onChange={(e) =>
                                    handleChannelFieldChange(
                                      originalIndex,
                                      'status',
                                      e.target.value as 'enabled' | 'disabled'
                                    )
                                  }
                                  className={
                                    'px-2.5 py-1 border rounded text-body-sm font-medium focus:outline-none transition-colors cursor-pointer whitespace-nowrap ' +
                                    (chan.status === 'enabled'
                                      ? 'border-border-subtle text-action-green bg-emerald-50/50 hover:border-action-green'
                                      : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                                  }
                                >
                                  <option value="enabled">启用</option>
                                  <option value="disabled">禁用</option>
                                </select>
                              </td>

                              <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                                {chan.createdAt}
                              </td>

                              <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                                {chan.updatedAt}
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSingleChannel(chan.id, chan.name)}
                                  className="inline-flex items-center justify-center p-1 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                                  title="删除该渠道"
                                >
                                  <span className="material-symbols-outlined text-[18px]">delete</span>
                                </button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )
        ) : activeMenu === 'internal_product' ? (
          activeDrilldownInternalProduct ? (
            /* ══════════════════════════════════════════════════════════
               5.1 细分产品下钻子表 (f_hy_zcp)
               ══════════════════════════════════════════════════════════ */
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4 animate-in fade-in duration-150">
              {/* 顶栏卡片 */}
              <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-[12px] text-text-muted">
                    <button
                      type="button"
                      onClick={() => setDrilldownInternalProductId(null)}
                      className="hover:text-primary transition-colors flex items-center gap-0.5 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[14px]">arrow_back</span>
                      <span>返回产品大类</span>
                    </button>
                    <span>/</span>
                    <span className="text-text-main font-medium">{activeDrilldownInternalProduct.name}</span>
                    <span>/</span>
                    <span className="text-primary font-medium">细分产品列表</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-h2-header text-text-main font-bold">
                      {activeDrilldownInternalProduct.name} - 细分产品
                    </h1>
                    <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                      共 {currentInternalSubList.length} 个细分产品
                    </span>
                    {hasUnsavedChanges && (
                      <span className="text-[12px] text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        存在未保存更改
                      </span>
                    )}
                    {saveToast && (
                      <span
                        className={
                          'text-body-sm px-2.5 py-0.5 rounded-full border flex items-center gap-1 animate-in fade-in duration-200 ' +
                          (saveToast.type === 'warn'
                            ? 'text-error bg-red-50 border-red-200'
                            : saveToast.type === 'info'
                              ? 'text-primary bg-primary/10 border-primary/20'
                              : 'text-action-green bg-emerald-50 border-emerald-200')
                        }
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {saveToast.type === 'warn' ? 'error' : saveToast.type === 'info' ? 'info' : 'check_circle'}
                        </span>
                        {saveToast.text}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center flex-wrap gap-3">
                  <div className="flex items-center gap-1.5">
                    <div className="relative">
                      <span
                        className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
                        style={{ fontSize: '18px' }}
                      >
                        search
                      </span>
                      <input
                        type="text"
                        placeholder="搜索细分产品名称或ID…"
                        value={internalSubProductSearchDraft}
                        onChange={(e) => setInternalSubProductSearchDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleQueryInternalSubProducts()
                        }}
                        className="pl-9 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-48 transition-all"
                      />
                    </div>

                    <select
                      value={internalSubProductStatusDraft}
                      onChange={(e) => setInternalSubProductStatusDraft(e.target.value)}
                      className="px-2.5 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary transition-all cursor-pointer"
                    >
                      <option value="all">全部状态</option>
                      <option value="enabled">● 启用</option>
                      <option value="disabled">○ 禁用</option>
                    </select>

                    <button
                      type="button"
                      onClick={handleQueryInternalSubProducts}
                      className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">search</span>
                      查询
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleTriggerSave}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    title="保存所有修改"
                  >
                    <span className="material-symbols-outlined text-[18px]">save</span>
                    保存
                  </button>

                  <button
                    type="button"
                    onClick={handleDeleteSelectedInternalSubProducts}
                    disabled={selectedInternalSubProductIds.length === 0}
                    className={
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                      (selectedInternalSubProductIds.length > 0
                        ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                        : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                    }
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                    删除 {selectedInternalSubProductIds.length > 0 ? `(${selectedInternalSubProductIds.length})` : ''}
                  </button>

                  <button
                    type="button"
                    onClick={handleAddNewInternalSubProduct}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    新增细分产品
                  </button>
                </div>
              </div>

              {/* 表格卡片 */}
              <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
                <div className="flex-1 overflow-auto">
                  <table className="min-w-[900px] w-full text-left border-collapse">
                    <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                      <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                        <th className="py-3 px-3 w-12 min-w-[48px] text-center">
                          <input
                            type="checkbox"
                            checked={isAllInternalSubProductsSelected}
                            onChange={() => {
                              if (selectedInternalSubProductIds.length === filteredInternalSubProducts.length) {
                                setSelectedInternalSubProductIds([])
                              } else {
                                setSelectedInternalSubProductIds(filteredInternalSubProducts.map((s) => s.id))
                              }
                            }}
                            className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                          />
                        </th>
                        <th className="py-3 px-3 w-32 min-w-[120px] text-center">物理主键ID</th>
                        <th className="py-3 px-3 w-24 min-w-[90px] text-center">序号ID</th>
                        <th className="py-3 px-4 w-72 min-w-[220px]">细分产品名称</th>
                        <th className="py-3 px-3 w-32 min-w-[110px] text-center">参考单价(元)</th>
                        <th className="py-3 px-3 w-28 min-w-[100px] text-center">状态</th>
                        <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                        <th className="py-3 px-3 w-20 min-w-[70px] text-center">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle text-body-sm">
                      {filteredInternalSubProducts.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-16 text-center text-text-muted">
                            <div className="flex flex-col items-center justify-center gap-2">
                              <span className="material-symbols-outlined text-[36px] text-outline">search_off</span>
                              <span>未找到匹配的细分产品数据</span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filteredInternalSubProducts.map((sub, sIdx) => {
                          const originalSubIndex = (activeDrilldownInternalProduct.subProducts || []).findIndex(
                            (s) => s.id === sub.id
                          )
                          const isChecked = selectedInternalSubProductIds.includes(sub.id)

                          return (
                            <tr
                              key={sub.id + '_' + sIdx}
                              className={
                                'transition-colors ' +
                                (isChecked ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-surface-container-low/50')
                              }
                            >
                              <td className="py-2 px-3 text-center">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    setSelectedInternalSubProductIds((prev) =>
                                      prev.includes(sub.id)
                                        ? prev.filter((x) => x !== sub.id)
                                        : [...prev, sub.id]
                                    )
                                  }}
                                  className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                                />
                              </td>

                              <td className="py-2.5 px-3 text-center font-mono-data text-body-sm text-text-muted bg-surface-container-low/30 whitespace-nowrap">
                                {sub.id}
                              </td>

                              <td className="py-1.5 px-2 font-mono-data text-center whitespace-nowrap">
                                <input
                                  type="text"
                                  value={sub.xh}
                                  onChange={(e) =>
                                    handleInternalSubProductFieldChange(originalSubIndex, 'xh', e.target.value)
                                  }
                                  className="w-16 px-1.5 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-3 whitespace-nowrap">
                                <input
                                  type="text"
                                  value={sub.name}
                                  onChange={(e) =>
                                    handleInternalSubProductFieldChange(originalSubIndex, 'name', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1 text-body-sm font-medium text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <input
                                  type="number"
                                  value={sub.price}
                                  onChange={(e) =>
                                    handleInternalSubProductFieldChange(originalSubIndex, 'price', e.target.value)
                                  }
                                  className="w-24 px-2 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary mx-auto"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <select
                                  value={sub.status}
                                  onChange={(e) =>
                                    handleInternalSubProductFieldChange(
                                      originalSubIndex,
                                      'status',
                                      e.target.value as 'enabled' | 'disabled'
                                    )
                                  }
                                  className={
                                    'px-2.5 py-1 border rounded text-body-sm font-medium focus:outline-none transition-colors cursor-pointer whitespace-nowrap ' +
                                    (sub.status === 'enabled'
                                      ? 'border-border-subtle text-action-green bg-emerald-50/50 hover:border-action-green'
                                      : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                                  }
                                >
                                  <option value="enabled">启用</option>
                                  <option value="disabled">禁用</option>
                                </select>
                              </td>

                              <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                                {sub.updatedAt}
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSingleInternalSubProduct(sub.id, sub.name)}
                                  className="inline-flex items-center justify-center p-1 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                                  title="删除该细分产品"
                                >
                                  <span className="material-symbols-outlined text-[18px]">delete</span>
                                </button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            /* ══════════════════════════════════════════════════════════
               5.2 对内产品管理主表 (f_hy_cp)
               ══════════════════════════════════════════════════════════ */
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
              {/* 顶栏卡片 */}
              <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
                <div>
                  <div className="flex items-center gap-2 text-[12px] text-text-muted mb-1">
                    <span>字典维护</span>
                    <span>/</span>
                    <span>渠道管理</span>
                    <span>/</span>
                    <span className="text-text-main font-medium">对内产品管理</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-h2-header text-text-main font-bold">对内产品管理</h1>
                    <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                      共 {internalProductList.length} 个产品大类
                    </span>
                    {hasUnsavedChanges && (
                      <span className="text-[12px] text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                        存在未保存更改
                      </span>
                    )}
                    {saveToast && (
                      <span
                        className={
                          'text-body-sm px-2.5 py-0.5 rounded-full border flex items-center gap-1 animate-in fade-in duration-200 ' +
                          (saveToast.type === 'warn'
                            ? 'text-error bg-red-50 border-red-200'
                            : saveToast.type === 'info'
                              ? 'text-primary bg-primary/10 border-primary/20'
                              : 'text-action-green bg-emerald-50 border-emerald-200')
                        }
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {saveToast.type === 'warn' ? 'error' : saveToast.type === 'info' ? 'info' : 'check_circle'}
                        </span>
                        {saveToast.text}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center flex-wrap gap-3">
                  <div className="flex items-center gap-1.5">
                    <div className="relative">
                      <span
                        className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
                        style={{ fontSize: '18px' }}
                      >
                        search
                      </span>
                      <input
                        type="text"
                        placeholder="搜索产品大类名称或描述…"
                        value={internalProductSearchDraft}
                        onChange={(e) => setInternalProductSearchDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleQueryInternalProducts()
                        }}
                        className="pl-9 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-56 transition-all"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleQueryInternalProducts}
                      className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">search</span>
                      查询
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleTriggerSave}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                    title="保存所有修改"
                  >
                    <span className="material-symbols-outlined text-[18px]">save</span>
                    保存
                  </button>

                  <button
                    type="button"
                    onClick={handleDeleteSelectedInternalProducts}
                    disabled={selectedInternalProductIds.length === 0}
                    className={
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                      (selectedInternalProductIds.length > 0
                        ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                        : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                    }
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                    删除 {selectedInternalProductIds.length > 0 ? `(${selectedInternalProductIds.length})` : ''}
                  </button>

                  <button
                    type="button"
                    onClick={handleAddNewInternalProduct}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    新增产品大类
                  </button>
                </div>
              </div>

              {/* 表格卡片 */}
              <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
                <div className="flex-1 overflow-auto">
                  <table className="min-w-[950px] w-full text-left border-collapse">
                    <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                      <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                        <th className="py-3 px-3 w-12 min-w-[48px] text-center">
                          <input
                            type="checkbox"
                            checked={isAllInternalProductsSelected}
                            onChange={() => {
                              if (selectedInternalProductIds.length === filteredInternalProducts.length) {
                                setSelectedInternalProductIds([])
                              } else {
                                setSelectedInternalProductIds(filteredInternalProducts.map((p) => p.id))
                              }
                            }}
                            className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                          />
                        </th>
                        <th className="py-3 px-3 w-24 min-w-[90px] text-center">ID</th>
                        <th className="py-3 px-3 w-32 min-w-[120px] text-center">操作</th>
                        <th className="py-3 px-4 w-64 min-w-[200px]">产品大类名称</th>
                        <th className="py-3 px-4 w-72 min-w-[240px]">类别描述</th>
                        <th className="py-3 px-3 w-28 min-w-[100px] text-center">状态</th>
                        <th className="py-3 px-4 w-40 min-w-[140px] text-center">创建时间</th>
                        <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                        <th className="py-3 px-3 w-20 min-w-[70px] text-center">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle text-body-sm">
                      {filteredInternalProducts.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="py-16 text-center text-text-muted">
                            <div className="flex flex-col items-center justify-center gap-2">
                              <span className="material-symbols-outlined text-[36px] text-outline">search_off</span>
                              <span>未找到匹配的产品类别数据</span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        filteredInternalProducts.map((prod, pIdx) => {
                          const originalIndex = internalProductList.findIndex((p) => p.id === prod.id)
                          const isChecked = selectedInternalProductIds.includes(prod.id)

                          return (
                            <tr
                              key={prod.id + '_' + pIdx}
                              className={
                                'transition-colors ' +
                                (isChecked ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-surface-container-low/50')
                              }
                            >
                              <td className="py-2 px-3 text-center">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => {
                                    setSelectedInternalProductIds((prev) =>
                                      prev.includes(prod.id)
                                        ? prev.filter((x) => x !== prod.id)
                                        : [...prev, prod.id]
                                    )
                                  }}
                                  className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                                />
                              </td>

                              <td className="py-1.5 px-2 font-mono-data text-center whitespace-nowrap">
                                <input
                                  type="text"
                                  value={prod.id}
                                  onChange={(e) =>
                                    handleInternalProductFieldChange(originalIndex, 'id', e.target.value)
                                  }
                                  className="w-20 px-1.5 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDrilldownInternalProductId(prod.id)
                                    setInternalSubProductSearchDraft('')
                                    setInternalSubProductStatusDraft('all')
                                    setAppliedInternalSubProductSearch('')
                                    setAppliedInternalSubProductStatus('all')
                                    setSelectedInternalSubProductIds([])
                                  }}
                                  className="inline-flex items-center gap-0.5 px-2.5 py-1 rounded-md text-primary bg-primary/10 hover:bg-primary hover:text-white border border-primary/20 text-[13px] font-medium transition-all cursor-pointer group"
                                  title="查看下属细分产品"
                                >
                                  <span>细分产品</span>
                                  <span className="material-symbols-outlined text-[15px] transition-transform group-hover:translate-x-0.5">
                                    chevron_right
                                  </span>
                                </button>
                              </td>

                              <td className="py-1.5 px-3 whitespace-nowrap">
                                <input
                                  type="text"
                                  value={prod.name}
                                  onChange={(e) =>
                                    handleInternalProductFieldChange(originalIndex, 'name', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1 text-body-sm font-medium text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-3 whitespace-nowrap">
                                <input
                                  type="text"
                                  value={prod.desc}
                                  onChange={(e) =>
                                    handleInternalProductFieldChange(originalIndex, 'desc', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1 text-body-sm text-text-muted bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <select
                                  value={prod.status}
                                  onChange={(e) =>
                                    handleInternalProductFieldChange(
                                      originalIndex,
                                      'status',
                                      e.target.value as 'enabled' | 'disabled'
                                    )
                                  }
                                  className={
                                    'px-2.5 py-1 border rounded text-body-sm font-medium focus:outline-none transition-colors cursor-pointer whitespace-nowrap ' +
                                    (prod.status === 'enabled'
                                      ? 'border-border-subtle text-action-green bg-emerald-50/50 hover:border-action-green'
                                      : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                                  }
                                >
                                  <option value="enabled">启用</option>
                                  <option value="disabled">禁用</option>
                                </select>
                              </td>

                              <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                                {prod.createdAt}
                              </td>

                              <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                                {prod.updatedAt}
                              </td>

                              <td className="py-1.5 px-2 text-center whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSingleInternalProduct(prod.id, prod.name)}
                                  className="inline-flex items-center justify-center p-1 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                                  title="删除该产品大类"
                                >
                                  <span className="material-symbols-outlined text-[18px]">delete</span>
                                </button>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )
        ) : activeMenu === 'payment_channel' ? (
          /* ══════════════════════════════════════════════════════════
             6. 支付渠道管理主表 (zfqd)
             ══════════════════════════════════════════════════════════ */
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
            {/* 顶栏卡片 */}
            <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
              <div>
                <div className="flex items-center gap-2 text-[12px] text-text-muted mb-1">
                  <span>字典维护</span>
                  <span>/</span>
                  <span>渠道管理</span>
                  <span>/</span>
                  <span className="text-text-main font-medium">支付渠道管理</span>
                </div>
                <div className="flex items-center gap-3">
                  <h1 className="text-h2-header text-text-main font-bold">支付渠道管理</h1>
                  <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                    共 {paymentChannelList.length} 个支付渠道
                  </span>
                  {hasUnsavedChanges && (
                    <span className="text-[12px] text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                      存在未保存更改
                    </span>
                  )}
                  {saveToast && (
                    <span
                      className={
                        'text-body-sm px-2.5 py-0.5 rounded-full border flex items-center gap-1 animate-in fade-in duration-200 ' +
                        (saveToast.type === 'warn'
                          ? 'text-error bg-red-50 border-red-200'
                          : saveToast.type === 'info'
                            ? 'text-primary bg-primary/10 border-primary/20'
                            : 'text-action-green bg-emerald-50 border-emerald-200')
                      }
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {saveToast.type === 'warn' ? 'error' : saveToast.type === 'info' ? 'info' : 'check_circle'}
                      </span>
                      {saveToast.text}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center flex-wrap gap-3">
                <div className="flex items-center gap-1.5">
                  <div className="relative">
                    <span
                      className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
                      style={{ fontSize: '18px' }}
                    >
                      search
                    </span>
                    <input
                      type="text"
                      placeholder="搜索渠道名称、所属医院或备注…"
                      value={paymentChannelSearchDraft}
                      onChange={(e) => setPaymentChannelSearchDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleQueryPaymentChannels()
                      }}
                      className="pl-9 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-56 transition-all"
                    />
                  </div>

                  <select
                    value={paymentChannelStatusDraft}
                    onChange={(e) => setPaymentChannelStatusDraft(e.target.value)}
                    className="px-2.5 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary transition-all cursor-pointer"
                  >
                    <option value="all">全部状态</option>
                    <option value="enabled">● 启用</option>
                    <option value="disabled">○ 禁用</option>
                  </select>

                  <button
                    type="button"
                    onClick={handleQueryPaymentChannels}
                    className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[16px]">search</span>
                    查询
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleTriggerSave}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  title="保存所有修改"
                >
                  <span className="material-symbols-outlined text-[18px]">save</span>
                  保存
                </button>

                <button
                  type="button"
                  onClick={handleDeleteSelectedPaymentChannels}
                  disabled={selectedPaymentChannelIds.length === 0}
                  className={
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                    (selectedPaymentChannelIds.length > 0
                      ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                      : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                  }
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                  删除 {selectedPaymentChannelIds.length > 0 ? `(${selectedPaymentChannelIds.length})` : ''}
                </button>

                <button
                  type="button"
                  onClick={handleAddNewPaymentChannel}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]">add</span>
                  新增支付渠道
                </button>
              </div>
            </div>

            {/* 表格卡片 */}
            <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
              <div className="flex-1 overflow-auto">
                <table className="min-w-[1050px] w-full text-left border-collapse">
                  <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                    <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                      <th className="py-3 px-3 w-12 min-w-[48px] text-center">
                        <input
                          type="checkbox"
                          checked={isAllPaymentChannelsSelected}
                          onChange={() => {
                            if (selectedPaymentChannelIds.length === filteredPaymentChannels.length) {
                              setSelectedPaymentChannelIds([])
                            } else {
                              setSelectedPaymentChannelIds(filteredPaymentChannels.map((c) => c.id))
                            }
                          }}
                          className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                        />
                      </th>
                      <th className="py-3 px-3 w-24 min-w-[90px] text-center">ID</th>
                      <th className="py-3 px-4 w-72 min-w-[220px]">渠道名称</th>
                      <th className="py-3 px-4 w-64 min-w-[200px]">所属医院</th>
                      <th className="py-3 px-3 w-32 min-w-[110px] text-center">费率(%)</th>
                      <th className="py-3 px-3 w-32 min-w-[110px] text-center">费率类型</th>
                      <th className="py-3 px-3 w-28 min-w-[100px] text-center">状态</th>
                      <th className="py-3 px-4 w-64 min-w-[200px]">备注说明</th>
                      <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                      <th className="py-3 px-3 w-20 min-w-[70px] text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle text-body-sm">
                    {filteredPaymentChannels.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-16 text-center text-text-muted">
                          <div className="flex flex-col items-center justify-center gap-2">
                            <span className="material-symbols-outlined text-[36px] text-outline">search_off</span>
                            <span>未找到匹配的支付渠道数据</span>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredPaymentChannels.map((chan, cIdx) => {
                        const originalIndex = paymentChannelList.findIndex((c) => c.id === chan.id)
                        const isChecked = selectedPaymentChannelIds.includes(chan.id)

                        return (
                          <tr
                            key={chan.id + '_' + cIdx}
                            className={
                              'transition-colors ' +
                              (isChecked ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-surface-container-low/50')
                            }
                          >
                            <td className="py-2 px-3 text-center">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => {
                                  setSelectedPaymentChannelIds((prev) =>
                                    prev.includes(chan.id)
                                      ? prev.filter((x) => x !== chan.id)
                                      : [...prev, chan.id]
                                  )
                                }}
                                className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                              />
                            </td>

                            <td className="py-1.5 px-2 font-mono-data text-center whitespace-nowrap">
                              <input
                                type="text"
                                value={chan.id}
                                onChange={(e) =>
                                  handlePaymentChannelFieldChange(originalIndex, 'id', e.target.value)
                                }
                                className="w-20 px-1.5 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            <td className="py-1.5 px-3 whitespace-nowrap">
                              <input
                                type="text"
                                value={chan.name}
                                onChange={(e) =>
                                  handlePaymentChannelFieldChange(originalIndex, 'name', e.target.value)
                                }
                                className="w-full px-2.5 py-1 text-body-sm font-medium text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            <td className="py-1.5 px-3 whitespace-nowrap">
                              <input
                                type="text"
                                value={chan.hospital}
                                onChange={(e) =>
                                  handlePaymentChannelFieldChange(originalIndex, 'hospital', e.target.value)
                                }
                                className="w-full px-2.5 py-1 text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <input
                                type="number"
                                step="0.01"
                                value={chan.feeRate}
                                onChange={(e) =>
                                  handlePaymentChannelFieldChange(originalIndex, 'feeRate', e.target.value)
                                }
                                className="w-24 px-2 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary mx-auto"
                              />
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={chan.feeType}
                                onChange={(e) =>
                                  handlePaymentChannelFieldChange(originalIndex, 'feeType', e.target.value)
                                }
                                className="w-28 px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center mx-auto"
                              >
                                <option value="百分比">百分比</option>
                                <option value="固定金额">固定金额</option>
                              </select>
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={chan.status}
                                onChange={(e) =>
                                  handlePaymentChannelFieldChange(
                                    originalIndex,
                                    'status',
                                    e.target.value as 'enabled' | 'disabled'
                                  )
                                }
                                className={
                                  'px-2.5 py-1 border rounded text-body-sm font-medium focus:outline-none transition-colors cursor-pointer whitespace-nowrap ' +
                                  (chan.status === 'enabled'
                                    ? 'border-border-subtle text-action-green bg-emerald-50/50 hover:border-action-green'
                                    : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                                }
                              >
                                <option value="enabled">启用</option>
                                <option value="disabled">禁用</option>
                              </select>
                            </td>

                            <td className="py-1.5 px-3 whitespace-nowrap">
                              <input
                                type="text"
                                value={chan.remark}
                                onChange={(e) =>
                                  handlePaymentChannelFieldChange(originalIndex, 'remark', e.target.value)
                                }
                                className="w-full px-2.5 py-1 text-body-sm text-text-muted bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                              {chan.updatedAt}
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => handleDeleteSinglePaymentChannel(chan.id, chan.name)}
                                className="inline-flex items-center justify-center p-1 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                                title="删除该支付渠道"
                              >
                                <span className="material-symbols-outlined text-[18px]">delete</span>
                              </button>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : activeMenu === 'escort_manage' ? (
          /* ══════════════════════════════════════════════════════════
             7. 陪诊人管理主表 (f_hy_pzr)
             ══════════════════════════════════════════════════════════ */
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
            {/* 顶栏卡片 */}
            <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
              <div>
                <div className="flex items-center gap-2 text-[12px] text-text-muted mb-1">
                  <span>字典维护</span>
                  <span>/</span>
                  <span>其他</span>
                  <span>/</span>
                  <span className="text-text-main font-medium">陪诊人管理</span>
                </div>
                <div className="flex items-center gap-3">
                  <h1 className="text-h2-header text-text-main font-bold">陪诊人管理</h1>
                  <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                    共 {escortList.length} 位陪诊人员
                  </span>
                  {hasUnsavedChanges && (
                    <span className="text-[12px] text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200 flex items-center gap-1 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                      存在未保存更改
                    </span>
                  )}
                  {saveToast && (
                    <span
                      className={
                        'text-body-sm px-2.5 py-0.5 rounded-full border flex items-center gap-1 animate-in fade-in duration-200 ' +
                        (saveToast.type === 'warn'
                          ? 'text-error bg-red-50 border-red-200'
                          : saveToast.type === 'info'
                            ? 'text-primary bg-primary/10 border-primary/20'
                            : 'text-action-green bg-emerald-50 border-emerald-200')
                      }
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {saveToast.type === 'warn' ? 'error' : saveToast.type === 'info' ? 'info' : 'check_circle'}
                      </span>
                      {saveToast.text}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center flex-wrap gap-3">
                <div className="flex items-center gap-1.5">
                  <div className="relative">
                    <span
                      className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
                      style={{ fontSize: '18px' }}
                    >
                      search
                    </span>
                    <input
                      type="text"
                      placeholder="搜索姓名、手机或备注…"
                      value={escortSearchDraft}
                      onChange={(e) => setEscortSearchDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleQueryEscorts()
                      }}
                      className="pl-9 pr-3 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:bg-white focus:ring-1 focus:ring-primary w-52 transition-all"
                    />
                  </div>

                  <select
                    value={escortTypeDraft}
                    onChange={(e) => setEscortTypeDraft(e.target.value)}
                    className="px-2.5 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary transition-all cursor-pointer"
                  >
                    <option value="all">全部类型</option>
                    <option value="自营">自营</option>
                    <option value="兼职">兼职</option>
                    <option value="合作">合作</option>
                    <option value="外包">外包</option>
                  </select>

                  <select
                    value={escortStatusDraft}
                    onChange={(e) => setEscortStatusDraft(e.target.value)}
                    className="px-2.5 py-1.5 bg-surface-bg border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary transition-all cursor-pointer"
                  >
                    <option value="all">全部状态</option>
                    <option value="enabled">● 启用</option>
                    <option value="disabled">○ 禁用</option>
                  </select>

                  <button
                    type="button"
                    onClick={handleQueryEscorts}
                    className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[16px]">search</span>
                    查询
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleTriggerSave}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                  title="保存所有修改"
                >
                  <span className="material-symbols-outlined text-[18px]">save</span>
                  保存
                </button>

                <button
                  type="button"
                  onClick={handleDeleteSelectedEscorts}
                  disabled={selectedEscortIds.length === 0}
                  className={
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                    (selectedEscortIds.length > 0
                      ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                      : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                  }
                >
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                  删除 {selectedEscortIds.length > 0 ? `(${selectedEscortIds.length})` : ''}
                </button>

                <button
                  type="button"
                  onClick={handleAddNewEscort}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]">add</span>
                  新增陪诊人
                </button>
              </div>
            </div>

            {/* 表格卡片 */}
            <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
              <div className="flex-1 overflow-auto">
                <table className="min-w-[1250px] w-full text-left border-collapse">
                  <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                    <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                      <th className="py-3 px-3 w-12 min-w-[48px] text-center">
                        <input
                          type="checkbox"
                          checked={isAllEscortsSelected}
                          onChange={() => {
                            if (selectedEscortIds.length === filteredEscorts.length) {
                              setSelectedEscortIds([])
                            } else {
                              setSelectedEscortIds(filteredEscorts.map((e) => e.id))
                            }
                          }}
                          className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                        />
                      </th>
                      <th className="py-3 px-3 w-20 min-w-[80px] text-center">ID</th>
                      <th className="py-3 px-4 w-40 min-w-[130px]">姓名</th>
                      <th className="py-3 px-3 w-24 min-w-[80px] text-center">性别</th>
                      <th className="py-3 px-4 w-44 min-w-[140px]">联系电话</th>
                      <th className="py-3 px-3 w-32 min-w-[110px] text-center">省份</th>
                      <th className="py-3 px-3 w-32 min-w-[110px] text-center">城市</th>
                      <th className="py-3 px-3 w-28 min-w-[100px] text-center">人员类型</th>
                      <th className="py-3 px-3 w-28 min-w-[100px] text-center">状态</th>
                      <th className="py-3 px-4 w-64 min-w-[200px]">备注</th>
                      <th className="py-3 px-4 w-40 min-w-[140px] text-center">创建时间</th>
                      <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                      <th className="py-3 px-3 w-20 min-w-[70px] text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle text-body-sm">
                    {filteredEscorts.length === 0 ? (
                      <tr>
                        <td colSpan={13} className="py-16 text-center text-text-muted">
                          <div className="flex flex-col items-center justify-center gap-2">
                            <span className="material-symbols-outlined text-[36px] text-outline">search_off</span>
                            <span>未找到匹配的陪诊人员数据</span>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredEscorts.map((escort, eIdx) => {
                        const originalIndex = escortList.findIndex((e) => e.id === escort.id)
                        const isChecked = selectedEscortIds.includes(escort.id)

                        return (
                          <tr
                            key={escort.id + '_' + eIdx}
                            className={
                              'transition-colors ' +
                              (isChecked ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-surface-container-low/50')
                            }
                          >
                            <td className="py-2 px-3 text-center">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => {
                                  setSelectedEscortIds((prev) =>
                                    prev.includes(escort.id)
                                      ? prev.filter((x) => x !== escort.id)
                                      : [...prev, escort.id]
                                  )
                                }}
                                className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                              />
                            </td>

                            <td className="py-1.5 px-2 font-mono-data text-center whitespace-nowrap">
                              <input
                                type="text"
                                value={escort.id}
                                onChange={(e) =>
                                  handleEscortFieldChange(originalIndex, 'id', e.target.value)
                                }
                                className="w-20 px-1.5 py-1 text-center font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            <td className="py-1.5 px-3 whitespace-nowrap">
                              <input
                                type="text"
                                value={escort.name}
                                onChange={(e) =>
                                  handleEscortFieldChange(originalIndex, 'name', e.target.value)
                                }
                                className="w-full px-2.5 py-1 text-body-sm font-medium text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={escort.gender}
                                onChange={(e) =>
                                  handleEscortFieldChange(
                                    originalIndex,
                                    'gender',
                                    e.target.value as '男' | '女'
                                  )
                                }
                                className="w-20 px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center mx-auto"
                              >
                                <option value="男">男</option>
                                <option value="女">女</option>
                              </select>
                            </td>

                            <td className="py-1.5 px-3 whitespace-nowrap">
                              <input
                                type="text"
                                value={escort.phone}
                                onChange={(e) =>
                                  handleEscortFieldChange(originalIndex, 'phone', e.target.value)
                                }
                                className="w-full px-2.5 py-1 font-mono-data text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <input
                                type="text"
                                value={escort.provinceCode}
                                onChange={(e) =>
                                  handleEscortFieldChange(originalIndex, 'provinceCode', e.target.value)
                                }
                                className="w-28 px-2 py-1 text-center text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary mx-auto"
                              />
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <input
                                type="text"
                                value={escort.cityCode}
                                onChange={(e) =>
                                  handleEscortFieldChange(originalIndex, 'cityCode', e.target.value)
                                }
                                className="w-28 px-2 py-1 text-center text-body-sm text-text-main bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary mx-auto"
                              />
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={escort.type}
                                onChange={(e) =>
                                  handleEscortFieldChange(originalIndex, 'type', e.target.value)
                                }
                                className="w-24 px-2 py-1 border border-border-subtle rounded text-body-sm bg-surface-bg hover:bg-white focus:bg-white focus:border-primary transition-colors cursor-pointer text-center mx-auto"
                              >
                                <option value="自营">自营</option>
                                <option value="兼职">兼职</option>
                                <option value="合作">合作</option>
                                <option value="外包">外包</option>
                              </select>
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <select
                                value={escort.status}
                                onChange={(e) =>
                                  handleEscortFieldChange(
                                    originalIndex,
                                    'status',
                                    e.target.value as 'enabled' | 'disabled'
                                  )
                                }
                                className={
                                  'px-2.5 py-1 border rounded text-body-sm font-medium focus:outline-none transition-colors cursor-pointer whitespace-nowrap ' +
                                  (escort.status === 'enabled'
                                    ? 'border-border-subtle text-action-green bg-emerald-50/50 hover:border-action-green'
                                    : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                                }
                              >
                                <option value="enabled">启用</option>
                                <option value="disabled">禁用</option>
                              </select>
                            </td>

                            <td className="py-1.5 px-3 whitespace-nowrap">
                              <input
                                type="text"
                                value={escort.remark}
                                onChange={(e) =>
                                  handleEscortFieldChange(originalIndex, 'remark', e.target.value)
                                }
                                className="w-full px-2.5 py-1 text-body-sm text-text-muted bg-transparent hover:bg-surface-container-low/60 focus:bg-white border border-transparent hover:border-border-subtle focus:border-primary rounded transition-all focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                            </td>

                            <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                              {escort.createdAt}
                            </td>

                            <td className="py-2.5 px-4 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                              {escort.updatedAt}
                            </td>

                            <td className="py-1.5 px-2 text-center whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => handleDeleteSingleEscort(escort.id, escort.name)}
                                className="inline-flex items-center justify-center p-1 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                                title="删除该陪诊人"
                              >
                                <span className="material-symbols-outlined text-[18px]">delete</span>
                              </button>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

        ) : (
          /* ─── 其他字典项占位页 ─── */
          <div className="flex-1 min-h-0 p-8 overflow-y-auto">
            <div className="max-w-3xl bg-white rounded-xl border border-border-subtle shadow-xs p-8 space-y-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                  <span className="material-symbols-outlined text-[28px]">
                    {currentActiveItem?.icon || 'dataset'}
                  </span>
                </div>
                <div>
                  <div className="flex items-center gap-2 text-[12px] text-text-muted mb-0.5">
                    <span>字典维护</span>
                    <span>/</span>
                    <span>{currentActiveGroup?.title}</span>
                  </div>
                  <h1 className="text-h2-header text-text-main font-bold">
                    {currentActiveItem?.label}
                  </h1>
                </div>
              </div>

              <div className="p-5 rounded-xl bg-surface-bg border border-border-subtle space-y-3">
                <div className="flex items-center gap-2 text-primary font-semibold text-body-md">
                  <span className="material-symbols-outlined text-[20px]">info</span>
                  <span>页面结构已就绪</span>
                </div>
                <p className="text-body-sm text-text-muted leading-relaxed">
                  当前处于字典视图预览状态，后续将根据业务配置需求接入“{currentActiveItem?.label}”的数据接口、增删改查以及关联业务字段配置。
                </p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
