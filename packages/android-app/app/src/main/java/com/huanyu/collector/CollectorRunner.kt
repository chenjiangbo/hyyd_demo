package com.huanyu.collector

import android.content.Context
import android.util.Log

class CollectorRunner(context: Context) {
    private val appContext = context.applicationContext

    fun sendHeartbeat(source: String): Boolean {
        val prefs = AppPrefs(appContext)
        val target = "${prefs.backendUrl}/api/v1/me/mobile-heartbeat"
        prefs.lastHeartbeatStartedAt = System.currentTimeMillis()
        prefs.lastHeartbeatTarget = "$target · 员工 ${prefs.employeeCode.ifBlank { "未配置" }} · $source"
        prefs.lastHeartbeatStatus = "发送中"
        prefs.lastHeartbeatResponse = ""
        return try {
            prefs.validateConfig()
            val status = org.json.JSONObject()
                .put("installationId", prefs.installationId)
                .put("appVersion", BuildConfig.VERSION_NAME)
                .put("appVisibility", prefs.appVisibility)
                .put("serviceRunning", prefs.collectorServiceRunning)
                .put("serviceStartedAtMs", prefs.serviceStartedAt.takeIf { it > 0L } ?: org.json.JSONObject.NULL)
                .put("backgroundSinceMs", prefs.backgroundSince.takeIf { it > 0L } ?: org.json.JSONObject.NULL)
                .put("syncRunning", prefs.syncRunning)
                .put("syncStartedAtMs", prefs.lastSyncStartedAt.takeIf { prefs.syncRunning && it > 0L } ?: org.json.JSONObject.NULL)
                .put("syncStage", if (prefs.syncRunning) prefs.lastSyncProgressStage else "idle")
                .put("recordingsTotal", prefs.lastRecordingProgressTotal)
                .put("recordingsProcessed", prefs.lastRecordingProgressProcessed)
                .put("recordingsUploaded", prefs.lastRecordingProgressUploaded)
                .put("recordingsFailed", prefs.lastRecordingProgressFailed)
                .put("currentRecordingName", if (prefs.syncRunning) prefs.lastRecordingProgressCurrent else "")
                .put("lastError", prefs.lastSyncError)
            val response = BackendClient(prefs.backendUrl, prefs.employeeCode).heartbeat(source, status)
            prefs.lastHeartbeatFinishedAt = System.currentTimeMillis()
            prefs.lastHeartbeatStatus = "成功"
            prefs.lastHeartbeatResponse = response
            Log.i(TAG, "移动端心跳已上报: $target source=$source")
            true
        } catch (e: Exception) {
            val message = e.message ?: e.javaClass.simpleName
            prefs.lastHeartbeatFinishedAt = System.currentTimeMillis()
            prefs.lastHeartbeatStatus = "失败"
            prefs.lastHeartbeatResponse = message
            Log.e(TAG, "移动端心跳失败 source=$source", e)
            false
        }
    }

    fun syncOnce() = synchronized(SYNC_LOCK) {
        val prefs = AppPrefs(appContext)
        prefs.syncRunning = true
        prefs.lastSyncStartedAt = System.currentTimeMillis()
        prefs.lastRunStartedAt = prefs.lastSyncStartedAt
        prefs.lastRunFinishedAt = 0L
        prefs.runResult = "同步中"
        prefs.callResult = "待处理"
        prefs.recordingResult = "待处理"
        prefs.runError = ""
        prefs.lastSyncError = ""
        prefs.lastCallScanCount = 0
        prefs.lastCallUploadCount = 0
        prefs.lastRunCallsUploaded = 0
        prefs.lastRunRecordingsTotal = 0
        prefs.lastRunRecordingsUploaded = 0
        prefs.lastRunRecordingsFailed = 0
        prefs.lastRecordingMissCount = 0
        prefs.unparsedRecordingCount = 0
        prefs.recordingScanIssue = ""
        try {
            performSync(prefs)
        } catch (e: Exception) {
            val message = e.message ?: e.javaClass.simpleName
            prefs.runResult = "同步失败"
            prefs.runError = message
            prefs.lastSyncError = message
            if (prefs.callResult == "处理中") prefs.callResult = "失败"
            if (prefs.recordingResult == "处理中") prefs.recordingResult = "失败"
            prefs.lastRunFinishedAt = System.currentTimeMillis()
            prefs.lastSyncFinishedAt = prefs.lastRunFinishedAt
            throw e
        } finally {
            prefs.syncRunning = false
            prefs.updateSyncProgress(prefs.runResult, current = "")
        }
    }

