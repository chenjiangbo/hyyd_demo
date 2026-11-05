package com.huanyu.collector

import android.os.Environment
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class RecordingScanner {
    private val timestampFormat = SimpleDateFormat("yyyyMMddHHmmss", Locale.CHINA).apply {
        timeZone = TimeZone.getTimeZone("Asia/Shanghai")
    }
    private val displayFormat = SimpleDateFormat("MM-dd HH:mm:ss", Locale.CHINA).apply {
        timeZone = TimeZone.getTimeZone("Asia/Shanghai")
    }

    fun scanSince(sinceMillis: Long): RecordingScanResult {
        val root = Environment.getExternalStorageDirectory()
        val dirs = listOf(
            File(root, "Sounds/CallRecord"),
            File(root, "Sounds/CallRecorder"),
            File(root, "Sounds/Recorder/Call"),
            File(root, "sounds/callrecord"),
            File(root, "sounds/callrecorder"),
            File(root, "sounds/recorder/call"),
            File(root, "record/callrecord"),
            File(root, "Record/Call"),
            File(root, "Recordings/Call"),
            File(root, "Recordings/Call Recordings"),
            File(root, "Recordings/Call recordings"),
            File(root, "recordings/call"),
            File(root, "recordings/call recordings"),
            File(root, "Recordings"),
            File(root, "recordings"),
            File(root, "CallRecord"),
            File(root, "callrecord"),
            File(root, "MIUI/sound_recorder/call_rec")
        )
        val extensions = setOf("m4a", "mp3", "aac", "wav", "amr")
        val summaries = mutableListOf<String>()
        val samples = mutableListOf<String>()
        val issues = mutableListOf<String>()
        var unparsedCount = 0
        val totalAudioKeys = linkedSetOf<String>()
        val recentAudioFiles = linkedMapOf<String, File>()
        val discoveredAudioFiles = linkedMapOf<String, File>()
        val directoryDiagnostics = mutableListOf<RecordingDirectoryDiagnostic>()

        val existingDirs = dirs.filter { it.exists() && it.isDirectory }
        dirs.filterNot { it.exists() && it.isDirectory }.forEach {
            directoryDiagnostics.add(RecordingDirectoryDiagnostic(it.absolutePath, "不存在"))
        }
        if (existingDirs.isEmpty()) issues.add("未找到预设录音目录，请检查录音设置和文件权限")
        existingDirs
            .forEach { dir ->
                try {
                    if (!dir.canRead() || dir.listFiles() == null) {
                        issues.add("录音目录无法读取: ${dir.absolutePath}")
                        directoryDiagnostics.add(RecordingDirectoryDiagnostic(dir.absolutePath, "无法读取"))
                        return@forEach
                    }
                    var partial = false
                    val allFiles = dir.walkTopDown()
                        .onFail { file, error ->
                            partial = true
                            issues.add("无法读取 ${file.absolutePath}: ${error.message}")
                        }
                        .filter { it.isFile }
                        .toList()
                    val allAudioFiles = allFiles.filter { it.extension.lowercase(Locale.ROOT) in extensions }
                    allAudioFiles.forEach { discoveredAudioFiles.putIfAbsent(it.absolutePath, it) }
                    directoryDiagnostics.add(RecordingDirectoryDiagnostic(dir.absolutePath, if (partial) "部分读取失败" else "已扫描", allAudioFiles.size))
                    val dirRecentAudioFiles = allAudioFiles.filter { it.lastModified() >= sinceMillis }
                    allAudioFiles.forEach { totalAudioKeys.add(fileIdentity(it)) }
                    dirRecentAudioFiles.forEach { recentAudioFiles.putIfAbsent(fileIdentity(it), it) }
                    summaries.add(directorySummary(dir, allAudioFiles, dirRecentAudioFiles, sinceMillis))
                } catch (e: Exception) {
                    issues.add("录音目录读取失败: ${dir.absolutePath}")
                    directoryDiagnostics.add(RecordingDirectoryDiagnostic(dir.absolutePath, "读取失败: ${e.javaClass.simpleName}"))
                    summaries.add("${dir.absolutePath}: 读取失败 ${e.javaClass.simpleName}: ${e.message.orEmpty()}")
                }
            }

        val recordings = recentAudioFiles.values
            .mapNotNull { file ->
                parseRecording(file) ?: run {
                    unparsedCount += 1
                    if (samples.size < 5) samples.add(file.name)
                    null
                }
            }
            .filter { it.timestampMillis >= sinceMillis }
            .sortedBy { it.timestampMillis }

        val missing = dirs.filterNot { it.exists() && it.isDirectory }.take(6)
        missing.forEach { summaries.add("${it.absolutePath}: 不存在") }
        return RecordingScanResult(
            recordings = recordings,
            totalAudioCount = totalAudioKeys.size,
            rawAudioCount = recentAudioFiles.size,
            parsedCount = recordings.size,
            summary = summaries.take(12).joinToString("\n"),
            unparsedSamples = samples.joinToString("\n"),
            unparsedCount = unparsedCount,
            issue = issues.distinct().joinToString("\n"),
            discoveredFiles = discoveredAudioFiles.values.toList(),
            discoveredRecordings = discoveredAudioFiles.values.mapNotNull { parseRecording(it) },
            directoryDiagnostics = directoryDiagnostics
        )
    }

    private fun directorySummary(
        dir: File,
        allAudioFiles: List<File>,
        recentAudioFiles: List<File>,
        sinceMillis: Long
    ): String {
        val latest = allAudioFiles.maxOfOrNull { it.lastModified() }
        val latestText = latest?.let { displayFormat.format(Date(it)) } ?: "无"
        val sample = allAudioFiles.firstOrNull()?.name ?: "无"
        return "${dir.absolutePath}: 总音频=${allAudioFiles.size}, 游标后=${recentAudioFiles.size}, " +
            "exists=${dir.exists()}, isDirectory=${dir.isDirectory}, " +
            "canRead=${dir.canRead()}, list=${dir.listFiles()?.size ?: -1}, " +
            "起点=${displayFormat.format(Date(sinceMillis))}, 最新=${latestText}, 样例=${sample}"
    }

    private fun parseRecording(file: File): LocalRecording? {
        val name = file.name
        val compactName = name.replace(Regex("""\s+"""), "")
        val phone = Regex("""(?:\+?86)?1\d{10}""").find(compactName)?.value
        val compactTime = Regex("""20\d{12}""").find(name)?.value
        val vivoTime = Regex("""(20\d{2}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2})""").find(name)
        val tsText = compactTime ?: vivoTime?.value?.replace(Regex("""[- ]"""), "")
        val parsedTime = tsText?.let {
            try { timestampFormat.apply { isLenient = false }.parse(it)?.time } catch (_: Exception) { null }
        }
        if (phone == null && (vivoTime == null || parsedTime == null)) return null
        val timestampMillis = parsedTime ?: file.lastModified()
        val contactName = vivoTime?.let { name.substring(0, it.range.first).trim().takeIf(String::isNotEmpty) }
        return LocalRecording(
            file = file,
            phone = phone?.let(PhoneNormalizer::normalize).orEmpty(),
            timestampMillis = timestampMillis,
            safeName = sanitizeFileName("${timestampMillis}_${file.name}"),
            contactName = contactName
        )
    }

    private fun sanitizeFileName(input: String): String {
        return input.replace(Regex("""[^A-Za-z0-9._-]"""), "_")
    }

    private fun fileIdentity(file: File): String {
        return "${file.name}:${file.length()}:${file.lastModified()}"
    }
}

data class RecordingScanResult(
    val recordings: List<LocalRecording>,
    val totalAudioCount: Int,
    val rawAudioCount: Int,
    val parsedCount: Int,
    val summary: String,
    val unparsedSamples: String,
    val unparsedCount: Int,
    val issue: String,
    val discoveredFiles: List<File>,
    val discoveredRecordings: List<LocalRecording>,
    val directoryDiagnostics: List<RecordingDirectoryDiagnostic>
)

data class RecordingDirectoryDiagnostic(val path: String, val status: String, val audioCount: Int = 0)

data class LocalRecording(
    val file: File,
    val phone: String,
    val timestampMillis: Long,
    val safeName: String,
    val contactName: String? = null
)
