import React, { useState, useCallback } from 'react';
import { TCPClient } from '@devioarts/capacitor-tcpclient';
import type { TCPConnection } from '@devioarts/capacitor-tcpclient';
import { Button } from '../components/Button.tsx';
import { Input } from '../components/Input.tsx';

// ── Types ─────────────────────────────────────────────────────────────────────

type RunStatus = 'idle' | 'running' | 'pass' | 'fail' | 'skip';

interface ScenarioDef {
  id: string;
  name: string;
  desc: string;
  critical?: boolean;   // abort suite on failure (skip remaining non-alwaysRun tests)
  alwaysRun?: boolean;  // runs even when suite is aborted (e.g. disconnect cleanup)
  run: () => Promise<{ ok: boolean; detail?: string }>;
}

type StatesMap = Record<string, { status: RunStatus; detail?: string }>;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const pass  = (detail?: string): { ok: true;  detail?: string } => ({ ok: true,  detail });
const fail  = (detail:  string): { ok: false; detail:  string } => ({ ok: false, detail });

// ── Metadata (static — used for rendering only) ───────────────────────────────

const ESCPOS_META = [
  { id: 'ep-connect',     name: 'Connect',              desc: 'Navázat TCP spojení na tiskárnu'              },
  { id: 'ep-init',        name: 'ESC @ (init)',         desc: '1B 40 — inicializovat / resetovat tiskárnu'   },
  { id: 'ep-status1',     name: 'DLE EOT — tiskárna',  desc: '10 04 01 → 1 B (bit3=0 ⇒ online)'            },
  { id: 'ep-status4',     name: 'DLE EOT — papír',     desc: '10 04 04 → 1 B (bit2:3=0 ⇒ papír OK)'        },
  { id: 'ep-print',       name: 'Print text',           desc: 'Tisk testovacího textu + CR LF'               },
  { id: 'ep-feed',        name: 'Feed 3 lines',         desc: '1B 64 03 — posun papíru o 3 řádky'           },
  { id: 'ep-cut',         name: 'Cut (partial)',        desc: '1D 56 42 00 — odříznutí papíru'               },
  { id: 'ep-disconnect',  name: 'Disconnect',           desc: 'Uzavřít TCP spojení'                          },
] as const;

const TCP_META = [
  { id: 'tcp-connect',    name: 'Connect',              desc: 'Navázat TCP spojení'                          },
  { id: 'tcp-echo',       name: 'Echo R/R',             desc: '"HELLO\\n" → expect odpověď s "ECHO:"'        },
  { id: 'tcp-status',     name: 'Status R/R',           desc: '"STATUS\\n" → expect odpověď s "OK"'          },
  { id: 'tcp-stream',     name: 'Stream push (≤5 s)',   desc: 'startRead + listener, čekat na push data'     },
  { id: 'tcp-rr-suspend', name: 'R/R + suspend stream', desc: 'writeAndRead při aktivním streamu'            },
  { id: 'tcp-timeout',    name: 'R/R timeout',          desc: '"NOREPLY\\n" timeout=500 ms → expect error'   },
  { id: 'tcp-multi-rr',   name: 'Multi R/R (3×)',       desc: '3× writeAndRead za sebou — žádný "busy"'     },
  { id: 'tcp-disconnect', name: 'Disconnect',           desc: 'Uzavřít TCP spojení'                          },
] as const;

// ── Scenario factories ────────────────────────────────────────────────────────

