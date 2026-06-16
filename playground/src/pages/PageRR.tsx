import React from "react";
import { useTCP } from "../helpers/TCPContext.tsx";
import { Button } from "../components/Button.tsx";
import { Input, Label, TextArea } from "../components/Input.tsx";

export const PageRR: React.FC = () => {
  const {
    req, setReq,
    rrTimeout, setRRTimeout,
    maxBytes, setMaxBytes,
    suspend, setSuspend,
    expectMode, setExpectMode,
    expectHex, setExpectHex,
    expectArr, setExpectArr,
    connected,
    doRR,
  } = useTCP();

  return (
    <div className="space-y-3 max-w-lg">
      <div className="grid sm:grid-cols-2 gap-3">
        <Label label="timeoutMs">
          <Input type="number" value={rrTimeout} onChange={e => setRRTimeout(+e.target.value)} />
        </Label>
        <Label label="maxBytes">
          <Input type="number" value={maxBytes} onChange={e => setMaxBytes(+e.target.value)} />
        </Label>
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
          <select
            className="bg-white border border-slate-300 rounded px-2 py-1 text-sm"
            value={expectMode}
            onChange={e => setExpectMode(e.target.value as any)}
          >
            <option value="none">None</option>
            <option value="hex">Hex</option>
            <option value="array">Array</option>
          </select>
        </Label>
        {expectMode === "hex"   && <Label label="Expect (hex)"><Input     value={expectHex} onChange={e => setExpectHex(e.target.value)} /></Label>}
        {expectMode === "array" && <Label label="Expect (numbers)"><Input value={expectArr} onChange={e => setExpectArr(e.target.value)} /></Label>}
      </div>
      <hr />
      <Button type="green" onClick={doRR} disabled={!connected}>Send & Await</Button>
    </div>
  );
};
