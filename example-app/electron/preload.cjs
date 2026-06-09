const { contextBridge, ipcRenderer } = require("electron");
// THIS IS IMPORTANT FOR PLUGIN!
const {createTCPClientAPI} = require("@devioarts/capacitor-tcpclient/electron/tcpclient-bridge.cjs");

window.addEventListener('DOMContentLoaded', () => {
    console.log('Electron preload loaded');
});

// THIS IS IMPORTANT FOR PLUGIN!
contextBridge.exposeInMainWorld('TCPClient', createTCPClientAPI({ ipcRenderer }));





