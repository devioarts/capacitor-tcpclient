import React from "react";
import { useTCP } from "../helpers/TCPContext.tsx";
import { Button } from "../components/Button.tsx";
import { Label, TextArea } from "../components/Input.tsx";

export const PageWrite: React.FC = () => {
  const {
    writeMode, setWriteMode,
    txt, setTxt,
    hex, setHex,
    arrStr, setArrStr,
    connected,
    doWrite,
  } = useTCP();

  return (
    <div className="space-y-3 max-w-lg">
      <div className="grid sm:grid-cols-3 gap-3">
        <Label label="Mode">
          <select
            className="bg-white border border-slate-300 rounded px-2 py-1 text-sm"
            value={writeMode}
            onChange={e => setWriteMode(e.target.value as any)}
          >
            <option value="text">Text (UTF-8)</option>
            <option value="hex">Hex</option>
            <option value="array">Array (numbers)</option>
          </select>
        </Label>
      </div>
      <div className="grid sm:grid-cols-1 gap-3">
        {writeMode === "text"  && <Label label="Text"><TextArea  rows={3} value={txt}    onChange={e => setTxt(e.target.value)} /></Label>}
        {writeMode === "hex"   && <Label label="Hex"><TextArea   rows={3} value={hex}    onChange={e => setHex(e.target.value)} /></Label>}
        {writeMode === "array" && <Label label="Array"><TextArea rows={3} value={arrStr} onChange={e => setArrStr(e.target.value)} /></Label>}
      </div>
      <hr />
      <Button type="green" onClick={doWrite} disabled={!connected}>Send</Button>
    </div>
  );
};
