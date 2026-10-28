// Orange 1.x's job runner (main/jobs.ts), for jobs that run in the tool window that started them:
// output paths that never overwrite, temp folders, progress + Cancel in the HUD, and errors
// translated into what to do next.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { shell } from 'electron';
import { toolsFor, extOf } from '../shared/catalog';
import type { Ctx, ToolFn } from './ops/types';
import { UserError } from './ops/types';
import { settings } from './settings';
import { hud } from './hud';
import { log } from './log';

// Names handed out but perhaps not written yet (files of one job convert in parallel).
const claimed = new Set<string>();

function uniquePath(p: string, claims: string[]): string {
  const free = (c: string) => !existsSync(c) && !claimed.has(c.toLowerCase());
  let c = p;
  if (!free(c)) {
    const ext = extname(p);
    const stem = p.slice(0, p.length - ext.length);
    for (let i = 2; !free((c = `${stem} ${i}${ext}`)); i++);
  }
  claimed.add(c.toLowerCase());
  claims.push(c.toLowerCase());
  return c;
}

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function targetDir(input: string): string {
  const o = settings.get().output;
  if (o.mode === 'folder' && o.folder) {
    mkdirSync(o.folder, { recursive: true });
    return o.folder;
  }
  return dirname(input);
}

function stemOf(p: string) {
  const b = basename(p);
  if (isDir(p)) return b;
  const e = extname(b);
  return e ? b.slice(0, -e.length) : b;
}

export function makeCtx(signal: AbortSignal, onProgress: (f: number, note?: string) => void, options?: any) {
  const temps: string[] = [];
  const claims: string[] = [];
  const ctx: Ctx = {
    signal,
    options,
    progress: onProgress,
    out(input, ext, suffix = '') {
      return uniquePath(join(targetDir(input), `${stemOf(input)}${suffix}${ext ? '.' + ext : ''}`), claims);
    },
    outDir(input, name) {
      const d = uniquePath(join(targetDir(input), name ?? stemOf(input)), claims);
      mkdirSync(d, { recursive: true });
      return d;
    },
    tmp() {
      const d = mkdtempSync(join(tmpdir(), 'orange-'));
      temps.push(d);
      return d;
    },
  };
  const cleanup = () => {
    temps.forEach((d) => {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* still in use: the OS cleans temp */
      }
    });
    claims.forEach((k) => claimed.delete(k));
  };
  return { ctx, cleanup };
}

