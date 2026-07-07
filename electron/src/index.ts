/*
 * Electron main-process TCP client bridge — multi-connection variant.
 *
 * Responsibilities:
 * - Manage a Map<connectionId, SocketState> — each entry owns one net.Socket.
 * - Provide connect / disconnect / read / RR per connection, all keyed by connectionId.
 * - Stream reader: micro-batch incoming data (10 ms window, 16 KB cap), split into
 *   consumer-sized slices, emit tcpData to renderer (payload includes connectionId).
 * - IPC contract: methods are registered as ipcMain.handle handlers by the
 *   auto-generated electron-main.ts runtime.  Events are pushed to the renderer
 *   via webContents.send.
 * - Error policy: methods resolve with { error, errorMessage, ... }; no exceptions cross IPC.
 *
 * NOTE: parseExpectBytes is inlined here — do NOT re-introduce an import from
 * '../../src/utils/expect'. The src/ directory is not included in the published npm
 * package (only dist/ and electron/ are listed in package.json "files"), so that
 * import would break in any app that installs the package.
 */

import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
// Use CommonJS import form so tsc does not emit top-level `this` helpers before Rollup.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import net = require('net');

// ---------------------------------------------------------------------------
// parseExpectBytes — inlined from src/utils/expect (src/ not in published pkg)
// ---------------------------------------------------------------------------

type ExpectInput = string | number[] | Uint8Array | null | undefined;
type ParsedExpect = { ok: true; bytes: Uint8Array | null } | { ok: false };