function buildEscposScenarios(conn: TCPConnection, host: string, port: number): ScenarioDef[] {
  return [
    {
      id: 'ep-connect',
      name: 'Connect',
      desc: ESCPOS_META[0].desc,
      critical: true,
      run: async () => {
        const r = await conn.connect({ host, port });
        return r.connected ? pass() : fail(r.errorMessage ?? 'connect failed');
      },
    },
    {
      id: 'ep-init',
      name: 'ESC @ (init)',
      desc: ESCPOS_META[1].desc,
      run: async () => {
        const r = await conn.write({ data: [0x1b, 0x40] });
        return r.error ? fail(r.errorMessage ?? 'write failed') : pass(`${r.bytesSent} B odesláno`);
      },
    },
    {
      id: 'ep-status1',
      name: 'DLE EOT — tiskárna',
      desc: ESCPOS_META[2].desc,
      run: async () => {
        const r = await conn.writeAndRead({ data: [0x10, 0x04, 0x01], timeout: 1000, maxBytes: 4 });
        if (r.error) return fail(r.errorMessage ?? 'writeAndRead failed');
        if (r.bytesReceived < 1) return fail('žádná odpověď (0 B)');
        const s = r.data[0];
        return pass(`0x${s.toString(16).toUpperCase().padStart(2, '0')} — online=${(s & 0x08) === 0}`);
      },
    },
    {
      id: 'ep-status4',
      name: 'DLE EOT — papír',
      desc: ESCPOS_META[3].desc,
      run: async () => {
        const r = await conn.writeAndRead({ data: [0x10, 0x04, 0x04], timeout: 1000, maxBytes: 4 });
        if (r.error) return fail(r.errorMessage ?? 'writeAndRead failed');
        if (r.bytesReceived < 1) return fail('žádná odpověď (0 B)');
        const s = r.data[0];
        return pass(`0x${s.toString(16).toUpperCase().padStart(2, '0')} — near-end=${(s & 0x0c) !== 0}`);
      },
    },
    {
      id: 'ep-print',
      name: 'Print text',
      desc: ESCPOS_META[4].desc,
      run: async () => {
        const bytes = Array.from(new TextEncoder().encode('--- TCP PLUGIN TEST ---\r\n'));
        const r = await conn.write({ data: bytes });
        return r.error ? fail(r.errorMessage ?? 'write failed') : pass(`${r.bytesSent} B`);
      },
    },
    {
      id: 'ep-feed',
      name: 'Feed 3 lines',
      desc: ESCPOS_META[5].desc,
      run: async () => {
        const r = await conn.write({ data: [0x1b, 0x64, 0x03] });
        return r.error ? fail(r.errorMessage ?? 'write failed') : pass(`${r.bytesSent} B`);
      },
    },
    {
      id: 'ep-cut',
      name: 'Cut (partial)',
      desc: ESCPOS_META[6].desc,
      run: async () => {
        const r = await conn.write({ data: [0x1d, 0x56, 0x42, 0x00] });
        return r.error ? fail(r.errorMessage ?? 'write failed') : pass(`${r.bytesSent} B`);
      },
    },
    {
      id: 'ep-disconnect',
      name: 'Disconnect',
      desc: ESCPOS_META[7].desc,
      alwaysRun: true,
      run: async () => {
        const r = await conn.disconnect();
        return r.error ? fail(r.errorMessage ?? 'disconnect failed') : pass();
      },
    },
  ];
}

