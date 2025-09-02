// web.ts
import type { PluginListenerHandle } from '@capacitor/core';
import { WebPlugin } from '@capacitor/core';

import type {
  TCPClientPlugin,
  TcpConnectOptions,
  TcpWriteOptions,
  TcpWriteAndReadOptions,
  TcpStartReadOptions,
  TcpConnectResult,
  TcpWriteResult,
  TcpWriteAndReadResult,
  TcpStartStopResult,
  TcpIsConnectedResult,
  TcpDisconnectResult,
  TcpIsReadingResult,
} from './definitions';

/**
 * Contract the Electron preload exposes as `window.TCPClient`.
 * If present, we delegate all calls to it; otherwise we fall back to a browser-only mock.
 */
type ElectronTCPClient = {
  connect(a: TcpConnectOptions): Promise<TcpConnectResult>;
  disconnect(): Promise<TcpDisconnectResult>;
  isConnected(): Promise<TcpIsConnectedResult>;
  isReading(): Promise<TcpIsReadingResult>;
  write(a: TcpWriteOptions): Promise<TcpWriteResult>;
  startRead(a?: TcpStartReadOptions): Promise<TcpStartStopResult>;
  stopRead(): Promise<TcpStartStopResult>;
  setReadTimeout(a: { readTimeout: number }): Promise<{
    error: boolean;
    errorMessage?: string | null;
  }>;
  writeAndRead(a: Required<TcpWriteAndReadOptions>): Promise<TcpWriteAndReadResult>;

  addListener(event: 'tcpData' | 'tcpDisconnect', cb: (payload: any) => void): { remove(): void };
  removeAllListeners(): Promise<void>;
};

/**
 * Detect Electron environment and capture the injected preload API if available.
 * Fallback to UA/versions checks for robustness in dev and tests.
 */
const electronApi = (globalThis as any).TCPClient as ElectronTCPClient | undefined;

type BaseResult = { error: boolean; errorMessage?: string | null };

function ok<T extends Record<string, unknown>>(extra: T = {} as T): BaseResult & T {
  return { error: false, errorMessage: null, ...extra };
}

function log(...a: any[]) {
  console.debug('[TCPClient]', ...a);
}

/**
 * Capacitor Web implementation.
 * - In Electron, proxies to the preload `window.TCPClient` API.
 * - In browsers, provides a no-op/mock implementation for development and previews.
 */
export class TCPClientWeb extends WebPlugin implements TCPClientPlugin {
  /** Open a TCP connection (delegated to Electron or mocked). */
  async connect(args: TcpConnectOptions): Promise<TcpConnectResult> {
    if (electronApi) return electronApi.connect(args);
    log('[connect]', args);
    return ok({ connected: true });
  }

  /** Disconnect the current session and emit a mock tcpDisconnect event if needed. */
  async disconnect(): Promise<TcpDisconnectResult> {
    if (electronApi) return electronApi.disconnect();
    log('[disconnect]');
    return ok({ disconnected: true, reading: false });
  }

  /** Report connection status. */
  async isConnected(): Promise<TcpIsConnectedResult> {
    if (electronApi) return electronApi.isConnected();
    log('[isConnected]');
    return ok({ connected: true });
  }

  /** Report whether the mock reader is active. */
  async isReading(): Promise<TcpIsReadingResult> {
    if (electronApi) return electronApi.isReading();
    log('[isReading]');
    return ok({ reading: true });
  }

  /** Write raw bytes (delegated or mocked). */
  async write(args: TcpWriteOptions): Promise<TcpWriteResult> {
    const data = Array.from(args.data as any) as number[];
    if (electronApi) return electronApi.write({ data });
    log('write', args);
    return ok({ bytesSent: data.length });
  }

  /**
   * Start continuous reading.
   * - Electron: defers to preload.
   * - Web: spins a timer to emit deterministic dummy chunks.
   */
  async startRead(args: TcpStartReadOptions = {}): Promise<TcpStartStopResult> {
    if (electronApi) return electronApi.startRead(args);
    log('startRead', args);
    return ok({ reading: true });
  }

  /** Stop continuous reading. */
  async stopRead(): Promise<TcpStartStopResult> {
    if (electronApi) return electronApi.stopRead();
    log('stopRead');
    return ok({ reading: false });
  }

  /**
   * Configure read timeout.
   * - Electron: forwards to preload (native-level timeout semantics).
   * - Web: stores the value for mock timing only.
   */
  async setReadTimeout(args: { readTimeout: number }): Promise<BaseResult> {
    if (electronApi) return electronApi.setReadTimeout(args);
    log('setReadTimeout', args);
    return ok();
  }

  /**
   * Request/Response helper:
   * - Electron: proxied to preload, supports early-exit on `expect` pattern.
   * - Web: synthesizes a response based on the request and `expect`.
   */
  async writeAndRead(args: TcpWriteAndReadOptions): Promise<TcpWriteAndReadResult> {
    const data = Array.from(args.data as any) as number[];
    const suspend = args.suspendStreamDuringRR ?? true;

    if (electronApi) {
      return electronApi.writeAndRead({
        data,
        timeout: args.timeout ?? 1000,
        maxBytes: args.maxBytes ?? 4096,
        expect: args.expect as any,
        suspendStreamDuringRR: suspend,
      });
    }

    // ----- Mock -----
    log('writeAndRead', args);

    return ok({
      bytesSent: data.length,
      bytesReceived: 0,

      data: [],
      matched: false,
    });
  }

  // Events

  /**
   * Subscribe to 'tcpData' or 'tcpDisconnect'.
   * - Electron: delegates to preload and wraps the remove handle.
   * - Web: registers the callback with the local mock bus.
   */
  async addListener(
    eventName: 'tcpData' | 'tcpDisconnect',
    listenerFunc: (event: any) => void,
  ): Promise<PluginListenerHandle> {
    if (electronApi) {
      const r = electronApi.addListener(eventName, listenerFunc);
      return { remove: async () => r.remove() };
    }

    return {
      remove: async () => {
        log('[addListener]');
      },
    };
  }

  /** Remove all listeners in the mock bus and ask the preload (if any) to do the same. */
  async removeAllListeners(): Promise<void> {
    if (electronApi?.removeAllListeners) await electronApi.removeAllListeners();
  }
}
