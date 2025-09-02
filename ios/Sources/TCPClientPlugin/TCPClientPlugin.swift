import Foundation
import Capacitor

@objc(TCPClientPlugin)
public class TCPClientPlugin: CAPPlugin, CAPBridgedPlugin, TcpClientDelegate {
    public let identifier = "TCPClientPlugin"
    public let jsName = "TCPClient"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isReading", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setReadTimeout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeAndRead", returnType: CAPPluginReturnPromise)
    ]

    private let client = TCPClient()

    // Automatic micro-batching for tcpData events (no external params)
    private let mergeWindowMs = 10
    private let mergeMaxBytes = 16 * 1024
    private var pendingBuffer = [UInt8]()
    private var flushWorkItem: DispatchWorkItem?

    override public func load() { client.delegate = self }

    // MARK: - API

    @objc func connect(_ call: CAPPluginCall) {
        guard let host = call.getString("host"), !host.isEmpty else {
            call.resolve(["error": true, "errorMessage": "host is required", "connected": false]); return
        }
        let port = call.getInt("port") ?? 9100
        let timeout = call.getInt("timeout") ?? 3000
        let noDelay = call.getBool("noDelay") ?? true
        let keepAlive = call.getBool("keepAlive") ?? true

        client.connect(host: host, port: UInt16(port), timeout: timeout, noDelay: noDelay, keepAlive: keepAlive) { res in
            switch res {
            case .success:
                call.resolve(["error": false, "errorMessage": NSNull(), "connected": true])
            case .failure(let e):
                call.resolve(["error": true, "errorMessage": "connect failed: \(e.localizedDescription)", "connected": false])
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        client.disconnect()
        flushPending()
        call.resolve(["error": false, "errorMessage": NSNull(), "disconnected": true, "reading": false])
    }

    @objc func isConnected(_ call: CAPPluginCall) {
        call.resolve(["error": false, "errorMessage": NSNull(), "connected": client.isConnected()])
    }

    @objc func isReading(_ call: CAPPluginCall) {
        call.resolve(["error": false, "errorMessage": NSNull(), "reading": client.isReading()])
    }

    @objc func write(_ call: CAPPluginCall) {
        var bytes: [UInt8]?
        if let arr = call.getArray("data", UInt.self) {
            bytes = arr.map { UInt8($0 & 0xff) }
        } else if let obj = call.getObject("data") {
            var out = [UInt8]()
            if let len = obj["length"] as? Int, len > 0 {
                out.reserveCapacity(len)
                for i in 0..<len {
                    if let v = obj["\(i)"] as? Int { out.append(UInt8(v & 0xff)) } else { bytes = nil; break }
                }
                bytes = out
            }
        }
        guard let data = bytes else {
            call.resolve(["error": true, "errorMessage": "invalid data (expected number[] / Uint8Array)", "bytesSent": 0]); return
        }
        client.write(data) { res in
            switch res {
            case .success(let n): call.resolve(["error": false, "errorMessage": NSNull(), "bytesSent": n])
            case .failure(let e): call.resolve(["error": true, "errorMessage": "write failed: \(e.localizedDescription)", "bytesSent": 0])
            }
        }
    }

    @objc func startRead(_ call: CAPPluginCall) {
        let chunk = call.getInt("chunkSize") ?? 4096
        // reset batching state
        pendingBuffer.removeAll(keepingCapacity: false)
        flushWorkItem?.cancel(); flushWorkItem = nil

        client.startRead(chunkSize: chunk)
        call.resolve(["error": false, "errorMessage": NSNull(), "reading": true])
    }

    @objc func stopRead(_ call: CAPPluginCall) {
        client.stopRead()
        flushPending()
        call.resolve(["error": false, "errorMessage": NSNull(), "reading": false])
    }

    @objc func setReadTimeout(_ call: CAPPluginCall) {
        // iOS: no-op for parity (Android-only)
        _ = call.getInt("readTimeout")
        call.resolve(["error": false, "errorMessage": NSNull()])
    }

    @objc func writeAndRead(_ call: CAPPluginCall) {
        var bytes: [UInt8]?
        if let arr = call.getArray("data", UInt.self) {
            bytes = arr.map { UInt8($0 & 0xff) }
        } else if let obj = call.getObject("data") {
            var out = [UInt8]()
            if let len = obj["length"] as? Int, len > 0 {
                out.reserveCapacity(len)
                for i in 0..<len {
                    if let v = obj["\(i)"] as? Int { out.append(UInt8(v & 0xff)) } else { bytes = nil; break }
                }
                bytes = out
            }
        }
        guard let data = bytes else {
            call.resolve(["error": true, "errorMessage": "invalid data (expected number[] / Uint8Array)",
                          "bytesSent": 0, "bytesReceived": 0, "data": [], "matched": false]); return
        }

        let timeout = call.getInt("timeout") ?? 1000
        let maxBytes = call.getInt("maxBytes") ?? 4096
        let suspendRR = call.getBool("suspendStreamDuringRR") ?? true

        var matcher: ((Data) -> Bool)?
        if let s = call.getString("expect"), !s.isEmpty {
            let clean = s.lowercased().replacingOccurrences(of: "0x", with: "").replacingOccurrences(of: " ", with: "")
            guard !clean.isEmpty, clean.count % 2 == 0 else {
                call.resolve(["error": true, "errorMessage": "invalid expect (hex)",
                              "bytesSent": 0, "bytesReceived": 0, "data": [], "matched": false]); return
            }
            var pat = Data(capacity: clean.count/2)
            var i = clean.startIndex
            while i < clean.endIndex {
                let j = clean.index(i, offsetBy: 2)
                guard let b = UInt8(clean[i..<j], radix: 16) else { break }
                pat.append(b); i = j
            }
            matcher = { buf in buf.range(of: pat) != nil }
        } else if let arr = call.getArray("expect", UInt.self) {
            let pat = Data(arr.map { UInt8($0 & 0xff) })
            matcher = { buf in buf.range(of: pat) != nil }
        }

        client.writeAndRead(data, timeout: timeout, maxBytes: maxBytes, expect: matcher, suspendStreamDuringRR: suspendRR) { res in
            switch res {
            case .success(let rr):
                call.resolve(["error": false, "errorMessage": NSNull(),
                              "bytesSent": data.count, "bytesReceived": rr.data.count,
                              "data": Array(rr.data), "matched": rr.matched])
            case .failure(let e):
                let timedOut: Bool
                if let tcpErr = e as? TCPClient.TcpError, case .connectTimeout = tcpErr { timedOut = true } else { timedOut = false }
                call.resolve(["error": true, "errorMessage": "writeAndRead failed: \(e.localizedDescription)",
                              "bytesSent": timedOut ? data.count : 0, "bytesReceived": 0,
                              "data": [], "matched": false])
            }
        }
    }

    // MARK: - Delegate (native → JS) with automatic micro-batching

    func tcpClient(_ client: TCPClient, didReceive data: Data) {
        DispatchQueue.main.async {
            // append
            self.pendingBuffer.append(contentsOf: data)
            // flush immediately if too big
            if self.pendingBuffer.count >= self.mergeMaxBytes {
                self.flushPending()
                return
            }
            // debounce window
            self.flushWorkItem?.cancel()
            let work = DispatchWorkItem { [weak self] in
                self?.flushPending()
            }
            self.flushWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(self.mergeWindowMs), execute: work)
        }
    }

    func tcpClientDidDisconnect(_ client: TCPClient, reason: TCPClient.DisconnectReason) {
        DispatchQueue.main.async {
            self.flushPending()
            var payload: [String: Any] = ["disconnected": true, "reading": false]
            switch reason {
            case .manual: payload["reason"] = "manual"
            case .remote: payload["reason"] = "remote"
            case .error(let e): payload["reason"] = "error"; payload["error"] = (e as NSError).localizedDescription
            }
            self.notifyListeners("tcpDisconnect", data: payload)
        }
    }

    override public func checkPermissions(_ call: CAPPluginCall) { call.resolve() }

    // MARK: - Helpers

    private func flushPending() {
        if !pendingBuffer.isEmpty {
            let payload = pendingBuffer
            pendingBuffer.removeAll(keepingCapacity: false)
            notifyListeners("tcpData", data: ["data": payload])
        }
        flushWorkItem?.cancel()
        flushWorkItem = nil
    }
}
