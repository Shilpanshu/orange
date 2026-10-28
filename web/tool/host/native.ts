// The tool window's line to the native side (src-tauri/src/tools.rs): Tauri commands, and the
// ofs:// file protocol. Synchronous XHR against ofs:// is what lets the 1.x main-process code keep
// its fs.*Sync calls unchanged when it runs here in the page.

interface TauriCore {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  Channel: new <T>(onmessage?: (m: T) => void) => { onmessage: (m: T) => void };
}
const core = (window as unknown as { __TAURI__: { core: TauriCore } }).__TAURI__.core;

export const invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => core.invoke<T>(cmd, args);
export const Channel = core.Channel;

export interface Info {
  binDir: string;
  tmp: string;
  home: string;
  userData: string;
  localData: string;
  cache: string;
  logs: string;
  downloads: string;
  documents: string;
  desktop: string;
  pictures: string;
  cpus: number;
  version: string;
  pid: number;
}

export let INFO: Info = {
  binDir: '', tmp: 'C:\\Windows\\Temp', home: '', userData: '', localData: '', cache: '', logs: '', downloads: '',
  documents: '', desktop: '', pictures: '', cpus: navigator.hardwareConcurrency || 4, version: '2.0.0', pid: 0,
};
let infoReady: Promise<void> | null = null;
/** Loads machine paths once; every host module awaits this before its first use. */
export function initNative(): Promise<void> {
  infoReady ??= invoke<Info>('tools_info').then((i) => {
    INFO = i;
  });
  return infoReady;
}

export const OFS = 'http://ofs.localhost';
/** URL the webview can load a local file from (img/video/audio src, fetch). Supports Range. */
export const fileSrc = (p: string) => `${OFS}/f?p=${encodeURIComponent(p)}`;
/** Reverse of fileSrc; '' when `u` isn't one. */
export function srcToPath(u: string): string {
  if (!u.startsWith(`${OFS}/f?p=`)) return '';
  return decodeURIComponent(u.slice(`${OFS}/f?p=`.length));
}

export interface FsError extends Error {
  code: string;
  path?: string;
}

function fsError(code: string, message: string, path?: string): FsError {
  const e = new Error(`${code}: ${message}${path ? `, '${path}'` : ''}`) as FsError;
  e.code = code;
  if (path) e.path = path;
  return e;
}

/** One filesystem op, synchronously. Throws Node-style errors (err.code = 'ENOENT'...). */
/** Logs synchronous file calls that hold the page up (they block its thread). */
function slow(what: string, t0: number) {
  const ms = performance.now() - t0;
  if (ms > 250) (window as any).orange?.send?.('log', `slow sync ${what}: ${Math.round(ms)} ms`);
}

export function fsSync<T = unknown>(op: string, p: string, extra: Record<string, unknown> = {}): T {
  const t0 = performance.now();
  if ((window as any).__traceSync) (window as any).orange.send('log', `sync> ${op} ${p}`);
  try {
    return fsSyncInner<T>(op, p, extra);
  } finally {
    slow(`${op} ${p}`, t0);
  }
}
function fsSyncInner<T>(op: string, p: string, extra: Record<string, unknown>): T {
  const x = new XMLHttpRequest();
  x.open('POST', `${OFS}/fs`, false);
  x.setRequestHeader('Content-Type', 'text/plain');
  x.send(JSON.stringify({ op, p, ...extra }));
  if (x.status !== 200) throw fsError('EIO', x.responseText || `fs ${op} failed (${x.status})`, p);
  const r = JSON.parse(x.responseText);
  if (!r.ok) throw fsError(r.code, r.message, p);
  return r.value as T;
}

