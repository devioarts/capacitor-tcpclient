package com.devioarts.capacitor.tcpclient

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TCPClientLifecycleTest {

    @Test
    fun disposeInvokesCallbackWithoutActiveConnection() {
        val client = TCPClient()
        val disposed = CountDownLatch(1)

        client.dispose {
            disposed.countDown()
        }

        assertTrue(disposed.await(2, TimeUnit.SECONDS))
        assertFalse(client.isConnected())
        assertFalse(client.isReading())
    }

    @Test
    fun connectAfterDisposeFailsInsteadOfLaunchingWork() {
        val client = TCPClient()
        val disposed = CountDownLatch(1)
        val connected = CountDownLatch(1)
        var failed = false

        client.dispose {
            disposed.countDown()
        }
        assertTrue(disposed.await(2, TimeUnit.SECONDS))

        client.connect("127.0.0.1", 1, 50, true, true) { result ->
            failed = result.isFailure
            connected.countDown()
        }

        assertTrue(connected.await(2, TimeUnit.SECONDS))
        assertTrue(failed)
    }
}
