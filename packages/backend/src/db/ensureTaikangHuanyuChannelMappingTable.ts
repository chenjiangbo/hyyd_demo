import type { PrismaClient } from '@prisma/client'

/**
 * 泰康业务与寰宇 B 端渠道的运营配置。
 *
 * 业务标识是稳定的程序键；渠道 ID 来自远端 MySQL 的 dim_hy_qd 维表。
 * 不保存自由输入的渠道名称作为匹配依据，避免名称调整后误匹配。
 */
export async function ensureTaikangHuanyuChannelMappingTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS taikang_huanyu_channel_mappings (
      id BIGSERIAL PRIMARY KEY,
      business_key VARCHAR(40) NOT NULL UNIQUE
        CHECK (business_key IN ('green_pass', 'register_assist')),
      business_name VARCHAR(100) NOT NULL,
      huanyu_channel_id VARCHAR(40),
      huanyu_channel_name VARCHAR(200),
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  // 两个业务类型固定存在；渠道需由管理员从远端 dim_hy_qd 中选择后保存。
  await prisma.$executeRawUnsafe(`
    INSERT INTO taikang_huanyu_channel_mappings (business_key, business_name, enabled)
    VALUES
      ('green_pass', '泰康绿通', true),
      ('register_assist', '泰康挂号协助', true)
    ON CONFLICT (business_key) DO UPDATE
      SET business_name = EXCLUDED.business_name,
          updated_at = now();
  `)
}
