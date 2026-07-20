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
            val response = BackendClient(prefs.backendUrl, prefs.employeeCode).heartbeat(source)
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
            prefs.lastSyncError = "移动端心跳失败: $message"
            Log.e(TAG, "移动端心跳失败 source=$source", e)
            false
        }
    }

    fun syncOnce() = synchronized(SYNC_LOCK) {
        Log.i(TAG, "开始同步通话记录和录音")
        val prefs = AppPrefs(appContext)
        prefs.validateConfig()
        val initialFloor = System.currentTimeMillis() - INITIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000L
        if (prefs.recordingScanFloorTs == 0L) prefs.recordingScanFloorTs = initialFloor
        if (prefs.lastCallLogTs == 0L) {
            prefs.lastCallLogTs = initialFloor
            Log.i(TAG, "首次采集仅补最近 $INITIAL_HISTORY_DAYS 天，起点=${prefs.lastCallLogTs}")
        }

        prefs.updateSyncProgress("检查后端连接", total = 0, processed = 0, uploaded = 0, failed = 0, current = "")
        val backend = BackendClient(prefs.backendUrl, prefs.employeeCode)
        val health = backend.health()
        prefs.lastBackendHealth = health
        prefs.lastBackendHealthAt = System.currentTimeMillis()

        prefs.updateSyncProgress("处理待上传通话 ${prefs.pendingCallCount()} 条")
        for (call in prefs.pendingCalls()) {
            try {
                val match = backend.matchCallPhone(call.phone)
                if (!match.matched) {
                    prefs.removePendingCall(call)
                    continue
                }
                val remote = backend.postCall(call, match.orderId)
                prefs.removePendingCall(call)
                prefs.rememberCall(remote)
                prefs.rememberCallListItem(remote, uploaded = true)
            } catch (e: Exception) {
                prefs.rememberLocalCallListItem(call, "上传失败")
                throw IllegalStateException("待上传通话同步失败: ${e.message}", e)
            }
        }

        prefs.updateSyncProgress("扫描系统通话记录")
        val calls = CallLogScanner(appContext).scanSince(prefs.lastCallLogTs)
        prefs.lastCallScanCount = calls.size
        prefs.lastCallUploadCount = 0
        var maxSyncedTs = prefs.lastCallLogTs
        prefs.updateSyncProgress("处理通话记录 ${calls.size} 条")
        for (call in calls) {
            maxSyncedTs = maxOf(maxSyncedTs, call.startedAtMillis)
            try {
                val match = backend.matchCallPhone(call.phone)
                if (!match.matched) {
                    prefs.lastCallLogTs = maxSyncedTs
                    continue
                }
                val remote = backend.postCall(call, match.orderId)
                prefs.rememberCall(remote)
                prefs.rememberCallListItem(remote, uploaded = true)
                prefs.lastCallUploadCount += 1
                val person = remote.contactName?.takeIf { it.isNotBlank() } ?: remote.phone
                prefs.lastSyncedCallText = "id=${remote.id} ${person} ${remote.callStatus} ${remote.durationSec}s"
                prefs.lastCallLogTs = maxSyncedTs
            } catch (e: Exception) {
                prefs.addPendingCall(call)
                prefs.rememberLocalCallListItem(call, "待上传")
                prefs.lastCallLogTs = maxSyncedTs
                Log.e(TAG, "通话上传失败，已加入待上传队列", e)
            }
        }

        prefs.updateSyncProgress("扫描录音目录", total = 0, processed = 0, uploaded = 0, failed = 0, current = "")
        val recordingScan = RecordingScanner().scanSince(prefs.recordingScanFloorTs)
        val recordings = recordingScan.recordings
        prefs.lastRecordingScanCount = recordings.size
        prefs.lastRecordingTotalFileCount = recordingScan.totalAudioCount
        prefs.lastRecordingRawFileCount = recordingScan.rawAudioCount
        prefs.lastRecordingScanSummary = recordingScan.summary
        prefs.lastRecordingUnparsedSamples = recordingScan.unparsedSamples
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
            prefs.updateSyncProgress(
                "处理录音",
                total = pendingRecordings.size,
                processed = recordingProcessedCount,
                uploaded = recordingUploadedCount,
                failed = recordingFailureCount,
                current = recording.file.name
            )

            var call = prefs.findCall(recording.phone, recording.timestampMillis)
            if (call == null) {
                val match = backend.matchCallPhone(recording.phone)
                if (!match.matched) {
                    prefs.rememberRecordingListItem(recording, "非订单电话，已忽略")
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
                call = backend.lookupCall(recording.phone, recording.timestampMillis)
                if (call != null) prefs.rememberCall(call)
            }
            if (call == null) {
                prefs.lastRecordingMissCount += 1
                prefs.rememberRecordingListItem(recording, "未匹配")
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

            try {
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
                    prefs.markRecordingUploaded(path)
                    prefs.rememberRecordingListItem(recording, "已存在", call.id)
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
                backend.confirmRecordingUploaded(call.id)
                prefs.markRecordingUploaded(path)
                prefs.rememberRecordingListItem(recording, "已上传", call.id)
                recordingProcessedCount += 1
                recordingUploadedCount += 1
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
                recordingProcessedCount += 1
                lastRecordingFailure = "callId=${call.id} ${recording.file.name}: $message"
                prefs.rememberRecordingListItem(recording, "上传失败: $message", call.id)
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
        private val SYNC_LOCK = Any()
    }
}
