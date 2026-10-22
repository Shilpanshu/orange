// Orange 2 (Tauri) adapter for the renderer bridge. Exposes the same `window.orange` API as the
// Electron preload (send / invoke / on / pathForFile / args), so pages run unchanged.
// Injected ahead of every page bundle by scripts/build-web.mjs.

interface TauriGlobal {
  core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, fn: (e: { payload: T }) => void): Promise<() => void> };
}

const T = (window as unknown as { __TAURI__: TauriGlobal }).__TAURI__;
const pending: Promise<unknown>[] = [];

const api = {
  send: (channel: string, ...args: unknown[]) => {
    T.core.invoke('bridge_send', { channel, args }).catch((e) => console.error('send', channel, e));
  },
  invoke: <R = unknown>(channel: string, ...args: unknown[]) => T.core.invoke<R>('bridge_invoke', { channel, args }),
  on: (channel: string, fn: (...args: any[]) => void) => {
    let off: (() => void) | null = null;
    let dead = false;
    const p = T.event.listen<unknown>(channel, (e) => fn(...(Array.isArray(e.payload) ? e.payload : [e.payload]))).then((u) => {
      if (dead) u();
      else off = u;
    });
    pending.push(p);
    return () => {
      dead = true;
      off?.();
    };
  },
  // Files arrive as paths from the native drop target; DOM File objects carry none.
  pathForFile: (_file: File) => '',
  args: (() => {
    try {
      return JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
    } catch {
      return {};
    }
  })(),
};

(window as unknown as { orange: typeof api }).orange = api;

// Once the page's script has registered its listeners (synchronously, at load), tell the host the
// page can receive events. Listener registration is itself asynchronous in Tauri.
setTimeout(() => {
  Promise.all(pending).then(() => api.send('page:ready'));
}, 0);
