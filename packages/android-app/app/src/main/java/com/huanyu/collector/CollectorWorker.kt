package com.huanyu.collector

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

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
        var heartbeatScheduler: ScheduledExecutorService? = null
        return try {
            prefs.validateConfig()
            val heartbeatOk = runner.sendHeartbeat("work_manager")
            heartbeatScheduler = Executors.newSingleThreadScheduledExecutor { task ->
                Thread(task, "mobile-status-heartbeat").apply { isDaemon = true }
            }
            heartbeatScheduler.scheduleAtFixedRate(
                { runner.sendHeartbeat("work_manager") },
                20,
                20,
                TimeUnit.SECONDS
            )
            runner.syncOnce()
            prefs.lastBackgroundWorkFinishedAt = System.currentTimeMillis()
            prefs.lastBackgroundWorkStatus = if (heartbeatOk) "成功" else "心跳失败，等待重试"
            if (heartbeatOk) Result.success() else Result.retry()
        } catch (e: Exception) {
            val message = e.message ?: e.javaClass.simpleName
            prefs.lastSyncError = message
            prefs.lastBackgroundWorkFinishedAt = System.currentTimeMillis()
            prefs.lastBackgroundWorkStatus = "失败: $message"
            Result.retry()
        } finally {
            heartbeatScheduler?.shutdownNow()
            runner.sendHeartbeat("work_manager")
        }
    }
}
