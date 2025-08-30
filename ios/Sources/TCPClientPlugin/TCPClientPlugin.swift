import Foundation
import Capacitor

/**
 * iOS bridge for the TCPClient.
 *
 * Responsibilities:
 * - Validate/normalize inputs from JavaScript calls
 * - Forward calls to the native TCPClient
 * - Emit JS events (tcpData, tcpDisconnect) via Capacitor's notifyListeners
 * - Keep lightweight UI-facing state (isReading, lastChunkSize) in sync with the native client
 *
 * Notes:
 * - We set the TCP client's delegate in `load()` so the plugin can receive async callbacks.
 * - Events are dispatched on the main thread to keep WKWebView/bridge interactions predictable.
 * - The public API mirrors Android as closely as possible for parity across platforms.
 */

/**
 * Please read the Capacitor iOS Plugin Development Guide
 * here: https://capacitorjs.com/docs/plugins/ios
 */
@objc(TCPClientPlugin)
public class TCPClientPlugin: CAPPlugin, CAPBridgedPlugin, TcpClientDelegate {
    public let identifier = "TCPClientPlugin"
    public let jsName = "TCPClient"
    public let pluginMethods: [CAPPluginMethod] = [
        // Promise-returning methods exposed to JS
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isReading", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeAndRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setReadTimeout", returnType: CAPPluginReturnPromise),
    ]
    private let tcpClient = TCPClient()
    // UI-facing reading flag (kept in sync with the native client's read source)
    private var isReading = false
    // Remember the last requested chunk size to resume streaming after RR operations
    private var lastChunkSize = 4096
    
    public override func load() {
            super.load()
            // Hook the delegate once the plugin is loaded so we receive async callbacks.
            tcpClient.delegate = self
        }

    // MARK: Capacitor methods
        /// Connect to the remote TCP endpoint. Mirrors Android parameters for parity.
        /// Resolves with { error, errorMessage, connected }.
        @objc func connect(_ call: CAPPluginCall) {
            guard let host = call.getString("host") else { call.reject("host is required"); return }

            let portInt = call.getInt("port") ?? 9100
            guard (1...65535).contains(portInt) else {
                call.resolve(["error": true, "errorMessage": "invalid port", "connected": false])
                return
            }
            let port = UInt16(portInt)


            let timeoutMs = call.getInt("timeoutMs") ?? 3000
            let noDelay = call.getBool("noDelay") ?? true
            let keepAlive = call.getBool("keepAlive") ?? true

            tcpClient.connect(host: host, port: port, timeoutMs: timeoutMs, noDelay: noDelay, keepAlive: keepAlive) { result in
                switch result {
                case .success:
                    // Optional: reassert delegate after successful connect (harmless redundancy).
                    self.tcpClient.delegate = self   // optional
                    call.resolve(["error": false, "errorMessage": NSNull(), "connected": true])
                case .failure(let e): call.resolve(["error": true, "errorMessage": "connect failed: \(e.localizedDescription)", "connected": false])
                }
            }
        }

        /// Disconnect from the remote peer. Also stops any ongoing stream read.
        /// Resolves with { error, errorMessage, disconnected }.
        @objc func disconnect(_ call: CAPPluginCall) {
            isReading = false
            tcpClient.stopRead()
            tcpClient.disconnect()
            call.resolve(["error": false, "errorMessage": NSNull(), "disconnected": true])
        }

        /// Returns the current socket connection state.
        /// Resolves with { error, errorMessage, connected }.
        @objc func isConnected(_ call: CAPPluginCall) {
            call.resolve(["error": false, "errorMessage": NSNull(), "connected": tcpClient.isConnected()])
        }

        /// Writes raw bytes to the socket. Expects `data` as number[] (0..255).
        /// Resolves with { error, errorMessage, bytesWritten }.
        @objc func write(_ call: CAPPluginCall) {
            guard let bytes = getBytes(from: call, key: "data") else {
                    call.resolve(["error": true, "errorMessage": "data is required (number[] | Uint8Array)", "bytesWritten": 0])
                    return
                }
            tcpClient.write(bytes) { result in
                switch result {
                case .success(let n): call.resolve(["error": false, "errorMessage": NSNull(), "bytesWritten": n])
                case .failure(let e): call.resolve(["error": true, "errorMessage": "write failed: \(e.localizedDescription)", "bytesWritten": 0])
                }
            }
        }

        /// Starts continuous stream reading with the given chunk size.
        /// Also remembers `chunkSize` so we can resume after a write-and-read cycle.
        /// Resolves with { error, errorMessage, reading }.
        @objc func startRead(_ call: CAPPluginCall) {
            let chunk = call.getInt("chunkSize") ?? 4096

            lastChunkSize = chunk

            tcpClient.startRead(chunkSize: chunk)
            isReading = true
            call.resolve(["error": false, "errorMessage": NSNull(), "reading": true])
        }

        /// Stops the current stream reading, if any.
        /// Resolves with { error, errorMessage, reading:false }.
        @objc func stopRead(_ call: CAPPluginCall) {
            isReading = false
            tcpClient.stopRead()
            call.resolve(["error": false, "errorMessage": NSNull(), "reading": false])
        }
        
        /// Returns whether the plugin believes a stream read is active.
        /// We AND it with `isConnected` to avoid stale "true" after disconnects.
        @objc func isReading(_ call: CAPPluginCall) {
            let readingNow = isReading && tcpClient.isConnected()
            call.resolve(["error": false, "errorMessage": NSNull(), "reading": readingNow])
        }

        /// Writes bytes and then waits for a response with a timeout and optional pattern matcher.
        /// - `timeoutMs`: overall read timeout
        /// - `maxBytes`: max response size to collect
        /// - `expect`: optional hex string or number[]; if present, we keep reading until it appears or maxBytes/timeout
        /// - `suspendStreamDuringRR`: if true and streaming is active, suspend it to avoid consuming the response
        /// On success resolves with { error:false, bytesWritten, bytesRead, data:number[] }.
        /// On timeout resolves error:true but `bytesWritten` may still reflect the request length.
        @objc func writeAndRead(_ call: CAPPluginCall) {
            guard let bytes = getBytes(from: call, key: "data") else {
                    call.resolve(["error": true, "errorMessage": "data is required (number[] | Uint8Array)", "bytesWritten": 0, "bytesRead": 0, "data": []])
                    return
                }
            let timeout = call.getInt("timeoutMs") ?? 1000
            let maxBytes = call.getInt("maxBytes") ?? 4096
            
            let suspendRR = call.getBool("suspendStreamDuringRR") ?? true
            let shouldResume = suspendRR && isReading
            if shouldResume { tcpClient.stopRead() }

    var matcher: ((Data) -> Bool)? = nil
    if let hex = call.getString("expect"), let pat = Data(hexString: hex) {
        matcher = { buf in buf.range(of: pat) != nil }
    } else if let arrPat = call.getArray("expect", Int.self) {
        let pat = Data(arrPat.map { UInt8(truncatingIfNeeded: $0) })
        matcher = { buf in buf.range(of: pat) != nil }
    } else if let obj = call.options["expect"] as? [String: Any],
              let patBytes = bytesFromIndexedObject(obj) {
        let pat = Data(patBytes)
        matcher = { buf in buf.range(of: pat) != nil }
    }

            tcpClient.writeAndRead(bytes, timeoutMs: timeout, maxBytes: maxBytes, expect: matcher) { result in
                switch result {
                case .success(let data):
                    // Resume streaming if we suspended it for this RR cycle.
                    if shouldResume { self.isReading = true; self.tcpClient.startRead(chunkSize: self.lastChunkSize) }
                    call.resolve([
                        "error": false,
                        "errorMessage": NSNull(),
                        "bytesWritten": bytes.count,
                        "bytesRead": data.count,
                        "data": [UInt8](data)
                    ])
                case .failure(let e):
                    if shouldResume { self.isReading = true; self.tcpClient.startRead(chunkSize: self.lastChunkSize) }
                    // If it was a timeout, we likely wrote everything; mirror Android semantics.
                    let isTimeout = (e as? TCPClient.TcpError) == .connectTimeout
                    call.resolve([
                        "error": true,
                        "errorMessage": "writeAndRead failed: \(e.localizedDescription)",
                        "bytesWritten": isTimeout ? bytes.count : 0,
                        "bytesRead": 0,
                        "data": []
                    ])
                }
            }
        }

        // MARK: TcpClientDelegate

        /// Stream data callback from the native client.
        /// Dispatch to main before notifying JS to keep bridge/UI interactions deterministic.
        func tcpClient(_ client: TCPClient, didReceive data: Data) {
        DispatchQueue.main.async {
            self.notifyListeners("tcpData", data: ["data": [UInt8](data)])
            }
        }
        
        /// iOS doesn't expose a socket-level read timeout like Android's SO_TIMEOUT.
        /// Provide a no-op to keep the cross-platform API surface consistent.
        @objc func setReadTimeout(_ call: CAPPluginCall) {
            call.resolve() // no-op on iOS
        }
        
        /// Called when the underlying socket disconnects (manual, remote EOF, or error).
        /// We reset reading state, restore defaults, and emit a `tcpDisconnect` event to JS.
        func tcpClientDidDisconnect(_ client: TCPClient, reason: TCPClient.DisconnectReason) {
            var payload: [String: Any] = ["disconnected": true]
            switch reason {
                case .manual:
                    payload["reason"] = "manual"
                case .remote:
                    payload["reason"] = "remote"
                case .error(let err):
                    payload["reason"] = "error"
                    payload["error"] = err.localizedDescription
            }
            DispatchQueue.main.async {
                self.isReading = false
                self.lastChunkSize = 4096
                self.notifyListeners("tcpDisconnect", data: payload)
            }
        }
    
    // Fallback: also parse bytes from an object shaped like a Uint8Array ({"0":n, "1":n, ..., length:n})
    private func bytesFromIndexedObject(_ obj: [String: Any]) -> [UInt8]? {
        // Determine length: prefer explicit "length", otherwise infer from the highest numeric key
        let len: Int = {
            if let l = obj["length"] as? Int, l >= 0 { return l }
            var maxIdx = -1
            for (k, _) in obj {
                if let i = Int(k), i > maxIdx { maxIdx = i }
            }
            return maxIdx + 1
        }()
        guard len > 0 else { return nil }

        var out = [UInt8](repeating: 0, count: len)
        for i in 0..<len {
            let key = String(i)
            guard let v = obj[key] else { return nil }
            if let n = v as? NSNumber {
                out[i] = UInt8(truncatingIfNeeded: n.intValue)
            } else if let s = v as? String, let n = Int(s) {
                out[i] = UInt8(truncatingIfNeeded: n)
            } else {
                return nil
            }
        }
        return out
    }

    // Unified getter: prefer a number[] first; otherwise try the indexed object form
    private func getBytes(from call: CAPPluginCall, key: String) -> [UInt8]? {
        if let arr = call.getArray(key, Int.self) {
            return arr.map { UInt8(truncatingIfNeeded: $0) }
        }
        if let obj = call.options[key] as? [String: Any] {
            return bytesFromIndexedObject(obj)
        }
        return nil
    }

}

// Helper: Hex → Data (tolerant to whitespace and 0x prefixes, case-insensitive)
private extension Data {
    /// Creates Data from a hex string.
    /// Accepts: "1b40", "1B 40", "0x1b 0x40", "1B40"
    /// Rules: ignores whitespace and optional "0x"/"0X" prefixes; requires even number of hex digits.
    init?(hexString: String) {
        // Strip "0x"/"0X" and all whitespace
        let stripped = hexString
            .replacingOccurrences(of: "0x", with: "", options: [.caseInsensitive])
            .replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)

        let count = stripped.count
        guard count > 0, count % 2 == 0 else { return nil }

        self.init(capacity: count / 2)
        var idx = stripped.startIndex
        while idx < stripped.endIndex {
            let next = stripped.index(idx, offsetBy: 2)
            let byteStr = stripped[idx..<next]
            if let b = UInt8(byteStr, radix: 16) {
                self.append(b)
                idx = next
            } else {
                return nil
            }
        }
    }
}
