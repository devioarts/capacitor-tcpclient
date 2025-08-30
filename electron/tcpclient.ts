// electron/main/tcpclient.ts

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import net from 'net';

import type {ExpectInput} from '../src/utils/expect'
import { parseExpectBytes } from '../src/utils/expect';


type ExpectType = ExpectInput;

type Empty = Record<string, never>;
type StdOk<T extends object = Empty>  = { error: false; errorMessage: null } & T;
type StdErr<T extends object = Empty> = { error: true;  errorMessage: string } & T;
type Std<T extends object = Empty>    = StdOk<T> | StdErr<T>;

// Standardized ok/fail helpers with overloads (preserve precise typings without `{}` widening).
function ok(): StdOk<Empty>;
function ok<T extends object>(extra: T): StdOk<T>;
function ok<T extends object>(extra?: T) {
  return { error: false, errorMessage: null, ...(extra ?? ({} as Empty)) };
}
function fail(msg: unknown): StdErr<Empty>;
function fail<T extends object>(msg: unknown, extra: T): StdErr<T>;
function fail<T extends object>(msg: unknown, extra?: T) {
  const m =
    (msg as any)?.message ??
    (typeof msg === 'string' ? msg : null) ??
    String(msg ?? 'Error');
  return { error: true, errorMessage: m, ...(extra ?? ({} as Empty)) };
}

export class TCPClient {
  private win: BrowserWindow;
  private sock: net.Socket | null = null;         // active socket, if any
  private reading = false;                         // stream-reading state for renderer parity
  private rrInFlight = false;                      // exclude concurrent request/response cycles
  private streamDataHandler?: (chunk: Buffer) => void; // current 'data' listener used for streaming
  private onClose?: (hadErr: boolean) => void;     // 'close' handler reference (to unregister on manual disconnect)

  private lastChunkSize = 4096;                    // remembers requested chunk size to partition large frames
  private readTimeoutMs = 1000;                    // logical RR timeout (Node sockets are evented; we emulate via timer)

  constructor(win: BrowserWindow) {
    this.win = win;

    // Register IPC handlers (main process). The preload/renderer will invoke these via ipcRenderer.invoke.
    ipcMain.handle('tcpclient:connect',        (_e, args) => this.connect(args));
    ipcMain.handle('tcpclient:disconnect',     () => this.disconnect());
    ipcMain.handle('tcpclient:isConnected',    () => this.isConnected());
    ipcMain.handle('tcpclient:isReading',      () => this.isReading());
    ipcMain.handle('tcpclient:write',          (_e, args) => this.write(args));
    ipcMain.handle('tcpclient:startRead',      (_e, args) => this.startRead(args));
    ipcMain.handle('tcpclient:stopRead',       () => this.stopRead());
    ipcMain.handle('tcpclient:setReadTimeout', (_e, args) => this.setReadTimeout(args));
    ipcMain.handle('tcpclient:writeAndRead',   (_e, args) => this.writeAndRead(args));
  }

  /** Emit an event to the renderer with a stable name prefix. */
  private sendEvent(name: 'tcpData' | 'tcpDisconnect', payload: any) {
    this.win.webContents.send(`tcpclient:event:${name}`, payload);
  }
  /** Cheap connection health: socket exists, not destroyed, not still connecting. */
  private isOpen() {
    const s = this.sock;
    return !!s && !s.destroyed && !s.connecting;
  }
  /** Convert JS number[] (0..255) to a Buffer safely. */
  private jsArrToBuf(arr: number[]) {
    return Buffer.from(arr.map(n => n & 0xff));
  }

  /** Convenience notifiers for disconnect reasons (forwarded to renderer). */
  private notifyDisconnectManual() { this.sendEvent('tcpDisconnect', { reason: 'manual', disconnected: true }); }
  private notifyDisconnectRemote() { this.sendEvent('tcpDisconnect', { reason: 'remote', disconnected: true }); }
  private notifyDisconnectError(err: string) {
    this.sendEvent('tcpDisconnect', { reason: 'error', error: err, disconnected: true });
  }

