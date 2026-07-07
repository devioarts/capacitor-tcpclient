# Getting Started

This guide covers installation and native project setup for a Capacitor app.
For runtime examples, see the [usage guide](usage.md).

## Requirements

- Capacitor `>= 8.0.0`
- Android, iOS or Electron when you need real TCP sockets
- A reachable TCP server or device on the network

The browser/web implementation is only a development stub. It mirrors the API
shape so your app can render in a browser, but it does not open real sockets.

## Install

```bash
npm install @devioarts/capacitor-tcpclient
npx cap sync
```

Import the root package in Capacitor code:

```ts
import { TCPClient } from '@devioarts/capacitor-tcpclient';
```

## Android Setup

The plugin declares the required Android network permissions in its own
manifest, so Gradle's Android manifest merger adds them to your app
automatically during `npx cap sync android` / Android builds.

If you want to declare them manually, or if you are checking a custom native
setup, add them to your app manifest:

`android/app/src/main/AndroidManifest.xml`

```xml
<manifest>
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

  <application>
    <!-- Your app configuration -->
  </application>
</manifest>
```

If you connect to plain-text devices on the local network, your app may also
need cleartext traffic enabled:

```xml
<application android:usesCleartextTraffic="true">
  <!-- Your app configuration -->
</application>
```

For local network discovery flows on newer Android versions, your app may need
additional permissions such as `NEARBY_WIFI_DEVICES` or location permissions.
Request only the permissions your app actually uses.

## iOS Setup

Add a local network usage message and allow local networking when talking to
local TCP devices.

`ios/App/App/Info.plist`

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>This app connects to TCP devices on your local network.</string>

<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

Then sync and open the native project:

```bash
npx cap sync ios
npx cap open ios
```

## Verify the Plugin Platform

`getPluginPlatform()` reports the TCP implementation backing the plugin. This is
different from `Capacitor.getPlatform()` because Electron and the web stub have
their own TCP behavior.

```ts
const platform = await TCPClient.getPluginPlatform();

if (!platform.error) {
  console.log(platform.platform); // 'ios' | 'android' | 'electron' | 'web'
}
```

## Playground App

The repository includes a Capacitor playground in `playground/`. It demonstrates
multiple screens for connection management, stream reads, request/response reads
and platform setup.

```bash
cd playground
npm install
npm run dev:build
npx cap add android
npx cap sync android
npx cap open android
```

For iOS:

```bash
cd playground
npm install
npm run dev:build
npx cap add ios
npx cap sync ios
npx cap open ios
```

For Electron playground usage, see [Electron integration](electron.md).
