package com.huanyu.collector

import android.os.Environment
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale

class RecordingScanner {
    private val timestampFormat = SimpleDateFormat("yyyyMMddHHmmss", Locale.CHINA)

    fun scanSince(sinceMillis: Long): List<LocalRecording> {
        val root = Environment.getExternalStorageDirectory()
        val dirs = listOf(
            File(root, "Sounds/CallRecord"),
            File(root, "record/callrecord"),
            File(root, "Recordings/Call"),
            File(root, "MIUI/sound_recorder/call_rec")
        )

        return dirs
            .filter { it.exists() && it.isDirectory }
            .flatMap { dir ->
                dir.walkTopDown()
                    .filter { it.isFile && it.lastModified() >= sinceMillis }
                    .toList()
            }
            .filter { it.extension.lowercase(Locale.ROOT) in setOf("m4a", "mp3", "aac", "wav", "amr") }
            .mapNotNull { parseRecording(it) }
            .filter { it.timestampMillis >= sinceMillis }
            .sortedBy { it.timestampMillis }
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

data class LocalRecording(
    val file: File,
    val phone: String,
    val timestampMillis: Long,
    val safeName: String
)
