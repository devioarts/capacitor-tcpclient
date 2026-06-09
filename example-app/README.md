# Sample project for [capacitor-tcpclient](https://github.com/devioarts/capacitor-tcpclient)

Playground app demonstrating the **multi-instance** API — each connection is identified by a `connectionId` string, so multiple independent TCP connections can coexist in a single app.

## Installation from GitHub

### Download and extract the repo folder (Linux/Mac)
> To folder `example-app`
```shell
curl -L https://codeload.github.com/devioarts/capacitor-tcpclient/tar.gz/refs/heads/main \
| tar -xz --strip-components=1 capacitor-tcpclient-main/example-app
cd example-app
```
> To current folder
```shell
curl -L https://codeload.github.com/devioarts/capacitor-tcpclient/tar.gz/refs/heads/main \
| tar -xz --strip-components=2 capacitor-tcpclient-main/example-app
```

### Install dependencies and build
```shell
mkdir dist
npm install
npm run dev:build
```

### Add platforms
```shell
# Android
npx cap add android

# iOS (CocoaPods)
npx cap add ios
# iOS (SPM)
npx cap add ios --packagemanager SPM
```

---

## Android

Add to `/android/app/src/main/AndroidManifest.xml`:
```xml
<application
    android:usesCleartextTraffic="true"
></application>

<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<!-- Android 12+ -->
<uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

```shell
npm run cap:open-android
```

---

## iOS

Add to `/ios/App/App/Info.plist`:
```xml
<key>NSLocalNetworkUsageDescription</key>
<string>It is needed for the correct functioning of the application</string>
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

```shell
npm run cap:open-ios
```

---

## Electron

The main process uses `TCPClientManager` from the plugin:
```ts
import { TCPClientManager } from "@devioarts/capacitor-tcpclient/electron/tcpclient";

const tcpClient = new TCPClientManager(win);
```

The preload exposes the bridge via `contextBridge`:
```js
const { createTCPClientAPI } = require("@devioarts/capacitor-tcpclient/electron/tcpclient-bridge.cjs");
contextBridge.exposeInMainWorld('TCPClient', createTCPClientAPI({ ipcRenderer }));
```

```shell
npm run electron:dev
```

---

## Plugin API — quick reference

All methods require a `connectionId` to identify the connection:

```ts
// Connect
await TCPClient.connect({ connectionId: "conn-1", host: "192.168.1.1", port: 9100 });

// Write
await TCPClient.write({ connectionId: "conn-1", data: [0x1b, 0x40] });

// Stream
await TCPClient.startRead({ connectionId: "conn-1", chunkSize: 4096 });

// Request / Response
await TCPClient.writeAndRead({ connectionId: "conn-1", data: [...], timeout: 1000 });

// Disconnect and free resources
await TCPClient.disconnect({ connectionId: "conn-1" });
await TCPClient.destroyConnection({ connectionId: "conn-1" });

// Events carry connectionId in the payload
TCPClient.addListener("tcpData", (ev) => {
    if (ev.connectionId !== "conn-1") return;
    console.log(ev.data); // number[]
});
TCPClient.addListener("tcpDisconnect", (ev) => {
    if (ev.connectionId !== "conn-1") return;
    console.log(ev.reason); // "manual" | "remote" | "error"
});
```
