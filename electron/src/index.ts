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

function parseExpectBytes(expect: ExpectInput): Uint8Array | null {
  if (!expect) return null;
  if (expect instanceof Uint8Array) return new Uint8Array(expect);
  if (Array.isArray(expect)) {
    const out = new Uint8Array(expect.length);
    for (let i = 0; i < expect.length; i++) out[i] = (expect[i] ?? 0) & 0xff;
    return out;
  }
  if (typeof expect === 'string') {
    const clean = expect.replace(/0x/gi, '').replace(/\s+/g, '').toLowerCase();
    if (!clean || clean.length % 2) return null;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      const v = parseInt(clean.slice(i, i + 2), 16);
      if (Number.isNaN(v)) return null;
      out[i / 2] = v & 0xff;
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

type Empty = Record<string, never>;
type StdOk<T extends object = Empty> = { error: false; errorMessage: null } & T;
type StdErr<T extends object = Empty> = { error: true; errorMessage: string } & T;
type Std<T extends object = Empty> = StdOk<T> | StdErr<T>;

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
// Per-connection state
// ---------------------------------------------------------------------------

interface SocketState {
  sock: net.Socket | null;
  reading: boolean;
  rrInFlight: boolean;
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
    lastSocketError: null,
    lastChunkSize: 4096,
    readTimeout: 1000,
    pendingChunks: [],
    pendingSize: 0,
    flushTimer: null,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERGE_WINDOW_MS = 10;
const MERGE_MAX_BYTES = 16 * 1024;

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
  private listenerCounts = new Map<string, number>();

  constructor() {
    ipcMain.on('event-add-TCPClient', (event, type: unknown) => {
      this.webContents = event.sender;
      const t = type as string;
      this.listenerCounts.set(t, (this.listenerCounts.get(t) ?? 0) + 1);
    });
    for (const ev of ['tcpData', 'tcpDisconnect'] as const) {
      ipcMain.on(`event-remove-TCPClient-${ev}`, () => {
        const c = (this.listenerCounts.get(ev) ?? 1) - 1;
        this.listenerCounts.set(ev, Math.max(0, c));
      });
    }
  }

  // ---- internal helpers ---------------------------------------------------

  private getOrCreate(connectionId: string): SocketState {
    let st = this.conns.get(connectionId);
    if (!st) {
      st = makeState();
      this.conns.set(connectionId, st);
    }
    return st;
  }

  private sendEvent(connectionId: string, name: 'tcpData' | 'tcpDisconnect', payload: object) {
    if ((this.listenerCounts.get(name) ?? 0) > 0) {
      this.webContents?.send(`event-TCPClient-${name}`, { connectionId, ...payload });
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
    if (arr instanceof Uint8Array) return Buffer.from(arr);
    if (!Array.isArray(arr)) return null;
    return Buffer.from(arr.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0) & 0xff));
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
    const timeout = this.positiveInt(args.timeout, 3000);
    const noDelay = args.noDelay ?? true;
    const keepAlive = args.keepAlive ?? true;

    // tear down any existing socket for this connection first
    await this.disconnect({ connectionId });
    const st = this.getOrCreate(connectionId);

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
        settled = true;
        cleanupConnect();
        this.installRuntimeSocketHandlers(connectionId, st, s);
        resolve(ok({ connected: true }));
      };

      s.once('connect', onConnect);
      s.once('error', onError);
      s.once('close', onClose);

      connectTimer = setTimeout(
        () => {
          settle(fail('connect timeout', { connected: false }), true);
        },
        Math.max(1, timeout),
      );

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
    if (st.rrInFlight) return fail('busy', { bytesSent: 0 });

    const buf = this.jsArrToBuf(args.data ?? []);
    if (!buf) return fail('data must be an array of bytes', { bytesSent: 0 });
    return new Promise<Std<{ bytesSent: number }>>((resolve) => {
      const s = st.sock!;
      let settled = false;

      // write callback, socket error, and socket close can race; settle once and detach all
      // temporary listeners so the permanent socket lifecycle handler remains authoritative.
      const cleanup = () => {
        s.off('error', onError);
        s.off('close', onClose);
      };

      const settle = (result: Std<{ bytesSent: number }>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const onError = (err: Error) => settle(fail(`write failed: ${err.message}`, { bytesSent: 0 }));
      const onClose = () => settle(fail('connection closed', { bytesSent: 0 }));

      s.once('error', onError);
      s.once('close', onClose);

      s.write(buf, (err) => {
        if (err) settle(fail(`write failed: ${err.message}`, { bytesSent: 0 }));
        else settle(ok({ bytesSent: buf.length }));
      });
    });
  }

  async startRead(args: {
    connectionId: string;
    chunkSize?: number;
    readTimeout?: number;
  }): Promise<Std<{ reading: boolean }>> {
    const { connectionId } = args;
    const st = this.conns.get(connectionId);
    if (!st || !this.isOpen(st) || !st.sock) return ok({ reading: false });
    if (st.reading) return ok({ reading: true });

    st.reading = true;
    st.lastChunkSize = this.positiveInt(args?.chunkSize, 4096);
    if (args?.readTimeout != null) st.readTimeout = this.positiveInt(args.readTimeout, st.readTimeout);

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
    const st = this.conns.get(args.connectionId);
    if (st) st.readTimeout = this.positiveInt(args?.readTimeout, 1000);
    return ok();
  }

  async getPlatform(): Promise<StdOk<{ platform: 'electron' }>> {
    return ok({ platform: 'electron' as const });
  }

  async destroyConnection(args: { connectionId: string }): Promise<Std> {
    await this.disconnect(args);
    this.conns.delete(args.connectionId);
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
    if (st.rrInFlight) {
      return fail('busy', { data: [], bytesSent: 0, bytesReceived: 0, matched: false });
    }
    st.rrInFlight = true;

    const timeout = this.positiveInt(args.timeout, st.readTimeout ?? 1000);
    const cap = this.positiveInt(args.maxBytes, 4096);
    const expectUA = parseExpectBytes(args.expect);
    const expectBuf = expectUA ? Buffer.from(expectUA) : null;

    const s = st.sock!;
    const wasReading = st.reading;
    const shouldSuspend = !!(args.suspendStreamDuringRR ?? true) && wasReading;

    // suspend stream reader so it does not consume the reply bytes
    if (shouldSuspend && st.streamDataHandler) {
      this.flushPendingNow(connectionId, st);
      s.off('data', st.streamDataHandler);
    }

    const reqBuf = this.jsArrToBuf(args.data ?? []);
    if (!reqBuf) {
      st.rrInFlight = false;
      if (shouldSuspend && st.streamDataHandler && st.sock === s && !s.destroyed) {
        s.on('data', st.streamDataHandler);
      }
      return fail('data must be an array of bytes', { data: [], bytesSent: 0, bytesReceived: 0, matched: false });
    }
    const bytesSent = reqBuf.length;
    let matched = false;

    return new Promise<Std<{ data: number[]; bytesSent: number; bytesReceived: number; matched: boolean }>>(
      (resolve) => {
        let timer: NodeJS.Timeout | null = null;
        let idleTimer: NodeJS.Timeout | null = null;
        let settled = false;

        const chunks: Buffer[] = [];
        let size = 0;

        // adaptive until-idle (like iOS)
        let lastDataAt = 0;
        const interArr: number[] = []; // ms intervals, keep last 5

        const currentIdleMs = () => {
          if (interArr.length === 0) return 50;
          const sorted = [...interArr].sort((a, b) => a - b);
          const med =
            sorted.length % 2
              ? sorted[(sorted.length / 2) | 0]
              : 0.5 * (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]);
          return Math.max(50, Math.min(200, Math.round(med * 1.75)));
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
          if (shouldSuspend && st.streamDataHandler && st.sock === s && !s.destroyed) {
            s.on('data', st.streamDataHandler);
          }
          st.rrInFlight = false;

          if (err) {
            const isTimeout = err === 'timeout';
            resolve(fail(err, { data: [], bytesSent: isTimeout ? bytesSent : 0, bytesReceived: 0, matched: false }));
          } else {
            const resBuf = (out ?? Buffer.alloc(0)).subarray(0, cap);
            resolve(ok({ data: Array.from(resBuf.values()), bytesSent, bytesReceived: resBuf.length, matched }));
          }
        };

        const onData = (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;

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

        const onError = (err: Error) => finish(null, `writeAndRead failed: ${err.message}`);
        const onClose = () => {
          const err = st.lastSocketError;
          finish(null, err ? `connection closed: ${err.message}` : 'connection closed');
        };

        timer = setTimeout(() => {
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
        s.once('close', onClose);

        s.write(reqBuf, (err) => {
          if (err) finish(null, `write failed: ${err.message}`);
        });
      },
    );
  }
}
