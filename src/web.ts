import type { PluginListenerHandle } from '@capacitor/core';
import { WebPlugin } from '@capacitor/core';

import type {
  TcpConnectOptions,
  TcpConnectResult,
  TcpDisconnectResult,
  TcpGetPlatformResult,
  TcpIsConnectedResult,
  TcpIsReadingResult,
  TcpWriteOptions,
  TcpWriteResult,
  TcpWriteAndReadOptions,
  TcpWriteAndReadResult,
  TcpStartReadOptions,
  TcpStartStopResult,
} from './definitions';

type BaseResult = { error: boolean; errorMessage?: string | null };

function ok<T extends Record<string, unknown>>(extra: T = {} as T): BaseResult & T {
  return { error: false, errorMessage: null, ...extra };
}

function log(...a: unknown[]) {
  console.debug('[TCPClient]', ...a);
}

export class TCPClientWeb extends WebPlugin {
  async connect(args: TcpConnectOptions & { connectionId: string }): Promise<TcpConnectResult> {
    log('[connect]', args);
    return ok({ connected: true });
  }

  async disconnect(args: { connectionId: string }): Promise<TcpDisconnectResult> {
    log('[disconnect]', args.connectionId);
    return ok({ disconnected: true, reading: false });
  }

  async isConnected(args: { connectionId: string }): Promise<TcpIsConnectedResult> {
    log('[isConnected]', args.connectionId);
    return ok({ connected: true });
  }

  async isReading(args: { connectionId: string }): Promise<TcpIsReadingResult> {
    log('[isReading]', args.connectionId);
    return ok({ reading: false });
  }

  async write(args: TcpWriteOptions & { connectionId: string }): Promise<TcpWriteResult> {
    const data = Array.from(args.data as unknown as number[]);
    log('[write]', args.connectionId, data.length, 'bytes');
    return ok({ bytesSent: data.length });
  }

  async startRead(args: TcpStartReadOptions & { connectionId: string }): Promise<TcpStartStopResult> {
    log('[startRead]', args.connectionId);
    return ok({ reading: true });
  }

  async stopRead(args: { connectionId: string }): Promise<TcpStartStopResult> {
    log('[stopRead]', args.connectionId);
    return ok({ reading: false });
  }

  async setReadTimeout(args: { readTimeout: number; connectionId: string }): Promise<BaseResult> {
    log('[setReadTimeout]', args.connectionId, args.readTimeout);
    return ok();
  }

  async writeAndRead(args: TcpWriteAndReadOptions & { connectionId: string }): Promise<TcpWriteAndReadResult> {
    const data = Array.from(args.data as unknown as number[]);
    log('[writeAndRead]', args.connectionId, data.length, 'bytes');
    return ok({ bytesSent: data.length, bytesReceived: 0, data: [], matched: false });
  }

  async getPluginPlatform(): Promise<TcpGetPlatformResult> {
    return ok({ platform: 'web' as const });
  }

  async destroyConnection(args: { connectionId: string }): Promise<void> {
    log('[destroyConnection]', args.connectionId);
  }

  async addListener(
    eventName: 'tcpData' | 'tcpDisconnect',
    listenerFunc: (event: unknown) => void,
  ): Promise<PluginListenerHandle> {
    void listenerFunc;
    return {
      remove: async () => {
        log('[removeListener]', eventName);
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    // no-op for browser
  }
}
