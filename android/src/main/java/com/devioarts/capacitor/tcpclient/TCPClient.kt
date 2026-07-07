/**
 * Android TCP client core (Kotlin).
 *
 * Responsibilities:
 * - Socket lifecycle: connect/disconnect with TCP_NODELAY/KEEPALIVE flags and buffered I/O
 * - Stream reader: background coroutine that emits data via delegate; SO_TIMEOUT controls idle wakeups
 * - Request/Response (writeAndRead): serialized write, adaptive "until-idle" when no expect, optional pattern matcher, byte cap, deadline handling, and optional stream suspension
 * - Concurrency: IO dispatcher with SupervisorJob; write serialization via Mutex; RR guarded by AtomicBoolean
 *
 * This core owns the actual socket and stream state; TCPClientPlugin.kt adapts it to Capacitor calls.
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
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
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
        object WriteTimeout : TcpError("write timeout")
        object ReadTimeout : TcpError("read timeout")
        object Closed : TcpError("closed")
        object InvalidParams : TcpError("invalid params")
    }

    @Volatile private var socket: Socket? = null
    @Volatile private var connectingSocket: Socket? = null
    @Volatile private var input: BufferedInputStream? = null
    @Volatile private var output: BufferedOutputStream? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val readStateLock = Any()
    @Volatile private var readerJob: Job? = null
    @Volatile private var lastChunkSize: Int = DEFAULT_CHUNK_SIZE
    @Volatile private var readTimeout: Int = 1000
    @Volatile private var connectionGeneration: Long = 0
    private val disposed = AtomicBoolean(false)
    private val rrInFlight = AtomicBoolean(false)
    private val writeMutex = Mutex()
    private val connectMutex = Mutex()

    @Volatile var delegate: TCPClientDelegate? = null

    data class ReadResult(val data: ByteArray, val matched: Boolean)

    private data class ConnectionSnapshot(
        val socket: Socket,
        val input: BufferedInputStream,
        val output: BufferedOutputStream,
        val generation: Long
    )

    private companion object {
        const val DEFAULT_CHUNK_SIZE = 4096
        const val MAX_BUFFER_BYTES = 16 * 1024 * 1024
        const val MAX_AGGREGATE_BUFFER_BYTES = 64 * 1024 * 1024
        const val WRITE_TIMEOUT_MS = 3000L
        const val MIN_RR_IDLE_MS = 100
        const val MAX_RR_IDLE_MS = 200
        val aggregateBufferBytes = AtomicInteger(0)
    }

    fun connect(
        host: String,
        port: Int = 9100,
        timeout: Int = 3000,
        noDelay: Boolean = true,
        keepAlive: Boolean = true,
        callback: (Result<Unit>) -> Unit
    ) {
        if (disposed.get()) {
            callback(Result.failure(TcpError.Closed))
            return
        }
        scope.launch {
            val connectTimeout = timeout.coerceAtLeast(1)
            val deadlineNs = System.nanoTime() + connectTimeout * 1_000_000L
            val address = try {
                // Resolve before taking connectMutex so slow DNS cannot block
                // disconnects or other lifecycle operations on this client.
                withTimeout(connectTimeout.toLong()) {
                    withContext(Dispatchers.IO) { InetSocketAddress(host, port) }
                }
            } catch (e: TimeoutCancellationException) {
                callback(Result.failure(TcpError.ConnectTimeout)); return@launch
            } catch (e: IllegalArgumentException) {
                callback(Result.failure(e)); return@launch
            } catch (e: SecurityException) {
                callback(Result.failure(e)); return@launch
            }
            if (address.isUnresolved) {
                callback(Result.failure(UnknownHostException(host))); return@launch
            }
            if (disposed.get()) {
                callback(Result.failure(TcpError.Closed)); return@launch
            }

            connectMutex.withLock {
                if (disposed.get()) {
                    callback(Result.failure(TcpError.Closed)); return@withLock
                }
                val remainingConnectMs = ((deadlineNs - System.nanoTime()).coerceAtLeast(0)) / 1_000_000L
                if (remainingConnectMs <= 0) {
                    callback(Result.failure(TcpError.ConnectTimeout)); return@withLock
                }
                disconnectInternal(DisconnectReason.Manual)
                var pendingSocket: Socket? = null
                try {
                    val s = Socket()
                    pendingSocket = s
                    s.tcpNoDelay = noDelay
                    s.keepAlive = keepAlive
                    connectingSocket = s
                    try {
                        s.connect(address, remainingConnectMs.toInt().coerceAtLeast(1))
                    } catch (e: java.net.SocketTimeoutException) {
                        closeQuietly(pendingSocket)
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(if (disposed.get()) TcpError.Closed else TcpError.ConnectTimeout)); return@withLock
                    } catch (e: SecurityException) {
                        closeQuietly(pendingSocket)
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(e)); return@withLock
                    } catch (e: IOException) {
                        closeQuietly(pendingSocket)
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(if (disposed.get()) TcpError.Closed else e)); return@withLock
                    } finally {
                        if (connectingSocket === s) connectingSocket = null
                    }
                    if (disposed.get()) {
                        closeQuietly(pendingSocket)
                        callback(Result.failure(TcpError.Closed)); return@withLock
                    }
                    try {
                        input = BufferedInputStream(s.getInputStream())
                        output = BufferedOutputStream(s.getOutputStream())
                        socket = s
                        connectionGeneration++
                        pendingSocket = null
                        callback(Result.success(Unit))
                    } catch (e: IOException) {
                        closeQuietly(pendingSocket)
                        disconnectInternal(DisconnectReason.Error(e))
                        callback(Result.failure(e))
                    }
                } catch (e: IllegalArgumentException) {
                    closeQuietly(pendingSocket)
                    disconnectInternal(DisconnectReason.Error(e))
                    callback(Result.failure(e))
                } catch (e: IOException) {
                    closeQuietly(pendingSocket)
                    disconnectInternal(DisconnectReason.Error(e))
                    callback(Result.failure(e))
                }
            }
        }
    }

    fun disconnect(callback: (() -> Unit)? = null) {
        if (disposed.get()) {
            callback?.invoke()
            return
        }
        scope.launch {
            withContext(NonCancellable) {
                connectMutex.withLock {
                    disconnectInternal(DisconnectReason.Manual)
                }
            }
            callback?.invoke()
        }
    }

    fun isConnected(): Boolean {
        val s = socket ?: return false
        // Quick local check of the socket state before deeper probing
        return s.isConnected && !s.isClosed && s.inetAddress != null
    }


    fun write(bytes: ByteArray, callback: (Result<Int>) -> Unit) {
        scope.launch {
            val snapshot = currentSnapshot()
            if (snapshot == null || !isConnected(snapshot.socket)) {
                callback(Result.failure(TcpError.NotConnected)); return@launch
            }
            if (rrInFlight.get()) { callback(Result.failure(TcpError.Busy)); return@launch }
            writeMutex.withLock {
                if (rrInFlight.get()) {
                    callback(Result.failure(TcpError.Busy)); return@withLock
                }
                try {
                    writeAllWithTimeout(snapshot.socket, snapshot.output, bytes, WRITE_TIMEOUT_MS)
                    callback(Result.success(bytes.size))
                } catch (e: TcpError.WriteTimeout) {
                    disconnectIfCurrent(snapshot, DisconnectReason.Error(e))
                    callback(Result.failure(e))
                } catch (e: IOException) {
                    disconnectIfCurrent(snapshot, DisconnectReason.Error(e))
                    callback(Result.failure(e))
                }
            }
        }
    }

    fun startRead(chunkSize: Int = 4096) {
        val size = if (chunkSize > 0) chunkSize.coerceAtMost(MAX_BUFFER_BYTES) else DEFAULT_CHUNK_SIZE
        if (!tryAcquireBufferBudget(size)) return
        val snapshot = currentSnapshot() ?: run {
            releaseBufferBudget(size)
            return
        }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val buf = ByteArray(size)
                while (isActive) {
                    try {
                        val n = snapshot.input.read(buf)
                        if (!isActive) break
                        if (n == -1) {
                            disconnectIfCurrent(snapshot, DisconnectReason.Remote)
                            break
                        }
                        if (n > 0 && isActive) delegate?.onReceive(buf.copyOf(n))
                    } catch (e: SocketTimeoutException) {
                        // idle tick; keep running
                        continue
                    } catch (e: IOException) {
                        disconnectIfCurrent(snapshot, DisconnectReason.Error(e))
                        break
                    }
                }
            } finally {
                releaseBufferBudget(size)
            }
        }
        synchronized(readStateLock) {
            if (!isCurrent(snapshot)) {
                job.cancel()
                releaseBufferBudget(size)
                return
            }
            if (readerJob?.isActive == true) {
                job.cancel()
                releaseBufferBudget(size)
                return
            }
            lastChunkSize = size
            try { snapshot.socket.soTimeout = if (readTimeout > 0) readTimeout else 1000 } catch (_: Exception) {}
            readerJob = job
            job.start()
        }
    }

    fun stopRead() {
        val job = synchronized(readStateLock) {
            val current = readerJob
            readerJob = null
            try { socket?.soTimeout = 20 } catch (_: Exception) {}
            current
        }
        job?.cancel()
    }

    fun isReading(): Boolean = synchronized(readStateLock) { readerJob?.isActive == true }

    fun setReadTimeout(ms: Int) {
        synchronized(readStateLock) {
            readTimeout = if (ms > 0) ms else 1000
            if (readerJob?.isActive == true && !rrInFlight.get()) {
                try { socket?.soTimeout = readTimeout } catch (_: Exception) {}
            }
        }
    }

    /**
     * Request/Response read with minimal allocations.
     *
     * The public JS default is suspendStreamDuringRR=true; the bridge passes that value explicitly.
     * The core default remains false for direct callers.
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
        val cap = if (maxBytes > 0) maxBytes.coerceAtMost(MAX_BUFFER_BYTES) else DEFAULT_CHUNK_SIZE
        if (!rrInFlight.compareAndSet(false, true)) {
            callback(Result.failure(TcpError.Busy)); return
        }

        scope.launch {
            val snapshot = currentSnapshot()
            if (snapshot == null || !isConnected(snapshot.socket)) {
                rrInFlight.set(false)
                callback(Result.failure(TcpError.NotConnected)); return@launch
            }
            var wasReading = false
            val previousTimeout: Int = try { snapshot.socket.soTimeout } catch (_: Exception) { 0 }
            val deadlineNs = System.nanoTime() + effTimeout * 1_000_000L
            var budgetAcquired = false
            try {
                val suspendedReader = synchronized(readStateLock) {
                    val activeReader = readerJob
                    if (suspendStreamDuringRR && activeReader?.isActive == true) {
                        wasReading = true
                        readerJob = null
                        try { snapshot.socket.soTimeout = 20 } catch (_: Exception) {}
                        activeReader
                    } else {
                        null
                    }
                }
                suspendedReader?.cancelAndJoin()

                // Write request (serialized under writeMutex)
                writeMutex.withLock {
                    try {
                        val remainMs = ((deadlineNs - System.nanoTime()).coerceAtLeast(0)) / 1_000_000L
                        if (remainMs <= 0) throw TcpError.WriteTimeout
                        writeAllWithTimeout(snapshot.socket, snapshot.output, bytes, remainMs)
                    } catch (e: TcpError.WriteTimeout) {
                        disconnectIfCurrent(snapshot, DisconnectReason.Error(e))
                        callback(Result.failure(e))
                        return@launch
                    } catch (e: IOException) {
                        disconnectIfCurrent(snapshot, DisconnectReason.Error(e))
                        callback(Result.failure(e))
                        return@launch
                    }
                }

                // Read with adaptive 'until-idle' (when no expect pattern is provided)
                val inp = snapshot.input
                if (!tryAcquireBufferBudget(cap)) {
                    callback(Result.failure(TcpError.InvalidParams)); return@launch
                }
                budgetAcquired = true
                val buf = ByteArray(cap)
                val tmp = ByteArray(minOf(4096, cap))
                var used = 0
                var matched = false

                var lastDataAtNs = 0L
                val interArr = mutableListOf<Long>() // keep last 5 samples

                fun idleThresholdMs(): Int {
                    if (interArr.isEmpty()) return MIN_RR_IDLE_MS
                    val sorted = interArr.sorted()
                    val med = if (sorted.size % 2 == 1)
                        sorted[sorted.size / 2].toDouble()
                    else
                        0.5 * (sorted[sorted.size / 2 - 1] + sorted[sorted.size / 2]).toDouble()
                    return (med * 1.75).toInt().coerceIn(MIN_RR_IDLE_MS, MAX_RR_IDLE_MS)
                }

                while (used < cap) {
                    val remainMs = ((deadlineNs - System.nanoTime()).coerceAtLeast(0)) / 1_000_000L
                    if (remainMs <= 0) {
                        // Parity with iOS: if any data arrived, resolve success (matched=false); otherwise, timeout
                        if (used > 0) {
                            callback(Result.success(ReadResult(buf.copyOf(used), false))); return@launch
                        } else {
                            callback(Result.failure(TcpError.ReadTimeout)); return@launch
                        }
                    }

                    val stepMs = if (expect == null && used > 0)
                        idleThresholdMs().toLong().coerceAtMost(remainMs)
                    else
                        minOf(200L, remainMs)
                    try { snapshot.socket.soTimeout = stepMs.toInt().coerceAtLeast(1) } catch (_: Exception) {}

                    val toRead = minOf(tmp.size, cap - used)
                    if (toRead <= 0) break

                    try {
                        val n = inp.read(tmp, 0, toRead)
                        if (n == -1) {
                            disconnectIfCurrent(snapshot, DisconnectReason.Remote)
                            if (used > 0) {
                                callback(Result.success(ReadResult(buf.copyOf(used), matched))); return@launch
                            }
                            throw TcpError.Closed
                        }
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
                if (e is TcpError.Closed) disconnectIfCurrent(snapshot, DisconnectReason.Remote)
                else disconnectIfCurrent(snapshot, DisconnectReason.Error(e))
                callback(Result.failure(e))
            } catch (e: Exception) {
                callback(Result.failure(e))
            } finally {
                if (budgetAcquired) releaseBufferBudget(cap)
                if (isCurrent(snapshot)) {
                    try { snapshot.socket.soTimeout = previousTimeout } catch (_: Exception) {}
                }
                rrInFlight.set(false)
                if (suspendStreamDuringRR && wasReading && isConnected()) {
                    startRead(lastChunkSize)
                }
            }
        }
    }

    private suspend fun writeAllWithTimeout(socketForWrite: Socket, out: BufferedOutputStream, bytes: ByteArray, timeoutMs: Long) {
        val settled = AtomicBoolean(false)
        val watchdog = scope.launch {
            delay(timeoutMs.coerceAtLeast(1))
            if (settled.compareAndSet(false, true)) {
                closeQuietly(socketForWrite)
            }
        }
        try {
            out.write(bytes)
            out.flush()
            if (!settled.compareAndSet(false, true)) throw TcpError.WriteTimeout
        } catch (e: IOException) {
            if (!settled.compareAndSet(false, true)) throw TcpError.WriteTimeout
            throw e
        } finally {
            watchdog.cancel()
        }
    }



    private fun disconnectInternal(reason: DisconnectReason) {
        val hadSomething = (socket != null) || (readerJob != null)
        synchronized(readStateLock) {
            try { readerJob?.cancel() } catch (_: Exception) {}
            readerJob = null
        }
        closeQuietly(connectingSocket)
        connectingSocket = null
        try { socket?.close() } catch (_: Exception) {}
        input = null
        output = null
        socket = null
        connectionGeneration++
        if (hadSomething) delegate?.onDisconnect(reason)
    }

    private fun closeQuietly(s: Socket?) {
        try { s?.close() } catch (_: Exception) {}
    }

    fun dispose(callback: (() -> Unit)? = null) {
        if (!disposed.compareAndSet(false, true)) {
            callback?.invoke()
            return
        }
        cleanupScope.launch {
            closeQuietly(connectingSocket)
            withContext(NonCancellable) {
                connectMutex.withLock {
                    disconnectInternal(DisconnectReason.Manual)
                }
            }
            delegate = null
            callback?.invoke()
            cleanupScope.cancel()
        }
    }

    private fun currentSnapshot(): ConnectionSnapshot? {
        val s = socket ?: return null
        val inp = input ?: return null
        val out = output ?: return null
        return ConnectionSnapshot(s, inp, out, connectionGeneration)
    }

    private fun isConnected(s: Socket): Boolean {
        return s.isConnected && !s.isClosed && s.inetAddress != null
    }

    private fun isCurrent(snapshot: ConnectionSnapshot): Boolean {
        return socket === snapshot.socket && connectionGeneration == snapshot.generation
    }

    private suspend fun disconnectIfCurrent(snapshot: ConnectionSnapshot, reason: DisconnectReason) {
        connectMutex.withLock {
            if (isCurrent(snapshot)) {
                disconnectInternal(reason)
            }
        }
    }

    private fun tryAcquireBufferBudget(bytes: Int): Boolean {
        while (true) {
            val current = aggregateBufferBytes.get()
            val next = current + bytes
            if (next > MAX_AGGREGATE_BUFFER_BYTES) return false
            if (aggregateBufferBytes.compareAndSet(current, next)) return true
        }
    }

    private fun releaseBufferBudget(bytes: Int) {
        aggregateBufferBytes.addAndGet(-bytes)
    }
}
