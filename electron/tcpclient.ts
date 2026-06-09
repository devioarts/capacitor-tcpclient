/*
 * Electron main-process TCP client bridge — multi-connection variant.
 *
 * Responsibilities:
 * - Manage a Map<connectionId, SocketState> — each entry owns one net.Socket.
 * - Provide connect / disconnect / read / RR per connection, all keyed by connectionId.
 * - Stream reader: micro-batch incoming data (10 ms window, 16 KB cap), split into
 *   consumer-sized slices, emit tcpData to renderer (payload includes connectionId).
 * - IPC contract: handle `ipcMain.handle('tcpclient:*')` requests and emit
 *   `tcpclient:event:*` notifications to the renderer.
 * - Error policy: methods resolve with { error, errorMessage, ... }; no exceptions cross IPC.
 *
 * NOTE: parseExpectBytes is inlined here — do NOT re-introduce an import from
 * '../src/utils/expect'. The src/ directory is not included in the published npm
 * package (only dist/ and electron/ are listed in package.json "files"), so that
 * import would break in any app that installs the package.
 */

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import net from 'net';

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
  onClose?: (hadErr: boolean) => void;
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
// TCPClientManager
// ---------------------------------------------------------------------------

export class TCPClientManager {
  private win: BrowserWindow;
  private conns = new Map<string, SocketState>();

  constructor(win: BrowserWindow) {
    this.win = win;

    ipcMain.handle('tcpclient:connect', (_e, args) => this.connect(args));
    ipcMain.handle('tcpclient:disconnect', (_e, args) => this.disconnect(args));
    ipcMain.handle('tcpclient:isConnected', (_e, args) => this.isConnected(args));
    ipcMain.handle('tcpclient:isReading', (_e, args) => this.isReading(args));
    ipcMain.handle('tcpclient:write', (_e, args) => this.write(args));
    ipcMain.handle('tcpclient:startRead', (_e, args) => this.startRead(args));
    ipcMain.handle('tcpclient:stopRead', (_e, args) => this.stopRead(args));
    ipcMain.handle('tcpclient:setReadTimeout', (_e, args) => this.setReadTimeout(args));
    ipcMain.handle('tcpclient:writeAndRead', (_e, args) => this.writeAndRead(args));
    ipcMain.handle('tcpclient:destroyConnection', (_e, args) => this.destroyConnection(args));
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
    this.win.webContents.send(`tcpclient:event:${name}`, { connectionId, ...payload });
  }

  private isOpen(st: SocketState) {
    return !!st.sock && !st.sock.destroyed && !st.sock.connecting;
  }

  private jsArrToBuf(arr: number[]) {
    return Buffer.from(arr.map((n) => n & 0xff));
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
    const host = args.host;
    const port = args.port ?? 9100;
    const timeout = args.timeout ?? 3000;
    const noDelay = args.noDelay ?? true;
    const keepAlive = args.keepAlive ?? true;

    // tear down any existing socket for this connection first
    await this.disconnect({ connectionId });
    const st = this.getOrCreate(connectionId);

    return new Promise<Std<{ connected: boolean }>>((resolve) => {
      try {
        const s = new net.Socket();
        st.sock = s;

        let connectTimer: NodeJS.Timeout | null = setTimeout(
          () => {
            connectTimer = null;
            try {
              s.destroy(new Error('connect timeout'));
            } catch {
              /* ignore */
            }
            if (st.sock === s) st.sock = null;
            resolve(fail('connect timeout', { connected: false }));
          },
          Math.max(1, timeout),
        );

        s.setNoDelay(!!noDelay);
        s.setKeepAlive(!!keepAlive, 60_000);

        const onError = (err: Error) => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          if (st.sock === s) st.sock = null;
          resolve(fail(`connect failed: ${err.message}`, { connected: false }));
        };
        s.once('error', onError);

        s.connect({ host, port }, () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          s.removeListener('error', onError);

          st.onClose = (hadErr: boolean) => {
            if (st.streamDataHandler) {
              s.off('data', st.streamDataHandler);
              st.streamDataHandler = undefined;
            }
            st.reading = false;
            if (st.sock === s) st.sock = null;
            if (hadErr) {
              this.sendEvent(connectionId, 'tcpDisconnect', {
                reason: 'error',
                error: 'socket closed with error',
                disconnected: true,
              });
            } else {
              this.sendEvent(connectionId, 'tcpDisconnect', { reason: 'remote', disconnected: true });
            }
          };
          s.once('close', st.onClose);
          resolve(ok({ connected: true }));
        });
      } catch (e) {
        st.sock = null;
        resolve(fail(e, { connected: false }));
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
      if (st.onClose) {
        s.off('close', st.onClose);
        st.onClose = undefined;
      }
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      this.sendEvent(connectionId, 'tcpDisconnect', { reason: 'manual', disconnected: true });
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

    const buf = this.jsArrToBuf(args.data || []);
    return new Promise<Std<{ bytesSent: number }>>((resolve) => {
      st.sock!.write(buf, (err) => {
        if (err) resolve(fail(`write failed: ${err.message}`, { bytesSent: 0 }));
        else resolve(ok({ bytesSent: buf.length }));
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
    st.lastChunkSize = Math.max(1, args?.chunkSize ?? 4096);
    if (args?.readTimeout != null) st.readTimeout = Math.max(1, args.readTimeout);

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
    if (st) st.readTimeout = Math.max(1, args?.readTimeout ?? 1000);
    return ok();
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
  }): Promise<Std<{ data: number[]; bytesSent: number | null; bytesReceived: number | null; matched: boolean }>> {
    const { connectionId } = args;
    const st = this.conns.get(connectionId);

    if (!st || !this.isOpen(st) || !st.sock) {
      return fail('not connected', { data: [], bytesSent: null, bytesReceived: null, matched: false });
    }
    if (st.rrInFlight) {
      return fail('busy', { data: [], bytesSent: null, bytesReceived: null, matched: false });
    }
    st.rrInFlight = true;

    const timeout = Math.max(1, args.timeout ?? st.readTimeout ?? 1000);
    const cap = Math.max(1, args.maxBytes ?? 4096);
    const expectUA = parseExpectBytes(args.expect);
    const expectBuf = expectUA ? Buffer.from(expectUA) : null;

    const s = st.sock!;
    const wasReading = st.reading;
    const shouldSuspend = !!(args.suspendStreamDuringRR ?? true) && wasReading;

    // suspend stream reader so it does not consume the reply bytes
    if (shouldSuspend && st.streamDataHandler) {
      s.off('data', st.streamDataHandler);
    }

    const reqBuf = this.jsArrToBuf(args.data || []);
    const bytesSent = reqBuf.length;
    let matched = false;

    return new Promise<
      Std<{ data: number[]; bytesSent: number | null; bytesReceived: number | null; matched: boolean }>
    >((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let idleTimer: NodeJS.Timeout | null = null;

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
        if (shouldSuspend && st.streamDataHandler) {
          s.on('data', st.streamDataHandler);
        }
        st.rrInFlight = false;

        if (err) {
          const isTimeout = err === 'connect timeout';
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
      const onClose = () => finish(null, 'connection closed');

      timer = setTimeout(() => {
        const out = size > 0 ? Buffer.concat(chunks, Math.min(size, cap)) : null;
        if (out) {
          matched = false;
          finish(out);
        } else {
          finish(null, 'connect timeout');
        }
      }, timeout);

      s.on('data', onData);
      s.once('error', onError);
      s.once('close', onClose);

      s.write(reqBuf, (err) => {
        if (err) finish(null, `write failed: ${err.message}`);
      });
    });
  }
}
