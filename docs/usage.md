# Usage Guide

The root package exports a multi-connection API. Each call to
`TCPClient.createConnection()` returns a `TCPConnection` instance with its own
socket lifecycle and event listeners.

## Basic Capacitor Connection

```ts
import { TCPClient } from '@devioarts/capacitor-tcpclient';

const conn = TCPClient.createConnection({
  connectionId: 'printer-1',
  host: '192.168.1.100',
  port: 9100,
  timeout: 3000,
});

const result = await conn.connect();

if (!result.connected) {
  throw new Error(result.errorMessage ?? 'Unable to connect');
}
```

Passing a `connectionId` makes the instance reusable. Calling
`createConnection({ connectionId: 'printer-1' })` again returns the same
registered instance until `destroy()` is called.

## Send Bytes

```ts
const write = await conn.write({
  data: [0x1b, 0x40],
});

console.log('Bytes sent:', write.bytesSent);
```

`data` can be a plain `number[]` or a `Uint8Array`:

```ts
const command = new Uint8Array([0x02, 0x10, 0x03]);
await conn.write({ data: command });
```

Byte values must be integers in the `0..255` range. Invalid values return an
error instead of being silently masked.

## Request / Response

Use `writeAndRead()` when a command should receive a bounded reply.

```ts
const reply = await conn.writeAndRead({
  data: [0x1b, 0x40],
  timeout: 1000,
  maxBytes: 4096,
});

if (reply.error) {
  console.error(reply.errorMessage);
} else {
  console.log(reply.bytesReceived, reply.data);
}
```

Without `expect`, the plugin reads until a short idle window so fragmented device
replies can be collected into one result.

## Request / Response With `expect`

`expect` stops the read as soon as the byte pattern is found. It accepts a byte
array or a hex string.

```ts
const reply = await conn.writeAndRead({
  data: new Uint8Array([0x02, 0x41, 0x03]),
  expect: '0d0a',
  timeout: 1500,
  maxBytes: 8192,
});

if (!reply.error && reply.matched) {
  console.log('Complete reply:', reply.data);
}
```

If the timeout expires after some data arrived, the operation returns success
with `matched: false`. If no data arrived before timeout, it returns a timeout
error.

## Continuous Stream Reads

Use stream reads when the remote side sends data independently of commands.
Register listeners before calling `startRead()` so early data is not missed.

```ts
const dataHandle = await conn.addListener('tcpData', ({ data }) => {
  console.log('RX chunk:', data);
});

const disconnectHandle = await conn.addListener('tcpDisconnect', ({ reason, error }) => {
  console.log('Disconnected:', reason, error ?? '');
});

await conn.startRead({ chunkSize: 4096 });

// Later
await conn.stopRead();
await dataHandle.remove();
await disconnectHandle.remove();
```

Native and Electron implementations micro-batch stream events every 10 ms or
16 KB. `chunkSize` controls native socket read size on Android/iOS and emitted
event split size on Electron.

## Stream Plus Request / Response

By default, `writeAndRead()` temporarily suspends the stream reader so the
request/response reply cannot be consumed by the stream listener.

```ts
await conn.startRead();

const reply = await conn.writeAndRead({
  data: [0x05],
  expect: [0x06],
  timeout: 1000,
  suspendStreamDuringRR: true,
});

console.log(reply.matched);
```

Set `suspendStreamDuringRR: false` only when your protocol is designed to let
stream and request/response reads run at the same time.

## Multiple Connections

Each connection instance is isolated by `connectionId`.

```ts
const printer = TCPClient.createConnection({
  connectionId: 'printer',
  host: '192.168.1.50',
  port: 9100,
});

const controller = TCPClient.createConnection({
  connectionId: 'controller',
  host: '192.168.1.60',
  port: 4000,
});

await Promise.all([printer.connect(), controller.connect()]);

await printer.write({ data: [0x1b, 0x40] });
await controller.writeAndRead({ data: [0x01], expect: [0x06] });
```

Listeners registered through one instance only receive events for that
connection.

## Lifecycle Pattern

For application code, keep connection ownership explicit and always release the
connection when the screen or service no longer needs it.

```ts
import { TCPClient, type TCPConnection } from '@devioarts/capacitor-tcpclient';

let conn: TCPConnection | undefined;

export async function openTcp(host: string, port = 9100) {
  conn = TCPClient.createConnection({ connectionId: 'device', host, port });
  await conn.connect();
  return conn;
}

export async function closeTcp() {
  await conn?.destroy();
  conn = undefined;
}
```

`destroy()` disconnects, removes listeners and releases the instance from the
registry. Use it for final cleanup. Use `disconnect()` when you want to close the
socket but keep the instance and listeners for a later reconnect.

## React / Ionic Example

```tsx
import { useEffect, useRef, useState } from 'react';
import { TCPClient, type TCPConnection } from '@devioarts/capacitor-tcpclient';

export function TcpPanel() {
  const connRef = useRef<TCPConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastReply, setLastReply] = useState<number[]>([]);

  async function connect() {
    const conn = TCPClient.createConnection({
      connectionId: 'panel-device',
      host: '192.168.1.100',
      port: 9100,
    });

    await conn.addListener('tcpDisconnect', () => setConnected(false));
    const result = await conn.connect();

    connRef.current = conn;
    setConnected(result.connected);
  }

  async function ping() {
    const conn = connRef.current;
    if (!conn) return;

    const reply = await conn.writeAndRead({
      data: [0x05],
      expect: [0x06],
      timeout: 1000,
    });

    if (!reply.error) setLastReply(reply.data);
  }

  useEffect(() => {
    return () => {
      void connRef.current?.destroy();
    };
  }, []);

  return (
    <main>
      <button onClick={connect} disabled={connected}>
        Connect
      </button>
      <button onClick={ping} disabled={!connected}>
        Ping
      </button>
      <pre>{JSON.stringify(lastReply)}</pre>
    </main>
  );
}
```

## Convert Text and Hex to Bytes

The plugin accepts bytes, so it is often useful to keep protocol conversion near
your app code.

```ts
export function textBytes(value: string) {
  return new TextEncoder().encode(value);
}

export function hexBytes(value: string) {
  const compact = value.replace(/(?:0x|\s|,|:|-)/gi, '');
  if (compact.length % 2 !== 0) throw new Error('Hex string must have an even length');

  return Uint8Array.from(compact.match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16));
}

await conn.write({ data: textBytes('STATUS\r\n') });
await conn.writeAndRead({ data: hexBytes('1b 40'), expect: '0d0a' });
```
