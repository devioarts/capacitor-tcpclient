# Behavior and FAQ

This page documents runtime behavior that matters when building TCP workflows.

## Platform Behavior

- Android, iOS and Electron provide real TCP sockets.
- The web implementation is a development stub with the same API shape, but no
  real TCP transport.
- Plain TCP is supported. TLS is not built in. Use an external TLS terminator if
  your deployment requires TLS.

## Defaults

| Setting | Default |
| --- | --- |
| Port | `9100` |
| Connect timeout | `3000 ms` |
| Stream chunk size | `4096 bytes` |
| Request/response timeout | `1000 ms` |
| Request/response max bytes | `4096 bytes` |
| `noDelay` | `true` |
| `keepAlive` | `true` |
| `suspendStreamDuringRR` | `true` |

Native and Electron implementations clamp stream chunks and request/response
buffers to 16 MiB. Android also enforces a shared native buffer budget across
connections.

## Request / Response Reads

`writeAndRead()` sends bytes and waits for a reply.

- Without `expect`, the operation returns after a short adaptive idle window
  of roughly 100-200 ms. This helps collect fragmented replies.
- With `expect`, the operation returns on the first match.
- If `expect` is set and timeout expires after some data arrived, the result is
  successful with `matched: false`.
- If no data arrived before timeout, the result is a timeout error.
- Empty `expect` values (`""`, `[]`, empty `Uint8Array`) are treated as if
  `expect` was omitted.

## Timeouts

- `connect.timeout` is the total DNS plus socket connect budget on
  Android/iOS/Electron.
- `write()` has a native write watchdog.
- `writeAndRead.timeout` covers both sending and receiving for that operation.
- A write timeout reports `bytesSent: 0`.
- A read timeout after the request was written reports `bytesSent` as the
  request length.
- `disconnect()` resolves after native teardown finishes.
- The JavaScript wrapper has a 30 second lifecycle watchdog for disconnect and
  destroy cleanup.

## Streaming

`startRead()` begins continuous reads and emits `tcpData` events.

- Native/Electron stream data is micro-batched every 10 ms or 16 KB.
- On Android/iOS, `chunkSize` controls each native socket read before batching.
- On Electron, the merged batch is split by `chunkSize` before it is sent to the
  web layer.
- Register listeners before `startRead()` to avoid missing early data.

## Connectivity Checks

`isConnected()` behaves slightly differently by platform:

- Android/iOS perform an active EOF check when no stream or request/response read
  is active. They may emit `tcpDisconnect` when a remote close is detected.
- Electron performs a fast local socket-state check.
- The web stub returns a mock connected state.

## Errors

`errorMessage` is diagnostic text and may vary by platform and OS version. Treat
it as logging or UI text, not as a stable machine-readable error code.

## FAQ

### Why does request/response read until idle without `expect`?

Many TCP devices reply in fragments. The short idle window avoids returning only
the first fragment.

### Why can `expect` timeout return success?

If data arrived but the expected pattern was not found, the plugin returns that
partial reply with `matched: false` so your app can decide what to do with it.

### What does an empty `expect` mean?

`""`, `[]` and an empty `Uint8Array` are treated the same as omitting `expect`.
The operation uses idle-based request/response mode.

### Why does `readTimeout` behave differently per platform?

Android uses `SO_TIMEOUT` for the blocking stream reader. iOS uses evented reads,
so stream `readTimeout` is a no-op. Electron uses it as the per-connection
default timeout for `writeAndRead`; the stream reader itself remains event-driven.

### Why are byte values strict?

Silent masking can turn invalid input into different bytes. The plugin rejects
invalid values so protocol mistakes fail close to the caller.

### Why did my stream listener receive no data?

Check that the listener was registered before `startRead()`, that the remote
side is actually sending bytes and that another operation is not consuming the
reply. For command/reply protocols, prefer `writeAndRead()`.

### Why does Electron only send events to one window?

The built-in Electron bridge sends events to the last `WebContents` that
registered a TCP event listener. Multi-window apps should route events in the
main process and fan them out intentionally.
