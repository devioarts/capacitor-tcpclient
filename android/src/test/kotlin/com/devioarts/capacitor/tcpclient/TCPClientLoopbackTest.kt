package com.devioarts.capacitor.tcpclient

import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TCPClientLoopbackTest {

    @Test
    fun writeAndReadMatchesFragmentedResponse() {
        loopback { socket ->
            val request = socket.getInputStream().readBytes(4)
            assertArrayEquals(byteArrayOf(0x70, 0x69, 0x6e, 0x67), request)
            val out = socket.getOutputStream()
            out.write(byteArrayOf(0x10, 0x20))
            out.flush()
            Thread.sleep(25)
            out.write(byteArrayOf(0x30, 0x40))
            out.flush()
        }.use { server ->
            val client = TCPClient()
            assertTrue(client.awaitConnect(server.port).isSuccess)

            val result = client.awaitWriteAndRead(
                bytes = byteArrayOf(0x70, 0x69, 0x6e, 0x67),
                timeout = 1000,
                maxBytes = 16,
                expect = pattern(byteArrayOf(0x30, 0x40))
            )

            assertTrue(result.isSuccess)
            val rr = result.getOrThrow()
            assertArrayEquals(byteArrayOf(0x10, 0x20, 0x30, 0x40), rr.data)
            assertTrue(rr.matched)
            client.awaitDisconnect()
        }
    }

    @Test
    fun writeAndReadWithoutExpectReturnsAfterIdleWithFragmentedResponse() {
        loopback { socket ->
            socket.getInputStream().readBytes(3)
            val out = socket.getOutputStream()
            out.write(byteArrayOf(1, 2, 3))
            out.flush()
            Thread.sleep(30)
            out.write(byteArrayOf(4, 5))
            out.flush()
        }.use { server ->
            val client = TCPClient()
            assertTrue(client.awaitConnect(server.port).isSuccess)

            val result = client.awaitWriteAndRead(byteArrayOf(9, 8, 7), timeout = 1000, maxBytes = 16)

            assertTrue(result.isSuccess)
            val rr = result.getOrThrow()
            assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5), rr.data)
            assertFalse(rr.matched)
            client.awaitDisconnect()
        }
    }

    @Test
    fun startReadEmitsRealStreamChunks() {
        loopback { socket ->
            val out = socket.getOutputStream()
            out.write(byteArrayOf(1, 2, 3, 4, 5, 6))
            out.flush()
            Thread.sleep(50)
        }.use { server ->
            val client = TCPClient()
            val delegate = RecordingDelegate(expectedBytes = 6)
            client.delegate = delegate

            assertTrue(client.awaitConnect(server.port).isSuccess)
            client.startRead(chunkSize = 2)

            assertTrue(delegate.dataArrived.await(2, TimeUnit.SECONDS))
            assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6), delegate.bytes())
            assertTrue(client.isReading())

            client.stopRead()
            Thread.sleep(50)
            assertFalse(client.isReading())
            client.awaitDisconnect()
        }
    }

    @Test
    fun writeAndReadTimesOutWhenServerStaysSilent() {
        loopback { socket ->
            socket.getInputStream().readBytes(3)
            Thread.sleep(300)
        }.use { server ->
            val client = TCPClient()
            assertTrue(client.awaitConnect(server.port).isSuccess)

            val result = client.awaitWriteAndRead(
                bytes = byteArrayOf(1, 2, 3),
                timeout = 120,
                maxBytes = 16,
                expect = pattern(byteArrayOf(9))
            )

            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is TCPClient.TcpError.ReadTimeout)
            client.awaitDisconnect()
        }
    }

    @Test
    fun writeAndReadStopsAtMaxBytes() {
        loopback { socket ->
            socket.getInputStream().readBytes(1)
            socket.getOutputStream().write(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8))
            socket.getOutputStream().flush()
        }.use { server ->
            val client = TCPClient()
            assertTrue(client.awaitConnect(server.port).isSuccess)

            val result = client.awaitWriteAndRead(byteArrayOf(1), timeout = 1000, maxBytes = 4)

            assertTrue(result.isSuccess)
            val rr = result.getOrThrow()
            assertArrayEquals(byteArrayOf(1, 2, 3, 4), rr.data)
            assertFalse(rr.matched)
            client.awaitDisconnect()
        }
    }

    @Test
    fun remoteCloseDuringStreamEmitsDisconnect() {
        loopback { socket ->
            Thread.sleep(50)
            socket.close()
        }.use { server ->
            val client = TCPClient()
            val delegate = RecordingDelegate(expectedBytes = 1)
            client.delegate = delegate

            assertTrue(client.awaitConnect(server.port).isSuccess)
            client.startRead(chunkSize = 4)

            assertTrue(delegate.disconnected.await(2, TimeUnit.SECONDS))
            assertEquals(TCPClient.DisconnectReason.Remote::class, delegate.disconnectReason!!::class)
            assertFalse(client.isConnected())
        }
    }

    @Test
    fun idleRemoteCloseIsDetectedByIsConnected() {
        loopback {
            Thread.sleep(50)
        }.use { server ->
            val client = TCPClient()
            val delegate = RecordingDelegate(expectedBytes = 1)
            client.delegate = delegate

            assertTrue(client.awaitConnect(server.port).isSuccess)
            Thread.sleep(150)

            assertFalse(client.isConnected())
            assertTrue(delegate.disconnected.await(2, TimeUnit.SECONDS))
            assertEquals(TCPClient.DisconnectReason.Remote::class, delegate.disconnectReason!!::class)
        }
    }

    @Test
    fun concurrentWriteIsBusyWhileRequestResponseIsInFlight() {
        loopback { socket ->
            socket.getInputStream().readBytes(1)
            Thread.sleep(200)
            socket.getOutputStream().write(byteArrayOf(0x55))
            socket.getOutputStream().flush()
        }.use { server ->
            val client = TCPClient()
            assertTrue(client.awaitConnect(server.port).isSuccess)

            val rrLatch = CountDownLatch(1)
            client.writeAndRead(byteArrayOf(0x01), timeout = 1000, maxBytes = 8, expect = pattern(byteArrayOf(0x55))) {
                rrLatch.countDown()
            }

            val writeResult = client.awaitWrite(byteArrayOf(0x02))

            assertTrue(writeResult.isFailure)
            assertTrue(writeResult.exceptionOrNull() is TCPClient.TcpError.Busy)
            assertTrue(rrLatch.await(2, TimeUnit.SECONDS))
            client.awaitDisconnect()
        }
    }

    private fun pattern(needle: ByteArray): (ByteArray, Int) -> Boolean = { buffer, used ->
        Helpers.indexOfRange(buffer, used, needle) >= 0
    }

    private fun loopback(handler: (Socket) -> Unit): LoopbackServer = LoopbackServer(handler)

    private class LoopbackServer(private val handler: (Socket) -> Unit) : AutoCloseable {
        private val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        @Volatile private var failure: Throwable? = null
        val port: Int = server.localPort

        private val acceptThread = thread(start = true, name = "tcpclient-loopback-server") {
            try {
                server.accept().use(handler)
            } catch (e: Throwable) {
                if (!server.isClosed) failure = e
            }
        }

        override fun close() {
            server.close()
            acceptThread.join(1_000)
            failure?.let { throw AssertionError("loopback server failed", it) }
        }
    }

    private class RecordingDelegate(private val expectedBytes: Int) : TCPClientDelegate {
        private val data = ByteArrayOutputStream()
        val dataArrived = CountDownLatch(1)
        val disconnected = CountDownLatch(1)
        @Volatile var disconnectReason: TCPClient.DisconnectReason? = null

        override fun onReceive(data: ByteArray) {
            synchronized(this.data) {
                this.data.write(data)
                if (this.data.size() >= expectedBytes) dataArrived.countDown()
            }
        }

        override fun onDisconnect(reason: TCPClient.DisconnectReason) {
            disconnectReason = reason
            disconnected.countDown()
        }

        fun bytes(): ByteArray = synchronized(data) { data.toByteArray() }
    }

    private fun TCPClient.awaitConnect(port: Int): Result<Unit> {
        val latch = CountDownLatch(1)
        var result: Result<Unit>? = null
        connect("127.0.0.1", port, 1000, true, true) {
            result = it
            latch.countDown()
        }
        assertTrue(latch.await(2, TimeUnit.SECONDS))
        return result ?: Result.failure(AssertionError("missing connect result"))
    }

    private fun TCPClient.awaitDisconnect() {
        val latch = CountDownLatch(1)
        disconnect { latch.countDown() }
        assertTrue(latch.await(2, TimeUnit.SECONDS))
    }

    private fun TCPClient.awaitWrite(bytes: ByteArray): Result<Int> {
        val latch = CountDownLatch(1)
        var result: Result<Int>? = null
        write(bytes) {
            result = it
            latch.countDown()
        }
        assertTrue(latch.await(2, TimeUnit.SECONDS))
        return result ?: Result.failure(AssertionError("missing write result"))
    }

    private fun TCPClient.awaitWriteAndRead(
        bytes: ByteArray,
        timeout: Int,
        maxBytes: Int,
        expect: ((ByteArray, Int) -> Boolean)? = null
    ): Result<TCPClient.ReadResult> {
        val latch = CountDownLatch(1)
        var result: Result<TCPClient.ReadResult>? = null
        writeAndRead(bytes, timeout, maxBytes, expect, suspendStreamDuringRR = true) {
            result = it
            latch.countDown()
        }
        assertTrue(latch.await(2, TimeUnit.SECONDS))
        return result ?: Result.failure(AssertionError("missing writeAndRead result"))
    }

    private fun java.io.InputStream.readBytes(count: Int): ByteArray {
        val out = ByteArray(count)
        var offset = 0
        while (offset < count) {
            val read = read(out, offset, count - offset)
            if (read == -1) throw AssertionError("socket closed before $count bytes were read")
            offset += read
        }
        return out
    }
}
