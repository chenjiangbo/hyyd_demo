package com.huanyu.collector

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.os.Build
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import kotlin.math.abs

/** 仅保存在应用私有目录，导出由用户主动选择。 */
class RecordingDiagnostics(private val context: Context) {
    private val output = AtomicFile(File(context.filesDir, "recording-diagnostics.json"))
    private fun token(value: String): String {
        if (value.isBlank()) return ""
        val salt = AppPrefs(context).installationId
        return MessageDigest.getInstance("SHA-256").digest((salt + ":" + value).toByteArray()).take(12).joinToString("") { "%02x".format(it) }
    }
    fun create(scan: RecordingScanResult, calls: List<LocalCall>, floor: Long, statuses: Map<String, String>, links: Map<String, LocalCall>, reasons: Map<String, Pair<String, Int>>, callScanError: String? = null, processingComplete: Boolean = true, backendCallIds: Map<String, Int> = emptyMap(), attempted: Set<String> = emptySet()) = synchronized(FILE_LOCK) {
        val now = System.currentTimeMillis()
        val previous = if (File(context.filesDir, "recording-diagnostics.json").exists() || File(context.filesDir, "recording-diagnostics.json.bak").exists()) JSONObject(output.openRead().bufferedReader().use { it.readText() }) else JSONObject()
        val files = previous.optJSONObject("recordings") ?: JSONObject()
        val callsJson = previous.optJSONObject("calls") ?: JSONObject()
        val parsed = scan.discoveredRecordings.associateBy { it.file.absolutePath }
        val linked = links.values.map { callId(it) }.toMutableSet()
        val oldKeys = files.keys()
        while (oldKeys.hasNext()) {
            val old = files.optJSONObject(oldKeys.next()) ?: continue
            val oldLink = old.optString("linkedCallId", "")
            val source = File(old.optString("path", ""))
            if (source.isFile && source.length() == old.optLong("size", -1) && source.lastModified() == old.optLong("modifiedAt", -1) && oldLink.isNotBlank() && oldLink != "null") linked.add(oldLink)
        }
        for (call in calls) {
            val id = callId(call)
            callsJson.put(id, JSONObject().put("id", id).put("phoneMasked", mask(call.phone))
                .put("phoneId", token(PhoneNormalizer.normalize(call.phone))).put("name", call.contactName)
                .put("startedAt", call.startedAtMillis).put("durationSeconds", call.durationSec)
                .put("direction", call.direction).put("status", call.callStatus).put("rawType", call.rawType ?: JSONObject.NULL)
                .put("recordingStatus", if (id in linked) "已关联" else if (call.callStatus == "answered") "关联情况未确认" else "未接通")
                .put("lastSeenAt", now))
        }
        for (file in scan.discoveredFiles) {
            val id = token(file.absolutePath)
            val old = files.optJSONObject(id) ?: JSONObject()
            val recording = parsed[file.absolutePath]
            val unchanged = old.optLong("size", -1) == file.length() && old.optLong("modifiedAt", -1) == file.lastModified()
            val duration = if (old.optLong("size", -1) == file.length() && old.optLong("modifiedAt", -1) == file.lastModified() && !old.isNull("durationMs")) old.optLong("durationMs") else duration(file)
            val nearby = JSONArray()
            if (recording != null) {
                calls.asSequence().filter { abs(recording.timestampMillis - it.startedAtMillis) <= 120_000L }
                    .forEach { call ->
                        val delta = recording.timestampMillis - call.startedAtMillis
                        val durationDelta = if (duration != null) duration - call.durationSec * 1000L else null
                        val excluded = JSONArray()
                        if (call.callStatus != "answered") excluded.put("通话状态不是已接通")
                        if (delta !in 0..60_000L) excluded.put("开始时间超出范围")
                        if (durationDelta == null) excluded.put("录音时长不可用")
                        else if (abs(durationDelta) > 3_000L) excluded.put("时长差超出范围")
                        val numberMatches = if (recording.phone.isNotBlank()) PhoneNormalizer.normalize(recording.phone) == PhoneNormalizer.normalize(call.phone) else null
                        if (numberMatches == false) excluded.put("号码不一致")
                        nearby.put(JSONObject().put("callId", callId(call)).put("timeDifferenceMs", delta)
                            .put("durationDifferenceMs", durationDelta ?: JSONObject.NULL)
                            .put("withinTimeRule", delta in 0..60_000L)
                            .put("withinDurationRule", durationDelta != null && abs(durationDelta) <= 3_000L)
                            .put("answered", call.callStatus == "answered").put("rawType", call.rawType ?: JSONObject.NULL)
                            .put("numberMatches", numberMatches ?: JSONObject.NULL)
                            .put("cachedNameMatches", if (!recording.contactName.isNullOrBlank() && !call.contactName.isNullOrBlank()) recording.contactName.trim() == call.contactName.trim() else JSONObject.NULL)
                            .put("excludedReasons", excluded))
                    }
            }
            val status = statuses[file.absolutePath] ?: when {
                unchanged && old.optString("status").isNotBlank() -> old.optString("status")
                file.lastModified() < floor || (recording != null && recording.timestampMillis < floor) -> "超出采集范围"
                recording != null -> "待处理"
                else -> "未识别"
            }
            val previousHistory = old.optJSONArray("history") ?: JSONArray()
            val history = JSONArray()
            for (i in 0 until previousHistory.length()) {
                val event = previousHistory.optJSONObject(i) ?: continue
                if (event.optLong("at") >= now - 90L * 24 * 60 * 60 * 1000 || status.contains("待") || status == "未识别") history.put(event)
            }
            val reason = reasons[file.absolutePath]
            if (old.optString("status") != status || (reason != null && old.optString("reason") != reason.first)) {
                history.put(JSONObject().put("at", now).put("status", status).put("reason", reason?.first ?: JSONObject.NULL))
            }
            val item = JSONObject().put("path", file.absolutePath).put("name", file.name).put("size", file.length())
                .put("modifiedAt", file.lastModified()).put("firstSeenAt", old.optLong("firstSeenAt", now))
                .put("lastSeenAt", now).put("durationMs", duration ?: JSONObject.NULL)
                .put("recordingTime", recording?.timestampMillis ?: JSONObject.NULL)
                .put("parsedContactName", recording?.contactName ?: JSONObject.NULL)
                .put("parsedPhoneMasked", if (recording != null && recording.phone.isNotBlank()) mask(recording.phone) else JSONObject.NULL)
                .put("status", status)
                .put("linkedCallId", links[file.absolutePath]?.let { callId(it) } ?: (if (unchanged) old.optString("linkedCallId", "").takeUnless { it.isBlank() || it == "null" } else null) ?: JSONObject.NULL)
                .put("reason", reason?.first ?: (if (unchanged && (!processingComplete || old.optString("status") == status)) old.optString("reason", "").takeUnless { it.isBlank() || it == "null" } else null) ?: JSONObject.NULL)
                .put("candidateCount", reason?.second ?: (if (unchanged && old.optString("status") == status && !old.isNull("candidateCount")) old.optInt("candidateCount") else JSONObject.NULL))
                .put("backendCallId", backendCallIds[file.absolutePath] ?: if (unchanged && !old.isNull("backendCallId")) old.optInt("backendCallId") else JSONObject.NULL)
                .put("lastAttemptAt", if (file.absolutePath in attempted) now else if (unchanged && !old.isNull("lastAttemptAt")) old.optLong("lastAttemptAt") else JSONObject.NULL)
                .put("attemptCount", (if (unchanged) old.optInt("attemptCount", 0) else 0) + if (file.absolutePath in attempted) 1 else 0)
                .put("history", history).put("nearbyCalls", nearby)
            files.put(id, item)
        }
        val dirs = JSONArray()
        scan.directoryDiagnostics.forEach { dirs.put(JSONObject().put("path", it.path).put("status", it.status).put("audioCount", it.audioCount)) }
        val permissions = JSONObject()
        listOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_CONTACTS, if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE).forEach {
            permissions.put(it, context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED)
        }
        permissions.put("allFilesAccess", if (Build.VERSION.SDK_INT >= 30) android.os.Environment.isExternalStorageManager() else JSONObject.NULL)
        val root = JSONObject().put("version", 2).put("appVersion", BuildConfig.VERSION_NAME).put("device", Build.MODEL).put("androidVersion", Build.VERSION.RELEASE).put("permissions", permissions)
            .put("scanAt", now).put("callScanFrom", floor).put("recordingScanFrom", floor)
            .put("callScanError", callScanError ?: JSONObject.NULL).put("processingComplete", processingComplete)
            .put("matchingRules", JSONObject().put("version", 1).put("maxStartDifferenceMs", 60000).put("maxDurationDifferenceMs", 3000))
            .put("directories", dirs).put("scanIssues", scan.issue).put("calls", callsJson).put("recordings", files)
        var stream: java.io.FileOutputStream? = null
        try {
            stream = output.startWrite()
            stream.write(root.toString(2).toByteArray(Charsets.UTF_8))
            output.finishWrite(stream)
        } catch (e: Exception) {
            if (stream != null) output.failWrite(stream)
            throw e
        }
    }
    fun read(): JSONObject = synchronized(FILE_LOCK) { JSONObject(output.openRead().bufferedReader().use { it.readText() }) }
    fun bytes(): ByteArray = synchronized(FILE_LOCK) { output.openRead().use { it.readBytes() } }
    private fun callId(call: LocalCall): String = if (call.sourceId > 0) token("call:${call.sourceId}") else token("${call.phone}:${call.startedAtMillis}:${call.direction}")
    companion object { private val FILE_LOCK = Any() }
    private fun mask(phone: String): String = if (phone.length >= 7) phone.take(3) + "****" + phone.takeLast(4) else if (phone.isBlank()) "" else "***"
    private fun duration(file: File): Long? = try {
        val reader = MediaMetadataRetriever()
        try { reader.setDataSource(file.absolutePath); reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() }
        finally { reader.release() }
    } catch (_: Exception) { null }
}
