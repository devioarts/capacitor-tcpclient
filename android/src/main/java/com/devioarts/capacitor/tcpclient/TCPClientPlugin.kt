package com.devioarts.capacitor.tcpclient

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.PluginMethod


@CapacitorPlugin(name = "TCPClient")
class TCPClientPlugin : Plugin(), TCPClientDelegate {

    private val tcpClient = TCPClient()

    override fun load() {
        // Wire the native client's delegate so we can forward async events to JS.
        tcpClient.delegate = this
    }

    /**
     * Connect to a TCP host.
     * JS: TCPClient.tcpConnect({ host, port?, timeoutMs?, noDelay?, keepAlive? })
     * Resolves with: { error, errorMessage, connected }
     *
     * Notes:
     * - Input validation: 'host' is required.
     * - Result is resolved on UI thread for bridge stability across OEM WebViews.
     */
    @PluginMethod
    fun tcpConnect(call: PluginCall) {
        val host = call.getString("host")
        if (host.isNullOrEmpty()) { call.resolve(JSObject().put("error", true).put("errorMessage", "host is required").put("connected", false)); return }
        val port = call.getInt("port") ?: 9100
        if (port !in 1..65535) {
            call.resolve(JSObject().put("error", true).put("errorMessage", "invalid port").put("connected", false))
            return
        }

        val timeoutMs = call.getInt("timeoutMs") ?: 3000
        val noDelay = call.getBoolean("noDelay") ?: true
        val keepAlive = call.getBoolean("keepAlive") ?: true

        tcpClient.connect(host, port, timeoutMs, noDelay, keepAlive) { res ->
            val obj = JSObject()
            if (res.isSuccess) obj.put("error", false).put("errorMessage", null).put("connected", true)
            else obj.put("error", true).put("errorMessage", "connect failed: ${res.exceptionOrNull()?.message}").put("connected", false)
            bridge?.activity?.runOnUiThread {call.resolve(obj)}
        }
    }

    /**
     * Disconnect the current session (idempotent).
     * Resolves with: { error, errorMessage, disconnected, reading:false }
     *
     * Also ensures stream reading is considered stopped from the JS perspective.
     */
    @PluginMethod
    fun tcpDisconnect(call: PluginCall) {
        tcpClient.disconnect()
        call.resolve(JSObject().put("error", false).put("errorMessage", null).put("disconnected", true).put("reading", false))
    }

    /**
     * Report socket connection status.
     * Resolves with: { error, errorMessage, connected }
     */
    @PluginMethod
    fun tcpIsConnected(call: PluginCall) {
        call.resolve(JSObject().put("error", false).put("errorMessage", null).put("connected", tcpClient.isConnected()))
    }

    /**
     * Write raw bytes to the socket.
     * Expects `data` as a JS array of numbers (0..255).
     * Resolves with: { error, errorMessage, bytesWritten }
     */
@PluginMethod
fun tcpWrite(call: PluginCall) {
    val arr = call.getArray("data")
    if (arr == null) {
        call.resolve(JSObject().put("error", true).put("errorMessage", "data is required (number[])").put("bytesWritten", 0))
        return
    }
    val bytes = Helpers.jsArrayToBytes(arr)
    if (bytes == null) {
        call.resolve(JSObject().put("error", true).put("errorMessage", "invalid data (expected number[])").put("bytesWritten", 0))
        return
    }
    tcpClient.write(bytes) { res ->
        val obj = JSObject()
        if (res.isSuccess) obj.put("error", false).put("errorMessage", null).put("bytesWritten", res.getOrNull())
        else obj.put("error", true).put("errorMessage", "write failed: ${res.exceptionOrNull()?.message}").put("bytesWritten", 0)
        bridge?.activity?.runOnUiThread { call.resolve(obj) }
    }
}

    /**
     * Start continuous stream reading.
     * Optional timeouts:
     *   - timeoutMs (preferred) or readTimeoutMs (deprecated alias)
     * Resolves with: { error, errorMessage, reading:true }
     *
     * The native layer emits 'tcpData' events with chunks as int arrays.
     */
    @PluginMethod
    fun tcpStartRead(call: PluginCall) {
        val chunk = call.getInt("chunkSize") ?: 4096
        (call.getInt("timeoutMs") ?: call.getInt("readTimeoutMs"))?.let { tcpClient.setReadTimeout(it) }
        tcpClient.startRead(chunk)
        call.resolve(JSObject().put("error", false).put("errorMessage", null).put("reading", true))
    }

    /**
     * Stop the stream reader (no-op if not running).
     * Resolves with: { error, errorMessage, reading:false }
     */
    @PluginMethod
    fun tcpStopRead(call: PluginCall) {
        tcpClient.stopRead()
        call.resolve(JSObject().put("error", false).put("errorMessage", null).put("reading", false))
    }

    /**
     * Report whether the native reader coroutine is active.
     * Resolves with: { error, errorMessage, reading }
     */
    @PluginMethod
    fun tcpIsReading(call: PluginCall) {
        call.resolve(JSObject().put("error", false).put("errorMessage", null).put("reading", tcpClient.isReading()))
    }

