package com.huanyu.collector

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RecordingMatchRulesTest {
    private fun call(time: Long, duration: Int = 32, status: String = "answered", phone: String = "13800000000") =
        LocalCall(phone, null, "out", status, duration, time)

    @Test fun includesBoundariesAndRejectsOutside() {
        val start = 120_000L
        val calls = listOf(call(start), call(start - 60_000), call(start - 60_001), call(start + 1))
        assertEquals(calls.take(2), RecordingMatchRules.candidates(calls, start, 32_000))
    }

    @Test fun checksDurationInMillisecondsAndAnsweredStatus() {
        val calls = listOf(call(0, 29), call(0, 35), call(0, 25), call(0, 43), call(0, 32, "missed"))
        assertEquals(calls.take(2), RecordingMatchRules.candidates(calls, 0, 32_000))
    }

    @Test fun privateAndUnknownNumbersRemainCandidates() {
        val calls = listOf(call(0), call(1, phone = ""), call(2, phone = "13900000000"))
        assertEquals(calls, RecordingMatchRules.candidates(calls, 10, 31_850))
    }

    @Test fun numberMatchingRequiresExactNumberAndUniqueTimeAndDuration() {
        val expected = call(1_000, phone = "13812345678")
        val unrelated = call(2_000, phone = "13912345678")
        val calls = listOf(expected, unrelated)
        assertEquals(expected, RecordingMatchRules.uniqueNumberCandidate(calls, "+86 13812345678", 20_000, 32_000))
        assertNull(RecordingMatchRules.uniqueNumberCandidate(calls, "13712345678", 20_000, 32_000))
        assertNull(RecordingMatchRules.uniqueNumberCandidate(calls + call(3_000, phone = "13812345678"), "13812345678", 20_000, 32_000))
        assertNull(RecordingMatchRules.uniqueNumberCandidate(calls, "13812345678", 20_000, 42_001))
    }

    @Test fun phoneToleranceRespectsDurationTierBoundaries() {
        assertEquals(3_000L, RecordingMatchRules.durationToleranceMillis(9))
        assertEquals(3_000L, RecordingMatchRules.durationToleranceMillis(10))
        assertEquals(6_000L, RecordingMatchRules.durationToleranceMillis(11))
        assertEquals(6_000L, RecordingMatchRules.durationToleranceMillis(29))
        assertEquals(6_000L, RecordingMatchRules.durationToleranceMillis(30))
        assertEquals(10_000L, RecordingMatchRules.durationToleranceMillis(31))
        assertEquals(10_000L, RecordingMatchRules.durationToleranceMillis(60))
        assertEquals(true, RecordingMatchRules.durationMatches(32, 26_496))
        assertEquals(true, RecordingMatchRules.durationMatches(9, 12_000))
        assertEquals(false, RecordingMatchRules.durationMatches(9, 12_001))
        assertEquals(true, RecordingMatchRules.durationMatches(11, 17_000))
        assertEquals(false, RecordingMatchRules.durationMatches(11, 17_001))
    }

    @Test fun widerNumberToleranceStillRequiresUniqueCandidate() {
        val calls = listOf(call(1_000, 32), call(2_000, 34))
        assertNull(RecordingMatchRules.uniqueNumberCandidate(calls, "13800000000", 20_000, 26_496))
    }

    @Test fun namelessRecordingUsesTiersAndKeepsAllAmbiguousCandidates() {
        val first = call(1_000, 32, phone = "13800000000")
        val second = call(2_000, 34, phone = "13900000000")
        assertEquals(listOf(first), RecordingMatchRules.candidates(listOf(first), 20_000, 26_496))
        assertEquals(listOf(first, second), RecordingMatchRules.candidates(listOf(first, second), 20_000, 26_496))
        assertEquals(emptyList<LocalCall>(), RecordingMatchRules.candidates(listOf(call(1_000, 10)), 20_000, 13_001))
    }
    @Test fun occupiedCandidateIsExcludedOnlyWhenEvidenceConfirmsIt() {
        val first = call(1_000, 9)
        val second = call(2_000, 12)
        val candidates = listOf(first, second)
        assertEquals(second, RecordingMatchRules.afterExcludingOccupied(candidates) { it == first })
        assertNull(RecordingMatchRules.afterExcludingOccupied(candidates) { false })
        assertNull(RecordingMatchRules.afterExcludingOccupied(candidates) { true })
        assertNull(RecordingMatchRules.afterExcludingOccupied(candidates + call(3_000, 12)) { it == first })
    }

    @Test fun diagnosticDoesNotConfuseLocalMatchWithUpload() {
        val ignored = listOf("非订单电话，已忽略")
        assertEquals("本机已匹配", RecordingDiagnosticSummary.matchStatus(ignored, "answered"))
        assertEquals("非订单电话，未上传", RecordingDiagnosticSummary.uploadStatus(ignored))
        assertEquals("本机记录已上传", RecordingDiagnosticSummary.uploadStatus(listOf("已上传")))
        assertEquals("上传失败", RecordingDiagnosticSummary.uploadStatus(listOf("上传失败: 网络")))
        assertEquals("关联情况未确认", RecordingDiagnosticSummary.matchStatus(emptyList(), "answered"))
        assertEquals("本机上传情况未确认", RecordingDiagnosticSummary.uploadStatus(emptyList()))
    }

}
