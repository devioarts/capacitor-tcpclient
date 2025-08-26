import Foundation

@objc public class TCPClient: NSObject {
    @objc public func echo(_ value: String) -> String {
        print(value)
        return value
    }
}
