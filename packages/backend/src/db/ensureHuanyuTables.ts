import type { PrismaClient } from '@prisma/client'

/**
 * 寰宇订单与基础字典维护表在启动时自动检测与创建（幂等）。
 */
const CREATE_STATEMENTS = [
  // 1. 科室维护表 f_hy_kswh
  `
    CREATE TABLE IF NOT EXISTS f_hy_kswh (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100),
      ms VARCHAR(200),
      state VARCHAR(50) DEFAULT '启用',
      c_date VARCHAR(50),
      u_date VARCHAR(50)
    );
  `,
  // 2. 细分科室表 f_hy_xfks
  `
    CREATE TABLE IF NOT EXISTS f_hy_xfks (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100),
      state VARCHAR(50) DEFAULT '启用',
      u_date VARCHAR(50),
      name_yjks VARCHAR(50),
      xh VARCHAR(50)
    );
  `,
  // 3. 医院维护表 f_hy_yywh
  `
    CREATE TABLE IF NOT EXISTS f_hy_yywh (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200),
      level VARCHAR(100),
      bq VARCHAR(200),
      dq VARCHAR(100),
      dz VARCHAR(200),
      tips VARCHAR(500),
      bz VARCHAR(500),
      state VARCHAR(50) DEFAULT '启用',
      dz1 VARCHAR(200),
      dz2 VARCHAR(200),
      dq_sf VARCHAR(50),
      dq_cs VARCHAR(50),
      dz3 VARCHAR(200),
      u_date VARCHAR(50)
    );
  `,
  // 4. 医院科室子表 f_hy_yy_ks
  `
    CREATE TABLE IF NOT EXISTS f_hy_yy_ks (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(200),
      ksdl VARCHAR(100),
      ksxf VARCHAR(100),
      state VARCHAR(50) DEFAULT '启用',
      u_date VARCHAR(50),
      id_yy VARCHAR(50),
      xh VARCHAR(50)
    );
  `,
  // 5. 医生档案表 f_hy_ys
  `
    CREATE TABLE IF NOT EXISTS f_hy_ys (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100),
      sex VARCHAR(50),
      tel VARCHAR(200),
      em VARCHAR(100),
      dq_sf VARCHAR(50),
      dq_cs VARCHAR(50),
      yy VARCHAR(100),
      dwks VARCHAR(100),
      zc VARCHAR(50),
      jxzc VARCHAR(50),
      yyxzzw VARCHAR(100),
      shrz VARCHAR(100),
      sc VARCHAR(500),
      bz VARCHAR(500),
      state VARCHAR(50) DEFAULT '启用',
      csrq VARCHAR(50),
      c_date VARCHAR(50),
      u_date VARCHAR(50)
    );
  `,
  // 6. 渠道主表 f_hy_qd
  `
    CREATE TABLE IF NOT EXISTS f_hy_qd (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100),
      state VARCHAR(50) DEFAULT '启用',
      c_date VARCHAR(50),
      u_date VARCHAR(50)
    );
  `,
  // 7. 渠道产品表 f_hy_cp_qd
  `
    CREATE TABLE IF NOT EXISTS f_hy_cp_qd (
      id VARCHAR(100) PRIMARY KEY,
      xh VARCHAR(50),
      name VARCHAR(100),
      cpjg NUMERIC(18, 2),
      nbyjcp VARCHAR(100),
      nbejcp VARCHAR(100),
      state VARCHAR(50) DEFAULT '启用',
      id_yj VARCHAR(50),
      u_date VARCHAR(50)
    );
  `,
  // 8. 对内产品表 f_hy_cp
  `
    CREATE TABLE IF NOT EXISTS f_hy_cp (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100),
      ms VARCHAR(200),
      lx VARCHAR(50),
      state VARCHAR(50) DEFAULT '启用',
      c_date VARCHAR(50),
      u_date VARCHAR(50)
    );
  `,
  // 9. 对内子产品表 f_hy_zcp
  `
    CREATE TABLE IF NOT EXISTS f_hy_zcp (
      id VARCHAR(100) PRIMARY KEY,
      xh VARCHAR(50),
      name VARCHAR(100),
      state VARCHAR(50) DEFAULT '启用',
      u_date VARCHAR(50),
      id_yj VARCHAR(50)
    );
  `,
  // 10. 支付渠道表 zfqd
  `
    CREATE TABLE IF NOT EXISTS zfqd (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100),
      yy VARCHAR(50),
      start VARCHAR(50) DEFAULT '启用',
      u_date VARCHAR(50),
      zf_id VARCHAR(50),
      by1 VARCHAR(50),
      by2 VARCHAR(50)
    );
  `,
  // 11. 陪诊人员表 f_hy_pzr
  `
    CREATE TABLE IF NOT EXISTS f_hy_pzr (
      id VARCHAR(50) PRIMARY KEY,
      name VARCHAR(100),
      xb VARCHAR(50),
      sj VARCHAR(100),
      sf VARCHAR(50),
      cs VARCHAR(50),
      bz VARCHAR(500),
      state VARCHAR(50) DEFAULT '启用',
      c_date VARCHAR(50),
      u_date VARCHAR(50),
      pzrlx VARCHAR(50)
    );
  `,
  // 12. 城市列表维度表 dim_cslb
  `
    CREATE TABLE IF NOT EXISTS dim_cslb (
      s_id VARCHAR(20),
      s_name VARCHAR(50),
      x_id VARCHAR(20) PRIMARY KEY,
      x_name VARCHAR(50)
    );
  `,
  // 13. 医院等级维度表 dim_yydjb486
  `
    CREATE TABLE IF NOT EXISTS dim_yydjb486 (
      id VARCHAR(100) PRIMARY KEY,
      name VARCHAR(100)
    );
  `,
  // 14. 寰宇订单主表 HY_FACT_DDCX_NEW
  `
    CREATE TABLE IF NOT EXISTS "HY_FACT_DDCX_NEW" (
      "DDBH" VARCHAR(50) NOT NULL,
      "DD_state" VARCHAR(20),
      "BDQD" VARCHAR(100),
      "BDQD_DDBH" VARCHAR(50),
      "BDQD_DDBH2" VARCHAR(50),
      "BDQD_XF" VARCHAR(100),
      "BDQD_DJR" VARCHAR(50),
      "BDQD_DJR2" VARCHAR(50),
      "BDQD_FWXM" VARCHAR(50),
      "DDJE" DECIMAL(18, 2),
      "KHJL" VARCHAR(50),
      "JZR_XM" VARCHAR(50),
      "JZR_ZJLX" VARCHAR(50),
      "JZR_ZJHM" VARCHAR(50),
      "JZR_XB" VARCHAR(20),
      "JZR_NL" DECIMAL(18, 0),
      "JZR_LXDH" VARCHAR(18),
      "JZR_JSMC" VARCHAR(50),
      "JZR_JSGX" VARCHAR(50),
      "JZR_JSLXFS" VARCHAR(18),
      "JZR_JB" VARCHAR(100),
      "JZR_BZ" VARCHAR(2000),
      "H_NAME" VARCHAR(100),
      "H_ADDRESS" VARCHAR(500),
      "H_KS" VARCHAR(50),
      "H_YS" VARCHAR(50),
      "DDFWBZ" VARCHAR(2000),
      "BBQ_XQ" VARCHAR(20),
      "DATE_XQ" VARCHAR(20),
      "BBQ_YD" VARCHAR(20),
      "DATE_YD" VARCHAR(20),
      "BBQ_QDFW" VARCHAR(20),
      "DATE_QDFW" VARCHAR(20),
      "BBQ_FK" VARCHAR(20),
      "DATE_FK" VARCHAR(20),
      "BBQ_FW" VARCHAR(20),
      "DATE_FW" VARCHAR(20),
      "PZR" VARCHAR(50),
      "PZXJ" VARCHAR(2000),
      "KPBH" VARCHAR(50),
      "HKBH" VARCHAR(50),
      "BDYH" VARCHAR(50),
      "YYQDLX" VARCHAR(50),
      "SLR" VARCHAR(50),
      "xtsj_" VARCHAR(100),
      "expectedProvince" VARCHAR(50),
      "expectedCity" VARCHAR(50),
      "expectedHospital" VARCHAR(255),
      "expectedDepartment" VARCHAR(255),
      "medicare" VARCHAR(2),
      "registerPayStatus" VARCHAR(2),
      "lastQueuingTime" VARCHAR(20),
      "messageUrl" VARCHAR(100),
      "registerAmount" DECIMAL(18, 2),
      "advanceRegisterAmount" DECIMAL(18, 2),
      "isAdvancePay" VARCHAR(2),
      "refundCustAmount" DECIMAL(18, 2),
      "medicareType" VARCHAR(2),
      "isTaiKang" VARCHAR(2),
      "aliPayTradeNo" VARCHAR(30),
      "expert_level" VARCHAR(50),
      CONSTRAINT "HY_FACT_DDCX_NEW_DDBH_key" UNIQUE ("DDBH")
    );
  `,
  // 15. 陪诊人员明细关联表 fact_hy_pzrxx
  `
    CREATE TABLE IF NOT EXISTS "fact_hy_pzrxx" (
      "DDBH" VARCHAR(50),
      "PZR" VARCHAR(100),
      "BBQ_FW" VARCHAR(50),
      "ZJ" VARCHAR(100) NOT NULL,
      "xtsj" VARCHAR(50),
      CONSTRAINT "fact_hy_pzrxx_ZJ_key" UNIQUE ("ZJ")
    );
  `,
  // 16. 订单附件表 hy_d_tp
  `
    CREATE TABLE IF NOT EXISTS "hy_d_tp" (
      "DDBH" VARCHAR(100),
      "TP_A" BYTEA,
      "TP_B" BYTEA,
      "TP_C" BYTEA,
      "TP_D" BYTEA,
      "TP_E" BYTEA,
      "TP_F" BYTEA,
      "TP_G" BYTEA,
      "TP_H" BYTEA,
      "TP_I" BYTEA,
      "TP_J" BYTEA,
      "FIELD12_" VARCHAR(100),
      "FIELD13_" VARCHAR(100),
      "FIELD14_" VARCHAR(100),
      "FIELD15_" VARCHAR(100),
      "FIELD16_" VARCHAR(100),
      "FIELD17_" VARCHAR(100),
      "FIELD18_" VARCHAR(100),
      "FIELD19_" VARCHAR(100),
      "FIELD20_" VARCHAR(100),
      CONSTRAINT "hy_d_tp_DDBH_key" UNIQUE ("DDBH")
    );
  `
]

export async function ensureHuanyuTables(prisma: PrismaClient): Promise<void> {
  for (const statement of CREATE_STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(statement)
    } catch {
      // 忽略已存在提示
    }
  }
}

