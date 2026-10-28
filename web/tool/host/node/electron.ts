// The slice of Electron's main-process API the ported tool modules use. ipcMain handlers register
// here and answer the page's own orange.invoke() calls (see host/router.ts); `e.sender.send()`
// delivers to the page's orange.on() listeners.
import { INFO, invoke, hudNative } from '../native';

type Handler = (e: IpcEvent, ...args: any[]) => unknown;
export interface IpcEvent {
  sender: WebContents;
}
export interface WebContents {
  send(channel: string, ...args: unknown[]): void;
  /** 'destroyed' never fires: the window's own page is the "contents" and it goes away with them. */
  once(event: string, fn: () => void): WebContents;
  on(event: string, fn: () => void): WebContents;
  off(event: string, fn: () => void): WebContents;
  removeListener(event: string, fn: () => void): WebContents;
  isDestroyed(): boolean;
  id: number;
}

export const handlers = new Map<string, Handler>();
export const listeners = new Map<string, Handler>();
export const pageListeners = new Map<string, Set<(...a: any[]) => void>>();

export const sender: WebContents = {
  id: 1,
  isDestroyed: () => false,
  once() {
    return sender;
  },
  on() {
    return sender;
  },
  removeListener() {
    return sender;
  },
  off() {
    return sender;
  },
  send(channel, ...args) {
    for (const f of pageListeners.get(channel) ?? []) {
      try {
        f(...args);
      } catch (e) {
        console.error(e);
      }
    }
  },
};

export const ipcMain = {
  handle(ch: string, fn: Handler) {
    handlers.set(ch, fn);
  },
  on(ch: string, fn: Handler) {
    listeners.set(ch, fn);
  },
  removeHandler(ch: string) {
    handlers.delete(ch);
  },
};

const PATHS: Record<string, () => string> = {
  userData: () => INFO.userData,
  appData: () => INFO.userData.replace(/[\\/][^\\/]+$/, ''),
  temp: () => INFO.tmp,
  home: () => INFO.home,
  downloads: () => INFO.downloads,
  documents: () => INFO.documents,
  desktop: () => INFO.desktop,
  pictures: () => INFO.pictures,
  logs: () => INFO.logs,
  sessionData: () => INFO.userData,
};

export const app = {
  isPackaged: false,
  getPath: (name: string) => (PATHS[name] ?? PATHS.userData)(),
  getVersion: () => INFO.version,
  getName: () => 'Orange',
  on: () => app,
  whenReady: () => Promise.resolve(),
};

export const shell = {
  showItemInFolder: (p: string) => void invoke('bridge_invoke', { channel: 'file:reveal', args: [p] }),
  openPath: async (p: string) => {
    await invoke('bridge_invoke', { channel: 'file:reveal', args: [p] });
    return '';
  },
  beep: () => {},
};

export const nativeTheme = { shouldUseDarkColors: matchMedia('(prefers-color-scheme: dark)').matches, on: () => nativeTheme };

export class Notification {
  static isSupported() {
    return false;
  }
  constructor(_o: unknown) {}
  show() {}
}

export const BrowserWindow = {
  fromWebContents: () => null,
  getAllWindows: () => [],
};

export const screen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: screen_.width, height: screen_.height }, scaleFactor: devicePixelRatio }),
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: screen_.width, height: screen_.height }, scaleFactor: devicePixelRatio }),
};
const screen_ = window.screen;

export const dialog = {
  async showOpenDialog(_w: unknown, o: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) {
    const folder = o.properties?.includes('openDirectory');
    const r = await invoke<string[] | string | null>('tools_dialog', {
      op: { op: folder ? 'folder' : 'files', title: o.title ?? null, filters: o.filters ?? [], multi: !!o.properties?.includes('multiSelections') },
    });
    const filePaths = r === null ? [] : Array.isArray(r) ? r : [r];
    return { canceled: !filePaths.length, filePaths };
  },
};

/** Electron's `net.fetch`: the webview's fetch does the same job. */
export const net = { fetch: (u: string, o?: RequestInit) => fetch(u, o) };

export const hudNotice = (msg: string) => hudNative.notice(msg);

export default { ipcMain, app, shell, nativeTheme, Notification, BrowserWindow, screen, dialog, net };
