# @devioarts/capacitor-tcpclient

TCP Client for Capacitor with iOS/Android/Electron support

## Install

For Capacitor apps:

```bash
npm install @devioarts/capacitor-tcpclient
npx cap sync
```

For a plain Electron app, install the package and wire the Electron bridge
manually as shown below. The root `@devioarts/capacitor-tcpclient` entry point
is the Capacitor JS API; the Electron bridge is exported from
`@devioarts/capacitor-tcpclient/electron`.

## Android

#### /android/app/src/main/AndroidManifest.xml

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

## iOS

#### /ios/App/App/Info.plist

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>It is needed for the correct functioning of the application</string>

<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

---

## ElectronJS

The package ships a native Electron bridge for the main process. In a plain
Electron app you register that bridge with `ipcMain`, expose a small API from
the preload script, and call the low-level methods from the renderer with your
own `connectionId`.

If you use Capacitor with Electron, use
[devioarts/capacitor-electron](https://github.com/devioarts/capacitor-electron).
The example below is only for manual Electron integration without Capacitor.

### Main process (`electron/main.ts`)

```typescript
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { TCPClient } from '@devioarts/capacitor-tcpclient/electron';

type AnyRecord = Record<string, unknown>;

const tcpClient = new TCPClient();
const tcpMethods = [
  'getPluginPlatform',
  'connect',
  'disconnect',
  'isConnected',
  'isReading',
  'write',
  'startRead',
  'stopRead',
  'setReadTimeout',
  'writeAndRead',
  'destroyConnection',
] as const;

function registerTCPClient() {
  for (const method of tcpMethods) {
    ipcMain.handle(`TCPClient-${method}`, async (_event, opts: unknown) => {
      try {
        return await (tcpClient as any)[method]((opts ?? {}) as AnyRecord);
      } catch (err) {
        return { error: true, errorMessage: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}

async function createWindow() {
  const win = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL('http://localhost:5173');
}

app.whenReady().then(async () => {
  registerTCPClient();
  await createWindow();
});
```

### Preload (`electron/preload.ts`)

```typescript
import { contextBridge, ipcRenderer } from 'electron';

type TcpEventName = 'tcpData' | 'tcpDisconnect';
type TcpEvent = {
  connectionId: string;
  data?: number[];
  disconnected?: true;
  reading?: boolean;
  reason?: 'manual' | 'remote' | 'error';
  error?: string;
};
type ListenerHandle = { remove: () => Promise<void> };

function invoke(method: string, options: Record<string, unknown> = {}) {
  return ipcRenderer.invoke(`TCPClient-${method}`, options);
}

const api = {
  getPluginPlatform: () => invoke('getPluginPlatform'),
  connect: (options: Record<string, unknown>) => invoke('connect', options),
  disconnect: (options: Record<string, unknown>) => invoke('disconnect', options),
  isConnected: (options: Record<string, unknown>) => invoke('isConnected', options),
  isReading: (options: Record<string, unknown>) => invoke('isReading', options),
  write: (options: Record<string, unknown>) => invoke('write', options),
  startRead: (options: Record<string, unknown>) => invoke('startRead', options),
  stopRead: (options: Record<string, unknown>) => invoke('stopRead', options),
  setReadTimeout: (options: Record<string, unknown>) => invoke('setReadTimeout', options),
  writeAndRead: (options: Record<string, unknown>) => invoke('writeAndRead', options),
  destroyConnection: (options: Record<string, unknown>) => invoke('destroyConnection', options),
  addListener(eventName: TcpEventName, listener: (event: TcpEvent) => void): Promise<ListenerHandle> {
    const channel = `event-TCPClient-${eventName}`;
    const wrapped = (_event: unknown, payload: TcpEvent) => listener(payload);

    ipcRenderer.send('event-add-TCPClient', eventName);
    ipcRenderer.on(channel, wrapped);

    return Promise.resolve({
      remove: async () => {
        ipcRenderer.off(channel, wrapped);
        ipcRenderer.send(`event-remove-TCPClient-${eventName}`);
      },
    });
  },
};

contextBridge.exposeInMainWorld('TCPClient', api);
```

### Renderer

```typescript
type TcpEvent = {
  connectionId: string;
  data?: number[];
  reason?: 'manual' | 'remote' | 'error';
  error?: string;
};
type ListenerHandle = { remove: () => Promise<void> };
type TCPClientBridge = {
  connect(
    options: Record<string, unknown>,
  ): Promise<{ error: boolean; errorMessage?: string | null; connected: boolean }>;
  disconnect(options: {
    connectionId: string;
  }): Promise<{ error: boolean; errorMessage?: string | null; disconnected: boolean }>;
  startRead(options: {
    connectionId: string;
    chunkSize?: number;
    readTimeout?: number;
  }): Promise<{ error: boolean; errorMessage?: string | null; reading: boolean }>;
  writeAndRead(options: Record<string, unknown>): Promise<{
    error: boolean;
    errorMessage?: string | null;
    data: number[];
    bytesSent: number;
    bytesReceived: number;
    matched: boolean;
  }>;
  destroyConnection(options: { connectionId: string }): Promise<{ error: boolean; errorMessage?: string | null }>;
  addListener(eventName: 'tcpData' | 'tcpDisconnect', listener: (event: TcpEvent) => void): Promise<ListenerHandle>;
};

const client = (window as Window & { TCPClient: TCPClientBridge }).TCPClient;
const connectionId = crypto.randomUUID();

await client.connect({
  connectionId,
  host: '192.168.1.100',
  port: 9100,
});

// stream
const dataListener = await client.addListener('tcpData', (event) => {
  if (event.connectionId === connectionId) console.log('RX:', event.data);
});

const disconnectListener = await client.addListener('tcpDisconnect', (event) => {
  if (event.connectionId === connectionId) console.log('disconnected:', event.reason);
});

await client.startRead({ connectionId, chunkSize: 4096 });

// RR
const rr = await client.writeAndRead({
  connectionId,
  data: [0x1b, 0x40],
  timeout: 1000,
});
console.log(rr.error ? rr.errorMessage : rr.data);

// cleanup
await client.disconnect({ connectionId });
await client.destroyConnection({ connectionId });
await dataListener.remove();
await disconnectListener.remove();
```

---

## Technical behavior

- **Platforms:** iOS / Android / Electron provide real TCP sockets. The Web implementation is a development stub with the same API shape but no real TCP transport.
- **Request/Response (`writeAndRead`)**
  - Without `expect`: returns after **until-idle** (adaptive ~50–200 ms) to capture the full reply.
  - With `expect`: returns on first match. If `timeout` expires and **some data arrived**, returns **success** with `matched:false`; if **no data** arrived, returns a **timeout error**.
- **Timeouts:** `timeout` controls the RR wait budget. On **Electron** it covers the pending RR operation timer. On **iOS**, sending uses the same value as its own write budget and the receive loop then uses that value for the response wait. On **Android**, the socket write is performed before the response wait; the response wait uses `timeout`. `readTimeout` on **Android** sets `SO_TIMEOUT` for the continuous reader. On **iOS** it’s a no-op (evented I/O). On **Electron** it sets the per-connection default `timeout` used by `writeAndRead` when no explicit `timeout` is passed; the stream reader itself has no timeout.
- **Streaming (`tcpData` events):** native/Electron stream data is micro-batched **every 10 ms or 16 KB**. On Android/iOS, `chunkSize` controls each native socket read before batching; on Electron, the merged batch is split by `chunkSize` before it is sent to the web layer.
- **Bytes & flags:** `bytesSent` is the request length on successful RR calls and timeout-style RR errors; on other RR errors it is `0`. Raw `write()` returns the number of bytes reported by the platform write. `bytesReceived` = length of returned `data`. `matched` = whether `expect` was found.
- **Connectivity (`isConnected()`)**: iOS/Android perform an active EOF check when no stream/RR read is active and may emit `tcpDisconnect` on remote close. Electron performs a fast local socket-state check. The Web stub returns a mock connected state.
- **Stream suspension:** `suspendStreamDuringRR` (default **true**) temporarily detaches streaming so the RR read can’t be “stolen” by the stream consumer.
- **Electron API shape:** the root package exposes `TCPClient.createConnection()`. The manual Electron bridge uses low-level methods directly and requires `connectionId` on every call.
- **Electron single-window:** only the `WebContents` of the last window that registered any TCP event listener receives `tcpData` / `tcpDisconnect` events. Multi-window Electron apps need a custom event fan-out layer in the main process.
- **Security:** plain **TCP** only (no TLS). Use an external TLS terminator (e.g., stunnel) if you need TLS.

## FAQ

- **Why “until-idle” without `expect`?** Many devices reply in fragments; a short adaptive idle window (~50–200 ms) avoids cutting responses.
- **Why success on `expect` + timeout (with data)?** To avoid dropping partial replies; `matched:false` tells you the pattern didn’t occur.
- **Why does `readTimeout` behave differently per platform?** On Android, `SO_TIMEOUT` applies to the blocking stream reader. On iOS, evented reads (via `DispatchSourceRead`) make it a no-op. On Electron, it sets the per-connection default `timeout` for `writeAndRead`; the stream reader is event-driven and has no built-in timeout.

## Minimal Capacitor usage

```ts
import { TCPClient } from '@devioarts/capacitor-tcpclient';

// Create (or retrieve) a connection instance. Pass connectionId to reuse the same instance.
const conn = TCPClient.createConnection({ host: '192.168.1.100', port: 9100, timeout: 3000 });

await conn.connect();

// stream (micro-batch 10 ms / 16 KB; chunkSize controls native read size,
// and on Electron also the emitted event split size)
// Register listeners before startRead so no events are missed
await conn.addListener('tcpData', ({ data }) => {
  console.log('RX:', data.length);
});
await conn.addListener('tcpDisconnect', ({ reason }) => {
  console.log('disconnected:', reason);
});
await conn.startRead({ chunkSize: 4096 });

// RR
const rr = await conn.writeAndRead({
  data: [0x1b, 0x40],
  timeout: 1000,
  maxBytes: 4096,
  // expect: '1b40' | [0x1b, 0x40]
  suspendStreamDuringRR: true,
});
console.log(rr.error ? rr.errorMessage : { matched: rr.matched, bytes: rr.bytesReceived });

// disconnect and release from registry
await conn.destroy();
```

## API

The generated API below documents the root
`@devioarts/capacitor-tcpclient` entry point used by Capacitor apps. The manual
Electron bridge shown above exposes the same native methods directly over IPC,
so it uses `connectionId` instead of `createConnection()`.

<docgen-index>

* [`createConnection(...)`](#createconnection)
* [`getPluginPlatform()`](#getpluginplatform)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

### createConnection(...)

```typescript
createConnection(options?: TcpCreateConnectionOptions | undefined) => TCPConnection
```

Create (or retrieve) a TCP connection instance.

- Without connectionId: always creates a new instance with a generated UUID.
- With connectionId: returns the existing instance if one was already created,
  otherwise creates a new one.
- host/port/timeout/noDelay/keepAlive supplied here become defaults for connect().

| Param         | Type                                                                              |
| ------------- | --------------------------------------------------------------------------------- |
| **`options`** | <code><a href="#tcpcreateconnectionoptions">TcpCreateConnectionOptions</a></code> |

**Returns:** <code><a href="#tcpconnection">TCPConnection</a></code>

--------------------


### getPluginPlatform()

```typescript
getPluginPlatform() => Promise<TcpGetPlatformResult>
```

Returns the platform identifier for this plugin's native implementation
('ios' | 'android' | 'electron' | 'web').

Distinct from the Capacitor core `Capacitor.getPlatform()` — use this when
you need to know whether the TCP layer is backed by iOS, Android, Electron,
or the browser development stub.

**Returns:** <code>Promise&lt;<a href="#tcpgetplatformresult">TcpGetPlatformResult</a>&gt;</code>

--------------------


### Interfaces


#### TCPConnection

A single TCP connection instance returned by TCPClient.createConnection().
Each instance has its own socket, event listeners, and lifecycle.

| Prop               | Type                |
| ------------------ | ------------------- |
| **`connectionId`** | <code>string</code> |

| Method                 | Signature                                                                                                                                                                                          | Description                                                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **connect**            | (options?: <a href="#partial">Partial</a>&lt;<a href="#tcpconnectoptions">TcpConnectOptions</a>&gt; \| undefined) =&gt; Promise&lt;<a href="#tcpconnectresult">TcpConnectResult</a>&gt;            | Open the socket. Options are merged with the defaults supplied in createConnection(). host must be present either in createConnection() or here.                                                                                                                                   |
| **disconnect**         | () =&gt; Promise&lt;<a href="#tcpdisconnectresult">TcpDisconnectResult</a>&gt;                                                                                                                     | Close the socket. Idempotent. Emits tcpDisconnect(reason: manual).                                                                                                                                                                                                                 |
| **isConnected**        | () =&gt; Promise&lt;<a href="#tcpisconnectedresult">TcpIsConnectedResult</a>&gt;                                                                                                                   |                                                                                                                                                                                                                                                                                    |
| **isReading**          | () =&gt; Promise&lt;<a href="#tcpisreadingresult">TcpIsReadingResult</a>&gt;                                                                                                                       |                                                                                                                                                                                                                                                                                    |
| **write**              | (options: <a href="#tcpwriteoptions">TcpWriteOptions</a>) =&gt; Promise&lt;<a href="#tcpwriteresult">TcpWriteResult</a>&gt;                                                                        |                                                                                                                                                                                                                                                                                    |
| **writeAndRead**       | (options: <a href="#tcpwriteandreadoptions">TcpWriteAndReadOptions</a>) =&gt; Promise&lt;<a href="#tcpwriteandreadresult">TcpWriteAndReadResult</a>&gt;                                            |                                                                                                                                                                                                                                                                                    |
| **startRead**          | (options?: <a href="#tcpstartreadoptions">TcpStartReadOptions</a> \| undefined) =&gt; Promise&lt;<a href="#tcpstartstopresult">TcpStartStopResult</a>&gt;                                          |                                                                                                                                                                                                                                                                                    |
| **stopRead**           | () =&gt; Promise&lt;<a href="#tcpstartstopresult">TcpStartStopResult</a>&gt;                                                                                                                       |                                                                                                                                                                                                                                                                                    |
| **setReadTimeout**     | (options: { readTimeout: number; }) =&gt; Promise&lt;{ error: boolean; errorMessage?: string \| null; }&gt;                                                                                        | Configure stream read timeout. - Android: sets `SO_TIMEOUT` on the continuous reader socket (applies during `startRead`). - iOS: no-op (evented I/O, no blocking timeout). - Electron: sets the default `timeout` value used by `writeAndRead` when no explicit timeout is passed. |
| **addListener**        | (eventName: 'tcpData', listenerFunc: (event: <a href="#tcpdataevent">TcpDataEvent</a>) =&gt; void) =&gt; Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;                   | Subscribe to stream data. Only events for this connectionId are delivered.                                                                                                                                                                                                         |
| **addListener**        | (eventName: 'tcpDisconnect', listenerFunc: (event: <a href="#tcpdisconnectevent">TcpDisconnectEvent</a>) =&gt; void) =&gt; Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt; | Subscribe to disconnect notifications for this connection.                                                                                                                                                                                                                         |
| **removeAllListeners** | () =&gt; Promise&lt;void&gt;                                                                                                                                                                       | Remove all listeners registered through this instance.                                                                                                                                                                                                                             |
| **destroy**            | () =&gt; Promise&lt;void&gt;                                                                                                                                                                       | Disconnect, remove all listeners, and release this instance from the registry.                                                                                                                                                                                                     |


#### TcpConnectResult

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`connected`**    | <code>boolean</code>        |


#### TcpConnectOptions

| Prop            | Type                 | Description                                                            |
| --------------- | -------------------- | ---------------------------------------------------------------------- |
| **`host`**      | <code>string</code>  | Hostname or IP address. Required (either here or in createConnection). |
| **`port`**      | <code>number</code>  | TCP port, default 9100. Valid range 1..65535.                          |
| **`timeout`**   | <code>number</code>  | Connect timeout in milliseconds, default 3000.                         |
| **`noDelay`**   | <code>boolean</code> | Enable TCP_NODELAY (Nagle off). Default true.                          |
| **`keepAlive`** | <code>boolean</code> | Enable SO_KEEPALIVE. Default true.                                     |


#### TcpDisconnectResult

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`disconnected`** | <code>boolean</code>        |
| **`reading`**      | <code>boolean</code>        |


#### TcpIsConnectedResult

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`connected`**    | <code>boolean</code>        |


#### TcpIsReadingResult

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`reading`**      | <code>boolean</code>        |


#### TcpWriteResult

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`bytesSent`**    | <code>number</code>         |


#### TcpWriteOptions

| Prop       | Type                                                      |
| ---------- | --------------------------------------------------------- |
| **`data`** | <code><a href="#tcpbytepayload">TcpBytePayload</a></code> |


#### TcpByteArrayLike

Byte-like array accepted by write APIs.
Uint8Array is supported because it has numeric indexes and a length.

| Prop         | Type                |
| ------------ | ------------------- |
| **`length`** | <code>number</code> |


#### TcpWriteAndReadResult

| Prop                | Type                        |
| ------------------- | --------------------------- |
| **`error`**         | <code>boolean</code>        |
| **`errorMessage`**  | <code>string \| null</code> |
| **`bytesSent`**     | <code>number</code>         |
| **`bytesReceived`** | <code>number</code>         |
| **`data`**          | <code>number[]</code>       |
| **`matched`**       | <code>boolean</code>        |


#### TcpWriteAndReadOptions

| Prop                        | Type                                                                | Description                                                                                                          |
| --------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **`data`**                  | <code><a href="#tcpbytepayload">TcpBytePayload</a></code>           |                                                                                                                      |
| **`timeout`**               | <code>number</code>                                                 | RR timeout in ms. Default 1000.                                                                                      |
| **`maxBytes`**              | <code>number</code>                                                 | Maximum bytes to accumulate. Default 4096.                                                                           |
| **`expect`**                | <code>string \| <a href="#tcpbytepayload">TcpBytePayload</a></code> | Optional pattern — reading stops when found. Accepts number[] / Uint8Array or hex string (e.g. "1B40", "0x1b 0x40"). |
| **`suspendStreamDuringRR`** | <code>boolean</code>                                                | Suspend stream reader during RR to avoid consuming reply. Default true.                                              |


#### TcpStartStopResult

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`reading`**      | <code>boolean</code>        |


#### TcpStartReadOptions

| Prop              | Type                | Description                                                                                                                                                                                                            |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`chunkSize`**   | <code>number</code> | Stream read chunk size in bytes. Default 4096. - Android/iOS: size of each native socket read before bridge micro-batching. - Electron: maximum bytes per emitted tcpData event after micro-batching.                  |
| **`readTimeout`** | <code>number</code> | Stream read timeout in ms. - Android: sets `SO_TIMEOUT` for the continuous reader. - iOS: no-op. - Electron: updates the per-connection default `writeAndRead` timeout; the stream reader itself remains event-driven. |


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |


#### TcpDataEvent

Emitted by the stream reader. connectionId identifies which connection sent the data.

| Prop               | Type                  |
| ------------------ | --------------------- |
| **`connectionId`** | <code>string</code>   |
| **`data`**         | <code>number[]</code> |


#### TcpDisconnectEvent

Emitted when a connection closes.

| Prop               | Type                                         |
| ------------------ | -------------------------------------------- |
| **`connectionId`** | <code>string</code>                          |
| **`disconnected`** | <code>true</code>                            |
| **`reading`**      | <code>boolean</code>                         |
| **`reason`**       | <code>'error' \| 'manual' \| 'remote'</code> |
| **`error`**        | <code>string</code>                          |


#### TcpCreateConnectionOptions

Options for TCPClient.createConnection().
All fields are optional. host/port and other connect options set here become
defaults for every connect() call on the returned instance.

| Prop               | Type                | Description                                                                                                                                                                                   |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`connectionId`** | <code>string</code> | Optional stable identifier for this connection. If an instance with this id already exists in the registry, it is returned as-is. Omit to get a new instance with a generated UUID each time. |


#### TcpGetPlatformResult

| Prop               | Type                                                |
| ------------------ | --------------------------------------------------- |
| **`error`**        | <code>boolean</code>                                |
| **`errorMessage`** | <code>string \| null</code>                         |
| **`platform`**     | <code><a href="#tcpplatform">TcpPlatform</a></code> |


### Type Aliases


#### Partial

Make all properties in T optional

<code>{ [P in keyof T]?: T[P]; }</code>


#### TcpBytePayload

Byte payload accepted by write APIs.

<code>number[] | <a href="#tcpbytearraylike">TcpByteArrayLike</a></code>


#### TcpPlatform

<code>'ios' | 'android' | 'web' | 'electron'</code>

</docgen-api>
