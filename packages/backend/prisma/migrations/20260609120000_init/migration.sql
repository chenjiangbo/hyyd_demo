-- CreateTable
CREATE TABLE "employees" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "wechat_id" TEXT,
    "taikang_account" TEXT,
    "token" TEXT NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "source_order_no" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_phone" TEXT,
    "hospital" TEXT,
    "dept" TEXT,
    "doctor" TEXT,
    "status" TEXT NOT NULL DEFAULT '候选',
    "assigned_employee_id" INTEGER,
    "raw_json" JSONB,
    "detail_json" JSONB,
    "detail_fetched_at" TIMESTAMP(3),
    "detail_fingerprint" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_attachments" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "file_type" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "minio_bucket" TEXT NOT NULL,
    "minio_key" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "raw_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "text_content" TEXT,
    "minio_bucket" TEXT,
    "minio_key" TEXT,
    "mime_type" TEXT,
    "byte_size" INTEGER,
    "client_uuid" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER,
    "channel" TEXT NOT NULL,
    "conversation_name" TEXT NOT NULL,
    "sender_name" TEXT,
    "content_text" TEXT NOT NULL,
    "screenshot_oss_key" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "employee_id" INTEGER NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER,
    "employee_id" INTEGER NOT NULL,
    "phone" TEXT NOT NULL,
    "contact_name" TEXT,
    "direction" TEXT NOT NULL,
    "call_status" TEXT NOT NULL DEFAULT 'answered',
    "duration_sec" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "recording_oss_key" TEXT,
    "asr_text" TEXT,
    "asr_status" TEXT NOT NULL DEFAULT 'no_recording',
    "dashscope_task_id" TEXT,
    "asr_result_json" JSONB,
    "asr_finished_at" TIMESTAMP(3),

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commands" (
    "id" SERIAL NOT NULL,
    "target" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMP(3),

    CONSTRAINT "commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_summaries" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "call_id" INTEGER,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_token_key" ON "employees"("token");

-- CreateIndex
CREATE UNIQUE INDEX "orders_source_source_order_no_key" ON "orders"("source", "source_order_no");

-- CreateIndex
CREATE INDEX "order_attachments_order_id_idx" ON "order_attachments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_attachments_order_id_file_id_key" ON "order_attachments"("order_id", "file_id");

-- CreateIndex
CREATE INDEX "materials_order_id_idx" ON "materials"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "materials_order_id_client_uuid_key" ON "materials"("order_id", "client_uuid");

-- CreateIndex
CREATE INDEX "ai_summaries_call_id_idx" ON "ai_summaries"("call_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_employee_id_fkey" FOREIGN KEY ("assigned_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_attachments" ADD CONSTRAINT "order_attachments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

