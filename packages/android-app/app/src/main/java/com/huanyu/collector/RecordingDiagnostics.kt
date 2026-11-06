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
    fun create(scan: RecordingScanResult, calls: List<LocalCall>, floor: Long, statuses: Map<String, String>, links: Map<String, LocalCall>, reasons: Map<String, Pair<String, Int>>, callScanError: String? = null, processingComplete: Boolean = true, backendCallIds: Map<String, Int> = emptyMap(), attempted: Set<String> = emptySet(), diagnosticCallFrom: Long = floor, historyFrom: Long = floor, historyComplete: Boolean = false, occupancyChecks: Map<String, List<Pair<LocalCall, String>>> = emptyMap()) = synchronized(FILE_LOCK) {
        val now = System.currentTimeMillis()
        val previous = if (File(context.filesDir, "recording-diagnostics.json").exists() || File(context.filesDir, "recording-diagnostics.json.bak").exists()) JSONObject(output.openRead().bufferedReader().use { it.readText() }) else JSONObject()
        val files = previous.optJSONObject("recordings") ?: JSONObject()
        val callsJson = previous.optJSONObject("calls") ?: JSONObject()
        val parsed = scan.discoveredRecordings.associateBy { it.file.absolutePath }
        for (call in calls) {
            val id = callId(call)
            val callDiagnostic = AppPrefs(context).callDiagnostic(call)
            callsJson.put(id, JSONObject().put("id", id).put("phoneMasked", mask(call.phone))
                .put("phoneId", token(PhoneNormalizer.normalize(call.phone))).put("name", call.contactName)
                .put("startedAt", call.startedAtMillis).put("durationSeconds", call.durationSec)
                .put("direction", call.direction).put("status", call.callStatus).put("rawType", call.rawType ?: JSONObject.NULL)
                .put("orderCheck", callDiagnostic.optString("orderCheck", "未记录"))
                .put("orderCheckAt", if (callDiagnostic.has("orderCheckAt")) callDiagnostic.optLong("orderCheckAt") else JSONObject.NULL)
                .put("historyOrderCheck", callDiagnostic.optString("historyOrderCheck", "未检查"))
                .put("historyOrderCheckAt", if (callDiagnostic.has("historyOrderCheckAt")) callDiagnostic.optLong("historyOrderCheckAt") else JSONObject.NULL)
                .put("historyBackendLookup", callDiagnostic.optString("historyBackendLookup", "未检查"))
                .put("historyBackendLookupAt", if (callDiagnostic.has("historyBackendLookupAt")) callDiagnostic.optLong("historyBackendLookupAt") else JSONObject.NULL)
                .put("historyRecordingKey", if (callDiagnostic.has("historyRecordingKey")) callDiagnostic.optString("historyRecordingKey") else JSONObject.NULL)
                .put("callUpload", callDiagnostic.optString("callUpload", "未记录"))
                .put("callUploadAt", if (callDiagnostic.has("callUploadAt")) callDiagnostic.optLong("callUploadAt") else JSONObject.NULL)
                .put("backendCallId", if (callDiagnostic.has("backendCallId")) callDiagnostic.optInt("backendCallId") else JSONObject.NULL)
                .put("recordingStatus", if (call.callStatus == "answered") "关联情况未确认" else "未接通")
                .put("lastSeenAt", now))
        }
        // 对象名称仅用于提供历史线索，不作为实际上传或关联成功的依据。
        val historicalKeys = mutableMapOf<String, MutableList<String>>()
        val callKeys = callsJson.keys()
        while (callKeys.hasNext()) {
            val id = callKeys.next()
            val value = callsJson.optJSONObject(id) ?: continue
            val key = value.optString("historyRecordingKey", "")
            if (key.isNotBlank() && key != "null") historicalKeys.getOrPut(key) { mutableListOf() }.add(id)
        }
        val recordingKeyCounts = scan.discoveredRecordings.groupingBy { "android-recordings/${it.safeName}" }.eachCount()
        val scannedIds = calls.asSequence().map { callId(it) }.toHashSet()
        for (file in scan.discoveredFiles) {
            val id = token(file.absolutePath)
            val old = files.optJSONObject(id) ?: JSONObject()
            val recording = parsed[file.absolutePath]
            val unchanged = old.optLong("size", -1) == file.length() && old.optLong("modifiedAt", -1) == file.lastModified()
            val duration = if (old.optLong("size", -1) == file.length() && old.optLong("modifiedAt", -1) == file.lastModified() && !old.isNull("durationMs")) old.optLong("durationMs") else duration(file)
            val nearby = JSONArray()
            // 增量查询未覆盖的旧候选保留；覆盖到的通话按当前数据重新计算。
            val oldNearby = old.optJSONArray("nearbyCalls")
            if (unchanged && oldNearby != null) for (index in 0 until oldNearby.length()) {
                val candidate = oldNearby.optJSONObject(index) ?: continue
                if (candidate.optString("callId") !in scannedIds) nearby.put(candidate)
            }
            if (recording != null) {
                calls.asSequence().filter { abs(recording.timestampMillis - it.startedAtMillis) <= 120_000L }
                    .forEach { call ->
                        val delta = recording.timestampMillis - call.startedAtMillis
                        val durationDelta = if (duration != null) duration - call.durationSec * 1000L else null
                        val durationLimit = RecordingMatchRules.durationToleranceMillis(call.durationSec)
                        val excluded = JSONArray()
                        if (call.callStatus != "answered") excluded.put("通话状态不是已接通")
                        if (delta !in 0..60_000L) excluded.put("开始时间超出范围")
                        if (durationDelta == null) excluded.put("录音时长不可用")
                        else if (abs(durationDelta) > durationLimit) excluded.put("时长差超出范围")
                        val numberMatches = if (recording.phone.isNotBlank()) PhoneNormalizer.normalize(recording.phone) == PhoneNormalizer.normalize(call.phone) else null
                        if (numberMatches == false) excluded.put("号码不一致")
                        nearby.put(JSONObject().put("callId", callId(call)).put("diagnosticRuleVersion", 4).put("evaluatedAt", now).put("timeDifferenceMs", delta)
                            .put("durationDifferenceMs", durationDelta ?: JSONObject.NULL)
                            .put("withinTimeRule", delta in 0..60_000L)
                            .put("withinDurationRule", durationDelta != null && abs(durationDelta) <= durationLimit)
                            .put("durationToleranceMs", durationLimit)
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
            val possibleKey = recording?.let { "android-recordings/${it.safeName}" }
            val historicCandidates = possibleKey?.let { historicalKeys[it] }.orEmpty()
            val historicalCandidateIds = JSONArray()
            historicCandidates.forEach { historicalCandidateIds.put(it) }
            val historicalEvidence = when {
                historicCandidates.isEmpty() -> "未发现对象名称线索"
                historicCandidates.size != 1 || recordingKeyCounts[possibleKey] != 1 -> "对象名称存在冲突，需核查"
                else -> "对象名称对应唯一候选，未校验音频内容"
            }
            val occupancy = if (file.absolutePath in attempted) JSONArray().also { arr ->
                occupancyChecks[file.absolutePath].orEmpty().forEach { (candidate, result) ->
                    arr.put(JSONObject().put("callId", callId(candidate)).put("result", result).put("checkedAt", now))
                }
            } else if (unchanged) old.optJSONArray("occupancyChecks") ?: JSONArray() else JSONArray()
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
                .put("lastAttemptRuleVersion", if (file.absolutePath in attempted) 4 else if (unchanged && !old.isNull("lastAttemptRuleVersion")) old.optInt("lastAttemptRuleVersion") else JSONObject.NULL)
                .put("attemptCount", (if (unchanged) old.optInt("attemptCount", 0) else 0) + if (file.absolutePath in attempted) 1 else 0)
                .put("occupancyChecks", occupancy)
                .put("historyBackendCandidateStatus", historicalEvidence).put("historyBackendCandidateCallIds", historicalCandidateIds)
                .put("history", history).put("nearbyCalls", nearby)
            files.put(id, item)
        }
        // 每次根据当前可见的文件和保留的通话重建摘要，避免增量扫描留下旧的“已关联”状态。
        val localMatches = mutableMapOf<String, MutableList<String>>()
        val fileKeys = files.keys()
        while (fileKeys.hasNext()) {
            val file = files.optJSONObject(fileKeys.next()) ?: continue
            val path = file.optString("path", "")
            val source = File(path)
            if (!source.isFile || source.length() != file.optLong("size", -1) || source.lastModified() != file.optLong("modifiedAt", -1)) continue
            val call = file.optString("linkedCallId", "")
            if (call.isNotBlank() && call != "null") localMatches.getOrPut(call) { mutableListOf() }.add(file.optString("status", "未记录"))
        }
        val allCallKeys = callsJson.keys()
        while (allCallKeys.hasNext()) {
            val id = allCallKeys.next()
            val item = callsJson.optJSONObject(id) ?: continue
            val fileStatuses = localMatches[id].orEmpty()
            val localStatus = RecordingDiagnosticSummary.matchStatus(fileStatuses, item.optString("status"))
            val localUpload = RecordingDiagnosticSummary.uploadStatus(fileStatuses)
            val backendStatus = when (item.optString("historyBackendLookup")) {
                "返回精确候选，录音有上传确认" -> "历史查询显示后台有上传确认"
                "返回精确候选，录音上传未确认" -> "历史查询显示后台上传未确认"
                "返回精确候选，无录音地址" -> "历史查询显示后台无录音地址"
                "未返回精确候选" -> "历史查询未返回精确通话候选"
                else -> "后台录音状态未查询"
            }
            item.put("recordingStatus", localStatus).put("recordingMatchStatus", localStatus)
                .put("recordingUploadStatus", localUpload).put("recordingBackendStatus", backendStatus)
                .put("recordingBackendCheckedAt", if (item.isNull("historyBackendLookupAt")) JSONObject.NULL else item.optLong("historyBackendLookupAt"))
        }
        val dirs = JSONArray()
        scan.directoryDiagnostics.forEach { dirs.put(JSONObject().put("path", it.path).put("status", it.status).put("audioCount", it.audioCount)) }
        val permissions = JSONObject()
        listOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_CONTACTS, if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE).forEach {
            permissions.put(it, context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED)
        }
        permissions.put("allFilesAccess", if (Build.VERSION.SDK_INT >= 30) android.os.Environment.isExternalStorageManager() else JSONObject.NULL)
        val root = JSONObject().put("version", 2).put("appVersion", BuildConfig.VERSION_NAME).put("device", Build.MODEL).put("androidVersion", Build.VERSION.RELEASE).put("permissions", permissions)
            .put("scanAt", now).put("callScanFrom", diagnosticCallFrom).put("recordingScanFrom", floor)
            .put("historyFrom", historyFrom).put("historyReviewComplete", historyComplete)
            .put("callScanError", callScanError ?: JSONObject.NULL).put("processingComplete", processingComplete)
            .put("matchingRules", JSONObject().put("version", 4).put("maxStartDifferenceMs", 60000)
                .put("durationTiers", JSONArray()
                    .put(JSONObject().put("callDurationAtMostSeconds", 10).put("toleranceMs", 3000))
                    .put(JSONObject().put("callDurationAtMostSeconds", 30).put("toleranceMs", 6000))
                    .put(JSONObject().put("callDurationOverSeconds", 30).put("toleranceMs", 10000))))
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
