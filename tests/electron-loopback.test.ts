import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

type ElectronClient = InstanceType<typeof import('../electron/src/index').TCPClient>;
type ElectronClientConstructor = typeof import('../electron/src/index').TCPClient;
type ModuleWithLoad = typeof Module & {
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
};

const moduleWithLoad = Module as unknown as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
  if (request === 'electron') {
    return {
      ipcMain: {
        on() {
          /* tests attach WebContents directly */
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let ElectronTCPClient: ElectronClientConstructor | undefined;

test('electron writeAndRead matches fragmented loopback response', async () => {
  const server = await loopback(async (socket) => {
    assert.deepEqual(await readExactly(socket, 4), Buffer.from([0x70, 0x69, 0x6e, 0x67]));
    socket.write(Buffer.from([0x10, 0x20]));
    await delay(25);
    socket.end(Buffer.from([0x30, 0x40]));
  });
  const client = await createClient();

  try {
    assert.equal((await client.connect(connectArgs(server.port))).error, false);
    const result = await client.writeAndRead({
      connectionId: 'a',
      data: [0x70, 0x69, 0x6e, 0x67],
      timeout: 1000,
      maxBytes: 16,
      expect: [0x30, 0x40],
    });

    assert.equal(result.error, false);
    assert.deepEqual(result.data, [0x10, 0x20, 0x30, 0x40]);
    assert.equal(result.matched, true);
    await client.destroyConnection({ connectionId: 'a' });
  } finally {
    await server.close();
  }
});

test('electron writeAndRead returns data when peer closes after response', async () => {
  const server = await loopback(async (socket) => {
    assert.deepEqual(await readExactly(socket, 3), Buffer.from([9, 8, 7]));
    socket.write(Buffer.from([1, 2, 3]));
    await delay(30);
    socket.end(Buffer.from([4, 5]));
  });
  const client = await createClient();

  try {
    assert.equal((await client.connect(connectArgs(server.port))).error, false);
    const result = await client.writeAndRead({
      connectionId: 'a',
      data: [9, 8, 7],
      timeout: 1000,
      maxBytes: 16,
    });

    assert.equal(result.error, false);
    assert.deepEqual(result.data, [1, 2, 3, 4, 5]);
    assert.equal(result.matched, false);
    await client.destroyConnection({ connectionId: 'a' });
  } finally {
    await server.close();
  }
});

test('electron writeAndRead without expect returns after adaptive idle', async () => {
  const server = await loopback(async (socket) => {
    assert.deepEqual(await readExactly(socket, 1), Buffer.from([1]));
    socket.write(Buffer.from([1, 2, 3]));
    await delay(30);
    socket.write(Buffer.from([4, 5]));
  });
  const client = await createClient();

  try {
    assert.equal((await client.connect(connectArgs(server.port))).error, false);
    const result = await client.writeAndRead({
      connectionId: 'a',
      data: [1],
      timeout: 1000,
      maxBytes: 16,
    });

    assert.equal(result.error, false);
    assert.deepEqual(result.data, [1, 2, 3, 4, 5]);
    assert.equal(result.matched, false);
    await client.destroyConnection({ connectionId: 'a' });
  } finally {
    await server.close();
  }
});

test('electron startRead emits loopback stream chunks', async () => {
  const server = await loopback(async (socket) => {
    socket.write(Buffer.from([1, 2, 3, 4, 5, 6]));
    await delay(50);
  });
  const client = await createClient();
  const webContents = new FakeWebContents();
  attachWebContents(client, webContents);

  try {
    assert.equal((await client.connect(connectArgs(server.port))).error, false);
    assert.deepEqual(await client.startRead({ connectionId: 'a', chunkSize: 2 }), {
      error: false,
      errorMessage: null,
      reading: true,
    });

    const payloads = await waitForData(webContents, 6);
    assert.deepEqual(
      payloads.flatMap((payload) => payload.data),
      [1, 2, 3, 4, 5, 6],
    );
    assert.ok(payloads.every((payload) => payload.connectionId === 'a'));
    assert.ok(payloads.every((payload) => payload.data.length <= 2));
    await client.destroyConnection({ connectionId: 'a' });
  } finally {
    await server.close();
  }
});

test('electron writeAndRead times out when server stays silent', async () => {
  const server = await loopback(async (socket) => {
    assert.deepEqual(await readExactly(socket, 3), Buffer.from([1, 2, 3]));
    await delay(300);
  });
  const client = await createClient();

  try {
    assert.equal((await client.connect(connectArgs(server.port))).error, false);
    const result = await client.writeAndRead({
      connectionId: 'a',
      data: [1, 2, 3],
      timeout: 120,
      maxBytes: 16,
      expect: [9],
    });

    assert.equal(result.error, true);
    assert.equal(result.errorMessage, 'timeout');
    assert.equal(result.bytesSent, 3);
    await client.destroyConnection({ connectionId: 'a' });
  } finally {
    await server.close();
  }
});

test('electron writeAndRead stops at maxBytes', async () => {
  const server = await loopback(async (socket) => {
    assert.deepEqual(await readExactly(socket, 1), Buffer.from([1]));
    socket.write(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });
  const client = await createClient();

  try {
    assert.equal((await client.connect(connectArgs(server.port))).error, false);
    const result = await client.writeAndRead({
      connectionId: 'a',
      data: [1],
      timeout: 1000,
      maxBytes: 4,
    });

    assert.equal(result.error, false);
    assert.deepEqual(result.data, [1, 2, 3, 4]);
    assert.equal(result.matched, false);
    await client.destroyConnection({ connectionId: 'a' });
  } finally {
    await server.close();
  }
});

test('electron concurrent write is busy while request response is in flight', async () => {
  const server = await loopback(async (socket) => {
    assert.deepEqual(await readExactly(socket, 1), Buffer.from([0x01]));
    await delay(200);
    socket.write(Buffer.from([0x55]));
  });
  const client = await createClient();

  try {
    assert.equal((await client.connect(connectArgs(server.port))).error, false);
    const rr = client.writeAndRead({
      connectionId: 'a',
      data: [0x01],
      timeout: 1000,
      maxBytes: 8,
      expect: [0x55],
    });
    const writeResult = await client.write({ connectionId: 'a', data: [0x02] });

    assert.equal(writeResult.error, true);
    assert.equal(writeResult.errorMessage, 'busy');
    assert.equal((await rr).error, false);
    await client.destroyConnection({ connectionId: 'a' });
  } finally {
    await server.close();
  }
});

async function createClient(): Promise<ElectronClient> {
  if (!ElectronTCPClient) {
    ElectronTCPClient = (await import('../electron/src/index.js')).TCPClient;
  }
  const Client = ElectronTCPClient;
  return new Client();
}

function connectArgs(port: number) {
  return { connectionId: 'a', host: '127.0.0.1', port, timeout: 1000 };
}

function attachWebContents(client: ElectronClient, webContents: FakeWebContents) {
  (client as unknown as { attachWebContents(webContents: FakeWebContents): void }).attachWebContents(webContents);
}

async function loopback(handler: (socket: net.Socket) => Promise<void> | void): Promise<LoopbackServer> {
  const server = net.createServer((socket) => {
    Promise.resolve(handler(socket))
      .catch((error) => socket.destroy(error))
      .finally(() => {
        if (!socket.destroyed) socket.end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return new LoopbackServer(server, address.port);
}

async function readExactly(socket: net.Socket, count: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < count) {
    const chunk = socket.read(count - size) as Buffer | null;
    if (chunk) {
      chunks.push(chunk);
      size += chunk.length;
      continue;
    }
    await once(socket, 'readable');
  }
  return Buffer.concat(chunks, size);
}

function once(emitter: EventEmitter, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      emitter.off(event, onEvent);
      emitter.off('error', onError);
      emitter.off('close', onClose);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`closed before ${event}`));
    };
    emitter.once(event, onEvent);
    emitter.once('error', onError);
    emitter.once('close', onClose);
  });
}

async function waitForData(webContents: FakeWebContents, byteCount: number): Promise<TcpDataPayload[]> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const payloads = webContents.sent
      .filter((event) => event.channel === 'event-TCPClient-tcpData')
      .map((event) => event.payload);
    const total = payloads.reduce((sum, payload) => sum + payload.data.length, 0);
    if (total >= byteCount) return payloads;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${byteCount} stream bytes`);
}

interface TcpDataPayload {
  connectionId: string;
  data: number[];
}

class FakeWebContents extends EventEmitter {
  sent: Array<{ channel: string; payload: TcpDataPayload }> = [];

  isDestroyed() {
    return false;
  }

  send(channel: string, payload: TcpDataPayload) {
    this.sent.push({ channel, payload });
  }
}

class LoopbackServer {
  constructor(
    private readonly server: net.Server,
    readonly port: number,
  ) {}

  async close() {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    });
  }
}
