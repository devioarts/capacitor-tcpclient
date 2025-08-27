/**
 * Electron preload-side bridge: exposes a stable, promise-based TCP API to the renderer.
 * - Delegates calls to the main process via ipcRenderer.invoke(...)
 * - Normalizes results to a common { error, errorMessage, ... } shape
 * - Provides small helpers for event subscription with remove()
 */
// eslint-disable-next-line no-undef
module.exports.createTCPClientAPI = ({ ipcRenderer }) => {
  /**
   * Build a success result with the standard shape.
   * Ensures { error:false, errorMessage:null } are always present.
   */
  const ok = (extra = {}) => ({ error: false, errorMessage: null, ...extra });

  /**
   * Build a failure result with the standard shape.
   * Accepts Error instances, strings, or unknown values and renders a readable message.
   */
  const fail = (e, extra = {}) => {
    const msg = (e && (e.message || (typeof e === 'string' ? e : null))) || String(e || 'Error');
    return { error: true, errorMessage: msg, ...extra };
  };

  /**
   * Quick duck-typing check to see if a returned value already conforms to the standard shape.
   * If so, we return it as-is; otherwise we normalize it with ok()/fail().
   */
  const hasStdShape = (x) => x && typeof x === 'object' && typeof x.error === 'boolean' && 'errorMessage' in x;

  return Object.freeze({
    /**
     * Connect to a TCP endpoint in the main process.
     * Returns { error, errorMessage, connected }.
     * If the main handler already returns a standardized shape, it is passed through verbatim.
     */
    async tcpConnect(args) {
      try {
        const res = await ipcRenderer.invoke('tcpclient:tcpConnect', args);
        return hasStdShape(res) ? res : ok({ connected: !!(res?.connected) });
      } catch (e) { return fail(e, { connected: false }); }
    },

    /**
     * Disconnect current session.
     * Returns { error, errorMessage, disconnected, reading:false }.
     */
    async tcpDisconnect() {
      try {
        const res = await ipcRenderer.invoke('tcpclient:tcpDisconnect');
        return hasStdShape(res) ? res : ok({ disconnected: true, reading: false });
      } catch (e) { return fail(e, { disconnected: false }); }
    },

    /**
     * Query connection status.
     * Returns { error, errorMessage, connected }.
     */
    async tcpIsConnected() {
      try {
        const res = await ipcRenderer.invoke('tcpclient:tcpIsConnected');
        return hasStdShape(res) ? res : ok({ connected: !!(res?.connected) });
      } catch (e) { return fail(e, { connected: false }); }
    },

    /**
     * Query stream-reading status (renderer-facing flag).
     * Returns { error, errorMessage, reading }.
     */
    async tcpIsReading() {
      try {
        const res = await ipcRenderer.invoke('tcpclient:tcpIsReading');
        return hasStdShape(res) ? res : ok({ reading: !!(res?.reading) });
      } catch (e) { return fail(e, { reading: false }); }
    },

    /**
     * Write raw bytes to the socket.
     * Expects { data:number[] } and returns { error, errorMessage, bytesWritten }.
     */
    async tcpWrite(args) {
      try {
        const res = await ipcRenderer.invoke('tcpclient:tcpWrite', args);
        return hasStdShape(res) ? res : ok({ bytesWritten: +res?.bytesWritten || 0 });
      } catch (e) { return fail(e, { bytesWritten: 0 }); }
    },

    /**
     * Start continuous reading. Accepts { chunkSize?, timeoutMs?/readTimeoutMs? }.
     * - For compatibility, maps readTimeoutMs -> timeoutMs if provided.
     * Returns { error, errorMessage, reading }.
     */
    async tcpStartRead(args) {
      try {
        const a = { ...args };
        if (a.timeoutMs == null && a.readTimeoutMs != null) a.timeoutMs = a.readTimeoutMs;
        const res = await ipcRenderer.invoke('tcpclient:tcpStartRead', a);
        return hasStdShape(res) ? res : ok({ reading: true });
      } catch (e) { return fail(e, { reading: false }); }
    },

    /**
     * Stop continuous reading.
     * Returns { error, errorMessage, reading:false }.
     */
    async tcpStopRead() {
      try {
        const res = await ipcRenderer.invoke('tcpclient:tcpStopRead');
        return hasStdShape(res) ? res : ok({ reading: false });
      } catch (e) { return fail(e, { reading: true }); }
    },

    /**
     * Configure read timeout used by certain operations (e.g., RR helper).
     * Accepts { timeoutMs } or legacy { ms } and forwards normalized shape.
     */
    async tcpSetReadTimeout(args) {
      try {
        const a = { timeoutMs: args?.timeoutMs ?? args?.ms };
        const res = await ipcRenderer.invoke('tcpclient:tcpSetReadTimeout', a);
        return hasStdShape(res) ? res : ok();
      } catch (e) { return fail(e); }
    },

    /**
     * Request/Response helper: write bytes and wait for a reply with optional early-exit pattern.
     * Accepts:
     *  - data:number[]
     *  - timeoutMs?:number
     *  - maxBytes?:number
     *  - expect?:number[]|hex-string
     *  - suspendStreamDuringRR?:boolean
     * Returns standardized shape with { data:number[], bytesWritten, bytesRead }.
     */
    async tcpWriteAndRead(args) {
      try {
        const res = await ipcRenderer.invoke('tcpclient:tcpWriteAndRead', args);
        if (hasStdShape(res)) return res;
        const data = res?.data || [];
        const bytesWritten = typeof res?.bytesWritten === 'number' ? res.bytesWritten : null;
        const bytesRead  = typeof res?.bytesRead  === 'number' ? res.bytesRead  : data.length;
        return ok({ data, bytesWritten, bytesRead });
      } catch (e) {
        return fail(e, { data: [], bytesWritten: null, bytesRead: null });
      }
    },

    /**
     * Subscribe to native events forwarded by the main process:
     *  - 'tcpData': { data:number[] }
     *  - 'tcpDisconnect': { disconnected:true, reason:'manual'|'remote'|'error', error? }
     * Returns a handle with remove() for cleanup.
     */
    addListener(event, cb) {
      const ch = `tcpclient:event:${event}`; // "tcpData" / "tcpDisconnect"
      const handler = (_ev, payload) => { try { cb(payload); } catch { /* ignore */} };
      ipcRenderer.on(ch, handler);
      return { remove: () => ipcRenderer.removeListener(ch, handler) };
    },

    /**
     * Remove all known event listeners registered by this bridge.
     * Useful during hot-reloads or when tearing down windows.
     */
    removeAllListeners() {
      ipcRenderer.removeAllListeners('tcpclient:event:tcpData');
      ipcRenderer.removeAllListeners('tcpclient:event:tcpDisconnect');
      return Promise.resolve();
    },
  });
};
