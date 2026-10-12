CREATE INDEX IF NOT EXISTS "orders_employee_created_id_idx"
  ON "orders" ("assigned_employee_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "hy_fact_bdqd_ddbh_idx"
  ON "HY_FACT_DDCX_NEW" ("BDQD_DDBH");
