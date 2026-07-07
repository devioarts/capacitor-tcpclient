# Electron Integration

There are two supported Electron paths:

- Capacitor Electron through
  [devioarts/capacitor-electron](https://github.com/devioarts/capacitor-electron)
- Manual Electron integration with the package's main-process bridge

Use the root import in Capacitor app code:

```ts
import { TCPClient } from '@devioarts/capacitor-tcpclient';
```

Use the Electron export only in the Electron main process:

```ts
import { TCPClient } from '@devioarts/capacitor-tcpclient/electron';
```

## Capacitor Electron

When using `devioarts/capacitor-electron`, keep using the same root package API
as Android and iOS:

```ts
import { TCPClient } from '@devioarts/capacitor-tcpclient';

const conn = TCPClient.createConnection({
  connectionId: 'electron-device',
  host: '127.0.0.1',
  port: 9100,
});

await conn.connect();
await conn.write({ data: [0x1b, 0x40] });
await conn.destroy();
```

The playground includes `public/electron-init.js`, which adapts
`CapacitorCustomPlatform.plugins.TCPClient` for the root package API.

## Manual Electron Bridge

In a plain Electron app, register the bridge in the main process, expose a small
API from the preload script and call the low-level methods from the renderer
with your own `connectionId`.

### Main Process

```ts
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
        return {
          error: true,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
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

### Preload

```ts
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
      },
    });
  },
};

contextBridge.exposeInMainWorld('TCPClient', api);
```

### Renderer

```ts
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

const dataListener = await client.addListener('tcpData', (event) => {
  if (event.connectionId === connectionId) console.log('RX:', event.data);
});

const disconnectListener = await client.addListener('tcpDisconnect', (event) => {
  if (event.connectionId === connectionId) console.log('disconnected:', event.reason);
});

await client.startRead({ connectionId, chunkSize: 4096 });

const rr = await client.writeAndRead({
  connectionId,
  data: [0x1b, 0x40],
  timeout: 1000,
});

console.log(rr.error ? rr.errorMessage : rr.data);

await client.disconnect({ connectionId });
await client.destroyConnection({ connectionId });
await dataListener.remove();
await disconnectListener.remove();
```

## Notes

- Instantiate and register the Electron bridge once in the main process.
- If your dev setup hot-reloads main-process modules, guard
  `registerTCPClient()` so `ipcMain.handle(...)` handlers are not registered
  twice.
- Manual Electron integration uses low-level methods directly and requires
  `connectionId` on every call.
- Only the `WebContents` of the last window that registered a TCP event listener
  receives `tcpData` and `tcpDisconnect` events. Multi-window apps should add a
  custom event fan-out layer in the main process.
