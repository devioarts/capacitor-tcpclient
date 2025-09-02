/**
 * Android bridge for the TCPClient Capacitor plugin.
 *
 * Responsibilities:
 * - Validate and map JS arguments to the core TCPClient APIs.
 * - Convert between JS arrays/objects and ByteArray efficiently.
 * - Event micro-batching: buffer small bursts and flush after ~10ms or when >=16KB.
 * - Uniform result objects: { error, errorMessage, ... } — no exceptions thrown across the bridge.
 * - writeAndRead: uses an efficient (ByteArray, usedLen) matcher to avoid temporary allocations.
 *
 * Behavior notes:
 * - startRead resets the batching state; stopRead flushes any pending data.
 * - setReadTimeout forwards to the Android core; on iOS this method is a no-op for API parity.
 * - Disconnect emits tcpDisconnect with reason: manual | remote | error.
 */
package com.devioarts.capacitor.tcpclient

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.PluginMethod
import android.os.Handler
import android.os.Looper
import java.io.ByteArrayOutputStream
/**
 * Android Capacitor bridge for TCPClient (strict API).
 * Updated to use (ByteArray, usedLen) matcher to avoid extra allocations.
 */
@CapacitorPlugin(name = "TCPClient")
class TCPClientPlugin : Plugin(), TCPClientDelegate {

    private val tcpClient = TCPClient()
// iOS-like micro-batching: 10ms window / 16KB cap
private val mergeWindowMs = 10
private val mergeMaxBytes = 16 * 1024
private val mainHandler = Handler(Looper.getMainLooper())
private var pending = ByteArrayOutputStream()
private val flushRunnable = Runnable { flushPendingNow() }

private fun flushPendingNow() {
    mainHandler.removeCallbacks(flushRunnable)
    val size = pending.size()
    if (size > 0) {
        val bytes = pending.toByteArray()
        pending.reset()
        notifyListeners("tcpData", JSObject().put("data", Helpers.bytesToJSArray(bytes)))
    }
}
private fun scheduleFlush() {
    mainHandler.removeCallbacks(flushRunnable)
    mainHandler.postDelayed(flushRunnable, mergeWindowMs.toLong())
}
    override fun load() {
        tcpClient.delegate = this
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val host = call.getString("host")
        if (host.isNullOrEmpty()) {
            call.resolve(JSObject().put("error", true).put("errorMessage", "host is required").put("connected", false)); return
        }
        val port = call.getInt("port") ?: 9100
        if (port !in 1..65535) {
            call.resolve(JSObject().put("error", true).put("errorMessage", "invalid port").put("connected", false)); return
        }
        val timeout = call.getInt("timeout") ?: 3000
        val noDelay = call.getBoolean("noDelay") ?: true
        val keepAlive = call.getBoolean("keepAlive") ?: true

        tcpClient.connect(host, port, timeout, noDelay, keepAlive) { res ->
            val obj = JSObject()
            if (res.isSuccess) obj.put("error", false).put("errorMessage", JSObject.NULL).put("connected", true)
            else obj.put("error", true).put("errorMessage", "connect failed: ${res.exceptionOrNull()?.message}").put("connected", false)
            bridge?.activity?.runOnUiThread { call.resolve(obj) }
        }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        tcpClient.disconnect()
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("disconnected", true).put("reading", false))
    }

    @PluginMethod
    fun isConnected(call: PluginCall) {
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("connected", tcpClient.isConnected()))
    }

    @PluginMethod
    fun isReading(call: PluginCall) {
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("reading", tcpClient.isReading()))
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val jsArr = call.getArray("data")
        val bytes: ByteArray? = when {
            jsArr != null -> Helpers.jsArrayToBytes(jsArr)
            else -> call.getObject("data")?.let { Helpers.jsonObjectToBytes(it) }
        }
        if (bytes == null) {
            call.resolve(JSObject()
                .put("error", true)
                .put("errorMessage", "invalid data (expected number[] / Uint8Array)")
                .put("bytesSent", 0))
            return
        }

        tcpClient.write(bytes) { res ->
            val obj = JSObject()
            if (res.isSuccess) obj.put("error", false).put("errorMessage", null).put("bytesSent", res.getOrNull())
            else obj.put("error", true).put("errorMessage", "write failed: ${res.exceptionOrNull()?.message}").put("bytesSent", 0)
            bridge?.activity?.runOnUiThread { call.resolve(obj) }
        }
    }

    @PluginMethod
    fun startRead(call: PluginCall) {
        val chunk = call.getInt("chunkSize") ?: 4096
        call.getInt("readTimeout")?.let { tcpClient.setReadTimeout(it) }
        pending.reset()
        mainHandler.removeCallbacks(flushRunnable)
        tcpClient.startRead(chunk)
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("reading", tcpClient.isReading()))
    }

    @PluginMethod
    fun stopRead(call: PluginCall) {
        tcpClient.stopRead()
        bridge?.activity?.runOnUiThread { flushPendingNow() }
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("reading", false))
    }

    @PluginMethod
    fun setReadTimeout(call: PluginCall) {
        val ms = call.getInt("readTimeout") ?: 1000
        tcpClient.setReadTimeout(ms)
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL))
    }

    /**
     * Write then read with timeout & optional pattern.
     * Matcher receives (buffer, usedLen) and uses BMH over prefix without extra copies.
     */
    @PluginMethod
