#!/usr/bin/env bash
# Fun-ASR 端到端测试：
#  1. 直接在 DB 里创建一条 Call 行
#  2. 调 /api/v1/recordings 拿 uploadUrl
#  3. PUT 一个 .wav 文件到 MinIO
#  4. 轮询 /api/v1/calls/:id/transcript 直到 asrStatus = done
#
# 用法: bash scripts/test-asr-e2e.sh <wav-file-path>

set -euo pipefail

WAV="${1:-/tmp/sample.wav}"
[ ! -f "$WAV" ] && { echo "❌ 找不到 wav 文件: $WAV"; exit 1; }

BACKEND="${BACKEND_URL:-http://localhost:13000}"
EMPLOYEE_CODE="${EMPLOYEE_CODE:-huanyu-field-1}"

# 1. 直接 SQL 插一条 Call（绕过移动端，模拟它已经上报通话）
echo "📞 [1/4] 创建测试 Call 记录..."
CALL_ID=$(docker exec huanyu-postgres psql -U huanyu -d huanyu -tAq -c "INSERT INTO calls (employee_id, phone, direction, duration_sec, started_at, asr_status) VALUES (2, '13800000000', 'out', 8, NOW(), 'pending') RETURNING id;" | head -1 | tr -d '[:space:]')
echo "   ✓ Call ID = $CALL_ID"

OSS_KEY="test/call-${CALL_ID}-$(date +%s).wav"
echo "   ossKey = $OSS_KEY"

# 2. 调 /recordings 拿 uploadUrl
echo "🔑 [2/4] 申请 MinIO 上传 URL..."
RESP=$(curl -s -X POST \
  -H "X-Employee-Code: $EMPLOYEE_CODE" \
  -H "Content-Type: application/json" \
  -d "{\"callId\":$CALL_ID,\"ossKey\":\"$OSS_KEY\",\"durationSec\":8}" \
  "$BACKEND/api/v1/recordings")
UPLOAD_URL=$(echo "$RESP" | node -e "process.stdin.on('data', d => { try { console.log(JSON.parse(d).data.uploadUrl) } catch (e) { console.error(d.toString()); process.exit(1) } })")
echo "   ✓ uploadUrl(short) = ${UPLOAD_URL:0:80}..."

# 3. PUT 音频到 MinIO
echo "⬆️  [3/4] PUT .wav 文件到 MinIO..."
PUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
  -H "Content-Type: audio/wav" \
  --data-binary "@$WAV" \
  "$UPLOAD_URL")
echo "   ✓ HTTP $PUT_CODE"
[ "$PUT_CODE" != "200" ] && { echo "❌ 上传失败 HTTP $PUT_CODE"; exit 1; }

# 4. 轮询转写状态
echo "⏳ [4/4] 等待 Fun-ASR 转写（最多 5 分钟）..."
START=$(date +%s)
while true; do
  STATUS=$(curl -s -H "X-Employee-Code: $EMPLOYEE_CODE" "$BACKEND/api/v1/calls/$CALL_ID/transcript" \
    | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log(j.data.asrStatus) })")
  ELAPSED=$(( $(date +%s) - START ))
  echo "   [${ELAPSED}s] asrStatus = $STATUS"
  case "$STATUS" in
    done)
      echo ""
      echo "✅ 转写完成！结果："
      echo "─────────────────────────────────────────"
      curl -s -H "X-Employee-Code: $EMPLOYEE_CODE" "$BACKEND/api/v1/calls/$CALL_ID/transcript" \
        | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log(j.data.asrText || '(empty)') })"
      echo "─────────────────────────────────────────"
      exit 0
      ;;
    failed|requires_manual)
      echo ""
      echo "❌ 转写失败 (status=$STATUS)，asrText:"
      curl -s -H "X-Employee-Code: $EMPLOYEE_CODE" "$BACKEND/api/v1/calls/$CALL_ID/transcript" \
        | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log(j.data.asrText) })"
      exit 1
      ;;
  esac
  [ "$ELAPSED" -gt 300 ] && { echo "⏰ 超时 5 分钟"; exit 1; }
  sleep 5
done
