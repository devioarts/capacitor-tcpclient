// web.ts
import type { PluginListenerHandle } from '@capacitor/core';
import { WebPlugin } from '@capacitor/core';

import type {
  TCPClientPlugin,
  TcpConnectOptions,
  TcpWriteOptions,
  TcpWriteAndReadOptions,
  TcpStartReadOptions,
  BaseResult,
  TcpConnectResult,
  TcpWriteResult,
  TcpWriteAndReadResult,
  TcpStartStopResult,
  TcpIsConnectedResult,
  TcpDisconnectResult,
  TcpIsReadingResult} from './definitions';
import { parseExpectBytes  } from './utils/expect';
import type {ExpectInput} from './utils/expect';

/**
 * Shape of the remove handle returned by addListener in the Electron preload API.
 */
type Remove = { remove: () => void };

/** Supported 'expect' value types for RR helper (hex string or byte array). */
type ExpectType = ExpectInput;

/**
 * Contract the Electron preload exposes as `window.TCPClient`.
 * If present, we delegate all calls to it; otherwise we fall back to a browser-only mock.
 */
type ElectronTCPClient = {
  requestLocalNetworkPermission(): Promise<BaseResult>;

  tcpConnect(a: TcpConnectOptions): Promise<TcpConnectResult>;
  tcpDisconnect(): Promise<TcpDisconnectResult>;
  tcpIsConnected(): Promise<TcpIsConnectedResult>;
  tcpIsReading(): Promise<TcpIsReadingResult>;
  tcpWrite(a: TcpWriteOptions): Promise<TcpWriteResult>;
  tcpStartRead(a?: TcpStartReadOptions): Promise<TcpStartStopResult>;
  tcpStopRead(): Promise<TcpStartStopResult>;
  tcpSetReadTimeout(a: { ms: number }): Promise<BaseResult>;
  tcpWriteAndRead(a: Required<TcpWriteAndReadOptions>): Promise<TcpWriteAndReadResult>;

  addListener(event: 'tcpData' | 'tcpDisconnect', cb: (payload: any) => void): { remove(): void };
  removeAllListeners(): Promise<void>;
};

/**
 * Detect Electron environment and capture the injected preload API if available.
 * Fallback to UA/versions checks for robustness in dev and tests.
 */
const electronApi = (globalThis as any).TCPClient as ElectronTCPClient | undefined;
const isElectron =
  !!electronApi ||
  (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)) ||
  (typeof (globalThis as any).process !== 'undefined' &&
    (globalThis as any).process.versions?.electron);

// ---------------- utils (mock) ----------------
/**
 * Small helpers to standardize results in the mock path.
 */
function ok<T extends Record<string, unknown>>(extra: T = {} as T): BaseResult & T {
  return { error: false, errorMessage: null, ...extra };
}
function fail<T extends Record<string, unknown>>(message: string, extra: T = {} as T): BaseResult & T {
  return { error: true, errorMessage: message, ...extra };
}

// =======================
// Mock impl (mimo Electron)
// =======================
// In pure web (non-Electron) we provide a minimal simulation of the API so apps can run
// without crashing. It does not perform real TCP; it emits deterministic dummy data.
const mock = {
  connected: false,
  reading: false,
  lastWrite: [] as number[] | null,
  readTimer: 0 as any,
  readTimeoutMs: 1000,
  chunkSize: 4096,
};

/** Simple event bus for the mock path. */
const listeners = new Map<string, Set<(p: any) => void>>();
function on(event: string, cb: (p: any) => void): Remove {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(cb);
  return { remove: () => set?.delete(cb) };
}
function emit(event: 'tcpData' | 'tcpDisconnect', payload: any) {
  const set = listeners.get(event);
  if (!set) return;
  set.forEach((cb) => { try { cb(payload); } catch {
    // ignore
  } });
}

/**
 * Start the mock reader: periodically emits a tcpData event with either the last write
 * truncated to chunk size, or a small dummy payload.
 */
function mockStartRead(chunkSize: number) {
  if (mock.readTimer) return;
  mock.chunkSize = Math.max(1, chunkSize);
  mock.reading = true;
  mock.readTimer = setInterval(() => {
    if (!mock.connected) return;
    const payload = mock.lastWrite?.length
      ? mock.lastWrite.slice(0, mock.chunkSize)
      : [0x10, 0x00]; // dummy
    emit('tcpData', { data: payload });
  }, 400);
}
/** Stop the mock reader and clear its timer. */
function mockStopRead() {
  if (mock.readTimer) {
    clearInterval(mock.readTimer);
    mock.readTimer = 0;
  }
  mock.reading = false;
}
function log(...a: any[]) { if (!isElectron) console.debug('[LANComm mock]', ...a); }


/** Concatenate two byte arrays (number[]) efficiently using Uint8Array under the hood. */
function concatBytes(a: number[], b: number[]): number[] {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return Array.from(out.values());
}

/**
 * Deterministic mock response generator:
 * - For ESC/POS-like status query [0x10, 0x04, ...] returns [0x00]
 * - Otherwise echos back up to 16 bytes of the request
 */
