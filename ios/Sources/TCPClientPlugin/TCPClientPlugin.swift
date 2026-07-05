import Foundation
import Capacitor

@objc(TCPClientPlugin)
public class TCPClientPlugin: CAPPlugin, CAPBridgedPlugin {
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
        CAPPluginMethod(name: "writeAndRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroyConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPluginPlatform", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - Per-connection state

    /// Holds the TCPClient and its micro-batch buffer for one connectionId.
    private final class ConnState {
        let client: TCPClient
        let delegate: ConnDelegate
        var pendingBuffer = [UInt8]()
        var flushWorkItem: DispatchWorkItem?

        init(id: String, plugin: TCPClientPlugin) {
            self.delegate = ConnDelegate(id, plugin)
            self.client = TCPClient()
            self.client.delegate = self.delegate
        }
    }

    /// Per-connection TcpClientDelegate that routes callbacks back to the plugin.
    private final class ConnDelegate: TcpClientDelegate {
        let connectionId: String
        weak var plugin: TCPClientPlugin?

        init(_ id: String, _ plugin: TCPClientPlugin) {
            self.connectionId = id
            self.plugin = plugin
        }

        func tcpClient(_ client: TCPClient, didReceive data: Data) {
            plugin?.onReceive(data, connectionId: connectionId)
        }

        func tcpClientDidDisconnect(_ client: TCPClient, reason: TCPClient.DisconnectReason) {
            plugin?.onDisconnect(reason, connectionId: connectionId)
        }
    }

    private var connections = [String: ConnState]()
    private let mergeWindowMs = 10
    private let mergeMaxBytes = 16 * 1024

    // MARK: - Registry helpers

    private func getOrCreate(_ id: String) -> ConnState {
        if let existing = connections[id] { return existing }
        let state = ConnState(id: id, plugin: self)
        connections[id] = state
        return state
    }

    // MARK: - API

    @objc func connect(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required", "connected": false]); return
        }
        guard let host = call.getString("host"), !host.isEmpty else {
            call.resolve(["error": true, "errorMessage": "host is required", "connected": false]); return
        }
        let port = call.getInt("port") ?? 9100
        guard (1...65535).contains(port) else {
            call.resolve(["error": true, "errorMessage": "invalid port", "connected": false]); return
        }
        let timeout = call.getInt("timeout") ?? 3000
        let noDelay = call.getBool("noDelay") ?? true
        let keepAlive = call.getBool("keepAlive") ?? true

        let state = getOrCreate(connectionId)
        state.client.connect(host: host, port: UInt16(port), timeout: timeout, noDelay: noDelay, keepAlive: keepAlive) { res in
            switch res {
            case .success:
                call.resolve(["error": false, "errorMessage": NSNull(), "connected": true])
            case .failure(let err):
                call.resolve(["error": true, "errorMessage": "connect failed: \(err.localizedDescription)", "connected": false])
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required", "disconnected": false, "reading": false]); return
        }
        if let state = connections[connectionId] {
            state.client.disconnect()
            flushPending(connectionId)
        }
        call.resolve(["error": false, "errorMessage": NSNull(), "disconnected": true, "reading": false])
    }

    @objc func isConnected(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required", "connected": false]); return
        }
        let connected = connections[connectionId]?.client.isConnected() ?? false
        call.resolve(["error": false, "errorMessage": NSNull(), "connected": connected])
    }

