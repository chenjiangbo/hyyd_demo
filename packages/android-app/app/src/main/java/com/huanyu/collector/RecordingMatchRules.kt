package com.huanyu.collector

import kotlin.math.abs

object RecordingMatchRules {
    fun candidates(calls: List<LocalCall>, recordingStartMillis: Long, recordingDurationMillis: Long): List<LocalCall> =
        calls.filter {
            it.callStatus == "answered" &&
                recordingStartMillis - it.startedAtMillis in 0..60_000L &&
                abs(it.durationSec * 1000L - recordingDurationMillis) <= 3_000L
        }

    fun uniqueNumberCandidate(calls: List<LocalCall>, phone: String, recordingStartMillis: Long, recordingDurationMillis: Long): LocalCall? {
        val normalized = PhoneNormalizer.normalize(phone)
        if (normalized.isBlank()) return null
        return candidates(calls, recordingStartMillis, recordingDurationMillis)
            .filter { PhoneNormalizer.normalize(it.phone) == normalized }
            .singleOrNull()
    }
}
