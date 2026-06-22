package com.huanyu.collector

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

class AppPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("huanyu_collector", Context.MODE_PRIVATE)

    var backendUrl: String
        get() = prefs.getString("backend_url", BuildConfig.BACKEND_URL).orEmpty()
        set(value) = prefs.edit().putString("backend_url", value.trim().trimEnd('/')).apply()

    var employeeCode: String
        get() = prefs.getString("employee_code", BuildConfig.EMPLOYEE_CODE).orEmpty()
        set(value) = prefs.edit().putString("employee_code", value.trim()).apply()

    var collectionEnabled: Boolean
        get() = prefs.getBoolean("collection_enabled", false)
        set(value) = prefs.edit().putBoolean("collection_enabled", value).apply()

    var lastBackgroundWorkStartedAt: Long
        get() = prefs.getLong("last_background_work_started_at", 0L)
        set(value) = prefs.edit().putLong("last_background_work_started_at", value).apply()

    var lastBackgroundWorkFinishedAt: Long
        get() = prefs.getLong("last_background_work_finished_at", 0L)
        set(value) = prefs.edit().putLong("last_background_work_finished_at", value).apply()

    var lastBackgroundWorkStatus: String
        get() = prefs.getString("last_background_work_status", "未运行").orEmpty()
        set(value) = prefs.edit().putString("last_background_work_status", value.take(300)).apply()

    var lastCallLogTs: Long
        get() = prefs.getLong("last_call_log_ts", 0L)
        set(value) = prefs.edit().putLong("last_call_log_ts", value).apply()

    var recordingScanFloorTs: Long
        get() = prefs.getLong("recording_scan_floor_ts", 0L)
        set(value) = prefs.edit().putLong("recording_scan_floor_ts", value).apply()

    var serviceStartedAt: Long
        get() = prefs.getLong("service_started_at", 0L)
        set(value) = prefs.edit().putLong("service_started_at", value).apply()

    var lastSyncStartedAt: Long
        get() = prefs.getLong("last_sync_started_at", 0L)
        set(value) = prefs.edit().putLong("last_sync_started_at", value).apply()

    var lastSyncFinishedAt: Long
        get() = prefs.getLong("last_sync_finished_at", 0L)
        set(value) = prefs.edit().putLong("last_sync_finished_at", value).apply()

    var lastSyncError: String
        get() = prefs.getString("last_sync_error", "").orEmpty()
        set(value) = prefs.edit().putString("last_sync_error", value.take(600)).apply()

    var lastBackendHealth: String
        get() = prefs.getString("last_backend_health", "未检查").orEmpty()
        set(value) = prefs.edit().putString("last_backend_health", value.take(300)).apply()

    var lastBackendHealthAt: Long
        get() = prefs.getLong("last_backend_health_at", 0L)
        set(value) = prefs.edit().putLong("last_backend_health_at", value).apply()

    var lastCallScanCount: Int
        get() = prefs.getInt("last_call_scan_count", 0)
        set(value) = prefs.edit().putInt("last_call_scan_count", value).apply()

    var lastCallUploadCount: Int
        get() = prefs.getInt("last_call_upload_count", 0)
        set(value) = prefs.edit().putInt("last_call_upload_count", value).apply()

    var lastRecordingScanCount: Int
        get() = prefs.getInt("last_recording_scan_count", 0)
        set(value) = prefs.edit().putInt("last_recording_scan_count", value).apply()

    var lastRecordingUploadCount: Int
        get() = prefs.getInt("last_recording_upload_count", 0)
        set(value) = prefs.edit().putInt("last_recording_upload_count", value).apply()

    var lastRecordingMissCount: Int
        get() = prefs.getInt("last_recording_miss_count", 0)
        set(value) = prefs.edit().putInt("last_recording_miss_count", value).apply()

    var lastSyncedCallText: String
        get() = prefs.getString("last_synced_call_text", "无").orEmpty()
        set(value) = prefs.edit().putString("last_synced_call_text", value.take(300)).apply()

    var lastUploadedRecordingText: String
        get() = prefs.getString("last_uploaded_recording_text", "无").orEmpty()
        set(value) = prefs.edit().putString("last_uploaded_recording_text", value.take(300)).apply()

    var lastHeartbeatStartedAt: Long
        get() = prefs.getLong("last_heartbeat_started_at", 0L)
        set(value) = prefs.edit().putLong("last_heartbeat_started_at", value).apply()

    var lastHeartbeatFinishedAt: Long
        get() = prefs.getLong("last_heartbeat_finished_at", 0L)
        set(value) = prefs.edit().putLong("last_heartbeat_finished_at", value).apply()

    var lastHeartbeatTarget: String
        get() = prefs.getString("last_heartbeat_target", "").orEmpty()
        set(value) = prefs.edit().putString("last_heartbeat_target", value.take(300)).apply()

    var lastHeartbeatStatus: String
        get() = prefs.getString("last_heartbeat_status", "未发送").orEmpty()
        set(value) = prefs.edit().putString("last_heartbeat_status", value.take(80)).apply()

    var lastHeartbeatResponse: String
        get() = prefs.getString("last_heartbeat_response", "").orEmpty()
        set(value) = prefs.edit().putString("last_heartbeat_response", value.take(600)).apply()

    fun isRecordingUploaded(path: String): Boolean = prefs.getBoolean("uploaded:$path", false)

    fun markRecordingUploaded(path: String) {
        prefs.edit().putBoolean("uploaded:$path", true).apply()
    }

    fun rememberCallListItem(call: SyncedCall, uploaded: Boolean) {
        val item = JSONObject()
            .put("id", call.id)
            .put("phone", call.phone)
            .put("contactName", call.contactName ?: JSONObject.NULL)
            .put("direction", call.direction)
            .put("callStatus", call.callStatus)
            .put("durationSec", call.durationSec)
            .put("startedAtMillis", call.startedAtMillis)
            .put("uploaded", uploaded)
            .put("updatedAt", System.currentTimeMillis())
        prependTrimmedJson("recent_calls", item, 50, "id", call.id)
    }

    fun rememberLocalCallListItem(call: LocalCall, status: String) {
        val item = JSONObject()
            .put("localKey", localCallKey(call))
            .put("id", JSONObject.NULL)
            .put("phone", call.phone)
            .put("contactName", call.contactName ?: JSONObject.NULL)
            .put("direction", call.direction)
            .put("callStatus", call.callStatus)
            .put("durationSec", call.durationSec)
            .put("startedAtMillis", call.startedAtMillis)
            .put("uploaded", false)
            .put("localStatus", status)
            .put("updatedAt", System.currentTimeMillis())
        prependTrimmedJson("recent_calls", item, 50, "localKey", localCallKey(call))
    }

    fun addPendingCall(call: LocalCall) {
        val item = localCallToJson(call)
        prependTrimmedJson("pending_calls", item, 300, "localKey", localCallKey(call))
    }

    fun removePendingCall(call: LocalCall) {
        val arr = JSONArray(prefs.getString("pending_calls", "[]"))
        val next = JSONArray()
        val key = localCallKey(call)
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            if (item.optString("localKey") != key) next.put(item)
        }
        prefs.edit().putString("pending_calls", next.toString()).apply()
    }

    fun pendingCalls(): List<LocalCall> {
        val arr = JSONArray(prefs.getString("pending_calls", "[]"))
        val result = mutableListOf<LocalCall>()
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            result.add(jsonToLocalCall(item))
        }
        return result
    }

    fun rememberRecordingListItem(recording: LocalRecording, status: String, callId: Int? = null) {
        val item = JSONObject()
            .put("path", recording.file.absolutePath)
            .put("name", recording.file.name)
            .put("phone", recording.phone)
            .put("timestampMillis", recording.timestampMillis)
            .put("status", status)
            .put("callId", callId ?: JSONObject.NULL)
            .put("updatedAt", System.currentTimeMillis())
        prependTrimmedJson("recent_recordings", item, 50, "path", recording.file.absolutePath)
    }

    fun recentCalls(): JSONArray = JSONArray(prefs.getString("recent_calls", "[]"))

    fun recentRecordings(): JSONArray = JSONArray(prefs.getString("recent_recordings", "[]"))

    fun pendingCallCount(): Int = JSONArray(prefs.getString("pending_calls", "[]")).length()

    fun rememberCall(call: SyncedCall) {
        val arr = JSONArray(prefs.getString("synced_calls", "[]"))
        val item = JSONObject()
            .put("id", call.id)
            .put("phone", call.phone)
            .put("contactName", call.contactName ?: JSONObject.NULL)
            .put("direction", call.direction)
            .put("callStatus", call.callStatus)
            .put("startedAtMillis", call.startedAtMillis)
            .put("durationSec", call.durationSec)
        arr.put(item)

        val trimmed = JSONArray()
        val start = maxOf(0, arr.length() - 200)
        for (i in start until arr.length()) trimmed.put(arr.getJSONObject(i))
        prefs.edit().putString("synced_calls", trimmed.toString()).apply()
    }

    private fun prependTrimmedJson(key: String, item: JSONObject, limit: Int, identityKey: String, identityValue: Any) {
        val arr = JSONArray(prefs.getString(key, "[]"))
        val next = JSONArray()
        next.put(item)
        for (i in 0 until arr.length()) {
            val existing = arr.getJSONObject(i)
            val same = when (identityValue) {
                is Int -> existing.optInt(identityKey) == identityValue
                else -> existing.optString(identityKey) == identityValue.toString()
            }
            if (!same && next.length() < limit) next.put(existing)
        }
        prefs.edit().putString(key, next.toString()).apply()
    }

    private fun localCallKey(call: LocalCall): String = "${call.phone}:${call.startedAtMillis}:${call.direction}"

    private fun localCallToJson(call: LocalCall): JSONObject {
        return JSONObject()
            .put("localKey", localCallKey(call))
            .put("phone", call.phone)
            .put("contactName", call.contactName ?: JSONObject.NULL)
            .put("direction", call.direction)
            .put("callStatus", call.callStatus)
            .put("durationSec", call.durationSec)
            .put("startedAtMillis", call.startedAtMillis)
    }

    private fun jsonToLocalCall(item: JSONObject): LocalCall {
        return LocalCall(
            phone = item.getString("phone"),
            contactName = item.optString("contactName", "").ifBlank { null },
            direction = item.getString("direction"),
            callStatus = item.getString("callStatus"),
            durationSec = item.optInt("durationSec", 0),
            startedAtMillis = item.getLong("startedAtMillis")
        )
    }

    fun validateConfig() {
        if (backendUrl.isBlank()) throw IllegalStateException("后端地址为空")
        if (!backendUrl.startsWith("http://") && !backendUrl.startsWith("https://")) {
            throw IllegalStateException("后端地址必须以 http:// 或 https:// 开头")
        }
        if (employeeCode.isBlank()) throw IllegalStateException("员工 ID 为空")
    }

    fun findCall(phone: String, recordingTsMillis: Long, windowMs: Long = 10 * 60 * 1000L): SyncedCall? {
        val normalized = PhoneNormalizer.normalize(phone)
        val arr = JSONArray(prefs.getString("synced_calls", "[]"))
        var best: SyncedCall? = null
        var bestDiff = Long.MAX_VALUE

        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val candidatePhone = item.getString("phone")
            if (!PhoneNormalizer.sameNumber(normalized, candidatePhone)) continue

            val startedAtMillis = item.getLong("startedAtMillis")
            val diff = abs(startedAtMillis - recordingTsMillis)
            if (diff <= windowMs && diff < bestDiff) {
                bestDiff = diff
                best = SyncedCall(
                    id = item.getInt("id"),
                    phone = candidatePhone,
                    contactName = item.optString("contactName", "").ifBlank { null },
                    direction = item.optString("direction", ""),
                    callStatus = item.optString("callStatus", ""),
                    startedAtMillis = startedAtMillis,
                    durationSec = item.optInt("durationSec", 0)
                )
            }
        }
        return best
    }
}

data class SyncedCall(
    val id: Int,
    val phone: String,
    val contactName: String?,
    val direction: String,
    val callStatus: String,
    val startedAtMillis: Long,
    val durationSec: Int
)