function buildTcpScenarios(conn: TCPConnection, host: string, port: number): ScenarioDef[] {
  return [
    {
      id: 'tcp-connect',
      name: 'Connect',
      desc: TCP_META[0].desc,
      critical: true,
      run: async () => {
        const r = await conn.connect({ host, port });
        return r.connected ? pass() : fail(r.errorMessage ?? 'connect failed');
      },
    },
    {
      id: 'tcp-echo',
      name: 'Echo R/R',
      desc: TCP_META[1].desc,
      run: async () => {
        const data = Array.from(new TextEncoder().encode('HELLO\n'));
        const r = await conn.writeAndRead({ data, timeout: 2000, maxBytes: 256 });
        if (r.error) return fail(r.errorMessage ?? 'writeAndRead failed');
        const resp = new TextDecoder().decode(new Uint8Array(r.data));
        if (!resp.includes('ECHO:')) return fail(`nečekaná odpověď: ${JSON.stringify(resp.trim())}`);
        return pass(JSON.stringify(resp.trim()));
      },
    },
    {
      id: 'tcp-status',
      name: 'Status R/R',
      desc: TCP_META[2].desc,
      run: async () => {
        const data = Array.from(new TextEncoder().encode('STATUS\n'));
        const r = await conn.writeAndRead({ data, timeout: 2000, maxBytes: 256 });
        if (r.error) return fail(r.errorMessage ?? 'writeAndRead failed');
        const resp = new TextDecoder().decode(new Uint8Array(r.data));
        if (!resp.includes('OK')) return fail(`nečekaná odpověď: ${JSON.stringify(resp.trim())}`);
        return pass(JSON.stringify(resp.trim()));
      },
    },
    {
      id: 'tcp-stream',
      name: 'Stream push (≤5 s)',
      desc: TCP_META[3].desc,
      run: async () => {
        let gotBytes = 0;
        const h = await conn.addListener('tcpData', ev => { gotBytes += ev.data.length; });
        await conn.startRead();
        await sleep(5000);
        await conn.stopRead();
        await h.remove();
        return gotBytes > 0
          ? pass(`${gotBytes} B přijato přes stream`)
          : fail('timeout — žádná push data za 5 s');
      },
    },
    {
      id: 'tcp-rr-suspend',
      name: 'R/R + suspend stream',
      desc: TCP_META[4].desc,
      run: async () => {
        const h = await conn.addListener('tcpData', () => {});
        await conn.startRead();
        await sleep(200); // let pending push data arrive via stream first

        const data = Array.from(new TextEncoder().encode('HELLO\n'));
        const r = await conn.writeAndRead({ data, timeout: 2000, maxBytes: 256, suspendStreamDuringRR: true });

        await conn.stopRead();
        await h.remove();
        if (r.error) return fail(r.errorMessage ?? 'writeAndRead failed');
        return pass(`bytesReceived=${r.bytesReceived}`);
      },
    },
    {
      id: 'tcp-timeout',
      name: 'R/R timeout',
      desc: TCP_META[5].desc,
      run: async () => {
        const data = Array.from(new TextEncoder().encode('NOREPLY\n'));
        const r = await conn.writeAndRead({ data, timeout: 500, maxBytes: 64 });
        if (!r.error) return fail(`chyba očekávána, ale přijato ${r.bytesReceived} B`);
        return pass(`"${r.errorMessage}"`);
      },
    },
    {
      id: 'tcp-multi-rr',
      name: 'Multi R/R (3×)',
      desc: TCP_META[6].desc,
      run: async () => {
        const byteCounts: number[] = [];
        for (let i = 0; i < 3; i++) {
          const data = Array.from(new TextEncoder().encode(`PING${i}\n`));
          const r = await conn.writeAndRead({ data, timeout: 2000, maxBytes: 256 });
          if (r.error) return fail(`iterace ${i}: ${r.errorMessage}`);
          byteCounts.push(r.bytesReceived);
        }
        return pass(`bytes=[${byteCounts.join(', ')}]`);
      },
    },
    {
      id: 'tcp-disconnect',
      name: 'Disconnect',
      desc: TCP_META[7].desc,
      alwaysRun: true,
      run: async () => {
        const r = await conn.disconnect();
        return r.error ? fail(r.errorMessage ?? 'disconnect failed') : pass();
      },
    },
  ];
}

// ── Suite runner ──────────────────────────────────────────────────────────────

async function runSuite(
  scenarios: ScenarioDef[],
  onState: (id: string, s: { status: RunStatus; detail?: string }) => void,
): Promise<void> {
  let aborted = false;

  for (const sc of scenarios) {
    if (aborted && !sc.alwaysRun) {
      onState(sc.id, { status: 'skip' });
      continue;
    }
    onState(sc.id, { status: 'running' });
    try {
      const result = await sc.run();
      onState(sc.id, { status: result.ok ? 'pass' : 'fail', detail: result.detail });
      if (!result.ok && sc.critical) aborted = true;
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      onState(sc.id, { status: 'fail', detail: msg });
      if (sc.critical) aborted = true;
    }
  }
}

