import XCTest
import Darwin
@testable import TCPClientPlugin

class TCPClientTests: XCTestCase {
    func testCreateDoesNotCrash() {
        let client = TCPClient()
        XCTAssertFalse(client.isConnected())
        XCTAssertFalse(client.isReading())
    }

    func testDisconnectIsIdempotentWhenNotConnected() {
        let client = TCPClient()
        client.disconnect()
        client.disconnect()

        XCTAssertFalse(client.isConnected())
        XCTAssertFalse(client.isReading())
    }

    func testStartStopReadWithoutSocketDoesNotEnterReadingState() {
        let client = TCPClient()
        client.startRead(chunkSize: 1024)
        client.stopRead()

        XCTAssertFalse(client.isConnected())
        XCTAssertFalse(client.isReading())
    }

    func testWriteAndReadMatchesFragmentedLoopbackResponse() throws {
        let server = try LoopbackServer { socketFd in
            XCTAssertEqual(Self.readExactly(socketFd, count: 4), Data([0x70, 0x69, 0x6e, 0x67]))
            Self.writeAll(socketFd, Data([0x10, 0x20]))
            usleep(25_000)
            Self.writeAll(socketFd, Data([0x30, 0x40]))
        }
        defer { server.close() }

        let client = TCPClient()
        try connect(client, port: server.port)

        let result = waitForWriteAndRead(client,
                                         data: Data([0x70, 0x69, 0x6e, 0x67]),
                                         timeout: 1000,
                                         maxBytes: 16,
                                         expect: { $0.range(of: Data([0x30, 0x40])) != nil })

        let readResult = try XCTUnwrap(result.get())
        XCTAssertEqual(readResult.data, Data([0x10, 0x20, 0x30, 0x40]))
        XCTAssertTrue(readResult.matched)
        disconnect(client)
    }

    func testWriteAndReadReturnsDataWhenPeerClosesAfterResponse() throws {
        let server = try LoopbackServer { socketFd in
            XCTAssertEqual(Self.readExactly(socketFd, count: 3), Data([9, 8, 7]))
            Self.writeAll(socketFd, Data([1, 2, 3]))
            usleep(30_000)
            Self.writeAll(socketFd, Data([4, 5]))
        }
        defer { server.close() }

        let client = TCPClient()
        try connect(client, port: server.port)

        let result = waitForWriteAndRead(client,
                                         data: Data([9, 8, 7]),
                                         timeout: 1000,
                                         maxBytes: 16,
                                         expect: nil)

        let readResult = try XCTUnwrap(result.get())
        XCTAssertEqual(readResult.data, Data([1, 2, 3, 4, 5]))
        XCTAssertFalse(readResult.matched)
        disconnect(client)
    }

    func testWriteAndReadTimesOutWhenServerStaysSilent() throws {
        let server = try LoopbackServer { socketFd in
            _ = Self.readExactly(socketFd, count: 3)
            usleep(300_000)
        }
        defer { server.close() }

        let client = TCPClient()
        try connect(client, port: server.port)

        let result = waitForWriteAndRead(client,
                                         data: Data([1, 2, 3]),
                                         timeout: 120,
                                         maxBytes: 16,
                                         expect: { $0.range(of: Data([9])) != nil })

        XCTAssertThrowsError(try result.get()) { error in
            XCTAssertEqual(error.localizedDescription, TCPClient.TcpError.readTimeout.localizedDescription)
        }
        disconnect(client)
    }

    func testWriteAndReadStopsAtMaxBytes() throws {
        let server = try LoopbackServer { socketFd in
            XCTAssertEqual(Self.readExactly(socketFd, count: 1), Data([1]))
            Self.writeAll(socketFd, Data([1, 2, 3, 4, 5, 6, 7, 8]))
        }
        defer { server.close() }

        let client = TCPClient()
        try connect(client, port: server.port)

        let result = waitForWriteAndRead(client,
                                         data: Data([1]),
                                         timeout: 1000,
                                         maxBytes: 4,
                                         expect: nil)

        let readResult = try XCTUnwrap(result.get())
        XCTAssertEqual(readResult.data, Data([1, 2, 3, 4]))
        XCTAssertFalse(readResult.matched)
        disconnect(client)
    }

    func testStartReadEmitsLoopbackStreamAndRemoteClose() throws {
        let server = try LoopbackServer { socketFd in
            Self.writeAll(socketFd, Data([1, 2, 3, 4, 5, 6]))
            usleep(50_000)
        }
        defer { server.close() }

        let client = TCPClient()
        let dataExpectation = expectation(description: "stream data")
        let disconnectExpectation = expectation(description: "remote disconnect")
        let delegate = RecordingDelegate(expectedBytes: 6,
                                         dataExpectation: dataExpectation,
                                         disconnectExpectation: disconnectExpectation)
        client.delegate = delegate

        try connect(client, port: server.port)
        client.startRead(chunkSize: 2)

        wait(for: [dataExpectation, disconnectExpectation], timeout: 2)
        XCTAssertEqual(delegate.bytes(), Data([1, 2, 3, 4, 5, 6]))
        XCTAssertFalse(client.isConnected())
    }

