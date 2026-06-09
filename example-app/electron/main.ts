import { app, BrowserWindow } from 'electron';
import * as path from 'path';
// uncomment to use local files
// import * as url from 'url';

import express from 'express';
import type { AddressInfo } from 'net';
// THIS IS IMPORTANT FOR PLUGING!
import {TCPClient} from "@devioarts/capacitor-tcpclient/electron/tcpclient";


const isDev = !app.isPackaged;
// THIS IS IMPORTANT FOR PLUGIN!
let tcpClient: TCPClient | null = null;

/*
 * Function to start a local HTTP server using express
 */
async function startLocalHttp(distDir: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const web = express();
		web.use(express.static(distDir));
		const server = web.listen(0, '127.0.0.1', () => {
			const addr = server.address() as AddressInfo;
			resolve(addr.port);
		});
		server.on('error', reject);
	});
}


function createWindow() {
	const win = new BrowserWindow({
		fullscreen: false,
		frame: true,
		autoHideMenuBar: false,
		webPreferences: {
			contextIsolation: true,
			preload: path.join(__dirname, 'preload.cjs'),
			sandbox: false,
		},
	});
	// THIS IS IMPORTANT FOR PLUGIN!
	tcpClient = new TCPClient(win);

	if (isDev) {
		win.loadURL('http://localhost:6001');
	} else {
		/*
		 * Only one of the two sections below can be uncommented at a time
		 * Uncomment the section you want to use and comment the other
		 */

		// SECTION 1
		/*
		 * Start a local HTTP server to serve the production build
		 * COMMENT THIS TO USE LOCAL FILES
		 */
		const DIST_DIR = path.join(__dirname, '../dist');
		startLocalHttp(DIST_DIR).then((port) => {
			win.loadURL(`http://localhost:${port}/index.html`);
		});
		// SECTION 2
		/*
		 * Work with local files
		 */
		/* UNCOMMENT THIS TO USE LOCAL FILES
		win.loadURL(
			url.format({
				pathname: path.join(__dirname, '../dist/index.html'),
				protocol: 'file:',
				slashes: true,
			})
		);
		*/
	}
	// Open the DevTools.
	win.webContents.openDevTools();

}

app.whenReady().then(() => {
	createWindow();
});

app.on('before-quit', async () => {
	// events to be handled before quitting the app
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
