-- 业务时间统一存为北京时间的无时区 timestamp。
-- 历史记录只用于测试；转换时保留原先在上海时区看到的墙上时间。
-- Prisma 自己的迁移记录表不是业务表，保持其原有字段类型。
DO $$
DECLARE
  time_column RECORD;
BEGIN
  FOR time_column IN
    SELECT table_name, column_name, COALESCE(datetime_precision, 6) AS precision
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND udt_name = 'timestamptz'
      AND table_name <> '_prisma_migrations'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I TYPE TIMESTAMP(%s) WITHOUT TIME ZONE USING %I AT TIME ZONE %L',
      time_column.table_name,
      time_column.column_name,
      time_column.precision,
      time_column.column_name,
      'Asia/Shanghai'
    );
  END LOOP;
END $$;