    func testConcurrentWriteIsBusyWhileRequestResponseIsInFlight() throws {
        let server = try LoopbackServer { socketFd in
            XCTAssertEqual(Self.readExactly(socketFd, count: 1), Data([0x01]))
            usleep(200_000)
            Self.writeAll(socketFd, Data([0x55]))
        }
        defer { server.close() }

        let client = TCPClient()
        try connect(client, port: server.port)

        let rrExpectation = expectation(description: "rr completes")
        client.writeAndRead([0x01],
                            timeout: 1000,
                            maxBytes: 8,
                            expect: { $0.range(of: Data([0x55])) != nil },
                            completion: { _ in
            rrExpectation.fulfill()
        })

        let writeExpectation = expectation(description: "busy write")
        var writeResult: Result<Int, Error>?
        client.write([0x02]) { result in
            writeResult = result
            writeExpectation.fulfill()
        }

        wait(for: [writeExpectation, rrExpectation], timeout: 2)
        XCTAssertThrowsError(try writeResult?.get()) { error in
            XCTAssertEqual(error.localizedDescription, TCPClient.TcpError.busy.localizedDescription)
        }
        disconnect(client)
    }

    private func connect(_ client: TCPClient, port: UInt16) throws {
        let connectExpectation = expectation(description: "connect")
        var connectResult: Result<Void, Error>?
        client.connect(host: "127.0.0.1", port: port, timeout: 1000) { result in
            connectResult = result
            connectExpectation.fulfill()
        }
        wait(for: [connectExpectation], timeout: 2)
        try connectResult?.get()
    }

    private func disconnect(_ client: TCPClient) {
        client.disconnect()
        usleep(50_000)
    }

    private func waitForWriteAndRead(_ client: TCPClient,
                                     data: Data,
                                     timeout: Int,
                                     maxBytes: Int,
                                     expect: ((Data) -> Bool)?) -> Result<TCPClient.ReadResult, Error> {
        let rrExpectation = expectation(description: "writeAndRead")
        var rrResult: Result<TCPClient.ReadResult, Error>?
        client.writeAndRead([UInt8](data),
                            timeout: timeout,
                            maxBytes: maxBytes,
                            expect: expect,
                            suspendStreamDuringRR: true) { result in
            rrResult = result
            rrExpectation.fulfill()
        }
        wait(for: [rrExpectation], timeout: 2)
        return rrResult ?? .failure(NSError(domain: "TCPClientTests", code: 1))
    }

    private static func readExactly(_ socketFd: Int32, count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        var offset = 0
        while offset < count {
            let readCount = bytes.withUnsafeMutableBytes { raw -> Int in
                guard let base = raw.baseAddress else { return -1 }
                return Darwin.recv(socketFd, base.advanced(by: offset), count - offset, 0)
            }
            if readCount <= 0 { return Data(bytes[0..<offset]) }
            offset += readCount
        }
        return Data(bytes)
    }

    private static func writeAll(_ socketFd: Int32, _ data: Data) {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var sent = 0
            while sent < raw.count {
                let written = Darwin.send(socketFd, base.advanced(by: sent), raw.count - sent, 0)
                if written <= 0 { return }
                sent += written
            }
        }
    }
}

private final class RecordingDelegate: TcpClientDelegate {
    private let expectedBytes: Int
    private let dataExpectation: XCTestExpectation
    private let disconnectExpectation: XCTestExpectation
    private let lock = NSLock()
    private var data = Data()

    init(expectedBytes: Int, dataExpectation: XCTestExpectation, disconnectExpectation: XCTestExpectation) {
        self.expectedBytes = expectedBytes
        self.dataExpectation = dataExpectation
        self.disconnectExpectation = disconnectExpectation
    }

    func tcpClient(_ client: TCPClient, didReceive data: Data) {
        lock.lock()
        self.data.append(data)
        let shouldFulfill = self.data.count >= expectedBytes
        lock.unlock()
        if shouldFulfill { dataExpectation.fulfill() }
    }

    func tcpClientDidDisconnect(_ client: TCPClient, reason: TCPClient.DisconnectReason) {
        disconnectExpectation.fulfill()
    }

    func bytes() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

private final class LoopbackServer {
    let port: UInt16
    private let serverFd: Int32
    private let queue = DispatchQueue(label: "tcpclient.loopback.server")
    private var closed = false

    init(handler: @escaping (Int32) -> Void) throws {
        let socketFd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        if socketFd < 0 { throw POSIXError(.EIO) }

        var yes: Int32 = 1
        _ = setsockopt(socketFd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout.size(ofValue: yes)))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(socketFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bindResult != 0 {
            Darwin.close(socketFd)
            throw POSIXError(.EADDRINUSE)
        }
        if Darwin.listen(socketFd, 1) != 0 {
            Darwin.close(socketFd)
            throw POSIXError(.EIO)
        }

        var bound = sockaddr_in()
        var boundLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &bound) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(socketFd, $0, &boundLen)
            }
        }
        if nameResult != 0 {
            Darwin.close(socketFd)
            throw POSIXError(.EIO)
        }
        serverFd = socketFd
        port = UInt16(bigEndian: bound.sin_port)

        queue.async { [socketFd] in
            let clientFd = Darwin.accept(socketFd, nil, nil)
            if clientFd >= 0 {
                handler(clientFd)
                Darwin.close(clientFd)
            }
        }
    }

    func close() {
        if closed { return }
        closed = true
        Darwin.shutdown(serverFd, SHUT_RDWR)
        Darwin.close(serverFd)
    }

    deinit {
        close()
    }
}
