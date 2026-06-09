/**
 * Electron preload-side bridge — multi-connection variant.
 *
 * Exposes window.TCPClient.createConnection(connectionId) to the renderer.
 * Each call returns a frozen, connection-scoped API that automatically attaches
 * connectionId to every IPC invoke and filters incoming events to those that
 * belong to this specific connection.
 *
 * Usage in preload.js:
 *
 *   const { contextBridge, ipcRenderer } = require('electron');
 *   const { createTCPClientAPI } = require('@devioarts/capacitor-tcpclient/electron/tcpclient-bridge.cjs');
 *   contextBridge.exposeInMainWorld('TCPClient', createTCPClientAPI({ ipcRenderer }));
 */
// eslint-disable-next-line no-undef
module.exports.createTCPClientAPI = ({ ipcRenderer }) => {
  /**
   * Standard success result.
   */
  const ok = (extra = {}) => ({ error: false, errorMessage: null, ...extra });

  /**
   * Standard failure result.
   */
  const fail = (e, extra = {}) => {
    const msg = (e && (e.message || (typeof e === 'string' ? e : null))) || String(e || 'Error');
    return { error: true, errorMessage: msg, ...extra };
  };

  /**
   * Returns true when a value already has the { error, errorMessage } shape,
   * so we can pass it through verbatim without re-wrapping.
   */
  const hasStdShape = (x) => x && typeof x === 'object' && typeof x.error === 'boolean' && 'errorMessage' in x;

  // ---------------------------------------------------------------------------
  // Flat API — used by the Capacitor web layer (web.ts) which passes connectionId
  // explicitly in every call. Filtering by connectionId is done by index.ts, not here.
  // ---------------------------------------------------------------------------

  const _invoke = (channel, args) => ipcRenderer.invoke(channel, args);

  const flatApi = {
    async connect(args) {
      try {
        const res = await _invoke('tcpclient:connect', args);
        return hasStdShape(res) ? res : ok({ connected: !!(res?.connected) });
      } catch (e) { return fail(e, { connected: false }); }
    },
    async disconnect(args) {
      try {
        const res = await _invoke('tcpclient:disconnect', args);
        return hasStdShape(res) ? res : ok({ disconnected: true, reading: false });
      } catch (e) { return fail(e, { disconnected: false }); }
    },
    async isConnected(args) {
      try {
        const res = await _invoke('tcpclient:isConnected', args);
        return hasStdShape(res) ? res : ok({ connected: !!(res?.connected) });
      } catch (e) { return fail(e, { connected: false }); }
    },
    async isReading(args) {
      try {
        const res = await _invoke('tcpclient:isReading', args);
        return hasStdShape(res) ? res : ok({ reading: !!(res?.reading) });
      } catch (e) { return fail(e, { reading: false }); }
    },
    async write(args) {
      try {
        const res = await _invoke('tcpclient:write', args);
        return hasStdShape(res) ? res : ok({ bytesSent: +res?.bytesSent || 0 });
      } catch (e) { return fail(e, { bytesSent: 0 }); }
    },
    async startRead(args) {
      try {
        const res = await _invoke('tcpclient:startRead', args);
        return hasStdShape(res) ? res : ok({ reading: true });
      } catch (e) { return fail(e, { reading: false }); }
    },
    async stopRead(args) {
      try {
        const res = await _invoke('tcpclient:stopRead', args);
        return hasStdShape(res) ? res : ok({ reading: false });
      } catch (e) { return fail(e, { reading: true }); }
    },
    async setReadTimeout(args) {
      try {
        const res = await _invoke('tcpclient:setReadTimeout', args);
        return hasStdShape(res) ? res : ok();
      } catch (e) { return fail(e); }
    },
    async writeAndRead(args) {
      try {
        const res = await _invoke('tcpclient:writeAndRead', args);
        if (hasStdShape(res)) return res;
        const data = res?.data || [];
        return ok({ data, bytesSent: res?.bytesSent ?? null, bytesReceived: res?.bytesReceived ?? data.length, matched: !!res?.matched });
      } catch (e) { return fail(e, { data: [], bytesSent: null, bytesReceived: null, matched: false }); }
    },
    async destroyConnection(args) {
      try { await _invoke('tcpclient:destroyConnection', args); } catch { /* ignore */ }
    },
    // Global listener — no connectionId filter here; index.ts _TCPConnection wraps the
    // callback and filters by connectionId before delivering to the caller.
    addListener(event, cb) {
      const ch = `tcpclient:event:${event}`;
      const handler = (_ev, payload) => { try { cb(payload); } catch { } };
      ipcRenderer.on(ch, handler);
      return { remove: () => ipcRenderer.removeListener(ch, handler) };
    },
    removeAllListeners() {
      // Individual remove() calls (from PluginListenerHandle) handle cleanup.
      return Promise.resolve();
    },
  };

  return Object.freeze({
    // Flat API (Capacitor web.ts path) — spread first so createConnection can override nothing
    ...flatApi,

    /**
     * Create a connection-scoped API for a given connectionId.
     * All methods automatically include connectionId in their IPC payloads.
     * addListener delivers only events that belong to this connection.
     * Use this in renderer-only Electron apps (without Capacitor).
     */
    createConnection(connectionId) {
      // Track per-connection listeners so removeAllListeners is scoped.
      // Map<eventName, handler[]>
      const _handlers = new Map();

      return Object.freeze({
        get connectionId() { return connectionId; },

        /**
         * Open a TCP connection.
         * Returns { error, errorMessage, connected }.
         */
        async connect(args) {
          try {
            const res = await ipcRenderer.invoke('tcpclient:connect', { ...args, connectionId });
            return hasStdShape(res) ? res : ok({ connected: !!(res?.connected) });
          } catch (e) { return fail(e, { connected: false }); }
        },

        /**
         * Disconnect current session.
         * Returns { error, errorMessage, disconnected, reading:false }.
         */
        async disconnect() {
          try {
            const res = await ipcRenderer.invoke('tcpclient:disconnect', { connectionId });
            return hasStdShape(res) ? res : ok({ disconnected: true, reading: false });
          } catch (e) { return fail(e, { disconnected: false }); }
        },

        /**
         * Query connection status.
         * Returns { error, errorMessage, connected }.
         */
        async isConnected() {
          try {
            const res = await ipcRenderer.invoke('tcpclient:isConnected', { connectionId });
            return hasStdShape(res) ? res : ok({ connected: !!(res?.connected) });
          } catch (e) { return fail(e, { connected: false }); }
        },

        /**
         * Query stream-reading status.
         * Returns { error, errorMessage, reading }.
         */
        async isReading() {
          try {
            const res = await ipcRenderer.invoke('tcpclient:isReading', { connectionId });
            return hasStdShape(res) ? res : ok({ reading: !!(res?.reading) });
          } catch (e) { return fail(e, { reading: false }); }
        },

        /**
         * Write raw bytes to the socket.
         * Expects { data:number[] } and returns { error, errorMessage, bytesSent }.
         */
        async write(args) {
          try {
            const res = await ipcRenderer.invoke('tcpclient:write', { ...args, connectionId });
            return hasStdShape(res) ? res : ok({ bytesSent: +res?.bytesSent || 0 });
          } catch (e) { return fail(e, { bytesSent: 0 }); }
        },

        /**
         * Start continuous reading.
         * Accepts { chunkSize?, readTimeout? }.
         * Returns { error, errorMessage, reading }.
         */
        async startRead(args) {
          try {
            const res = await ipcRenderer.invoke('tcpclient:startRead', { ...args, connectionId });
            return hasStdShape(res) ? res : ok({ reading: true });
          } catch (e) { return fail(e, { reading: false }); }
        },

        /**
         * Stop continuous reading.
         * Returns { error, errorMessage, reading:false }.
         */
        async stopRead() {
          try {
            const res = await ipcRenderer.invoke('tcpclient:stopRead', { connectionId });
            return hasStdShape(res) ? res : ok({ reading: false });
          } catch (e) { return fail(e, { reading: true }); }
        },

        /**
         * Configure logical read timeout used by writeAndRead.
         * Accepts { readTimeout:number }.
         */
        async setReadTimeout(args) {
          try {
            const res = await ipcRenderer.invoke('tcpclient:setReadTimeout', { ...args, connectionId });
            return hasStdShape(res) ? res : ok();
          } catch (e) { return fail(e); }
        },

        /**
         * Request/Response helper: write bytes and wait for a reply.
         * Accepts { data, timeout?, maxBytes?, expect?, suspendStreamDuringRR? }.
         * Returns { error, errorMessage, data, bytesSent, bytesReceived, matched }.
         */
        async writeAndRead(args) {
          try {
            const res = await ipcRenderer.invoke('tcpclient:writeAndRead', { ...args, connectionId });
            if (hasStdShape(res)) return res;
            const data = res?.data || [];
            const bytesSent = typeof res?.bytesSent === 'number' ? res.bytesSent : null;
            const bytesReceived = typeof res?.bytesReceived === 'number' ? res.bytesReceived : data.length;
            return ok({ data, bytesSent, bytesReceived, matched: !!res?.matched });
          } catch (e) {
            return fail(e, { data: [], bytesSent: null, bytesReceived: null, matched: false });
          }
        },

        /**
         * Subscribe to native events for this connection:
         *  - 'tcpData':       { connectionId, data:number[] }
         *  - 'tcpDisconnect': { connectionId, disconnected:true, reason:'manual'|'remote'|'error', error? }
         *
         * Only events matching this connection's connectionId are delivered.
         * Returns a handle with remove() for cleanup.
         */
        addListener(event, cb) {
          const ch = `tcpclient:event:${event}`;
          const handler = (_ev, payload) => {
            try {
              if (payload?.connectionId === connectionId) cb(payload);
            } catch { /* ignore renderer-side errors */ }
          };
          ipcRenderer.on(ch, handler);
          if (!_handlers.has(event)) _handlers.set(event, []);
          _handlers.get(event).push(handler);
          return {
            remove: () => {
              ipcRenderer.removeListener(ch, handler);
              const arr = _handlers.get(event);
              if (arr) {
                const idx = arr.indexOf(handler);
                if (idx >= 0) arr.splice(idx, 1);
              }
            },
          };
        },

        /**
         * Remove all listeners registered via addListener on this connection.
         * Does NOT affect listeners registered on other connections.
         */
        removeAllListeners() {
          for (const [event, handlers] of _handlers.entries()) {
            const ch = `tcpclient:event:${event}`;
            for (const h of handlers) ipcRenderer.removeListener(ch, h);
          }
          _handlers.clear();
          return Promise.resolve();
        },

        /**
         * Disconnect, clean up all listeners, and release this connection
         * from the main-process registry.
         */
        async destroy() {
          try {
            await this.removeAllListeners();
            await ipcRenderer.invoke('tcpclient:destroyConnection', { connectionId });
          } catch { /* ignore */ }
        },
      });
    },
  });
};
