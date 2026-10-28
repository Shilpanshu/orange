// The `orange` bridge every page sees as a global (installed by web/bridge.ts).
export interface OrangeApi {
  send: (channel: string, ...args: unknown[]) => void;
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
  on: (channel: string, fn: (...args: any[]) => void) => () => void;
  pathForFile: (file: File) => string;
  /** Window arguments passed in the URL hash. */
  args: any;
}