// ── Status badge ──────────────────────────────────────────────────────────────

const BADGE_CFG: Record<RunStatus, { cls: string; label: string }> = {
  idle:    { cls: 'bg-slate-100 text-slate-400',     label: '—' },
  running: { cls: 'bg-amber-100  text-amber-700',    label: '…' },
  pass:    { cls: 'bg-emerald-100 text-emerald-700', label: '✓' },
  fail:    { cls: 'bg-rose-100   text-rose-700',     label: '✗' },
  skip:    { cls: 'bg-slate-100 text-slate-400',     label: '↩' },
};

const StatusBadge: React.FC<{ status: RunStatus }> = ({ status }) => {
  const { cls, label } = BADGE_CFG[status];
  return (
    <span className={`inline-flex items-center justify-center w-6 h-6 rounded text-xs font-bold flex-shrink-0 ${cls}`}>
      {label}
    </span>
  );
};

// ── Scenario row ──────────────────────────────────────────────────────────────

const ScenarioRow: React.FC<{
  meta: { id: string; name: string; desc: string };
  state: { status: RunStatus; detail?: string };
}> = ({ meta, state }) => (
  <div className="flex gap-3 items-start py-2 border-b border-slate-100 last:border-0">
    <StatusBadge status={state.status} />
    <div className="flex-1 min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium text-slate-800">{meta.name}</span>
        <span className="text-xs text-slate-400">{meta.desc}</span>
      </div>
      {state.detail && (
        <div className={`text-xs mt-0.5 font-mono break-all ${state.status === 'fail' ? 'text-rose-600' : 'text-slate-500'}`}>
          {state.detail}
        </div>
      )}
    </div>
  </div>
);

// ── Suite card ────────────────────────────────────────────────────────────────