  /**
   * Connect to a TCP host.
   * - Ensures a clean starting state (calls tcpDisconnect()).
   * - Applies TCP_NODELAY and keep-alive settings.
   * - Sets up a connection timeout via setTimeout; clears listeners accordingly.
   * Resolves with a standardized result shape.
   */
  async connect(args: {
    host: string; port?: number; timeoutMs?: number; noDelay?: boolean; keepAlive?: boolean;
  }): Promise<Std<{ connected: boolean }>> {
    const host = args.host;
    const port = args.port ?? 9100;
    const timeoutMs = args.timeoutMs ?? 3000;
    const noDelay = args.noDelay ?? true;
    const keepAlive = args.keepAlive ?? true;

    // ensure clean state (neemituje "manual", pokud žádný socket nebyl)
    await this.disconnect();

    return new Promise<Std<{ connected: boolean }>>((resolve) => {
      try {
        const s = new net.Socket();
        this.sock = s;

        // Connection watchdog: if not connected in time, destroy and fail.
        let connectTimer: NodeJS.Timeout | null = setTimeout(() => {
          connectTimer = null;
          try { s.destroy(new Error('connect timeout')); } catch { /* ignore */ }
          if (this.sock === s) this.sock = null;
          resolve(fail('connect timeout', { connected: false }));
        }, Math.max(1, timeoutMs));

        s.setNoDelay(!!noDelay);
        s.setKeepAlive(!!keepAlive, 60_000);

        const onError = (err: Error) => {
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
          if (this.sock === s) this.sock = null;
          resolve(fail(`connect failed: ${err.message}`, { connected: false }));
        };
        // Guard the connect phase with a one-shot error listener.
        s.once('error', onError);

        s.connect({ host, port }, () => {
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
          s.removeListener('error', onError);

          // Register a one-shot close handler and keep a reference to avoid duplicate events on manual destroy().
          this.onClose = (hadErr: boolean) => {
            if (this.sock === s) this.sock = null;
            if (hadErr) this.notifyDisconnectError('socket closed with error');
            else this.notifyDisconnectRemote();
          };
          s.once('close', this.onClose);

          resolve(ok({ connected: true }));
        });
      } catch (e) {
        this.sock = null;
        resolve(fail(e, { connected: false }));
      }
    });
  }

  /**
   * Manual disconnect.
   * - Stops streaming (removes 'data' handler) and resets reading=false.
   * - Unregisters the 'close' handler before destroy() to avoid duplicate disconnect events.
   * - Notifies the renderer with a 'manual' disconnect event.
   */
  async disconnect(): Promise<Std<{ disconnected: boolean; reading?: boolean }>> {
    await this.stopRead(); // sets this.reading = false

    const s = this.sock;
    this.sock = null;

    if (s) {
      // Unhook the close listener before destroy so we don't emit a second event.
      if (this.onClose) { s.off('close', this.onClose); this.onClose = undefined; }
      try { s.destroy(); } catch { /* ignore */ }
      this.notifyDisconnectManual();
    }

    return ok({ disconnected: true, reading: false });
  }

  /** Quick connection status (main process side). */
  async isConnected(): Promise<Std<{ connected: boolean }>> {
    return ok({ connected: this.isOpen() });
  }

  /** Whether stream reading is currently enabled from the renderer's perspective. */
  async isReading(): Promise<Std<{ reading: boolean }>> {
    return ok({ reading: this.reading });
  }

  /**
   * Write raw bytes to the socket.
   * - Fails if no connection or an RR cycle is active.
   * - Uses Node's write callback to resolve success/failure.
   */
  async write(args: { data: number[] }): Promise<Std<{ bytesWritten: number }>> {
    if (!this.isOpen() || !this.sock) return fail('not connected', { bytesWritten: 0 });
    if (this.rrInFlight) return fail('busy', { bytesWritten: 0 });

    const buf = this.jsArrToBuf(args.data || []);
    return new Promise<Std<{ bytesWritten: number }>>((resolve) => {
      this.sock!.write(buf, (err) => {
        if (err) resolve(fail(`write failed: ${err.message}`, { bytesWritten: 0 }));
        else resolve(ok({ bytesWritten: buf.length }));
      });
    });
  }

  /**
   * Start streaming read.
   * - Attaches a 'data' handler that slices large frames into `lastChunkSize` parts,
   *   emitting multiple tcpData events to the renderer.
   * - Idempotent: if already reading, returns reading:true without changing handlers.
   */
  async startRead(args: { chunkSize?: number; readTimeoutMs?: number }): Promise<Std<{ reading: boolean }>> {
    if (!this.isOpen() || !this.sock) return ok({ reading: false });
    if (this.reading) return ok({ reading: true });
    this.reading = true;
    this.lastChunkSize = Math.max(1, args?.chunkSize ?? 4096);
    if (args?.readTimeoutMs != null) this.readTimeoutMs = Math.max(1, args.readTimeoutMs);

    // Respect lastChunkSize: split larger buffers into smaller event-sized pieces.
    this.streamDataHandler = (chunk: Buffer) => {
      const lim = this.lastChunkSize;
      for (let off = 0; off < chunk.length; off += lim) {
        const part = chunk.subarray(off, Math.min(off + lim, chunk.length));
        this.sendEvent('tcpData', { data: Array.from(part.values()) });
      }
    };
    this.sock.on('data', this.streamDataHandler);
    return ok({ reading: true });
  }

