package com.huanyu.collector

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.provider.ContactsContract

/** 无号码录音仅在本机全部通话候选中确定唯一对应关系。 */
class RecordingMatcher(private val context: Context) {
    fun match(recording: LocalRecording, isConfirmedOccupied: (LocalCall) -> Boolean = { false }, diagnostic: (String, Int) -> Unit = { _, _ -> }): LocalCall? {
        val file = recording.file
        val size = file.length()
        val modified = file.lastModified()
        if (size <= 0 || System.currentTimeMillis() - modified < 15_000L) { diagnostic("文件为空或仍在写入", 0); return null }
        val duration = try {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(file.absolutePath)
                retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
            } finally {
                retriever.release()
            }
        } catch (_: Exception) { null } ?: run { diagnostic("无法读取录音时长", 0); return null }
        if (duration <= 0 || file.length() != size || file.lastModified() != modified) { diagnostic("时长无效或文件正在变化", 0); return null }

        // 查询包含边界的时间段，不能先过滤非订单或未知号码。
        val calls = CallLogScanner(context).scanSince(recording.timestampMillis - 60_001L)
        val candidates = RecordingMatchRules.candidates(calls, recording.timestampMillis, duration)
        val numberCandidates = if (recording.phone.isNotBlank()) calls.filter {
            it.callStatus == "answered" && recording.timestampMillis - it.startedAtMillis in 0..60_000L &&
                PhoneNormalizer.normalize(it.phone) == PhoneNormalizer.normalize(recording.phone) &&
                RecordingMatchRules.durationMatches(it.durationSec, duration)
        } else candidates
        val initiallySelected = when {
            recording.phone.isNotBlank() -> numberCandidates.singleOrNull()
            candidates.size == 0 -> null
            candidates.size == 1 -> candidates.single()
            else -> selectByContact(recording.contactName, candidates)
        }
        var resolvedByOccupancy = false
        val selected = if (initiallySelected == null && numberCandidates.size > 1) {
            RecordingMatchRules.afterExcludingOccupied(numberCandidates, isConfirmedOccupied).also {
                resolvedByOccupancy = it != null
            }
        } else initiallySelected
        val result = selected?.takeIf { it.phone.isNotBlank() }
        val reason = when {
            result != null && resolvedByOccupancy -> "排除已确认被其他录音占用的候选后唯一匹配"
            result != null -> "已找到通话"
            numberCandidates.isEmpty() -> "没有符合号码、时间和时长的通话"
            numberCandidates.size > 1 -> "多个候选无法唯一确定"
            else -> "通话号码不可用"
        }
        diagnostic(reason, numberCandidates.size)
        return result
    }

    private fun selectByContact(name: String?, candidates: List<LocalCall>): LocalCall? {
        if (name.isNullOrBlank() || context.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) return null
        val numbers = mutableSetOf<String>()
        val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
        val projection = arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER)
        val cursor = context.contentResolver.query(uri, projection, null, null, null) ?: return null
        cursor.use {
            val nameIndex = it.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val numberIndex = it.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (it.moveToNext()) {
                if (it.getString(nameIndex)?.trim() == name) {
                    numbers.add(PhoneNormalizer.normalize(it.getString(numberIndex).orEmpty()))
                }
            }
        }
        val matches = candidates.filter { candidate ->
            candidate.contactName?.trim() == name ||
                (candidate.phone.isNotBlank() && numbers.any { it.isNotBlank() && it == PhoneNormalizer.normalize(candidate.phone) })
        }
        return matches.singleOrNull()
    }
}
