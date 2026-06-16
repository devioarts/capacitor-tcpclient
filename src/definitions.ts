import type { PluginListenerHandle } from '@capacitor/core';

/*
 * Capacitor TCP client — public TypeScript API surface.
 *
 * Key concepts:
 * - Multi-connection model: each TCPClient.createConnection() call returns an isolated
 *   TCPConnection instance with its own socket, listener set, and lifecycle.
 * - If the same connectionId is passed to createConnection() more than once, the existing
 *   instance is returned from the registry (no new socket is opened).
 * - Two data paths per connection:
 *   1) Stream reader (startRead/stopRead) that emits tcpData events.
 *   2) Request/Response (writeAndRead) with timeout, optional byte-pattern matching, and a cap.
 * - Event micro-batching: native/Electron platforms buffer short bursts and flush every ~10ms
 *   or when ~16KB accumulates. Each event carries connectionId so the JS layer can route it.
 * - Defaults: port=9100, connect timeout=3000ms, stream chunkSize=4096 bytes,
 *   RR timeout=1000ms, RR maxBytes=4096, TCP_NODELAY=true, SO_KEEPALIVE=true.
 */

/* ====== Connect ====== */

export interface TcpConnectOptions {
  /** Hostname or IP address. Required (either here or in createConnection). */
  host: string;
  /** TCP port, default 9100. Valid range 1..65535. */
  port?: number;
  /** Connect timeout in milliseconds, default 3000. */
  timeout?: number;
  /** Enable TCP_NODELAY (Nagle off). Default true. */
  noDelay?: boolean;
  /** Enable SO_KEEPALIVE. Default true. */
  keepAlive?: boolean;
}

export interface TcpConnectResult {
  error: boolean;
  errorMessage?: string | null;
  connected: boolean;
}

/* ====== Disconnect / Status ====== */

export interface TcpDisconnectResult {
  error: boolean;
  errorMessage?: string | null;
  disconnected: boolean;
  reading: boolean;
}

export interface TcpIsConnectedResult {
  error: boolean;
  errorMessage?: string | null;
  connected: boolean;
}

export interface TcpIsReadingResult {
  error: boolean;
  errorMessage?: string | null;
  reading: boolean;
}

/* ====== Stream (reader) ====== */

export interface TcpStartReadOptions {
  /**
   * Stream read chunk size in bytes. Default 4096.
   * - Android/iOS: size of each native socket read before bridge micro-batching.
   * - Electron: maximum bytes per emitted tcpData event after micro-batching.
   */
  chunkSize?: number;
  /**
   * Stream read timeout in ms.
   * - Android: sets `SO_TIMEOUT` for the continuous reader.
   * - iOS: no-op.
   * - Electron: updates the per-connection default `writeAndRead` timeout; the stream reader
   *   itself remains event-driven.
   */
  readTimeout?: number;
}

export interface TcpStartStopResult {
  error: boolean;
  errorMessage?: string | null;
  reading: boolean;
}

/* ====== Write (raw) ====== */

export interface TcpWriteOptions {
  data: number[] | Uint8Array;
}

export interface TcpWriteResult {
  error: boolean;
  errorMessage?: string | null;
  bytesSent: number;
}

/* ====== Write & Read (RR) ====== */

export interface TcpWriteAndReadOptions {
  data: number[] | Uint8Array;
  /** RR timeout in ms. Default 1000. */
  timeout?: number;
  /** Maximum bytes to accumulate. Default 4096. */
  maxBytes?: number;
  /**
   * Optional pattern — reading stops when found.
   * Accepts number[] / Uint8Array or hex string (e.g. "1B40", "0x1b 0x40").
   */
  expect?: number[] | Uint8Array | string;
  /** Suspend stream reader during RR to avoid consuming reply. Default true. */
  suspendStreamDuringRR?: boolean;
}

