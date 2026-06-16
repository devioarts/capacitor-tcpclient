import React, { createContext, useContext, useRef, useState } from "react";
import { TCPClient } from "@devioarts/capacitor-tcpclient";
import type { TCPConnection } from "@devioarts/capacitor-tcpclient";
import { useLogger } from "../components/Logger.tsx";

function fromHex(s: string): number[] | null {
  const clean = s.toLowerCase().replace(/0x/g, "").replace(/\s+/g, "");
  if (!clean || clean.length % 2) return null;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const v = parseInt(clean.slice(i, i + 2), 16);
    if (Number.isNaN(v)) return null;
    out.push(v & 0xff);
  }
  return out;
}

function utf8ToArr(s: string): number[] { return Array.from(new TextEncoder().encode(s)); }

interface TCPState {
  // Connection
  connectionId: string; setConnectionId: (v: string) => void;
  host: string;         setHost:         (v: string) => void;
  port: number;         setPort:         (v: number) => void;
  connTimeout: number;  setConnTimeout:  (v: number) => void;
  noDelay: boolean;     setNoDelay:      (v: boolean) => void;
  keepAlive: boolean;   setKeepAlive:    (v: boolean) => void;
  connected: boolean;
  listenings: boolean;
  // Stream
  chunkSize: number;     setChunkSize:     (v: number) => void;
  readerTimeout: number; setReaderTimeout: (v: number) => void;
  reading: boolean;
  // Write
  writeMode: "text" | "hex" | "array"; setWriteMode: (v: "text" | "hex" | "array") => void;
  txt:    string; setTxt:    (v: string) => void;
  hex:    string; setHex:    (v: string) => void;
  arrStr: string; setArrStr: (v: string) => void;
  // RR
  req:        string;                       setReq:        (v: string) => void;
  rrTimeout:  number;                       setRRTimeout:  (v: number) => void;
  maxBytes:   number;                       setMaxBytes:   (v: number) => void;
  suspend:    boolean;                      setSuspend:    (v: boolean) => void;
  expectMode: "none" | "hex" | "array";    setExpectMode: (v: "none" | "hex" | "array") => void;
  expectHex:  string;                       setExpectHex:  (v: string) => void;
  expectArr:  string;                       setExpectArr:  (v: string) => void;
  // Actions
  startListening:  () => Promise<void>;
  stopListening:   () => Promise<void>;
  doConnect:       () => Promise<void>;
  doDisconnect:    () => Promise<void>;
  doDestroy:       () => Promise<void>;
  doStatus:        () => Promise<void>;
  doStatusReading: () => Promise<void>;
  doGetPlatform:   () => Promise<void>;
  startRead:       () => Promise<void>;
  stopRead:        () => Promise<void>;
  doWrite:         () => Promise<void>;
  doRR:            () => Promise<void>;
}

const TCPCtx = createContext<TCPState | null>(null);

export function useTCP(): TCPState {
  const v = useContext(TCPCtx);
  if (!v) throw new Error("TCPProvider missing");
  return v;
}

