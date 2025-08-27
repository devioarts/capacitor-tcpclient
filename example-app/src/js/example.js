import { TCPClient } from '@devioarts/capacitor-tcpclient';

//<editor-fold desc="TCP Client">
const hexToBytes = (str) => {
  const clean = str.replace(/0x/gi, '').replace(/\s+/g, '').toLowerCase();
  if (!clean || clean.length % 2) throw new Error('hex string has odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return Array.from(out);
};

const bytesToHex = (bytes) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

const strToUtf8Bytes = (s) => Array.from(new TextEncoder().encode(s)); // pro echo server OK

// ===== Event subscriptions =====
let _unsubData = null;
let _unsubDisc = null;

window.tcpListenOn = () => {
  if (!_unsubData) {
    _unsubData = TCPClient.addListener('tcpData', (e) => {
      console.log('[tcpData]', e.data, 'hex=', bytesToHex(e.data || []));
    });
    console.log('tcpOn:[tcpData] listener attached');
  }
  if (!_unsubDisc) {
    _unsubDisc = TCPClient.addListener('tcpDisconnect', (e) => {
      console.warn('[tcpDisconnect]', e);
    });
    console.log('tcpOn:[tcpDisconnect] listener attached');
  }
};
window.tcpListenOff = async () => {
  TCPClient.removeAllListeners();
  console.log('tcpOff: listeners removed');
  _unsubData = null;
  _unsubDisc = null;
};

// ===== Core API wrappers =====
window.tcpConnect = async (opts = {}) => {
  const cfg = {
    host: document.getElementById('tcpIP').value,
    port: 9100,
    timeoutMs: 3000,
    noDelay: true,
    keepAlive: true,
    ...opts,
  };
  const r = await TCPClient.tcpConnect(cfg);
  console.log('tcpConnect ->', r);
  return r;
};

window.tcpDisconnect = async () => {
  const r = await TCPClient.tcpDisconnect();
  console.log('tcpDisconnect ->', r);
  return r;
};

window.tcpIsConnected = async () => {
  const r = await TCPClient.tcpIsConnected();
  console.log('tcpIsConnected ->', r);
  return r.connected;
};

window.tcpStartRead = async (chunkSize = 4096, readTimeoutMs /* Android only */) => {
  const r = await TCPClient.tcpStartRead(
    readTimeoutMs != null ? { chunkSize, readTimeoutMs } : { chunkSize }
  );
  console.log('tcpStartRead ->', r);
  return r;
};

window.tcpStopRead = async () => {
  const r = await TCPClient.tcpStopRead();
  console.log('tcpStopRead ->', r);
  return r;
};

window.tcpIsReading = async () => {
  const r = await TCPClient.tcpIsReading();
  console.log('tcpIsReading ->', r);
}

window.tcpSetReadTimeout = async (ms = 1000) => {
  // Android: nastaví socket timeout; iOS: no-op, ale metoda existuje.
  const r = await TCPClient.tcpSetReadTimeout({ ms });
  console.log('tcpSetReadTimeout ->', r);
  return r;
};

// ===== Writes =====
window.tcpWriteArr = async (arr /* number[] 0..255 */) => {
  const r = await TCPClient.tcpWrite({ data: arr.map(n => n & 0xFF) });
  console.log('tcpWriteArr ->', r);
  return r;
};

window.tcpWriteHex = async (hex /* "1b40..." / "1B 40" */) => {
  const data = hexToBytes(hex);
  const r = await TCPClient.tcpWrite({ data });
  console.log('tcpWriteHex ->', r);
  return r;
};

window.tcpWriteText = async (text /* string */, appendLF = true) => {
  // POZOR: tiskárny obv. chtějí CP437/CP852; tohle je jen UTF-8 pro test/echo server.


  const data = strToUtf8Bytes(appendLF ? text + '\n' : text);
  const r = await TCPClient.tcpWrite({ data });
  console.log('tcpWriteText ->', r);
  return r;
};

// ===== Write & Read =====
window.tcpWriteAndRead = async (opts) => {
  // opts: { data: number[] | hex?: string, timeoutMs?, maxBytes?, expectHex?, expectArr?, suspendStreamDuringRR? }
  let data = opts.data;
  if (!data && opts.hex) data = hexToBytes(opts.hex);

  let expect;
  if (opts?.expectHex) expect = opts.expectHex.replace(/\s+/g, '').toLowerCase();
  const payload = {
    data,
    timeoutMs: opts?.timeoutMs ?? 1000,
    maxBytes: opts?.maxBytes ?? 4096,
    suspendStreamDuringRR: opts?.suspendStreamDuringRR ?? false,
  };
  if (expect) payload.expect = expect;           // hex string pattern
  else if (opts?.expectArr) payload.expect = opts.expectArr; // number[] pattern

  TCPClient.tcpWriteAndRead(payload)
    .then(r => {
      console.log('O','tcpWriteAndRead ->', r);
    })
    .catch(e => {
      console.error('E','tcpWriteAndRead ->', e);
    });

};

// ===== ESC/POS mini-helpers =====
window.escposInit = () => tcpWriteHex('1B 40'); // ESC @
window.escposPC = () => tcpWriteHex('1B 74 18'); // ESC @
window.escposCutPartial = () => tcpWriteHex('1D 56 42 10'); // GS V B n (částečný řez, n≈16)
window.escposFeed = (n = 3) => tcpWriteArr([0x1B, 0x64, n & 0xFF]); // ESC d n

// Rychlý test tiskárny (bez odezvy – jen poslat příkaz)
window.testPrint = async (text = 'Hello ESC/POS') => {
  await escposInit();
  await tcpWriteText(text);
  await escposFeed(2);
  await escposFeed(3);
  await escposCutPartial();
  console.log('testPrint done');
};

// Realtime status (mnoho Epsonů vrací 1 byte): DLE EOT 1
window.epsonRealtimeStatus = async () =>
  tcpWriteAndRead({
    data: [0x10, 0x04, 0x01],
    timeoutMs: 500,
    maxBytes: 32,
    // často je lepší pozastavit stream, aby odpověď "neukradl" reader:
    suspendStreamDuringRR: true,
  });

//</editor-fold>