// Raw messages from FFmpeg, ImageMagick, 7-Zip, Ghostscript, translated into what to do next.
const ERROR_HINTS: [RegExp, string][] = [
  [/spawn .*ENOENT|is not recognized as an internal/i, 'A part of Orange is missing. Reinstall Orange to restore it.'],
  [/ENOSPC|No space left|There is not enough space/i, 'The disk is full. Free up some space and try again.'],
  [/EBUSY|being used by another process|resource busy/i, 'The file is open in another app. Close it and try again.'],
  [/EPERM|EACCES|Access is denied|Permission denied|read-only/i, "Orange can't write there. Choose another output folder in Settings → Saving, or check the folder's permissions."],
  [/ENAMETOOLONG|path too long/i, 'The file path is too long for Windows. Move the file to a shorter folder path.'],
  [/Wrong password|Can not open encrypted archive|password is incorrect|Invalid password/i, 'The password is wrong.'],
  [/encrypted|password-protected|Encrypted PDF/i, 'The file is password-protected. Use Unlock on the Tools wheel first.'],
  [/Invalid data found when processing input|moov atom not found|could not find codec parameters|End of file/i, "This media file looks damaged or incomplete, so it can't be read. If it's still downloading or copying, wait for it to finish."],
  [/does not contain any stream|Output file #0 does not contain any stream|matches no streams/i, "There's nothing to convert in this file: it has no usable audio or video track."],
  [/Unknown encoder|Encoder not found|not compiled with/i, "This format isn't supported by the bundled video engine. Pick another format."],
  [/height not divisible by 2|width not divisible by 2/i, "The video's width or height is an odd number, which this format can't store. Crop or resize it by a pixel first."],
  [/unsupported image format|Input file is missing|no decode delegate|improper image header|VipsForeignLoad|Input buffer contains unsupported/i, "This image format or file can't be read. It may be damaged, or not really an image."],
  [/pixel limit|exceeds pixel limit|too large/i, 'The image is too large to process. Resize it with Compress first.'],
  [/Can not open the file as archive|Unexpected end of archive|Headers Error|Data Error/i, 'The archive is damaged or incomplete.'],
  [/Unrecoverable error|ghostscript|gswin64c/i, "The PDF couldn't be processed. It may be damaged. Try Organize to resave it first."],
  [/ETIMEDOUT|ENOTFOUND|ECONNRESET|getaddrinfo|network|Failed to fetch/i, "Orange couldn't reach the internet to download a component. Check your connection and try again."],
  [/out of memory|bad_alloc|Cannot allocate memory|ENOMEM/i, 'Your PC ran out of memory for this file. Close other apps, or process fewer files at once.'],
];

export function friendly(e: any): string {
  if (e instanceof UserError || e?.name === 'UserError') return e.message;
  const m = String(e?.message ?? e);
  for (const [re, hint] of ERROR_HINTS) if (re.test(m)) return hint;
  return m.length > 220 ? m.slice(0, 220) + '…' : m;
}

function label(paths: string[]) {
  return paths.length === 1 ? basename(paths[0]) : `${paths.length} files`;
}

/** Jobs running in this window (it parks out of sight instead of closing until they finish). */
export let running = 0;
const idle: (() => void)[] = [];
export const whenIdle = () => (running ? new Promise<void>((r) => idle.push(r)) : Promise.resolve());
/** Counts a job that hasn't reached runTool yet (e.g. waiting for a preview) as running. */
export function holdOpen(): () => void {
  running++;
  return () => {
    running--;
    if (!running) idle.splice(0).forEach((f) => f());
  };
}

/** Jobs in flight, so the test runner can cancel them as the progress panel's Cancel does. */
const active = new Set<AbortController>();
(window as unknown as { __cancelJobs: () => void }).__cancelJobs = () => active.forEach((a) => a.abort());

/** What the test runner reads back: how each job in this window ended (see tools.rs, tool:job). */
function record(rec: { tool: string; state: 'done' | 'failed' | 'cancelled'; outputs: string[]; message?: string }) {
  const w = window as unknown as { __orangeJobs?: unknown[]; orange: { args?: { test?: boolean }; send(ch: string, ...a: unknown[]): void } };
  (w.__orangeJobs ??= []).push(rec);
  if (w.orange.args?.test) w.orange.send('tool:job', rec);
}

/** Runs a tool on `paths` with HUD progress; resolves with the created files. Mirrors runTool. */
export async function runTool(fn: ToolFn, id: string, paths: string[], options: any, title?: string): Promise<string[]> {
  const def = toolsFor(paths.map(extOf), paths.some(isDir)).find((t) => t.id === id);
  const ac = new AbortController();
  active.add(ac);
  const job = hud.start(`${title ?? def?.label ?? id} · ${label(paths)}`, paths.length, () => ac.abort());
  running++;
  const { ctx, cleanup } = makeCtx(ac.signal, (f, note) => job.progress(f, note), options);
  const outputs: string[] = [];
  try {
    outputs.push(...(await fn(paths, ctx)));
    if (ac.signal.aborted) {
      record({ tool: id, state: 'cancelled', outputs });
      await job.cancelled();
    } else {
      record({ tool: id, state: 'done', outputs });
      await job.done(outputs, []);
      if (outputs.length && settings.get().revealWhenDone) shell.showItemInFolder(outputs[0]);
    }
    return outputs;
  } catch (e: any) {
    if (ac.signal.aborted) {
      record({ tool: id, state: 'cancelled', outputs });
      await job.cancelled();
    } else {
      log('job failed', id, e);
      record({ tool: id, state: 'failed', outputs, message: friendly(e) });
      await job.failed(friendly(e));
    }
    return outputs;
  } finally {
    active.delete(ac);
    cleanup();
    running--;
    if (!running) idle.splice(0).forEach((f) => f());
  }
}

export { UserError };
