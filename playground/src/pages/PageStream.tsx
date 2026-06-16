import React from "react";
import { useTCP } from "../helpers/TCPContext.tsx";
import { Button } from "../components/Button.tsx";
import { Input, Label } from "../components/Input.tsx";

export const PageStream: React.FC = () => {
  const {
    chunkSize, setChunkSize,
    readerTimeout, setReaderTimeout,
    connected, reading,
    startRead, stopRead, doStatusReading,
  } = useTCP();

  return (
    <div className="space-y-3 max-w-lg">
      <div className="flex items-center gap-2">
        <b className={reading ? "text-emerald-700" : "text-rose-700"}>●</b>
        <span className="text-sm">{reading ? "Streaming" : "Idle"}</span>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <Label label="chunkSize">
          <Input type="number" value={chunkSize} onChange={e => setChunkSize(+e.target.value)} />
        </Label>
        <Label label="reader timeout (ms)">
          <Input type="number" value={readerTimeout} onChange={e => setReaderTimeout(+e.target.value)} />
        </Label>
      </div>
      <hr />
      <div className="flex gap-2">
        <Button type="green"   onClick={startRead}       disabled={!connected || reading}>Start read</Button>
        <Button type="red"     onClick={stopRead}        disabled={!reading}>Stop read</Button>
        <Button type="neutral" onClick={doStatusReading}>Status</Button>
      </div>
    </div>
  );
};
