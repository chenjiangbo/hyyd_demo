-- 字段/服务步骤分析不再复用旧“AI 简报”的水位。
ALTER TABLE "orders"
  ADD COLUMN "field_ai_last_msg_id" INTEGER,
  ADD COLUMN "field_ai_last_call_id" INTEGER,
  ADD COLUMN "field_ai_last_material_id" INTEGER;

-- 上线时继承旧链路已处理的边界，避免对全部历史沟通重新调用模型。
UPDATE "orders"
SET
  "field_ai_last_msg_id" = "brief_last_msg_id",
  "field_ai_last_call_id" = "brief_last_call_id",
  "field_ai_last_material_id" = "brief_last_material_id";
