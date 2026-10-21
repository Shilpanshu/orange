// Turns a wheel choice into work: validates it against the real files, runs converters/tools
// with progress + cancel, and reports to the HUD.
import { shell, ipcMain, Notification } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { conversionTargets, extOf, kindOfExt, toolsFor, type Kind } from '../shared/catalog';
import type { ConverterModule, Ctx, ToolFn } from './ops/types';
import { UserError } from './ops/types';
import { settings } from './settings';
import { hud } from './hud';
import { openTool } from './windows';
import { runAction } from './actions';
import { log } from './log';

import { converter as imageConv } from './ops/convert-image';
import { converter as avConv } from './ops/convert-av';
import { converter as docConv } from './ops/convert-docs';
import { converter as archiveConv } from './ops/convert-archive';
import { converter as subtitleConv } from './ops/convert-subtitle';
import { tools as imageTools } from './ops/tools-image';
import { tools as avTools } from './ops/tools-av';
import { tools as pdfTools } from './ops/tools-pdf';
import { tools as fileTools } from './ops/tools-file';

const CONVERTERS: ConverterModule[] = [imageConv, avConv, docConv, archiveConv, subtitleConv];
const TOOLS: Record<string, ToolFn> = { ...imageTools, ...avTools, ...pdfTools, ...fileTools };

// Tools that run immediately without a window.
const INSTANT_TOOLS = new Set(['extractArchive']);

function converterFor(kind: Kind, target: string): ConverterModule | undefined {
  // Zipping works for anything; the archive module owns it.
  if (['zip', 'tar', 'gz', '7z'].includes(target) && kind !== 'archive') return archiveConv;
  return CONVERTERS.find((c) => c.kinds.includes(kind));
}

// ------------------------------------------------------------------ output paths

function uniquePath(p: string): string {
  if (!existsSync(p)) return p;
  const ext = extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) {
    const c = `${stem} ${i}${ext}`;
    if (!existsSync(c)) return c;
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
  const e = extname(b);
  return e ? b.slice(0, -e.length) : b;
}

export function makeCtx(signal: AbortSignal, onProgress: (f: number, note?: string) => void, options?: any) {
  const temps: string[] = [];
  const ctx: Ctx = {
    signal,
    options,
    progress: onProgress,
    out(input, ext, suffix = '') {
      return uniquePath(join(targetDir(input), `${stemOf(input)}${suffix}${ext ? '.' + ext : ''}`));
    },
    outDir(input, name) {
      const d = uniquePath(join(targetDir(input), name ?? stemOf(input)));
      mkdirSync(d, { recursive: true });
      return d;
    },
    tmp() {
      const d = mkdtempSync(join(tmpdir(), 'orange-'));
      temps.push(d);
      return d;
    },
  };
  const cleanup = () => temps.forEach((d) => rmSync(d, { recursive: true, force: true }));
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
    else job.done(outputs, errors);
    if (outputs.length && settings.get().revealWhenDone) shell.showItemInFolder(outputs[0]);
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

function friendly(e: any): string {
  if (e instanceof UserError) return e.message;
  const m = String(e?.message ?? e);
  if (/ENOENT/.test(m) && /spawn/.test(m)) return 'A required component is missing. Reinstall Orange.';
  if (/EBUSY|EPERM/.test(m)) return 'The file is in use or read-only.';
  return m.length > 220 ? m.slice(0, 220) + '…' : m;
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

  if (kind === 'tool') {
    const ok = toolsFor(exts, hasFolder).some((t) => t.id === id);
    if (!ok) return hud.notice(`That tool doesn't work with ${describe(paths)}.`);
    if (INSTANT_TOOLS.has(id)) return void runTool(id, paths, undefined);
    return openTool(id, paths);
  }

  // Conversion. The wheel guessed from MIME types; trust the real extensions now.
  const target = id; // "png" | "extract"
  const valid = hasFolder ? ['zip'] : conversionTargets(exts).map((t) => (t.id === 'extract' ? 'extract' : t.ext));
  if (!valid.includes(target)) return hud.notice(`Can't convert ${describe(paths)} to ${target.toUpperCase()}.`);

  // Folders and mixed selections become one archive.
  if ((hasFolder || new Set(exts.map(kindOfExt)).size > 1) && ['zip', 'tar', 'gz', '7z'].includes(target)) {
    return void runJob({
      title: `Compressing ${paths.length === 1 ? basename(paths[0]) : `${paths.length} items`}`,
      inputs: paths,
      combined: (ctx) => archiveConv.convert(paths.join('\n'), target, ctx),
    });
  }

  const k = kindOfExt(exts[0]);
  const conv = converterFor(k, target);
  if (!conv) return hud.notice('Nothing can convert that yet.');
  const heavy = k === 'video' || k === 'audio';
  const office = ['document', 'slides', 'spreadsheet', 'ebook', 'pdf'].includes(k);
  void runJob({
    title: target === 'extract' ? `Extracting ${label(paths)}` : `Converting ${label(paths)} to ${target.toUpperCase()}`,
    inputs: paths,
    perFile: (input, ctx) => conv.convert(input, target, ctx),
    concurrency: heavy ? Math.max(1, Math.floor(CPU / 4)) : office ? 1 : Math.max(2, CPU - 1),
  });
}

export function runTool(id: string, paths: string[], options: any): Promise<string[]> {
  const fn = TOOLS[id];
  if (!fn) {
    hud.notice('This tool is not available yet.');
    return Promise.resolve([]);
  }
  const def = toolsFor(paths.map(extOf), paths.some(isDir)).find((t) => t.id === id);
  return runJob({
    title: `${def?.label ?? id} · ${label(paths)}`,
    inputs: paths,
    options,
    combined: (ctx) => fn(paths, ctx),
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
ipcMain.handle('file:open', (_e, p: string) => shell.openPath(p));

export function notifyDone(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, silent: !settings.get().sounds }).show();
}
