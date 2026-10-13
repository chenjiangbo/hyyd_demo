ALTER TABLE "orders"
  ADD COLUMN "source_category" TEXT,
  ADD COLUMN "pool_entered_at" TIMESTAMP(3);

-- Classify existing orders with the same pool-type rules used by ingestion.
UPDATE "orders"
SET "source_category" = CASE
  WHEN "source" = 'taikang' AND COALESCE(
    "raw_json"->>'poolType',
    "raw_json"#>>'{taikangRawJson,poolType}',
    "raw_json"#>>'{rawJson,poolType}'
  ) = 'register' THEN 'taikang_register'
  WHEN "source" = 'taikang' THEN 'taikang_green'
  WHEN "source" = 'huanyu'
    OR "source_order_no" LIKE 'HYYD%'
    OR "source_order_no" LIKE 'SELF:%' THEN 'huanyu_self'
  ELSE "source"
END;

-- Taikang's list column 入池时间 is applyDate. Values without an explicit
-- timezone are China Standard Time; store the equivalent UTC instant.
WITH taikang_pool_times AS (
  SELECT
    id,
    COALESCE(
      NULLIF(BTRIM("raw_json"->>'applyDate'), ''),
      NULLIF(BTRIM("raw_json"#>>'{taikangRawJson,applyDate}'), ''),
      NULLIF(BTRIM("raw_json"#>>'{rawJson,applyDate}'), '')
    ) AS local_pool_time
  FROM "orders"
  WHERE "source" = 'taikang'
)
UPDATE "orders" AS o
SET "pool_entered_at" = CASE
  WHEN t.local_pool_time ~ '^[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}'
    AND t.local_pool_time ~ '([Zz]|[+-][0-9]{2}:?[0-9]{2})$'
  THEN replace(t.local_pool_time, '/', '-')::timestamptz AT TIME ZONE 'UTC'
  WHEN t.local_pool_time ~ '^[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}'
  THEN (replace(t.local_pool_time, '/', '-')::timestamp AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC'
  ELSE NULL
END
FROM taikang_pool_times AS t
WHERE o.id = t.id;

CREATE INDEX "orders_workbench_source_pool_time_id_idx"
  ON "orders" ("source_category", (COALESCE("pool_entered_at", "created_at")) DESC, "id" DESC);

CREATE INDEX "orders_workbench_pool_time_id_idx"
  ON "orders" ((COALESCE("pool_entered_at", "created_at")) DESC, "id" DESC);
