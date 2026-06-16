# @devioarts/capacitor-tcpclient

TCP Client for Capacitor with iOS/Android/Electron support

## Install

```bash
npm install @devioarts/capacitor-tcpclient
npx cap sync
```

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

The plugin ships a native IPC bridge for Electron.  Integration requires two
auto-generated runtime files — one for the **main process** and one for the
**preload script** — which wire the plugin's IPC channels to the renderer.

> If you are using the [capacitor-electron](https://github.com/devioarts/capacitor-examples/tree/main/capacitor-electron)
> project template, run `npm run update` inside your `electron/` directory to
> regenerate these files automatically from the plugin's
> `@devioarts/capacitor-tcpclient/electron/settings` metadata.

### Main process (`electron/src/rt/electron-main.ts`)

```typescript
// Auto-generated — do not edit. Regenerate with: npm run update
import { app, ipcMain } from 'electron';
import { TCPClient } from '@devioarts/capacitor-tcpclient/electron';

type AnyRecord = Record<string, unknown>;

function registerPlugin(pluginClass: string, instance: AnyRecord, methods: readonly string[]) {
  for (const method of methods) {
    ipcMain.handle(`${pluginClass}-${method}`, async (_event, opts: unknown) => {
      try {
        return await (instance[method] as (opts: AnyRecord) => Promise<unknown>)((opts ?? {}) as AnyRecord);
      } catch (err) {
        return { error: true, errorMessage: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}

void (async () => {
  await app.whenReady();
  registerPlugin('TCPClient', new TCPClient() as unknown as AnyRecord, [
    'getPlatform', 'connect', 'disconnect', 'isConnected', 'isReading',
    'write', 'startRead', 'stopRead', 'setReadTimeout', 'writeAndRead', 'destroyConnection',
  ]);
})();
```

Import this file from your `electron/main.ts`:

```typescript
import './src/rt/electron-main';
```

### Preload (`electron/src/rt/electron-rt.ts`)

The preload runtime exposes `CapacitorCustomPlatform` to the renderer via
`contextBridge`, mapping each method to `ipcRenderer.invoke` and routing
events from `ipcRenderer.on`.

```typescript
// electron/preload.ts
import './src/rt/electron-rt';
```

See the [example project](https://github.com/devioarts/capacitor-examples) for
the full `electron-rt.ts` and `electron-plugins.ts` sources.

### Renderer (using the `@capacitor/core` JS API)

```typescript
import { TCPClient } from '@devioarts/capacitor-tcpclient';

const conn = TCPClient.createConnection({ host: '192.168.1.100', port: 9100 });
await conn.connect();

// stream
await conn.addListener('tcpData', ({ data }) => console.log('RX:', data));
await conn.addListener('tcpDisconnect', ({ reason }) => console.log('disconnected:', reason));
await conn.startRead({ chunkSize: 4096 });

// RR
const rr = await conn.writeAndRead({ data: [0x1b, 0x40], timeout: 1000 });
console.log(rr.error ? rr.errorMessage : rr.data);

// cleanup
await conn.destroy();
```
---

## Technical behavior & guarantees

- **Platforms:** iOS / Android / Electron provide real TCP sockets. The Web implementation is a development stub with the same API shape but no real TCP transport.
- **Request/Response (`writeAndRead`)**
    - Without `expect`: returns after **until-idle** (adaptive ~50–200 ms) to capture the full reply.
    - With `expect`: returns on first match. If `timeout` expires and **some data arrived**, returns **success** with `matched:false`; if **no data** arrived, returns a **timeout error**.
- **Timeouts:** `timeout` is the total RR budget. `readTimeout` on **Android** sets `SO_TIMEOUT` for the continuous reader. On **iOS** it’s a no-op (evented I/O). On **Electron** it sets the per-connection default `timeout` used by `writeAndRead` when no explicit `timeout` is passed; the stream reader itself has no timeout.
- **Streaming (`tcpData` events):** native/Electron stream data is micro-batched **every 10 ms or 16 KB**. On Android/iOS, `chunkSize` controls each native socket read before batching; on Electron, the merged batch is split by `chunkSize` before it is sent to the web layer.
- **Bytes & flags:** `bytesSent` = actually written; on RR timeout it remains the request length, on other errors it’s `0`. `bytesReceived` = length of returned `data`. `matched` = whether `expect` was found.
- **Connectivity (`isConnected()`)**: iOS/Android perform an active EOF check when no stream/RR read is active and may emit `tcpDisconnect` on remote close. Electron performs a fast local socket-state check. The Web stub returns a mock connected state.
- **Stream suspension:** `suspendStreamDuringRR` (default **true**) temporarily detaches streaming so the RR read can’t be “stolen” by the stream consumer.
- **Security:** plain **TCP** only (no TLS). Use an external TLS terminator (e.g., stunnel) if you need TLS.

## FAQ

- **Why “until-idle” without `expect`?** Many devices reply in fragments; a short adaptive idle window (~50–200 ms) avoids cutting responses.
- **Why success on `expect` + timeout (with data)?** To avoid dropping partial replies; `matched:false` tells you the pattern didn’t occur.
- **Why does `readTimeout` behave differently per platform?** On Android, `SO_TIMEOUT` applies to the blocking stream reader. On iOS, evented reads (via `DispatchSourceRead`) make it a no-op. On Electron, it sets the per-connection default `timeout` for `writeAndRead`; the stream reader is event-driven and has no built-in timeout.

## Minimal usage (recap)

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

<docgen-index>

* [`createConnection(...)`](#createconnection)
* [`getPlatform()`](#getplatform)
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


### getPlatform()

```typescript
getPlatform() => Promise<TcpGetPlatformResult>
```

Returns the platform identifier of the implementation answering calls.

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

| Prop       | Type                                                          |
| ---------- | ------------------------------------------------------------- |
| **`data`** | <code>number[] \| <a href="#uint8array">Uint8Array</a></code> |


#### Uint8Array

A typed array of 8-bit unsigned integer values. The contents are initialized to 0. If the
requested number of bytes could not be allocated an exception is raised.

| Prop                    | Type                                                        | Description                                                                  |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **`BYTES_PER_ELEMENT`** | <code>number</code>                                         | The size in bytes of each element in the array.                              |
| **`buffer`**            | <code><a href="#arraybufferlike">ArrayBufferLike</a></code> | The <a href="#arraybuffer">ArrayBuffer</a> instance referenced by the array. |
| **`byteLength`**        | <code>number</code>                                         | The length in bytes of the array.                                            |
| **`byteOffset`**        | <code>number</code>                                         | The offset in bytes of the array.                                            |
| **`length`**            | <code>number</code>                                         | The length of the array.                                                     |

| Method             | Signature                                                                                                                                                                      | Description                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **copyWithin**     | (target: number, start: number, end?: number \| undefined) =&gt; this                                                                                                          | Returns the this object after copying a section of the array identified by start and end to the same array starting at position target                                                                                                      |
| **every**          | (predicate: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; unknown, thisArg?: any) =&gt; boolean                                            | Determines whether all the members of an array satisfy the specified test.                                                                                                                                                                  |
| **fill**           | (value: number, start?: number \| undefined, end?: number \| undefined) =&gt; this                                                                                             | Returns the this object after filling the section identified by start and end with value                                                                                                                                                    |
| **filter**         | (predicate: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; any, thisArg?: any) =&gt; <a href="#uint8array">Uint8Array</a>                   | Returns the elements of an array that meet the condition specified in a callback function.                                                                                                                                                  |
| **find**           | (predicate: (value: number, index: number, obj: <a href="#uint8array">Uint8Array</a>) =&gt; boolean, thisArg?: any) =&gt; number \| undefined                                  | Returns the value of the first element in the array where predicate is true, and undefined otherwise.                                                                                                                                       |
| **findIndex**      | (predicate: (value: number, index: number, obj: <a href="#uint8array">Uint8Array</a>) =&gt; boolean, thisArg?: any) =&gt; number                                               | Returns the index of the first element in the array where predicate is true, and -1 otherwise.                                                                                                                                              |
| **forEach**        | (callbackfn: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; void, thisArg?: any) =&gt; void                                                 | Performs the specified action for each element in an array.                                                                                                                                                                                 |
| **indexOf**        | (searchElement: number, fromIndex?: number \| undefined) =&gt; number                                                                                                          | Returns the index of the first occurrence of a value in an array.                                                                                                                                                                           |
| **join**           | (separator?: string \| undefined) =&gt; string                                                                                                                                 | Adds all the elements of an array separated by the specified separator string.                                                                                                                                                              |
| **lastIndexOf**    | (searchElement: number, fromIndex?: number \| undefined) =&gt; number                                                                                                          | Returns the index of the last occurrence of a value in an array.                                                                                                                                                                            |
| **map**            | (callbackfn: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number, thisArg?: any) =&gt; <a href="#uint8array">Uint8Array</a>               | Calls a defined callback function on each element of an array, and returns an array that contains the results.                                                                                                                              |
| **reduce**         | (callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number) =&gt; number                       | Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.                      |
| **reduce**         | (callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number, initialValue: number) =&gt; number |                                                                                                                                                                                                                                             |
| **reduce**         | &lt;U&gt;(callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; U, initialValue: U) =&gt; U            | Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function.                      |
| **reduceRight**    | (callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number) =&gt; number                       | Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function. |
| **reduceRight**    | (callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; number, initialValue: number) =&gt; number |                                                                                                                                                                                                                                             |
| **reduceRight**    | &lt;U&gt;(callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; U, initialValue: U) =&gt; U            | Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated result, and is provided as an argument in the next call to the callback function. |
| **reverse**        | () =&gt; <a href="#uint8array">Uint8Array</a>                                                                                                                                  | Reverses the elements in an Array.                                                                                                                                                                                                          |
| **set**            | (array: <a href="#arraylike">ArrayLike</a>&lt;number&gt;, offset?: number \| undefined) =&gt; void                                                                             | Sets a value or an array of values.                                                                                                                                                                                                         |
| **slice**          | (start?: number \| undefined, end?: number \| undefined) =&gt; <a href="#uint8array">Uint8Array</a>                                                                            | Returns a section of an array.                                                                                                                                                                                                              |
| **some**           | (predicate: (value: number, index: number, array: <a href="#uint8array">Uint8Array</a>) =&gt; unknown, thisArg?: any) =&gt; boolean                                            | Determines whether the specified callback function returns true for any element of an array.                                                                                                                                                |
| **sort**           | (compareFn?: ((a: number, b: number) =&gt; number) \| undefined) =&gt; this                                                                                                    | Sorts an array.                                                                                                                                                                                                                             |
| **subarray**       | (begin?: number \| undefined, end?: number \| undefined) =&gt; <a href="#uint8array">Uint8Array</a>                                                                            | Gets a new <a href="#uint8array">Uint8Array</a> view of the <a href="#arraybuffer">ArrayBuffer</a> store for this array, referencing the elements at begin, inclusive, up to end, exclusive.                                                |
| **toLocaleString** | () =&gt; string                                                                                                                                                                | Converts a number to a string by using the current locale.                                                                                                                                                                                  |
| **toString**       | () =&gt; string                                                                                                                                                                | Returns a string representation of an array.                                                                                                                                                                                                |
| **valueOf**        | () =&gt; <a href="#uint8array">Uint8Array</a>                                                                                                                                  | Returns the primitive value of the specified object.                                                                                                                                                                                        |


#### ArrayLike

| Prop         | Type                |
| ------------ | ------------------- |
| **`length`** | <code>number</code> |


#### ArrayBufferTypes

Allowed <a href="#arraybuffer">ArrayBuffer</a> types for the buffer of an ArrayBufferView and related Typed Arrays.

| Prop              | Type                                                |
| ----------------- | --------------------------------------------------- |
| **`ArrayBuffer`** | <code><a href="#arraybuffer">ArrayBuffer</a></code> |


#### ArrayBuffer

Represents a raw buffer of binary data, which is used to store data for the
different typed arrays. ArrayBuffers cannot be read from or written to directly,
but can be passed to a typed array or DataView Object to interpret the raw
buffer as needed.

| Prop             | Type                | Description                                                                     |
| ---------------- | ------------------- | ------------------------------------------------------------------------------- |
| **`byteLength`** | <code>number</code> | Read-only. The length of the <a href="#arraybuffer">ArrayBuffer</a> (in bytes). |

| Method    | Signature                                                                               | Description                                                     |
| --------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **slice** | (begin: number, end?: number \| undefined) =&gt; <a href="#arraybuffer">ArrayBuffer</a> | Returns a section of an <a href="#arraybuffer">ArrayBuffer</a>. |


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

| Prop                        | Type                                                                    | Description                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **`data`**                  | <code>number[] \| <a href="#uint8array">Uint8Array</a></code>           |                                                                                                                                                |
| **`timeout`**               | <code>number</code>                                                     | RR timeout in ms. Default 1000.                                                                                                                |
| **`maxBytes`**              | <code>number</code>                                                     | Maximum bytes to accumulate. Default 4096.                                                                                                     |
| **`expect`**                | <code>string \| number[] \| <a href="#uint8array">Uint8Array</a></code> | Optional pattern — reading stops when found. Accepts number[] / <a href="#uint8array">Uint8Array</a> or hex string (e.g. "1B40", "0x1b 0x40"). |
| **`suspendStreamDuringRR`** | <code>boolean</code>                                                    | Suspend stream reader during RR to avoid consuming reply. Default true.                                                                        |


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

<code>{ [P in keyof T]?: T[P]; }</code>


#### ArrayBufferLike

<code>ArrayBufferTypes[keyof ArrayBufferTypes]</code>


#### TcpPlatform

<code>'ios' | 'android' | 'web' | 'electron'</code>

</docgen-api>
