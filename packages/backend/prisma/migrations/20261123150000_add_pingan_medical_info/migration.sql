ALTER TABLE "pingan_orders"
  ADD COLUMN "medical_info" JSONB,
  ADD COLUMN "medical_fingerprint" TEXT,
  ADD COLUMN "medical_state" VARCHAR(16),
  ADD COLUMN "medical_next_attempt_at" TIMESTAMP(3) WITHOUT TIME ZONE,
  ADD CONSTRAINT "pingan_orders_medical_state_check" CHECK ("medical_state" IN ('pending', 'completed'));
