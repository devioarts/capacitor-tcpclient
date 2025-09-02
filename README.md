# @devioarts/capacitor-tcpclient

TCP Client for CapacitorJS with iOS/Android/Electron support - [Example App](https://github.com/devioarts/capacitor-examples/tree/main/capacitor-tcpclient)

## Install

```bash
npm install @devioarts/capacitor-tcpclient
npx cap sync
```

## Android
#### /android/app/src/main/AndroidManifest.xml
```xml
<application 
        android:usesCleartextTraffic="true"
></application>

<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<!-- Android 12+ -->
<uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />

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
> Implementation example was developed on [capacitor-electron](https://github.com/devioarts/capacitor-examples/tree/main/capacitor-electron)
> base, if you run electron differently, you may need to adjust the code.
#### /electron/main.ts
```typescript
// ...
// THIS LINE IS IMPORTANT FOR PLUGIN!
import {TCPClient} from "@devioarts/capacitor-tcpclient/electron/tcpclient";
// ...
// THIS LINE IS IMPORTANT FOR PLUGIN!
let tcpClient: TCPClient | null = null;
// ...
function createWindow() {
  const win = new BrowserWindow(
    // ...
  );
  // ...
  // THIS LINE IS IMPORTANT FOR PLUGIN!
  tcpClient = new TCPClient(win);
  // ...
}
// ...
```

#### electron/preload.cjs
```javascript
const { contextBridge, ipcRenderer } = require("electron");

// THIS LINE IS IMPORTANT FOR PLUGIN!
const {createTCPClientAPI} = require("@devioarts/capacitor-tcpclient/electron/tcpclient-bridge.cjs");
// ...
// THIS LINE IS IMPORTANT FOR PLUGIN!
contextBridge.exposeInMainWorld('TCPClient', createTCPClientAPI({ ipcRenderer }));
// ...
```
---
## API

<docgen-index>

* [`connect(...)`](#connect)
* [`disconnect()`](#disconnect)
* [`isConnected()`](#isconnected)
* [`isReading()`](#isreading)
* [`write(...)`](#write)
* [`writeAndRead(...)`](#writeandread)
* [`startRead(...)`](#startread)
* [`stopRead()`](#stopread)
* [`setReadTimeout(...)`](#setreadtimeout)
* [`addListener('tcpData', ...)`](#addlistenertcpdata-)
* [`addListener('tcpDisconnect', ...)`](#addlistenertcpdisconnect-)
* [`removeAllListeners()`](#removealllisteners)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

The Capacitor plugin contract. All methods resolve; errors are returned in the
payload (error=true, errorMessage=string) rather than throwing.

### connect(...)

```typescript
connect(options: TcpConnectOptions) => Promise<TcpConnectResult>
```

Open a TCP connection.

| Param         | Type                                                            |
| ------------- | --------------------------------------------------------------- |
| **`options`** | <code><a href="#tcpconnectoptions">TcpConnectOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#tcpconnectresult">TcpConnectResult</a>&gt;</code>

--------------------


### disconnect()

```typescript
disconnect() => Promise<TcpDisconnectResult>
```

Close the TCP connection. Idempotent. Triggers tcpDisconnect(manual).

**Returns:** <code>Promise&lt;<a href="#tcpdisconnectresult">TcpDisconnectResult</a>&gt;</code>

--------------------


### isConnected()

```typescript
isConnected() => Promise<TcpIsConnectedResult>
```

Check whether the socket is connected.

**Returns:** <code>Promise&lt;<a href="#tcpisconnectedresult">TcpIsConnectedResult</a>&gt;</code>

--------------------


### isReading()

```typescript
isReading() => Promise<TcpIsReadingResult>
```

Check whether the stream reader is active.

**Returns:** <code>Promise&lt;<a href="#tcpisreadingresult">TcpIsReadingResult</a>&gt;</code>

--------------------


### write(...)

```typescript
write(options: TcpWriteOptions) => Promise<TcpWriteResult>
```

Write raw bytes.

| Param         | Type                                                        |
| ------------- | ----------------------------------------------------------- |
| **`options`** | <code><a href="#tcpwriteoptions">TcpWriteOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#tcpwriteresult">TcpWriteResult</a>&gt;</code>

--------------------


### writeAndRead(...)

```typescript
writeAndRead(options: TcpWriteAndReadOptions) => Promise<TcpWriteAndReadResult>
```

Write request, then read reply under the given constraints.

| Param         | Type                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| **`options`** | <code><a href="#tcpwriteandreadoptions">TcpWriteAndReadOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#tcpwriteandreadresult">TcpWriteAndReadResult</a>&gt;</code>

--------------------


### startRead(...)

```typescript
startRead(options?: TcpStartReadOptions | undefined) => Promise<TcpStartStopResult>
```

Start emitting tcpData events. Safe to call multiple times.

| Param         | Type                                                                |
| ------------- | ------------------------------------------------------------------- |
| **`options`** | <code><a href="#tcpstartreadoptions">TcpStartReadOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#tcpstartstopresult">TcpStartStopResult</a>&gt;</code>

--------------------


### stopRead()

```typescript
stopRead() => Promise<TcpStartStopResult>
```

Stop emitting tcpData events. Safe to call multiple times.

**Returns:** <code>Promise&lt;<a href="#tcpstartstopresult">TcpStartStopResult</a>&gt;</code>

--------------------


### setReadTimeout(...)

```typescript
setReadTimeout(options: { readTimeout: number; }) => Promise<{ error: boolean; errorMessage?: string | null; }>
```

Configure stream read timeout (Android only). iOS: no-op; Electron: stored
for RR defaults. Provided for API parity across platforms.

| Param         | Type                                  |
| ------------- | ------------------------------------- |
| **`options`** | <code>{ readTimeout: number; }</code> |

**Returns:** <code>Promise&lt;{ error: boolean; errorMessage?: string | null; }&gt;</code>

--------------------


### addListener('tcpData', ...)

```typescript
addListener(eventName: 'tcpData', listenerFunc: (event: TcpDataEvent) => void) => Promise<PluginListenerHandle>
```

Subscribe to micro-batched stream data events.

| Param              | Type                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| **`eventName`**    | <code>'tcpData'</code>                                                    |
| **`listenerFunc`** | <code>(event: <a href="#tcpdataevent">TcpDataEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### addListener('tcpDisconnect', ...)

```typescript
addListener(eventName: 'tcpDisconnect', listenerFunc: (event: TcpDisconnectEvent) => void) => Promise<PluginListenerHandle>
```

Subscribe to disconnect notifications.

| Param              | Type                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| **`eventName`**    | <code>'tcpDisconnect'</code>                                                          |
| **`listenerFunc`** | <code>(event: <a href="#tcpdisconnectevent">TcpDisconnectEvent</a>) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### removeAllListeners()

```typescript
removeAllListeners() => Promise<void>
```

Remove all tcpData/tcpDisconnect listeners.

--------------------


### Interfaces


#### TcpConnectResult

Result of connect().
- connected=true on success; false on failure.
- error=true with errorMessage on failure (e.g., "connect timeout",
  "connect failed: ...").

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`connected`**    | <code>boolean</code>        |


#### TcpConnectOptions

Connection parameters for opening a TCP socket.

Notes by platform:
- Android: validates port range (1..65535); applies TCP_NODELAY and SO_KEEPALIVE
  according to the flags. Connect timeout is enforced by Socket#connect.
- iOS: sets TCP_NODELAY, SO_KEEPALIVE and SO_NOSIGPIPE. Connect timeout is
  enforced using non-blocking connect + polling.
- Electron: sets noDelay and keepAlive (with 60s initial delay). Connect
  timeout is emulated via a JS timer that destroys the socket if elapsed.

| Prop            | Type                 | Description                                                              |
| --------------- | -------------------- | ------------------------------------------------------------------------ |
| **`host`**      | <code>string</code>  | Hostname or IP address to connect to. Required.                          |
| **`port`**      | <code>number</code>  | TCP port, defaults to 9100. Valid range 1..65535 (validated on Android). |
| **`timeout`**   | <code>number</code>  | Connect timeout in milliseconds, defaults to 3000.                       |
| **`noDelay`**   | <code>boolean</code> | Enable TCP_NODELAY (Nagle off). Defaults to true.                        |
| **`keepAlive`** | <code>boolean</code> | Enable SO_KEEPALIVE. Defaults to true.                                   |


#### TcpDisconnectResult

Result of disconnect(). Always resolves. After disconnect, reading is false.
A tcpDisconnect event with reason 'manual' is also emitted by platforms.

| Prop               | Type                        | Description                                                          |
| ------------------ | --------------------------- | -------------------------------------------------------------------- |
| **`error`**        | <code>boolean</code>        |                                                                      |
| **`errorMessage`** | <code>string \| null</code> |                                                                      |
| **`disconnected`** | <code>boolean</code>        | True if the instance transitioned to disconnected state.             |
| **`reading`**      | <code>boolean</code>        | Whether the stream reader is active (always false after disconnect). |


#### TcpIsConnectedResult

Result of isConnected().
- Android performs a safe 1-byte peek unless streaming/RR is active, in which
  case it returns true if those are active to avoid consuming input.
- iOS/Electron return based on current socket open/close state.

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`connected`**    | <code>boolean</code>        |


#### TcpIsReadingResult

Result of isReading(). True if stream reader is active.

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`reading`**      | <code>boolean</code>        |


#### TcpWriteResult

Result of write().
- bytesSent equals the request length on success; 0 on failure.
- Fails with error=true if not connected or busy (RR in progress on some
  platforms).

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`bytesSent`**    | <code>number</code>         |


#### TcpWriteOptions

Bytes to write to the socket verbatim. Accepts number[] or <a href="#uint8array">Uint8Array</a>.

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

Result of writeAndRead().
- bytesSent is the number of request bytes written. If the operation fails
  due to a pure timeout (no bytes received), bytesSent can still equal the
  request length; for other errors it is 0.
- bytesReceived is the length of returned data (&lt;= maxBytes).
- matched indicates whether the expect pattern (if any) was found.

| Prop                | Type                        | Description                                                 |
| ------------------- | --------------------------- | ----------------------------------------------------------- |
| **`error`**         | <code>boolean</code>        |                                                             |
| **`errorMessage`**  | <code>string \| null</code> |                                                             |
| **`bytesSent`**     | <code>number</code>         |                                                             |
| **`bytesReceived`** | <code>number</code>         |                                                             |
| **`data`**          | <code>number[]</code>       | Received bytes (may be partial if timeout after some data). |
| **`matched`**       | <code>boolean</code>        | True if the expect pattern was matched; false otherwise.    |


#### TcpWriteAndReadOptions

Options for writeAndRead() request/response operation.

Behavior summary (parity across Android/iOS/Electron):
- The request is written atomically with internal serialization (no interleaved
  writes across concurrent calls).
- Response collection ends when ANY of these happens:
  • expect pattern is found (matched=true), or
  • maxBytes cap is reached, or
  • without expect: adaptive "until-idle" period elapses after last data, or
  • absolute timeout elapses (see errors below).
- On timeout:
  • If no data arrived at all, the call fails with error=true and
    errorMessage resembling "connect timeout" and bytesSent equals the request
    length on Android/iOS/Electron; bytesReceived=0, matched=false.
  • If some data arrived before the deadline, the call resolves successfully
    with matched=false and returns the partial data.
- suspendStreamDuringRR: when true, the active stream reader is temporarily
  stopped for the RR window to avoid racing over the same bytes; after RR it
  is resumed with the previous chunk size. Default is true on Android & iOS;
  Electron treats it as true by default as well.
- expect: hex string like "0A0B0C" (case/spacing ignored) or a byte array.

| Prop                        | Type                                                                    | Description                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`data`**                  | <code>number[] \| <a href="#uint8array">Uint8Array</a></code>           | Request payload to send.                                                                                                                                                                                                                                               |
| **`timeout`**               | <code>number</code>                                                     | Absolute RR timeout in ms. Defaults to 1000.                                                                                                                                                                                                                           |
| **`maxBytes`**              | <code>number</code>                                                     | Maximum number of bytes to accumulate and return. Defaults to 4096.                                                                                                                                                                                                    |
| **`expect`**                | <code>string \| number[] \| <a href="#uint8array">Uint8Array</a></code> | Optional expected pattern. When provided, reading stops as soon as the accumulated buffer contains this pattern. Accepts: - number[] / <a href="#uint8array">Uint8Array</a>: raw byte sequence - string: hex bytes (e.g., "0x1b40", "1B 40"), spacing and case ignored |
| **`suspendStreamDuringRR`** | <code>boolean</code>                                                    | Temporarily suspend the stream reader during RR to avoid consuming reply in the stream. Defaults to true (Android default true; iOS behaves as if true; Electron defaults to true as well).                                                                            |


#### TcpStartStopResult

Result of startRead()/stopRead().

| Prop               | Type                        | Description                                    |
| ------------------ | --------------------------- | ---------------------------------------------- |
| **`error`**        | <code>boolean</code>        |                                                |
| **`errorMessage`** | <code>string \| null</code> |                                                |
| **`reading`**      | <code>boolean</code>        | Whether the stream reader is currently active. |


#### TcpStartReadOptions

Options for startRead().
- chunkSize controls maximum size of a single tcpData event slice. Native
  implementations may micro-batch multiple small reads; Electron additionally
  splits a flushed batch into slices up to chunkSize to preserve consumer
  expectations.
- readTimeout applies only on Android (socket SO_TIMEOUT while streaming). It
  is a no-op on iOS. Electron stores it for RR but does not apply to stream.

| Prop              | Type                | Description                                                        |
| ----------------- | ------------------- | ------------------------------------------------------------------ |
| **`chunkSize`**   | <code>number</code> | Maximum bytes per emitted tcpData event. Default 4096.             |
| **`readTimeout`** | <code>number</code> | Stream read timeout (ms). Android: applies SO_TIMEOUT; iOS: no-op. |


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |


#### TcpDataEvent

Emitted by the stream reader with micro-batched data chunks.
- Data values are 0..255. The plugin may coalesce multiple small reads and
  then emit one or more events capped by chunkSize.

| Prop       | Type                  |
| ---------- | --------------------- |
| **`data`** | <code>number[]</code> |


#### TcpDisconnectEvent

Emitted when the socket is closed or the plugin disconnects it.
- reason:
  • 'manual' — disconnect() called or instance disposed.
  • 'remote' — the peer closed the connection (EOF).
  • 'error'  — an I/O error occurred; error contains a message.
- reading is false when this event fires.

| Prop               | Type                                         |
| ------------------ | -------------------------------------------- |
| **`disconnected`** | <code>true</code>                            |
| **`reading`**      | <code>boolean</code>                         |
| **`reason`**       | <code>'error' \| 'manual' \| 'remote'</code> |
| **`error`**        | <code>string</code>                          |


### Type Aliases


#### ArrayBufferLike

<code>ArrayBufferTypes[keyof ArrayBufferTypes]</code>

</docgen-api>
