ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "taikang_intention" JSONB;
DROP TABLE IF EXISTS "taikang_special_price_intents";
