/**
 * Metadata consumed by the capacitor-electron runtime generator (`npm run update`).
 *
 * The generator reads `pluginMethods`, `pluginEvents`, `imports`, and `beforeRegister`
 * to produce the auto-wired IPC handler file (`electron-main.ts`) and the preload
 * plugin registry (`electron-plugins.ts`).
 *
 * With `autoRegister: true` the generator includes this plugin automatically.
 * Import path for the JS layer: `@devioarts/capacitor-tcpclient/electron/settings`.
 */
export const pluginSettings = {
  pluginClass: 'TCPClient',
  pluginMethods: [
    'getPlatform',
    'connect',
    'disconnect',
    'isConnected',
    'isReading',
    'write',
    'startRead',
    'stopRead',
    'setReadTimeout',
    'writeAndRead',
    'destroyConnection',
  ] as const,
  pluginEvents: ['tcpData', 'tcpDisconnect'] as const,
  autoRegister: true,
  imports: ["import { TCPClient } from '@devioarts/capacitor-tcpclient/electron'"] as const,
  beforeRegister: ['await app.whenReady()'] as const,
} as const;

export type PluginSettings = typeof pluginSettings;
