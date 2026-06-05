package com.huanyu.collector

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.Future

class CollectorService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private var loop: Future<*>? = null
    @Volatile private var running = false

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "CollectorService onCreate")
        AppPrefs(this).serviceStartedAt = System.currentTimeMillis()
        startForeground(1001, buildNotification("寰宇业务采集运行中"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "CollectorService onStartCommand startId=$startId")
        if (loop == null || loop?.isDone == true) {
            running = true
            loop = executor.submit { runLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        loop?.cancel(true)
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun runLoop() {
        while (running) {
            val prefs = AppPrefs(this)
            prefs.lastSyncStartedAt = System.currentTimeMillis()
            prefs.lastSyncError = ""
            try {
                syncOnce()
                prefs.lastSyncFinishedAt = System.currentTimeMillis()
            } catch (e: Exception) {
                Log.e(TAG, "同步失败", e)
                prefs.lastSyncError = e.message ?: e.javaClass.simpleName
            }
            try {
                Thread.sleep(10_000)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    private fun syncOnce() {
        Log.i(TAG, "开始同步通话记录和录音")
        val prefs = AppPrefs(this)
        prefs.validateConfig()
        if (prefs.lastCallLogTs == 0L) {
            prefs.lastCallLogTs = System.currentTimeMillis()
            Log.i(TAG, "首次启动，已初始化通话同步游标。请在服务启动后拨打测试电话。")
        }
        val backend = BackendClient(prefs.backendUrl, prefs.employeeCode)
        val health = backend.health()
        prefs.lastBackendHealth = health
        prefs.lastBackendHealthAt = System.currentTimeMillis()

        val pendingCalls = prefs.pendingCalls()
        for (call in pendingCalls) {
            try {
                val remote = backend.postCall(call)
                prefs.removePendingCall(call)
                prefs.rememberCall(remote)
                prefs.rememberCallListItem(remote, uploaded = true)
                Log.i(TAG, "待上传通话已同步: id=${remote.id} phone=${remote.phone}")
            } catch (e: Exception) {
                prefs.rememberLocalCallListItem(call, "上传失败")
                throw IllegalStateException("待上传通话同步失败: ${e.message}", e)
            }
        }

        val calls = CallLogScanner(this).scanSince(prefs.lastCallLogTs)
        prefs.lastCallScanCount = calls.size
        prefs.lastCallUploadCount = 0
        Log.i(TAG, "扫描到新增通话 ${calls.size} 条，lastCallLogTs=${prefs.lastCallLogTs}")
        var maxSyncedTs = prefs.lastCallLogTs

        for (call in calls) {
            maxSyncedTs = maxOf(maxSyncedTs, call.startedAtMillis)
            prefs.lastCallLogTs = maxSyncedTs
            try {
                val remote = backend.postCall(call)
                prefs.rememberCall(remote)
                prefs.rememberCallListItem(remote, uploaded = true)
                prefs.lastCallUploadCount = prefs.lastCallUploadCount + 1
                val person = remote.contactName?.takeIf { it.isNotBlank() } ?: remote.phone
                prefs.lastSyncedCallText = "id=${remote.id} ${person} ${remote.callStatus} ${remote.durationSec}s"
                Log.i(TAG, "通话已同步: id=${remote.id} phone=${remote.phone}")
            } catch (e: Exception) {
                prefs.addPendingCall(call)
                prefs.rememberLocalCallListItem(call, "待上传")
                Log.e(TAG, "通话上传失败，已加入待上传队列: phone=${call.phone}", e)
            }
        }

        val recordings = RecordingScanner().scan()
        prefs.lastRecordingScanCount = recordings.size
        prefs.lastRecordingUploadCount = 0
        prefs.lastRecordingMissCount = 0
        Log.i(TAG, "扫描到录音文件 ${recordings.size} 个")
        for (recording in recordings) {
            val path = recording.file.absolutePath
            if (prefs.isRecordingUploaded(path)) continue

            val call = prefs.findCall(recording.phone, recording.timestampMillis)
            if (call == null) {
                prefs.lastRecordingMissCount = prefs.lastRecordingMissCount + 1
                prefs.rememberRecordingListItem(recording, "未匹配")
                Log.w(TAG, "录音暂未匹配到已同步通话: $path")
                continue
            }

            try {
                val uploadUrl = backend.registerRecording(call, recording)
                backend.uploadFile(uploadUrl, recording.file)
                prefs.markRecordingUploaded(path)
                prefs.rememberRecordingListItem(recording, "已上传", call.id)
                prefs.lastRecordingUploadCount = prefs.lastRecordingUploadCount + 1
                prefs.lastUploadedRecordingText = "callId=${call.id} ${recording.file.name}"
                Log.i(TAG, "录音已上传: callId=${call.id} file=$path")
            } catch (e: Exception) {
                prefs.rememberRecordingListItem(recording, "上传失败", call.id)
                throw e
            }
        }
    }

    private fun buildNotification(text: String): Notification {
        val channelId = "huanyu_collector"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(channelId, "寰宇采集", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        return Notification.Builder(this, channelId)
            .setContentTitle("寰宇采集")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "HuanyuCollector"
    }
}
