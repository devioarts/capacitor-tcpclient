import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

import type {
  TCPClientPlugin,
  TCPConnection,
  TcpCreateConnectionOptions,
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
  TcpDataEvent,
  TcpDisconnectEvent,
} from './definitions';

// Internal bridge interface — native receives connectionId on every call
interface _Bridge {
  getPlatform(): Promise<TcpGetPlatformResult>;
  connect(opts: TcpConnectOptions & { connectionId: string }): Promise<TcpConnectResult>;
  disconnect(opts: { connectionId: string }): Promise<TcpDisconnectResult>;
  isConnected(opts: { connectionId: string }): Promise<TcpIsConnectedResult>;
  isReading(opts: { connectionId: string }): Promise<TcpIsReadingResult>;
  write(opts: TcpWriteOptions & { connectionId: string }): Promise<TcpWriteResult>;
  writeAndRead(opts: TcpWriteAndReadOptions & { connectionId: string }): Promise<TcpWriteAndReadResult>;
  startRead(opts: TcpStartReadOptions & { connectionId: string }): Promise<TcpStartStopResult>;
  stopRead(opts: { connectionId: string }): Promise<TcpStartStopResult>;
  setReadTimeout(opts: {
    readTimeout: number;
    connectionId: string;
  }): Promise<{ error: boolean; errorMessage?: string | null }>;
  destroyConnection(opts: { connectionId: string }): Promise<void>;
  addListener(eventName: string, listenerFunc: (event: any) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

const _bridge = registerPlugin<_Bridge>('TCPClient', {
  web: () => import('./web').then((m) => new m.TCPClientWeb()),
  electron: () => Promise.resolve((window as any).CapacitorCustomPlatform.plugins.TCPClient as _Bridge),
});

function _uuid(): string {
  if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
    return (crypto as any).randomUUID() as string;
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Registry: connectionId → instance (allows createConnection to return existing instances by id)
const _registry = new Map<string, _TCPConnection>();

class _TCPConnection implements TCPConnection {
  readonly connectionId: string;
  private readonly _defaults: Partial<TcpConnectOptions>;
  private _handles: PluginListenerHandle[] = [];

  constructor(connectionId: string, defaults: Partial<TcpConnectOptions> = {}) {
    this.connectionId = connectionId;
    this._defaults = defaults;
  }

  connect(options: Partial<TcpConnectOptions> = {}): Promise<TcpConnectResult> {
    const merged = { ...this._defaults, ...options };
    if (!merged.host) return Promise.resolve({ error: true, errorMessage: 'host is required', connected: false });
    return _bridge.connect({ ...(merged as TcpConnectOptions), connectionId: this.connectionId });
  }

  disconnect(): Promise<TcpDisconnectResult> {
    return _bridge.disconnect({ connectionId: this.connectionId });
  }

  isConnected(): Promise<TcpIsConnectedResult> {
    return _bridge.isConnected({ connectionId: this.connectionId });
  }

  isReading(): Promise<TcpIsReadingResult> {
    return _bridge.isReading({ connectionId: this.connectionId });
  }

  write(options: TcpWriteOptions): Promise<TcpWriteResult> {
    return _bridge.write({ ...options, connectionId: this.connectionId });
  }

  writeAndRead(options: TcpWriteAndReadOptions): Promise<TcpWriteAndReadResult> {
    return _bridge.writeAndRead({ ...options, connectionId: this.connectionId });
  }

  startRead(options: TcpStartReadOptions = {}): Promise<TcpStartStopResult> {
    return _bridge.startRead({ ...options, connectionId: this.connectionId });
  }

  stopRead(): Promise<TcpStartStopResult> {
    return _bridge.stopRead({ connectionId: this.connectionId });
  }

  setReadTimeout(options: { readTimeout: number }): Promise<{ error: boolean; errorMessage?: string | null }> {
    return _bridge.setReadTimeout({ ...options, connectionId: this.connectionId });
  }

  async addListener(eventName: 'tcpData', listenerFunc: (event: TcpDataEvent) => void): Promise<PluginListenerHandle>;
  async addListener(
    eventName: 'tcpDisconnect',
    listenerFunc: (event: TcpDisconnectEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: 'tcpData' | 'tcpDisconnect',
    listenerFunc: (event: any) => void,
  ): Promise<PluginListenerHandle> {
    const id = this.connectionId;
    // Filter: only deliver events that belong to this connection
    const wrapped = (event: any) => {
      if (event.connectionId === id) listenerFunc(event);
    };
    const raw = await _bridge.addListener(eventName, wrapped);
    // Capacitor bridge returns PluginListenerHandle; Electron preload returns a string id
    const handle: PluginListenerHandle =
      typeof raw === 'string'
        ? {
            remove: async () => {
              (_bridge as any).removeListener?.(raw);
            },
          }
        : (raw as unknown as PluginListenerHandle);
    const ownHandle: PluginListenerHandle = {
      remove: async () => {
        await handle.remove();
        this._handles = this._handles.filter((h) => h !== ownHandle);
      },
    };
    this._handles.push(ownHandle);
    return ownHandle;
  }

  async removeAllListeners(): Promise<void> {
    await Promise.all(this._handles.map((h) => h.remove()));
    this._handles = [];
  }

  async destroy(): Promise<void> {
    await this.disconnect().catch(() => {
      /* idempotent — already disconnected is fine */
    });
    await this.removeAllListeners();
    _registry.delete(this.connectionId);
    await _bridge.destroyConnection({ connectionId: this.connectionId });
  }
}

const TCPClient: TCPClientPlugin = {
  createConnection(options: TcpCreateConnectionOptions = {}): TCPConnection {
    const { connectionId, ...connectDefaults } = options;
    const id = connectionId ?? _uuid();
    const existing = _registry.get(id);
    if (existing) return existing;
    const conn = new _TCPConnection(id, connectDefaults);
    _registry.set(id, conn);
    return conn;
  },

  getPlatform(): Promise<TcpGetPlatformResult> {
    return _bridge.getPlatform();
  },
};

export * from './definitions';
export { TCPClient };
