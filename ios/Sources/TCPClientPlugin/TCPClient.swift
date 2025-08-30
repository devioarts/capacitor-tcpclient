import Foundation
import Darwin

/// Lightweight delegate used by the POSIX-based TCP client to stream bytes
/// and notify the host (plugin) about disconnect reasons.
protocol TcpClientDelegate: AnyObject {
    func tcpClient(_ client: TCPClient, didReceive data: Data)
    func tcpClientDidDisconnect(_ client: TCPClient, reason: TCPClient.DisconnectReason)
}

/// POSIX-based TCP client for iOS/macOS.
///
/// Design goals:
/// - Zero external deps (uses Darwin sockets, poll, fcntl, etc.).
/// - Thread-safe via a dedicated serial queue for all socket operations.
/// - Optional streaming read using `DispatchSourceRead`.
/// - Simple request/response helper (`writeAndRead`) with timeout and optional pattern match.
///
/// Notes:
/// - We set `SO_NOSIGPIPE` to avoid process-killing SIGPIPE on `send`.
/// - The socket is non-blocking; connect timeout is implemented using `poll(POLLOUT) + SO_ERROR`.
/// - Read source runs on the same serial queue to avoid cross-thread races.
final class TCPClient {
    /// Error surface kept intentionally small and transport-oriented.
    enum TcpError: Error {
        case notConnected
        case connectTimeout
        case closed
        case invalidPort
        case readStopped
        case busy
    }

    /// Why the connection ended.
    enum DisconnectReason {
        case manual
        case error(Error)
        case remote
    }

    // MARK: - Socket state (POSIX)
    private var fd: Int32 = -1
    private var readSource: DispatchSourceRead?
    /// Single-serial queue: guarantees ordering and eliminates most locking.
    private let queue = DispatchQueue(label: "dioarts.tcpclient", qos: .userInitiated)

    /// Streaming-read flag (mirrors whether `readSource` is active).
    private var reading = false
    /// Simple exclusion for `writeAndRead` to avoid concurrent RR operations.
    private var rrInFlight = false

    weak var delegate: TcpClientDelegate?

    /// Ensure resources are freed on GC/teardown.
    deinit { disconnectInternal(reason: .manual) }

    // MARK: - Connect/Disconnect

