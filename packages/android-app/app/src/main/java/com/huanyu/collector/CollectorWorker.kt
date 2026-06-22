package com.huanyu.collector

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class CollectorWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : Worker(appContext, workerParams) {
    override fun doWork(): Result {
        val prefs = AppPrefs(applicationContext)
        if (!prefs.collectionEnabled) return Result.success()

        prefs.lastBackgroundWorkStartedAt = System.currentTimeMillis()
        prefs.lastBackgroundWorkStatus = "运行中"
        val runner = CollectorRunner(applicationContext)
        return try {
            prefs.validateConfig()
            val heartbeatOk = runner.sendHeartbeat("work_manager")
            prefs.lastSyncStartedAt = System.currentTimeMillis()
            runner.syncOnce()
            prefs.lastSyncFinishedAt = System.currentTimeMillis()
            prefs.lastBackgroundWorkFinishedAt = System.currentTimeMillis()
            prefs.lastBackgroundWorkStatus = if (heartbeatOk) "成功" else "心跳失败，等待重试"
            if (heartbeatOk) Result.success() else Result.retry()
        } catch (e: Exception) {
            val message = e.message ?: e.javaClass.simpleName
            prefs.lastSyncError = message
            prefs.lastBackgroundWorkFinishedAt = System.currentTimeMillis()
            prefs.lastBackgroundWorkStatus = "失败: $message"
            Result.retry()
        }
    }
}
