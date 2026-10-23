// node:fs and node:fs/promises over the ofs:// protocol (src-tauri/src/tools.rs). The sync calls
// are synchronous XHRs, so code written for Electron's main process runs unchanged.
import { Buffer } from 'buffer';
import { fsAsync, fsSync, readAsync, readRange, readSync, writeAsync, writeSync } from '../native';
import { EventEmitter } from './events';

interface RawStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mtimeMs: number;
  atimeMs: number;
  birthtimeMs: number;
  readonly: boolean;
}

export class Stats {
  size: number;
  mtimeMs: number;
  atimeMs: number;
  birthtimeMs: number;
  ctimeMs: number;
  mtime: Date;
  atime: Date;
  birthtime: Date;
  ctime: Date;
  mode: number;
  constructor(private r: RawStat) {
    this.size = r.size;
    this.mtimeMs = r.mtimeMs;
    this.atimeMs = r.atimeMs;
    this.birthtimeMs = r.birthtimeMs;
    this.ctimeMs = r.mtimeMs;
    this.mtime = new Date(r.mtimeMs);
    this.atime = new Date(r.atimeMs);
    this.birthtime = new Date(r.birthtimeMs);
    this.ctime = new Date(r.mtimeMs);
    this.mode = r.readonly ? 0o444 : 0o666;
  }
  isFile() {
    return this.r.isFile;
  }
  isDirectory() {
    return this.r.isDirectory;
  }
  isSymbolicLink() {
    return this.r.isSymbolicLink;
  }
}

class Dirent {
  constructor(
    public name: string,
    private d: { dir: boolean; file: boolean; link: boolean },
    public parentPath: string,
  ) {}
  isDirectory() {
    return this.d.dir;
  }
  isFile() {
    return this.d.file;
  }
  isSymbolicLink() {
    return this.d.link;
  }
}

type Enc = BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null | undefined;
const encOf = (o: Enc) => (typeof o === 'string' ? o : (o?.encoding ?? null));
const toBytes = (data: unknown, enc?: Enc): Uint8Array | string => {
  if (typeof data === 'string') return encOf(enc) && encOf(enc) !== 'utf8' && encOf(enc) !== 'utf-8' ? Buffer.from(data, encOf(enc) as BufferEncoding) : data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return String(data);
};
const decode = (b: Uint8Array, enc: Enc) => {
  const e = encOf(enc);
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  return e ? buf.toString(e) : buf;
};

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 };

export function existsSync(p: string) {
  if (!p) return false;
  try {
    return fsSync<boolean>('exists', String(p));
  } catch {
    return false;
  }
}
export const statSync = (p: string, o?: { throwIfNoEntry?: boolean }) => {
  try {
    return new Stats(fsSync<RawStat>('stat', String(p)));
  } catch (e) {
    if (o?.throwIfNoEntry === false) return undefined as unknown as Stats;
    throw e;
  }
};
export const lstatSync = (p: string) => new Stats(fsSync<RawStat>('lstat', String(p)));
export function readFileSync(p: string, enc?: Enc): any {
  return decode(readSync(String(p)), enc);
}
export function writeFileSync(p: string, data: unknown, enc?: Enc) {
  writeSync(String(p), toBytes(data, enc));
}
export function appendFileSync(p: string, data: unknown, enc?: Enc) {
  writeSync(String(p), toBytes(data, enc), true);
}
export function mkdirSync(p: string, o?: { recursive?: boolean }) {
  try {
    fsSync('mkdir', String(p), { recursive: !!o?.recursive });
  } catch (e: any) {
    if (!(o?.recursive && e.code === 'EEXIST')) throw e;
  }
  return o?.recursive ? String(p) : undefined;
}
export const mkdtempSync = (prefix: string) => fsSync<string>('mkdtemp', prefix);
export function readdirSync(p: string, o?: { withFileTypes?: boolean } | string): any[] {
  const list = fsSync<{ name: string; dir: boolean; file: boolean; link: boolean }[]>('readdir', String(p));
  if (typeof o === 'object' && o?.withFileTypes) return list.map((d) => new Dirent(d.name, d, String(p)));
  return list.map((d) => d.name);
}
export const rmSync = (p: string, o?: { recursive?: boolean; force?: boolean }) => {
  if (!p) return;
  fsSync('rm', String(p), { recursive: !!o?.recursive, force: !!o?.force });
};
export const unlinkSync = (p: string) => fsSync('rm', String(p));
export const rmdirSync = (p: string, o?: { recursive?: boolean }) => fsSync('rm', String(p), { recursive: !!o?.recursive });
export const renameSync = (a: string, b: string) => fsSync('rename', String(a), { to: String(b) });
export const copyFileSync = (a: string, b: string) => fsSync('copy', String(a), { to: String(b) });
export const realpathSync = Object.assign((p: string) => fsSync<string>('realpath', String(p)), { native: (p: string) => fsSync<string>('realpath', String(p)) });
export const utimesSync = (p: string, _a: number | Date, m: number | Date) => fsSync('utimes', String(p), { mtime: typeof m === 'number' ? m * 1000 : m.getTime() });
export const accessSync = (p: string) => {
  statSync(p);
};
export const truncateSync = (p: string, len = 0) => fsSync('truncate', String(p), { len });

