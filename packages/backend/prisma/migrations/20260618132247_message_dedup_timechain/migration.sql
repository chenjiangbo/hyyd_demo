-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "chat_time" TIMESTAMP(3),
ADD COLUMN     "content_hash" TEXT,
ADD COLUMN     "dedupe_key" TEXT,
ADD COLUMN     "first_seen_at" TIMESTAMP(3),
ADD COLUMN     "kind" TEXT,
ADD COLUMN     "last_seen_at" TIMESTAMP(3),
ADD COLUMN     "seen_count" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sender_type" TEXT NOT NULL DEFAULT 'other';

-- CreateIndex
CREATE UNIQUE INDEX "messages_dedupe_key_key" ON "messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "messages_order_id_chat_time_idx" ON "messages"("order_id", "chat_time");

-- CreateIndex
CREATE INDEX "messages_order_id_captured_at_idx" ON "messages"("order_id", "captured_at");

