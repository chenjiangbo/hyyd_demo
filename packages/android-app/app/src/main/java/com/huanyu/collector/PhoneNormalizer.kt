package com.huanyu.collector

object PhoneNormalizer {
    fun normalize(input: String): String {
        val digits = input.filter { it.isDigit() }
        return when {
            digits.startsWith("86") && digits.length > 11 -> digits.removePrefix("86")
            digits.startsWith("0086") && digits.length > 13 -> digits.removePrefix("0086")
            else -> digits
        }
    }

    fun sameNumber(a: String, b: String): Boolean {
        val left = normalize(a)
        val right = normalize(b)
        if (left.isBlank() || right.isBlank()) return false
        return left == right || left.endsWith(right.takeLast(8)) || right.endsWith(left.takeLast(8))
    }
}
