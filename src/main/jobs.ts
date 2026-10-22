// Turns a wheel choice into work: validates it against the real files, runs converters/tools
// with progress + cancel, and reports to the HUD.
import { shell, ipcMain, Notification } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, dirname, extname, join } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { conversionTargets, extOf, kindOfExt, toolsFor, type Kind } from '../shared/catalog';
import type { ConverterModule, Ctx } from './ops/types';
import { UserError } from './ops/types';
import { settings } from './settings';
import { hud } from './hud';
import { openTool } from './windows';
import { runAction } from './actions';
import { log } from './log';

import { CONVERTERS, archiveConverter, loadTools, undoLastRename } from './ops/registry';

// Tools whose outputs are the user's own files (renamed, or edited in place). Moving those to the
// Recycle Bin would be destructive, so they get their own undo, or none.
const TOOL_UNDO: Record<string, (options: any, outputs: string[]) => (() => Promise<void>) | null | undefined> = {
  // Undo exactly this job's rename (matched by its outputs), not whichever rename ran last.
  rename: (_options, outputs) => async () => {
    const r = await undoLastRename(outputs);
    if (!r.ok) throw new Error(r.message);
  },
  // With "replace original" on, metadata edits overwrite the source: no safe undo.
  metadata: () => (settings.get().replaceOriginal ? null : undefined),
};

// Tools that run immediately without a window.
const INSTANT_TOOLS = new Set(['extractArchive']);

function converterFor(kind: Kind, target: string): ConverterModule | undefined {
  // Zipping works for anything; the archive module owns it.
  if (['zip', 'tar', 'gz', '7z'].includes(target) && kind !== 'archive') return archiveConverter();
  return CONVERTERS.find((c) => c.kinds.includes(kind))?.load();
}

// ------------------------------------------------------------------ output paths

// Names handed out but perhaps not written yet. Files of one job convert in parallel, so photo.jpg
// and photo.png going to WebP would otherwise both get "photo.webp" and one would overwrite the other.
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

/** Set by watch folders: results go to this folder instead of the usual output setting. */
export const outputDirOverride = new AsyncLocalStorage<string>();
/** Set for automatic runs (watch folders): don't change "last used" or open Explorer. */
export const autoRun = new AsyncLocalStorage<boolean>();

function targetDir(input: string): string {
  const forced = outputDirOverride.getStore();
  if (forced) {
    mkdirSync(forced, { recursive: true });
    return forced;
  }
  const o = settings.get().output;
  if (o.mode === 'folder' && o.folder) {
    mkdirSync(o.folder, { recursive: true });
    return o.folder;
  }
  return dirname(input);
}

function stemOf(p: string) {
  const b = basename(p);
  // A folder's whole name is its stem: "photos.2024" zips to "photos.2024.zip", not "photos.zip".
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
    temps.forEach((d) => rmSync(d, { recursive: true, force: true }));
    claims.forEach((k) => claimed.delete(k));
  };
  return { ctx, cleanup };
}

// ------------------------------------------------------------------- the runner

interface JobSpec {
  title: string;
  inputs: string[];
  /** Run per input with this concurrency, or once for all inputs when `combined` is set. */
  perFile?: (input: string, ctx: Ctx) => Promise<string[]>;
  combined?: (ctx: Ctx) => Promise<string[]>;
  concurrency?: number;
  options?: any;
  /**
   * How Undo works for this job. Default (undefined): move the outputs to the Recycle Bin,
   * which is right for anything that creates new files. Return a function for a custom undo,
   * or null when the job changed files in place and can't be undone safely.
   */
  undo?: (outputs: string[]) => (() => Promise<void>) | null | undefined;
}

