import type { PrismaClient } from '@prisma/client'

/**
 * 寰宇订单相关的业务表不属于当前采集模型，但后端需要保证它们在启动时存在，
 * 这样部署到已有数据库或全新数据库时都可以直接使用。
 *
 * 字段定义来源：`(对应数据库表)表格视图.xlsx`。
 */
const CREATE_STATEMENTS = [
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
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS "fact_hy_pzrxx" (
      "DDBH" VARCHAR(50),
      "PZR" VARCHAR(100),
      "BBQ_FW" VARCHAR(50),
      "ZJ" VARCHAR(100) NOT NULL,
      "xtsj" VARCHAR(50),
      CONSTRAINT "fact_hy_pzrxx_ZJ_key" UNIQUE ("ZJ")
    )
  `,
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
    )
  `
]

export async function ensureHuanyuTables(prisma: PrismaClient): Promise<void> {
  for (const statement of CREATE_STATEMENTS) {
    await prisma.$executeRawUnsafe(statement)
  }
}