// File descriptors: enough for "read the first bytes of a file" (archive sniffing) and appending.
const fds = new Map<number, { p: string; pos: number }>();
let nextFd = 100;
export function openSync(p: string, flags = 'r') {
  if (/w/.test(flags)) writeSync(String(p), new Uint8Array(0));
  else if (!/a/.test(flags)) statSync(p);
  fds.set(nextFd, { p: String(p), pos: 0 });
  return nextFd++;
}
export function readSyncFd(fd: number, buf: Uint8Array, off: number, len: number, pos: number | null) {
  const f = fds.get(fd);
  if (!f) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
  const at = pos ?? f.pos;
  const b64 = fsSync<string>('readSlice', f.p, { start: at, len });
  const bytes = Buffer.from(b64, 'base64');
  buf.set(bytes, off);
  if (pos === null || pos === undefined) f.pos += bytes.length;
  return bytes.length;
}
export function writeSyncFd(fd: number, data: Uint8Array | string) {
  const f = fds.get(fd);
  if (!f) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
  writeSync(f.p, typeof data === 'string' ? data : data, true);
  return typeof data === 'string' ? data.length : data.length;
}
export const closeSync = (fd: number) => void fds.delete(fd);

/** A write stream that appends each chunk (buffered up to 8 MB per request). */
export function createWriteStream(p: string) {
  const em = new EventEmitter() as EventEmitter & { write(c: any): boolean; end(c?: any): void; close(): void; bytesWritten: number; path: string };
  let pending: Uint8Array[] = [];
  let size = 0;
  let chain = writeAsync(String(p), new Uint8Array(0));
  const flush = () => {
    if (!pending.length) return;
    const all = new Uint8Array(size);
    let o = 0;
    for (const c of pending) {
      all.set(c, o);
      o += c.length;
    }
    pending = [];
    size = 0;
    chain = chain.then(() => writeAsync(String(p), all, true));
    chain.catch((e) => em.emit('error', e));
  };
  em.path = String(p);
  em.bytesWritten = 0;
  em.write = (c: any) => {
    const b = typeof c === 'string' ? new TextEncoder().encode(c) : (toBytes(c) as Uint8Array);
    pending.push(b);
    size += b.length;
    em.bytesWritten += b.length;
    if (size > 8 * 1024 * 1024) flush();
    return true;
  };
  em.end = (c?: any) => {
    if (c !== undefined && c !== null) em.write(c);
    flush();
    chain.then(
      () => {
        em.emit('finish');
        em.emit('close');
      },
      (e) => em.emit('error', e),
    );
  };
  em.close = () => em.end();
  return em;
}

