import React, {useEffect} from "react";

/** Where to send logs. */
export type LoggerSink = "panel" | "console" | "both";

export interface LogEntry {
	ts: number;
	level: "info" | "warn" | "error";
	msg: string;
	data?: unknown;
	scope?: string;
}

interface LoggerCtx {
	sink: LoggerSink;
	setSink: (s: LoggerSink) => void;
	logs: LogEntry[];
	clear: () => void;
	info: (scope:string,m: string, d?: unknown) => void;
	warn: (scope:string,m: string, d?: unknown) => void;
	error: (scope:string,m: string, d?: unknown) => void;
}

const Ctx = React.createContext<LoggerCtx | null>(null);

/** Provider + panel logic kept together for simplicity. */
export const LoggerProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
	const [sink, setSink] = React.useState<LoggerSink>("both");
	const [logs, setLogs] = React.useState<LogEntry[]>([]);

	const push = React.useCallback((level: LogEntry["level"],scope:string, msg: string, data?: unknown) => {
		const entry: LogEntry = { ts: Date.now(), level, msg, data,scope };
		if (sink === "panel" || sink === "both") {
			setLogs(prev => {
				const next = prev.length > 500 ? prev.slice(prev.length - 500) : prev;
				return [...next, entry];
			});
		}
		if (sink === "console" || sink === "both") {
			const line = `[${new Date(entry.ts).toLocaleTimeString()}][${scope}] ${level.toUpperCase()}: ${msg}`;
			if (level === "info") console.log(line, data ?? "");
			else if (level === "warn") console.warn(line, data ?? "");
			else console.error(line, data ?? "");
		}
	}, [sink]);
	useEffect(() => {
		//push("info","App","LoggerProvider started");
	}, []);


	const ctx: LoggerCtx = {
		sink, setSink, logs,
		clear: () => setLogs([]),
		info: (m, d,scope) => push("info", m, d,scope),
		warn: (m, d,scope) => push("warn", m, d,scope),
		error: (m, d,scope) => push("error", m, d,scope),
	};

	return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
};


export function useLogger(): LoggerCtx {
	const v = React.useContext(Ctx);
	if (!v) throw new Error("LoggerProvider missing");
	return v;
}

/** Inline log viewer. */
export const LogViewer: React.FC = () => {


	const { logs, clear } = useLogger();

	useEffect(() => {
		const el = document.getElementById("logger") as HTMLDivElement | null;
		if (!el) return;
		el.scrollTop = el.scrollHeight; // auto-scroll bottom on new logs
	}, [logs]);

	return (
		<div className="border border-slate-200 rounded-lg overflow-hidden">
			<div className="px-3 py-2 bg-slate-50 flex items-center justify-between">
				<span className="font-medium text-sm">Logger</span>
				<button className="text-xs px-2 py-1 rounded bg-slate-800 text-white hover:bg-slate-900" onClick={clear}>Clear</button>
			</div>
			<div id={"logger"} className="md:h-[calc(100vh-15rem)] overflow-auto text-xs p-2">
				{logs.length === 0 ? (
					<div className="text-slate-500">No logs yet…</div>
				) :
					(
						<ul className="space-y-2">
							{logs.map((l,i) => (
								<li key={i} className={
									[
										l.level === "error" ? "bg-rose-600/10" : l.level === "warn" ? "bg-amber-600/10" : "bg-emerald-700/10",
										"rounded-lg border border-slate-100 p-2"
									].join(" ")
								}>
									<div className={"flex items-center gap-2 text-[11px] text-slate-500"}>
										<span>{formatDT(l.ts)}</span>
										{l.scope && <span className="rounded bg-slate-100 px-1 py-0.5">{l.scope}</span>}
										<span
											className={
												l.level === "error"
													? "text-rose-600"
													: l.level === "warn"
														? "text-amber-600"
														: "text-emerald-700"
											}
										>
                    {l.level.toUpperCase()}
                  </span>
									</div>
									<div className="mt-1 text-sm text-slate-800">{l.msg}</div>
									{typeof l.data !== "undefined" && (
										<pre className="mt-1 overflow-auto rounded-md bg-slate-50 p-2 text-[11px] leading-snug text-slate-700">
                    {formatData(l.data)}
                  </pre>
									)}
								</li>
							))}
						</ul>
					)
				}
			</div>
		</div>
	);
};

/** Sink switcher placed in App header. */
export const LoggerSinkSwitch: React.FC = () => {
	const { sink, setSink } = useLogger();
	return (
		<label className="flex items-center gap-2 text-sm">
			<span className="text-slate-500">Logger:</span>
			<select
				className="bg-white border border-slate-300 rounded px-2 py-1"
				value={sink}
				onChange={(e) => setSink(e.target.value as LoggerSink)}
			>
				<option value="panel">Panel only</option>
				<option value="console">Console only</option>
				<option value="both">Both</option>
			</select>
		</label>
	);
};

function formatData(d: unknown): string {
	try {
		if (d instanceof Uint8Array) return `Uint8Array[${d.length}]`;
		if (Array.isArray(d)) return JSON.stringify(d, null, 2);
		if (typeof d === "object") return JSON.stringify(d, null, 2);
		return String(d);
	} catch { return String(d); }
}

function formatDT(timestamp:number) {
	const d = new Date(timestamp);
	//return `${d.toLocaleTimeString()} ${d.toLocaleDateString()}`;
	return `${d.toLocaleTimeString()}`;

}
