import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Capacitor TCP client — public TypeScript API surface.
 *
 * This type file documents the strict, stable names used by the plugin across
 * Android (Kotlin/Socket), iOS (Swift/POSIX), and Electron (Node.js net.Socket).
 * There are no legacy aliases and no interface inheritance to keep the surface
 * flat and explicit.
 *
 * Key concepts and behavior (derived from native/electron sources):
 * - Single connection model per plugin instance. Methods operate on that socket.
 * - Two data paths:
 *   1) Stream reader (startRead/stopRead) that emits tcpData events.
 *   2) Request/Response (writeAndRead) that writes a request and reads a reply
 *      with timeout, optional byte-pattern matching, and a configurable cap.
 * - Event micro-batching: platforms buffer short bursts and flush every ~10ms or
 *   when ~16KB accumulates, to reduce event overhead. Android & iOS do this
 *   explicitly; Electron mimics it and also splits flushed batches into
 *   up-to-chunkSize slices to preserve consumer expectations.
 * - Defaults: port=9100, connect timeout=3000ms, stream chunkSize=4096 bytes,
 *   RR timeout=1000ms, RR maxBytes=4096, TCP_NODELAY=true, SO_KEEPALIVE=true.
 * - Platform notes:
 *   • Android applies socket SO_TIMEOUT to the stream when reading and respects
 *     setReadTimeout(). isConnected() performs a non-destructive 1-byte peek
 *     unless streaming or RR are active (to avoid disturbing input).
 *   • iOS implements non-blocking POSIX sockets with DispatchSourceRead. The
 *     setReadTimeout() call is a no-op for parity (stream uses non-blocking +
 *     source-driven I/O). RR uses its own deadline logic.
 *   • Electron uses Node's net.Socket. Read timeout is not applied to the
 *     stream; it affects RR timeouts. Stream events are micro-batched in the
 *     main process and forwarded to the renderer via IPC.
 * - Error policy for writeAndRead(): if any bytes arrive before the deadline,
 *   the call resolves successfully with matched=false (even if expect is not
 *   provided). If no bytes arrive by the deadline, the call rejects with a
 *   timeout error. When a timeout happens after the request is written, bytesSent
 *   reports the full request length; on other errors it reports 0.
 */

/* ====== Connect ====== */

/**
 * Connection parameters for opening a TCP socket.
 *
 * Notes by platform:
 * - Android: validates port range (1..65535); applies TCP_NODELAY and SO_KEEPALIVE
 *   according to the flags. Connect timeout is enforced by Socket#connect.
 * - iOS: sets TCP_NODELAY, SO_KEEPALIVE and SO_NOSIGPIPE. Connect timeout is
 *   enforced using non-blocking connect + polling.
 * - Electron: sets noDelay and keepAlive (with 60s initial delay). Connect
 *   timeout is emulated via a JS timer that destroys the socket if elapsed.
 */
export interface TcpConnectOptions {
  /** Hostname or IP address to connect to. Required. */
  host: string;
  /** TCP port, defaults to 9100. Valid range 1..65535 (validated on Android). */
  port?: number; // default 9100
  /** Connect timeout in milliseconds, defaults to 3000. */
  timeout?: number; // ms, default 3000
  /** Enable TCP_NODELAY (Nagle off). Defaults to true. */
  noDelay?: boolean; // TCP_NODELAY (default true)
  /** Enable SO_KEEPALIVE. Defaults to true. */
  keepAlive?: boolean; // SO_KEEPALIVE (default true)
}

/**
 * Result of connect().
 * - connected=true on success; false on failure.
 * - error=true with errorMessage on failure (e.g., "connect timeout",
 *   "connect failed: ...").
 */
export interface TcpConnectResult {
  error: boolean;
  errorMessage?: string | null;
  connected: boolean;
}

/* ====== Disconnect / Status ====== */

/**
 * Result of disconnect(). Always resolves. After disconnect, reading is false.
 * A tcpDisconnect event with reason 'manual' is also emitted by platforms.
 */