export async function runJob(spec: JobSpec): Promise<string[]> {
  const ac = new AbortController();
  const job = hud.start(spec.title, spec.inputs.length, () => ac.abort());
  const outputs: string[] = [];
  const errors: string[] = [];
  const frac = new Array(spec.inputs.length).fill(0);
  const push = () => job.progress(frac.reduce((a, b) => a + b, 0) / Math.max(1, frac.length));

  try {
    if (spec.combined) {
      const { ctx, cleanup } = makeCtx(ac.signal, (f, note) => job.progress(f, note), spec.options);
      try {
        outputs.push(...(await spec.combined(ctx)));
      } finally {
        cleanup();
      }
    } else if (spec.perFile) {
      let next = 0;
      const worker = async () => {
        while (next < spec.inputs.length && !ac.signal.aborted) {
          const i = next++;
          const input = spec.inputs[i];
          const { ctx, cleanup } = makeCtx(
            ac.signal,
            (f, note) => {
              frac[i] = Math.min(1, Math.max(0, f));
              push();
              if (note) job.progress(undefined, note);
            },
            spec.options,
          );
          try {
            outputs.push(...(await spec.perFile!(input, ctx)));
          } catch (e: any) {
            if (ac.signal.aborted) break;
            log('file failed', input, e);
            errors.push(`${basename(input)}: ${friendly(e)}`);
          } finally {
            frac[i] = 1;
            push();
            cleanup();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(spec.concurrency ?? 1, spec.inputs.length)) }, worker));
    }
    if (ac.signal.aborted) {
      job.cancelled();
      return outputs;
    }
    if (errors.length && !outputs.length) job.failed(errors.join('\n'));
    else job.done(outputs, errors, spec.undo?.(outputs));
    if (outputs.length && settings.get().revealWhenDone && !autoRun.getStore()) shell.showItemInFolder(outputs[0]);
    return outputs;
  } catch (e: any) {
    if (ac.signal.aborted) job.cancelled();
    else {
      log('job failed', spec.title, e);
      job.failed(friendly(e));
    }
    return outputs;
  }
}

// Raw messages from FFmpeg, libvips, 7-Zip, Ghostscript and Node, translated into what to do next.
// First match wins; keep the most specific patterns at the top.
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
  [/unsupported image format|Input file is missing|VipsForeignLoad|Input buffer contains unsupported/i, "This image format or file can't be read. It may be damaged, or not really an image."],
  [/pixel limit|exceeds pixel limit|too large/i, 'The image is too large to process. Resize it with Compress first.'],
  [/Can not open the file as archive|Unexpected end of archive|Headers Error|Data Error/i, 'The archive is damaged or incomplete.'],
  [/Unrecoverable error|ghostscript|gswin64c/i, "The PDF couldn't be processed. It may be damaged. Try Organize to resave it first."],
  [/ETIMEDOUT|ENOTFOUND|ECONNRESET|getaddrinfo|network/i, "Orange couldn't reach the internet to download a component. Check your connection and try again."],
  [/out of memory|bad_alloc|Cannot allocate memory|ENOMEM/i, 'Your PC ran out of memory for this file. Close other apps, or process fewer files at once.'],
];

function friendly(e: any): string {
  if (e instanceof UserError) return e.message;
  const m = String(e?.message ?? e);
  for (const [re, hint] of ERROR_HINTS) if (re.test(m)) return hint;
  return m.length > 220 ? m.slice(0, 220) + '…' : m;
}

/** Remember the last slice chosen for a file type so the wheel can offer it first next time. */
function rememberChoice(itemId: string, exts: string[]) {
  if (autoRun.getStore() || itemId.startsWith('action:') || new Set(exts).size !== 1 || !exts[0]) return;
  const recents = { ...settings.get().recents, [exts[0]]: itemId };
  settings.set({ recents });
}

// --------------------------------------------------------------- entry points

const CPU = Math.max(1, cpus().length);

