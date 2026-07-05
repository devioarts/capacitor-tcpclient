/**
 * Android bridge for the TCPClient Capacitor plugin — multi-instance version.
 *
 * Each JS connectionId maps to its own TCPClient instance, delegate, and micro-batch buffer.
 * This bridge validates Capacitor calls, converts byte payloads, and routes native callbacks
 * back to tcpData/tcpDisconnect events with the originating connectionId.
 */
package com.devioarts.capacitor.tcpclient

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.PluginMethod
import android.os.Handler
import android.os.Looper
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

@CapacitorPlugin(name = "TCPClient")
class TCPClientPlugin : Plugin() {

    // MARK: - Per-connection state

    private inner class ConnState(val id: String) {
        val delegate = ConnDelegate(id)
        val client   = TCPClient().also { it.delegate = delegate }
        val pending  = ByteArrayOutputStream()
        val flushRunnable = Runnable { flushPendingNow(id) }
    }

    /** Routes TCPClient callbacks back to the plugin with the matching connectionId. */
    private inner class ConnDelegate(val id: String) : TCPClientDelegate {
        override fun onReceive(data: ByteArray)                        = this@TCPClientPlugin.onReceive(id, data)
        override fun onDisconnect(reason: TCPClient.DisconnectReason)  = this@TCPClientPlugin.onDisconnect(id, reason)
    }

    private val connections  = ConcurrentHashMap<String, ConnState>()
    private val mainHandler  = Handler(Looper.getMainLooper())
    private val mergeWindowMs = 10L
    private val mergeMaxBytes = 16 * 1024

    // MARK: - Registry helpers

    private fun getOrCreate(id: String): ConnState = connections.getOrPut(id) { ConnState(id) }

