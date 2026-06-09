// global.d.ts

// Mark this file as a module to avoid augmenting the global scope unintentionally.
// This also prevents duplicate identifier errors when consumed by TS projects.
export {};
// https://github.com/devioarts/capacitor-tcpclient
// https://github.com/devioarts/capacitor-tcpclient/tree/main

/**
 * Global ambient declarations for the Electron preload API exposed on window.TCPClient.
 * Consumers can import nothing and still benefit from IntelliSense / type-safety.
 */
declare global {
  /**
   * Standard result envelope shared by all API calls.
   * - `error`:        operation status
   * - `errorMessage`: human-readable error or null on success
   *
   * Extra fields per call are carried via a generic type parameter.
   */
  type TCPStd<T extends object = Record<string, unknown>> = { error: boolean; errorMessage: string | null } & T;

  /**
   * A single TCP connection returned by window.TCPClient.createConnection().
   * Each instance has its own socket, event listeners, and connectionId.
   */
  interface TCPElectronConnection {
    /** Stable identifier for this connection, set at creation time. */
    readonly connectionId: string;

    /**
     * Open a TCP connection.
     * Defaults: port=9100, timeout=3000 ms, noDelay=true, keepAlive=true.
     */
    connect(args: {
      host: string;
      port?: number;
      timeout?: number;
      noDelay?: boolean;
      keepAlive?: boolean;
    }): Promise<TCPStd<{ connected: boolean }>>;

    /** Close the current connection. Idempotent. */
    disconnect(): Promise<TCPStd<{ disconnected: boolean; reading?: boolean }>>;

    /** Quick connection health check. */
    isConnected(): Promise<TCPStd<{ connected: boolean }>>;

    /** Whether the streaming reader is currently active. */
    isReading(): Promise<TCPStd<{ reading: boolean }>>;

    /** Write raw bytes. */
    write(args: { data: number[] }): Promise<TCPStd<{ bytesSent: number }>>;

    /**
     * Begin continuous reading. Large frames may be split into multiple events
     * according to the configured chunkSize.
     */
    startRead(args?: {
      chunkSize?: number;
      readTimeout?: number;
    }): Promise<TCPStd<{ reading: boolean }>>;

    /** Stop continuous reading. */
    stopRead(): Promise<TCPStd<{ reading: boolean }>>;

    /** Configure logical read timeout in milliseconds (used by writeAndRead). */
    setReadTimeout(args: { readTimeout: number }): Promise<TCPStd>;

    /**
     * Request/Response helper: write bytes and collect a reply with optional early-exit pattern.
     * - `expect` accepts a hex string (e.g. "1B40") or number[].
     * - On timeout with partial data, bytesSent is non-null while bytesReceived reflects actual bytes.
     */
    writeAndRead(args: {
      data: number[];
      timeout?: number;
      maxBytes?: number;
      expect?: string | number[];
      suspendStreamDuringRR?: boolean;
    }): Promise<TCPStd<{ data: number[]; bytesSent: number | null; bytesReceived: number | null; matched: boolean }>>;

    /**
     * Subscribe to native events forwarded from the main process.
     * Only events belonging to this connection are delivered.
     *  - 'tcpData':       { connectionId, data:number[] }
     *  - 'tcpDisconnect': { connectionId, disconnected:true, reason:'manual'|'remote'|'error', error? }
     * Returns a handle with remove() for cleanup.
     */
    addListener(event: 'tcpData' | 'tcpDisconnect', cb: (payload: unknown) => void): { remove: () => void };

    /** Remove all listeners registered via addListener on this connection. */
    removeAllListeners(): Promise<void>;

    /**
     * Disconnect, remove all listeners, and release this connection
     * from the main-process registry.
     */
    destroy(): Promise<void>;
  }

  interface Window {
    /**
     * Preload-injected TCP client API (multi-connection).
     * Exposed via contextBridge.exposeInMainWorld('TCPClient', createTCPClientAPI({ ipcRenderer })).
     */
    TCPClient: {
      /**
       * Create a connection-scoped API for the given connectionId.
       * The connectionId should be a stable, unique string (e.g. a UUID).
       * You are responsible for generating it — use crypto.randomUUID() or similar.
       */
      createConnection(connectionId: string): TCPElectronConnection;
    };
  }
}