export interface TcpDisconnectResult {
  error: boolean;
  errorMessage?: string | null;
  /** True if the instance transitioned to disconnected state. */
  disconnected: boolean;
  /** Whether the stream reader is active (always false after disconnect). */
  reading: boolean;
}

/**
 * Result of isConnected().
 * - Android performs a safe 1-byte peek unless streaming/RR is active, in which
 *   case it returns true if those are active to avoid consuming input.
 * - iOS/Electron return based on current socket open/close state.
 */
export interface TcpIsConnectedResult {
  error: boolean;
  errorMessage?: string | null;
  connected: boolean;
}

/** Result of isReading(). True if stream reader is active. */
export interface TcpIsReadingResult {
  error: boolean;
  errorMessage?: string | null;
  reading: boolean;
}

/* ====== Stream (reader) ====== */

/**
 * Options for startRead().
 * - chunkSize controls maximum size of a single tcpData event slice. Native
 *   implementations may micro-batch multiple small reads; Electron additionally
 *   splits a flushed batch into slices up to chunkSize to preserve consumer
 *   expectations.
 * - readTimeout applies only on Android (socket SO_TIMEOUT while streaming). It
 *   is a no-op on iOS. Electron stores it for RR but does not apply to stream.
 */
export interface TcpStartReadOptions {
  /** Maximum bytes per emitted tcpData event. Default 4096. */
  chunkSize?: number; // default 4096
  /** Stream read timeout (ms). Android: applies SO_TIMEOUT; iOS: no-op. */
  readTimeout?: number; // ms; Android applies SO_TIMEOUT; iOS: no-op
}

/** Result of startRead()/stopRead(). */
export interface TcpStartStopResult {
  error: boolean;
  errorMessage?: string | null;
  /** Whether the stream reader is currently active. */
  reading: boolean;
}

/* ====== Write (raw) ====== */

/** Bytes to write to the socket verbatim. Accepts number[] or Uint8Array. */
export interface TcpWriteOptions {
  data: number[] | Uint8Array;
}

/**
 * Result of write().
 * - bytesSent equals the request length on success; 0 on failure.
 * - Fails with error=true if not connected or busy (RR in progress on some
 *   platforms).
 */
export interface TcpWriteResult {
  error: boolean;
  errorMessage?: string | null;
  bytesSent: number;
}

/* ====== Write & Read (RR) ====== */

/**
 * Options for writeAndRead() request/response operation.
 *
 * Behavior summary (parity across Android/iOS/Electron):
 * - The request is written atomically with internal serialization (no interleaved
 *   writes across concurrent calls).
 * - Response collection ends when ANY of these happens:
 *   • expect pattern is found (matched=true), or
 *   • maxBytes cap is reached, or
 *   • without expect: adaptive "until-idle" period elapses after last data, or
 *   • absolute timeout elapses (see errors below).
 * - On timeout:
 *   • If no data arrived at all, the call fails with error=true and
 *     errorMessage resembling "connect timeout" and bytesSent equals the request
 *     length on Android/iOS/Electron; bytesReceived=0, matched=false.
 *   • If some data arrived before the deadline, the call resolves successfully
 *     with matched=false and returns the partial data.
 * - suspendStreamDuringRR: when true, the active stream reader is temporarily
 *   stopped for the RR window to avoid racing over the same bytes; after RR it
 *   is resumed with the previous chunk size. Default is true on Android & iOS;
 *   Electron treats it as true by default as well.
 * - expect: hex string like "0A0B0C" (case/spacing ignored) or a byte array.
 */
