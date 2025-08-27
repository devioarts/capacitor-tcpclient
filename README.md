# @devioarts/capacitor-tcpclient

TCP Client for CapacitorJS

## Install

```bash
npm install @devioarts/capacitor-tcpclient
npx cap sync
```


## iOS
### CapacitorJS

```bash
npm install @capacitor/ios
npm run build
npx cap add ios --packagemanager SPM
```

### info.plist

```file:ios/App/App/Info.plist
<key>NSLocalNetworkUsageDescription</key>
<string>Local server/client connection</string>
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
<key>NSBonjourServices</key>
<array>
    <string>_http._tcp</string>
    <string>_lancomm._tcp</string>
</array>
```

## API

<docgen-index>

* [`tcpConnect(...)`](#tcpconnect)
* [`tcpWrite(...)`](#tcpwrite)
* [`tcpWriteAndRead(...)`](#tcpwriteandread)
* [`tcpStartRead(...)`](#tcpstartread)
* [`tcpStopRead()`](#tcpstopread)
* [`tcpIsConnected()`](#tcpisconnected)
* [`tcpDisconnect()`](#tcpdisconnect)
* [`tcpIsReading()`](#tcpisreading)
* [`addListener('tcpData', ...)`](#addlistenertcpdata-)
* [`addListener('tcpDisconnect', ...)`](#addlistenertcpdisconnect-)
* [`removeAllListeners()`](#removealllisteners)
* [Interfaces](#interfaces)
* [Type Aliases](#type-aliases)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

Public plugin surface exposed to JS/TS consumers.

Usage example:
```ts
const res = await TCPClient.tcpConnect({ host: '192.168.1.50', port: 9100 });
if (!res.error && res.connected) {
  await TCPClient.tcpStartRead({ chunkSize: 1024 });
  const rr = await TCPClient.tcpWriteAndRead({ data: [0x1b, 0x40], timeoutMs: 500 });
}
```

### tcpConnect(...)

```typescript
tcpConnect(options: TcpConnectOptions) => Promise<TcpConnectResult>
```

| Param         | Type                                                            |
| ------------- | --------------------------------------------------------------- |
| **`options`** | <code><a href="#tcpconnectoptions">TcpConnectOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#tcpconnectresult">TcpConnectResult</a>&gt;</code>

--------------------


### tcpWrite(...)

```typescript
tcpWrite(options: TcpWriteOptions) => Promise<TcpWriteResult>
```

| Param         | Type                                                        |
| ------------- | ----------------------------------------------------------- |
| **`options`** | <code><a href="#tcpwriteoptions">TcpWriteOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#tcpwriteresult">TcpWriteResult</a>&gt;</code>

--------------------


### tcpWriteAndRead(...)

```typescript
tcpWriteAndRead(options: TcpWriteAndReadOptions) => Promise<TcpWriteAndReadResult>
```

| Param         | Type                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| **`options`** | <code><a href="#tcpwriteandreadoptions">TcpWriteAndReadOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#tcpwriteandreadresult">TcpWriteAndReadResult</a>&gt;</code>

--------------------


### tcpStartRead(...)

```typescript
tcpStartRead(options?: TcpStartReadOptions | undefined) => Promise<TcpStartStopResult>
```

| Param         | Type                                                                |
| ------------- | ------------------------------------------------------------------- |
| **`options`** | <code><a href="#tcpstartreadoptions">TcpStartReadOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#tcpstartstopresult">TcpStartStopResult</a>&gt;</code>

--------------------


### tcpStopRead()

```typescript
tcpStopRead() => Promise<TcpStartStopResult>
```

**Returns:** <code>Promise&lt;<a href="#tcpstartstopresult">TcpStartStopResult</a>&gt;</code>

--------------------


### tcpIsConnected()

```typescript
tcpIsConnected() => Promise<TcpIsConnectedResult>
```

**Returns:** <code>Promise&lt;<a href="#tcpisconnectedresult">TcpIsConnectedResult</a>&gt;</code>

--------------------


### tcpDisconnect()

```typescript
tcpDisconnect() => Promise<TcpDisconnectResult>
```

**Returns:** <code>Promise&lt;<a href="#tcpdisconnectresult">TcpDisconnectResult</a>&gt;</code>

--------------------


### tcpIsReading()

```typescript
tcpIsReading() => Promise<TcpIsReadingResult>
```

**Returns:** <code>Promise&lt;<a href="#tcpisreadingresult">TcpIsReadingResult</a>&gt;</code>

--------------------


### addListener('tcpData', ...)

```typescript
addListener(eventName: 'tcpData', listenerFunc: (event: TcpDataEvent) => void) => Promise<PluginListenerHandle>
```

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

--------------------


### Interfaces


#### TcpConnectResult

Result for connect().

| Prop            | Type                 |
| --------------- | -------------------- |
| **`connected`** | <code>boolean</code> |


#### TcpConnectOptions

Options for opening a TCP connection.

Parity:
- Mirrors iOS/Android native options.
Defaults:
- port: 9100
- timeoutMs: 3000
- noDelay: true
- keepAlive: true

| Prop            | Type                 |
| --------------- | -------------------- |
| **`host`**      | <code>string</code>  |
| **`port`**      | <code>number</code>  |
| **`timeoutMs`** | <code>number</code>  |
| **`noDelay`**   | <code>boolean</code> |
| **`keepAlive`** | <code>boolean</code> |


#### TcpWriteResult

Result for write().

| Prop               | Type                |
| ------------------ | ------------------- |
| **`bytesWritten`** | <code>number</code> |


#### TcpWriteOptions

Payload for raw write operations.
`data` can be a JS number[] or <a href="#uint8array">Uint8Array</a>; values are interpreted as bytes 0..255.

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

Result for writeAndRead().

| Prop               | Type                  |
| ------------------ | --------------------- |
| **`bytesWritten`** | <code>number</code>   |
| **`bytesRead`**    | <code>number</code>   |
| **`data`**         | <code>number[]</code> |


#### TcpWriteAndReadOptions

Request/Response helper: write bytes, then read back with a timeout and optional pattern.

Notes:
- `expect` can be a byte pattern (number[]) or a hex string (e.g., "1b40").
- `timeoutMs` is the overall RR timeout.
- `maxBytes` caps the response size.
- `suspendStreamDuringRR` pauses the streaming reader during RR to avoid stealing the reply
  (native default is **true** on both iOS and Android).

| Prop                        | Type                            |
| --------------------------- | ------------------------------- |
| **`expect`**                | <code>string \| number[]</code> |
| **`timeoutMs`**             | <code>number</code>             |
| **`maxBytes`**              | <code>number</code>             |
| **`suspendStreamDuringRR`** | <code>boolean</code>            |


#### TcpStartStopResult

Result for start/stop read.

| Prop          | Type                 |
| ------------- | -------------------- |
| **`reading`** | <code>boolean</code> |


#### TcpStartReadOptions

Options for starting continuous stream reading.

Notes:
- `readTimeoutMs` is Android-only; on iOS this is a no-op for API parity.

| Prop                | Type                |
| ------------------- | ------------------- |
| **`chunkSize`**     | <code>number</code> |
| **`readTimeoutMs`** | <code>number</code> |


#### TcpIsConnectedResult

Result for isConnected().

| Prop            | Type                 |
| --------------- | -------------------- |
| **`connected`** | <code>boolean</code> |


#### TcpDisconnectResult

Result for disconnect().

| Prop               | Type                 |
| ------------------ | -------------------- |
| **`disconnected`** | <code>boolean</code> |


#### TcpIsReadingResult

Result for isReading().

| Prop          | Type                 |
| ------------- | -------------------- |
| **`reading`** | <code>boolean</code> |


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |


### Type Aliases


#### ArrayBufferLike

<code>ArrayBufferTypes[keyof ArrayBufferTypes]</code>


#### TcpDataEvent

Event payloads
- `tcpData`: emitted with raw bytes as number[] (0..255)
- `tcpDisconnect`: emitted once per disconnect with a reason

Note: Android currently also includes `reading:false` in the disconnect payload
for UI convenience; that field is optional and may be ignored here.

<code>{ data: number[] }</code>


#### TcpDisconnectEvent

<code>{ disconnected: true; reason: 'manual' } | { disconnected: true; reason: 'remote' } | { disconnected: true; reason: 'error'; error: string }</code>

</docgen-api>
