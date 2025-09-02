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
   * - `error`: operation status
   * - `errorMessage`: human-readable error or null on success
   *
   * Tip: Extra fields for each call are carried via a generic type parameter.
   */

  type TCPStd<T extends object = Record<string, unknown>> = { error: boolean; errorMessage: string | null } & T;

  /**
   * Preload-injected API surface.
   * Each method returns a Promise that resolves to the standardized TCPStd<T> shape.
   * Events are delivered via addListener and can be unsubscribed with the remove() handle.
   */
  interface Window {
    TCPClient: {
      /**
       * Open a TCP connection.
       * Defaults:
       * - port: 9100
       * - timeout: 3000
       * - noDelay: true
       * - keepAlive: true
       */
      connect(args: {
        host: string;
        port?: number;
        timeout?: number;
        noDelay?: boolean;
        keepAlive?: boolean;
      }): Promise<TCPStd<{ connected: boolean }>>;

      /** Close the current connection; also reports { reading:false } for UI parity. */
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
        readTimeout?: number; // logical read timeout used by the main process helper
      }): Promise<TCPStd<{ reading: boolean }>>;

      /** Stop continuous reading. */
      stopRead(): Promise<TCPStd<{ reading: boolean }>>;

      /** Configure logical read readTimeout in milliseconds (used by request/response helper). */
      setReadTimeout(args: { readTimeout: number }): Promise<TCPStd>;

      /**
       * Request/Response helper: write bytes and collect a reply with optional early-exit pattern.
       * - `expect` accepts a hex string or number[].
       * - On timeout, bytesWritten may still be non-null while bytesRead is null.
       */
      writeAndRead(args: {
        data: number[];
        timeout?: number;
        maxBytes?: number;
        expect?: string | number[];
        suspendStreamDuringRR?: boolean;
      }): Promise<TCPStd<{ data: number[]; bytesSent: number | null; bytesReceived: number | null; matched: boolean }>>;

      /**
       * Subscribe to native events forwarded from the main process:
       * - 'tcpData': { data:number[] }
       * - 'tcpDisconnect': { disconnected:true, reason:'manual'|'remote'|'error', error? }
       */
      addListener(event: 'tcpData' | 'tcpDisconnect', cb: (payload: unknown) => void): { remove: () => void };

      /** Remove all event listeners registered via this bridge. */
      removeAllListeners(): Promise<void>;
    };
  }
}
