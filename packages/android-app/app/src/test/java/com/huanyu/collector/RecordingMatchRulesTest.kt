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
        val calls = listOf(call(0, 29), call(0, 35), call(0, 28), call(0, 36), call(0, 32, "missed"))
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
        assertNull(RecordingMatchRules.uniqueNumberCandidate(calls, "13812345678", 20_000, 36_000))
    }
}
