-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "ai_brief_json" JSONB,
ADD COLUMN     "brief_last_call_id" INTEGER,
ADD COLUMN     "brief_last_msg_id" INTEGER,
ADD COLUMN     "brief_updated_at" TIMESTAMP(3);
