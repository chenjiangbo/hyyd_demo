package com.huanyu.collector

import android.os.Environment
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RecordingScanner {
    private val timestampFormat = SimpleDateFormat("yyyyMMddHHmmss", Locale.CHINA)
    private val displayFormat = SimpleDateFormat("MM-dd HH:mm:ss", Locale.CHINA)

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
        var rawAudioCount = 0
        var totalAudioCount = 0

        val recordings = dirs
            .filter { it.exists() && it.isDirectory }
            .flatMap { dir ->
                try {
                    val allFiles = dir.walkTopDown()
                        .filter { it.isFile }
                        .toList()
                    val allAudioFiles = allFiles.filter { it.extension.lowercase(Locale.ROOT) in extensions }
                    val recentAudioFiles = allAudioFiles.filter { it.lastModified() >= sinceMillis }
                    totalAudioCount += allAudioFiles.size
                    rawAudioCount += recentAudioFiles.size
                    summaries.add(directorySummary(dir, allAudioFiles, recentAudioFiles, sinceMillis))
                    recentAudioFiles
                } catch (e: Exception) {
                    summaries.add("${dir.absolutePath}: 读取失败 ${e.javaClass.simpleName}: ${e.message.orEmpty()}")
                    emptyList()
                }
            }
            .mapNotNull { file ->
                parseRecording(file) ?: run {
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
            totalAudioCount = totalAudioCount,
            rawAudioCount = rawAudioCount,
            parsedCount = recordings.size,
            summary = summaries.take(12).joinToString("\n"),
            unparsedSamples = samples.joinToString("\n")
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
        val phone = Regex("""(?:\+?86)?1\d{10}""").find(compactName)?.value ?: return null
        val tsText = Regex("""20\d{12}""").find(name)?.value
        val timestampMillis = tsText?.let { timestampFormat.parse(it)?.time } ?: file.lastModified()
        return LocalRecording(
            file = file,
            phone = PhoneNormalizer.normalize(phone),
            timestampMillis = timestampMillis,
            safeName = sanitizeFileName("${timestampMillis}_${file.name}")
        )
    }

    private fun sanitizeFileName(input: String): String {
        return input.replace(Regex("""[^A-Za-z0-9._-]"""), "_")
    }
}

data class RecordingScanResult(
    val recordings: List<LocalRecording>,
    val totalAudioCount: Int,
    val rawAudioCount: Int,
    val parsedCount: Int,
    val summary: String,
    val unparsedSamples: String
)

data class LocalRecording(
    val file: File,
    val phone: String,
    val timestampMillis: Long,
    val safeName: String
)
