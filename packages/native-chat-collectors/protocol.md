# Collector subprocess protocol, version 1

Each child is a long-running process. Standard output contains one UTF-8 JSON object per line; standard error is diagnostic output and must not contain message bodies or credentials.

The child starts by emitting `{"event":"ready","channel":"wechat|wxwork","accountId":"...","sessions":[...]}`. It can later emit `sessions` when its session directory changes. Sessions carry `channel`, `accountId`, `sourceConversationId`, `title`, `kind`, and optional `sourceMetadata`.

The parent sends `{"type":"subscribe","conversations":[{"sourceConversationId":"...","cursor":"opaque cursor"}]}`. An empty list disables message reads. A child emits `message_batch` with a conversation ID, ordered canonical messages and `cursorAfter`. It must hold that cursor until the parent sends `{"type":"ack","sourceConversationId":"...","cursor":"same opaque cursor"}`. The parent sends the ACK only after backend message and attachment persistence succeeds. On failure the child may retry the same batch; backend writes must be idempotent by source message and attachment IDs.

The parent can replace subscriptions while a batch is pending; the child must finish the in-flight batch handshake before dropping that conversation. `{"type":"stop"}` requests clean shutdown. Fatal source, decryption, parsing, database, or protocol errors are emitted as `fatal` or `error` and must not advance a cursor.
