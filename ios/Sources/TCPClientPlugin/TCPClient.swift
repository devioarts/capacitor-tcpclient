// swiftlint:disable cyclomatic_complexity function_body_length identifier_name type_body_length file_length force_unwrapping
import Foundation
import Darwin

protocol TcpClientDelegate: AnyObject {
    func tcpClient(_ client: TCPClient, didReceive data: Data)
    func tcpClientDidDisconnect(_ client: TCPClient, reason: TCPClient.DisconnectReason)
}

/// POSIX-based TCP client for iOS/macOS.
/// - Non-blocking socket, connect timeout via poll+SO_ERROR
/// - Streaming via DispatchSourceRead
/// - Request/Response with timeout, optional pattern match,
///   automatic "until idle" (adaptive), and optional stream suspension
final class TCPClient {
    private static let defaultChunkSize = 4096
    private static let maxBufferBytes = 16 * 1024 * 1024
    private static let queueKey = DispatchSpecificKey<Void>()

    enum TcpError: LocalizedError {
        case notConnected
        case connectTimeout
        case writeTimeout(bytesSent: Int)
        case readTimeout
        case closed
        case invalidPort
        case readStopped
        case busy

        var errorDescription: String? {
            switch self {
            case .notConnected: return "not connected"
            case .connectTimeout: return "connect timeout"
            case .writeTimeout: return "write timeout"
            case .readTimeout: return "read timeout"
            case .closed: return "closed"
            case .invalidPort: return "invalid port"
            case .readStopped: return "read stopped"
            case .busy: return "busy"
            }
        }
    }

    enum DisconnectReason {
        case manual
        case error(Error)
        case remote
    }

    struct ReadResult {
        let data: Data
        let matched: Bool
    }

    private var fd: Int32 = -1
    private var readSource: DispatchSourceRead?
    private let queue = DispatchQueue(label: "devioarts.tcpclient", qos: .userInitiated)
    private let signalLock = NSLock()
    private let operationLock = NSLock()

    private var reading = false
    private var rrInFlight = false
    private var operationInFlight = false
    private var manualDisconnectRequested = false
    private var lastChunkSize: Int = TCPClient.defaultChunkSize

    weak var delegate: TcpClientDelegate?

    init() {
        queue.setSpecific(key: Self.queueKey, value: ())
    }

    deinit {
        runOnQueueSync {
            disconnectInternal(reason: .manual)
        }
    }

    // MARK: - Connect/Disconnect

    func connect(host: String,
                 port: UInt16 = 9100,
                 timeout: Int = 3000,
                 noDelay: Bool = true,
                 keepAlive: Bool = true,
                 completion: @escaping (Result<Void, Error>) -> Void) {
        let timeoutMs = max(1, timeout)
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        resolveAddresses(host: host, timeoutMs: timeoutMs) { result in
            self.queue.async {
                switch result {
                case .failure(let error):
                    completion(.failure(error))
                case .success(let res):
                    self.connectResolvedAddresses(res,
                                                  port: port,
                                                  noDelay: noDelay,
                                                  keepAlive: keepAlive,
                                                  deadline: deadline,
                                                  completion: completion)
                }
            }
        }
    }