export const TCPProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const log = useLogger();

  const [connectionId, setConnectionId] = useState("conn-1");
  const [host, setHost]                 = useState("192.168.222.102");
  const [port, setPort]                 = useState(9100);
  const [connTimeout, setConnTimeout]   = useState(3000);
  const [noDelay, setNoDelay]           = useState(true);
  const [keepAlive, setKeepAlive]       = useState(true);
  const [connected, setConnected]       = useState(false);
  const [listenings, setListenings]     = useState(false);

  const [chunkSize, setChunkSize]         = useState(4096);
  const [readerTimeout, setReaderTimeout] = useState(1000);
  const [reading, setReading]             = useState(false);

  const [writeMode, setWriteMode] = useState<"text" | "hex" | "array">("text");
  const [txt, setTxt]       = useState("hello\n");
  const [hex, setHex]       = useState("1b 40");
  const [arrStr, setArrStr] = useState("27,64");

  const [req, setReq]               = useState("ping\n");
  const [rrTimeout, setRRTimeout]   = useState(1000);
  const [maxBytes, setMaxBytes]     = useState(4096);
  const [suspend, setSuspend]       = useState(true);
  const [expectMode, setExpectMode] = useState<"none" | "hex" | "array">("none");
  const [expectHex, setExpectHex]   = useState("0a");
  const [expectArr, setExpectArr]   = useState("10,13");

  const connRef = useRef<TCPConnection | null>(null);

  function getConn(): TCPConnection {
    const c = TCPClient.createConnection({ connectionId });
    connRef.current = c;
    return c;
  }

  const startListening = async () => {
    if (listenings) { log.warn("client", "startListening - already listening, ignoring"); return; }
    const conn = getConn();
    await conn.addListener("tcpData", (ev) => {
      log.info("listener", `tcpData <- ${ev.data.length} bytes`, ev.data.slice(0, 13));
    });
    await conn.addListener("tcpDisconnect", (ev) => {
      log.warn("listener", `tcpDisconnect: ${ev.reason} ${ev.error ?? ""}`);
      setConnected(false);
      setReading(false);
    });
    log.info("client", "startListening(tcpData, tcpDisconnect)");
    setListenings(true);
  };

  const stopListening = async () => {
    if (!listenings) { log.warn("client", "stopListening - not listening, ignoring"); return; }
    await connRef.current?.removeAllListeners();
    log.info("client", "stopListening()");
    setListenings(false);
  };

  const doConnect = async () => {
    const conn = TCPClient.createConnection({ connectionId });
    connRef.current = conn;
    const r = await conn.connect({ host, port, timeout: connTimeout, noDelay, keepAlive });
    setConnected(!r.error && !!r.connected);
    log.info("client", "connect()", r);
  };

  const doDisconnect = async () => {
    const r = await getConn().disconnect();
    setConnected(false); setReading(false);
    log.info("client", "disconnect()", r);
  };

  const doDestroy = async () => {
    await getConn().destroy();
    connRef.current = null;
    setConnected(false); setReading(false); setListenings(false);
    log.info("client", "destroy()", { connectionId });
  };

  const doStatus = async () => {
    const r = await getConn().isConnected();
    const p = await TCPClient.getPlatform();
    setConnected(!!r.connected);
    log.info("client", "isConnected()", r);
    log.info("client", "getPlatform()", p);
  };

  const doStatusReading = async () => {
    const r = await getConn().isReading();
    setReading(!!r.reading);
    log.info("client", "isReading()", r);
  };

  const doGetPlatform = async () => {
    const p = await TCPClient.getPlatform();
    log.info("client", "getPlatform()", p);
  };

  const startRead = async () => {
    await getConn().setReadTimeout({ readTimeout: readerTimeout });
    const r = await getConn().startRead({ chunkSize, readTimeout: readerTimeout });
    setReading(!r.error);
    log.info("stream", "startRead()", r);
  };

  const stopRead = async () => {
    const r = await getConn().stopRead();
    setReading(false);
    log.info("stream", "stopRead()", r);
  };

  const doWrite = async () => {
    try {
      let data: number[] = [];
      if (writeMode === "text") data = utf8ToArr(txt);
      if (writeMode === "hex") {
        const b = fromHex(hex); if (!b) throw new Error("Invalid hex"); data = b;
      }
      if (writeMode === "array") {
        const nums = arrStr.split(/[,\s]+/).filter(Boolean).map(Number);
        if (nums.some(n => Number.isNaN(n))) throw new Error("Invalid array");
        data = nums.map(n => n & 0xff);
      }
      const r = await getConn().write({ data });
      log.info("write", `write(${data.length})`, r);
    } catch (e: any) {
      log.error("write", "write() failed", e?.message ?? e);
    }
  };

  const doRR = async () => {
    try {
      const data = utf8ToArr(req);
      let expect: number[] | undefined;
      if (expectMode === "hex") {
        const b = fromHex(expectHex); if (!b) throw new Error("Invalid expect hex"); expect = b;
      } else if (expectMode === "array") {
        const nums = expectArr.split(/[,\s]+/).filter(Boolean).map(Number);
        if (nums.some(n => Number.isNaN(n))) throw new Error("Invalid expect array");
        expect = nums.map(n => n & 0xff);
      }
      const r = await getConn().writeAndRead({ data, timeout: rrTimeout, maxBytes, expect, suspendStreamDuringRR: suspend });
      log.info("rr", `RR: bytesReceived=${r.bytesReceived} matched=${r.matched} error=${r.error}`, r);
    } catch (e: any) {
      log.error("rr", "writeAndRead() failed", e?.message ?? e);
    }
  };

  return (
    <TCPCtx.Provider value={{
      connectionId, setConnectionId, host, setHost, port, setPort,
      connTimeout, setConnTimeout, noDelay, setNoDelay, keepAlive, setKeepAlive,
      connected, listenings,
      chunkSize, setChunkSize, readerTimeout, setReaderTimeout, reading,
      writeMode, setWriteMode, txt, setTxt, hex, setHex, arrStr, setArrStr,
      req, setReq, rrTimeout, setRRTimeout, maxBytes, setMaxBytes,
      suspend, setSuspend, expectMode, setExpectMode, expectHex, setExpectHex, expectArr, setExpectArr,
      startListening, stopListening, doConnect, doDisconnect, doDestroy, doStatus,
      doStatusReading, doGetPlatform, startRead, stopRead, doWrite, doRR,
    }}>
      {children}
    </TCPCtx.Provider>
  );
};
