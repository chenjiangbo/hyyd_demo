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
    private val heartbeatExecutor = Executors.newSingleThreadExecutor()
    private var loop: Future<*>? = null
    private var heartbeatLoop: Future<*>? = null
    @Volatile private var running = false
    private lateinit var runner: CollectorRunner

    override fun onCreate() {
        super.onCreate()
        runner = CollectorRunner(this)
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
        if (heartbeatLoop == null || heartbeatLoop?.isDone == true) {
            running = true
            heartbeatLoop = heartbeatExecutor.submit { runHeartbeatLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        loop?.cancel(true)
        heartbeatLoop?.cancel(true)
        executor.shutdownNow()
        heartbeatExecutor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "前台 dataSync 服务达到系统时限，停止服务并交由 WorkManager 继续")
        stopSelf(startId)
    }

    private fun runLoop() {
        while (running) {
            val prefs = AppPrefs(this)
            prefs.lastSyncStartedAt = System.currentTimeMillis()
            prefs.lastSyncError = ""
            try {
                runner.syncOnce()
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

    private fun runHeartbeatLoop() {
        while (running) {
            runner.sendHeartbeat("foreground_service")
            try {
                Thread.sleep(20_000)
            } catch (_: InterruptedException) {
                return
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
