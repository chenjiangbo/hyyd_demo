ALTER TABLE "employees"
  ADD COLUMN "pingan_id" TEXT;

CREATE UNIQUE INDEX "employees_pingan_id_key"
  ON "employees"("pingan_id");
