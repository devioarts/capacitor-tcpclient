import React from "react";
import { LoggerProvider, LoggerSinkSwitch, LogViewer } from "./components/Logger.tsx";
import { TcpPlayground } from "./Playground.tsx";

export default function App() {
	return (
		<LoggerProvider>
			<div className="min-h-screen bg-white text-slate-900">
				<Header title={"Playground TCPClient"}><LoggerSinkSwitch /></Header>
				<main className=" mx-auto px-4 py-6 space-y-6">
					<div className={ "grid grid-cols-1 md:grid-cols-2 gap-6"}>
						<TcpPlayground />
						<LogViewer />
					</div>
					<Footer />
				</main>
			</div>
		</LoggerProvider>
	);
}

type HeaderProps = React.PropsWithChildren<{
	title?: string;
	caption?: string;
}>;

function Header({ title = "Playground", children }: HeaderProps) {
	return (
		<header className="border-b border-slate-200 bg-slate-50">
			<div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
				<div className="min-w-0">
					<h1 className="text-xl font-bold truncate">{title}</h1>
				</div>
				<div className="flex items-center gap-2">{children}</div>
			</div>
		</header>
	);
}

function Footer() {
	return (
		<footer className="border-t border-slate-200 pt-4 text-sm text-slate-500">
			Tip: <code>expect</code> můžeš zadat jako hex (<code>1b 40</code>) nebo pole čísel (<code>27,64</code>).
		</footer>
	);
}
