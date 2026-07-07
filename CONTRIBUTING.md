# Contributing Guidelines

We welcome bug reports, feature requests, and focused code improvements.

## Reporting Bugs

- Include the platform: iOS, Android, Electron, or Web.
- Include the device/OS version and Capacitor version.
- Add a small TCP server/client reproduction when possible.
- Include the exact call options, returned object, and any `tcpDisconnect` event.

## Requesting Features

- Describe the protocol or device you need to support.
- Explain the expected behavior for streaming and request/response reads.
- Call out platform differences you already know about.

## Local Setup

```bash
npm install
```

Useful checks:

```bash
npm run build
npm run eslint
npm run swiftlint -- lint
xcodebuild -scheme DevioartsCapacitorTcpclient -destination generic/platform=iOS
cd android && ./gradlew build test
```

`npm run build` regenerates the API section in `README.md` from JSDoc in
`src/definitions.ts`. Update the JSDoc first, then rerun the build.

## Coding Notes

- Keep platform behavior aligned across iOS, Android, and Electron unless a platform API makes that impossible.
- Byte payloads must validate integer values in the `0..255` range instead of silently masking invalid input.
- Clamp user-controlled buffer sizes before allocating memory.
- Keep socket lifecycle callbacks idempotent: disconnect, close, timeout, and error paths can race.
- Document behavior changes in `README.md` and `CHANGELOG.md`.
