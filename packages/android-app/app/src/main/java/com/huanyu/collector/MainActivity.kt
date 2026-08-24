package com.huanyu.collector

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.content.ActivityNotFoundException
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
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

class MainActivity : Activity() {
    private lateinit var statusDot: TextView
    private lateinit var statusLine: TextView
    private lateinit var syncSpinner: ProgressBar
    private lateinit var content: LinearLayout
    private lateinit var bottomNav: LinearLayout
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
            setBackgroundColor(COLOR_BACKGROUND)
        }

        root.addView(topAppBar())

        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(18))
        }
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

        bottomNav = LinearLayout(this)
        root.addView(bottomNav)
        setContentView(root)
    }

    private fun topAppBar(): View {
        val wrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_SURFACE)
            elevation = dp(2).toFloat()
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(8), dp(18), dp(8))
            setBackgroundColor(COLOR_SURFACE)
        }
        bar.addView(iconView(R.drawable.ic_analytics, COLOR_ON_SURFACE_VARIANT, 26), LinearLayout.LayoutParams(dp(38), dp(48)))
        bar.addView(TextView(this).apply {
            text = "寰宇采集"
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_PRIMARY)
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), 0, 0, 0)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        syncSpinner = ProgressBar(this).apply {
            isIndeterminate = true
            visibility = View.GONE
        }
        bar.addView(syncSpinner, LinearLayout.LayoutParams(dp(32), dp(32)))
        bar.addView(iconView(R.drawable.ic_sync, COLOR_ON_SURFACE_VARIANT, 26).apply {
            setOnClickListener {
                currentTab = Tab.SYNC
                refreshStatus()
            }
        }, LinearLayout.LayoutParams(dp(44), dp(48)))

        val status = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(22), 0, dp(18), dp(10))
            setBackgroundColor(COLOR_SURFACE)
        }
        statusDot = TextView(this).apply {
            text = "●"
            textSize = 18f
            setTextColor(COLOR_NEUTRAL)
            gravity = Gravity.CENTER
        }
        statusLine = TextView(this).apply {
            textSize = 12f
            setTextColor(COLOR_ON_SURFACE_VARIANT)
            setPadding(dp(8), 0, 0, 0)
        }
        status.addView(statusDot, LinearLayout.LayoutParams(dp(20), ViewGroup.LayoutParams.WRAP_CONTENT))
        status.addView(statusLine, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        wrapper.addView(bar)
        wrapper.addView(status)
        return wrapper
    }

    private fun renderOverview(prefs: AppPrefs) {
        val serviceRunning = isCollectorRunning()
        val serviceText = when {
            serviceRunning -> "前台服务运行中"
            prefs.collectionEnabled -> "后台采集已启用"
            else -> "未启用"
        }
        val progressPercent = recordingProgressPercent(prefs)
        val currentFile = prefs.lastRecordingProgressCurrent.ifBlank { "无" }

        content.addView(statusCard(
            title = "服务状态",
            badge = if (prefs.collectionEnabled) "运行中" else "未启用",
            badgeKind = if (prefs.collectionEnabled) Kind.SUCCESS else Kind.NEUTRAL,
            rows = listOf(
                "员工 ID" to prefs.employeeCode.ifBlank { "未配置" },
                "后端服务" to compactBackend(prefs.backendUrl),
                "服务" to serviceText,
                "心跳" to prefs.lastHeartbeatStatus
            ),
            progressLabel = "录音同步进度",
            progressValue = progressPercent
        ))

        content.addView(summaryCard(
            title = "最近同步",
            iconRes = R.drawable.ic_sync,
            rows = listOf(
                "通话处理" to "${prefs.lastCallScanCount}",
                "通话上传" to "${prefs.lastCallUploadCount}",
                "录音待处理" to "${prefs.lastRecordingProgressTotal}",
                "录音已上传" to "${prefs.lastRecordingProgressUploaded}",
                "上传失败" to "${prefs.lastRecordingProgressFailed}",
                "最近检查" to formatTs(maxOf(prefs.lastSyncFinishedAt, prefs.lastBackendHealthAt))
            )
        ))

        val progressRows = listOf(
            "当前阶段" to syncStatusText(prefs),
            "当前文件" to currentFile,
            "处理进度" to recordingProgressText(prefs),
            "最近错误" to prefs.lastSyncError.ifBlank { "无" }
        )
        content.addView(summaryCard("同步详情", R.drawable.ic_sync, progressRows, highlight = isSyncing(prefs)))

        content.addView(summaryCard(
            title = "系统状态",
            iconRes = R.drawable.ic_health,
            rows = listOf(
                "后端 API" to prefs.lastBackendHealth,
                "后台任务" to prefs.lastBackgroundWorkStatus,
                "后台完成" to formatTs(prefs.lastBackgroundWorkFinishedAt),
                "待上传通话" to "${prefs.pendingCallCount()}"
            )
        ))

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(10), 0, dp(2))
        }
        actions.addView(actionButton("▶ 启动采集", Kind.PRIMARY) { startCollectorService() }, weightParams())
        actions.addView(space(dp(12)))
        actions.addView(actionButton("□ 停止服务", Kind.ERROR) { stopCollectorService() }, weightParams())
        content.addView(actions)
        content.addView(outlineButton("检查后端") { checkBackendHealth() })
    }

    private fun renderCalls(prefs: AppPrefs) {
        content.addView(pageHeader("最近通话", "显示已扫描到的通话记录和上传结果"))
        val arr = prefs.recentCalls()
        if (arr.length() == 0) {
            content.addView(emptyCard("还没有同步到通话记录。启动采集后拨打或接听一次电话，最多 10 秒后这里会出现记录。"))
            return
        }
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val uploaded = item.optBoolean("uploaded")
            val status = if (uploaded) "已上传" else item.optString("localStatus", "未上传")
            val kind = when {
                uploaded -> Kind.SUCCESS
                status.contains("失败") -> Kind.ERROR
                status.contains("待") -> Kind.WARNING
                else -> Kind.NEUTRAL
            }
            val idText = if (item.isNull("id")) "ID: 无" else "ID: ${item.optInt("id")}"
            val name = item.optString("contactName", "").ifBlank { "未知联系人" }
            content.addView(callCard(
                directionIconRes = directionIconRes(item),
                directionColor = directionColor(item),
                name = name,
                phone = item.optString("phone"),
                time = formatTs(item.optLong("startedAtMillis")),
                duration = durationText(item.optInt("durationSec")),
                status = status,
                statusKind = kind,
                idText = idText,
                callStatus = statusLabel(item.optString("callStatus"))
            ))
        }
    }

    private fun renderRecordings(prefs: AppPrefs) {
        content.addView(pageHeader("最近录音", "显示录音扫描、匹配和上传结果"))
        content.addView(metricGrid(listOf(
            "总音频" to "${prefs.lastRecordingTotalFileCount}",
            "游标后" to "${prefs.lastRecordingRawFileCount}",
            "可解析" to "${prefs.lastRecordingScanCount}",
            "未匹配" to "${prefs.lastRecordingMissCount}"
        )))

        val arr = prefs.recentRecordings()
        if (arr.length() == 0) {
            content.addView(emptyCard("还没有扫描到可匹配的录音文件。请确认系统电话已开启自动录音。"))
            return
        }
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            val status = item.optString("status")
            val kind = when {
                status.contains("上传失败") -> Kind.ERROR
                status.contains("未匹配") || status.contains("忽略") || status.contains("未识别") -> Kind.WARNING
                status.contains("已上传") || status.contains("已存在") -> Kind.SUCCESS
                else -> Kind.NEUTRAL
            }
            val callId = if (item.isNull("callId")) "关联通话: 无" else "关联通话: ${item.optInt("callId")}"
            content.addView(recordingCard(
                name = item.optString("name"),
                phone = item.optString("phone"),
                time = formatTs(item.optLong("timestampMillis")),
                status = status,
                statusKind = kind,
                footer = callId
            ))
        }
    }

    private fun renderSyncDetails(prefs: AppPrefs) {
        content.addView(pageHeader("同步详情", "查看当前扫描和上传过程"))
        content.addView(summaryCard(
            title = "当前进度",
            iconRes = R.drawable.ic_sync,
            rows = listOf(
                "阶段" to syncStatusText(prefs),
                "录音总数" to "${prefs.lastRecordingProgressTotal}",
                "已处理" to "${prefs.lastRecordingProgressProcessed}",
                "已上传" to "${prefs.lastRecordingProgressUploaded}",
                "失败" to "${prefs.lastRecordingProgressFailed}",
                "当前文件" to prefs.lastRecordingProgressCurrent.ifBlank { "无" },
                "更新时间" to formatTs(prefs.lastSyncProgressAt)
            ),
            highlight = isSyncing(prefs)
        ))
        content.addView(progressCard(prefs))
        content.addView(summaryCard(
            title = "扫描诊断",
            iconRes = R.drawable.ic_audio_file,
            rows = listOf(
                "总音频文件" to "${prefs.lastRecordingTotalFileCount}",
                "游标后音频" to "${prefs.lastRecordingRawFileCount}",
                "可解析录音" to "${prefs.lastRecordingScanCount}",
                "未匹配录音" to "${prefs.lastRecordingMissCount}",
                "最近上传" to prefs.lastUploadedRecordingText
            )
        ))
        val summary = prefs.lastRecordingScanSummary
        if (summary.isNotBlank()) content.addView(logCard("扫描目录", summary))
        val unparsed = prefs.lastRecordingUnparsedSamples
        if (unparsed.isNotBlank()) content.addView(logCard("未识别文件名", unparsed))
    }

    private fun renderSettings() {
        val prefs = AppPrefs(this)
        content.addView(pageHeader("设置", "配置后端地址、员工 ID 和系统权限"))

        val box = card()
        box.addView(sectionHeader("连接配置", "后端地址和员工 ID 必须配置正确"))
        backendInput = EditText(this).apply {
            hint = "后端地址"
            setSingleLine(true)
            setText(prefs.backendUrl)
            setTextColor(COLOR_ON_SURFACE)
            setHintTextColor(COLOR_ON_SURFACE_VARIANT)
            background = roundedBg(COLOR_SURFACE_LOW, dp(8), COLOR_OUTLINE, 1)
            setPadding(dp(12), 0, dp(12), 0)
        }
        employeeCodeInput = EditText(this).apply {
            hint = "员工 ID"
            setSingleLine(true)
            setText(prefs.employeeCode)
            setTextColor(COLOR_ON_SURFACE)
            setHintTextColor(COLOR_ON_SURFACE_VARIANT)
            background = roundedBg(COLOR_SURFACE_LOW, dp(8), COLOR_OUTLINE, 1)
            setPadding(dp(12), 0, dp(12), 0)
        }
        box.addView(backendInput, inputParams())
        box.addView(employeeCodeInput, inputParams())
        box.addView(actionButton("保存配置", Kind.PRIMARY) { saveConfig(showToast = true) })
        box.addView(outlineButton("立即发送心跳") {
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

        content.addView(summaryCard(
            title = "最近心跳",
            iconRes = R.drawable.ic_health,
            rows = listOf(
                "状态" to prefs.lastHeartbeatStatus,
                "发送给" to prefs.lastHeartbeatTarget.ifBlank { "无" },
                "发送时间" to formatTs(prefs.lastHeartbeatStartedAt),
                "完成时间" to formatTs(prefs.lastHeartbeatFinishedAt),
                "后端反馈" to prefs.lastHeartbeatResponse.ifBlank { "无" }
            )
        ))

        content.addView(pageHeader("权限", "系统权限会影响通话和录音读取"))
        content.addView(permissionGrid())
        content.addView(actionButton("申请基础权限", Kind.PRIMARY) { requestRuntimePermissions() })
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            content.addView(outlineButton("打开全部文件访问权限") { openAllFilesAccessSettings() })
        } else {
            content.addView(outlineButton("打开应用权限设置") { openAppDetailsSettings() })
            content.addView(emptyCard("Android 10 不支持全部文件访问入口；请通过申请基础权限或应用权限设置允许存储/文件和媒体权限。"))
        }
        content.addView(outlineButton("通知设置") { openNotificationSettings() })
        content.addView(outlineButton("申请忽略电池优化") { requestIgnoreBatteryOptimizations() })
        content.addView(outlineButton("应用详情 / 后台运行") { openAppDetailsSettings() })
        content.addView(outlineButton("华为应用启动管理") { openHuaweiStartupManager() })
        content.addView(emptyCard("系统里还需要开启电话自动录音；华为应用启动管理中关闭自动管理，并允许自启动、关联启动和后台活动。"))
    }

    private fun refreshStatus() {
        val prefs = AppPrefs(this)
        val serviceRunning = isCollectorRunning()
        val hasError = prefs.lastSyncError.isNotBlank()
        val pending = prefs.pendingCallCount()
        statusDot.setTextColor(
            when {
                !prefs.collectionEnabled -> COLOR_NEUTRAL
                hasError -> COLOR_ERROR
                !serviceRunning || pending > 0 || isSyncing(prefs) -> COLOR_WARNING
                else -> COLOR_SUCCESS
            }
        )
        val serviceText = when {
            serviceRunning -> "前台服务运行中"
            prefs.collectionEnabled -> "后台采集已启用"
            else -> "未启用"
        }
        statusLine.text = "$serviceText · ${syncStatusText(prefs)} · 待上传 $pending · ${prefs.employeeCode.ifBlank { "未配置员工 ID" }}"
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
            Tab.SYNC -> renderSyncDetails(prefs)
            Tab.SETTINGS -> renderSettings()
        }
        renderBottomNav()
    }

    private fun renderBottomNav() {
        bottomNav.removeAllViews()
        bottomNav.orientation = LinearLayout.HORIZONTAL
        bottomNav.gravity = Gravity.CENTER
        bottomNav.setPadding(dp(14), dp(8), dp(14), dp(10))
        bottomNav.background = roundedBg(COLOR_SURFACE, dp(18), Color.TRANSPARENT, 0)
        bottomNav.elevation = dp(10).toFloat()
        bottomNav.addView(navButton(R.drawable.ic_dashboard, "首页", Tab.OVERVIEW), weightParams())
        bottomNav.addView(navButton(R.drawable.ic_call, "通话", Tab.CALLS), weightParams())
        bottomNav.addView(navButton(R.drawable.ic_mic, "录音", Tab.RECORDINGS), weightParams())
        bottomNav.addView(navButton(R.drawable.ic_sync, "同步", Tab.SYNC), weightParams())
        bottomNav.addView(navButton(R.drawable.ic_settings, "设置", Tab.SETTINGS), weightParams())
    }

    private fun navButton(iconRes: Int, label: String, tab: Tab): View {
        val active = currentTab == tab
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(4), dp(6), dp(4), dp(5))
            background = if (active) roundedBg(Color.rgb(77, 142, 254), dp(28), Color.TRANSPARENT, 0) else null
            setOnClickListener {
                currentTab = tab
                refreshStatus()
            }
            addView(iconView(iconRes, if (active) COLOR_ON_PRIMARY else COLOR_ON_SURFACE_VARIANT, 24))
            addView(TextView(this@MainActivity).apply {
                text = label
                textSize = 11f
                gravity = Gravity.CENTER
                setTextColor(if (active) COLOR_ON_PRIMARY else COLOR_ON_SURFACE_VARIANT)
            })
        }
    }

    private fun iconView(iconRes: Int, color: Int, sizeDp: Int): ImageView {
        return ImageView(this).apply {
            setImageResource(iconRes)
            setColorFilter(color)
            scaleType = ImageView.ScaleType.CENTER
            adjustViewBounds = false
            layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
        }
    }

    private fun circleIcon(iconRes: Int, iconColor: Int, backgroundColor: Int, boxDp: Int, iconDp: Int): View {
        return LinearLayout(this).apply {
            gravity = Gravity.CENTER
            background = roundedBg(backgroundColor, dp(boxDp / 2), Color.TRANSPARENT, 0)
            addView(iconView(iconRes, iconColor, iconDp))
            layoutParams = LinearLayout.LayoutParams(dp(boxDp), dp(boxDp))
        }
    }

    private fun statusCard(
        title: String,
        badge: String,
        badgeKind: Kind,
        rows: List<Pair<String, String>>,
        progressLabel: String,
        progressValue: Int
    ): View {
        val box = card()
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(TextView(this).apply {
            text = title
            textSize = 20f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_ON_SURFACE)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(badge(badge, badgeKind))
        box.addView(head)
        box.addView(twoColumnRows(rows), LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(18) })
        box.addView(divider())
        val progressHead = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        progressHead.addView(TextView(this).apply {
            text = progressLabel
            textSize = 14f
            setTextColor(COLOR_ON_SURFACE_VARIANT)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        progressHead.addView(TextView(this).apply {
            text = "$progressValue%"
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_PRIMARY)
        })
        box.addView(progressHead)
        box.addView(horizontalProgress(progressValue))
        return box
    }

    private fun summaryCard(title: String, iconRes: Int, rows: List<Pair<String, String>>, highlight: Boolean = false): View {
        val box = card(stroke = if (highlight) COLOR_PRIMARY else COLOR_OUTLINE)
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(iconView(iconRes, COLOR_PRIMARY, 26), LinearLayout.LayoutParams(dp(42), dp(36)))
        head.addView(TextView(this).apply {
            text = title
            textSize = 19f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_ON_SURFACE)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        box.addView(head)
        for ((label, value) in rows) {
            box.addView(keyValueRow(label, value))
        }
        return box
    }

    private fun progressCard(prefs: AppPrefs): View {
        val box = card(stroke = if (prefs.lastRecordingProgressFailed > 0) COLOR_ERROR else COLOR_OUTLINE)
        box.addView(sectionHeader("录音上传队列", "当前轮次的文件处理情况"))
        box.addView(horizontalProgress(recordingProgressPercent(prefs)))
        box.addView(keyValueRow("总数", "${prefs.lastRecordingProgressTotal}"))
        box.addView(keyValueRow("已处理", "${prefs.lastRecordingProgressProcessed}"))
        box.addView(keyValueRow("已上传", "${prefs.lastRecordingProgressUploaded}"))
        box.addView(keyValueRow("失败", "${prefs.lastRecordingProgressFailed}"))
        box.addView(keyValueRow("当前文件", prefs.lastRecordingProgressCurrent.ifBlank { "无" }))
        return box
    }

    private fun metricGrid(rows: List<Pair<String, String>>): View {
        val grid = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = blockParams()
        }
        for (chunk in rows.chunked(2)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            for ((label, value) in chunk) {
                val cell = card()
                cell.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    rightMargin = if (chunk.indexOf(label to value) == 0 && chunk.size > 1) dp(8) else 0
                }
                cell.addView(TextView(this).apply {
                    text = label
                    textSize = 12f
                    setTextColor(COLOR_ON_SURFACE_VARIANT)
                })
                cell.addView(TextView(this).apply {
                    text = value
                    textSize = 20f
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(COLOR_ON_SURFACE)
                    setPadding(0, dp(4), 0, 0)
                })
                row.addView(cell)
            }
            grid.addView(row)
        }
        return grid
    }

    private fun callCard(
        directionIconRes: Int,
        directionColor: Int,
        name: String,
        phone: String,
        time: String,
        duration: String,
        status: String,
        statusKind: Kind,
        idText: String,
        callStatus: String
    ): View {
        val box = card(stroke = if (statusKind == Kind.ERROR) COLOR_ERROR else COLOR_OUTLINE)
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(circleIcon(directionIconRes, directionColor, COLOR_SURFACE_HIGH, 58, 26))
        val main = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, dp(8), 0)
        }
        main.addView(TextView(this).apply {
            text = name
            textSize = 17f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_ON_SURFACE)
        })
        main.addView(TextView(this).apply {
            text = phone
            textSize = 13f
            setTextColor(COLOR_ON_SURFACE_VARIANT)
        })
        row.addView(main, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val side = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.RIGHT
        }
        side.addView(TextView(this).apply {
            text = time
            textSize = 13f
            setTextColor(COLOR_ON_SURFACE_VARIANT)
            gravity = Gravity.RIGHT
        })
        side.addView(badge(status, statusKind))
        row.addView(side)
        box.addView(row)
        box.addView(divider())
        val foot = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        foot.addView(TextView(this).apply {
            text = "◷ $duration · $callStatus"
            textSize = 13f
            setTextColor(COLOR_ON_SURFACE_VARIANT)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        foot.addView(badge(idText, Kind.NEUTRAL))
        box.addView(foot)
        return box
    }

    private fun recordingCard(name: String, phone: String, time: String, status: String, statusKind: Kind, footer: String): View {
        val box = card(stroke = if (statusKind == Kind.ERROR) COLOR_ERROR else COLOR_OUTLINE)
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(circleIcon(R.drawable.ic_audio_file, COLOR_PRIMARY, COLOR_SURFACE_HIGH, 54, 25))
        val main = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), 0, 0, 0)
        }
        main.addView(TextView(this).apply {
            text = name
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(COLOR_ON_SURFACE)
        })
        main.addView(TextView(this).apply {
            text = "$phone · $time"
            textSize = 12f
            setTextColor(COLOR_ON_SURFACE_VARIANT)
            setPadding(0, dp(3), 0, 0)
        })
        row.addView(main, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(badge(status, statusKind))
        box.addView(row)
        box.addView(divider())
        box.addView(TextView(this).apply {
            text = footer
            textSize = 12f
            setTextColor(COLOR_ON_SURFACE_VARIANT)
        })
        return box
    }

    private fun permissionGrid(): View {
        return metricGrid(listOf(
            "通话记录" to yesNo(granted(Manifest.permission.READ_CALL_LOG)),
            "电话状态" to yesNo(granted(Manifest.permission.READ_PHONE_STATE)),
            "音频读取" to yesNo(audioGranted()),
            "全部文件" to yesNo(Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager())
        ))
    }

    private fun pageHeader(title: String, subtitle: String): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, dp(12))
            addView(TextView(this@MainActivity).apply {
                text = title
                textSize = 22f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(COLOR_ON_SURFACE)
            })
            addView(TextView(this@MainActivity).apply {
                text = subtitle
                textSize = 13f
                setTextColor(COLOR_ON_SURFACE_VARIANT)
                setPadding(0, dp(4), 0, 0)
            })
        }
    }

    private fun sectionHeader(title: String, subtitle: String): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, dp(12))
            addView(TextView(this@MainActivity).apply {
                text = title
                textSize = 18f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(COLOR_ON_SURFACE)
            })
            addView(TextView(this@MainActivity).apply {
                text = subtitle
                textSize = 12f
                setTextColor(COLOR_ON_SURFACE_VARIANT)
            })
        }
    }

    private fun twoColumnRows(rows: List<Pair<String, String>>): View {
        val grid = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        for (chunk in rows.chunked(2)) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 0, 0, dp(14))
            }
            for ((label, value) in chunk) {
                val cell = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                }
                cell.addView(TextView(this).apply {
                    text = label
                    textSize = 12f
                    setTextColor(COLOR_ON_SURFACE_VARIANT)
                })
                cell.addView(TextView(this).apply {
                    text = value
                    textSize = 16f
                    setTextColor(COLOR_ON_SURFACE)
                    setPadding(0, dp(4), dp(8), 0)
                })
                row.addView(cell, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            }
            grid.addView(row)
        }
        return grid
    }

    private fun keyValueRow(label: String, value: String): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))
            addView(TextView(this@MainActivity).apply {
                text = label
                textSize = 13f
                setTextColor(COLOR_ON_SURFACE_VARIANT)
            }, LinearLayout.LayoutParams(dp(96), ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(TextView(this@MainActivity).apply {
                text = value
                textSize = 13f
                setTextColor(COLOR_ON_SURFACE)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
    }

    private fun badge(text: String, kind: Kind): View {
        val colors = kindColors(kind)
        return TextView(this).apply {
            this.text = text
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(colors.first)
            setPadding(dp(10), dp(4), dp(10), dp(4))
            background = roundedBg(colors.second, dp(18), colors.third, 1)
        }
    }

    private fun horizontalProgress(percent: Int): View {
        return ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = percent.coerceIn(0, 100)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(10)
            ).apply {
                topMargin = dp(10)
            }
        }
    }

    private fun actionButton(text: String, kind: Kind, onClick: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            setAllCaps(false)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(if (kind == Kind.ERROR) COLOR_ERROR else COLOR_ON_PRIMARY)
            background = when (kind) {
                Kind.ERROR -> roundedBg(Color.TRANSPARENT, dp(10), COLOR_ERROR, 1)
                else -> roundedBg(COLOR_PRIMARY, dp(10), Color.TRANSPARENT, 0)
            }
            minHeight = dp(52)
            setOnClickListener { onClick() }
        }
    }

    private fun outlineButton(text: String, onClick: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            setAllCaps(false)
            textSize = 14f
            setTextColor(COLOR_PRIMARY)
            background = roundedBg(Color.TRANSPARENT, dp(10), COLOR_OUTLINE, 1)
            minHeight = dp(48)
            setOnClickListener { onClick() }
            layoutParams = blockParams()
        }
    }

    private fun emptyCard(text: String): View {
        return card().apply {
            addView(TextView(this@MainActivity).apply {
                this.text = text
                textSize = 14f
                setTextColor(COLOR_ON_SURFACE_VARIANT)
            })
        }
    }

    private fun logCard(title: String, body: String): View {
        return card(stroke = COLOR_TERTIARY).apply {
            addView(TextView(this@MainActivity).apply {
                text = title
                textSize = 16f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(COLOR_ON_SURFACE)
            })
            addView(TextView(this@MainActivity).apply {
                text = body
                textSize = 12f
                setTextColor(COLOR_ON_SURFACE_VARIANT)
                setPadding(0, dp(8), 0, 0)
            })
        }
    }

    private fun card(stroke: Int = COLOR_OUTLINE): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = roundedBg(COLOR_SURFACE, dp(16), stroke, 1)
            elevation = dp(1).toFloat()
            layoutParams = blockParams()
        }
    }

    private fun divider(): View {
        return View(this).apply {
            setBackgroundColor(COLOR_OUTLINE)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                1
            ).apply {
                topMargin = dp(14)
                bottomMargin = dp(14)
            }
        }
    }

    private fun roundedBg(color: Int, radius: Int, strokeColor: Int, strokeWidth: Int): GradientDrawable {
        return GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius.toFloat()
            if (strokeWidth > 0) setStroke(dp(strokeWidth), strokeColor)
        }
    }

    private fun kindColors(kind: Kind): Triple<Int, Int, Int> {
        return when (kind) {
            Kind.PRIMARY -> Triple(COLOR_ON_PRIMARY, COLOR_PRIMARY, COLOR_PRIMARY)
            Kind.SUCCESS -> Triple(COLOR_SUCCESS, Color.rgb(232, 246, 236), Color.rgb(190, 230, 202))
            Kind.WARNING -> Triple(Color.rgb(180, 120, 0), Color.rgb(255, 247, 218), Color.rgb(255, 225, 140))
            Kind.ERROR -> Triple(COLOR_ERROR, Color.rgb(255, 235, 232), Color.rgb(255, 190, 184))
            Kind.NEUTRAL -> Triple(COLOR_ON_SURFACE_VARIANT, COLOR_SURFACE_LOW, COLOR_OUTLINE)
        }
    }

    private fun blockParams(): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply {
            bottomMargin = dp(12)
        }
    }

    private fun inputParams(): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(48)
        ).apply {
            bottomMargin = dp(10)
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
        val appIntent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, uri)
        try {
            startActivity(appIntent)
            return
        } catch (_: ActivityNotFoundException) {
        } catch (_: SecurityException) {
        }

        try {
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            Toast.makeText(this, "请在列表中找到寰宇采集，并允许管理所有文件", Toast.LENGTH_LONG).show()
        } catch (_: ActivityNotFoundException) {
            openAppDetailsSettings()
            Toast.makeText(this, "请在权限里手动打开文件/音频访问", Toast.LENGTH_LONG).show()
        }
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

    private fun directionIconRes(item: JSONObject): Int {
        return when (item.optString("callStatus")) {
            "missed", "rejected", "outgoing_unanswered" -> R.drawable.ic_call_missed
            else -> if (item.optString("direction") == "out") R.drawable.ic_call_made else R.drawable.ic_call_received
        }
    }

    private fun directionColor(item: JSONObject): Int {
        return when (item.optString("callStatus")) {
            "missed", "rejected", "outgoing_unanswered" -> COLOR_ERROR
            else -> if (item.optString("direction") == "out") COLOR_SUCCESS else COLOR_PRIMARY
        }
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

    private fun syncStatusText(prefs: AppPrefs): String {
        val stage = prefs.lastSyncProgressStage.ifBlank {
            return if (isSyncing(prefs)) "正在扫描/上传" else "空闲"
        }
        if (isSyncing(prefs)) return stage
        return if (stage == "本轮完成") "空闲" else stage
    }

    private fun recordingProgressText(prefs: AppPrefs): String {
        val total = prefs.lastRecordingProgressTotal
        val processed = prefs.lastRecordingProgressProcessed
        val uploaded = prefs.lastRecordingProgressUploaded
        val failed = prefs.lastRecordingProgressFailed
        val base = if (total > 0) {
            "$processed/$total，已上传 $uploaded，失败 $failed"
        } else {
            "待处理 0，已上传 $uploaded，失败 $failed"
        }
        val at = formatTs(prefs.lastSyncProgressAt)
        return "$base · ${prefs.lastSyncProgressStage} · $at"
    }

    private fun recordingProgressPercent(prefs: AppPrefs): Int {
        val total = prefs.lastRecordingProgressTotal
        if (total <= 0) return if (isSyncing(prefs)) 8 else 0
        return ((prefs.lastRecordingProgressProcessed.toFloat() / total.toFloat()) * 100f).roundToInt().coerceIn(0, 100)
    }

    private fun durationText(seconds: Int): String {
        val min = seconds / 60
        val sec = seconds % 60
        return "%02d:%02d".format(min, sec)
    }

    private fun compactBackend(url: String): String {
        return url
            .removePrefix("http://")
            .removePrefix("https://")
            .ifBlank { "未配置" }
    }

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

    private enum class Kind {
        PRIMARY,
        SUCCESS,
        WARNING,
        ERROR,
        NEUTRAL
    }

    private enum class Tab {
        OVERVIEW,
        CALLS,
        RECORDINGS,
        SYNC,
        SETTINGS
    }

    companion object {
        private val COLOR_BACKGROUND = Color.rgb(247, 249, 255)
        private val COLOR_SURFACE = Color.WHITE
        private val COLOR_SURFACE_LOW = Color.rgb(241, 244, 250)
        private val COLOR_SURFACE_HIGH = Color.rgb(229, 232, 238)
        private val COLOR_ON_SURFACE = Color.rgb(24, 28, 32)
        private val COLOR_ON_SURFACE_VARIANT = Color.rgb(65, 71, 84)
        private val COLOR_OUTLINE = Color.rgb(218, 220, 224)
        private val COLOR_PRIMARY = Color.rgb(0, 91, 191)
        private val COLOR_ON_PRIMARY = Color.WHITE
        private val COLOR_TERTIARY = Color.rgb(43, 90, 181)
        private val COLOR_SUCCESS = Color.rgb(52, 168, 83)
        private val COLOR_WARNING = Color.rgb(251, 188, 4)
        private val COLOR_ERROR = Color.rgb(217, 48, 37)
        private val COLOR_NEUTRAL = Color.rgb(148, 163, 184)
    }
}
