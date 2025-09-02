/*
 * Electron main-process TCP client bridge.
 *
 * Responsibilities:
 * - Manage a single net.Socket lifecycle (connect/disconnect) with TCP_NODELAY and KEEPALIVE.
 * - Provide a strict request/response API with timeout, optional pattern match, and byte cap.
 * - Stream reader: micro-batch incoming data (10ms window, 16KB cap) to minimize IPC overhead,
 *   then split into consumer-sized slices (<= lastChunkSize) before emitting tcpData to renderer.
 * - IPC contract: handle `ipcMain.handle('tcpclient:*')` requests and emit `tcpclient:event:*`
 *   notifications to the renderer.
 * - Error policy: methods resolve with { error, errorMessage, ... } payloads; no exceptions cross IPC.
 */

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import net from 'net';

import type { ExpectInput } from '../src/utils/expect';
import { parseExpectBytes } from '../src/utils/expect';

type ExpectType = ExpectInput;

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

export class TCPClient {
  private win: BrowserWindow;
  private sock: net.Socket | null = null;
  private reading = false;
  private rrInFlight = false;
  private streamDataHandler?: (chunk: Buffer) => void;
  private onClose?: (hadErr: boolean) => void;

  private lastChunkSize = 4096;
  private readTimeout = 1000;

  // iOS-like micro-batching
  private readonly mergeWindowMs = 10;
  private readonly mergeMaxBytes = 16 * 1024;
  private pendingChunks: Buffer[] = [];
  private pendingSize = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(win: BrowserWindow) {
    this.win = win;

    ipcMain.handle('tcpclient:connect', (_e, args) => this.connect(args));
    ipcMain.handle('tcpclient:disconnect', () => this.disconnect());
    ipcMain.handle('tcpclient:isConnected', () => this.isConnected());
    ipcMain.handle('tcpclient:isReading', () => this.isReading());
    ipcMain.handle('tcpclient:write', (_e, args) => this.write(args));
    ipcMain.handle('tcpclient:startRead', (_e, args) => this.startRead(args));
    ipcMain.handle('tcpclient:stopRead', () => this.stopRead());
    ipcMain.handle('tcpclient:setReadTimeout', (_e, args) => this.setReadTimeout(args));
    ipcMain.handle('tcpclient:writeAndRead', (_e, args) => this.writeAndRead(args));
  }

  private sendEvent(name: 'tcpData' | 'tcpDisconnect', payload: any) {
    this.win.webContents.send(`tcpclient:event:${name}`, payload);
  }
  private isOpen() {
    const s = this.sock;
    return !!s && !s.destroyed && !s.connecting;
  }
  private jsArrToBuf(arr: number[]) {
    return Buffer.from(arr.map((n) => n & 0xff));
  }

  private notifyDisconnectManual() {
    this.sendEvent('tcpDisconnect', { reason: 'manual', disconnected: true });
  }
  private notifyDisconnectRemote() {
    this.sendEvent('tcpDisconnect', { reason: 'remote', disconnected: true });
  }
  private notifyDisconnectError(err: string) {
    this.sendEvent('tcpDisconnect', { reason: 'error', error: err, disconnected: true });
  }

