# Changelog

## Unreleased

### Fixed

- Hardened iOS socket teardown so manual disconnect wakes in-flight blocking reads and closes DispatchSource-backed file descriptors from the cancel handler.
- Routed iOS plugin entry points back to the main thread before touching plugin connection state.
- Added Android write timeout handling and blocked raw writes while a request/response operation is active.
- Improved Android stream reader start/stop synchronization so cancelled readers do not emit stale chunks after `stopRead()`.
- Moved Android DNS resolution out of the serialized connect section and bounded it by the connect timeout.
- Added Electron write timeout handling, bounded timers, bounded buffer sizes, and stricter disconnected errors for `startRead()`.
- Preserved Electron `setReadTimeout()` defaults even when called before a socket is connected.
- Rejected invalid byte payload values instead of silently masking values outside `0..255`.

### Documentation

- Documented platform timeout behavior, byte validation, buffer limits, and the verification workflow.
