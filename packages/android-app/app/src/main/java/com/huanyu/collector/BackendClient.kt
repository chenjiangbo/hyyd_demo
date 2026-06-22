package com.huanyu.collector

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

class BackendClient(
    private val backendUrl: String = BuildConfig.BACKEND_URL,
    private val employeeCode: String = BuildConfig.EMPLOYEE_CODE
) {
    fun health(): String {
        val conn = URL("$backendUrl/health").openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.connectTimeout = 5_000
        conn.readTimeout = 10_000
        val code = conn.responseCode
        val text = if (code in 200..299) {
            conn.inputStream.bufferedReader().readText()
        } else {
            conn.errorStream?.bufferedReader()?.readText().orEmpty()
        }
        if (code !in 200..299) throw IllegalStateException("后端健康检查失败: HTTP $code $text")
        return text
    }

    fun heartbeat(source: String): String {
        return postJson(
            "/api/v1/me/mobile-heartbeat",
            JSONObject().put("source", source)
        ).toString()
    }

    fun matchCallPhone(phone: String): CallPhoneMatch {
        val data = postJson("/api/v1/calls/match", JSONObject().put("phone", phone)).getJSONObject("data")
        if (!data.optBoolean("matched")) return CallPhoneMatch(matched = false)
        val order = data.getJSONObject("order")
        return CallPhoneMatch(
            matched = true,
            orderId = order.getInt("id"),
            sourceOrderNo = order.optString("sourceOrderNo", "")
        )
    }

    fun postCall(call: LocalCall, orderId: Int? = null): SyncedCall {
        val body = JSONObject()
            .put("phone", call.phone)
            .put("contactName", call.contactName)
            .put("direction", call.direction)
            .put("callStatus", call.callStatus)
            .put("durationSec", call.durationSec)
            .put("startedAt", Instant.ofEpochMilli(call.startedAtMillis).toString())
        if (orderId != null) body.put("orderId", orderId)

        val data = postJson("/api/v1/calls", body).getJSONObject("data")
        val contactName = if (data.isNull("contactName")) null else data.optString("contactName")
        return SyncedCall(
            id = data.getInt("id"),
            phone = data.getString("phone"),
            contactName = contactName ?: call.contactName,
            direction = data.optString("direction", call.direction),
            callStatus = data.optString("callStatus", call.callStatus),
            startedAtMillis = call.startedAtMillis,
            durationSec = data.optInt("durationSec", call.durationSec)
        )
    }

    fun lookupCall(phone: String, startedAtMillis: Long): SyncedCall? {
        val response = postJson(
            "/api/v1/calls/lookup",
            JSONObject()
                .put("phone", phone)
                .put("startedAtMillis", startedAtMillis)
        )
        if (response.isNull("data")) return null
        val data = response.getJSONObject("data")
        val contactName = if (data.isNull("contactName")) null else data.optString("contactName")
        return SyncedCall(
            id = data.getInt("id"),
            phone = data.getString("phone"),
            contactName = contactName,
            direction = data.optString("direction", ""),
            callStatus = data.optString("callStatus", ""),
            startedAtMillis = Instant.parse(data.getString("startedAt")).toEpochMilli(),
            durationSec = data.optInt("durationSec", 0)
        )
    }

    fun registerRecording(call: SyncedCall, recording: LocalRecording): String {
        val ossKey = "android-recordings/${recording.safeName}"
        val body = JSONObject()
            .put("callId", call.id)
            .put("ossKey", ossKey)
            .put("durationSec", call.durationSec)
        val data = postJson("/api/v1/recordings", body).getJSONObject("data")
        return data.getString("uploadUrl")
    }

    fun uploadFile(uploadUrl: String, file: File) {
        val conn = URL(uploadUrl).openConnection() as HttpURLConnection
        conn.requestMethod = "PUT"
        conn.doOutput = true
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        conn.setRequestProperty("Content-Type", "audio/mp4")
        file.inputStream().use { input ->
            conn.outputStream.use { output -> input.copyTo(output) }
        }
        val code = conn.responseCode
        if (code !in 200..299) {
            val error = conn.errorStream?.bufferedReader()?.readText().orEmpty()
            throw IllegalStateException("录音上传失败: HTTP $code $error")
        }
    }

    private fun postJson(path: String, body: JSONObject): JSONObject {
        if (backendUrl.isBlank()) throw IllegalStateException("后端地址为空")
        if (employeeCode.isBlank()) throw IllegalStateException("员工 ID 为空")
        val conn = URL("$backendUrl$path").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 10_000
        conn.readTimeout = 30_000
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("X-Employee-Code", employeeCode)
        conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

        val code = conn.responseCode
        val text = if (code in 200..299) {
            conn.inputStream.bufferedReader().readText()
        } else {
            conn.errorStream?.bufferedReader()?.readText().orEmpty()
        }
        if (code !in 200..299) throw IllegalStateException("后端请求失败 $path: HTTP $code $text")
        return JSONObject(text)
    }
}

data class CallPhoneMatch(
    val matched: Boolean,
    val orderId: Int? = null,
    val sourceOrderNo: String = ""
)
