import type { PluginListenerHandle } from '@capacitor/core';
import { WebPlugin } from '@capacitor/core';

import type {
  TcpConnectOptions,
  TcpConnectResult,
  TcpDisconnectResult,
  TcpIsConnectedResult,
  TcpIsReadingResult,
  TcpWriteOptions,
  TcpWriteResult,
  TcpWriteAndReadOptions,
  TcpWriteAndReadResult,
  TcpStartReadOptions,
  TcpStartStopResult,
} from './definitions';

/**
 * Contract the Electron preload exposes as `window.TCPClient`.
 * Methods accept connectionId for multi-instance routing.
 */
type ElectronBridge = {
  connect(a: TcpConnectOptions & { connectionId: string }): Promise<TcpConnectResult>;
  disconnect(a: { connectionId: string }): Promise<TcpDisconnectResult>;
  isConnected(a: { connectionId: string }): Promise<TcpIsConnectedResult>;
  isReading(a: { connectionId: string }): Promise<TcpIsReadingResult>;
  write(a: TcpWriteOptions & { connectionId: string }): Promise<TcpWriteResult>;
  startRead(a: TcpStartReadOptions & { connectionId: string }): Promise<TcpStartStopResult>;
  stopRead(a: { connectionId: string }): Promise<TcpStartStopResult>;
  setReadTimeout(a: {
    readTimeout: number;
    connectionId: string;
  }): Promise<{ error: boolean; errorMessage?: string | null }>;
  writeAndRead(a: TcpWriteAndReadOptions & { connectionId: string }): Promise<TcpWriteAndReadResult>;
  destroyConnection(a: { connectionId: string }): Promise<void>;
  addListener(event: 'tcpData' | 'tcpDisconnect', cb: (payload: any) => void): { remove(): void };
  removeAllListeners(): Promise<void>;
};

const electronApi = (globalThis as any).TCPClient as ElectronBridge | undefined;

type BaseResult = { error: boolean; errorMessage?: string | null };

function ok<T extends Record<string, unknown>>(extra: T = {} as T): BaseResult & T {
  return { error: false, errorMessage: null, ...extra };
}

function log(...a: any[]) {
  console.debug('[TCPClient]', ...a);
}

/**
 * Web/Electron implementation of the native bridge.
 * - In Electron: proxies to the preload `window.TCPClient` API (which must also accept connectionId).
 * - In browsers: no-op mock for development and previews.
 */
export class TCPClientWeb extends WebPlugin {
  async connect(args: TcpConnectOptions & { connectionId: string }): Promise<TcpConnectResult> {
    if (electronApi) return electronApi.connect(args);
    log('[connect]', args);
    return ok({ connected: true });
  }

  async disconnect(args: { connectionId: string }): Promise<TcpDisconnectResult> {
    if (electronApi) return electronApi.disconnect(args);
    log('[disconnect]', args.connectionId);
    return ok({ disconnected: true, reading: false });
  }

  async isConnected(args: { connectionId: string }): Promise<TcpIsConnectedResult> {
    if (electronApi) return electronApi.isConnected(args);
    log('[isConnected]', args.connectionId);
    return ok({ connected: true });
  }

  async isReading(args: { connectionId: string }): Promise<TcpIsReadingResult> {
    if (electronApi) return electronApi.isReading(args);
    log('[isReading]', args.connectionId);
    return ok({ reading: false });
  }

  async write(args: TcpWriteOptions & { connectionId: string }): Promise<TcpWriteResult> {
    const data = Array.from(args.data as any) as number[];
    if (electronApi) return electronApi.write({ ...args, data });
    log('[write]', args.connectionId, data.length, 'bytes');
    return ok({ bytesSent: data.length });
  }

  async startRead(args: TcpStartReadOptions & { connectionId: string }): Promise<TcpStartStopResult> {
    if (electronApi) return electronApi.startRead(args);
    log('[startRead]', args.connectionId);
    return ok({ reading: true });
  }

  async stopRead(args: { connectionId: string }): Promise<TcpStartStopResult> {
    if (electronApi) return electronApi.stopRead(args);
    log('[stopRead]', args.connectionId);
    return ok({ reading: false });
  }

  async setReadTimeout(args: { readTimeout: number; connectionId: string }): Promise<BaseResult> {
    if (electronApi) return electronApi.setReadTimeout(args);
    log('[setReadTimeout]', args.connectionId, args.readTimeout);
    return ok();
  }

  async writeAndRead(args: TcpWriteAndReadOptions & { connectionId: string }): Promise<TcpWriteAndReadResult> {
    const data = Array.from(args.data as any) as number[];
    if (electronApi) {
      return electronApi.writeAndRead({
        ...args,
        data,
        timeout: args.timeout ?? 1000,
        maxBytes: args.maxBytes ?? 4096,
        suspendStreamDuringRR: args.suspendStreamDuringRR ?? true,
      });
    }
    log('[writeAndRead]', args.connectionId, data.length, 'bytes');
    return ok({ bytesSent: data.length, bytesReceived: 0, data: [], matched: false });
  }

  async destroyConnection(args: { connectionId: string }): Promise<void> {
    if (electronApi) return electronApi.destroyConnection(args);
    log('[destroyConnection]', args.connectionId);
  }

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
        log('[removeListener]', eventName);
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    if (electronApi?.removeAllListeners) await electronApi.removeAllListeners();
  }
}