function parseExpectBytes(expect: ExpectInput): ParsedExpect {
  if (expect == null || expect === '') return { ok: true, bytes: null };
  if (expect instanceof Uint8Array) {
    return { ok: true, bytes: expect.length === 0 ? null : new Uint8Array(expect) };
  }
  if (Array.isArray(expect)) {
    if (expect.length === 0) return { ok: true, bytes: null };
    const out = new Uint8Array(expect.length);
    for (let i = 0; i < expect.length; i++) {
      const value = expect[i];
      if (!isByte(value)) return { ok: false };
      out[i] = value;
    }
    return { ok: true, bytes: out };
  }
  if (typeof expect === 'string') {
    const clean = expect.replace(/0x/gi, '').replace(/\s+/g, '').toLowerCase();
    if (!clean || clean.length % 2) return { ok: false };
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      const v = parseInt(clean.slice(i, i + 2), 16);
      if (Number.isNaN(v)) return { ok: false };
      out[i / 2] = v & 0xff;
    }
    return { ok: true, bytes: out };
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

type Empty = Record<string, never>;
type StdOk<T extends object = Empty> = { error: false; errorMessage: null } & T;
type StdErr<T extends object = Empty> = { error: true; errorMessage: string } & T;
type Std<T extends object = Empty> = StdOk<T> | StdErr<T>;

function isByte(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

function ok(): StdOk<Empty>;
function ok<T extends object>(extra: T): StdOk<T>;
function ok<T extends object>(extra?: T) {
  return { error: false, errorMessage: null, ...(extra ?? ({} as Empty)) };
}
function fail(msg: unknown): StdErr<Empty>;
function fail<T extends object>(msg: unknown, extra: T): StdErr<T>;
function fail<T extends object>(msg: unknown, extra?: T) {
  const m = (msg as any)?.message ?? (typeof msg === 'string' ? msg : null) ?? String(msg ?? 'Error');
  return { error: true, errorMessage: m, ...(extra ?? ({} as Empty)) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 4096;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const WRITE_TIMEOUT_MS = 3000;
const MIN_RR_IDLE_MS = 100;
const MAX_RR_IDLE_MS = 200;
const MERGE_WINDOW_MS = 10;
const MERGE_MAX_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

interface SocketState {
  sock: net.Socket | null;
  reading: boolean;
  rrInFlight: boolean;
  ioInFlight: boolean;
  connectInFlight: boolean;
  streamDataHandler?: (chunk: Buffer) => void;
  socketErrorHandler?: (err: Error) => void;
  onClose?: (hadErr: boolean) => void;
  lastSocketError: Error | null;
  lastChunkSize: number;
  readTimeout: number;
  // micro-batch
  pendingChunks: Buffer[];
  pendingSize: number;
  flushTimer: NodeJS.Timeout | null;
}

function makeState(): SocketState {
  return {
    sock: null,
    reading: false,
    rrInFlight: false,
    ioInFlight: false,
    connectInFlight: false,
    lastSocketError: null,
    lastChunkSize: DEFAULT_CHUNK_SIZE,
    readTimeout: 1000,
    pendingChunks: [],
    pendingSize: 0,
    flushTimer: null,
  };
}

// ---------------------------------------------------------------------------
// TCPClient
// ---------------------------------------------------------------------------

/**
 * Main-process TCP client plugin for Electron.
 *
 * Lifecycle:
 *  1. Instantiate once after `app.whenReady()`.
 *  2. Register each plugin method as an IPC handler (via the auto-generated
 *     `electron-main.ts` runtime or manually with `ipcMain.handle`).
 *  3. The preload runtime (`electron-rt.ts`) exposes the methods and event
 *     subscriptions to the renderer via `CapacitorCustomPlatform`.
 *
 * Events:
 *  - `event-add-TCPClient` (ipcMain.on) — sent by the preload when the first
 *    listener for any event type is registered; captures the renderer's
 *    `WebContents` so subsequent `sendEvent` calls can reach it.
 *  - `event-TCPClient-tcpData` / `event-TCPClient-tcpDisconnect` — sent to
 *    the renderer via `webContents.send`.
 *
 * ⚠️ Single-window limitation: only the `WebContents` of the most recent
 *    `event-add-TCPClient` sender is retained.  In multi-window Electron apps
 *    events are delivered only to the last window that registered a listener.
 */
export class TCPClient {
  private webContents: WebContents | null = null;
  private conns = new Map<string, SocketState>();
  private pendingReadTimeouts = new Map<string, number>();

  constructor() {
    ipcMain.on('event-add-TCPClient', (event) => {
      this.attachWebContents(event.sender);
    });
  }

  // ---- internal helpers ---------------------------------------------------

  private attachWebContents(webContents: WebContents) {
    if (this.webContents === webContents) return;

    this.webContents = webContents;
    webContents.once('destroyed', () => {
      if (this.webContents === webContents) {
        this.webContents = null;
      }
    });
  }

  private getOrCreate(connectionId: string): SocketState {
    let st = this.conns.get(connectionId);
    if (!st) {
      st = makeState();
      const pendingReadTimeout = this.pendingReadTimeouts.get(connectionId);
      if (pendingReadTimeout != null) st.readTimeout = pendingReadTimeout;
      this.conns.set(connectionId, st);
    }
    return st;
  }

  private sendEvent(connectionId: string, name: 'tcpData' | 'tcpDisconnect', payload: object) {
    const webContents = this.webContents;
    if (!webContents) return;

    if (webContents.isDestroyed()) {
      if (this.webContents === webContents) {
        this.webContents = null;
      }
      return;
    }

    try {
      webContents.send(`event-TCPClient-${name}`, { connectionId, ...payload });
    } catch {
      if (this.webContents === webContents) {
        this.webContents = null;
      }
    }
  }

  private isOpen(st: SocketState) {
    return !!st.sock && !st.sock.destroyed && !st.sock.connecting;
  }

  private positiveInt(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
  }

  private jsArrToBuf(arr: unknown) {
    if (arr instanceof Uint8Array) {
      if (arr.length > MAX_BUFFER_BYTES) return null;
      return Buffer.from(arr);
    }
    if (!Array.isArray(arr)) return null;
    if (arr.length > MAX_BUFFER_BYTES) return null;
    const out = Buffer.alloc(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const value = arr[i];
      if (!isByte(value)) return null;
      out[i] = value;
    }
    return out;
  }

  private detachRuntimeSocketHandlers(st: SocketState, s: net.Socket) {
    if (st.streamDataHandler) {
      s.off('data', st.streamDataHandler);
      st.streamDataHandler = undefined;
    }
    if (st.socketErrorHandler) {
      s.off('error', st.socketErrorHandler);
      st.socketErrorHandler = undefined;
    }
    if (st.onClose) {
      s.off('close', st.onClose);
      st.onClose = undefined;
    }
  }

  private installRuntimeSocketHandlers(connectionId: string, st: SocketState, s: net.Socket) {
    st.lastSocketError = null;

    // Node treats an unhandled socket "error" event as fatal. Keep this listener installed
    // for the whole connected lifetime and translate the final state through tcpDisconnect.
    st.socketErrorHandler = (err: Error) => {
      st.lastSocketError = err;
    };

    st.onClose = (hadErr: boolean) => {
      this.detachRuntimeSocketHandlers(st, s);
      this.flushPendingNow(connectionId, st);
      st.reading = false;
      st.rrInFlight = false;
      st.ioInFlight = false;
      if (st.sock === s) st.sock = null;

      const err = st.lastSocketError;
      st.lastSocketError = null;
      if (hadErr || err) {
        this.sendEvent(connectionId, 'tcpDisconnect', {
          reason: 'error',
          error: err?.message ?? 'socket closed with error',
          disconnected: true,
          reading: false,
        });
      } else {
        this.sendEvent(connectionId, 'tcpDisconnect', { reason: 'remote', disconnected: true, reading: false });
      }
    };

    s.on('error', st.socketErrorHandler);
    s.once('close', st.onClose);
  }

  // ---- micro-batch --------------------------------------------------------

  private flushPendingNow(connectionId: string, st: SocketState) {
    if (st.flushTimer) {
      clearTimeout(st.flushTimer);
      st.flushTimer = null;
    }
    if (st.pendingSize > 0) {
      const payload = Buffer.concat(st.pendingChunks, st.pendingSize);
      st.pendingChunks = [];
      st.pendingSize = 0;
      const lim = Math.max(1, st.lastChunkSize || 4096);
      for (let off = 0; off < payload.length; off += lim) {
        const part = payload.subarray(off, Math.min(off + lim, payload.length));
        this.sendEvent(connectionId, 'tcpData', { data: Array.from(part.values()) });
      }
    }
  }

  private scheduleFlush(connectionId: string, st: SocketState) {
    if (st.flushTimer) clearTimeout(st.flushTimer);
    st.flushTimer = setTimeout(() => {
      st.flushTimer = null;
      this.flushPendingNow(connectionId, st);
    }, MERGE_WINDOW_MS);
  }

  private async writeBufferWithTimeout(
    st: SocketState,
    s: net.Socket,
    buf: Buffer,
    timeoutMs: number,
  ): Promise<Std<{ bytesSent: number }>> {
    return new Promise<Std<{ bytesSent: number }>>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let socketError: Error | null = null;

      // write callback, socket error, close, and watchdog can race; settle once
      // and leave the permanent lifecycle handler to translate final disconnect.
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        s.off('error', onError);
        s.off('close', onClose);
      };

      const settle = (result: Std<{ bytesSent: number }>, destroySocket = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (destroySocket && st.sock === s && !s.destroyed) {
          st.lastSocketError = new Error(result.errorMessage ?? 'write timeout');
          s.destroy(st.lastSocketError);
        }
        resolve(result);
      };

      const onError = (err: Error) => {
        socketError = err;
        settle(fail(`write failed: ${err.message}`, { bytesSent: 0 }));
      };
      const onClose = () => {
        const err = socketError ?? st.lastSocketError;
        settle(fail(err ? `connection closed: ${err.message}` : 'connection closed', { bytesSent: 0 }));
      };

      s.once('error', onError);
      s.prependOnceListener('close', onClose);
      timer = setTimeout(() => settle(fail('write timeout', { bytesSent: 0 }), true), timeoutMs);

      s.write(buf, (err) => {
        if (err) settle(fail(`write failed: ${err.message}`, { bytesSent: 0 }));
        else settle(ok({ bytesSent: buf.length }));
      });
    });
  }

  // ---- IPC handlers -------------------------------------------------------

  async connect(args: {
    connectionId: string;
    host: string;
    port?: number;
    timeout?: number;
    noDelay?: boolean;
    keepAlive?: boolean;
  }): Promise<Std<{ connected: boolean }>> {
    const { connectionId } = args;
    if (typeof connectionId !== 'string' || !connectionId) {
      return fail('connectionId is required', { connected: false });
    }
    const hostRaw = args.host;
    if (typeof hostRaw !== 'string' || !hostRaw.trim()) {
      return fail('host is required', { connected: false });
    }
    const host = hostRaw.trim();
    const port = this.positiveInt(args.port, 9100, 1, 65535);
    if (args.port != null && port !== args.port) {
      return fail('invalid port', { connected: false });
    }
    const timeout = this.positiveInt(args.timeout, 3000, 1, MAX_TIMER_MS);
    const noDelay = args.noDelay ?? true;
    const keepAlive = args.keepAlive ?? true;
    const st = this.getOrCreate(connectionId);

    if (st.connectInFlight) {
      return fail('busy', { connected: false });
    }
    st.connectInFlight = true;

    // tear down any existing socket for this connection first
    await this.disconnect({ connectionId });
    st.reading = false;
    st.rrInFlight = false;
    st.ioInFlight = false;

    return new Promise<Std<{ connected: boolean }>>((resolve) => {
      const s = new net.Socket();
      st.sock = s;
      st.lastSocketError = null;

      let settled = false;
      let connectTimer: NodeJS.Timeout | null = null;

      const cleanupConnect = () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        s.off('connect', onConnect);
        s.off('error', onError);
        s.off('close', onClose);
      };

      const settle = (result: Std<{ connected: boolean }>, destroySocket: boolean) => {
        if (settled) return;
        settled = true;
        cleanupConnect();
        if (st.sock === s && result.error) st.sock = null;
        if (destroySocket && !s.destroyed) {
          try {
            s.destroy();
          } catch {
            /* ignore */
          }
        }
        st.connectInFlight = false;
        resolve(result);
      };

      const onError = (err: Error) => {
        st.lastSocketError = err;
        settle(fail(`connect failed: ${err.message}`, { connected: false }), false);
      };

      const onClose = () => {
        const err = st.lastSocketError;
        st.lastSocketError = null;
        settle(
          fail(err ? `connect failed: ${err.message}` : 'connection closed before connect', { connected: false }),
          false,
        );
      };

      const onConnect = () => {
        if (settled) return;
        if (st.sock !== s) {
          settle(fail('connection closed before connect', { connected: false }), true);
          return;
        }
        settled = true;
        cleanupConnect();
        st.connectInFlight = false;
        this.installRuntimeSocketHandlers(connectionId, st, s);
        resolve(ok({ connected: true }));
      };

      s.once('connect', onConnect);
      s.once('error', onError);
      s.once('close', onClose);

      connectTimer = setTimeout(() => {
        settle(fail('connect timeout', { connected: false }), true);
      }, timeout);

      try {
        s.setNoDelay(!!noDelay);
        s.setKeepAlive(!!keepAlive, 60_000);
        s.connect({ host, port });
      } catch (e) {
        settle(fail(e, { connected: false }), true);
      }
    });
  }

  async disconnect(args: { connectionId: string }): Promise<Std<{ disconnected: boolean; reading?: boolean }>> {
    const { connectionId } = args;
    await this.stopRead({ connectionId });

    const st = this.conns.get(connectionId);
    if (!st) return ok({ disconnected: true, reading: false });

    const s = st.sock;
    st.sock = null;
    st.reading = false;
    st.rrInFlight = false;
    st.ioInFlight = false;

    if (s) {
      this.detachRuntimeSocketHandlers(st, s);
      const suppressDestroyError = () => {
        /* Socket is being closed manually; keep error events handled until close. */
      };
      s.on('error', suppressDestroyError);
      s.once('close', () => s.off('error', suppressDestroyError));
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      this.sendEvent(connectionId, 'tcpDisconnect', { reason: 'manual', disconnected: true, reading: false });
    }
    return ok({ disconnected: true, reading: false });
  }

  async isConnected(args: { connectionId: string }): Promise<Std<{ connected: boolean }>> {
    const st = this.conns.get(args.connectionId);
    return ok({ connected: !!st && this.isOpen(st) });
  }

  async isReading(args: { connectionId: string }): Promise<Std<{ reading: boolean }>> {
    const st = this.conns.get(args.connectionId);
    return ok({ reading: !!st?.reading });
  }

  async write(args: { connectionId: string; data: number[] }): Promise<Std<{ bytesSent: number }>> {
    const st = this.conns.get(args.connectionId);
    if (!st || !this.isOpen(st) || !st.sock) return fail('not connected', { bytesSent: 0 });
    if (st.ioInFlight || st.rrInFlight) return fail('busy', { bytesSent: 0 });

    const buf = this.jsArrToBuf(args.data ?? []);
    if (!buf) return fail('data must be an array of bytes', { bytesSent: 0 });
    st.ioInFlight = true;
    try {
      return await this.writeBufferWithTimeout(st, st.sock, buf, WRITE_TIMEOUT_MS);
    } finally {
      st.ioInFlight = false;
    }
  }

  async startRead(args: {
    connectionId: string;
    chunkSize?: number;
    readTimeout?: number;
  }): Promise<Std<{ reading: boolean }>> {
    const { connectionId } = args;
    const st = this.conns.get(connectionId);
    if (!st || !this.isOpen(st) || !st.sock) return fail('not connected', { reading: false });
    if (st.reading) return ok({ reading: true });

    st.reading = true;
    st.lastChunkSize = this.positiveInt(args?.chunkSize, DEFAULT_CHUNK_SIZE, 1, MAX_BUFFER_BYTES);
    if (args?.readTimeout != null) st.readTimeout = this.positiveInt(args.readTimeout, st.readTimeout, 1, MAX_TIMER_MS);

    // reset micro-batch state
    st.pendingChunks = [];
    st.pendingSize = 0;
    if (st.flushTimer) {
      clearTimeout(st.flushTimer);
      st.flushTimer = null;
    }

    st.streamDataHandler = (chunk: Buffer) => {
      st.pendingChunks.push(chunk);
      st.pendingSize += chunk.length;
      if (st.pendingSize >= MERGE_MAX_BYTES) {
        this.flushPendingNow(connectionId, st);
      } else {
        this.scheduleFlush(connectionId, st);
      }
    };
    st.sock.on('data', st.streamDataHandler);
    return ok({ reading: true });
  }

  async stopRead(args: { connectionId: string }): Promise<Std<{ reading: boolean }>> {
    const st = this.conns.get(args.connectionId);
    if (!st) return ok({ reading: false });
    if (st.sock && st.streamDataHandler) {
      st.sock.off('data', st.streamDataHandler);
    }
    st.streamDataHandler = undefined;
    this.flushPendingNow(args.connectionId, st);
    st.reading = false;
    return ok({ reading: false });
  }

  async setReadTimeout(args: { connectionId: string; readTimeout: number }): Promise<Std> {
    const timeout = this.positiveInt(args?.readTimeout, 1000, 1, MAX_TIMER_MS);
    const st = this.conns.get(args.connectionId);
    if (st) st.readTimeout = timeout;
    else this.pendingReadTimeouts.set(args.connectionId, timeout);
    return ok();
  }

  async getPluginPlatform(): Promise<StdOk<{ platform: 'electron' }>> {
    return ok({ platform: 'electron' as const });
  }

  async destroyConnection(args: { connectionId: string }): Promise<Std> {
    await this.disconnect(args);
    this.conns.delete(args.connectionId);
    this.pendingReadTimeouts.delete(args.connectionId);
    return ok();
  }

  async writeAndRead(args: {
    connectionId: string;
    data: number[];
    timeout?: number;
    maxBytes?: number;
    expect?: ExpectInput;
    suspendStreamDuringRR?: boolean;
  }): Promise<Std<{ data: number[]; bytesSent: number; bytesReceived: number; matched: boolean }>> {
    const { connectionId } = args;
    const st = this.conns.get(connectionId);

    if (!st || !this.isOpen(st) || !st.sock) {
      return fail('not connected', { data: [], bytesSent: 0, bytesReceived: 0, matched: false });
    }
    if (st.ioInFlight || st.rrInFlight) {
      return fail('busy', { data: [], bytesSent: 0, bytesReceived: 0, matched: false });
    }

    const timeout = this.positiveInt(args.timeout, st.readTimeout ?? 1000, 1, MAX_TIMER_MS);
    const cap = this.positiveInt(args.maxBytes, DEFAULT_CHUNK_SIZE, 1, MAX_BUFFER_BYTES);
    const parsedExpect = parseExpectBytes(args.expect);
    if (!parsedExpect.ok) {
      return fail('invalid expect (hex or byte array expected)', {
        data: [],
        bytesSent: 0,
        bytesReceived: 0,
        matched: false,
      });
    }
    const expectBuf = parsedExpect.bytes ? Buffer.from(parsedExpect.bytes) : null;
    const reqBuf = this.jsArrToBuf(args.data ?? []);
    if (!reqBuf) {
      return fail('data must be an array of bytes', { data: [], bytesSent: 0, bytesReceived: 0, matched: false });
    }
    st.rrInFlight = true;
    st.ioInFlight = true;

    const s = st.sock!;
    const wasReading = st.reading;
    const shouldSuspend = !!(args.suspendStreamDuringRR ?? true) && wasReading;
    const suspendedStreamDataHandler = shouldSuspend ? st.streamDataHandler : undefined;

    // suspend stream reader so it does not consume the reply bytes
    if (suspendedStreamDataHandler) {
      this.flushPendingNow(connectionId, st);
      s.off('data', suspendedStreamDataHandler);
    }

    const bytesSent = reqBuf.length;
    let matched = false;

    return new Promise<Std<{ data: number[]; bytesSent: number; bytesReceived: number; matched: boolean }>>(
      (resolve) => {
        let timer: NodeJS.Timeout | null = null;
        let idleTimer: NodeJS.Timeout | null = null;
        let settled = false;
        let writeFinished = false;
        let socketError: Error | null = null;

        const chunks: Buffer[] = [];
        let size = 0;

        // adaptive until-idle (like iOS)
        let lastDataAt = 0;
        const interArr: number[] = []; // ms intervals, keep last 5

        const currentIdleMs = () => {
          if (interArr.length === 0) return MIN_RR_IDLE_MS;
          const sorted = [...interArr].sort((a, b) => a - b);
          const med =
            sorted.length % 2
              ? sorted[(sorted.length / 2) | 0]
              : 0.5 * (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]);
          return Math.max(MIN_RR_IDLE_MS, Math.min(MAX_RR_IDLE_MS, Math.round(med * 1.75)));
        };

        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finish(Buffer.concat(chunks, Math.min(size, cap))), currentIdleMs());
        };

        const finish = (out: Buffer | null, err?: string) => {
          if (settled) return;
          settled = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          s.off('data', onData);
          s.off('error', onError);
          s.off('close', onClose);
          // resume stream reader
          if (
            suspendedStreamDataHandler &&
            st.streamDataHandler === suspendedStreamDataHandler &&
            st.sock === s &&
            !s.destroyed
          ) {
            s.on('data', suspendedStreamDataHandler);
          }
          st.rrInFlight = false;
          st.ioInFlight = false;

          if (err) {
            const isTimeout = err === 'timeout';
            resolve(fail(err, { data: [], bytesSent: isTimeout ? bytesSent : 0, bytesReceived: 0, matched: false }));
          } else {
            const resBuf = (out ?? Buffer.alloc(0)).subarray(0, cap);
            resolve(ok({ data: Array.from(resBuf.values()), bytesSent, bytesReceived: resBuf.length, matched }));
          }
        };

        const onData = (chunk: Buffer) => {
          const remaining = cap - size;
          const accepted = remaining > 0 && chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(accepted);
          size += accepted.length;

          const now = Date.now();
          if (lastDataAt > 0) {
            const d = now - lastDataAt;
            interArr.push(d);
            if (interArr.length > 5) interArr.splice(0, interArr.length - 5);
          }
          lastDataAt = now;

          const current = Buffer.concat(chunks, Math.min(size, cap));

          if (expectBuf) {
            if (current.indexOf(expectBuf) >= 0) {
              matched = true;
              finish(current);
              return;
            }
            if (current.length >= cap) {
              matched = false;
              finish(current);
              return;
            }
            // keep waiting for more data
            return;
          }

          // no expect: adaptive until-idle
          if (current.length >= cap) {
            matched = false;
            finish(current);
            return;
          }
          armIdle();
        };

        const onError = (err: Error) => {
          socketError = err;
          finish(null, `writeAndRead failed: ${err.message}`);
        };
        const onClose = () => {
          const err = socketError ?? st.lastSocketError;
          if (size > 0) {
            finish(Buffer.concat(chunks, Math.min(size, cap)));
          } else {
            finish(null, err ? `connection closed: ${err.message}` : 'connection closed');
          }
        };

        timer = setTimeout(() => {
          if (!writeFinished) {
            st.lastSocketError = new Error('write timeout');
            if (st.sock === s && !s.destroyed) s.destroy(st.lastSocketError);
            finish(null, 'write timeout');
            return;
          }
          const out = size > 0 ? Buffer.concat(chunks, Math.min(size, cap)) : null;
          if (out) {
            matched = false;
            finish(out);
          } else {
            finish(null, 'timeout');
          }
        }, timeout);

        s.on('data', onData);
        s.once('error', onError);
        s.prependOnceListener('close', onClose);

        s.write(reqBuf, (err) => {
          writeFinished = true;
          if (err) finish(null, `write failed: ${err.message}`);
        });
      },
    );
  }
}
