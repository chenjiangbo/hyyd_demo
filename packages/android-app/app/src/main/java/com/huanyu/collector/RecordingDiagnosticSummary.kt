package com.huanyu.collector

/** 仅归纳本机记录，不把匹配或历史查询当成实时上传证明。 */
object RecordingDiagnosticSummary {
    fun matchStatus(fileStatuses: List<String>, callStatus: String): String = when {
        fileStatuses.isNotEmpty() -> "本机已匹配"
        callStatus != "answered" -> "未接通"
        else -> "关联情况未确认"
    }
    fun uploadStatus(fileStatuses: List<String>): String = when {
        fileStatuses.any { it == "已上传" || it == "已存在" } -> "本机记录已上传"
        fileStatuses.any { it.startsWith("上传失败") } -> "上传失败"
        fileStatuses.any { it == "非订单电话，已忽略" } -> "非订单电话，未上传"
        fileStatuses.isNotEmpty() -> "本机有匹配，上传情况未确认"
        else -> "本机上传情况未确认"
    }
}
