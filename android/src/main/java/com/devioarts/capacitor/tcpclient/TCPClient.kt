/**
 * Android TCP client core (Kotlin).
 *
 * Responsibilities:
 * - Socket lifecycle: connect/disconnect with TCP_NODELAY/KEEPALIVE flags and buffered I/O
 * - Stream reader: background coroutine that emits data via delegate; SO_TIMEOUT used for idle ticks
 * - Request/Response (writeAndRead): serialized write, adaptive "until-idle" when no expect, optional pattern matcher, byte cap, deadline handling, and optional stream suspension
 * - Concurrency: IO dispatcher with SupervisorJob; write serialization via Mutex; RR guarded by AtomicBoolean
 *
 * This file documents behavior and edge cases without altering logic.
 */
package com.devioarts.capacitor.tcpclient

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.cancelAndJoin

interface TCPClientDelegate {
    fun onReceive(data: ByteArray)
    fun onDisconnect(reason: TCPClient.DisconnectReason)
}

class TCPClient {

    sealed class DisconnectReason {
        object Manual : DisconnectReason()
        object Remote : DisconnectReason()
        data class Error(val error: Throwable) : DisconnectReason()
    }

    sealed class TcpError(message: String) : IOException(message) {
        object NotConnected : TcpError("not connected")
        object Busy : TcpError("busy")
        object ConnectTimeout : TcpError("connect timeout")
        object Closed : TcpError("closed")
        object InvalidParams : TcpError("invalid params")
    }

    @Volatile private var socket: Socket? = null
    @Volatile private var input: BufferedInputStream? = null
    @Volatile private var output: BufferedOutputStream? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var readerJob: Job? = null
    private var lastChunkSize: Int = 4096
    private var readTimeout: Int = 1000
    private val rrInFlight = AtomicBoolean(false)
    private val writeMutex = Mutex()
    private val connectMutex = Mutex()

    @Volatile var delegate: TCPClientDelegate? = null

    data class ReadResult(val data: ByteArray, val matched: Boolean)