    private fun runOnMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) action() else mainHandler.post(action)
    }

    private fun requireId(call: PluginCall): String? {
        val id = call.getString("connectionId")
        if (id.isNullOrEmpty()) {
            call.resolve(JSObject().put("error", true).put("errorMessage", "connectionId is required"))
            return null
        }
        return id
    }

    // MARK: - API

    @PluginMethod
    fun connect(call: PluginCall) {
        val id   = requireId(call) ?: return
        val host = call.getString("host")
        if (host.isNullOrEmpty()) {
            call.resolve(JSObject().put("error", true).put("errorMessage", "host is required").put("connected", false)); return
        }
        val port      = call.getInt("port") ?: 9100
        if (port !in 1..65535) {
            call.resolve(JSObject().put("error", true).put("errorMessage", "invalid port").put("connected", false)); return
        }
        val timeout   = (call.getInt("timeout")        ?: 3000).coerceAtLeast(1)
        val noDelay   = call.getBoolean("noDelay")     ?: true
        val keepAlive = call.getBoolean("keepAlive")   ?: true

        getOrCreate(id).client.connect(host, port, timeout, noDelay, keepAlive) { res ->
            val obj = JSObject()
            if (res.isSuccess) obj.put("error", false).put("errorMessage", JSObject.NULL).put("connected", true)
            else               obj.put("error", true).put("errorMessage", "connect failed: ${res.exceptionOrNull()?.message}").put("connected", false)
            runOnMain { call.resolve(obj) }
        }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        val id = requireId(call) ?: return
        connections[id]?.let { state ->
            state.client.disconnect()
            runOnMain { flushPendingNow(id) }
        }
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("disconnected", true).put("reading", false))
    }

    @PluginMethod
    fun isConnected(call: PluginCall) {
        val id = requireId(call) ?: return
        val connected = connections[id]?.client?.isConnected() ?: false
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("connected", connected))
    }

    @PluginMethod
    fun isReading(call: PluginCall) {
        val id = requireId(call) ?: return
        val reading = connections[id]?.client?.isReading() ?: false
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("reading", reading))
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val id    = requireId(call) ?: return
        val state = connections[id] ?: run {
            call.resolve(JSObject().put("error", true).put("errorMessage", "not connected").put("bytesSent", 0)); return
        }
        val bytes = extractBytes(call) ?: run {
            call.resolve(JSObject().put("error", true).put("errorMessage", "invalid data (expected number[] / Uint8Array)").put("bytesSent", 0)); return
        }
        state.client.write(bytes) { res ->
            val obj = JSObject()
            if (res.isSuccess) obj.put("error", false).put("errorMessage", null).put("bytesSent", res.getOrNull())
            else               obj.put("error", true).put("errorMessage", "write failed: ${res.exceptionOrNull()?.message}").put("bytesSent", 0)
            runOnMain { call.resolve(obj) }
        }
    }

    @PluginMethod
    fun startRead(call: PluginCall) {
        val id    = requireId(call) ?: return
        val state = connections[id] ?: run {
            call.resolve(JSObject().put("error", true).put("errorMessage", "not connected").put("reading", false)); return
        }
        if (!state.client.isConnected()) {
            call.resolve(JSObject().put("error", true).put("errorMessage", "not connected").put("reading", false)); return
        }
        val chunk = call.getInt("chunkSize") ?: 4096
        call.getInt("readTimeout")?.let { state.client.setReadTimeout(it) }
        runOnMain {
            mainHandler.removeCallbacks(state.flushRunnable)
            state.pending.reset()
        }
        state.client.startRead(chunk)
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("reading", state.client.isReading()))
    }

    @PluginMethod
    fun stopRead(call: PluginCall) {
        val id = requireId(call) ?: return
        connections[id]?.let { state ->
            state.client.stopRead()
            runOnMain { flushPendingNow(id) }
        }
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("reading", false))
    }

    @PluginMethod
    fun setReadTimeout(call: PluginCall) {
        val id = requireId(call) ?: return
        val ms = call.getInt("readTimeout") ?: 1000
        connections[id]?.client?.setReadTimeout(ms)
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL))
    }

    @PluginMethod
    fun writeAndRead(call: PluginCall) {
        val id    = requireId(call) ?: return
        val state = connections[id] ?: run {
            call.resolve(JSObject().put("error", true).put("errorMessage", "not connected")
                .put("bytesSent", 0).put("bytesReceived", 0).put("data", JSArray()).put("matched", false)); return
        }
        val bytes = extractBytes(call) ?: run {
            call.resolve(JSObject().put("error", true).put("errorMessage", "invalid data (expected number[] / Uint8Array)")
                .put("bytesSent", 0).put("bytesReceived", 0).put("data", JSArray()).put("matched", false)); return
        }

        val timeout   = call.getInt("timeout")   ?: 1000
        val maxBytes  = call.getInt("maxBytes")  ?: 4096
        val suspendRR = call.getBoolean("suspendStreamDuringRR") ?: true

        var matcher: ((ByteArray, Int) -> Boolean)? = null
        val expectStr = call.getString("expect")
        if (expectStr != null && expectStr.isEmpty()) {
            matcher = null
        } else if (!expectStr.isNullOrBlank()) {
            val pat = Helpers.hexToBytes(expectStr) ?: run {
                call.resolve(JSObject().put("error", true).put("errorMessage", "invalid expect (hex)")
                    .put("bytesSent", 0).put("bytesReceived", 0).put("data", JSArray()).put("matched", false)); return
            }
            matcher = { buf, used -> Helpers.indexOfRange(buf, used, pat) >= 0 }
        } else {
            val expectArr = call.getArray("expect")
            if (expectArr != null) {
                val pat = Helpers.jsArrayToBytes(expectArr) ?: run {
                    call.resolve(JSObject().put("error", true).put("errorMessage", "invalid expect (number[])")
                        .put("bytesSent", 0).put("bytesReceived", 0).put("data", JSArray()).put("matched", false)); return
                }
                matcher = { buf, used -> Helpers.indexOfRange(buf, used, pat) >= 0 }
            } else {
                val expectObj = call.getObject("expect")
                if (expectObj != null) {
                    val pat = Helpers.jsonObjectToBytes(expectObj) ?: run {
                        call.resolve(JSObject().put("error", true).put("errorMessage", "invalid expect (byte object)")
                            .put("bytesSent", 0).put("bytesReceived", 0).put("data", JSArray()).put("matched", false)); return
                    }
                    matcher = { buf, used -> Helpers.indexOfRange(buf, used, pat) >= 0 }
                } else if (call.getData().has("expect") && !call.getData().isNull("expect")) {
                    call.resolve(JSObject().put("error", true).put("errorMessage", "invalid expect (hex or byte array expected)")
                        .put("bytesSent", 0).put("bytesReceived", 0).put("data", JSArray()).put("matched", false)); return
                }
            }
        }

        state.client.writeAndRead(bytes, timeout, maxBytes, matcher, suspendRR) { res ->
            val obj = JSObject()
            if (res.isSuccess) {
                val rr = res.getOrNull()!!
                obj.put("error", false).put("errorMessage", JSObject.NULL)
                    .put("bytesSent", bytes.size).put("bytesReceived", rr.data.size)
                    .put("data", Helpers.bytesToJSArray(rr.data)).put("matched", rr.matched)
            } else {
                val ex = res.exceptionOrNull()
                val bytesSent = if (ex is TCPClient.TcpError.ReadTimeout) bytes.size else 0
                obj.put("error", true).put("errorMessage", "writeAndRead failed: ${ex?.message}")
                    .put("bytesSent", bytesSent).put("bytesReceived", 0)
                    .put("data", JSArray()).put("matched", false)
            }
            runOnMain { call.resolve(obj) }
        }
    }

    @PluginMethod
    fun destroyConnection(call: PluginCall) {
        val id = call.getString("connectionId") ?: run { call.resolve(); return }
        connections.remove(id)?.let { state ->
            mainHandler.removeCallbacks(state.flushRunnable)
            state.client.dispose()
        }
        call.resolve()
    }

    // MARK: - Delegate callbacks

    private fun onReceive(id: String, data: ByteArray) {
        runOnMain {
            val state = connections[id] ?: return@runOnMain
            state.pending.write(data)
            if (state.pending.size() >= mergeMaxBytes) {
                flushPendingNow(id)
            } else {
                mainHandler.removeCallbacks(state.flushRunnable)
                mainHandler.postDelayed(state.flushRunnable, mergeWindowMs)
            }
        }
    }

    private fun onDisconnect(id: String, reason: TCPClient.DisconnectReason) {
        runOnMain { flushPendingNow(id) }
        val payload = JSObject().put("connectionId", id).put("disconnected", true).put("reading", false)
        when (reason) {
            is TCPClient.DisconnectReason.Manual -> payload.put("reason", "manual")
            is TCPClient.DisconnectReason.Remote -> payload.put("reason", "remote")
            is TCPClient.DisconnectReason.Error  -> payload.put("reason", "error").put("error", reason.error.message ?: "error")
        }
        runOnMain { notifyListeners("tcpDisconnect", payload) }
    }

    // MARK: - Helpers

    private fun flushPendingNow(id: String) {
        val state = connections[id] ?: return
        mainHandler.removeCallbacks(state.flushRunnable)
        val size = state.pending.size()
        if (size > 0) {
            val bytes = state.pending.toByteArray()
            state.pending.reset()
            notifyListeners("tcpData", JSObject()
                .put("connectionId", id)
                .put("data", Helpers.bytesToJSArray(bytes)))
        }
    }

    private fun extractBytes(call: PluginCall): ByteArray? {
        val jsArr = call.getArray("data")
        return when {
            jsArr != null -> Helpers.jsArrayToBytes(jsArr)
            else          -> call.getObject("data")?.let { Helpers.jsonObjectToBytes(it) }
        }
    }

    @PluginMethod
    fun getPluginPlatform(call: PluginCall) {
        call.resolve(JSObject().put("error", false).put("errorMessage", JSObject.NULL).put("platform", "android"))
    }

    override fun handleOnDestroy() {
        connections.values.forEach { state ->
            mainHandler.removeCallbacks(state.flushRunnable)
            state.client.dispose()
        }
        connections.clear()
    }
}