  async connect(args: {
    host: string;
    port?: number;
    timeout?: number;
    noDelay?: boolean;
    keepAlive?: boolean;
  }): Promise<Std<{ connected: boolean }>> {
    const host = args.host;
    const port = args.port ?? 9100;
    const timeout = args.timeout ?? 3000;
    const noDelay = args.noDelay ?? true;
    const keepAlive = args.keepAlive ?? true;

    await this.disconnect();

    return new Promise<Std<{ connected: boolean }>>((resolve) => {
      try {
        const s = new net.Socket();
        this.sock = s;

        let connectTimer: NodeJS.Timeout | null = setTimeout(
          () => {
            connectTimer = null;
            try {
              s.destroy(new Error('connect timeout'));
            } catch {
              /* ignore */
            }
            if (this.sock === s) this.sock = null;
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
          if (this.sock === s) this.sock = null;
          resolve(fail(`connect failed: ${err.message}`, { connected: false }));
        };
        s.once('error', onError);

        s.connect({ host, port }, () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          s.removeListener('error', onError);

          this.onClose = (hadErr: boolean) => {
            if (this.streamDataHandler) {
              s.off('data', this.streamDataHandler);
              this.streamDataHandler = undefined;
            }
            this.reading = false;
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

  async disconnect(): Promise<Std<{ disconnected: boolean; reading?: boolean }>> {
    await this.stopRead();

    const s = this.sock;
    this.sock = null;

    if (s) {
      if (this.onClose) {
        s.off('close', this.onClose);
        this.onClose = undefined;
      }
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      this.notifyDisconnectManual();
    }
    return ok({ disconnected: true, reading: false });
  }

  async isConnected(): Promise<Std<{ connected: boolean }>> {
    return ok({ connected: this.isOpen() });
  }

  async isReading(): Promise<Std<{ reading: boolean }>> {
    return ok({ reading: this.reading });
  }

  async write(args: { data: number[] }): Promise<Std<{ bytesSent: number }>> {
    if (!this.isOpen() || !this.sock) return fail('not connected', { bytesSent: 0 });
    if (this.rrInFlight) return fail('busy', { bytesSent: 0 });

    const buf = this.jsArrToBuf(args.data || []);
    return new Promise<Std<{ bytesSent: number }>>((resolve) => {
      if (!this.sock) return resolve(fail('not connected', { bytesSent: 0 }));
      this.sock.write(buf, (err) => {
        if (err) resolve(fail(`write failed: ${err.message}`, { bytesSent: 0 }));
        else resolve(ok({ bytesSent: buf.length }));
      });
    });
  }

  // --- micro-batch helpers ---
  private flushPendingNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingSize > 0) {
      const payload = Buffer.concat(this.pendingChunks, this.pendingSize);
      this.pendingChunks = [];
      this.pendingSize = 0;
      const lim = Math.max(1, this.lastChunkSize || 4096);
      for (let off = 0; off < payload.length; off += lim) {
        const part = payload.subarray(off, Math.min(off + lim, payload.length));
        this.sendEvent('tcpData', { data: Array.from(part.values()) });
      }
    }
  }
  private scheduleFlush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPendingNow();
    }, this.mergeWindowMs);
  }

  async startRead(args: { chunkSize?: number; readTimeout?: number }): Promise<Std<{ reading: boolean }>> {
    if (!this.isOpen() || !this.sock) return ok({ reading: false });
    if (this.reading) return ok({ reading: true });

    this.reading = true;
    this.lastChunkSize = Math.max(1, args?.chunkSize ?? 4096);
    if (args?.readTimeout != null) this.readTimeout = Math.max(1, args.readTimeout);

    // reset batch state
    this.pendingChunks = [];
    this.pendingSize = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.streamDataHandler = (chunk: Buffer) => {
      // iOS-like micro-batch: buffer + debounce 10ms, flush if >16KB
      this.pendingChunks.push(chunk);
      this.pendingSize += chunk.length;
      if (this.pendingSize >= this.mergeMaxBytes) {
        this.flushPendingNow();
      } else {
        this.scheduleFlush();
      }
    };
    this.sock.on('data', this.streamDataHandler);
    return ok({ reading: true });
  }

  async stopRead(): Promise<Std<{ reading: boolean }>> {
    if (this.sock && this.streamDataHandler) {
      this.sock.off('data', this.streamDataHandler);
    }
    this.streamDataHandler = undefined;
    // flush anything buffered
    this.flushPendingNow();
    this.reading = false;
    return ok({ reading: false });
  }

  async setReadTimeout(args: { readTimeout: number }): Promise<Std> {
    this.readTimeout = Math.max(1, args?.readTimeout ?? 1000);
    return ok();
  }

  async writeAndRead(args: {
    data: number[];
    timeout?: number;
    maxBytes?: number;
    expect?: ExpectType;
    suspendStreamDuringRR?: boolean;
  }): Promise<Std<{ data: number[]; bytesSent: number | null; bytesReceived: number | null; matched: boolean }>> {
    if (!this.isOpen() || !this.sock) {
      return fail('not connected', { data: [], bytesSent: null, bytesReceived: null, matched: false });
    }
    if (this.rrInFlight) {
      return fail('busy', { data: [], bytesSent: null, bytesReceived: null, matched: false });
    }
    this.rrInFlight = true;

    const timeout = Math.max(1, args.timeout ?? this.readTimeout ?? 1000);
    const cap = Math.max(1, args.maxBytes ?? 4096);
    const expectUA = parseExpectBytes(args.expect);
    const expectBuf = expectUA ? Buffer.from(expectUA) : null;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const s = this.sock!;
    const wasReading = this.reading;
    const shouldSuspend = !!(args.suspendStreamDuringRR ?? true) && wasReading;

    if (shouldSuspend && this.streamDataHandler && this.isOpen() && this.reading) {
      s.on('data', this.streamDataHandler);
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
      const interArr: number[] = []; // ms, keep last 5
      const currentIdleMs = () => {
        if (interArr.length === 0) return 50;
        const sorted = [...interArr].sort((a, b) => a - b);
        const med =
          sorted.length % 2
            ? sorted[(sorted.length / 2) | 0]
            : 0.5 * (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]);
        const thr = Math.round(med * 1.75);
        return Math.max(50, Math.min(200, thr));
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
        if (shouldSuspend && this.streamDataHandler) {
          s.on('data', this.streamDataHandler);
        }
        this.rrInFlight = false;

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
          const idx = current.indexOf(expectBuf);
          if (idx >= 0) {
            matched = true;
            finish(current);
            return;
          }
          if (current.length >= cap) {
            matched = false;
            finish(current);
            return;
          }
          // keep waiting for more
          return;
        }

        // bez expect: adaptivní until-idle
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