fun writeAndRead(call: PluginCall) {
    val jsArr = call.getArray("data")
    val bytes: ByteArray? = when {
        jsArr != null -> Helpers.jsArrayToBytes(jsArr)
        else -> call.getObject("data")?.let { Helpers.jsonObjectToBytes(it) }
    }
    if (bytes == null) {
        call.resolve(
            JSObject()
                .put("error", true)
                .put("errorMessage", "invalid data (expected number[] / Uint8Array)")
                .put("bytesSent", 0)
                .put("bytesReceived", 0)
                .put("data", JSArray())
                .put("matched", false)
        )
        return
    }

    val timeout = call.getInt("timeout") ?: 1000
    val maxBytes = call.getInt("maxBytes") ?: 4096

    var matcher: ((ByteArray, Int) -> Boolean)? = null
    val expectStr = call.getString("expect")
    if (!expectStr.isNullOrBlank()) {
        val pat = Helpers.hexToBytes(expectStr)
        if (pat == null) {
            call.resolve(
                JSObject().put("error", true).put("errorMessage", "invalid expect (hex)")
                    .put("bytesSent", 0).put("bytesReceived", 0).put("data", JSArray()).put("matched", false)
            )
            return
        }
        matcher = { buf, used -> Helpers.indexOfRange(buf, used, pat) >= 0 }
    } else {
        val expectArr = call.getArray("expect")
        if (expectArr != null) {
            val pat = Helpers.jsArrayToBytes(expectArr)
            if (pat == null) {
                call.resolve(
                    JSObject().put("error", true).put("errorMessage", "invalid expect (number[])")
                        .put("bytesSent", 0).put("bytesReceived", 0).put("data", JSArray()).put("matched", false)
                )
                return
            }
            matcher = { buf, used -> Helpers.indexOfRange(buf, used, pat) >= 0 }
        }
    }

    val suspendRR = call.getBoolean("suspendStreamDuringRR") ?: true
    tcpClient.writeAndRead(bytes, timeout, maxBytes, matcher, suspendRR) { res ->
        val obj = JSObject()
        if (res.isSuccess) {
            val rr = res.getOrNull()!! // ReadResult
            obj.put("error", false)
                .put("errorMessage", JSObject.NULL)
                .put("bytesSent", bytes.size)
                .put("bytesReceived", rr.data.size)
                .put("data", Helpers.bytesToJSArray(rr.data))
                .put("matched", rr.matched)
        } else {
            val ex = res.exceptionOrNull()
            val timedOut = ex is TCPClient.TcpError.ConnectTimeout
            obj.put("error", true)
                .put("errorMessage", "writeAndRead failed: ${ex?.message}")
                .put("bytesSent", if (timedOut) bytes.size else 0)
                .put("bytesReceived", 0)
                .put("data", JSArray())
                .put("matched", false)
        }
        bridge?.activity?.runOnUiThread { call.resolve(obj) }
    }
}


    // --- Native → JS events ---

override fun onReceive(data: ByteArray) {
    // Micro-batch on the main thread
    bridge?.activity?.runOnUiThread {
        pending.write(data)
        if (pending.size() >= mergeMaxBytes) {
            flushPendingNow()
        } else {
            scheduleFlush()
        }
    }
}

    override fun onDisconnect(reason: TCPClient.DisconnectReason) {
        bridge?.activity?.runOnUiThread { flushPendingNow() }
        val payload = JSObject().put("disconnected", true).put("reading", false)
        when (reason) {
            is TCPClient.DisconnectReason.Manual -> payload.put("reason", "manual")
            is TCPClient.DisconnectReason.Remote -> payload.put("reason", "remote")
            is TCPClient.DisconnectReason.Error -> {
                payload.put("reason", "error")
                payload.put("error", reason.error.message ?: "error")
            }
        }
        bridge?.activity?.runOnUiThread { notifyListeners("tcpDisconnect", payload) }
    }

    override fun handleOnDestroy() { tcpClient.dispose() }
}
