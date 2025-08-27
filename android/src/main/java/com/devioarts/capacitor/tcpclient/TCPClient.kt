package com.devioarts.capacitor.tcpclient

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.cancelAndJoin

/**
 * Delegate used by the Kotlin TCP client to push data/events to the host layer (the Capacitor plugin).
 * - onReceive: delivers raw bytes from the stream reader
 * - onDisconnect: explains why the connection ended (manual, remote EOF, or error)
 */
interface TCPClientDelegate {
    fun onReceive(data: ByteArray)
    fun onDisconnect(reason: TCPClient.DisconnectReason)
}

/**
 * Android TCP client built on java.net.Socket with Kotlin coroutines.
 *
 * Design goals:
 * - Minimal dependencies (plain Socket + coroutines)
 * - Thread-safety and backpressure via a dedicated IO scope and Mutex for writes
 * - Optional continuous stream read (readerJob) that emits chunks via delegate
 * - Request/response helper (writeAndRead) with timeout and optional pattern matching
 *
 * Concurrency model:
 * - All blocking I/O is executed on Dispatchers.IO within a SupervisorJob-backed scope.
 * - Writes are serialized by a Mutex to avoid interleaving across coroutines.
 * - A lightweight AtomicBoolean prevents concurrent write-and-read (RR) operations.
 *
 * Notes:
 * - SO_LINGER is left commented out; you can enable it for faster teardown (RST) if your device benefits.
 * - Socket read timeout (soTimeout) is adjusted temporarily during RR and restored afterwards.
 * - When RR is active and streaming is requested to suspend, the reader job is cancelled and resumed later.
 */
class TCPClient {
    /** Why the connection ended. */
    sealed class DisconnectReason {
        object Manual : DisconnectReason()
        object Remote : DisconnectReason()
        data class Error(val error: Throwable) : DisconnectReason()
    }

    /**
     * Public error surface kept compact and transport-oriented.
     * Serializable singletons ensure safe round-tripping if ever needed.
     */
    sealed class TcpError(message: String) : IOException(message), java.io.Serializable {
        object NotConnected : TcpError("not connected") {
            @Throws(java.io.ObjectStreamException::class)
            private fun readResolve(): Any = NotConnected
        }
        object Busy : TcpError("busy") {
            @Throws(java.io.ObjectStreamException::class)
            private fun readResolve(): Any = Busy
        }
        object ConnectTimeout : TcpError("connect timeout") {
            @Throws(java.io.ObjectStreamException::class)
            private fun readResolve(): Any = ConnectTimeout
        }
        object Closed : TcpError("closed") {
            @Throws(java.io.ObjectStreamException::class)
            private fun readResolve(): Any = Closed
        }
        object InvalidParams : TcpError("invalid params") {
            @Throws(java.io.ObjectStreamException::class)
            private fun readResolve(): Any = InvalidParams
        }
    }

    // --- Socket & streams (volatile for visibility across threads) ---
    @Volatile private var socket: Socket? = null
    @Volatile private var input: BufferedInputStream? = null
    @Volatile private var output: BufferedOutputStream? = null

    // --- Coroutine machinery ---
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var readerJob: Job? = null
    private var lastChunkSize: Int = 4096
    private var readTimeoutMs: Int = 1000
    private val rrInFlight = AtomicBoolean(false)    // excludes concurrent writeAndRead
    private val writeMutex = Mutex()                 // serializes write() and RR write phase

    private val connectMutex = Mutex()               // prevents overlapping connect attempts

    @Volatile
    var delegate: TCPClientDelegate? = null

