// One small bridge shared by every Orange window.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>,
  on: (channel: string, fn: (...args: any[]) => void) => {
    const handler = (_e: unknown, ...args: any[]) => fn(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  // Window arguments passed via the URL hash by the main process.
  args: (() => {
    try {
      return JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
    } catch {
      return {};
    }
  })(),
};

contextBridge.exposeInMainWorld('orange', api);
export type OrangeApi = typeof api;
