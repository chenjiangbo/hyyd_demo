package com.huanyu.collector

import kotlin.math.abs

object RecordingMatchRules {
    fun durationToleranceMillis(callDurationSeconds: Int): Long = when {
        callDurationSeconds <= 10 -> 3_000L
        callDurationSeconds <= 30 -> 6_000L
        else -> 10_000L
    }

    fun durationMatches(callDurationSeconds: Int, recordingDurationMillis: Long): Boolean =
        abs(callDurationSeconds * 1000L - recordingDurationMillis) <= durationToleranceMillis(callDurationSeconds)

    fun candidates(calls: List<LocalCall>, recordingStartMillis: Long, recordingDurationMillis: Long): List<LocalCall> =
        calls.filter {
            it.callStatus == "answered" &&
                recordingStartMillis - it.startedAtMillis in 0..60_000L &&
                durationMatches(it.durationSec, recordingDurationMillis)
        }

    /** 只排除已通过外部证据核实被其他文件占用的通话；仍需剩余唯一候选。 */
    fun afterExcludingOccupied(candidates: List<LocalCall>, isOccupied: (LocalCall) -> Boolean): LocalCall? =
        candidates.filterNot(isOccupied).singleOrNull()

    fun uniqueNumberCandidate(calls: List<LocalCall>, phone: String, recordingStartMillis: Long, recordingDurationMillis: Long): LocalCall? {
        val normalized = PhoneNormalizer.normalize(phone)
        if (normalized.isBlank()) return null
        return calls.filter {
            it.callStatus == "answered" &&
                recordingStartMillis - it.startedAtMillis in 0..60_000L &&
                PhoneNormalizer.normalize(it.phone) == normalized &&
                durationMatches(it.durationSec, recordingDurationMillis)
        }
            .singleOrNull()
    }
}
