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
    enum TcpError: Error {
        case notConnected
        case connectTimeout
        case closed
        case invalidPort
        case readStopped
        case busy
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

    private var reading = false
    private var rrInFlight = false
    private var lastChunkSize: Int = 4096

    weak var delegate: TcpClientDelegate?

    deinit { disconnectInternal(reason: .manual) }

    // MARK: - Connect/Disconnect

    func connect(host: String,
                 port: UInt16 = 9100,
                 timeout: Int = 3000,
                 noDelay: Bool = true,
                 keepAlive: Bool = true,
                 completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            self.disconnectInternal(reason: .manual)

            var hints = addrinfo(
                ai_flags: AI_NUMERICHOST,
                ai_family: AF_UNSPEC,
                ai_socktype: SOCK_STREAM,
                ai_protocol: IPPROTO_TCP,
                ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil
            )
            var res: UnsafeMutablePointer<addrinfo>?
            let hostC = host.cString(using: .utf8)!
            if getaddrinfo(hostC, nil, &hints, &res) != 0 {
                hints.ai_flags = 0
                if getaddrinfo(hostC, nil, &hints, &res) != 0 {
                    completion(.failure(TcpError.invalidPort))
                    return
                }
            }
            defer { if res != nil { freeaddrinfo(res) } }

            let deadline = Date().addingTimeInterval(Double(max(1, timeout)) / 1000.0)
            var lastErr: Int32 = 0
            var connected = false

            var ai = res
            while ai != nil, !connected {
                guard let aiP = ai?.pointee else { break }
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
                    let msg = String(cString: strerror(lastErr))
                    let err = NSError(domain: NSPOSIXErrorDomain, code: Int(lastErr), userInfo: [NSLocalizedDescriptionKey: msg])
                    completion(.failure(err))
                } else {
                    completion(.failure(TcpError.connectTimeout))
                }
            }
        }
    }

    func disconnect() { queue.async { self.disconnectInternal(reason: .manual) } }

    private func disconnectInternal(reason: DisconnectReason) {
        let had = (fd >= 0) || reading
        rrInFlight = false
        reading = false

        if let src = readSource {
            src.cancel()
            readSource = nil
        }
        if fd >= 0 {
            _ = shutdown(fd, SHUT_RDWR)
            close(fd)
            fd = -1
        }
        if had { delegate?.tcpClientDidDisconnect(self, reason: reason) }
    }

    /// Robust connectivity check without a running reader:
    /// uses non-blocking MSG_PEEK to detect EOF immediately.
    func isConnected() -> Bool {
        var ok = false
        queue.sync {
            guard fd >= 0 else { ok = false; return }

            if reading || rrInFlight { ok = true; return }

            var p = pollfd(fd: fd, events: Int16(POLLIN | POLLERR | POLLHUP | POLLNVAL), revents: 0)
            let rc = withUnsafeMutablePointer(to: &p) { poll($0, 1, 0) }
            if rc < 0 {
                let e = errno
                self.disconnectInternal(reason: .error(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                ok = false
                return
            }
            if (p.revents & Int16(POLLERR | POLLHUP | POLLNVAL)) != 0 {
                self.disconnectInternal(reason: .remote)
                ok = false
                return
            }

            var c: UInt8 = 0
            let n: Int = withUnsafeMutableBytes(of: &c) { rawPtr in
                guard let base = rawPtr.baseAddress else { return -1 }
                return Darwin.recv(self.fd, base, 1, MSG_PEEK)
            }

            if n == 0 {
                self.disconnectInternal(reason: .remote)
                ok = false
            } else if n > 0 {
                ok = true
            } else {
                let e = errno
                ok = (e == EAGAIN || e == EWOULDBLOCK)
                if !ok {
                    self.disconnectInternal(reason: .error(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                }
            }
        }
        return ok
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
            if e == EPIPE {
                self.disconnectInternal(reason: .remote)
                throw TcpError.closed
            } else if e == EAGAIN || e == EWOULDBLOCK {
                // wait for POLLOUT
                while true {
                    let now = Date()
                    let remain = deadline.timeIntervalSince(now)
                    if remain <= 0 { throw TcpError.connectTimeout }
                    let stepSec = min(remain, 0.010) // 10ms
                    var pfd = pollfd(fd: self.fd, events: Int16(POLLOUT), revents: 0)
                    let prc = withUnsafeMutablePointer(to: &pfd) { poll($0, 1, Int32(stepSec * 1000.0)) }
                    if prc > 0 { break }
                    if prc < 0 {
                        let perr = errno
                        throw NSError(domain: NSPOSIXErrorDomain, code: Int(perr),
                                      userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(perr))])
                    }
                    // prc == 0 => timed step; loop until deadline
                }
            } else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(e),
                              userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(e))])
            }
        }
        return sent
    }

    // MARK: - Write

    func write(_ bytes: [UInt8], completion: @escaping (Result<Int, Error>) -> Void) {
        queue.async {
            guard self.fd >= 0 else { completion(.failure(TcpError.notConnected)); return }
            if self.rrInFlight { completion(.failure(TcpError.busy)); return }
            do {
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
            guard self.fd >= 0 else { return }
            if self.reading { return }
            self.reading = true
            self.lastChunkSize = max(1, chunkSize)

            let src = DispatchSource.makeReadSource(fileDescriptor: self.fd, queue: self.queue)
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
                        self.disconnectInternal(reason: .error(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                        break
                    }
                }
            }
            self.readSource = src
            src.resume()
        }
    }

    func stopRead() {
        queue.async {
            self.reading = false
            self.readSource?.cancel()
            self.readSource = nil
        }
    }

    func isReading() -> Bool { return reading }

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
        queue.async {
            guard self.fd >= 0 else { completion(.failure(TcpError.notConnected)); return }
            guard !self.rrInFlight else { completion(.failure(TcpError.busy)); return }
            self.rrInFlight = true
            func finish(_ r: Result<ReadResult, Error>) { self.rrInFlight = false; completion(r) }

            let wasReading = self.reading
            if suspendStreamDuringRR && wasReading {
                self.stopRead()
            }

            // Send phase (budget = timeout)
            do {
                _ = try self.sendAll(bytes, budgetMs: max(1, timeout))
            } catch {
                if case TcpError.closed = error {
                    self.disconnectInternal(reason: .remote)
                }
                finish(.failure(error))
                if suspendStreamDuringRR && wasReading && self.fd >= 0 { self.startRead(chunkSize: self.lastChunkSize) }
                return
            }

            // Receive phase with global timeout budget
            let cap = max(1, maxBytes)
            var out = Data(capacity: cap)
            var pfd = pollfd(fd: self.fd, events: Int16(POLLIN), revents: 0)
            var remain = max(1, timeout)
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

            while out.count < cap && remain > 0 {
                let step = min(remain, 50) // fine-grained to evaluate idle
                let rc = withUnsafeMutablePointer(to: &pfd) { poll($0, 1, Int32(step)) }
                remain -= step

                if rc == 0 {
                    // no new data this tick
                    if expect == nil && out.count > 0 {
                        let idleMs = Int(Date().timeIntervalSince(lastDataTime) * 1000.0)
                        if idleMs >= currentIdleThresholdMs() {
                            finish(.success(ReadResult(data: out, matched: false)))
                            if suspendStreamDuringRR && wasReading && self.fd >= 0 { self.startRead(chunkSize: self.lastChunkSize) }
                            return
                        }
                    }
                    continue
                }
                if rc < 0 {
                    let e = errno
                    finish(.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                    if suspendStreamDuringRR && wasReading && self.fd >= 0 { self.startRead(chunkSize: self.lastChunkSize) }
                    return
                }

                var tmp = [UInt8](repeating: 0, count: min(4096, cap - out.count))
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
                    finish(.failure(TcpError.closed))
                    if suspendStreamDuringRR && wasReading && self.fd >= 0 { self.startRead(chunkSize: self.lastChunkSize) }
                    return
                } else {
                    let e = errno
                    if e == EAGAIN || e == EWOULDBLOCK { continue }
                    self.disconnectInternal(reason: .error(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                    finish(.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                    if suspendStreamDuringRR && wasReading && self.fd >= 0 { self.startRead(chunkSize: self.lastChunkSize) }
                    return
                }
            }

            if out.isEmpty && !matched && remain <= 0 {
                finish(.failure(TcpError.connectTimeout))
            } else {
                finish(.success(ReadResult(data: out, matched: matched)))
            }

            if suspendStreamDuringRR && wasReading && self.fd >= 0 {
                self.startRead(chunkSize: self.lastChunkSize)
            }
        }
    }
}
