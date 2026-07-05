// Minimal type stubs for Electron APIs used by the plugin.
// Consumer Electron apps have the real electron package installed.
declare module 'electron' {
  interface IpcMainEvent {
    readonly sender: WebContents;
  }
  interface WebContents {
    isDestroyed(): boolean;
    once(event: 'destroyed', listener: () => void): this;
    send(channel: string, ...args: unknown[]): void;
  }
  const ipcMain: {
    on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void;
  };
  export { ipcMain };
  export type { WebContents, IpcMainEvent };
}
