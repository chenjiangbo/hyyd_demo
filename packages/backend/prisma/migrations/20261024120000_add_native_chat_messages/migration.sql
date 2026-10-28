CREATE TABLE "native_chat_conversations" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "source_conversation_id" TEXT NOT NULL,
    "title" TEXT,
    "conversation_kind" TEXT NOT NULL DEFAULT 'unknown',
    "business_category" TEXT NOT NULL DEFAULT '',
    "source_metadata" JSONB,
    "first_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "native_chat_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "native_chat_messages" (
    "id" SERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "source_message_id" TEXT NOT NULL,
    "parent_source_message_id" TEXT,
    "source_item_index" INTEGER,
    "direction" TEXT NOT NULL DEFAULT 'unknown',
    "sender_id" TEXT,
    "sender_name" TEXT,
    "kind" TEXT NOT NULL,
    "source_type_code" TEXT,
    "text" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "source_metadata" JSONB,

    CONSTRAINT "native_chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "native_chat_attachments" (
    "id" SERIAL NOT NULL,
    "message_id" INTEGER NOT NULL,
    "source_attachment_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT,
    "byte_size" BIGINT,
    "content_hash" TEXT,
    "state" TEXT NOT NULL,
    "storage_key" TEXT,
    "source_metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_chat_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "native_chat_conversations_source_key"
    ON "native_chat_conversations"("employee_id", "channel", "account_id", "source_conversation_id");
CREATE INDEX "native_chat_conversations_recent_idx"
    ON "native_chat_conversations"("employee_id", "channel", "last_observed_at" DESC);
CREATE UNIQUE INDEX "native_chat_messages_source_key"
    ON "native_chat_messages"("conversation_id", "source_message_id");
CREATE INDEX "native_chat_messages_timeline_idx"
    ON "native_chat_messages"("conversation_id", "occurred_at", "source_item_index");
CREATE INDEX "native_chat_messages_kind_time_idx"
    ON "native_chat_messages"("kind", "occurred_at");
CREATE INDEX "native_chat_attachments_message_idx"
    ON "native_chat_attachments"("message_id");
CREATE INDEX "native_chat_attachments_hash_idx"
    ON "native_chat_attachments"("content_hash");
CREATE UNIQUE INDEX "native_chat_attachments_source_key"
    ON "native_chat_attachments"("message_id", "source_attachment_id");

ALTER TABLE "native_chat_conversations"
    ADD CONSTRAINT "native_chat_conversations_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "native_chat_messages"
    ADD CONSTRAINT "native_chat_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "native_chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "native_chat_attachments"
    ADD CONSTRAINT "native_chat_attachments_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "native_chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
