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
        CAPPluginMethod(name: "tcpConnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpDisconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpIsConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpStartRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpStopRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpIsReading", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpWriteAndRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpSetReadTimeout", returnType: CAPPluginReturnPromise),
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
        @objc func tcpConnect(_ call: CAPPluginCall) {
            guard let host = call.getString("host") else { call.reject("host is required"); return }
            let port = UInt16(call.getInt("port") ?? 9100)
            let timeoutMs = call.getInt("timeoutMs") ?? 3000
            let noDelay = call.getBool("noDelay") ?? true
            let keepAlive = call.getBool("keepAlive") ?? true

            tcpClient.connect(host: host, port: port, timeoutMs: timeoutMs, noDelay: noDelay, keepAlive: keepAlive) { result in
                switch result {
                case .success:
                    // Optional: reassert delegate after successful connect (harmless redundancy).
                    self.tcpClient.delegate = self   // volitelné
                    call.resolve(["error": false, "errorMessage": NSNull(), "connected": true])
                case .failure(let e): call.resolve(["error": true, "errorMessage": "connect failed: \(e.localizedDescription)", "connected": false])
                }
            }
        }

        /// Disconnect from the remote peer. Also stops any ongoing stream read.
        /// Resolves with { error, errorMessage, disconnected }.
        @objc func tcpDisconnect(_ call: CAPPluginCall) {
            isReading = false
            tcpClient.stopRead()
            tcpClient.disconnect()
            call.resolve(["error": false, "errorMessage": NSNull(), "disconnected": true])
        }

        /// Returns the current socket connection state.
        /// Resolves with { error, errorMessage, connected }.
        @objc func tcpIsConnected(_ call: CAPPluginCall) {
            call.resolve(["error": false, "errorMessage": NSNull(), "connected": tcpClient.isConnected()])
        }

        /// Writes raw bytes to the socket. Expects `data` as number[] (0..255).
        /// Resolves with { error, errorMessage, bytesWritten }.
        @objc func tcpWrite(_ call: CAPPluginCall) {
            guard let arr = call.getArray("data", Int.self) else {
                call.resolve(["error": true, "errorMessage": "data is required (number[])", "bytesWritten": 0]); return
            }
            let bytes = arr.map { UInt8(truncatingIfNeeded: $0) }
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
        @objc func tcpStartRead(_ call: CAPPluginCall) {
            let chunk = call.getInt("chunkSize") ?? 4096

            lastChunkSize = chunk

            tcpClient.startRead(chunkSize: chunk)
            isReading = true
            call.resolve(["error": false, "errorMessage": NSNull(), "reading": true])
        }

        /// Stops the current stream reading, if any.
        /// Resolves with { error, errorMessage, reading:false }.
        @objc func tcpStopRead(_ call: CAPPluginCall) {
            isReading = false
            tcpClient.stopRead()
            call.resolve(["error": false, "errorMessage": NSNull(), "reading": false])
        }
        
        /// Returns whether the plugin believes a stream read is active.
        /// We AND it with `isConnected` to avoid stale "true" after disconnects.
        @objc func tcpIsReading(_ call: CAPPluginCall) {
            let readingNow = isReading && tcpClient.isConnected()
            call.resolve(["error": false, "errorMessage": NSNull(), "reading": readingNow])
        }

        /// Writes bytes and then waits for a response with a timeout and optional pattern matcher.
        /// - `timeoutMs`: overall read timeout
        /// - `maxBytes`: max response size to collect
        /// - `expect`: optional hex string or number[]; if present, we keep reading until it appears or maxBytes/timeout
        /// - `suspendStreamDuringRR`: if true and streaming is active, suspend it to avoid consuming the response
        /// On success resolves with { error:false, bytesWritten, bytesReaded, data:number[] }.
        /// On timeout resolves error:true but `bytesWritten` may still reflect the request length.
        @objc func tcpWriteAndRead(_ call: CAPPluginCall) {
            guard let arr = call.getArray("data", Int.self) else {
                call.resolve(["error": true, "errorMessage": "data is required (number[])", "bytesWritten": 0, "bytesReaded": 0, "data": []]); return
            }
            let bytes = arr.map { UInt8(truncatingIfNeeded: $0) }
            let timeout = call.getInt("timeoutMs") ?? 1000
            let maxBytes = call.getInt("maxBytes") ?? 4096
            
            let suspendRR = call.getBool("suspendStreamDuringRR") ?? true
            let shouldResume = suspendRR && isReading
            if shouldResume { tcpClient.stopRead() }

            // Optional pattern matcher: "expect" can be hex string or number[]
            var matcher: ((Data) -> Bool)? = nil
            if let hex = call.getString("expect") {
                let clean = hex.replacingOccurrences(of: " ", with: "").lowercased()
                if let pat = Data(clean) {
                    matcher = { buf in buf.range(of: pat) != nil }
                }
            } else if let arrPat = call.getArray("expect", Int.self) {
                let pat = Data(arrPat.map { UInt8(truncatingIfNeeded: $0) })
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
                        "bytesReaded": data.count,
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
                        "bytesReaded": 0,
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
        
        /// iOS doesn't support socket read timeouts in the same way as Android (Network.framework).
        /// Expose a no-op to keep the API surface consistent across platforms.
        // Parita s Androidem – na iOS nemá efekt (Network.framework nemá soTimeout)
        @objc func tcpSetReadTimeout(_ call: CAPPluginCall) {
            call.resolve() // no-op
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
}

// Helper: hex -> Data
private extension Data {
    /// Initialize Data from a hex string (e.g. "1b40" or "1B 40").
    /// Returns nil if the string contains invalid hex or has odd length.
    init?(_ hexString: String) {
        self.init()
        let s = hexString
        if s.count % 2 != 0 { return nil }
        var idx = s.startIndex
        while idx < s.endIndex {
            let next = s.index(idx, offsetBy: 2)
            let byteStr = s[idx..<next]
            if let b = UInt8(byteStr, radix: 16) {
                self.append(b)
                idx = next
            } else { return nil }
        }
    }
}