export async function fsAsync<T = unknown>(op: string, p: string, extra: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${OFS}/fs`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ op, p, ...extra }) });
  const r = await res.json();
  if (!r.ok) throw fsError(r.code, r.message, p);
  return r.value as T;
}

/** Whole file, synchronously. */
export function readSync(p: string): Uint8Array {
  if ((window as any).__traceSync) (window as any).orange.send('log', `sync> read ${p}`);
  const x = new XMLHttpRequest();
  x.open('GET', fileSrc(p), false);
  x.overrideMimeType('text/plain; charset=x-user-defined');
  x.send();
  if (x.status === 404) throw fsError('ENOENT', 'no such file or directory', p);
  if (x.status !== 200) throw fsError('EIO', x.responseText, p);
  const s = x.responseText;
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export async function readAsync(p: string): Promise<Uint8Array> {
  const res = await fetch(fileSrc(p), { cache: 'no-store' });
  if (res.status === 404) throw fsError('ENOENT', 'no such file or directory', p);
  if (!res.ok) throw fsError('EIO', await res.text(), p);
  return new Uint8Array(await res.arrayBuffer());
}

/** Bytes [start, start + len) of a file. */
export async function readRange(p: string, start: number, len: number): Promise<Uint8Array> {
  if (len <= 0) return new Uint8Array(0);
  const out = new Uint8Array(len);
  let got = 0;
  // The protocol answers at most 4 MB per Range request.
  while (got < len) {
    const res = await fetch(fileSrc(p), { headers: { Range: `bytes=${start + got}-${start + len - 1}` }, cache: 'no-store' });
    if (res.status === 416) break;
    if (!res.ok) throw fsError(res.status === 404 ? 'ENOENT' : 'EIO', await res.text(), p);
    const b = new Uint8Array(await res.arrayBuffer());
    if (!b.length) break;
    out.set(b.subarray(0, len - got), got);
    got += b.length;
  }
  return got < len ? out.subarray(0, got) : out;
}

function writeResult(status: number, text: string, p: string) {
  if (status !== 200) throw fsError('EIO', text, p);
  const r = JSON.parse(text);
  if (!r.ok) throw fsError(r.code, r.message, p);
}

export function writeSync(p: string, data: Uint8Array | string, append = false) {
  const x = new XMLHttpRequest();
  x.open('POST', `${OFS}/write?p=${encodeURIComponent(p)}${append ? '&append=1' : ''}`, false);
  x.send((typeof data === "string" ? new TextEncoder().encode(data) : data) as unknown as XMLHttpRequestBodyInit);
  writeResult(x.status, x.responseText, p);
}

export async function writeAsync(p: string, data: Uint8Array | string | Blob, append = false) {
  const body = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const res = await fetch(`${OFS}/write?p=${encodeURIComponent(p)}${append ? '&append=1' : ''}`, { method: 'POST', body: body as BodyInit });
  writeResult(res.status, await res.text(), p);
}

// ------------------------------------------------------------------ progress panel

/** Windows opened by the test runner (src-tauri/src/tools.rs, ORANGE_TOOL_TEST_DIR) show no progress panel. */
const quiet = () => !!(window as unknown as { orange?: { args?: { test?: boolean } } }).orange?.args?.test;
const none = <T>(v: T) => Promise.resolve(v);

export const hudNative = {
  start: (title: string) => (quiet() ? none(0) : invoke<number>('tools_hud', { op: { op: 'start', title } })),
  progress: (id: number, progress: number | undefined, note?: string) =>
    quiet() ? none(null) : invoke('tools_hud', { op: { op: 'progress', id, progress: progress ?? null, note: note ?? null } }),
  poll: (id: number) => (quiet() ? none(false) : invoke<boolean>('tools_hud', { op: { op: 'poll', id } })),
  done: (id: number, outputs: string[], errors: string[]) => (quiet() ? none(null) : invoke('tools_hud', { op: { op: 'done', id, outputs, errors } })),
  failed: (id: number, note: string) => (quiet() ? none(null) : invoke('tools_hud', { op: { op: 'failed', id, note } })),
  cancelled: (id: number) => (quiet() ? none(null) : invoke('tools_hud', { op: { op: 'cancelled', id } })),
  notice: (title: string) => (quiet() ? none(null) : invoke('tools_hud', { op: { op: 'notice', title } })),
};

/**
 * Ids for native processes and downloads. The native side keys them in one table shared by every
 * tool window, so a per-window counter would make two windows kill each other's processes: each
 * window gets a random 32-bit prefix, then counts.
 */
const idBase = crypto.getRandomValues(new Uint32Array(1))[0] * 1048576;
let idCount = 0;
export const uniqueId = () => idBase + (idCount++ % 1048576);

export const windowOp = (op: string) => invoke('tools_window', { op: { op } });

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
