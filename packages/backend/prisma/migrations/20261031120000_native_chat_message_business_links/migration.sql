ALTER TABLE "native_chat_messages"
    ADD COLUMN "application_no" TEXT,
    ADD COLUMN "order_id" INTEGER,
    ADD COLUMN "application_link_status" TEXT NOT NULL DEFAULT 'unmatched',
    ADD COLUMN "application_link_source" TEXT,
    ADD COLUMN "application_link_evidence" JSONB,
    ADD COLUMN "application_linked_at" TIMESTAMP(3);

ALTER TABLE "native_chat_attachments"
    ADD COLUMN "application_no" TEXT,
    ADD COLUMN "order_id" INTEGER,
    ADD COLUMN "application_link_status" TEXT NOT NULL DEFAULT 'unmatched',
    ADD COLUMN "application_link_source" TEXT,
    ADD COLUMN "application_link_evidence" JSONB,
    ADD COLUMN "application_linked_at" TIMESTAMP(3);

CREATE INDEX "native_chat_messages_application_no_time_idx"
    ON "native_chat_messages"("application_no", "occurred_at");
CREATE INDEX "native_chat_messages_order_id_time_idx"
    ON "native_chat_messages"("order_id", "occurred_at");
CREATE INDEX "native_chat_messages_link_status_time_idx"
    ON "native_chat_messages"("application_link_status", "application_linked_at");
CREATE INDEX "native_chat_attachments_application_no_created_idx"
    ON "native_chat_attachments"("application_no", "created_at");
CREATE INDEX "native_chat_attachments_order_id_created_idx"
    ON "native_chat_attachments"("order_id", "created_at");

CREATE INDEX "orders_crm_apply_no_lower_idx"
    ON "orders" (lower("raw_json"->>'crmApplyNo'));
CREATE INDEX "orders_crm_apply_no_suffix8_idx"
    ON "orders" (right(lower("raw_json"->>'crmApplyNo'), 8));
CREATE INDEX "orders_source_order_no_lower_idx"
    ON "orders" (lower("source_order_no"));