    /**
     * Set the per-socket read timeout used by reader and RR.
     * Accepts 'timeoutMs' (preferred) or legacy 'ms'.
     */
    @PluginMethod
    fun tcpSetReadTimeout(call: PluginCall) {
        val ms = call.getInt("timeoutMs") ?: call.getInt("ms") ?: 1000
        tcpClient.setReadTimeout(ms)
        call.resolve()
    }

    /**
     * Write bytes and synchronously read a response with timeout and optional pattern match.
     * Inputs:
     *   - data: number[]
     *   - timeoutMs?: number
     *   - maxBytes?: number
     *   - expect?: hex string or number[] (stop when pattern found)
     *   - suspendStreamDuringRR?: boolean (pause streaming to avoid stealing the reply)
     *
     * Resolves with:
     *   - success: { error:false, errorMessage:null, bytesWritten, bytesRead, data:int[] }
     *   - timeout: { error:true, errorMessage, bytesWritten: data.length, bytesRead:0, data:[] }
     *   - other errors: { error:true, errorMessage, bytesWritten:0, bytesRead:0, data:[] }
     */
    @PluginMethod
    fun tcpWriteAndRead(call: PluginCall) {
        val arr = call.getArray("data")
        if (arr == null) { call.resolve(JSObject().put("error", true).put("errorMessage", "data is required (number[])").put("bytesWritten", 0).put("bytesRead", 0).put("data", JSArray())); return }
        val bytes = Helpers.jsArrayToBytes(arr)
        if (bytes == null) {
            call.resolve(JSObject().put("error", true).put("errorMessage", "invalid data (expected number[])")
                .put("bytesWritten", 0).put("bytesRead", 0).put("data", JSArray()))
            return
        }



        val timeout = call.getInt("timeoutMs") ?: 1000
        val maxBytes = call.getInt("maxBytes") ?: 4096

        // Optional 'expect' matcher: hex string or number[] → convert to ByteArray and search.
        var matcher: ((ByteArray) -> Boolean)? = null
        val expectStr = call.getString("expect")
        if (!expectStr.isNullOrBlank()) {
            val pat = Helpers.hexToBytes(expectStr)
            if (pat != null) matcher = { buf -> Helpers.indexOf(buf, pat) >= 0 }
        } else {
            val expectArr = call.getArray("expect")
            if (expectArr != null) {
                val pat = Helpers.jsArrayToBytes(expectArr)
                matcher = { buf -> Helpers.indexOf(buf, pat) >= 0 }
            }
        }

        val suspendRR = call.getBoolean("suspendStreamDuringRR") ?: true
        tcpClient.writeAndRead(bytes, timeout, maxBytes, matcher, suspendRR) { res ->
            val obj = JSObject()
            if (res.isSuccess) {
                val data = res.getOrNull() ?: ByteArray(0)
                obj.put("error", false)
                    .put("errorMessage", null)
                    .put("bytesWritten", bytes.size)
                    .put("bytesRead", data.size)
                    .put("data", Helpers.bytesToJSArray(data))
            } else {
                val ex = res.exceptionOrNull()
                val timedOut = ex is TCPClient.TcpError.ConnectTimeout
                obj.put("error", true)
                    .put("errorMessage", "writeAndRead failed: ${ex?.message}")
                    .put("bytesWritten", if (timedOut) bytes.size else 0)
                    .put("bytesRead", 0)
                    .put("data", JSArray())
            }
            bridge?.activity?.runOnUiThread {call.resolve(obj)}
        }
    }

    // --- TCPClientDelegate (native → JS events) ---

    /**
     * Stream chunk from the native reader.
     * Forward to JS event 'tcpData' with an int[] payload for compatibility with WebView JSON.
     */
    override fun onReceive(data: ByteArray) {
        bridge?.activity?.runOnUiThread {
            notifyListeners("tcpData", JSObject().put("data", Helpers.bytesToJSArray(data)))
        }
    }

    /**
     * Notify JS about disconnection.
     * Payload includes reason: "manual" | "remote" | "error" and resets reading:false for UI parity.
     */
    override fun onDisconnect(reason: TCPClient.DisconnectReason) {
        val payload = JSObject().put("disconnected", true)
            .put("reading", false) // ensure renderer-side reading state is cleared
        when (reason) {
            is TCPClient.DisconnectReason.Manual -> payload.put("reason", "manual")
            is TCPClient.DisconnectReason.Remote -> payload.put("reason", "remote")
            is TCPClient.DisconnectReason.Error -> {
                payload.put("reason", "error")
                payload.put("error", reason.error.message ?: "error")
            }
        }
        bridge?.activity?.runOnUiThread {
            notifyListeners("tcpDisconnect", payload)
        }
    }

    /**
     * Plugin lifecycle hook.
     * Dispose the native client and cancel its coroutine scope to prevent leaks.
     */
    override fun handleOnDestroy() {
        tcpClient.dispose()
    }

}
