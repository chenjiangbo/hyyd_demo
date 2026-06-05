package com.huanyu.collector

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog

class CallLogScanner(private val context: Context) {
    fun scanSince(sinceMillis: Long): List<LocalCall> {
        if (context.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            throw IllegalStateException("缺少 READ_CALL_LOG 权限")
        }

        val result = mutableListOf<LocalCall>()
        val projection = arrayOf(
            CallLog.Calls.NUMBER,
            CallLog.Calls.CACHED_NAME,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION
        )
        val cursor = context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            projection,
            "${CallLog.Calls.DATE} > ?",
            arrayOf(sinceMillis.toString()),
            "${CallLog.Calls.DATE} ASC"
        ) ?: return emptyList()

        cursor.use {
            val numberIdx = it.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
            val nameIdx = it.getColumnIndex(CallLog.Calls.CACHED_NAME)
            val typeIdx = it.getColumnIndexOrThrow(CallLog.Calls.TYPE)
            val dateIdx = it.getColumnIndexOrThrow(CallLog.Calls.DATE)
            val durationIdx = it.getColumnIndexOrThrow(CallLog.Calls.DURATION)

            while (it.moveToNext()) {
                val phone = PhoneNormalizer.normalize(it.getString(numberIdx).orEmpty())
                if (phone.isBlank()) continue
                val contactName = if (nameIdx >= 0) {
                    it.getString(nameIdx)?.trim()?.takeIf { name -> name.isNotEmpty() }
                } else {
                    null
                }

                val type = it.getInt(typeIdx)
                val direction = if (type == CallLog.Calls.OUTGOING_TYPE) "out" else "in"
                val durationSec = it.getInt(durationIdx)
                result.add(
                    LocalCall(
                        phone = phone,
                        contactName = contactName,
                        direction = direction,
                        callStatus = callStatus(type, durationSec),
                        durationSec = durationSec,
                        startedAtMillis = it.getLong(dateIdx)
                    )
                )
            }
        }
        return result
    }

    private fun callStatus(type: Int, durationSec: Int): String {
        return when (type) {
            CallLog.Calls.MISSED_TYPE -> "missed"
            CallLog.Calls.REJECTED_TYPE -> "rejected"
            CallLog.Calls.BLOCKED_TYPE -> "rejected"
            CallLog.Calls.OUTGOING_TYPE -> if (durationSec == 0) "outgoing_unanswered" else "answered"
            else -> if (durationSec == 0) "missed" else "answered"
        }
    }
}

data class LocalCall(
    val phone: String,
    val contactName: String?,
    val direction: String,
    val callStatus: String,
    val durationSec: Int,
    val startedAtMillis: Long
)
