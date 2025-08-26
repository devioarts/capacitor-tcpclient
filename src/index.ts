import { registerPlugin } from '@capacitor/core';

import type { TCPClientPlugin } from './definitions';

const TCPClient = registerPlugin<TCPClientPlugin>('TCPClient', {
  web: () => import('./web').then((m) => new m.TCPClientWeb()),
});

export * from './definitions';
export { TCPClient };