function mockResponseFor(req: number[]): number[] {
  if (req.length >= 3 && req[0] === 0x10 && req[1] === 0x04) return [0x00]; // pseudo-status
  return req.slice(0, 16);
}

/** Promise-based sleep for the mock RR helper. */
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// -----------------------
// Public API
// -----------------------

/**
 * Capacitor Web implementation.
 * - In Electron, proxies to the preload `window.TCPClient` API.
 * - In browsers, provides a no-op/mock implementation for development and previews.
 */
export class TCPClientWeb extends WebPlugin implements TCPClientPlugin {


  /** Open a TCP connection (delegated to Electron or mocked). */
  async tcpConnect(args: TcpConnectOptions): Promise<TcpConnectResult> {
    if (electronApi) return electronApi.tcpConnect(args);
    log('tcpConnect', args);
    mock.connected = true;
    return ok({ connected: true });
  }

  /** Disconnect the current session and emit a mock tcpDisconnect event if needed. */
  async tcpDisconnect(): Promise<TcpDisconnectResult> {
    if (electronApi) return electronApi.tcpDisconnect();
    log('tcpDisconnect');
    const was = mock.connected;
    mockStopRead();
    mock.connected = false;
    if (was) emit('tcpDisconnect', { reason: 'manual', disconnected: true });
    return ok({ disconnected: true });
  }

  /** Report connection status. */
  async tcpIsConnected(): Promise<TcpIsConnectedResult> {
    if (electronApi) return electronApi.tcpIsConnected();
    log('tcpIsConnected');
    return ok({ connected: mock.connected });
  }

  /** Report whether the mock reader is active. */
  async tcpIsReading(): Promise<TcpIsReadingResult> {
    if (electronApi) return electronApi.tcpIsReading();
    return ok({ reading: mock.reading });
  }

  /** Write raw bytes (delegated or mocked). */
  async tcpWrite(args: TcpWriteOptions): Promise<TcpWriteResult> {
    const data = Array.from(args.data as any) as number[];
    if (electronApi) return electronApi.tcpWrite({ data });
    log('tcpWrite', args);
    if (!mock.connected) return fail('not connected (mock)', { bytesWritten: 0 });
    mock.lastWrite = data.slice();
    return ok({ bytesWritten: data.length });
  }

  /**
   * Start continuous reading.
   * - Electron: defers to preload.
   * - Web: spins a timer to emit deterministic dummy chunks.
   */
  async tcpStartRead(args: TcpStartReadOptions = {}): Promise<TcpStartStopResult> {
    if (electronApi) return electronApi.tcpStartRead(args);
    log('tcpStartRead', args);
    if (!mock.connected) return ok({ reading: false });
    if (!mock.reading) mockStartRead(args.chunkSize ?? 4096);
    return ok({ reading: mock.reading });
  }

  /** Stop continuous reading. */
  async tcpStopRead(): Promise<TcpStartStopResult> {
    if (electronApi) return electronApi.tcpStopRead();
    log('tcpStopRead');
    mockStopRead();
    return ok({ reading: false });
  }

  /**
   * Configure read timeout.
   * - Electron: forwards to preload (native-level timeout semantics).
   * - Web: stores the value for mock timing only.
   */
  async tcpSetReadTimeout(args: { ms: number }): Promise<BaseResult> {
    if (electronApi) return electronApi.tcpSetReadTimeout(args);
    log('tcpSetReadTimeout', args);
    mock.readTimeoutMs = Math.max(1, args?.ms ?? 1000);
    return ok();
  }

  /**
   * Request/Response helper:
   * - Electron: proxied to preload, supports early-exit on `expect` pattern.
   * - Web: synthesizes a response based on the request and `expect`.
   */
  async tcpWriteAndRead(args: TcpWriteAndReadOptions): Promise<TcpWriteAndReadResult> {
    const data = Array.from(args.data as any) as number[];
    const suspend = args.suspendStreamDuringRR ?? true;

    if (electronApi) {
      return electronApi.tcpWriteAndRead({
        data ,
        timeoutMs: args.timeoutMs ?? 1000,
        maxBytes: args.maxBytes ?? 4096,
        expect: args.expect as any,
        suspendStreamDuringRR: suspend,
      });
    }

    // ----- Mock -----
    log('tcpWriteAndRead', args);
    if (!mock.connected) {
      return fail('not connected (mock)', { bytesWritten: 0, bytesRead: 0, data: [] as number[] });
    }

    mock.lastWrite = data.slice() as number[];
    const expectBuf = parseExpectBytes(args.expect as ExpectType);
    let reply = mockResponseFor(data);
    if (expectBuf) reply = concatBytes(reply, Array.from(expectBuf));

    const cap = Math.max(1, args.maxBytes ?? 4096);
    reply = reply.slice(0, cap);

    await sleep(Math.min(150, args.timeoutMs ?? 1000));
    return ok({
      bytesWritten: data.length,
      bytesRead: reply.length,
      data: reply,
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
    const r = on(eventName, listenerFunc);
    return { remove: async () => r.remove() };
  }

  /** Remove all listeners in the mock bus and ask the preload (if any) to do the same. */
  async removeAllListeners(): Promise<void> {
    listeners.clear();
    if (electronApi?.removeAllListeners) await electronApi.removeAllListeners();
  }
}
