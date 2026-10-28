ALTER TABLE "native_chat_conversations"
    ADD COLUMN "application_no" TEXT,
    ADD COLUMN "application_candidate" TEXT,
    ADD COLUMN "application_link_status" TEXT NOT NULL DEFAULT 'no_candidate',
    ADD COLUMN "application_linked_at" TIMESTAMP(3);

CREATE INDEX "native_chat_conversations_application_no_idx"
    ON "native_chat_conversations"("application_no");

ALTER TABLE "orders"
    ADD COLUMN "brief_last_native_at" TIMESTAMP(3),
    ADD COLUMN "field_ai_last_native_at" TIMESTAMP(3);

ALTER TABLE "application_briefs"
    ADD COLUMN "brief_last_native_at" TIMESTAMP(3);
