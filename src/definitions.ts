import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Options for opening a TCP connection.
 *
 * Parity:
 * - Mirrors iOS/Android native options.
 * Defaults:
 * - port: 9100
 * - timeoutMs: 3000
 * - noDelay: true
 * - keepAlive: true
 */
export interface TcpConnectOptions {
  host: string;
  port?: number;        // default 9100
  timeoutMs?: number;   // default 3000
  noDelay?: boolean;    // default true
  keepAlive?: boolean;  // default true
}

/**
 * Payload for raw write operations.
 * `data` can be a JS number[] or Uint8Array; values are interpreted as bytes 0..255.
 */
export interface TcpWriteOptions {
  data: number[] | Uint8Array; // raw bytes
}

/**
 * Request/Response helper: write bytes, then read back with a timeout and optional pattern.
 *
 * Notes:
 * - `expect` can be a byte pattern (number[]) or a hex string (e.g., "1b40").
 * - `timeoutMs` is the overall RR timeout.
 * - `maxBytes` caps the response size.
 * - `suspendStreamDuringRR` pauses the streaming reader during RR to avoid stealing the reply
 *   (native default is **true** on both iOS and Android).
 */
export interface TcpWriteAndReadOptions extends TcpWriteOptions {
  expect?: number[] | string;   // byte pattern or hex string
  timeoutMs?: number;           // default 1000
  maxBytes?: number;            // default 4096
  suspendStreamDuringRR?: boolean; // default true (matches native)
}

/**
 * Options for starting continuous stream reading.
 *
 * Notes:
 * - `readTimeoutMs` is Android-only; on iOS this is a no-op for API parity.
 */
export interface TcpStartReadOptions {
  chunkSize?: number;           // default 4096
  readTimeoutMs?: number;       // Android only; iOS no-op
}

/** Common result shape returned by all methods for predictable error handling. */
export interface BaseResult {
  error: boolean;
  errorMessage: string | null;
}

/** Result for connect(). */
export type TcpConnectResult = BaseResult & {
  connected: boolean;
}

/** Result for write(). */
export type TcpWriteResult = BaseResult & {
  bytesWritten: number;
}

/** Result for writeAndRead(). */
export type TcpWriteAndReadResult = BaseResult & {
  bytesWritten: number;
  bytesRead: number;
  data: number[];
}

/** Result for start/stop read. */
export type TcpStartStopResult = BaseResult & {
  reading: boolean;
}

/** Result for isConnected(). */
export type TcpIsConnectedResult = BaseResult & {
  connected: boolean;
}

/** Result for disconnect(). */
export type TcpDisconnectResult = BaseResult & {
  disconnected: boolean;
}

/** Result for isReading(). */
export type TcpIsReadingResult = BaseResult & {
  reading: boolean;
}

/**
 * Event payloads
 * - `tcpData`: emitted with raw bytes as number[] (0..255)
 * - `tcpDisconnect`: emitted once per disconnect with a reason
 *
 * Note: Android currently also includes `reading:false` in the disconnect payload
 * for UI convenience; that field is optional and may be ignored here.
 */
export type TcpDataEvent = { data: number[] };
export type TcpDisconnectEvent =
  | { disconnected: true; reason: 'manual' }
  | { disconnected: true; reason: 'remote' }
  | { disconnected: true; reason: 'error'; error: string };

/**
 * Public plugin surface exposed to JS/TS consumers.
 *
 * Usage example:
 * ```ts
 * const res = await TCPClient.tcpConnect({ host: '192.168.1.50', port: 9100 });
 * if (!res.error && res.connected) {
 *   await TCPClient.tcpStartRead({ chunkSize: 1024 });
 *   const rr = await TCPClient.tcpWriteAndRead({ data: [0x1b, 0x40], timeoutMs: 500 });
 * }
 * ```
 */
export interface TCPClientPlugin {
  /*
   * TCP
   */
  tcpConnect(options: TcpConnectOptions): Promise<TcpConnectResult>;
  tcpWrite(options: TcpWriteOptions): Promise<TcpWriteResult>;
  tcpWriteAndRead(options: TcpWriteAndReadOptions): Promise<TcpWriteAndReadResult>;
  tcpStartRead(options?: TcpStartReadOptions): Promise<TcpStartStopResult>;
  tcpStopRead(): Promise<TcpStartStopResult>;
  tcpIsConnected(): Promise<TcpIsConnectedResult>;
  tcpDisconnect(): Promise<TcpDisconnectResult>;
  tcpIsReading(): Promise<TcpIsReadingResult>;
  tcpSetReadTimeout(options: { ms: number }): Promise<BaseResult>;

  /*
   * Events
   */
  addListener(eventName: 'tcpData', listenerFunc: (event: TcpDataEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'tcpDisconnect', listenerFunc: (event: TcpDisconnectEvent) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
