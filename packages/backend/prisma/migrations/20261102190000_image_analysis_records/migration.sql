CREATE TABLE "pet_image_analysis_records" (
  "id" SERIAL PRIMARY KEY,
  "employee_id" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "image_analysis" JSONB,
  "registration_match" JSONB,
  "error" TEXT,
  "order_id" INTEGER,
  "created_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "pet_image_analysis_records_created_idx" ON "pet_image_analysis_records" ("created_at" DESC, "id" DESC);
