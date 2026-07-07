# @devioarts/capacitor-tcpclient

TCP client plugin for Capacitor apps with native Android, iOS and Electron support.

Use it when your app needs to talk to a TCP device or service directly, for example
printers, scanners, controllers, gateways or local network hardware.

## Features

- Native TCP sockets on Android, iOS and Electron
- Multi-connection API with isolated listeners per connection
- Raw writes, continuous stream reads and request/response reads
- Byte payloads as `number[]` or `Uint8Array`
- Optional `expect` pattern matching for protocol replies
- Web stub for browser development builds

## Install

```bash
npm install @devioarts/capacitor-tcpclient
npx cap sync
```

Android network permissions are merged automatically from the plugin manifest.
See [Getting started](docs/getting-started.md) for manual Android fallback notes
and the required iOS setup.

## Quick Start

```ts
import { TCPClient } from '@devioarts/capacitor-tcpclient';

const conn = TCPClient.createConnection({
  host: '192.168.1.100',
  port: 9100,
  timeout: 3000,
});

await conn.connect();

const reply = await conn.writeAndRead({
  data: [0x1b, 0x40],
  timeout: 1000,
  maxBytes: 4096,
});

if (reply.error) {
  console.error(reply.errorMessage);
} else {
  console.log('Received bytes:', reply.data);
}

await conn.destroy();
```

## Capacitor App Example

```ts
import { TCPClient, type TCPConnection } from '@devioarts/capacitor-tcpclient';

let connection: TCPConnection | undefined;

export async function connectToDevice(host: string) {
  connection = TCPClient.createConnection({ connectionId: 'main-device', host, port: 9100 });

  await connection.addListener('tcpDisconnect', ({ reason, error }) => {
    console.log('TCP disconnected:', reason, error ?? '');
  });

  return connection.connect();
}

export async function sendCommand(command: Uint8Array) {
  if (!connection) throw new Error('TCP connection is not ready');

  return connection.writeAndRead({
    data: command,
    expect: '0d0a',
    timeout: 1500,
    maxBytes: 8192,
  });
}

export async function disconnectFromDevice() {
  await connection?.destroy();
  connection = undefined;
}
```

## Documentation