export interface TcpWriteAndReadResult {
  error: boolean;
  errorMessage?: string | null;
  bytesSent: number;
  bytesReceived: number;
  data: number[];
  matched: boolean;
}

/* ====== Events ====== */

/** Emitted by the stream reader. connectionId identifies which connection sent the data. */
export interface TcpDataEvent {
  connectionId: string;
  data: number[];
}

/** Emitted when a connection closes. */
export interface TcpDisconnectEvent {
  connectionId: string;
  disconnected: true;
  reading: boolean;
  reason: 'manual' | 'remote' | 'error';
  error?: string;
}

/* ====== Multi-instance ====== */

/**
 * Options for TCPClient.createConnection().
 * All fields are optional. host/port and other connect options set here become
 * defaults for every connect() call on the returned instance.
 */
export interface TcpCreateConnectionOptions extends Partial<TcpConnectOptions> {
  /**
   * Optional stable identifier for this connection.
   * If an instance with this id already exists in the registry, it is returned as-is.
   * Omit to get a new instance with a generated UUID each time.
   */
  connectionId?: string;
}

/**
 * A single TCP connection instance returned by TCPClient.createConnection().
 * Each instance has its own socket, event listeners, and lifecycle.
 */
export interface TCPConnection {
  readonly connectionId: string;

  /**
   * Open the socket. Options are merged with the defaults supplied in createConnection().
   * host must be present either in createConnection() or here.
   */
  connect(options?: Partial<TcpConnectOptions>): Promise<TcpConnectResult>;

  /** Close the socket. Idempotent. Emits tcpDisconnect(reason: manual). */
  disconnect(): Promise<TcpDisconnectResult>;

  isConnected(): Promise<TcpIsConnectedResult>;
  isReading(): Promise<TcpIsReadingResult>;

  write(options: TcpWriteOptions): Promise<TcpWriteResult>;
  writeAndRead(options: TcpWriteAndReadOptions): Promise<TcpWriteAndReadResult>;

  startRead(options?: TcpStartReadOptions): Promise<TcpStartStopResult>;
  stopRead(): Promise<TcpStartStopResult>;

  /**
   * Configure stream read timeout.
   * - Android: sets `SO_TIMEOUT` on the continuous reader socket (applies during `startRead`).
   * - iOS: no-op (evented I/O, no blocking timeout).
   * - Electron: sets the default `timeout` value used by `writeAndRead` when no explicit timeout is passed.
   */
  setReadTimeout(options: { readTimeout: number }): Promise<{ error: boolean; errorMessage?: string | null }>;

  /** Subscribe to stream data. Only events for this connectionId are delivered. */
  addListener(eventName: 'tcpData', listenerFunc: (event: TcpDataEvent) => void): Promise<PluginListenerHandle>;

  /** Subscribe to disconnect notifications for this connection. */
  addListener(
    eventName: 'tcpDisconnect',
    listenerFunc: (event: TcpDisconnectEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Remove all listeners registered through this instance. */
  removeAllListeners(): Promise<void>;

  /** Disconnect, remove all listeners, and release this instance from the registry. */
  destroy(): Promise<void>;
}

/* ====== Platform ====== */

export type TcpPlatform = 'ios' | 'android' | 'web' | 'electron';

export interface TcpGetPlatformResult {
  error: boolean;
  errorMessage?: string | null;
  platform: TcpPlatform;
}

/* ====== Plugin surface ====== */

export interface TCPClientPlugin {
  /**
   * Create (or retrieve) a TCP connection instance.
   *
   * - Without connectionId: always creates a new instance with a generated UUID.
   * - With connectionId: returns the existing instance if one was already created,
   *   otherwise creates a new one.
   * - host/port/timeout/noDelay/keepAlive supplied here become defaults for connect().
   */
  createConnection(options?: TcpCreateConnectionOptions): TCPConnection;

  /** Returns the platform identifier of the implementation answering calls. */
  getPlatform(): Promise<TcpGetPlatformResult>;
}
