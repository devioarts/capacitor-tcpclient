# Changelog

## Unreleased

### Fixed

- Hardened iOS socket teardown so manual disconnect reads socket state on the serial queue, wakes in-flight blocking reads, and closes DispatchSource-backed file descriptors from the cancel handler.
- Serialized iOS `deinit` teardown through the client queue and made `isConnected()` safe when called from that queue.
- Bounded iOS DNS resolution by the connect timeout and kept the socket connect phase inside the same total timeout budget.
- Restored the iOS stream reader before resolving `writeAndRead()` promises when RR temporarily suspended streaming.
- Added iOS byte payload length checks before reserving array capacity and normalized empty byte-array `expect` values to "no expect".
- Improved iOS POSIX error messages by consistently including `strerror` details.
- Routed iOS plugin entry points back to the main thread before touching plugin connection state.
- Added Android write timeout handling, blocked raw writes while a request/response operation is active, and made write watchdogs close the exact socket being written.
- Protected Android `writeAndRead()` against reconnect/disconnect races by operating on a captured socket generation.
- Improved Android stream reader start/stop synchronization so cancelled readers do not emit stale chunks after `stopRead()` and readers do not capture stale streams across reconnect.
- Made Android `disconnect()` resolve only after native teardown completes.
- Made Android dispose non-blocking for the caller and able to close an in-flight connecting socket so lifecycle teardown cannot leave pending callbacks hanging.
- Moved Android DNS resolution out of the serialized connect section and kept DNS plus socket connect inside one timeout budget.
- Added Android payload length checks and a shared native read/RR buffer budget across connections.
- Normalized Android empty byte-array/object `expect` values to "no expect" and returned `errorMessage: null` consistently on successful `write()`.
- Added Electron write timeout handling, bounded timers, bounded buffer sizes, and stricter disconnected errors for `startRead()`.
- Isolated Electron events by `connectionId` so listener cleanup for one connection cannot suppress another connection in the same window.
- Added an Electron shared I/O in-flight guard so `write()` and `writeAndRead()` cannot interleave on the same socket.
- Preserved Electron `setReadTimeout()` defaults before connect without creating an orphan socket state entry.
- Preserved Electron socket error details for transient write/RR close handlers and trimmed incoming RR chunks before exceeding `maxBytes`.
- Made JS `destroy()` release the registry and call native destroy even if listener cleanup rejects, with a lifecycle watchdog for disconnect/destroy calls.
- Rejected invalid byte payload values instead of silently masking values outside `0..255`.

### Tests

- Added TypeScript unit tests for `expect` parsing edge cases, including empty patterns and invalid byte values.
- Added a TypeScript regression check that Electron byte payload length validation stays before buffer allocation.
- Added Electron loopback TCP tests for fragmented RR responses, until-idle reads, remote close after data, stream batching, read timeouts, `maxBytes`, and busy guards.
- Added Android JVM unit tests for hex parsing, byte validation, pattern matching, and huge object length rejection.
- Added Android loopback TCP tests for real connect/write/RR/stream behavior, remote close handling, read timeouts, `maxBytes`, and busy guards.
- Added iOS XCTest loopback TCP tests for real connect/write/RR/stream behavior, remote close handling, read timeouts, `maxBytes`, and busy guards.
- Added Android lifecycle JVM tests for dispose callback completion and connect-after-dispose behavior.
- Added GitHub Actions CI jobs for TypeScript/web build, Android unit tests/build, and iOS build/XCTest.
- Added an MIT `LICENSE` file to match package metadata.

### Documentation

- Documented platform timeout behavior, byte validation, empty `expect` behavior, buffer limits, Electron event isolation, lifecycle cleanup behavior, and the verification workflow.
