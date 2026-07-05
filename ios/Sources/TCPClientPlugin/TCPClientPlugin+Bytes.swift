import Foundation
import Capacitor

extension TCPClientPlugin {
    /// Build an optional byte-pattern matcher from the "expect" call parameter.
    func buildMatcher(_ call: CAPPluginCall) throws -> ((Data) -> Bool)? {
        if let hexStr = call.getString("expect") {
            return try matcherFromHex(hexStr)
        }
        if let arr = call.getArray("expect", UInt.self) {
            return try matcherFromArray(arr)
        }
        if let obj = call.getObject("expect"), let bytes = bytesFromObject(obj) {
            return matcherFromBytes(bytes)
        }
        if hasPresentOption(call, "expect") {
            throw invalidExpectError("invalid expect (hex or byte array expected)")
        }
        return nil
    }

    /// Extract bytes from "data" field; accepts number[] or Uint8Array object.
    func extractBytes(_ call: CAPPluginCall) -> [UInt8]? {
        if let arr = call.getArray("data", UInt.self) { return bytesFromArray(arr) }
        if let obj = call.getObject("data") { return bytesFromObject(obj) }
        return nil
    }

    func bytesFromObject(_ obj: JSObject) -> [UInt8]? {
        let len = objectByteLength(obj)
        guard len >= 0 else { return nil }

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

    private func matcherFromHex(_ hexStr: String) throws -> ((Data) -> Bool)? {
        if hexStr.isEmpty { return nil }
        let clean = String(hexStr.lowercased().replacingOccurrences(of: "0x", with: "").filter { !$0.isWhitespace })
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
        return matcherFromBytes(Array(pattern))
    }

    private func matcherFromArray(_ arr: [UInt]) throws -> ((Data) -> Bool) {
        guard let bytes = bytesFromArray(arr) else { throw invalidExpectError("invalid expect (number[])") }
        return matcherFromBytes(bytes)
    }

    private func matcherFromBytes(_ bytes: [UInt8]) -> ((Data) -> Bool) {
        let pattern = Data(bytes)
        return { buf in buf.range(of: pattern) != nil }
    }

    private func invalidExpectError(_ message: String) -> NSError {
        NSError(domain: "TCPClientPlugin", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func bytesFromArray(_ arr: [UInt]) -> [UInt8]? {
        guard arr.allSatisfy({ $0 <= UInt(UInt8.max) }) else { return nil }
        return arr.map { UInt8($0) }
    }

    private func objectByteLength(_ obj: JSObject) -> Int {
        if let explicitLen = obj["length"] {
            return (explicitLen as? NSNumber)?.intValue ?? explicitLen as? Int ?? -1
        }
        return (obj.keys.compactMap { Int($0) }.max() ?? -1) + 1
    }

    private func byteValue(_ value: Any?) -> UInt8? {
        guard let value = value, !(value is NSNull) else { return nil }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
            return byteFromDouble(number.doubleValue)
        }
        if let intValue = value as? Int { return byteFromInt(intValue) }
        if let uintValue = value as? UInt, uintValue <= UInt(UInt8.max) { return UInt8(uintValue) }
        if let doubleValue = value as? Double { return byteFromDouble(doubleValue) }
        return nil
    }

    private func byteFromDouble(_ value: Double) -> UInt8? {
        guard value.isFinite, value.rounded(.towardZero) == value else { return nil }
        return byteFromInt(Int(value))
    }

    private func byteFromInt(_ value: Int) -> UInt8? {
        guard value >= 0, value <= Int(UInt8.max) else { return nil }
        return UInt8(value)
    }
}
