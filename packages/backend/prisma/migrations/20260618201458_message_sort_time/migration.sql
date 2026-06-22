-- DropIndex
DROP INDEX "messages_order_id_captured_at_idx";

-- DropIndex
DROP INDEX "messages_order_id_chat_time_idx";

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "sort_time" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "messages_order_id_sort_time_idx" ON "messages"("order_id", "sort_time");

-- 回填历史行：sort_time = chat_time 优先，否则 captured_at
UPDATE "messages" SET "sort_time" = COALESCE("chat_time", "captured_at") WHERE "sort_time" IS NULL;
