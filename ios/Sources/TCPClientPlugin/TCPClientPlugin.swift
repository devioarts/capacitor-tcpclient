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

    private func dispatchToMainIfNeeded(_ work: @escaping () -> Void) -> Bool {
        guard !Thread.isMainThread else { return false }
        DispatchQueue.main.async(execute: work)
        return true
    }

    private func writeAndReadBytesSentOnFailure(_ error: Error, requestedByteCount: Int) -> Int {
        guard let tcpError = error as? TCPClient.TcpError else { return 0 }
        switch tcpError {
        case .readTimeout:
            // A read timeout is only reported after the request was fully written.
            return requestedByteCount
        case .writeTimeout(let sent):
            return sent
        default:
            return 0
        }
    }

    private func getOrCreate(_ id: String) -> ConnState {
        if let existing = connections[id] { return existing }
        let state = ConnState(id: id, plugin: self)
        connections[id] = state
        return state
    }

    // MARK: - API

    @objc func connect(_ call: CAPPluginCall) {
        if dispatchToMainIfNeeded({ self.connect(call) }) { return }
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
        if dispatchToMainIfNeeded({ self.disconnect(call) }) { return }
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
        if dispatchToMainIfNeeded({ self.isConnected(call) }) { return }
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required", "connected": false]); return
        }
        let connected = connections[connectionId]?.client.isConnected() ?? false
        call.resolve(["error": false, "errorMessage": NSNull(), "connected": connected])
    }

    @objc func isReading(_ call: CAPPluginCall) {
        if dispatchToMainIfNeeded({ self.isReading(call) }) { return }
        guard let connectionId = call.getString("connectionId"), !connectionId.isEmpty else {
            call.resolve(["error": true, "errorMessage": "connectionId is required", "reading": false]); return
        }
        let reading = connections[connectionId]?.client.isReading() ?? false
        call.resolve(["error": false, "errorMessage": NSNull(), "reading": reading])
    }

    @objc func write(_ call: CAPPluginCall) {
        if dispatchToMainIfNeeded({ self.write(call) }) { return }
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
        if dispatchToMainIfNeeded({ self.startRead(call) }) { return }
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
        if dispatchToMainIfNeeded({ self.stopRead(call) }) { return }
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
        if dispatchToMainIfNeeded({ self.setReadTimeout(call) }) { return }
        // iOS stream reads are event-driven, so readTimeout is accepted for API parity only.
        _ = call.getString("connectionId")
        _ = call.getInt("readTimeout")
        call.resolve(["error": false, "errorMessage": NSNull()])
    }

    @objc func writeAndRead(_ call: CAPPluginCall) {
        if dispatchToMainIfNeeded({ self.writeAndRead(call) }) { return }
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
                let bytesSent = self.writeAndReadBytesSentOnFailure(err, requestedByteCount: bytes.count)
                call.resolve(["error": true, "errorMessage": "writeAndRead failed: \(err.localizedDescription)",
                              "bytesSent": bytesSent, "bytesReceived": 0,
                              "data": [], "matched": false])
            }
        }
    }

    @objc func destroyConnection(_ call: CAPPluginCall) {
        if dispatchToMainIfNeeded({ self.destroyConnection(call) }) { return }
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
