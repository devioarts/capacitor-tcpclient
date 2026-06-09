import React, {useRef, useState} from "react";
import { TCPClient } from "@devioarts/capacitor-tcpclient";
import type { TCPConnection } from "@devioarts/capacitor-tcpclient";
import { useLogger } from "./components/Logger.tsx";
import { Button } from "./components/Button.tsx";
import { Input, Label, TextArea } from "./components/Input.tsx";
import {TabButton} from "./components/TabButton.tsx";

/** Helper: hex string → number[] (tolerant to spaces and 0x). */
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
/** UTF-8 → number[] */
function utf8ToArr(s: string): number[] { return Array.from(new TextEncoder().encode(s)); }

export const TcpPlayground: React.FC = () => {
	const log = useLogger();
	const [active, setActive] = useState<string>("server");

	// Connection
	const [connectionId, setConnectionId] = React.useState("conn-1");
	const [host, setHost] = React.useState("192.168.222.102");
	const [port, setPort] = React.useState(9100);
	const [connTimeout, setConnTimeout] = React.useState(3000);
	const [noDelay, setNoDelay] = React.useState(true);
	const [keepAlive, setKeepAlive] = React.useState(true);
	const [connected, setConnected] = React.useState(false);

	// Stream
	const [chunkSize, setChunkSize] = React.useState(4096);
	const [readerTimeout, setReaderTimeout] = React.useState(1000);
	const [reading, setReading] = React.useState(false);
	const [listenings, setListenings] = useState<boolean>(false);

	// Write
	const [writeMode, setWriteMode] = React.useState<"text" | "hex" | "array">("text");
	const [txt, setTxt] = React.useState("hello\n");
	const [hex, setHex] = React.useState("1b 40");
	const [arrStr, setArrStr] = React.useState("27,64");

	// RR
	const [req, setReq] = React.useState("ping\n");
	const [timeout, setTimeout] = React.useState(1000);
	const [maxBytes, setMaxBytes] = React.useState(4096);
	const [suspend, setSuspend] = React.useState(true);
	const [expectMode, setExpectMode] = React.useState<"none" | "hex" | "array">("none");
	const [expectHex, setExpectHex] = React.useState("0a");
	const [expectArr, setExpectArr] = React.useState("10,13");

	// Current connection instance (non-reactive — doesn't need to trigger re-render)
	const connRef = useRef<TCPConnection | null>(null);

	/** Returns the existing instance for the current connectionId, or creates a new one. */
	function getConn(): TCPConnection {
		const c = TCPClient.createConnection({ connectionId });
		connRef.current = c;
		return c;
	}


	const startListening = async () => {
		if (listenings) {
			log.warn(`client`, "startListening - already listening, ignoring");
			return;
		}
		const conn = getConn();
		// conn.addListener already filters events by connectionId internally
		await conn.addListener("tcpData", (ev) => {
			log.info(`listener`, `tcpData <- ${ev.data.length} bytes`, ev.data.slice(0, 13));
		});
		await conn.addListener("tcpDisconnect", (ev) => {
			log.warn(`listener`, `tcpDisconnect: ${ev.reason} ${ev.error ?? ""}`);
			setConnected(false);
			setReading(false);
		});
		log.info(`client`, "startListening(tcpData, tcpDisconnect)");
		setListenings(true);
	};

	const stopListening = async () => {
		if (!listenings) {
			log.warn(`client`, "stopListening - not listening, ignoring");
			return;
		}
		await connRef.current?.removeAllListeners();
		log.info(`client`, "stopListening()");
		setListenings(false);
	};


	// Actions
	const doConnect = async () => {
		// createConnection sets host/port/... as defaults for connect()
		const conn = TCPClient.createConnection({ connectionId });
		connRef.current = conn;
		const r = await conn.connect({ host, port, timeout: connTimeout, noDelay, keepAlive });
		setConnected(!r.error && !!r.connected);
		log.info(`client`, "connect()", r);
	};
	const doDisconnect = async () => {
		const r = await getConn().disconnect();
		setConnected(false); setReading(false);
		log.info(`client`, "disconnect()", r);
	};
	const doDestroy = async () => {
		await getConn().destroy();
		connRef.current = null;
		setConnected(false); setReading(false); setListenings(false);
		log.info(`client`, "destroy()", { connectionId });
	};
	const doStatus = async () => {
		const r = await getConn().isConnected();
		setConnected(!!r.connected);
		log.info(`client`, "isConnected()", r);
	};
	const doStatusReading = async () => {
		const r = await getConn().isReading();
		setReading(!!r.reading);
		log.info(`client`, "isReading()", r);
	};
	const startRead = async () => {
		await getConn().setReadTimeout({ readTimeout: readerTimeout });
		const r = await getConn().startRead({ chunkSize, readTimeout: readerTimeout });
		setReading(!r.error);
		log.info(`stream`, "startRead()", r);
	};
	const stopRead = async () => {
		const r = await getConn().stopRead();
		setReading(false);
		log.info(`stream`, "stopRead()", r);
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
			log.info(`write`, `write(${data.length})`, r);
		} catch (e: any) {
			log.error(`write`, "write() failed", e?.message ?? e);
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
			const r = await getConn().writeAndRead({ data, timeout, maxBytes, expect, suspendStreamDuringRR: suspend });
			log.info(`rr`, `RR: bytesReceived=${r.bytesReceived} matched=${r.matched} error=${r.error}`, r);
		} catch (e: any) {
			log.error(`rr`, "writeAndRead() failed", e?.message ?? e);
		}
	};

	return (
		<div className="space-y-6">
			{/* Tabs */}
			<div className="mb-3 flex items-center gap-2 border-b border-slate-200">
				<TabButton tabId={"server"} active={active} onClick={ () => setActive("server")}>Connection</TabButton>
				<TabButton tabId={"stream"} active={active} onClick={ () => setActive("stream")}>Stream</TabButton>
				<TabButton tabId={"write"} active={active} onClick={ () => setActive("write")}>Write</TabButton>
				<TabButton tabId={"rr"} active={active} onClick={ () => setActive("rr")}>R/R</TabButton>
			</div>

			{/* Connection */}
			{active === "server" && (
				<section className="border border-slate-200 rounded-lg p-4 space-y-3">
					<h3 className="font-semibold">Connection
						<span className="ml-2 text-sm">
            <b className={connected ? "text-emerald-700" : "text-rose-700"}>●</b> {connected ? "Connected" : "Disconnected"}
          </span>
					</h3>
					<div className="grid sm:grid-cols-1 gap-3">
						<Label label="Connection ID"><Input value={connectionId} onChange={e => setConnectionId(e.target.value)} /></Label>
					</div>
					<div className="grid sm:grid-cols-3 gap-3">
						<Label label="Host"><Input value={host} onChange={e => setHost(e.target.value)} /></Label>
						<Label label="Port"><Input type="number" value={port} onChange={e => setPort(+e.target.value)} /></Label>
						<Label label="Timeout (ms)"><Input type="number" value={connTimeout} onChange={e => setConnTimeout(+e.target.value)} /></Label>
					</div>
					<div className="flex items-end gap-4">
						<label className="text-sm flex items-center gap-2"><input type="checkbox" checked={noDelay} onChange={e => setNoDelay(e.target.checked)} /> TCP_NODELAY</label>
						<label className="text-sm flex items-center gap-2"><input type="checkbox" checked={keepAlive} onChange={e => setKeepAlive(e.target.checked)} /> SO_KEEPALIVE</label>
					</div>
					<hr />
					<div className="flex flex-wrap gap-2">
						<Button type={"green"} onClick={startListening} disabled={listenings}>Start listen</Button>
						<Button type={"red"} onClick={stopListening} disabled={!listenings}>Stop listen</Button>
						<Button type={"green"} onClick={doConnect} disabled={connected}>Connect</Button>
						<Button type={"red"} onClick={doDisconnect} disabled={!connected}>Disconnect</Button>
						<Button type={"red"} onClick={doDestroy} disabled={!connected}>Destroy</Button>
						<Button type={"neutral"} onClick={doStatus}>Status</Button>
					</div>
				</section>
			)}

			{/* Stream */}
			{active === "stream" && (
				<section className="border border-slate-200 rounded-lg p-4 space-y-3">
					<h3 className="font-semibold">Stream
						<span className="ml-2 text-sm">
            <b className={reading ? "text-emerald-700" : "text-rose-700"}>●</b> {reading ? "Streaming" : "Idle"}
          </span>
					</h3>
					<div className="grid sm:grid-cols-2 gap-3">
						<Label label="chunkSize"><Input type="number" value={chunkSize} onChange={e => setChunkSize(+e.target.value)} /></Label>
						<Label label="reader timeout (ms)"><Input type="number" value={readerTimeout} onChange={e => setReaderTimeout(+e.target.value)} /></Label>
					</div>
					<hr />
					<div className="flex gap-2">
						<Button type={"green"} onClick={startRead} disabled={!connected || reading}>Start read</Button>
						<Button type={"red"} onClick={stopRead} disabled={!reading}>Stop read</Button>
						<Button type={"neutral"} onClick={doStatusReading}>Status</Button>
					</div>
				</section>
			)}

			{/* Write */}
			{active === "write" && (
				<section className="border border-slate-200 rounded-lg p-4 space-y-3">
					<h3 className="font-semibold">Write</h3>
					<div className="grid sm:grid-cols-3 gap-3">
						<Label label="Mode">
							<select className="bg-white border border-slate-300 rounded px-2 py-1 text-sm"
							        value={writeMode} onChange={e => setWriteMode(e.target.value as any)}>
								<option value="text">Text (UTF-8)</option>
								<option value="hex">Hex</option>
								<option value="array">Array (numbers)</option>
							</select>
						</Label>
					</div>
					<div className="grid sm:grid-cols-1 gap-3">
						{writeMode === "text" && <Label label="Text"><TextArea rows={3} value={txt} onChange={e => setTxt(e.target.value)} /></Label>}
						{writeMode === "hex" && <Label label="Hex"><TextArea rows={3} value={hex} onChange={e => setHex(e.target.value)} /></Label>}
						{writeMode === "array" && <Label label="Array"><TextArea rows={3} value={arrStr} onChange={e => setArrStr(e.target.value)} /></Label>}
					</div>
					<hr/>
					<Button type={"green"} onClick={doWrite} disabled={!connected}>Send</Button>
				</section>
			)}

			{/* Request/Response */}
			{active === "rr"&& (
				<section className="border border-slate-200 rounded-lg p-4 space-y-3">
					<h3 className="font-semibold">Request / Response</h3>
					<div className="grid sm:grid-cols-2 lg:grid-cols-2 gap-3">
						<Label label="timeoutMs"><Input type="number" value={timeout} onChange={e => setTimeout(+e.target.value)} /></Label>
						<Label label="maxBytes"><Input type="number" value={maxBytes} onChange={e => setMaxBytes(+e.target.value)} /></Label>
						<label className="text-sm flex items-center gap-2">
							<input type="checkbox" checked={suspend} onChange={e => setSuspend(e.target.checked)} />
							Suspend stream during RR
						</label>
					</div>
					<Label label="Request (UTF-8)">
						<TextArea rows={3} value={req} onChange={e => setReq(e.target.value)} />
					</Label>
					<div className="grid sm:grid-cols-3 gap-3">
						<Label label="Expect mode">
							<select className="bg-white border border-slate-300 rounded px-2 py-1 text-sm"
							        value={expectMode} onChange={e => setExpectMode(e.target.value as any)}>
								<option value="none">None</option>
								<option value="hex">Hex</option>
								<option value="array">Array</option>
							</select>
						</Label>
						{expectMode === "hex" && <Label label="Expect (hex)"><Input value={expectHex} onChange={e => setExpectHex(e.target.value)} /></Label>}
						{expectMode === "array" && <Label label="Expect (numbers)"><Input value={expectArr} onChange={e => setExpectArr(e.target.value)} /></Label>}
					</div>
					<hr/>
					<Button type={"green"} onClick={doRR} disabled={!connected}>Send & Await</Button>
				</section>
			)}
		</div>
	);
};
