import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { constants as zc, zstdDecompress, zstdDecompressSync, type ZstdOptions } from 'node:zlib';
import { log } from './log';

// dist/ when running from source, resources/app.asar/dist when packaged.
export const distDir = __dirname;

// Bundled command-line tools (ffmpeg, 7z, pandoc, magick, gs, helper).
export const binDir = app.isPackaged ? join(process.resourcesPath, 'bin') : join(__dirname, '..', 'vendor', 'bin');

// ------------------------------------------------------------------ packed tools
//
// The installer ships ffmpeg and ffprobe zstd-compressed (scripts/vendor/media.mjs): ffmpeg.exe.zst, and
// ffprobe as a patch against ffmpeg.exe, since both are static builds of the same libraries. That takes
// 53 MB instead of 210 MB on disk until the first audio/video job, which unpacks them once (about half a
// second, offline). From source, vendor/bin holds the plain exes and nothing is unpacked.
//
// Unpacked copies go next to the archive as ffmpeg.exe / ffprobe.exe and the archive is then deleted, so
// an install holds one copy, never two. When the install folder is read-only they go to
// <userData>/engines instead (named by archive size, so an update never reuses a stale copy) and the
// archive stays. Every archive carries a content checksum that the decoder verifies, so a damaged or
// mismatched archive fails loudly instead of producing a broken exe.

interface Packed {
  /** Archive file name in binDir. */
  file: string;
  /** Tool whose exe is the patch reference (zstd dictionary). */
  dict?: string;
}

const PACKED: Record<string, Packed> = {
  ffmpeg: { file: 'ffmpeg.exe.zst' },
  ffprobe: { file: 'ffprobe.exe.from-ffmpeg.zst', dict: 'ffmpeg' },
};

/** Matches the window the archives were made with (scripts/vendor/media.mjs, ZSTD_WINDOW_LOG). */
const WINDOW_LOG_MAX = 28;

const exeName = (name: string) => (name.endsWith('.exe') ? name : `${name}.exe`);
const toolName = (name: string) => exeName(name).slice(0, -4).replace(/\\/g, '/');

function packedArchive(name: string): string | null {
  const p = PACKED[toolName(name)];
  if (!p) return null;
  // From source vendor/bin holds both the exe and the archive the installer will ship: use the exe.
  if (!app.isPackaged && existsSync(join(binDir, exeName(name)))) return null;
  const f = join(binDir, p.file);
  return existsSync(f) ? f : null;
}

/** Where an unpacked copy may live, best first. */
function targets(name: string, archive: string): string[] {
  const fallback = join(app.getPath('userData'), 'engines', `${toolName(name)}-${statSync(archive).size.toString(36)}.exe`);
  return [join(binDir, exeName(name)), fallback];
}

function decodeOptions(dictionary?: Buffer): ZstdOptions {
  return { ...(dictionary ? { dictionary } : {}), params: { [zc.ZSTD_d_windowLogMax]: WINDOW_LOG_MAX } } as ZstdOptions;
}

/** Writes `body` to the first writable target; returns its path. */
function place(name: string, archive: string, body: Buffer, started: number): string {
  let lastErr: unknown;
  for (const [i, exe] of targets(name, archive).entries()) {
    const part = `${exe}.${process.pid}.part`;
    try {
      mkdirSync(join(exe, '..'), { recursive: true });
      writeFileSync(part, body);
      renameSync(part, exe);
      if (i === 0) {
        // Next to the archive: the archive is no longer needed.
        rmSync(archive, { force: true });
      } else {
        const dir = join(exe, '..');
        const base = toolName(name);
        for (const f of readdirSync(dir)) {
          if (f !== exe.split(/[\\/]/).pop() && new RegExp(`^${base}-[0-9a-z]+\\.exe(\\.\\d+\\.part)?$`).test(f)) rmSync(join(dir, f), { force: true });
        }
      }
      log(`${toolName(name)} unpacked to ${exe} in ${Date.now() - started} ms`);
      return exe;
    } catch (e) {
      lastErr = e;
      rmSync(part, { force: true });
    }
  }
  throw new Error(`Couldn't prepare ${toolName(name)} (${(lastErr as Error)?.message ?? lastErr}).`);
}

/** An already-unpacked copy, or null. */
function unpackedCopy(name: string, archive: string): string | null {
  // An archive next to an exe means the exe is older (an unpack cut short, or a leftover), so only the
  // read-only fallback location is trusted while the archive exists.
  const fallback = targets(name, archive)[1];
  return existsSync(fallback) ? fallback : null;
}

function unpackSync(name: string, archive: string): string {
  const ready = unpackedCopy(name, archive);
  if (ready) return ready;
  const started = Date.now();
  const p = PACKED[toolName(name)];
  const dictionary = p.dict ? readFileSync(bin(p.dict)) : undefined;
  const body = zstdDecompressSync(readFileSync(archive), decodeOptions(dictionary));
  return place(name, archive, body, started);
}

const decodeAsync = promisify(zstdDecompress) as (buf: Buffer, opts: ZstdOptions) => Promise<Buffer>;
const preparing = new Map<string, Promise<string>>();

/**
 * Path of a runnable tool, unpacking it first when it ships packed, without blocking the main process
 * (decoding runs on the thread pool). Use it to get a tool ready ahead of time, e.g. when a video is
 * selected; bin() does the same work synchronously if nothing prepared it.
 */
export function prepareBin(name: string): Promise<string> {
  const key = toolName(name);
  const archive = packedArchive(name);
  if (!archive) return Promise.resolve(join(binDir, exeName(name)));
  const ready = unpackedCopy(name, archive);
  if (ready) return Promise.resolve(ready);
  let job = preparing.get(key);
  if (!job) {
    job = (async () => {
      const started = Date.now();
      const p = PACKED[key];
      const dictionary = p.dict ? readFileSync(await prepareBin(p.dict)) : undefined;
      const body = await decodeAsync(readFileSync(archive), decodeOptions(dictionary));
      // bin() may have unpacked it synchronously meanwhile.
      if (!existsSync(archive)) return join(binDir, exeName(name));
      return place(name, archive, body, started);
    })().finally(() => preparing.delete(key));
    preparing.set(key, job);
  }
  return job;
}

/** Path of a bundled tool ("ffmpeg", "gs/bin/gswin64c"). A packed tool is unpacked on first call. */
export function bin(name: string): string {
  const exe = join(binDir, exeName(name));
  const archive = packedArchive(name);
  if (!archive) return exe;
  return unpackSync(name, archive);
}

/** True when the tool is bundled (as an exe, or packed and unpacked on first use). */
export function hasBin(name: string): boolean {
  return existsSync(join(binDir, exeName(name))) || packedArchive(name) !== null;
}

export const page = (name: string) => join(distDir, 'renderer', name, 'index.html');
export const asset = (name: string) => join(distDir, 'assets', name);
