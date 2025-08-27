// Helpers.kt
package com.devioarts.capacitor.tcpclient

import com.getcapacitor.JSArray
import org.json.JSONArray
// NOTE: JSONArray import appears unused; safe to remove if not referenced elsewhere.

/**
 * Helper utilities for bridging binary data between Kotlin/Android and the Capacitor JS layer.
 *
 * Goals:
 * - Minimize allocations and avoid boxing where possible
 * - Keep payloads JSON-serializable and WebView-friendly
 * - Provide small, dependency-free helpers for hex and pattern matching
 *
 * Performance notes:
 * - Prefer primitive arrays (IntArray) when constructing a JSArray to avoid per-element boxing.
 * - All conversions mask to 0..255 to stay within byte boundaries expected by JS consumers.
 */
object Helpers {

    /**
     * Convert a Capacitor JSArray (numbers 0..255) into a ByteArray.
     *
     * Expectations:
     * - Each element is an integer-like value; any fractional part will be truncated by JS before it reaches here.
     * - Values outside 0..255 are masked with 0xFF to fit into a byte.
     *
     * Failure modes:
     * - If the JSArray contains non-numeric entries, JSArray#getInt(i) may throw.
     */
    fun jsArrayToBytes(arr: JSArray): ByteArray {
        val out = ByteArray(arr.length())
        for (i in 0 until arr.length()) {
            val v = (arr.getInt(i)) and 0xFF
            out[i] = v.toByte()
        }
        return out
    }

    /**
     * Convert a ByteArray into a JSArray of integers (0..255).
     *
     * Rationale:
     * - Using a primitive IntArray avoids boxing overhead and results in a compact JSON payload.
     * - This is friendlier to WebView/bridge than a JSONArray of boxed Integers, especially for large buffers.
     */
    fun bytesToJSArray(bytes: ByteArray): JSArray {
        // <- klíčová změna: použít PRIMITIVNÍ pole int[]
        val ints = IntArray(bytes.size) { i -> (bytes[i].toInt() and 0xFF) }
        return JSArray(ints)
    }

    /**
     * Parse a hex string (e.g., "1b40" or "1B 40") into a ByteArray.
     *
     * Rules:
     * - Whitespace is ignored; case-insensitive.
     * - Returns null if the string is empty, has odd length, or contains invalid hex digits.
     *
     * Extensions you might add later (not implemented here):
     * - Accept "0x" prefixes
     * - Ignore commas or other separators
     */
    fun hexToBytes(str: String): ByteArray? {
        val clean = str.replace(" ", "").lowercase()
        if (clean.isEmpty() || clean.length % 2 != 0) return null
        val out = ByteArray(clean.length / 2)
        var i = 0
        while (i < clean.length) {
            val byteStr = clean.substring(i, i + 2)
            val v = byteStr.toIntOrNull(16) ?: return null
            out[i / 2] = (v and 0xFF).toByte()
            i += 2
        }
        return out
    }

    /**
     * Naive byte-pattern search: find the first occurrence of [needle] in [haystack].
     *
     * Complexity:
     * - O(n*m) worst case (n = haystack size, m = needle size)
     *
     * Suitability:
     * - Adequate for small to medium buffers or one-off checks.
     * - For very large streams or frequent searches, consider a more efficient algorithm (e.g., KMP/Boyer–Moore).
     *
     * Returns:
     * - Start index of the first match, or -1 if not found.
     */
    fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
        if (needle.isEmpty() || needle.size > haystack.size) return -1
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) {
                if (haystack[i + j] != needle[j]) continue@outer
            }
            return i
        }
        return -1
    }
}