const SuiteCard: React.FC<{
  title: string;
  metas: ReadonlyArray<{ id: string; name: string; desc: string }>;
  states: StatesMap;
  disabled: boolean;
  onRun: () => void;
}> = ({ title, metas, states, disabled, onRun }) => {
  const passed = metas.filter(m => states[m.id]?.status === 'pass').length;
  const failed = metas.filter(m => states[m.id]?.status === 'fail').length;
  const ran = passed + failed;

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="bg-slate-50 px-4 py-3 flex items-center justify-between gap-4 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-slate-800">{title}</span>
          {ran > 0 && (
            <span className="text-xs text-slate-500">
              {passed}/{metas.length} PASS{failed > 0 ? ` · ${failed} FAIL` : ''}
            </span>
          )}
        </div>
        <Button type="primary" onClick={onRun} disabled={disabled}>
          Run suite
        </Button>
      </div>
      <div className="px-4 divide-y divide-slate-50">
        {metas.map(m => (
          <ScenarioRow key={m.id} meta={m} state={states[m.id] ?? { status: 'idle' }} />
        ))}
      </div>
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────────────────────

export const PageTests: React.FC = () => {
  const [escposHost, setEscposHost] = useState('192.168.222.237');
  const [escposPort, setEscposPort] = useState(9100);
  const [tcpHost,    setTcpHost]    = useState('192.168.222.102');
  const [tcpPort,    setTcpPort]    = useState(9200);

  const [states,    setStates]    = useState<StatesMap>({});
  const [isRunning, setIsRunning] = useState(false);

  const setState = useCallback((id: string, s: { status: RunStatus; detail?: string }) => {
    setStates(prev => ({ ...prev, [id]: s }));
  }, []);

  const resetIds = (ids: readonly string[]) => {
    setStates(prev => {
      const next = { ...prev };
      ids.forEach(id => { next[id] = { status: 'idle' }; });
      return next;
    });
  };

  const runEscpos = async () => {
    resetIds(ESCPOS_META.map(m => m.id));
    setIsRunning(true);
    const conn = TCPClient.createConnection({ connectionId: 'test-escpos' });
    await runSuite(buildEscposScenarios(conn, escposHost, escposPort), setState);
    setIsRunning(false);
  };

  const runTcp = async () => {
    resetIds(TCP_META.map(m => m.id));
    setIsRunning(true);
    const conn = TCPClient.createConnection({ connectionId: 'test-tcp' });
    await runSuite(buildTcpScenarios(conn, tcpHost, tcpPort), setState);
    setIsRunning(false);
  };

  const runAll = async () => {
    resetIds([...ESCPOS_META.map(m => m.id), ...TCP_META.map(m => m.id)]);
    setIsRunning(true);
    const epConn  = TCPClient.createConnection({ connectionId: 'test-escpos' });
    const tcpConn = TCPClient.createConnection({ connectionId: 'test-tcp' });
    await runSuite(buildEscposScenarios(epConn,  escposHost, escposPort), setState);
    await runSuite(buildTcpScenarios(tcpConn, tcpHost, tcpPort), setState);
    setIsRunning(false);
  };

  const allPassed = [...ESCPOS_META, ...TCP_META].every(m => states[m.id]?.status === 'pass');
  const anyFailed = [...ESCPOS_META, ...TCP_META].some(m => states[m.id]?.status === 'fail');

  return (
    <div className="space-y-6 max-w-2xl">

      {/* Config ─────────────────────────────────────────────────────────────── */}
      <div className="border border-slate-200 rounded-xl p-4 space-y-4">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">Konfigurace</h2>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-600">ESC/POS tiskárna</p>
            <div className="flex gap-2">
              <div className="flex-1">
                <Input value={escposHost} onChange={e => setEscposHost(e.target.value)} placeholder="IP adresa" />
              </div>
              <div className="w-20">
                <Input type="number" value={escposPort} onChange={e => setEscposPort(+e.target.value)} />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-600">Generic TCP server</p>
            <div className="flex gap-2">
              <div className="flex-1">
                <Input value={tcpHost} onChange={e => setTcpHost(e.target.value)} placeholder="IP adresa" />
              </div>
              <div className="w-20">
                <Input type="number" value={tcpPort} onChange={e => setTcpPort(+e.target.value)} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button type="green" onClick={runAll} disabled={isRunning}>
            {isRunning ? 'Probíhá…' : 'Run all'}
          </Button>
          {allPassed && !isRunning && (
            <span className="text-sm text-emerald-600 font-medium">Všechny testy prošly ✓</span>
          )}
          {anyFailed && !isRunning && (
            <span className="text-sm text-rose-600 font-medium">Některé testy selhaly</span>
          )}
        </div>
      </div>

      {/* ESC/POS suite ───────────────────────────────────────────────────────── */}
      <SuiteCard
        title="ESC/POS tiskárna"
        metas={ESCPOS_META}
        states={states}
        disabled={isRunning}
        onRun={runEscpos}
      />

      {/* Generic TCP suite ───────────────────────────────────────────────────── */}
      <SuiteCard
        title="Generic TCP server"
        metas={TCP_META}
        states={states}
        disabled={isRunning}
        onRun={runTcp}
      />

      {/* Tip ─────────────────────────────────────────────────────────────────── */}
      <div className="text-xs text-slate-400 bg-slate-50 rounded-lg px-4 py-3 leading-relaxed">
        Generic TCP scénáře předpokládají, že server odpovídá na text zakončený <code className="bg-white border border-slate-200 rounded px-1 py-0.5">\n</code>
        {' '}a periodicky pushuje data (k testování streamu). Scénář <strong>R/R timeout</strong> odešle
        text <code className="bg-white border border-slate-200 rounded px-1 py-0.5">NOREPLY\n</code> — pokud server
        vrátí odpověď, test selže (timeout se neprojeví). Přizpůsob příkazy svému serveru pokud se liší.
      </div>

    </div>
  );
};