    private fun performSync(prefs: AppPrefs) {
        Log.i(TAG, "开始同步通话记录和录音")
        val runStartedAt = System.currentTimeMillis()
        prefs.lastRunStartedAt = runStartedAt
        prefs.lastSyncStartedAt = runStartedAt
        prefs.lastSyncError = ""
        val initialFloor = runStartedAt - INITIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000L
        if (prefs.recordingScanFloorTs == 0L) prefs.recordingScanFloorTs = initialFloor
        if (prefs.lastCallLogTs == 0L) {
            prefs.lastCallLogTs = initialFloor
            Log.i(TAG, "首次采集仅补最近 $INITIAL_HISTORY_DAYS 天，起点=${prefs.lastCallLogTs}")
        }

        // 诊断范围独立于业务采集范围；不会重置已有上传游标。
        val diagnosticFrom = if (!prefs.diagnosticHistoryComplete || prefs.diagnosticCallWatermark == 0L) {
            DIAGNOSTIC_HISTORY_START
        } else {
            maxOf(DIAGNOSTIC_HISTORY_START, prefs.diagnosticCallWatermark - DIAGNOSTIC_OVERLAP_MS)
        }

        // 先保存本机扫描结果，即使后端不可用也能排查文件与权限。
        var diagnosticScan: RecordingScanResult? = null
        var diagnosticCalls: List<LocalCall> = emptyList()
        var diagnosticCallError: String? = null
        try {
            diagnosticScan = RecordingScanner().scanSince(prefs.recordingScanFloorTs)
            try { diagnosticCalls = CallLogScanner(appContext).scanSince(diagnosticFrom - 1L) }
            catch (e: Exception) { diagnosticCallError = "通话记录读取失败: ${e.message ?: e.javaClass.simpleName}" }
            RecordingDiagnostics(appContext).create(diagnosticScan, diagnosticCalls, prefs.recordingScanFloorTs, emptyMap(), emptyMap(), emptyMap(), diagnosticCallError, false, diagnosticCallFrom = diagnosticFrom, historyFrom = DIAGNOSTIC_HISTORY_START, historyComplete = prefs.diagnosticHistoryComplete)
        } catch (e: Exception) {
            if (diagnosticCallError == null) diagnosticCallError = "诊断初始化失败: ${e.javaClass.simpleName}"
            prefs.recordingScanIssue = "诊断日志保存失败: ${e.message ?: e.javaClass.simpleName}"
            Log.e(TAG, "本机诊断扫描失败", e)
        }

        prefs.updateSyncProgress("检查后端连接", total = 0, processed = 0, uploaded = 0, failed = 0, current = "")
        val backend = BackendClient(prefs.backendUrl, prefs.employeeCode)
        fun checkOrder(call: LocalCall): CallPhoneMatch = try {
            backend.matchCallPhone(call.phone).also {
                prefs.recordCallDiagnostic(call, "orderCheck", if (it.matched) "命中订单" else "未命中订单")
                if (!it.matched && !prefs.callDiagnostic(call).has("backendCallId")) {
                    prefs.recordCallDiagnostic(call, "callUpload", "未命中订单，不上传")
                }
            }
        } catch (e: Exception) {
            prefs.recordCallDiagnostic(call, "orderCheck", "检查失败: ${e.javaClass.simpleName}")
            throw e
        }
        fun uploadCall(call: LocalCall, orderId: Int?): SyncedCall = try {
            backend.postCall(call, orderId).also { prefs.recordCallDiagnostic(call, "callUpload", "已上传", it.id) }
        } catch (e: Exception) {
            prefs.recordCallDiagnostic(call, "callUpload", "上传失败: ${e.javaClass.simpleName}")
            throw e
        }
        val health = backend.health()
        prefs.lastBackendHealth = health
        prefs.lastBackendHealthAt = System.currentTimeMillis()

        prefs.updateSyncProgress("处理待上传通话 ${prefs.pendingCallCount()} 条")
        prefs.callResult = "处理中"
        for (call in prefs.pendingCalls()) {
            try {
                val match = checkOrder(call)
                if (!match.matched) {
                    prefs.removePendingCall(call)
                    prefs.rememberLocalCallListItem(call, "非订单电话，已忽略")
                    continue
                }
                val remote = uploadCall(call, match.orderId)
                prefs.removePendingCall(call)
                prefs.rememberCall(remote)
                prefs.rememberCallListItem(remote, uploaded = true)
                prefs.lastCallUploadCount += 1
            } catch (e: Exception) {
                prefs.rememberLocalCallListItem(call, "上传失败")
                throw IllegalStateException("待上传通话同步失败: ${e.message}", e)
            }
        }

        prefs.updateSyncProgress("扫描系统通话记录")
        val calls = CallLogScanner(appContext).scanSince(prefs.lastCallLogTs)
        prefs.lastCallScanCount = calls.size
        var maxSyncedTs = prefs.lastCallLogTs
        prefs.updateSyncProgress("处理通话记录 ${calls.size} 条")
        for (call in calls) {
            maxSyncedTs = maxOf(maxSyncedTs, call.startedAtMillis)
            if (call.phone.isBlank()) {
                prefs.recordCallDiagnostic(call, "orderCheck", "号码不可用，未检查")
                continue
            }
            try {
                val match = checkOrder(call)
                if (!match.matched) {
                    prefs.rememberLocalCallListItem(call, "非订单电话，已忽略")
                    continue
                }
                val remote = uploadCall(call, match.orderId)
                prefs.rememberCall(remote)
                prefs.rememberCallListItem(remote, uploaded = true)
                prefs.lastCallUploadCount += 1
                val person = remote.contactName?.takeIf { it.isNotBlank() } ?: remote.phone
                prefs.lastSyncedCallText = "id=${remote.id} ${person} ${remote.callStatus} ${remote.durationSec}s"
            } catch (e: Exception) {
                prefs.addPendingCall(call)
                prefs.rememberLocalCallListItem(call, "待上传")
                Log.e(TAG, "通话上传失败，已加入待上传队列", e)
            }
        }

        // 整批处理后再推进游标，避免中断时漏掉相同时间戳的通话。
        prefs.lastCallLogTs = maxSyncedTs
        prefs.lastRunCallsScanned = calls.size
        prefs.lastRunCallsUploaded = prefs.lastCallUploadCount
        prefs.callResult = if (prefs.pendingCallCount() == 0) "已完成" else "待上传"

        prefs.updateSyncProgress("扫描录音目录", total = 0, processed = 0, uploaded = 0, failed = 0, current = "")
        prefs.recordingResult = "处理中"
        val recordingScan = diagnosticScan ?: RecordingScanner().scanSince(prefs.recordingScanFloorTs)
        val recordings = recordingScan.recordings
        val diagnosticStatuses = mutableMapOf<String, String>()
        val diagnosticLinks = mutableMapOf<String, LocalCall>()
        val diagnosticReasons = mutableMapOf<String, Pair<String, Int>>()
        val diagnosticBackendCallIds = mutableMapOf<String, Int>()
        val diagnosticAttempted = mutableSetOf<String>()
        val diagnosticOccupancy = mutableMapOf<String, MutableList<Pair<LocalCall, String>>>()
        fun rememberRecording(recording: LocalRecording, status: String, callId: Int? = null) {
            diagnosticStatuses[recording.file.absolutePath] = status
            prefs.rememberRecordingListItem(recording, status, callId)
        }
        recordings.filter { prefs.isRecordingUploaded(it.file.absolutePath) }.forEach {
            val path = it.file.absolutePath
            diagnosticStatuses[path] = "已上传"
            val savedId = prefs.recordingCallId(path)
            if (savedId > 0) diagnosticCalls.singleOrNull { call -> call.sourceId == savedId }?.let { call -> diagnosticLinks[path] = call }
        }
        prefs.lastRecordingScanCount = recordings.size
        prefs.lastRecordingTotalFileCount = recordingScan.totalAudioCount
        prefs.lastRecordingRawFileCount = recordingScan.rawAudioCount
        prefs.lastRecordingScanSummary = recordingScan.summary
        prefs.lastRecordingUnparsedSamples = recordingScan.unparsedSamples
        prefs.unparsedRecordingCount = recordingScan.unparsedCount
        prefs.recordingScanIssue = recordingScan.issue
        prefs.lastRecordingUploadCount = 0
        prefs.lastRecordingMissCount = 0
        var recordingFailureCount = 0
        var lastRecordingFailure = ""
        val pendingRecordings = recordings.filterNot { prefs.isRecordingUploaded(it.file.absolutePath) }
        var recordingProcessedCount = 0
        var recordingUploadedCount = 0
        prefs.updateSyncProgress(
            "处理录音 ${pendingRecordings.size} 条",
            total = pendingRecordings.size,
            processed = 0,
            uploaded = 0,
            failed = 0,
            current = if (pendingRecordings.isEmpty()) "无待上传录音" else pendingRecordings.first().file.name
        )
        for (recording in pendingRecordings) {
            val path = recording.file.absolutePath
            diagnosticAttempted.add(path)
            prefs.updateSyncProgress(
                "处理录音",
                total = pendingRecordings.size,
                processed = recordingProcessedCount,
                uploaded = recordingUploadedCount,
                failed = recordingFailureCount,
                current = recording.file.name
            )

            var call: SyncedCall? = null
            try {
                val localCall = RecordingMatcher(appContext).match(recording, isConfirmedOccupied = { candidate ->
                    // 必须同时具备本机上传成功的文件映射和后台精确通话的上传确认。
                    val other = recordings.filter {
                        it.file.absolutePath != path && candidate.sourceId > 0 &&
                            prefs.isRecordingUploaded(it.file.absolutePath) &&
                            prefs.recordingCallId(it.file.absolutePath) == candidate.sourceId
                    }.singleOrNull()
                    var evidence = "没有唯一的本机已上传录音映射"
                    val occupied = if (other == null) false else try {
                        val remote = backend.lookupHistoricalCall(candidate)
                        val confirmed = remote != null && remote.hasUploadConfirmation &&
                            remote.recordingKey == "android-recordings/${other.safeName}" &&
                            remote.recordingKey != "android-recordings/${recording.safeName}"
                        evidence = if (confirmed) "本机映射与后台上传确认一致，排除此候选" else "后台上传确认或录音地址不一致，保留候选"
                        confirmed
                    } catch (e: Exception) {
                        evidence = "后台检查失败，保留候选: ${e.javaClass.simpleName}"
                        Log.w(TAG, "无法核实候选通话占用状态，保留候选", e)
                        false
                    }
                    diagnosticOccupancy.getOrPut(path) { mutableListOf() }.add(candidate to evidence)
                    occupied
                }) { reason, count -> diagnosticReasons[path] = reason to count }
                if (localCall != null) {
                    diagnosticLinks[path] = localCall
                    val match = checkOrder(localCall)
                    if (!match.matched) {
                        rememberRecording(recording, "非订单电话，已忽略")
                        recordingProcessedCount += 1
                        prefs.updateSyncProgress("处理录音", processed = recordingProcessedCount, current = recording.file.name)
                        continue
                    }
                    call = uploadCall(localCall, match.orderId)
                    prefs.rememberCall(call)
                }
            } catch (e: Exception) {
                diagnosticReasons[path] = ("关联过程失败: ${e.javaClass.simpleName}" to -1)
                Log.e(TAG, "录音关联失败，将在后续采集中重试: $path", e)
            }
            if (call == null) {
                prefs.lastRecordingMissCount += 1
                rememberRecording(recording, "待关联通话")
                recordingProcessedCount += 1
                prefs.updateSyncProgress(
                    "处理录音",
                    total = pendingRecordings.size,
                    processed = recordingProcessedCount,
                    uploaded = recordingUploadedCount,
                    failed = recordingFailureCount,
                    current = recording.file.name
                )
                continue
            }

            diagnosticBackendCallIds[path] = call.id
            if (!diagnosticLinks.containsKey(path) && diagnosticCallError == null) {
                val selectedCall = call
                val local = diagnosticCalls.filter {
                    it.startedAtMillis == selectedCall.startedAtMillis && it.direction == selectedCall.direction &&
                        PhoneNormalizer.normalize(it.phone) == PhoneNormalizer.normalize(selectedCall.phone)
                }.singleOrNull()
                if (local != null) diagnosticLinks[path] = local
            }
            try {
                val local = diagnosticLinks[path]
                if (local != null && diagnosticReasons[path]?.first == "排除已确认被其他录音占用的候选后唯一匹配") {
                    val target = backend.lookupHistoricalCall(local)
                        ?: throw IllegalStateException("无法核实目标通话的后台录音状态")
                    if (target.id != call.id || (target.recordingKey != null && target.recordingKey != "android-recordings/${recording.safeName}")) {
                        throw IllegalStateException("目标通话已有其他录音或后台通话不一致")
                    }
                }
                prefs.updateSyncProgress(
                    "登记录音",
                    total = pendingRecordings.size,
                    processed = recordingProcessedCount,
                    uploaded = recordingUploadedCount,
                    failed = recordingFailureCount,
                    current = recording.file.name
                )
                val registration = backend.registerRecording(call, recording)
                if (registration.alreadyUploaded) {
                    diagnosticLinks[path]?.let { prefs.rememberRecordingCallId(path, it.sourceId) }
                    prefs.markRecordingUploaded(path)
                    rememberRecording(recording, "已存在", call.id)
                    recordingProcessedCount += 1
                    prefs.updateSyncProgress(
                        "录音已存在",
                        total = pendingRecordings.size,
                        processed = recordingProcessedCount,
                        uploaded = recordingUploadedCount,
                        failed = recordingFailureCount,
                        current = recording.file.name
                    )
                    continue
                }
                val uploadUrl = registration.uploadUrl
                    ?: throw IllegalStateException("后端未返回录音上传地址")
                prefs.updateSyncProgress(
                    "上传录音到 MinIO",
                    total = pendingRecordings.size,
                    processed = recordingProcessedCount,
                    uploaded = recordingUploadedCount,
                    failed = recordingFailureCount,
                    current = recording.file.name
                )
                backend.uploadFile(uploadUrl, recording.file)
                prefs.updateSyncProgress(
                    "确认录音上传",
                    total = pendingRecordings.size,
                    processed = recordingProcessedCount,
                    uploaded = recordingUploadedCount,
                    failed = recordingFailureCount,
                    current = recording.file.name
                )
                backend.confirmRecordingUploaded(call.id, prefs.installationId)
                diagnosticLinks[path]?.let { prefs.rememberRecordingCallId(path, it.sourceId) }
                prefs.markRecordingUploaded(path)
                rememberRecording(recording, "已上传", call.id)
                recordingProcessedCount += 1
                recordingUploadedCount += 1
                prefs.lastRunRecordingsUploaded = recordingUploadedCount
                prefs.lastRecordingUploadCount += 1
                prefs.lastUploadedRecordingText = "callId=${call.id} ${recording.file.name}"
                prefs.updateSyncProgress(
                    "处理录音",
                    total = pendingRecordings.size,
                    processed = recordingProcessedCount,
                    uploaded = recordingUploadedCount,
                    failed = recordingFailureCount,
                    current = recording.file.name
                )
            } catch (e: Exception) {
                val message = e.message ?: e.javaClass.simpleName
                recordingFailureCount += 1
                prefs.lastRunRecordingsFailed = recordingFailureCount
                recordingProcessedCount += 1
                lastRecordingFailure = "callId=${call.id} ${recording.file.name}: $message"
                rememberRecording(recording, "上传失败: $message", call.id)
                Log.e(TAG, "录音上传失败，跳过该文件并继续处理后续录音: $path", e)
                prefs.updateSyncProgress(
                    "录音上传失败，继续后续录音",
                    total = pendingRecordings.size,
                    processed = recordingProcessedCount,
                    uploaded = recordingUploadedCount,
                    failed = recordingFailureCount,
                    current = recording.file.name
                )
                continue
            }
        }
        if (recordingFailureCount > 0) {
            prefs.lastSyncError = "录音上传失败 $recordingFailureCount 条，已继续处理后续录音；最后失败: $lastRecordingFailure"
        }
        // 仅核查订单归属并写诊断，不提交历史通话或录音。
        var historicalChecksComplete = diagnosticCallError == null
        if (!prefs.diagnosticHistoryComplete && diagnosticCallError == null) {
            val checkedPhones = mutableMapOf<String, Boolean>()
            for (historicalCall in diagnosticCalls) {
                val existing = prefs.callDiagnostic(historicalCall).optString("historyOrderCheck", "")
                if (historicalCall.phone.isBlank()) {
                    if (existing != "号码不可用") prefs.recordCallDiagnostic(historicalCall, "historyOrderCheck", "号码不可用")
                    continue
                }
                try {
                    val phone = PhoneNormalizer.normalize(historicalCall.phone)
                    val matched = when (existing) {
                        "命中订单" -> true
                        "未命中订单" -> false
                        else -> (checkedPhones[phone] ?: backend.matchCallPhone(phone).matched.also { checkedPhones[phone] = it }).also {
                            prefs.recordCallDiagnostic(historicalCall, "historyOrderCheck", if (it) "命中订单" else "未命中订单")
                        }
                    }
                    val lookupStatus = prefs.callDiagnostic(historicalCall).optString("historyBackendLookup", "")
                    if (matched && (lookupStatus.isBlank() || lookupStatus.startsWith("检查失败"))) {
                        val found = backend.lookupHistoricalCall(historicalCall)
                        if (found?.recordingKey != null) prefs.recordCallDiagnostic(historicalCall, "historyRecordingKey", found.recordingKey)
                        val detail = if (found == null) "未返回精确候选" else when {
                            found.recordingKey != null && found.hasUploadConfirmation -> "返回精确候选，录音有上传确认"
                            found.recordingKey != null -> "返回精确候选，录音上传未确认"
                            else -> "返回精确候选，无录音地址"
                        }
                        prefs.recordCallDiagnostic(historicalCall, "historyBackendLookup", detail, found?.id)
                    }
                } catch (e: Exception) {
                    historicalChecksComplete = false
                    val field = if (prefs.callDiagnostic(historicalCall).optString("historyOrderCheck") == "命中订单") "historyBackendLookup" else "historyOrderCheck"
                    prefs.recordCallDiagnostic(historicalCall, field, "检查失败: ${e.javaClass.simpleName}")
                }
            }
        }

        try {
            if (diagnosticCallError != null) {
                diagnosticCalls = CallLogScanner(appContext).scanSince(diagnosticFrom - 1L)
                diagnosticCallError = null
            }
            val historyReady = prefs.diagnosticHistoryComplete || (historicalChecksComplete && diagnosticCallError == null && recordingScan.issue.isBlank())
            RecordingDiagnostics(appContext).create(recordingScan, diagnosticCalls, prefs.recordingScanFloorTs, diagnosticStatuses, diagnosticLinks, diagnosticReasons, diagnosticCallError, true, diagnosticBackendCallIds, diagnosticAttempted, diagnosticFrom, DIAGNOSTIC_HISTORY_START, historyReady, diagnosticOccupancy)
            if (historyReady) {
                prefs.diagnosticHistoryComplete = true
                prefs.diagnosticCallWatermark = runStartedAt
            }
        } catch (e: Exception) {
            prefs.recordingScanIssue = listOf(prefs.recordingScanIssue, "诊断日志保存失败: ${e.message ?: e.javaClass.simpleName}").filter { it.isNotBlank() }.joinToString("\n")
            Log.e(TAG, "诊断日志保存失败", e)
        }
        val finishedAt = System.currentTimeMillis()
        prefs.lastRunCallsScanned = calls.size
        prefs.lastRunCallsUploaded = prefs.lastCallUploadCount
        prefs.lastRunRecordingsTotal = pendingRecordings.size
        prefs.lastRunRecordingsUploaded = recordingUploadedCount
        prefs.lastRunRecordingsFailed = recordingFailureCount
        prefs.recordingResult = if (recordingFailureCount > 0 || prefs.lastRecordingMissCount > 0 ||
            prefs.unparsedRecordingCount > 0 || prefs.recordingScanIssue.isNotBlank()) "待处理" else "已完成"
        prefs.runResult = if (prefs.callResult == "已完成" && prefs.recordingResult == "已完成") "同步完成" else "部分完成"
        prefs.lastRunFinishedAt = finishedAt
        prefs.lastSyncFinishedAt = finishedAt
        prefs.updateSyncProgress(
            "本轮完成",
            total = pendingRecordings.size,
            processed = recordingProcessedCount,
            uploaded = recordingUploadedCount,
            failed = recordingFailureCount,
            current = ""
        )
    }

    companion object {
        private const val TAG = "HuanyuCollector"
        private const val INITIAL_HISTORY_DAYS = 7L
        private const val DIAGNOSTIC_HISTORY_START = 1793116800000L // 2026-10-28 00:00 Asia/Shanghai
        private const val DIAGNOSTIC_OVERLAP_MS = 10 * 60 * 1000L
        private val SYNC_LOCK = Any()
    }
}
