// Helpers.kt
package com.devioarts.capacitor.tcpclient

import com.getcapacitor.JSArray

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
    fun jsArrayToBytes(arr: JSArray): ByteArray? {
        val len = arr.length()
        val out = ByteArray(len)
        for (i in 0 until len) {
            try {
                val v = arr.getInt(i) // may throw if non-numeric
                out[i] = (v and 0xFF).toByte()
            } catch (e: Exception) {
                return null
            }
        }
        return out
    }

    /**
     * Lenient conversion: skips non-numeric entries instead of failing.
     * - Useful if you prefer best-effort writes.
     * - Keeps original order of valid items.
     */
    fun jsArrayToBytesLenient(arr: JSArray): ByteArray {
        val tmp = ArrayList<Byte>(arr.length())
        for (i in 0 until arr.length()) {
            try {
                val v = arr.getInt(i)
                tmp.add((v and 0xFF).toByte())
            } catch (_: Exception) {
                // skip invalid entry
            }
        }
        return tmp.toByteArray()
    }

    /**
     * Convert a ByteArray into a JSArray of integers (0..255).
     *
     * Rationale:
     * - Using a primitive IntArray avoids boxing overhead and results in a compact JSON payload.
     * - This is friendlier to WebView/bridge than a JSONArray of boxed Integers, especially for large buffers.
     */
    fun bytesToJSArray(bytes: ByteArray): JSArray {
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
     * Find the first occurrence of [needle] inside [haystack] using
     * the Boyer–Moore–Horspool algorithm.
     *
     * Returns:
     *  - start index of the first match
     *  - -1 if no match is found
     *
     * Complexity:
     *  - Average ~O(n / m) where n=haystack length, m=needle length
     *  - Worst-case O(n*m) is rare for random data
     *
     * Notes:
     *  - For an empty needle this mirrors previous behavior and returns -1.
     *  - This implementation uses a 256-entry skip table for byte values.
     */
    fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
        val n = haystack.size
        val m = needle.size
        if (m == 0 || m > n) return -1

        // Build bad-character skip table for all 256 possible byte values.
        // Default shift is the needle length; last character keeps default.
        val skip = IntArray(256) { m }
        for (i in 0 until m - 1) {
            skip[needle[i].toInt() and 0xFF] = m - 1 - i
        }

        var i = 0
        while (i <= n - m) {
            var j = m - 1
            // Compare from the end of the pattern backwards.
            while (j >= 0 && haystack[i + j] == needle[j]) j--
            if (j < 0) return i // full match

            // Advance by the skip value based on the mismatching byte in haystack
            i += skip[haystack[i + m - 1].toInt() and 0xFF]
        }
        return -1
    }
}
