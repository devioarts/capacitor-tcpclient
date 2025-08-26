import { WebPlugin } from '@capacitor/core';

import type { TCPClientPlugin } from './definitions';

export class TCPClientWeb extends WebPlugin implements TCPClientPlugin {
  async echo(options: { value: string }): Promise<{ value: string }> {
    console.log('ECHO', options);
    return options;
  }
}
