import React from "react";
import { useTCP } from "../helpers/TCPContext.tsx";
import { Button } from "../components/Button.tsx";
import { Input, Label } from "../components/Input.tsx";

export const PageConnection: React.FC = () => {
  const {
    connectionId, setConnectionId,
    host, setHost,
    port, setPort,
    connTimeout, setConnTimeout,
    noDelay, setNoDelay,
    keepAlive, setKeepAlive,
    connected, listenings,
    startListening, stopListening,
    doConnect, doDisconnect, doDestroy, doStatus, doStatusReading, doGetPlatform,
  } = useTCP();

  return (
    <div className="space-y-3 max-w-lg">
      <div className="flex items-center gap-2">
        <b className={connected ? "text-emerald-700" : "text-rose-700"}>●</b>
        <span className="text-sm">{connected ? "Connected" : "Disconnected"}</span>
      </div>

      <div className="grid sm:grid-cols-1 gap-3">
        <Label label="Connection ID">
          <Input value={connectionId} onChange={e => setConnectionId(e.target.value)} />
        </Label>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <Label label="Host">
          <Input value={host} onChange={e => setHost(e.target.value)} />
        </Label>
        <Label label="Port">
          <Input type="number" value={port} onChange={e => setPort(+e.target.value)} />
        </Label>
        <Label label="Timeout (ms)">
          <Input type="number" value={connTimeout} onChange={e => setConnTimeout(+e.target.value)} />
        </Label>
      </div>
      <div className="flex items-center gap-4">
        <label className="text-sm flex items-center gap-2">
          <input type="checkbox" checked={noDelay} onChange={e => setNoDelay(e.target.checked)} /> TCP_NODELAY
        </label>
        <label className="text-sm flex items-center gap-2">
          <input type="checkbox" checked={keepAlive} onChange={e => setKeepAlive(e.target.checked)} /> SO_KEEPALIVE
        </label>
      </div>
      <hr />
      <div className="flex flex-wrap gap-2">
        <Button type="green"   onClick={startListening} disabled={listenings}>Start listen</Button>
        <Button type="red"     onClick={stopListening}  disabled={!listenings}>Stop listen</Button>
        <Button type="green"   onClick={doConnect}      disabled={connected}>Connect</Button>
        <Button type="red"     onClick={doDisconnect}   disabled={!connected}>Disconnect</Button>
        <Button type="red"     onClick={doDestroy}      disabled={!connected}>Destroy</Button>
        <Button type="neutral" onClick={doStatus}>Status</Button>
        <Button type="neutral" onClick={doStatusReading}>isReading</Button>
        <Button type="neutral" onClick={doGetPlatform}>getPlatform</Button>
      </div>
    </div>
  );
};
