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
    'getPluginPlatform',
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
  // optional, default is true
  // autoRegister: true,

  // add only if the plugin reads plugins.TCPClient from capacitor.config
  // configSections: ['TCPClient'],
} as const;

export type PluginSettings = typeof pluginSettings;