    // swiftlint:disable:next function_parameter_count
    private func connectResolvedAddresses(_ res: UnsafeMutablePointer<addrinfo>,
                                          port: UInt16,
                                          noDelay: Bool,
                                          keepAlive: Bool,
                                          deadline: Date,
                                          completion: @escaping (Result<Void, Error>) -> Void) {
        defer { freeaddrinfo(res) }
        self.disconnectInternal(reason: .manual)

        var lastErr: Int32 = 0
        var connected = false

        var ai: UnsafeMutablePointer<addrinfo>? = res
        while ai != nil, !connected {
            guard let aiP = ai?.pointee else { break }
            if deadline.timeIntervalSinceNow <= 0 {
                lastErr = ETIMEDOUT
                break
            }
            let s = socket(aiP.ai_family, aiP.ai_socktype, aiP.ai_protocol)
            if s < 0 { lastErr = errno; ai = aiP.ai_next; continue }

            var yes: Int32 = 1
            if noDelay { _ = setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &yes, socklen_t(MemoryLayout.size(ofValue: yes))) }
            if keepAlive { _ = setsockopt(s, SOL_SOCKET, SO_KEEPALIVE, &yes, socklen_t(MemoryLayout.size(ofValue: yes))) }
            _ = setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout.size(ofValue: yes)))

            let flags = fcntl(s, F_GETFL, 0)
            _ = fcntl(s, F_SETFL, flags | O_NONBLOCK)

            var sa = sockaddr_storage()
            if let src = aiP.ai_addr { memcpy(&sa, src, Int(aiP.ai_addrlen)) }
            var saLen: socklen_t = 0

            switch Int32(sa.ss_family) {
            case AF_INET:
                var sin = withUnsafePointer(to: &sa) { $0.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee } }
                sin.sin_port = CFSwapInt16HostToBig(port)
                _ = withUnsafePointer(to: &sin) { p in
                    p.withMemoryRebound(to: sockaddr.self, capacity: 1) { memcpy(&sa, $0, MemoryLayout<sockaddr_in>.size) }
                }
                saLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            case AF_INET6:
                var sin6 = withUnsafePointer(to: &sa) { $0.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee } }
                sin6.sin6_port = CFSwapInt16HostToBig(port)
                _ = withUnsafePointer(to: &sin6) { p in
                    p.withMemoryRebound(to: sockaddr.self, capacity: 1) { memcpy(&sa, $0, MemoryLayout<sockaddr_in6>.size) }
                }
                saLen = socklen_t(MemoryLayout<sockaddr_in6>.size)
            default:
                saLen = socklen_t(aiP.ai_addrlen)
            }

            let rc: Int32 = withUnsafePointer(to: &sa) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, saLen) }
            }

            var ok = false
            if rc == 0 {
                ok = true
            } else if errno == EINPROGRESS {
                var pfd = pollfd(fd: s, events: Int16(POLLOUT), revents: 0)
                while true {
                    let now = Date()
                    let remain = deadline.timeIntervalSince(now)
                    if remain <= 0 { lastErr = ETIMEDOUT; break }
                    let step = min(remain, 0.200) // 200 ms steps
                    let prc = withUnsafeMutablePointer(to: &pfd) { poll($0, 1, Int32(step * 1000.0)) }
                    if prc > 0 {
                        var soErr: Int32 = 0
                        var slen = socklen_t(MemoryLayout.size(ofValue: soErr))
                        if getsockopt(s, SOL_SOCKET, SO_ERROR, &soErr, &slen) == 0, soErr == 0 {
                            ok = true
                        } else {
                            lastErr = (soErr != 0) ? soErr : errno
                        }
                        break
                    } else if prc == 0 {
                        continue
                    } else {
                        if errno == EINTR { continue }
                        lastErr = errno
                        break
                    }
                }
            } else {
                lastErr = errno
            }

            if ok {
                self.fd = s
                connected = true
            } else {
                close(s)
                ai = aiP.ai_next
            }
        }

        if connected {
            completion(.success(()))
        } else {
            if lastErr == ETIMEDOUT {
                completion(.failure(TcpError.connectTimeout))
            } else if lastErr != 0 {
                completion(.failure(posixError(lastErr)))
            } else {
                completion(.failure(TcpError.connectTimeout))
            }
        }
    }

    func disconnect() {
        requestManualDisconnect()
        // Wake an in-flight poll/recv in writeAndRead. Teardown still runs on the
        // serial queue, but shutdown makes the blocking syscall return promptly.
        let wakeFd = runOnQueueSync { fd }
        if wakeFd >= 0 { _ = shutdown(wakeFd, SHUT_RDWR) }
        queue.async { self.disconnectInternal(reason: .manual) }
    }

    private func disconnectInternal(reason: DisconnectReason) {
        let finalReason: DisconnectReason = consumeManualDisconnectRequest() ? .manual : reason
        let had = (fd >= 0) || reading
        let closeFd = fd
        fd = -1
        rrInFlight = false
        reading = false

        if let src = readSource {
            src.setCancelHandler {
                if closeFd >= 0 { close(closeFd) }
            }
            src.cancel()
            readSource = nil
        } else if closeFd >= 0 {
            close(closeFd)
        }
        if had { delegate?.tcpClientDidDisconnect(self, reason: finalReason) }
    }

    private func requestManualDisconnect() {
        signalLock.lock()
        manualDisconnectRequested = true
        signalLock.unlock()
    }

    private func consumeManualDisconnectRequest() -> Bool {
        signalLock.lock()
        let requested = manualDisconnectRequested
        manualDisconnectRequested = false
        signalLock.unlock()
        return requested
    }

    /// Robust connectivity check without a running reader:
    /// uses non-blocking MSG_PEEK to detect EOF immediately.
    func isConnected() -> Bool {
        return runOnQueueSync {
            guard fd >= 0 else { return false }

            if reading || rrInFlight { return true }

            var p = pollfd(fd: fd, events: Int16(POLLIN | POLLERR | POLLHUP | POLLNVAL), revents: 0)
            let rc = withUnsafeMutablePointer(to: &p) { poll($0, 1, 0) }
            if rc < 0 {
                let e = errno
                if e == EINTR {
                    return true
                }
                self.disconnectInternal(reason: .error(self.posixError(e)))
                return false
            }
            if (p.revents & Int16(POLLERR | POLLHUP | POLLNVAL)) != 0 {
                self.disconnectInternal(reason: .remote)
                return false
            }

            var c: UInt8 = 0
            let n: Int = withUnsafeMutableBytes(of: &c) { rawPtr in
                guard let base = rawPtr.baseAddress else { return -1 }
                return Darwin.recv(self.fd, base, 1, MSG_PEEK)
            }

            if n == 0 {
                self.disconnectInternal(reason: .remote)
                return false
            } else if n > 0 {
                return true
            } else {
                let e = errno
                let ok = (e == EAGAIN || e == EWOULDBLOCK || e == EINTR)
                if !ok {
                    self.disconnectInternal(reason: .error(self.posixError(e)))
                }
                return ok
            }
        }
    }

    // MARK: - Low-level send helper (automatic POLLOUT backoff)

    /// Send all bytes with non-blocking socket handling.
    /// On EAGAIN/EWOULDBLOCK waits for POLLOUT in 10ms steps until budget expires.
    private func sendAll(_ bytes: [UInt8], budgetMs: Int) throws -> Int {
        var sent = 0
        let total = bytes.count
        let deadline = Date().addingTimeInterval(Double(max(1, budgetMs)) / 1000.0)

        while sent < total {
            let n = bytes.withUnsafeBytes { p -> Int in
                let base = p.baseAddress!.advanced(by: sent)
                return Darwin.send(self.fd, base, total - sent, 0)
            }
            if n >= 0 {
                sent += n
                continue
            }
            let e = errno
            if e == EINTR { continue }
            if e == EPIPE {
                self.disconnectInternal(reason: .remote)
                throw TcpError.closed
            } else if e == EAGAIN || e == EWOULDBLOCK {
                // wait for POLLOUT
                while true {
                    let now = Date()
                    let remain = deadline.timeIntervalSince(now)
                    if remain <= 0 { throw TcpError.writeTimeout(bytesSent: sent) }
                    let stepSec = min(remain, 0.010) // 10ms
                    var pfd = pollfd(fd: self.fd, events: Int16(POLLOUT), revents: 0)
                    let prc = withUnsafeMutablePointer(to: &pfd) { poll($0, 1, Int32(stepSec * 1000.0)) }
                    if prc > 0 { break }
                    if prc < 0 {
                        let perr = errno
                        if perr == EINTR { continue }
                        throw posixError(perr)
                    }
                    // prc == 0 => timed step; loop until deadline
                }
            } else {
                throw posixError(e)
            }
        }
        return sent
    }

    // MARK: - Write

    func write(_ bytes: [UInt8], completion: @escaping (Result<Int, Error>) -> Void) {
        guard beginOperation() else { completion(.failure(TcpError.busy)); return }
        queue.async {
            defer { self.endOperation() }
            guard self.fd >= 0 else { completion(.failure(TcpError.notConnected)); return }
            if self.rrInFlight { completion(.failure(TcpError.busy)); return }
            do {
                // 3 s budget: only exhausted if the OS send buffer is full AND the remote
                // stops reading. For typical POS/IoT payloads (≤ a few KB) send() returns
                // immediately and this timeout is never reached. The connection is NOT
                // closed on timeout — only an error is returned to the caller.
                let n = try self.sendAll(bytes, budgetMs: 3000)
                completion(.success(n))
            } catch {
                completion(.failure(error))
            }
        }
    }

    // MARK: - Stream

    func startRead(chunkSize: Int = 4096) {
        queue.async {
            self.startReadInternal(chunkSize: chunkSize)
        }
    }

    func stopRead() {
        queue.async {
            self.reading = false
            self.readSource?.cancel()
            self.readSource = nil
        }
    }

    func isReading() -> Bool { runOnQueueSync { reading } }

    // MARK: - Write & wait for pattern (RR) with adaptive "until idle"

    /// Automatic "until idle" when `expect == nil`.
    /// - Starts with base idle 50ms.
    /// - Tracks inter-arrival times and sets idle = clamp(median * 1.75, 50ms…200ms).
    func writeAndRead(_ bytes: [UInt8],
                      timeout: Int = 1000,
                      maxBytes: Int = 4096,
                      expect: ((Data) -> Bool)? = nil,
                      suspendStreamDuringRR: Bool = true,
                      completion: @escaping (Result<ReadResult, Error>) -> Void) {
        guard beginOperation() else { completion(.failure(TcpError.busy)); return }
        queue.async {
            guard self.fd >= 0 else { self.endOperation(); completion(.failure(TcpError.notConnected)); return }
            guard !self.rrInFlight else { self.endOperation(); completion(.failure(TcpError.busy)); return }
            self.rrInFlight = true

            let wasReading = self.reading
            if suspendStreamDuringRR && wasReading {
                // Cancel inline: stopRead() dispatches queue.async and would run AFTER
                // writeAndRead on this same serial queue — stream would not be suspended.
                self.reading = false
                self.readSource?.cancel()
                self.readSource = nil
            }
            func restoreReaderIfNeeded() {
                if suspendStreamDuringRR && wasReading && self.fd >= 0 {
                    self.startReadInternal(chunkSize: self.lastChunkSize)
                }
            }
            func finish(_ r: Result<ReadResult, Error>) {
                restoreReaderIfNeeded()
                self.rrInFlight = false
                self.endOperation()
                completion(r)
            }

            // Send phase (budget = timeout)
            do {
                _ = try self.sendAll(bytes, budgetMs: max(1, timeout))
            } catch {
                if case TcpError.closed = error {
                    self.disconnectInternal(reason: .remote)
                }
                finish(.failure(error))
                return
            }

            // Receive phase with global timeout budget
            let cap = min(max(1, maxBytes), Self.maxBufferBytes)
            var out = Data(capacity: cap)
            var pfd = pollfd(fd: self.fd, events: Int16(POLLIN), revents: 0)
            let receiveDeadline = Date().addingTimeInterval(Double(max(1, timeout)) / 1000.0)
            var matched = false

            // adaptive idle
            var lastDataTime = Date.distantPast
            var interArrivals: [Double] = [] // ms, keep last 5

            func currentIdleThresholdMs() -> Int {
                guard !interArrivals.isEmpty else { return 50 }
                let sorted = interArrivals.sorted()
                let med = (sorted.count % 2 == 1)
                    ? sorted[sorted.count/2]
                    : 0.5 * (sorted[sorted.count/2 - 1] + sorted[sorted.count/2])
                let thr = Int(med * 1.75)
                return max(50, min(200, thr))
            }

            while out.count < cap {
                let remainingMs = Int(receiveDeadline.timeIntervalSinceNow * 1000.0)
                if remainingMs <= 0 { break }
                let step: Int
                if expect == nil && out.count > 0 {
                    let idleMs = Int(Date().timeIntervalSince(lastDataTime) * 1000.0)
                    step = min(remainingMs, max(1, currentIdleThresholdMs() - idleMs))
                } else {
                    step = min(remainingMs, 50) // fine-grained to evaluate idle
                }
                let rc = withUnsafeMutablePointer(to: &pfd) { poll($0, 1, Int32(step)) }

                if rc == 0 {
                    // no new data this tick
                    if expect == nil && out.count > 0 {
                        let idleMs = Int(Date().timeIntervalSince(lastDataTime) * 1000.0)
                        if idleMs >= currentIdleThresholdMs() {
                            finish(.success(ReadResult(data: out, matched: false)))
                            return
                        }
                    }
                    continue
                }
                if rc < 0 {
                    let e = errno
                    if e == EINTR { continue }
                    finish(.failure(self.posixError(e)))
                    return
                }

                var tmp = [UInt8](repeating: 0, count: min(Self.defaultChunkSize, cap - out.count))
                let n = tmp.withUnsafeMutableBytes { p -> Int in
                    guard let base = p.baseAddress else { return -1 }
                    return Darwin.recv(self.fd, base, p.count, 0)
                }
                if n > 0 {
                    out.append(contentsOf: tmp[0..<n])
                    let now = Date()
                    if lastDataTime != .distantPast {
                        let deltaMs = (now.timeIntervalSince(lastDataTime) * 1000.0)
                        interArrivals.append(deltaMs)
                        if interArrivals.count > 5 { interArrivals.removeFirst(interArrivals.count - 5) }
                    }
                    lastDataTime = now

                    if let ex = expect {
                        if ex(out) { matched = true; break }
                        if out.count >= cap { break }
                    } else {
                        if out.count >= cap { break } // cap reached, return below
                        continue // keep collecting until idle
                    }
                } else if n == 0 {
                    self.disconnectInternal(reason: .remote)
                    if out.isEmpty {
                        finish(.failure(TcpError.closed))
                    } else {
                        finish(.success(ReadResult(data: out, matched: matched)))
                    }
                    return
                } else {
                    let e = errno
                    if e == EAGAIN || e == EWOULDBLOCK || e == EINTR { continue }
                    let error = self.posixError(e)
                    self.disconnectInternal(reason: .error(error))
                    finish(.failure(error))
                    return
                }
            }

            if out.isEmpty && !matched && receiveDeadline.timeIntervalSinceNow <= 0 {
                finish(.failure(TcpError.readTimeout))
            } else {
                finish(.success(ReadResult(data: out, matched: matched)))
            }
        }
    }

    private func startReadInternal(chunkSize: Int) {
        guard fd >= 0 else { return }
        if reading { return }
        reading = true
        lastChunkSize = min(max(1, chunkSize), Self.maxBufferBytes)

        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in
            guard let self = self else { return }
            let size = self.lastChunkSize
            var buf = [UInt8](repeating: 0, count: size)
            while true {
                let n = buf.withUnsafeMutableBytes { p -> Int in
                    guard let base = p.baseAddress else { return -1 }
                    return Darwin.recv(self.fd, base, p.count, 0)
                }
                if n > 0 {
                    self.delegate?.tcpClient(self, didReceive: Data(buf[0..<n]))
                    continue
                } else if n == 0 {
                    self.disconnectInternal(reason: .remote)
                    break
                } else {
                    let e = errno
                    if e == EAGAIN || e == EWOULDBLOCK { break }
                    if e == EINTR { continue }
                    self.disconnectInternal(reason: .error(self.posixError(e)))
                    break
                }
            }
        }
        readSource = src
        src.resume()
    }

    private func resolveAddresses(host: String,
                                  timeoutMs: Int,
                                  completion: @escaping (Result<UnsafeMutablePointer<addrinfo>, Error>) -> Void) {
        let lock = NSLock()
        var settled = false

        func settle(_ result: Result<UnsafeMutablePointer<addrinfo>, Error>) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if settled { return false }
            settled = true
            completion(result)
            return true
        }

        DispatchQueue.global(qos: .userInitiated).async {
            var hints = addrinfo(
                ai_flags: AI_NUMERICHOST,
                ai_family: AF_UNSPEC,
                ai_socktype: SOCK_STREAM,
                ai_protocol: IPPROTO_TCP,
                ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil
            )
            var res: UnsafeMutablePointer<addrinfo>?
            let hostC = host.cString(using: .utf8)!
            var rc = getaddrinfo(hostC, nil, &hints, &res)
            if rc != 0 {
                hints.ai_flags = 0
                rc = getaddrinfo(hostC, nil, &hints, &res)
            }

            if rc == 0, let resolved = res {
                if !settle(.success(resolved)) {
                    freeaddrinfo(resolved)
                }
            } else {
                _ = settle(.failure(TcpError.invalidPort))
            }
        }

        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) {
            _ = settle(.failure(TcpError.connectTimeout))
        }
    }

    private func runOnQueueSync<T>(_ work: () -> T) -> T {
        if DispatchQueue.getSpecific(key: Self.queueKey) != nil {
            return work()
        }
        return queue.sync(execute: work)
    }

    private func beginOperation() -> Bool {
        operationLock.lock()
        defer { operationLock.unlock() }
        if operationInFlight { return false }
        operationInFlight = true
        return true
    }

    private func endOperation() {
        operationLock.lock()
        operationInFlight = false
        operationLock.unlock()
    }

    private func posixError(_ code: Int32) -> NSError {
        NSError(domain: NSPOSIXErrorDomain,
                code: Int(code),
                userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(code))])
    }
}
