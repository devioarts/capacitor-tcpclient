import type {
  TcpConnectOptions,
  TcpConnectResult,
  TcpDisconnectResult,
  TcpGetPlatformResult,
  TcpIsConnectedResult,
  TcpIsReadingResult,
  TcpStartReadOptions,
  TcpStartStopResult,
  TcpWriteAndReadOptions,
  TcpWriteAndReadResult,
  TcpWriteOptions,
  TcpWriteResult,
} from '../../dist/esm/definitions';

export declare class TCPClient {
  getPlatform(): Promise<TcpGetPlatformResult>;
  connect(args: TcpConnectOptions & { connectionId: string }): Promise<TcpConnectResult>;
  disconnect(args: { connectionId: string }): Promise<TcpDisconnectResult>;
  isConnected(args: { connectionId: string }): Promise<TcpIsConnectedResult>;
  isReading(args: { connectionId: string }): Promise<TcpIsReadingResult>;
  write(args: TcpWriteOptions & { connectionId: string }): Promise<TcpWriteResult>;
  writeAndRead(args: TcpWriteAndReadOptions & { connectionId: string }): Promise<TcpWriteAndReadResult>;
  startRead(args: TcpStartReadOptions & { connectionId: string }): Promise<TcpStartStopResult>;
  stopRead(args: { connectionId: string }): Promise<TcpStartStopResult>;
  setReadTimeout(args: {
    connectionId: string;
    readTimeout: number;
  }): Promise<{ error: boolean; errorMessage?: string | null }>;
  destroyConnection(args: { connectionId: string }): Promise<{ error: boolean; errorMessage?: string | null }>;
}
