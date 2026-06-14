-- AlterTable
ALTER TABLE "materials" ADD COLUMN     "ai_image_kind" TEXT,
ADD COLUMN     "ai_image_processed_at" TIMESTAMP(3),
ADD COLUMN     "ai_image_text" TEXT;
