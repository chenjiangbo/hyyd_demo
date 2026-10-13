-- 字段提取提示词版本已超过原 40 字符上限；创建分析运行记录前即会被 PostgreSQL 拒绝。
-- IF EXISTS 兼容首次初始化：该表由应用启动时的 ensureBOrderFormTables 创建。
ALTER TABLE IF EXISTS b_order_ai_analysis_runs
  ALTER COLUMN prompt_version TYPE VARCHAR(100);