    /**
     * Open a TCP connection to [host]:[port].
     * - Applies tcpNoDelay and keepAlive as requested.
     * - Wraps the streams in buffered variants for efficiency.
     * - Calls back with success or a failure (connect timeout, IO/security error, etc.).
     *
     * The entire flow is guarded by [connectMutex] so concurrent connect requests won't overlap.
     */
    fun connect(
        host: String,
        port: Int = 9100,
        timeoutMs: Int = 3000,
        noDelay: Boolean = true,
        keepAlive: Boolean = true,
        callback: (Result<Unit>) -> Unit
    ) {
        scope.launch {
            connectMutex.withLock {
                // Tear down any previous session first (emits delegate disconnect if needed).
                disconnectInternal(DisconnectReason.Manual)

                try {
                    val s = Socket()
                    s.tcpNoDelay = noDelay
                    s.keepAlive = keepAlive
                    // optional: faster teardown (RST instead of FIN)
                    // s.setSoLinger(true, 0)

                    try {
                        s.connect(InetSocketAddress(host, port), timeoutMs)
                    } catch (e: java.net.SocketTimeoutException) {
                        // Normalize timeouts to a stable, typed error
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(TcpError.ConnectTimeout))
                        return@withLock
                    } catch (e: SecurityException) {
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(e))
                        return@withLock
                    }

                    socket = s
                    input = BufferedInputStream(s.getInputStream())
                    output = BufferedOutputStream(s.getOutputStream())
                    callback(Result.success(Unit))
                } catch (e: IOException) {
                    disconnectInternal(DisconnectReason.Error(e))
                    callback(Result.failure(e))
                }
            }
        }
    }

    /** Public disconnect entry point. Runs on IO scope and safely tears down the connection. */
    fun disconnect() {
        scope.launch { disconnectInternal(DisconnectReason.Manual) }
    }

    /**
     * Lightweight connection health check:
     * - true if socket exists, is connected, not closed, and has a valid inetAddress.
     * - false otherwise.
     */
    fun isConnected(): Boolean {
        val s = socket ?: return false
        return s.isConnected && !s.isClosed && s.inetAddress != null
    }

    /**
     * Write all [bytes] to the socket.
     * - Serialized by [writeMutex] to avoid interleaved writes.
     * - Fails fast if not connected or a request/response cycle is already in flight.
     * - On IO failure, we disconnect and surface the exception.
     */
    fun write(bytes: ByteArray, callback: (Result<Int>) -> Unit) {
        val out = output
        if (!isConnected() || out == null) {
            callback(Result.failure(TcpError.NotConnected)); return
        }
        if (rrInFlight.get()) {
            callback(Result.failure(TcpError.Busy)); return
        }
        scope.launch {
            try {
                writeMutex.withLock {
                    out.write(bytes)
                    out.flush()
                }
                callback(Result.success(bytes.size))
            } catch (e: IOException) {
                // Treat write failures as fatal; notify delegate via disconnect.
                disconnectInternal(DisconnectReason.Error(e))
                callback(Result.failure(e))
            }
        }
    }

    /**
     * Start a continuous stream reader.
     * - Allocates a fixed-size buffer and repeatedly reads from the socket.
     * - Emits chunks to [delegate.onReceive].
     * - On EOF (-1) it reports a remote disconnect and stops.
     * - Read timeouts (soTimeout) are treated as idle; loop continues unless cancelled.
     */
    fun startRead(chunkSize: Int = 4096) {
        if (readerJob?.isActive == true) return
        val inp = input ?: return
        val size = if (chunkSize > 0) chunkSize else 4096
        lastChunkSize = size
        socket?.soTimeout = if (readTimeoutMs > 0) readTimeoutMs else 1000
        readerJob = scope.launch {
            val buf = ByteArray(size)
            while (isActive) {
                try {
                    val n = try { inp.read(buf) } catch (e: java.net.SocketTimeoutException) {
                        // Idle read: no data within soTimeout; keep looping while active.
                        if (!isActive) break
                        continue
                    }

                    if (n == -1) {
                        // EOF: peer closed the connection.
                        disconnectInternal(DisconnectReason.Remote)
                        break
                    }
                    if (n > 0) {
                        // Copy the bytes to avoid exposing a shared buffer.
                        delegate?.onReceive(buf.copyOf(n))
                    }
                } catch (e: IOException) {
                    // Read error: treat as fatal and notify.
                    disconnectInternal(DisconnectReason.Error(e))
                    break
                }
            }
        }
    }

    /**
     * Stop the stream reader (if any) and reset the per-socket timeout to 0 (blocking).
     * Idempotent and safe to call multiple times.
     */
    fun stopRead() {
        readerJob?.cancel()
        readerJob = null
        try { socket?.soTimeout = 0 } catch (_: Exception) {}
    }

    /** True if a reader coroutine is currently active. */
    fun isReading(): Boolean = readerJob?.isActive == true

    /**
     * Configure the per-socket read timeout used by the stream reader and RR.
     * Internally guards against invalid values and applies immediately when possible.
     */
    fun setReadTimeout(ms: Int) {
        readTimeoutMs = if (ms > 0) ms else 1000
        try { socket?.soTimeout = readTimeoutMs } catch (_: Exception) {}
    }

    /**
     * Write and synchronous read-back with timeout and optional pattern.
     *
     * Parameters:
     * - [bytes]: request payload to send
     * - [timeoutMs]: maximum time to wait for a response (applied via soTimeout)
     * - [maxBytes]: upper bound on the collected response size
     * - [expect]: optional predicate; stop early when it returns true on the accumulated bytes
     * - [suspendStreamDuringRR]: when true, pause the stream reader to avoid stealing the RR response
     *
     * Behavior:
     * - Fails fast if not connected or another RR is already running.
     * - Serializes the write phase via [writeMutex] (same path as write()).
     * - Temporarily adjusts socket soTimeout and restores it afterwards.
     * - On timeout, returns a ConnectTimeout error; on EOF, returns Closed.
     */
    fun writeAndRead(
        bytes: ByteArray,
        timeoutMs: Int = 1000,
        maxBytes: Int = 4096,
        expect: ((ByteArray) -> Boolean)? = null,
        suspendStreamDuringRR: Boolean = false,
        callback: (Result<ByteArray>) -> Unit
    ) {
        val effTimeout = if (timeoutMs > 0) timeoutMs else 1000
        val cap = if (maxBytes > 0) maxBytes else 4096
        if (!isConnected() || input == null || output == null) {
            callback(Result.failure(TcpError.NotConnected)); return
        }
        if (!rrInFlight.compareAndSet(false, true)) {
            callback(Result.failure(TcpError.Busy)); return
        }

        scope.launch {
            val s = socket!!
            val wasReading = readerJob?.isActive == true
            val prevTimeout = s.soTimeout
            if (suspendStreamDuringRR && wasReading) {
                // Shorten timeout for a prompt cancellation and stop the reader gracefully.
                try { s.soTimeout = 50 } catch (_: Exception) {}
                readerJob?.cancelAndJoin()
            }

            val inp = input!!
            val out = output!!
            try {
                // Temporary read timeout for the RR receive phase.
                s.soTimeout = effTimeout
                // Serialize the write with the standard write mutex to preserve ordering.
                writeMutex.withLock { out.write(bytes); out.flush() }

                val baos = java.io.ByteArrayOutputStream(cap)
                val temp = ByteArray(minOf(2048, cap))

                while (true) {
                    val toRead = minOf(temp.size, cap - baos.size())
                    if (toRead <= 0) break
                    val n = try { inp.read(temp, 0, toRead) } catch (e: java.net.SocketTimeoutException) {
                        // Timed out waiting for response.
                        callback(Result.failure(TcpError.ConnectTimeout)); return@launch
                    }

                    if (n == -1) throw TcpError.Closed
                    if (n > 0) {
                        baos.write(temp, 0, n)
                        val current = baos.toByteArray()
                        // Early exit strategies:
                        if (expect == null) {
                            callback(Result.success(current)); return@launch
                        } else if (expect.invoke(current)) {
                            callback(Result.success(current)); return@launch
                        } else if (baos.size() >= cap) {
                            callback(Result.success(current)); return@launch
                        }
                    }
                }
                // Cap or loop ended without early exit.
                callback(Result.success(baos.toByteArray()))
            } catch (e: IOException) {
                callback(Result.failure(e))
            } finally {
                rrInFlight.set(false)
                try { s.soTimeout = prevTimeout } catch (_: Exception) {}
                // Resume streaming only if it was running before and the socket is still healthy.
                if (suspendStreamDuringRR && wasReading && isConnected()) startRead(lastChunkSize)
            }
        }
    }

    /**
     * Internal teardown routine (shared by public disconnect and error paths).
     * - Stops the reader
     * - Shuts down and closes the socket and streams
     * - Clears references
     * - Notifies the delegate once if there was any active state
     */
    private fun disconnectInternal(reason: DisconnectReason) {
        rrInFlight.set(false)
        val hadSomething = socket != null || input != null || output != null || readerJob != null

        stopRead()
        try { socket?.shutdownInput() } catch (_: Exception) {}
        try { socket?.shutdownOutput() } catch (_: Exception) {}
        try { output?.close() } catch (_: Exception) {}
        try { input?.close() } catch (_: Exception) {}
        try { socket?.close() } catch (_: Exception) {}
        output = null
        input = null
        socket = null
        if (hadSomething) delegate?.onDisconnect(reason)
    }

    /**
     * Dispose the client and cancel the coroutine scope.
     * Safe to call during app/plugin teardown.
     */
    fun dispose() {
        disconnectInternal(DisconnectReason.Manual)
        delegate = null
        scope.cancel()
    }
}