export interface TcpWriteAndReadOptions {
  /** Request payload to send. */
  data: number[] | Uint8Array;
  /** Absolute RR timeout in ms. Defaults to 1000. */
  timeout?: number; // ms, default 1000
  /** Maximum number of bytes to accumulate and return. Defaults to 4096. */
  maxBytes?: number; // default 4096
  /**
   * Optional expected pattern. When provided, reading stops as soon as the
   * accumulated buffer contains this pattern. Accepts:
   * - number[] / Uint8Array: raw byte sequence
   * - string: hex bytes (e.g., "0x1b40", "1B 40"), spacing and case ignored
   */
  expect?: number[] | Uint8Array | string; // hex string or byte pattern
  /**
   * Temporarily suspend the stream reader during RR to avoid consuming reply in
   * the stream. Defaults to true (Android default true; iOS behaves as if true;
   * Electron defaults to true as well).
   */
  suspendStreamDuringRR?: boolean; // default true on Android; iOS behaves as if true
}

/**
 * Result of writeAndRead().
 * - bytesSent is the number of request bytes written. If the operation fails
 *   due to a pure timeout (no bytes received), bytesSent can still equal the
 *   request length; for other errors it is 0.
 * - bytesReceived is the length of returned data (<= maxBytes).
 * - matched indicates whether the expect pattern (if any) was found.
 */
export interface TcpWriteAndReadResult {
  error: boolean;
  errorMessage?: string | null;
  bytesSent: number;
  bytesReceived: number;
  /** Received bytes (may be partial if timeout after some data). */
  data: number[]; // received bytes
  /** True if the expect pattern was matched; false otherwise. */
  matched: boolean;
}

/* ====== Events ====== */

/**
 * Emitted by the stream reader with micro-batched data chunks.
 * - Data values are 0..255. The plugin may coalesce multiple small reads and
 *   then emit one or more events capped by chunkSize.
 */
export interface TcpDataEvent {
  data: number[]; // chunk bytes (0..255)
}

/**
 * Emitted when the socket is closed or the plugin disconnects it.
 * - reason:
 *   • 'manual' — disconnect() called or instance disposed.
 *   • 'remote' — the peer closed the connection (EOF).
 *   • 'error'  — an I/O error occurred; error contains a message.
 * - reading is false when this event fires.
 */
export interface TcpDisconnectEvent {
  disconnected: true;
  reading: boolean;
  reason: 'manual' | 'remote' | 'error';
  error?: string;
}

/* ====== Plugin surface ====== */

export interface TCPClientPlugin {
  /** Open a TCP connection. */
  connect(options: TcpConnectOptions): Promise<TcpConnectResult>;
  /** Close the TCP connection. Idempotent. Triggers tcpDisconnect(manual). */
  disconnect(): Promise<TcpDisconnectResult>;

  /** Check whether the socket is connected. */
  isConnected(): Promise<TcpIsConnectedResult>;
  /** Check whether the stream reader is active. */
  isReading(): Promise<TcpIsReadingResult>;

  /** Write raw bytes. */
  write(options: TcpWriteOptions): Promise<TcpWriteResult>;
  /** Write request, then read reply under the given constraints. */
  writeAndRead(options: TcpWriteAndReadOptions): Promise<TcpWriteAndReadResult>;

  /** Start emitting tcpData events. Safe to call multiple times. */
  startRead(options?: TcpStartReadOptions): Promise<TcpStartStopResult>;
  /** Stop emitting tcpData events. Safe to call multiple times. */
  stopRead(): Promise<TcpStartStopResult>;

  /**
   * Configure stream read timeout (Android only). iOS: no-op; Electron: stored
   * for RR defaults. Provided for API parity across platforms.
   */
  setReadTimeout(options: { readTimeout: number }): Promise<{
    error: boolean;
    errorMessage?: string | null;
  }>;

  /** Subscribe to micro-batched stream data events. */
  addListener(eventName: 'tcpData', listenerFunc: (event: TcpDataEvent) => void): Promise<PluginListenerHandle>;

  /** Subscribe to disconnect notifications. */
  addListener(
    eventName: 'tcpDisconnect',
    listenerFunc: (event: TcpDisconnectEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Remove all tcpData/tcpDisconnect listeners. */
  removeAllListeners(): Promise<void>;
}