export function createReadStream(p: string) {
  const em = new EventEmitter() as EventEmitter & { pipe(d: any): any };
  em.pipe = (d: any) => {
    readAsync(String(p)).then(
      (b) => {
        d.write(Buffer.from(b));
        d.end();
      },
      (e) => em.emit('error', e),
    );
    return d;
  };
  return em;
}

// ---------------------------------------------------------------- promises

class FileHandle {
  constructor(
    private p: string,
    private appendMode: boolean,
  ) {}
  async read(buf: Uint8Array, off: number, len: number, pos: number) {
    const b = await readRange(this.p, pos, len);
    buf.set(b, off);
    return { bytesRead: b.length, buffer: buf };
  }
  async write(data: Uint8Array | string) {
    await writeAsync(this.p, data, true);
    return { bytesWritten: typeof data === 'string' ? data.length : data.length };
  }
  async stat() {
    return new Stats(await fsAsync<RawStat>('stat', this.p));
  }
  async readFile(enc?: Enc) {
    return decode(await readAsync(this.p), enc);
  }
  async close() {
    void this.appendMode;
  }
}

export const promises = {
  async readFile(p: string, enc?: Enc): Promise<any> {
    return decode(await readAsync(String(p)), enc);
  },
  async writeFile(p: string, data: unknown, enc?: Enc) {
    await writeAsync(String(p), toBytes(data, enc));
  },
  async appendFile(p: string, data: unknown, enc?: Enc) {
    await writeAsync(String(p), toBytes(data, enc), true);
  },
  async stat(p: string) {
    return new Stats(await fsAsync<RawStat>('stat', String(p)));
  },
  async lstat(p: string) {
    return new Stats(await fsAsync<RawStat>('lstat', String(p)));
  },
  async rename(a: string, b: string) {
    await fsAsync('rename', String(a), { to: String(b) });
  },
  async rm(p: string, o?: { recursive?: boolean; force?: boolean }) {
    await fsAsync('rm', String(p), { recursive: !!o?.recursive, force: !!o?.force });
  },
  async unlink(p: string) {
    await fsAsync('rm', String(p));
  },
  async mkdir(p: string, o?: { recursive?: boolean }) {
    try {
      await fsAsync('mkdir', String(p), { recursive: !!o?.recursive });
    } catch (e: any) {
      if (!(o?.recursive && e.code === 'EEXIST')) throw e;
    }
  },
  async mkdtemp(prefix: string) {
    return fsAsync<string>('mkdtemp', prefix);
  },
  async readdir(p: string, o?: { withFileTypes?: boolean }) {
    return readdirSync(p, o);
  },
  async copyFile(a: string, b: string) {
    await fsAsync('copy', String(a), { to: String(b) });
  },
  async access(p: string) {
    await fsAsync('stat', String(p));
  },
  async utimes(p: string, a: number | Date, m: number | Date) {
    utimesSync(p, a, m);
  },
  async realpath(p: string) {
    return fsAsync<string>('realpath', String(p));
  },
  async open(p: string, flags = 'r') {
    if (/w/.test(flags)) await writeAsync(String(p), new Uint8Array(0));
    else if (!/a/.test(flags)) await fsAsync('stat', String(p));
    return new FileHandle(String(p), /a|w/.test(flags));
  },
};

export {
  readSyncFd as readSync,
  writeSyncFd as writeSync,
};
export const { readFile, writeFile, appendFile, stat, lstat, rename, rm, unlink, mkdir, mkdtemp, readdir, copyFile, access, utimes, realpath, open } = promises;

/** Default export for `import fs from 'node:fs'`. */
const fs = {
  constants, existsSync, statSync, lstatSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync,
  unlinkSync, rmdirSync, renameSync, copyFileSync, realpathSync, utimesSync, accessSync, truncateSync, openSync, readSync: readSyncFd,
  writeSync: writeSyncFd, closeSync, createWriteStream, createReadStream, promises, Stats,
};
export default fs;
