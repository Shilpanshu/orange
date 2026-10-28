// Small node: modules for the ported code: os, url, module, async_hooks, util, zlib, stream.
// scripts/build-web.mjs aliases each `node:x` import to its export object here (see host/node/*.ts).
import { INFO, fileSrc, srcToPath } from '../native';
import { inflate as pakoInflate, ungzip } from 'pako';
import { Buffer } from 'buffer';
import { EventEmitter } from './events';

// ---------------------------------------------------------------- os
export const os = {
  tmpdir: () => INFO.tmp.replace(/[\\/]+$/, ''),
  homedir: () => INFO.home,
  cpus: () => Array.from({ length: INFO.cpus }, () => ({ model: 'cpu', speed: 0 })),
  availableParallelism: () => INFO.cpus,
  platform: () => 'win32',
  arch: () => 'x64',
  EOL: '\r\n',
  totalmem: () => ((navigator as any).deviceMemory ?? 8) * 2 ** 30,
  freemem: () => ((navigator as any).deviceMemory ?? 8) * 2 ** 29,
  release: () => '10.0',
};

// ---------------------------------------------------------------- url
// A "file URL" here is the ofs:// URL the webview can actually load.
export const url = {
  pathToFileURL: (p: string) => new URL(fileSrc(p)),
  fileURLToPath(u: string | URL) {
    const s = String(u);
    const p = srcToPath(s);
    if (p) return p;
    if (s.startsWith('file:')) return decodeURIComponent(s.replace(/^file:\/\/\/?/, '')).replace(/\//g, '\\');
    return s;
  },
};

// ---------------------------------------------------------------- module
export const module_ = {
  createRequire: (_f: string) => (id: string) => {
    throw new Error(`require(${id}) is not available in Orange 2`);
  },
};

// ---------------------------------------------------------------- async_hooks
// No real async context: run() sets the store for the call and the promise it returns (a tool
// window runs one job at a time).
export class AsyncLocalStorage<T> {
  private store: T | undefined;
  getStore() {
    return this.store;
  }
  run<R>(store: T, fn: (...a: any[]) => R, ...args: any[]): R {
    const prev = this.store;
    this.store = store;
    try {
      const r = fn(...args);
      if (r && typeof (r as any).then === 'function') return (r as any).finally(() => (this.store = prev));
      this.store = prev;
      return r;
    } catch (e) {
      this.store = prev;
      throw e;
    }
  }
}
export const async_hooks = { AsyncLocalStorage };

// ---------------------------------------------------------------- util
const inspect = (v: unknown) => {
  try {
    return typeof v === 'string' ? v : v instanceof Error ? v.stack ?? v.message : JSON.stringify(v);
  } catch {
    return String(v);
  }
};
export const util = {
  promisify: (fn: (...a: any[]) => void) => (...a: any[]) => new Promise((res, rej) => fn(...a, (e: any, v: any) => (e ? rej(e) : res(v)))),
  inspect,
  format: (...a: unknown[]) => a.map(inspect).join(' '),
  types: { isUint8Array: (v: unknown) => v instanceof Uint8Array },
  TextDecoder,
  TextEncoder,
};

// ---------------------------------------------------------------- zlib
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data: Uint8Array | string, value = 0): number {
  const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let c = (value ^ 0xffffffff) >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export const zlib = {
  crc32,
  gunzipSync: (b: Uint8Array) => Buffer.from(ungzip(b)),
  inflateSync: (b: Uint8Array) => Buffer.from(pakoInflate(b)),
  createGunzip: (): never => {
    throw new Error('createGunzip is not available in Orange 2');
  },
  constants: {},
};

// ---------------------------------------------------------------- stream
export class Readable extends EventEmitter {
  static from(it: AsyncIterable<any> | Iterable<any>) {
    const r = new Readable();
    r.source = it;
    return r;
  }
  source: AsyncIterable<any> | Iterable<any> | null = null;
  pipe<T extends { write(c: any): any; end(): any }>(dest: T): T {
    (async () => {
      try {
        for await (const c of this.source as AsyncIterable<any>) await dest.write(c);
        await dest.end();
      } catch (e) {
        this.emit('error', e);
      }
    })();
    return dest;
  }
  async *[Symbol.asyncIterator]() {
    if (this.source) yield* this.source as AsyncIterable<any>;
  }
}
export const stream = { Readable };

// ---------------------------------------------------------------- process (global)
export const process_: any = {
  platform: 'win32',
  arch: 'x64',
  env: {},
  argv: [],
  versions: { node: '22.0.0' },
  get pid() {
    return INFO.pid;
  },
  get resourcesPath() {
    return INFO.binDir.replace(/[\\/]bin[\\/]?$/i, '');
  },
  cwd: () => INFO.tmp,
  nextTick: (f: (...a: any[]) => void, ...a: any[]) => queueMicrotask(() => f(...a)),
  hrtime: Object.assign(
    (prev?: [number, number]) => {
      const t = performance.now();
      const s = Math.floor(t / 1000);
      const ns = Math.floor((t % 1000) * 1e6);
      return prev ? [s - prev[0], ns - prev[1]] : [s, ns];
    },
    { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
  ),
  memoryUsage: () => ({ rss: 0, heapUsed: (performance as any).memory?.usedJSHeapSize ?? 0 }),
  on: () => process_,
  once: () => process_,
  emitWarning: () => {},
};