    @objc func isReading(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required", "reading": false]); return
        }
        let reading = connections[connectionId]?.client.isReading() ?? false
        call.resolve(["error": false, "errorMessage": NSNull(), "reading": reading])
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required", "bytesSent": 0]); return
        }
        guard let state = connections[connectionId] else {
            call.resolve(["error": true, "errorMessage": "not connected", "bytesSent": 0]); return
        }
        guard let bytes = extractBytes(call) else {
            call.resolve(["error": true, "errorMessage": "invalid data (expected number[] / Uint8Array)", "bytesSent": 0]); return
        }
        state.client.write(bytes) { res in
            switch res {
            case .success(let count): call.resolve(["error": false, "errorMessage": NSNull(), "bytesSent": count])
            case .failure(let err): call.resolve(["error": true, "errorMessage": "write failed: \(err.localizedDescription)", "bytesSent": 0])
            }
        }
    }

    @objc func startRead(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required", "reading": false]); return
        }
        guard let state = connections[connectionId] else {
            call.resolve(["error": true, "errorMessage": "not connected", "reading": false]); return
        }
        guard state.client.isConnected() else {
            call.resolve(["error": true, "errorMessage": "not connected", "reading": false]); return
        }
        let chunk = call.getInt("chunkSize") ?? 4096
        state.pendingBuffer.removeAll(keepingCapacity: false)
        state.flushWorkItem?.cancel()
        state.flushWorkItem = nil
        state.client.startRead(chunkSize: chunk)
        call.resolve(["error": false, "errorMessage": NSNull(), "reading": true])
    }

    @objc func stopRead(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required", "reading": false]); return
        }
        if let state = connections[connectionId] {
            state.client.stopRead()
            flushPending(connectionId)
        }
        call.resolve(["error": false, "errorMessage": NSNull(), "reading": false])
    }

    @objc func setReadTimeout(_ call: CAPPluginCall) {
        // iOS stream reads are event-driven, so readTimeout is accepted for API parity only.
        _ = call.getString("connectionId")
        _ = call.getInt("readTimeout")
        call.resolve(["error": false, "errorMessage": NSNull()])
    }

    @objc func writeAndRead(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required",
                          "bytesSent": 0, "bytesReceived": 0, "data": [], "matched": false]); return
        }
        guard let state = connections[connectionId] else {
            call.resolve(["error": true, "errorMessage": "not connected",
                          "bytesSent": 0, "bytesReceived": 0, "data": [], "matched": false]); return
        }
        guard let bytes = extractBytes(call) else {
            call.resolve(["error": true, "errorMessage": "invalid data (expected number[] / Uint8Array)",
                          "bytesSent": 0, "bytesReceived": 0, "data": [], "matched": false]); return
        }
        let timeout = call.getInt("timeout") ?? 1000
        let maxBytes = call.getInt("maxBytes") ?? 4096
        let suspendRR = call.getBool("suspendStreamDuringRR") ?? true
        let matcher: ((Data) -> Bool)?
        do {
            matcher = try buildMatcher(call)
        } catch {
            call.resolve(["error": true, "errorMessage": error.localizedDescription,
                          "bytesSent": 0, "bytesReceived": 0, "data": [], "matched": false]); return
        }

        state.client.writeAndRead(bytes, timeout: timeout, maxBytes: maxBytes, expect: matcher, suspendStreamDuringRR: suspendRR) { res in
            switch res {
            case .success(let rrResult):
                call.resolve(["error": false, "errorMessage": NSNull(),
                              "bytesSent": bytes.count, "bytesReceived": rrResult.data.count,
                              "data": Array(rrResult.data), "matched": rrResult.matched])
            case .failure(let err):
                let bytesSent: Int = {
                    guard let tcpError = err as? TCPClient.TcpError else { return 0 }
                    switch tcpError {
                    case .readTimeout:
                        return bytes.count
                    case .writeTimeout(let sent):
                        return sent
                    default:
                        return 0
                    }
                }()
                call.resolve(["error": true, "errorMessage": "writeAndRead failed: \(err.localizedDescription)",
                              "bytesSent": bytesSent, "bytesReceived": 0,
                              "data": [], "matched": false])
            }
        }
    }

    @objc func destroyConnection(_ call: CAPPluginCall) {
        guard let connectionId = call.getString("connectionId") else { call.resolve(); return }
        if let state = connections.removeValue(forKey: connectionId) {
            state.client.disconnect()
            state.flushWorkItem?.cancel()
        }
        call.resolve()
    }

    // MARK: - Delegate callbacks (called by ConnDelegate)

    fileprivate func onReceive(_ data: Data, connectionId: String) {
        DispatchQueue.main.async {
            guard let state = self.connections[connectionId] else { return }
            state.pendingBuffer.append(contentsOf: data)
            if state.pendingBuffer.count >= self.mergeMaxBytes {
                self.flushPending(connectionId)
                return
            }
            state.flushWorkItem?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.flushPending(connectionId) }
            state.flushWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(self.mergeWindowMs), execute: work)
        }
    }

    fileprivate func onDisconnect(_ reason: TCPClient.DisconnectReason, connectionId: String) {
        DispatchQueue.main.async {
            self.flushPending(connectionId)
            var payload: [String: Any] = ["connectionId": connectionId, "disconnected": true, "reading": false]
            switch reason {
            case .manual: payload["reason"] = "manual"
            case .remote: payload["reason"] = "remote"
            case .error(let err): payload["reason"] = "error"; payload["error"] = err.localizedDescription
            }
            self.notifyListeners("tcpDisconnect", data: payload)
        }
    }

    // MARK: - Helpers

    private func flushPending(_ connectionId: String) {
        guard let state = connections[connectionId] else { return }
        state.flushWorkItem?.cancel()
        state.flushWorkItem = nil
        guard !state.pendingBuffer.isEmpty else { return }
        let payload = state.pendingBuffer
        state.pendingBuffer.removeAll(keepingCapacity: false)
        notifyListeners("tcpData", data: ["connectionId": connectionId, "data": payload])
    }

    @objc func getPluginPlatform(_ call: CAPPluginCall) {
        call.resolve(["error": false, "errorMessage": NSNull(), "platform": "ios"])
    }

    override public func checkPermissions(_ call: CAPPluginCall) { call.resolve() }
}

