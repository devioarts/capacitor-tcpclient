export interface TCPClientPlugin {
  echo(options: { value: string }): Promise<{ value: string }>;
}