  /** Stop streaming read and remove the current 'data' handler (if any). */
  async stopRead(): Promise<Std<{ reading: boolean }>> {
    if (this.sock && this.streamDataHandler) {
      this.sock.off('data', this.streamDataHandler);
    }
    this.streamDataHandler = undefined;
    this.reading = false;
    return ok({ reading: false });
  }

  /** Store a logical read timeout used by the RR helper. */
  async setReadTimeout(args: { ms: number }): Promise<Std> {
    this.readTimeoutMs = Math.max(1, args?.ms ?? 1000);
    return ok();
  }

  /**
   * Request/Response helper:
   * - Optionally suspends streaming to avoid the stream consumer stealing the response.
   * - Accumulates chunks until:
   *   a) `expect` pattern appears, or
   *   b) `maxBytes` reached, or
   *   c) timeout fires.
   * - Ensures cleanup of listeners and internal flags in all paths.
   */
  async writeAndRead(args: {
    data: number[];
    timeoutMs?: number;
    maxBytes?: number;
    expect?: ExpectType;
    suspendStreamDuringRR?: boolean;
  }): Promise<Std<{ data: number[]; bytesWritten: number | null; bytesRead: number | null }>> {
    if (!this.isOpen() || !this.sock) {
      return fail('not connected', { data: [], bytesWritten: null, bytesRead: null });
    }
    if (this.rrInFlight) {
      return fail('busy', { data: [], bytesWritten: null, bytesRead: null });
    }
    this.rrInFlight = true;

    const timeout = Math.max(1, args.timeoutMs ?? this.readTimeoutMs ?? 1000);
    const cap = Math.max(1, args.maxBytes ?? 4096);
    const expectUA = parseExpectBytes(args.expect);
    const expectBuf = expectUA ? Buffer.from(expectUA) : null;

    const s = this.sock!;
    const wasReading = this.reading;
    const shouldSuspend = !!(args.suspendStreamDuringRR ?? true) && wasReading;

    // Temporarily unhook streaming so the RR listener exclusively consumes data.
    if (shouldSuspend && this.streamDataHandler) {
      s.off('data', this.streamDataHandler);
    }

    const reqBuf = this.jsArrToBuf(args.data || []);
    const bytesWritten = reqBuf.length;

    return new Promise<Std<{ data: number[]; bytesWritten: number | null; bytesRead: number | null }>>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const chunks: Buffer[] = [];

      const finish = (out: Buffer | null, err?: string) => {
        if (timer) { clearTimeout(timer); timer = null; }
        s.off('data', onData);
        s.off('error', onError);
        s.off('close', onClose);
        // Restore streaming if we suspended it.
        if (shouldSuspend && this.streamDataHandler) {
          s.on('data', this.streamDataHandler);
        }
        this.rrInFlight = false;

        if (err) {
          resolve(fail(err, { data: [], bytesWritten, bytesRead: null }));
        } else {
          const resBuf = (out ?? Buffer.alloc(0)).subarray(0, cap);
          resolve(ok({ data: Array.from(resBuf.values()), bytesWritten, bytesRead: resBuf.length }));
        }
      };

      // Accumulate data; if 'expect' is set, search for it; otherwise return first chunk.
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const current = Buffer.concat(chunks);
        if (expectBuf) {
          if (current.indexOf(expectBuf) >= 0 || current.length >= cap) {
            finish(current);
          }
        } else {
          finish(current);
        }
      };

      const onError = (err: Error) => finish(null, `writeAndRead failed: ${err.message}`);
      const onClose = () => finish(null, 'connection closed');

      // Emulate read timeout with a single-shot timer.
      timer = setTimeout(() => finish(null, 'connect timeout'), timeout);

      s.on('data', onData);
      s.once('error', onError);
      s.once('close', onClose);

      // Fire the request; if write fails, bail out and clean up.
      s.write(reqBuf, (err) => {
        if (err) finish(null, `write failed: ${err.message}`);
      });
    });
  }
}