    fun connect(
        host: String,
        port: Int = 9100,
        timeout: Int = 3000,
        noDelay: Boolean = true,
        keepAlive: Boolean = true,
        callback: (Result<Unit>) -> Unit
    ) {
        scope.launch {
            connectMutex.withLock {
                disconnectInternal(DisconnectReason.Manual)
                try {
                    val s = Socket()
                    s.tcpNoDelay = noDelay
                    s.keepAlive = keepAlive
                    try {
                        s.connect(InetSocketAddress(host, port), timeout)
                    } catch (e: java.net.SocketTimeoutException) {
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(TcpError.ConnectTimeout)); return@withLock
                    } catch (e: SecurityException) {
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(e)); return@withLock
                    } catch (e: IOException) {
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(e)); return@withLock
                    }
                    try {
                        input = BufferedInputStream(s.getInputStream())
                        output = BufferedOutputStream(s.getOutputStream())
                        socket = s
                        callback(Result.success(Unit))
                    } catch (e: IOException) {
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(e))
                    }
                } catch (e: IOException) {
                    disconnectInternal(DisconnectReason.Error(e))
                    callback(Result.failure(e))
                }
            }
        }
    }

    fun disconnect() {
        scope.launch {
            // robust during cancellation/shutdown
            withContext(NonCancellable) {
                readerJob?.cancelAndJoin()
                readerJob = null
                val s = socket
                try { output?.flush() } catch (_: Exception) {}
                try { s?.close() } catch (_: Exception) {}
                input = null
                output = null
                socket = null
                delegate?.onDisconnect(DisconnectReason.Manual)
            }
        }
    }

    fun isConnected(): Boolean {
        val s = socket ?: return false
        // Quick local check of the socket state before deeper probing
        if (!s.isConnected || s.isClosed || s.inetAddress == null) return false

        // If RR is in flight or the reader is active, avoid touching the input stream
        if (readerJob?.isActive == true || rrInFlight.get()) return true

        // Non-destructive 1-byte peek: mark(1) + read + reset, with a short SO_TIMEOUT
        val inp = input ?: return true
        val oldTimeout = try { s.soTimeout } catch (_: Exception) { 0 }
        return try {
            try { s.soTimeout = 5 } catch (_: Exception) {}
            inp.mark(1)
            val b = inp.read() // -1 => peer closed (EOF), >=0 => data available
            if (b == -1) {
                // Peer closed the connection
                disconnectInternal(DisconnectReason.Remote)
                false
            } else {
                // Data available; restore it by resetting the stream buffer
                inp.reset()
                true
            }
        } catch (_: java.net.SocketTimeoutException) {
            // No data within the short window; connection is still alive
            true
        } catch (e: IOException) {
            // Real I/O error — treat as closed
            disconnectInternal(DisconnectReason.Error(e))
            false
        } finally {
            try { s.soTimeout = oldTimeout } catch (_: Exception) {}
        }
    }


    fun write(bytes: ByteArray, callback: (Result<Int>) -> Unit) {
        scope.launch {
            val out = output ?: run { callback(Result.failure(TcpError.NotConnected)); return@launch }
            if (!isConnected()) { callback(Result.failure(TcpError.NotConnected)); return@launch }
            writeMutex.withLock {
                try {
                    out.write(bytes)
                    out.flush()
                    callback(Result.success(bytes.size))
                } catch (e: IOException) {
                    disconnectInternal(DisconnectReason.Error(e))
                    callback(Result.failure(e))
                }
            }
        }
    }

    fun startRead(chunkSize: Int = 4096) {
        if (readerJob?.isActive == true) return
        val inp = input ?: return
        val size = if (chunkSize > 0) chunkSize else 4096
        lastChunkSize = size
        socket?.soTimeout = if (readTimeout > 0) readTimeout else 1000

        readerJob = scope.launch {
            val buf = ByteArray(size)
            while (isActive) {
                try {
                    val n = inp.read(buf)
                    if (n == -1) {
                        disconnectInternal(DisconnectReason.Remote)
                        break
                    }
                    if (n > 0) delegate?.onReceive(buf.copyOf(n))
                } catch (e: SocketTimeoutException) {
                    // idle tick; keep running
                    continue
                } catch (e: IOException) {
                    disconnectInternal(DisconnectReason.Error(e))
                    break
                }
            }
        }
    }

    fun stopRead() {
        readerJob?.cancel()
        readerJob = null
        try { socket?.soTimeout = 0 } catch (_: Exception) {}
    }

    fun isReading(): Boolean = readerJob?.isActive == true

    fun setReadTimeout(ms: Int) {
        readTimeout = if (ms > 0) ms else 1000
        try { socket?.soTimeout = readTimeout } catch (_: Exception) {}
    }

    /**
     * Request/Response read with minimal allocations.
     * - Single growth buffer [buf] with [used] counter (no per-iteration toByteArray()).
     * - [expect] receives (buffer, usedLen) to check current prefix without copying.
     */
    fun writeAndRead(
        bytes: ByteArray,
        timeout: Int = 1000,
        maxBytes: Int = 4096,
        expect: ((ByteArray, Int) -> Boolean)? = null,
        suspendStreamDuringRR: Boolean = false,
        callback: (Result<ReadResult>) -> Unit
    ) {
        val effTimeout = if (timeout > 0) timeout else 1000
        val cap = if (maxBytes > 0) maxBytes else 4096
        if (!isConnected() || input == null || output == null) {
            callback(Result.failure(TcpError.NotConnected)); return
        }
        if (!rrInFlight.compareAndSet(false, true)) {
            callback(Result.failure(TcpError.Busy)); return
        }

        scope.launch {
            var wasReading = false
            val previousTimeout: Int = try { socket?.soTimeout ?: 0 } catch (_: Exception) { 0 }
            try {
                if (suspendStreamDuringRR && readerJob?.isActive == true) {
                    wasReading = true
                    readerJob?.cancelAndJoin()
                    readerJob = null
                }

                // Write request (serialized under writeMutex)
                writeMutex.withLock {
                    try {
                        output!!.write(bytes)
                        output!!.flush()
                    } catch (e: IOException) {
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(e))
                        return@launch
                    }
                }

                // Read with adaptive 'until-idle' (when no expect pattern is provided)
                val inp = input!!
                val buf = ByteArray(cap)
                val tmp = ByteArray(minOf(4096, cap))
                var used = 0
                var matched = false

                val deadlineNs = System.nanoTime() + effTimeout * 1_000_000L

                var lastDataAtNs = 0L
                val interArr = mutableListOf<Long>() // keep last 5 samples

                fun idleThresholdMs(): Int {
                    if (interArr.isEmpty()) return 50
                    val sorted = interArr.sorted()
                    val med = if (sorted.size % 2 == 1)
                        sorted[sorted.size / 2].toDouble()
                    else
                        0.5 * (sorted[sorted.size / 2 - 1] + sorted[sorted.size / 2]).toDouble()
                    return (med * 1.75).toInt().coerceIn(50, 200)
                }

                while (used < cap) {
                    val remainMs = ((deadlineNs - System.nanoTime()).coerceAtLeast(0)) / 1_000_000L
                    if (remainMs <= 0) {
                        // Parity with iOS: if any data arrived, resolve success (matched=false); otherwise, timeout
                        if (used > 0) {
                            callback(Result.success(ReadResult(buf.copyOf(used), false))); return@launch
                        } else {
                            callback(Result.failure(TcpError.ConnectTimeout)); return@launch
                        }
                    }

                    val stepMs = if (expect == null && used > 0)
                        idleThresholdMs().toLong().coerceAtMost(remainMs)
                    else
                        minOf(200L, remainMs)
                    try { socket?.soTimeout = stepMs.toInt().coerceAtLeast(1) } catch (_: Exception) {}

                    val toRead = minOf(tmp.size, cap - used)
                    if (toRead <= 0) break

                    try {
                        val n = inp.read(tmp, 0, toRead)
                        if (n == -1) throw TcpError.Closed
                        if (n > 0) {
                            val copyLen = minOf(n, cap - used)
                            System.arraycopy(tmp, 0, buf, used, copyLen)
                            used += copyLen

                            val now2 = System.nanoTime()
                            if (lastDataAtNs != 0L) {
                                val dMs = (now2 - lastDataAtNs) / 1_000_000L
                                interArr.add(dMs)
                                if (interArr.size > 5) interArr.removeAt(0)
                            }
                            lastDataAtNs = now2

                            if (expect != null) {
                                if (expect.invoke(buf, used)) {
                                    matched = true
                                    callback(Result.success(ReadResult(buf.copyOf(used), true))); return@launch
                                }
                                if (used >= cap) {
                                    callback(Result.success(ReadResult(buf.copyOf(used), false))); return@launch
                                }
                                // otherwise continue collecting
                            } else {
                                if (used >= cap) {
                                    callback(Result.success(ReadResult(buf.copyOf(used), false))); return@launch
                                }
                                // Without an expect pattern: wait for the 'idle' condition on the next iteration
                                continue
                            }
                        }
                    } catch (e: SocketTimeoutException) {
                        if (expect == null && used > 0) {
                            // until-idle — silent period after last data
                            callback(Result.success(ReadResult(buf.copyOf(used), false))); return@launch
                        }
                        // With an expect pattern: keep waiting until the deadline
                        continue
                    }
                }

                callback(Result.success(ReadResult(buf.copyOf(used), matched)))
            } catch (e: IOException) {
                callback(Result.failure(e))
            } finally {
                try { socket?.soTimeout = previousTimeout } catch (_: Exception) {}
                rrInFlight.set(false)
                if (suspendStreamDuringRR && wasReading && isConnected()) {
                    startRead(lastChunkSize)
                }
            }
        }
    }



    private fun disconnectInternal(reason: DisconnectReason) {
        val hadSomething = (socket != null) || (readerJob != null)
        try { readerJob?.cancel() } catch (_: Exception) {}
        readerJob = null
        try { socket?.close() } catch (_: Exception) {}
        input = null
        output = null
        socket = null
        if (hadSomething) delegate?.onDisconnect(reason)
    }

    fun dispose() {
        disconnectInternal(DisconnectReason.Manual)
        delegate = null
        scope.cancel()
    }
}
