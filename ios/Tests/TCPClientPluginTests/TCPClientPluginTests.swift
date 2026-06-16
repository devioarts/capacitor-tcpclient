import XCTest
@testable import TCPClientPlugin

class TCPClientTests: XCTestCase {
    func testCreateDoesNotCrash() {
        let client = TCPClient()
        XCTAssertFalse(client.isConnected())
        XCTAssertFalse(client.isReading())
    }
}
