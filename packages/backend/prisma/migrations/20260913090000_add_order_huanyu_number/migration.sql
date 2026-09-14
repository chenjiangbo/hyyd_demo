-- 订单与寰宇订单主表建立稳定、一对一的关联；PostgreSQL 的唯一索引允许多个 NULL。
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "huanyu_order_no" VARCHAR(20);

CREATE UNIQUE INDEX IF NOT EXISTS "orders_huanyu_order_no_key"
  ON "orders"("huanyu_order_no");
