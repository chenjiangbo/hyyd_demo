package com.huanyu.collector

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {
    private lateinit var statusIcon: TextView
    private lateinit var statusLine: TextView
    private lateinit var syncSpinner: ProgressBar
    private lateinit var content: LinearLayout
    private lateinit var backendInput: EditText
    private lateinit var employeeCodeInput: EditText
    private var currentTab = Tab.OVERVIEW
    private var lastForegroundHeartbeatAt = 0L

    private val handler = Handler(Looper.getMainLooper())
    private val refreshTicker = object : Runnable {
        override fun run() {
            sendForegroundHeartbeatIfNeeded()
            refreshStatus()
            handler.postDelayed(this, 2_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        val prefs = AppPrefs(this)
        if (prefs.collectionEnabled) {
            try {
                CollectorWorkScheduler.ensureScheduled(this)
            } catch (e: Exception) {
                prefs.lastBackgroundWorkStatus = "调度失败: ${e.message ?: e.javaClass.simpleName}"
            }
        }
        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        sendForegroundHeartbeatIfNeeded(force = true)
        handler.post(refreshTicker)
        refreshStatus()
    }

    override fun onPause() {
        handler.removeCallbacks(refreshTicker)
        super.onPause()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(246, 248, 251))
        }

        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(18), dp(16), dp(8))
        }

        page.addView(header())
        page.addView(actions())

        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        page.addView(content)

        val scroll = ScrollView(this).apply {
            addView(page, ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
        }
        root.addView(scroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f
        ))
        root.addView(tabs())

        setContentView(root)
    }

    private fun header(): View {
        val box = section()
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        statusIcon = TextView(this).apply {
            text = "●"
            textSize = 28f
            setTextColor(Color.rgb(148, 163, 184))
            setPadding(0, 0, dp(10), 0)
        }
        val title = TextView(this).apply {
            text = "寰宇采集"
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(24, 32, 45))
        }
        statusLine = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(79, 91, 108))
            setPadding(0, dp(6), 0, 0)
        }
        syncSpinner = ProgressBar(this).apply {
            isIndeterminate = true
            visibility = View.GONE
        }
        row.addView(statusIcon)
        row.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(syncSpinner, LinearLayout.LayoutParams(dp(34), dp(34)))
        box.addView(row)
        box.addView(statusLine)
        return box
    }

    private fun actions(): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, dp(12))
        }
        row.addView(button("启动采集") { startCollectorService() }, weightParams())
        row.addView(space(dp(8)))
        row.addView(button("停止") { stopCollectorService() }, weightParams())
        row.addView(space(dp(8)))
        row.addView(button("检查后端") { checkBackendHealth() }, weightParams())
        return row
    }

    private fun tabs(): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(10), dp(8), dp(10), dp(10))
            setBackgroundColor(Color.WHITE)
        }
        row.addView(tabButton("首页", Tab.OVERVIEW), weightParams())
        row.addView(space(dp(6)))
        row.addView(tabButton("通话", Tab.CALLS), weightParams())
        row.addView(space(dp(6)))
        row.addView(tabButton("录音", Tab.RECORDINGS), weightParams())
        row.addView(space(dp(6)))
        row.addView(tabButton("设置", Tab.SETTINGS), weightParams())
        return row
    }

    private fun tabButton(label: String, tab: Tab): Button {
        return button(label) {
            currentTab = tab
            refreshStatus()
        }
    }

    private fun renderOverview(prefs: AppPrefs) {
        val serviceText = when {
            isCollectorRunning() -> "前台服务运行中"
            prefs.collectionEnabled -> "后台采集已启用"
            else -> "未启用"
        }
        content.addView(sectionTitle("运行状态"))
        content.addView(kvSection(listOf(
            "服务" to serviceText,
            "同步" to if (isSyncing(prefs)) "正在扫描/上传" else "空闲",
            "员工 ID" to prefs.employeeCode.ifBlank { "未配置" },
            "启动时间" to formatTs(prefs.serviceStartedAt),
            "历史补采起点" to formatTs(prefs.recordingScanFloorTs),
            "后台任务" to prefs.lastBackgroundWorkStatus,
            "后台任务开始" to formatTs(prefs.lastBackgroundWorkStartedAt),
            "后台任务完成" to formatTs(prefs.lastBackgroundWorkFinishedAt),
            "最近同步开始" to formatTs(prefs.lastSyncStartedAt),
            "最近同步完成" to formatTs(prefs.lastSyncFinishedAt),
            "最近错误" to prefs.lastSyncError.ifBlank { "无" }
        )))

        content.addView(sectionTitle("后端"))
        content.addView(kvSection(listOf(
            "地址" to prefs.backendUrl,
            "健康检查" to prefs.lastBackendHealth,
            "检查时间" to formatTs(prefs.lastBackendHealthAt)
        )))

        content.addView(sectionTitle("心跳"))
        content.addView(kvSection(listOf(
            "状态" to prefs.lastHeartbeatStatus,
            "发送给" to prefs.lastHeartbeatTarget.ifBlank { "无" },
            "发送时间" to formatTs(prefs.lastHeartbeatStartedAt),
            "完成时间" to formatTs(prefs.lastHeartbeatFinishedAt),
            "后端反馈" to prefs.lastHeartbeatResponse.ifBlank { "无" }
        )))

        content.addView(sectionTitle("最近一轮"))
        content.addView(kvSection(listOf(
            "通话扫描" to "${prefs.lastCallScanCount}",
            "通话上传" to "${prefs.lastCallUploadCount}",
            "待上传通话" to "${prefs.pendingCallCount()}",
            "录音扫描" to "${prefs.lastRecordingScanCount}",
            "录音上传" to "${prefs.lastRecordingUploadCount}",
            "录音未匹配" to "${prefs.lastRecordingMissCount}",
            "最近通话" to prefs.lastSyncedCallText,
            "最近录音" to prefs.lastUploadedRecordingText
        )))
    }

    private fun renderCalls(prefs: AppPrefs) {
        content.addView(sectionTitle("最近通话记录"))
        val arr = prefs.recentCalls()
        if (arr.length() == 0) {
            content.addView(emptyText("还没有同步到通话记录。启动采集后拨打或接听一次电话，最多 10 秒后这里会出现记录。"))
            return
        }
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val name = item.optString("contactName", "").ifBlank { "未知联系人" }
            content.addView(listItem(
                "${directionLabel(item)} · ${statusLabel(item.optString("callStatus"))} · ${item.optInt("durationSec")} 秒",
                "$name · ${item.optString("phone")}  ${formatTs(item.optLong("startedAtMillis"))}",
                if (item.optBoolean("uploaded")) "已上传到后端 #${item.optInt("id")}" else "未上传"
            ))
        }
    }

    private fun renderRecordings(prefs: AppPrefs) {
        content.addView(sectionTitle("最近录音文件"))
        val arr = prefs.recentRecordings()
        if (arr.length() == 0) {
            content.addView(emptyText("还没有扫描到可匹配的录音文件。请确认系统电话已开启自动录音。"))
            return
        }
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val callId = if (item.isNull("callId")) "" else " callId=${item.optInt("callId")}"
            content.addView(listItem(
                "${item.optString("status")}$callId",
                item.optString("name"),
                "${item.optString("phone")}  ${formatTs(item.optLong("timestampMillis"))}"
            ))
        }
    }

    private fun renderSettings() {
        val prefs = AppPrefs(this)
        content.addView(sectionTitle("连接配置"))
        val box = section()
        backendInput = EditText(this).apply {
            hint = "后端地址"
            setSingleLine(true)
            setText(prefs.backendUrl)
        }
        employeeCodeInput = EditText(this).apply {
            hint = "员工 ID"
            setSingleLine(true)
            setText(prefs.employeeCode)
        }
        box.addView(backendInput)
        box.addView(employeeCodeInput)
        box.addView(button("保存配置") { saveConfig(showToast = true) })
        box.addView(button("立即发送心跳") {
            if (saveConfig(showToast = false)) {
                Thread {
                    sendHeartbeat("手动")
                    runOnUiThread {
                        Toast.makeText(this, "心跳已发送：${AppPrefs(this).lastHeartbeatStatus}", Toast.LENGTH_SHORT).show()
                        refreshStatus()
                    }
                }.start()
            }
        })
        content.addView(box)

        content.addView(sectionTitle("最近心跳"))
        content.addView(kvSection(listOf(
            "状态" to prefs.lastHeartbeatStatus,
            "发送给" to prefs.lastHeartbeatTarget.ifBlank { "无" },
            "发送时间" to formatTs(prefs.lastHeartbeatStartedAt),
            "完成时间" to formatTs(prefs.lastHeartbeatFinishedAt),
            "后端反馈" to prefs.lastHeartbeatResponse.ifBlank { "无" }
        )))

        content.addView(sectionTitle("权限"))
        content.addView(kvSection(listOf(
            "READ_CALL_LOG" to yesNo(granted(Manifest.permission.READ_CALL_LOG)),
            "READ_PHONE_STATE" to yesNo(granted(Manifest.permission.READ_PHONE_STATE)),
            "音频读取" to yesNo(audioGranted()),
            "全部文件访问" to yesNo(Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager())
        )))
        content.addView(button("申请基础权限") { requestRuntimePermissions() })
        content.addView(button("打开全部文件访问权限") { openAllFilesAccessSettings() })
        content.addView(button("通知设置") { openNotificationSettings() })
        content.addView(button("申请忽略电池优化") { requestIgnoreBatteryOptimizations() })
        content.addView(button("应用详情 / 后台运行") { openAppDetailsSettings() })
        content.addView(button("华为应用启动管理") { openHuaweiStartupManager() })
        content.addView(emptyText("系统里还需要开启电话自动录音；华为应用启动管理中关闭自动管理，并允许自启动、关联启动和后台活动。"))
    }

    private fun refreshStatus() {
        val prefs = AppPrefs(this)
        val serviceRunning = isCollectorRunning()
        val service = when {
            serviceRunning -> "前台服务运行中"
            prefs.collectionEnabled -> "后台采集已启用"
            else -> "未启用"
        }
        val sync = if (isSyncing(prefs)) "同步中" else "空闲"
        val hasError = prefs.lastSyncError.isNotBlank()
        val pending = prefs.pendingCallCount()
        statusIcon.setTextColor(
            when {
                !prefs.collectionEnabled -> Color.rgb(148, 163, 184)
                hasError -> Color.rgb(239, 68, 68)
                !serviceRunning || pending > 0 || isSyncing(prefs) -> Color.rgb(245, 158, 11)
                else -> Color.rgb(16, 185, 129)
            }
        )
        statusLine.text = "$service · $sync · 待上传 $pending · ${prefs.employeeCode.ifBlank { "未配置员工 ID" }}"
        syncSpinner.visibility = if (isSyncing(prefs)) View.VISIBLE else View.GONE
        if (currentTab == Tab.SETTINGS &&
            ((::backendInput.isInitialized && backendInput.isFocused) ||
                (::employeeCodeInput.isInitialized && employeeCodeInput.isFocused))
        ) {
            return
        }
        content.removeAllViews()
        when (currentTab) {
            Tab.OVERVIEW -> renderOverview(prefs)
            Tab.CALLS -> renderCalls(prefs)
            Tab.RECORDINGS -> renderRecordings(prefs)
            Tab.SETTINGS -> renderSettings()
        }
    }

    private fun requestRuntimePermissions() {
        val permissions = mutableListOf(
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_PHONE_STATE
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.READ_MEDIA_AUDIO)
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        val missing = permissions
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
            .toTypedArray()
        if (missing.isNotEmpty()) requestPermissions(missing, 100)
    }

    private fun openAllFilesAccessSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val uri = Uri.parse("package:$packageName")
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, uri)
        startActivity(intent)
    }

    private fun openNotificationSettings() {
        startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        })
    }

    private fun requestIgnoreBatteryOptimizations() {
        val powerManager = getSystemService(PowerManager::class.java)
        if (powerManager.isIgnoringBatteryOptimizations(packageName)) {
            Toast.makeText(this, "已经忽略电池优化", Toast.LENGTH_SHORT).show()
            return
        }
        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        })
    }

    private fun openAppDetailsSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:$packageName")
        })
    }

    private fun openHuaweiStartupManager() {
        val intent = Intent().apply {
            component = ComponentName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
            )
        }
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "当前手机没有华为应用启动管理页面", Toast.LENGTH_LONG).show()
        }
    }

    private fun startCollectorService() {
        if (currentTab == Tab.SETTINGS && !saveConfig(showToast = false)) return
        try {
            AppPrefs(this).validateConfig()
        } catch (e: Exception) {
            Toast.makeText(this, e.message ?: "配置无效", Toast.LENGTH_LONG).show()
            currentTab = Tab.SETTINGS
            refreshStatus()
            return
        }
        val prefs = AppPrefs(this)
        try {
            prefs.collectionEnabled = true
            CollectorWorkScheduler.ensureScheduled(this)
            val intent = Intent(this, CollectorService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        } catch (e: Exception) {
            prefs.collectionEnabled = false
            CollectorWorkScheduler.cancel(this)
            Toast.makeText(this, "启动采集失败: ${e.message ?: e.javaClass.simpleName}", Toast.LENGTH_LONG).show()
            refreshStatus()
            return
        }
        Toast.makeText(this, "采集服务已启动", Toast.LENGTH_SHORT).show()
        refreshStatus()
    }

    private fun stopCollectorService() {
        AppPrefs(this).collectionEnabled = false
        CollectorWorkScheduler.cancel(this)
        stopService(Intent(this, CollectorService::class.java))
        Toast.makeText(this, "采集服务已停止", Toast.LENGTH_SHORT).show()
        refreshStatus()
    }

    private fun saveConfig(showToast: Boolean = false): Boolean {
        val prefs = AppPrefs(this)
        if (::backendInput.isInitialized) prefs.backendUrl = backendInput.text.toString()
        if (::employeeCodeInput.isInitialized) prefs.employeeCode = employeeCodeInput.text.toString()
        return try {
            prefs.validateConfig()
            if (showToast) Toast.makeText(this, "配置已保存", Toast.LENGTH_SHORT).show()
            refreshStatus()
            true
        } catch (e: Exception) {
            Toast.makeText(this, e.message ?: "配置无效", Toast.LENGTH_LONG).show()
            refreshStatus()
            false
        }
    }

    private fun checkBackendHealth() {
        val prefs = AppPrefs(this)
        if (currentTab == Tab.SETTINGS && !saveConfig(showToast = false)) return
        try {
            prefs.validateConfig()
        } catch (e: Exception) {
            Toast.makeText(this, e.message ?: "配置无效", Toast.LENGTH_LONG).show()
            refreshStatus()
            return
        }

        Thread {
            val (ok, result) = try {
                val backend = BackendClient(prefs.backendUrl, prefs.employeeCode)
                val text = backend.health()
                sendHeartbeat("检查后端")
                true to text
            } catch (e: Exception) {
                false to "失败：${e.message ?: e.javaClass.simpleName}"
            }
            prefs.lastBackendHealth = result
            prefs.lastBackendHealthAt = System.currentTimeMillis()
            runOnUiThread {
                Toast.makeText(
                    this,
                    if (ok) "后端连接成功" else result,
                    if (ok) Toast.LENGTH_SHORT else Toast.LENGTH_LONG
                ).show()
                refreshStatus()
            }
        }.start()
    }

    private fun sendForegroundHeartbeatIfNeeded(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastForegroundHeartbeatAt < 20_000) return
        val prefs = AppPrefs(this)
        try {
            prefs.validateConfig()
        } catch (_: Exception) {
            return
        }
        lastForegroundHeartbeatAt = now
        Thread { sendHeartbeat("前台") }.start()
    }

    private fun sendHeartbeat(source: String) {
        val prefs = AppPrefs(this)
        val target = "${prefs.backendUrl}/api/v1/me/mobile-heartbeat"
        prefs.lastHeartbeatStartedAt = System.currentTimeMillis()
        prefs.lastHeartbeatTarget = "$target · 员工 ${prefs.employeeCode.ifBlank { "未配置" }} · $source"
        prefs.lastHeartbeatStatus = "发送中"
        prefs.lastHeartbeatResponse = ""
        try {
            prefs.validateConfig()
            val response = BackendClient(prefs.backendUrl, prefs.employeeCode).heartbeat(source)
            prefs.lastHeartbeatFinishedAt = System.currentTimeMillis()
            prefs.lastHeartbeatStatus = "成功"
            prefs.lastHeartbeatResponse = response
        } catch (e: Exception) {
            prefs.lastHeartbeatFinishedAt = System.currentTimeMillis()
            prefs.lastHeartbeatStatus = "失败"
            prefs.lastHeartbeatResponse = e.message ?: e.javaClass.simpleName
        }
    }

    private fun sectionTitle(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(25, 35, 50))
            setPadding(0, dp(12), 0, dp(8))
        }
    }

    private fun kvSection(rows: List<Pair<String, String>>): View {
        val box = section()
        for ((label, value) in rows) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(4), 0, dp(4))
            }
            row.addView(TextView(this).apply {
                text = label
                textSize = 14f
                setTextColor(Color.rgb(86, 98, 115))
            }, LinearLayout.LayoutParams(dp(100), ViewGroup.LayoutParams.WRAP_CONTENT))
            row.addView(TextView(this).apply {
                text = value
                textSize = 14f
                setTextColor(Color.rgb(22, 30, 44))
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            box.addView(row)
        }
        return box
    }

    private fun listItem(title: String, subtitle: String, footer: String): View {
        val box = section()
        box.addView(TextView(this).apply {
            text = title
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(25, 35, 50))
        })
        box.addView(TextView(this).apply {
            text = subtitle
            textSize = 13f
            setTextColor(Color.rgb(67, 79, 96))
            setPadding(0, dp(5), 0, dp(3))
        })
        box.addView(TextView(this).apply {
            text = footer
            textSize = 12f
            setTextColor(Color.rgb(96, 111, 132))
        })
        return box
    }

    private fun emptyText(text: String): View {
        return section().apply {
            addView(TextView(this@MainActivity).apply {
                this.text = text
                textSize = 14f
                setTextColor(Color.rgb(85, 96, 112))
            })
        }
    }

    private fun button(text: String, onClick: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            setAllCaps(false)
            setOnClickListener { onClick() }
        }
    }

    private fun section(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(8).toFloat()
                setStroke(1, Color.rgb(225, 230, 238))
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = dp(10)
            }
        }
    }

    private fun space(width: Int): View {
        return View(this).apply {
            layoutParams = LinearLayout.LayoutParams(width, 1)
        }
    }

    private fun weightParams(): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }

    private fun directionLabel(item: JSONObject): String {
        return if (item.optString("direction") == "out") "呼出" else "来电"
    }

    private fun statusLabel(status: String): String {
        return when (status) {
            "answered" -> "已接通"
            "missed" -> "未接"
            "rejected" -> "拒接/拦截"
            "outgoing_unanswered" -> "未接通"
            else -> status.ifBlank { "未知" }
        }
    }

    private fun audioGranted(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted(Manifest.permission.READ_MEDIA_AUDIO)
        } else {
            granted(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun granted(permission: String): Boolean {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun yesNo(value: Boolean): String = if (value) "已允许" else "未允许"

    private fun formatTs(value: Long): String {
        if (value <= 0L) return "无"
        return SimpleDateFormat("MM-dd HH:mm:ss", Locale.CHINA).format(Date(value))
    }

    private fun isSyncing(prefs: AppPrefs): Boolean {
        return prefs.lastSyncStartedAt > prefs.lastSyncFinishedAt &&
            System.currentTimeMillis() - prefs.lastSyncStartedAt < 30_000
    }

    @Suppress("DEPRECATION")
    private fun isCollectorRunning(): Boolean {
        val manager = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return manager.getRunningServices(Int.MAX_VALUE).any {
            it.service.className == CollectorService::class.java.name
        }
    }

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }

    enum class Tab {
        OVERVIEW,
        CALLS,
        RECORDINGS,
        SETTINGS
    }
}