    /// Open a TCP connection. This resolves the host (IPv4/IPv6), configures the socket,
    /// switches it to non-blocking mode, and performs a connect with a deadline using `poll`.
    ///
    /// - Parameters:
    ///   - host: hostname or IPv4/IPv6 literal
    ///   - port: TCP port (default 9100 is common for printers)
    ///   - timeoutMs: connect timeout
    ///   - noDelay: set TCP_NODELAY to minimize Nagle delays
    ///   - keepAlive: enable SO_KEEPALIVE
    ///   - completion: async result on the client queue
    func connect(host: String,
                 port: UInt16 = 9100,
                 timeoutMs: Int = 3000,
                 noDelay: Bool = true,
                 keepAlive: Bool = true,
                 completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            // Drop previous state if any; emits delegate disconnect if we had a socket.
            self.disconnectInternal(reason: .manual)

            // Resolve host (first try numeric to skip DNS, then fallback to DNS).
            var hints = addrinfo(
                ai_flags: AI_NUMERICHOST,  // try literal IP first
                ai_family: AF_UNSPEC,
                ai_socktype: SOCK_STREAM,
                ai_protocol: IPPROTO_TCP,
                ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil
            )
            var res: UnsafeMutablePointer<addrinfo>?
            let hostC = host.cString(using: .utf8)!
            if getaddrinfo(hostC, nil, &hints, &res) != 0 {
                hints.ai_flags = 0 // DNS fallback
                if getaddrinfo(hostC, nil, &hints, &res) != 0 {
                    completion(.failure(TcpError.invalidPort))
                    return
                }
            }
            defer { if res != nil { freeaddrinfo(res) } }

            // Deadline for the entire connect attempt across all candidate addresses.
            let deadline = Date().addingTimeInterval(Double(max(1, timeoutMs)) / 1000.0)
            var lastErr: Int32 = 0
            var connected = false

            // Iterate address list until a connect succeeds.
            var ai = res
            while ai != nil, !connected {
                guard let aiP = ai?.pointee else { break }
                let s = socket(aiP.ai_family, aiP.ai_socktype, aiP.ai_protocol)
                if s < 0 { lastErr = errno; ai = aiP.ai_next; continue }

                // Socket options: TCP_NODELAY / KEEPALIVE / NO SIGPIPE
                var yes: Int32 = 1
                if noDelay { _ = setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &yes, socklen_t(MemoryLayout.size(ofValue: yes))) }
                if keepAlive { _ = setsockopt(s, SOL_SOCKET, SO_KEEPALIVE, &yes, socklen_t(MemoryLayout.size(ofValue: yes))) }
                _ = setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout.size(ofValue: yes))) // critical to avoid SIGPIPE on send

                // Non-blocking connect
                let flags = fcntl(s, F_GETFL, 0)
                _ = fcntl(s, F_SETFL, flags | O_NONBLOCK)

                // Build sockaddr with the target port (both v4 and v6).
                var sa = sockaddr_storage()
                if let src = aiP.ai_addr {
                    memcpy(&sa, src, Int(aiP.ai_addrlen))
                }
                var saLen: socklen_t = 0

                switch Int32(sa.ss_family) {
                case AF_INET:
                    var sin = withUnsafePointer(to: &sa) {
                        $0.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
                    }
                    sin.sin_port = CFSwapInt16HostToBig(port)
                    _ = withUnsafePointer(to: &sin) {
                        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                            memcpy(&sa, $0, MemoryLayout<sockaddr_in>.size)
                        }
                    }
                    saLen = socklen_t(MemoryLayout<sockaddr_in>.size)
                case AF_INET6:
                    var sin6 = withUnsafePointer(to: &sa) {
                        $0.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee }
                    }
                    sin6.sin6_port = CFSwapInt16HostToBig(port)
                    _ = withUnsafePointer(to: &sin6) {
                        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                            memcpy(&sa, $0, MemoryLayout<sockaddr_in6>.size)
                        }
                    }
                    saLen = socklen_t(MemoryLayout<sockaddr_in6>.size)
                default:
                    saLen = socklen_t(aiP.ai_addrlen)
                }

                // Kick off the non-blocking connect.
                let rc: Int32 = withUnsafePointer(to: &sa) {
                    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        Darwin.connect(s, $0, saLen)
                    }
                }

                var ok = false
                if rc == 0 {
                    // Immediate connect (local targets or cached ARP/ND can do this).
                    ok = true
                } else if errno == EINPROGRESS {
                    // Wait for connect completion or failure.
                    var pfd = pollfd(fd: s, events: Int16(POLLOUT), revents: 0)
                    let now = Date()
                    let remainMs = max(1, Int(deadline.timeIntervalSince(now) * 1000))
                    let prc = withUnsafeMutablePointer(to: &pfd) { poll($0, 1, Int32(remainMs)) }
                    if prc > 0 {
                        var soErr: Int32 = 0
                        var slen = socklen_t(MemoryLayout.size(ofValue: soErr))
                        // On POLLOUT, check SO_ERROR for the final status.
                        if getsockopt(s, SOL_SOCKET, SO_ERROR, &soErr, &slen) == 0, soErr == 0 {
                            ok = true
                        } else {
                            lastErr = (soErr != 0) ? soErr : errno
                        }
                    } else if prc == 0 {
                        // Poll timeout
                        lastErr = ETIMEDOUT
                    } else {
                        // Poll error
                        lastErr = errno
                    }
                } else {
                    // Immediate error
                    lastErr = errno
                }

                if ok {
                    self.fd = s
                    connected = true
                } else {
                    // Try next candidate address
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
                    // Return a precise POSIX error (e.g., ECONNREFUSED, ENETUNREACH, etc.).
                    let msg = String(cString: strerror(lastErr))
                    let err = NSError(domain: NSPOSIXErrorDomain,
                                      code: Int(lastErr),
                                      userInfo: [NSLocalizedDescriptionKey: msg])
                    completion(.failure(err))
                } else {
                    // Fallback in case errno got lost; treat it as a connect timeout.
                    completion(.failure(TcpError.connectTimeout))
                }
            }
        }
    }

    /// Public disconnect entrypoint — executes on the client queue.
    func disconnect() {
        queue.async { self.disconnectInternal(reason: .manual) }
    }

    /// Internal teardown. Cancels the read source, shuts down and closes the socket,
    /// resets flags, and notifies the delegate if we had an active connection.
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

    /// Cheap connection health check:
    /// - Poll for POLLOUT (writable) and ensure no error/hup/nval bits are present.
    /// - Returns true if the descriptor looks good; false otherwise.
    func isConnected() -> Bool {
        var ok = false
        queue.sync {
            guard fd >= 0 else { ok = false; return }
            var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            let rc = withUnsafeMutablePointer(to: &p) { poll($0, 1, 0) }
            if rc > 0 {
                let bad = (p.revents & Int16(POLLERR | POLLHUP | POLLNVAL)) != 0
                ok = !bad
            } else {
                // rc == 0 (no events) or rc < 0 (transient); keep the connection optimistic.
                ok = true
            }
        }
        return ok
    }

    // MARK: - Write

    /// Write the entire byte array to the socket.
    /// - Uses a loop to handle short writes on non-blocking sockets.
    /// - On EPIPE we treat it as remote disconnect and notify via delegate.
    func write(_ bytes: [UInt8], completion: @escaping (Result<Int, Error>) -> Void) {
        queue.async {
            guard self.fd >= 0 else { completion(.failure(TcpError.notConnected)); return }
            if self.rrInFlight { completion(.failure(TcpError.busy)); return }

            var sent = 0
            let total = bytes.count
            while sent < total {
                let toSend = total - sent
                let n = bytes.withUnsafeBytes { p -> Int in
                    let base = p.baseAddress!.advanced(by: sent)
                    // SO_NOSIGPIPE prevents SIGPIPE signals on broken pipes.
                    return Darwin.send(self.fd, base, toSend, 0)
                }
                if n < 0 {
                    let e = errno
                    if e == EPIPE {
                        self.disconnectInternal(reason: .remote)
                        completion(.failure(TcpError.closed))
                    } else {
                        self.disconnectInternal(reason: .error(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                        completion(.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                    }
                    return
                }
                sent += n
            }
            completion(.success(sent))
        }
    }

    // MARK: - Stream read (events)

    /// Start continuous read using `DispatchSourceRead`.
    /// - Allocates a fixed-size buffer (`chunkSize`) and drains the socket until EAGAIN/EWOULDBLOCK.
    /// - Emits each read chunk to the delegate.
    /// - On 0 bytes (EOF) treats it as remote disconnect.
    func startRead(chunkSize: Int = 4096) {
        queue.async {
            guard self.fd >= 0 else { return }
            if self.reading { return }
            self.reading = true

            let src = DispatchSource.makeReadSource(fileDescriptor: self.fd, queue: self.queue)
            src.setEventHandler { [weak self] in
                guard let self = self else { return }
                let size = max(1, chunkSize)
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
                        // EOF – remote closed the connection.
                        self.disconnectInternal(reason: .remote)
                        break
                    } else {
                        let e = errno
                        if e == EAGAIN || e == EWOULDBLOCK { break }
                        // Other recv errors => treat as fatal and notify.
                        self.disconnectInternal(reason: .error(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                        break
                    }
                }
            }
            src.setCancelHandler { }
            self.readSource = src
            src.resume()
        }
    }

    /// Stop the streaming read and release the source.
    func stopRead() {
        queue.async {
            self.reading = false
            self.readSource?.cancel()
            self.readSource = nil
        }
    }

    /// Lightweight flag getter (queue-confined).
    func isReading() -> Bool { return reading }

    // MARK: - Write & wait for pattern (request/response)

    /// Perform a one-shot request/response on the same socket.
    ///
    /// Steps:
    /// 1) Guard against concurrent RR (`rrInFlight`).
    /// 2) Send all bytes (looping on short writes).
    /// 3) Repeatedly poll for readability with small steps (<= 200 ms) until:
    ///    - `expect` pattern appears, or
    ///    - `maxBytes` reached, or
    ///    - timeout expires.
    ///
    /// Notes:
    /// - This RR helper is independent of the streaming read; the plugin typically suspends
    ///   streaming during RR to avoid the stream consumer eating the response.
    func writeAndRead(_ bytes: [UInt8],
                      timeoutMs: Int = 1000,
                      maxBytes: Int = 4096,
                      expect: ((Data) -> Bool)? = nil,
                      completion: @escaping (Result<Data, Error>) -> Void) {
        queue.async {
            guard self.fd >= 0 else { completion(.failure(TcpError.notConnected)); return }
            guard !self.rrInFlight else { completion(.failure(TcpError.busy)); return }
            self.rrInFlight = true

            func finish(_ r: Result<Data, Error>) {
                self.rrInFlight = false
                completion(r)
            }

            // --- Send phase (handle short writes, EPIPE, etc.) ---
            var sent = 0
            while sent < bytes.count {
                let n = bytes.withUnsafeBytes {
                    Darwin.send(self.fd, $0.baseAddress!.advanced(by: sent), bytes.count - sent, 0)
                }
                if n < 0 {
                    let e = errno
                    if e == EPIPE {
                        self.disconnectInternal(reason: .remote)
                        finish(.failure(TcpError.closed))
                    } else {
                        self.disconnectInternal(reason: .error(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                        finish(.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                    }
                    return
                }
                sent += n
            }

            // --- Receive phase using poll(POLLIN) with a global timeout budget ---
            let cap = max(1, maxBytes)
            // `Data(capacity:)` reserves but length grows as we append; efficient for concat.
            var out = Data(capacity: cap)
            var pfd = pollfd(fd: self.fd, events: Int16(POLLIN), revents: 0)
            var remain = max(1, timeoutMs)

            while out.count < cap && remain > 0 {
                let step = min(remain, 200) // small poll slices improve responsiveness to early matches
                let rc = withUnsafeMutablePointer(to: &pfd) { poll($0, 1, Int32(step)) }
                remain -= step
                if rc == 0 { continue } // still waiting
                if rc < 0 {
                    let e = errno
                    finish(.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                    return
                }
                // Socket readable
                let want = min(2048, cap - out.count)
                var tmp = [UInt8](repeating: 0, count: want)
                let n = tmp.withUnsafeMutableBytes { p -> Int in
                    guard let base = p.baseAddress else { return -1 }
                    return Darwin.recv(self.fd, base, p.count, 0)
                }
                if n > 0 {
                    out.append(tmp, count: n)
                    if let match = expect, match(out) { finish(.success(out)); return }
                    if expect == nil { finish(.success(out)); return } // first chunk policy when no pattern
                    continue
                } else if n == 0 {
                    // Peer closed during RR
                    finish(.failure(TcpError.closed)); return
                } else {
                    let e = errno
                    if e == EAGAIN || e == EWOULDBLOCK { continue }
                    finish(.failure(NSError(domain: NSPOSIXErrorDomain, code: Int(e))))
                    return
                }
            }
            // Timeout or cap reached: return what we have (even empty) as success.
            finish(.success(out))
        }
    }
}