export async function runChoice(itemId: string, paths: string[]) {
  paths = paths.filter((p) => existsSync(p));
  if (!paths.length) return;
  const [kind, id] = itemId.includes(':') ? (itemId.split(/:(.*)/s) as [string, string]) : ['to', itemId];
  log('choice', itemId, paths.length);

  if (kind === 'action') return runAction(id, paths);

  const exts = paths.filter((p) => !isDir(p)).map(extOf);
  const hasFolder = paths.some(isDir);
  rememberChoice(itemId, exts);

  if (kind === 'preset') {
    const preset = settings.get().presets.find((p) => p.id === id);
    if (!preset) return hud.notice('That preset no longer exists.');
    // Same rule as the wheel and watch folders: the tool fits, and so do the kinds it was saved for.
    const kinds = new Set<string>(exts.map(kindOfExt));
    if (hasFolder) kinds.add('folder');
    const ok = toolsFor(exts, hasFolder).some((t) => t.id === preset.tool) && [...kinds].every((k) => preset.kinds.includes(k));
    if (!ok) return hud.notice(`The "${preset.name}" preset doesn't work with ${describe(paths)}.`);
    return runTool(preset.tool, paths, preset.options, preset.name);
  }

  if (kind === 'tool') {
    const ok = toolsFor(exts, hasFolder).some((t) => t.id === id);
    if (!ok) return hud.notice(`That tool doesn't work with ${describe(paths)}.`);
    if (INSTANT_TOOLS.has(id)) return runTool(id, paths, undefined);
    return openTool(id, paths);
  }

  // Conversion. The wheel guessed from MIME types; trust the real extensions now.
  const target = id; // "png" | "extract"
  const valid = hasFolder ? ['zip'] : conversionTargets(exts).map((t) => (t.id === 'extract' ? 'extract' : t.ext));
  if (!valid.includes(target)) return hud.notice(`Can't convert ${describe(paths)} to ${target.toUpperCase()}.`);

  // Folders and mixed selections become one archive.
  if ((hasFolder || new Set(exts.map(kindOfExt)).size > 1) && ['zip', 'tar', 'gz', '7z'].includes(target)) {
    return runJob({
      title: `Compressing ${paths.length === 1 ? basename(paths[0]) : `${paths.length} items`}`,
      inputs: paths,
      combined: (ctx) => archiveConverter().convert(paths.join('\n'), target, ctx),
    });
  }

  const k = kindOfExt(exts[0]);
  const conv = converterFor(k, target);
  if (!conv) return hud.notice('Nothing can convert that yet.');
  const heavy = k === 'video' || k === 'audio';
  const office = ['document', 'slides', 'spreadsheet', 'ebook', 'pdf'].includes(k);
  return runJob({
    title: target === 'extract' ? `Extracting ${label(paths)}` : `Converting ${label(paths)} to ${target.toUpperCase()}`,
    inputs: paths,
    perFile: (input, ctx) => conv.convert(input, target, ctx),
    concurrency: heavy ? Math.max(1, Math.floor(CPU / 4)) : office ? 1 : Math.max(2, CPU - 1),
  });
}

export function runTool(id: string, paths: string[], options: any, title?: string): Promise<string[]> {
  const fn = loadTools()[id];
  if (!fn) {
    hud.notice('This tool is not available yet.');
    return Promise.resolve([]);
  }
  const def = toolsFor(paths.map(extOf), paths.some(isDir)).find((t) => t.id === id);
  return runJob({
    title: `${title ?? def?.label ?? id} · ${label(paths)}`,
    inputs: paths,
    options,
    combined: (ctx) => fn(paths, ctx),
    undo: (outputs) => TOOL_UNDO[id]?.(options, outputs),
  });
}

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function label(paths: string[]) {
  return paths.length === 1 ? basename(paths[0]) : `${paths.length} files`;
}

function describe(paths: string[]) {
  return paths.length === 1 ? basename(paths[0]) : `these ${paths.length} files`;
}

ipcMain.handle('tool:run', (_e, id: string, paths: string[], options: any) => runTool(id, paths, options));
ipcMain.handle('file:reveal', (_e, p: string) => shell.showItemInFolder(p));

export function notifyDone(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, silent: !settings.get().sounds }).show();
}