- [Getting started](docs/getting-started.md): installation, Android/iOS setup and playground notes
- [Usage guide](docs/usage.md): Capacitor examples, streaming, request/response and lifecycle patterns
- [Electron integration](docs/electron.md): Capacitor Electron and manual Electron bridge setup
- [Behavior and FAQ](docs/behavior.md): timeouts, buffering, platform notes and troubleshooting
- [API reference](#api): generated TypeScript API reference in this README

## Platform Support

| Platform | Status | Notes |
| --- | --- | --- |
| Android | Native TCP | Internet/network permissions are merged automatically |
| iOS | Native TCP | Requires local network usage description for local devices |
| Electron | Native TCP | Use Capacitor Electron or the manual bridge |
| Web | Development stub | Keeps the same API shape, but does not open real TCP sockets |

## Common Commands

```bash
npm run build
npm test
npm run verify:web
```

## API

The generated API below documents the root
`@devioarts/capacitor-tcpclient` entry point used by Capacitor apps. The manual
Electron bridge exposes the native methods directly over IPC, so it uses
`connectionId` on every call instead of `createConnection()`.

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

| Method                 | Signature                                                                                                                                                                                          | Description                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **connect**            | (options?: <a href="#partial">Partial</a>&lt;<a href="#tcpconnectoptions">TcpConnectOptions</a>&gt; \| undefined) =&gt; Promise&lt;<a href="#tcpconnectresult">TcpConnectResult</a>&gt;            | Open the socket. Options are merged with the defaults supplied in createConnection(). host must be present either in createConnection() or here.                                                                                                                                                                                                                          |
| **disconnect**         | () =&gt; Promise&lt;<a href="#tcpdisconnectresult">TcpDisconnectResult</a>&gt;                                                                                                                     | Close the socket. Idempotent. Resolves after native teardown completes. Emits tcpDisconnect(reason: manual).                                                                                                                                                                                                                                                              |
| **isConnected**        | () =&gt; Promise&lt;<a href="#tcpisconnectedresult">TcpIsConnectedResult</a>&gt;                                                                                                                   |                                                                                                                                                                                                                                                                                                                                                                           |
| **isReading**          | () =&gt; Promise&lt;<a href="#tcpisreadingresult">TcpIsReadingResult</a>&gt;                                                                                                                       |                                                                                                                                                                                                                                                                                                                                                                           |
| **write**              | (options: <a href="#tcpwriteoptions">TcpWriteOptions</a>) =&gt; Promise&lt;<a href="#tcpwriteresult">TcpWriteResult</a>&gt;                                                                        |                                                                                                                                                                                                                                                                                                                                                                           |
| **writeAndRead**       | (options: <a href="#tcpwriteandreadoptions">TcpWriteAndReadOptions</a>) =&gt; Promise&lt;<a href="#tcpwriteandreadresult">TcpWriteAndReadResult</a>&gt;                                            |                                                                                                                                                                                                                                                                                                                                                                           |
| **startRead**          | (options?: <a href="#tcpstartreadoptions">TcpStartReadOptions</a> \| undefined) =&gt; Promise&lt;<a href="#tcpstartstopresult">TcpStartStopResult</a>&gt;                                          |                                                                                                                                                                                                                                                                                                                                                                           |
| **stopRead**           | () =&gt; Promise&lt;<a href="#tcpstartstopresult">TcpStartStopResult</a>&gt;                                                                                                                       |                                                                                                                                                                                                                                                                                                                                                                           |
| **setReadTimeout**     | (options: { readTimeout: number; }) =&gt; Promise&lt;{ error: boolean; errorMessage?: string \| null; }&gt;                                                                                        | Configure stream read timeout. - Android: sets `SO_TIMEOUT` on the continuous reader socket (applies during `startRead`). - iOS: no-op (evented I/O, no blocking timeout). - Electron: sets the default `timeout` value used by `writeAndRead` when no explicit timeout is passed; if called before connect, the default is stored without creating a socket state entry. |
| **addListener**        | (eventName: 'tcpData', listenerFunc: (event: <a href="#tcpdataevent">TcpDataEvent</a>) =&gt; void) =&gt; Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;                   | Subscribe to stream data. Only events for this connectionId are delivered.                                                                                                                                                                                                                                                                                                |
| **addListener**        | (eventName: 'tcpDisconnect', listenerFunc: (event: <a href="#tcpdisconnectevent">TcpDisconnectEvent</a>) =&gt; void) =&gt; Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt; | Subscribe to disconnect notifications for this connection.                                                                                                                                                                                                                                                                                                                |
| **removeAllListeners** | () =&gt; Promise&lt;void&gt;                                                                                                                                                                       | Remove all listeners registered through this instance.                                                                                                                                                                                                                                                                                                                    |
| **destroy**            | () =&gt; Promise&lt;void&gt;                                                                                                                                                                       | Disconnect, remove all listeners, and release this instance from the registry even if listener cleanup fails.                                                                                                                                                                                                                                                             |


#### TcpConnectResult

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`connected`**    | <code>boolean</code>        |


#### TcpConnectOptions

| Prop            | Type                 | Description                                                                            |
| --------------- | -------------------- | -------------------------------------------------------------------------------------- |
| **`host`**      | <code>string</code>  | Hostname or IP address. Required (either here or in createConnection).                 |
| **`port`**      | <code>number</code>  | TCP port, default 9100. Valid range 1..65535.                                          |
| **`timeout`**   | <code>number</code>  | Connect timeout in milliseconds, default 3000. Includes DNS and socket connect budget. |
| **`noDelay`**   | <code>boolean</code> | Enable TCP_NODELAY (Nagle off). Default true.                                          |
| **`keepAlive`** | <code>boolean</code> | Enable SO_KEEPALIVE. Default true.                                                     |


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

| Prop                        | Type                                                                | Description                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`data`**                  | <code><a href="#tcpbytepayload">TcpBytePayload</a></code>           |                                                                                                                                                                     |
| **`timeout`**               | <code>number</code>                                                 | RR timeout in ms. Default 1000. Values &lt;= 0 fall back to the default.                                                                                            |
| **`maxBytes`**              | <code>number</code>                                                 | Maximum bytes to accumulate. Default 4096, capped at 16 MiB.                                                                                                        |
| **`expect`**                | <code>string \| <a href="#tcpbytepayload">TcpBytePayload</a></code> | Optional pattern — reading stops when found. Accepts number[] / Uint8Array or hex string (e.g. "1B40", "0x1b 0x40"). Empty values are treated as no expect pattern. |
| **`suspendStreamDuringRR`** | <code>boolean</code>                                                | Suspend stream reader during RR to avoid consuming reply. Default true.                                                                                             |


#### TcpStartStopResult

| Prop               | Type                        |
| ------------------ | --------------------------- |
| **`error`**        | <code>boolean</code>        |
| **`errorMessage`** | <code>string \| null</code> |
| **`reading`**      | <code>boolean</code>        |


#### TcpStartReadOptions

| Prop              | Type                | Description                                                                                                                                                                                                             |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`chunkSize`**   | <code>number</code> | Stream read chunk size in bytes. Default 4096, capped at 16 MiB. - Android/iOS: size of each native socket read before bridge micro-batching. - Electron: maximum bytes per emitted tcpData event after micro-batching. |
| **`readTimeout`** | <code>number</code> | Stream read timeout in ms. - Android: sets `SO_TIMEOUT` for the continuous reader. - iOS: no-op. - Electron: updates the per-connection default `writeAndRead` timeout; the stream reader itself remains event-driven.  |


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

Byte payload accepted by write APIs. Values must be integer bytes in the 0..255 range.

<code>number[] | <a href="#tcpbytearraylike">TcpByteArrayLike</a></code>


#### TcpPlatform

<code>'ios' | 'android' | 'web' | 'electron'</code>

</docgen-api>

## License

MIT