private extension TCPClientPlugin {
    /// Build an optional byte-pattern matcher from the "expect" call parameter.
    func buildMatcher(_ call: CAPPluginCall) throws -> ((Data) -> Bool)? {
        if let hexStr = call.getString("expect") {
            if hexStr.isEmpty { return nil }
            let clean = String(hexStr.lowercased()
                .replacingOccurrences(of: "0x", with: "")
                .filter { !$0.isWhitespace })
            guard !clean.isEmpty, clean.count % 2 == 0 else { throw invalidExpectError("invalid expect (hex)") }
            var pattern = Data(capacity: clean.count / 2)
            var idx = clean.startIndex
            while idx < clean.endIndex {
                let nextIdx = clean.index(idx, offsetBy: 2)
                guard let byte = UInt8(clean[idx..<nextIdx], radix: 16) else {
                    throw invalidExpectError("invalid expect (hex)")
                }
                pattern.append(byte)
                idx = nextIdx
            }
            return { buf in buf.range(of: pattern) != nil }
        }
        if let arr = call.getArray("expect", UInt.self) {
            let pattern = Data(arr.map { UInt8($0 & 0xff) })
            return { buf in buf.range(of: pattern) != nil }
        }
        if let obj = call.getObject("expect"), let bytes = bytesFromObject(obj) {
            let pattern = Data(bytes)
            return { buf in buf.range(of: pattern) != nil }
        }
        if hasPresentOption(call, "expect") {
            throw invalidExpectError("invalid expect (hex or byte array expected)")
        }
        return nil
    }

    func invalidExpectError(_ message: String) -> NSError {
        NSError(domain: "TCPClientPlugin", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    /// Extract bytes from "data" field — accepts number[] or Uint8Array object.
    func extractBytes(_ call: CAPPluginCall) -> [UInt8]? {
        if let arr = call.getArray("data", UInt.self) {
            return arr.map { UInt8($0 & 0xff) }
        }
        if let obj = call.getObject("data") { return bytesFromObject(obj) }
        return nil
    }

    func byteValue(_ value: Any?) -> UInt8? {
        guard let value = value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
            let doubleValue = number.doubleValue
            guard doubleValue.isFinite else { return nil }
            return UInt8(Int(doubleValue) & 0xff)
        }
        if let intValue = value as? Int { return UInt8(intValue & 0xff) }
        if let uintValue = value as? UInt { return UInt8(uintValue & 0xff) }
        if let doubleValue = value as? Double, doubleValue.isFinite { return UInt8(Int(doubleValue) & 0xff) }
        return nil
    }

    func bytesFromObject(_ obj: JSObject) -> [UInt8]? {
        let len: Int
        if let explicitLen = obj["length"] {
            guard let parsedLen = (explicitLen as? NSNumber)?.intValue ?? explicitLen as? Int, parsedLen >= 0 else {
                return nil
            }
            len = parsedLen
        } else {
            let maxIndex = obj.keys.compactMap { Int($0) }.max() ?? -1
            len = maxIndex + 1
        }

        var out = [UInt8]()
        out.reserveCapacity(len)
        for idx in 0..<len {
            guard let byte = byteValue(obj["\(idx)"]) else { return nil }
            out.append(byte)
        }
        return out
    }

    func hasPresentOption(_ call: CAPPluginCall, _ key: String) -> Bool {
        guard let value = call.options[key] else { return false }
        return !(value is NSNull)
    }
}
