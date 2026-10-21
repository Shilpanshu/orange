// Watch folders: new files that land in a watched folder are converted (or run through an
// instant tool or a preset) automatically.
//
// A file is only picked up once it is finished: its size and modified time must hold still
// across two checks and it must not be locked by the program writing it. Browser partials
// (.crdownload, .part, .tmp…) are ignored; the finished file shows up under its final name.
// Files that were already there when watching started are left alone, and everything Orange
// itself creates is remembered so a result never triggers another run.
import { readdirSync, statSync, existsSync, openSync, closeSync, watch as fsWatch, type FSWatcher, type Stats } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { shell } from 'electron';
import { conversionTargets, kindOfExt, toolsFor } from '../shared/catalog';
import { settings, type WatchFolder, type Preset } from './settings';
import * as jobs from './jobs';
import { runPreset } from './presets';
import { log } from './log';

// Tools that run without a window, so they can run unattended. Mirrors INSTANT_TOOLS in jobs.ts.
const INSTANT_TOOLS = new Set(['extractArchive']);

// Written by browsers and download managers while a file is still arriving.
const PARTIAL_EXTS = new Set(['crdownload', 'part', 'partial', 'tmp', 'temp', 'download', 'opdownload', 'filepart', 'crswap', '!ut', '!qb', 'aria2', 'dtapart', 'downloading']);
const IGNORED_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

export interface WatchDeps {
  runChoice: (itemId: string, paths: string[]) => Promise<unknown>;
  runPreset: (id: string, paths: string[]) => Promise<string[]>;
  presets: () => Preset[];
  folders: () => WatchFolder[];
  trash: (path: string) => Promise<void>;
  /** Runs fn with job outputs redirected to dir (see the jobs.ts hook). Undefined = not supported. */
  withOutputDir?: <T>(dir: string, fn: () => T) => T;
  log: (...args: unknown[]) => void;
  /** Gap between size checks while a file settles. */
  settleMs?: number;
  /** Safety-net directory rescan, for events fs.watch misses (network drives, bursts). */
  rescanMs?: number;
}

const keyOf = (p: string) => resolve(p).toLowerCase();
const extOfName = (n: string) => extname(n).slice(1).toLowerCase();
const stemOf = (p: string) => {
  const b = basename(p);
  const e = extname(b);
  return (e ? b.slice(0, -e.length) : b).toLowerCase();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalises user-typed extensions: ".JPG", "*.jpg", "jpg" → "jpg". */
export function normalizeExts(exts: string[]): string[] {
  return [...new Set(exts.map((e) => e.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean))];
}

/** Whether the action can run on a file with this extension. */
export function actionFits(action: string, ext: string, presets: Preset[]): boolean {
  const [kind, id] = action.split(/:(.*)/s) as [string, string | undefined];
  if (!id) return false;
  if (kind === 'to') return conversionTargets([ext]).some((t) => (t.id === 'extract' ? id === 'extract' : t.ext === id));
  if (kind === 'tool') return INSTANT_TOOLS.has(id) && toolsFor([ext]).some((t) => t.id === id);
  if (kind === 'preset') {
    const p = presets.find((x) => x.id === id);
    return !!p && toolsFor([ext]).some((t) => t.id === p.tool) && p.kinds.includes(kindOfExt(ext));
  }
  return false;
}

/** Only unattended actions are allowed: conversions, instant tools and presets. */
export function actionAllowed(action: string): boolean {
  return /^to:./.test(action) || /^preset:./.test(action) || (action.startsWith('tool:') && INSTANT_TOOLS.has(action.slice(5)));
}

function isLocked(p: string, st: Stats): boolean {
  // Asking for write access fails while another program holds the file without write sharing
  // (Explorer copies, most downloaders, Office saves).
  try {
    closeSync(openSync(p, 'r+'));
    return false;
  } catch (e: any) {
    if ((e?.code === 'EPERM' || e?.code === 'EACCES') && (st.mode & 0o200) === 0) return false; // read-only file
    return e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES';
  }
}

class FolderWatch {
  private known = new Set<string>(); // lower-case names already seen in the folder
  private settling = new Set<string>();
  private watcher?: FSWatcher;
  private rescanTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    public wf: WatchFolder,
    private svc: WatchService,
  ) {}

  start() {
    try {
      for (const n of readdirSync(this.wf.folder)) this.known.add(n.toLowerCase());
    } catch (e) {
      this.svc.deps.log('watch: cannot read folder', this.wf.folder, e);
      return;
    }
    try {
      this.watcher = fsWatch(this.wf.folder, { persistent: false }, (_ev, name) => {
        if (name) this.onName(String(name));
        else this.rescan();
      });
      this.watcher.on('error', (e) => {
        this.svc.deps.log('watch: watcher error', this.wf.folder, e);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch (e) {
      this.svc.deps.log('watch: cannot watch folder', this.wf.folder, e);
    }
    this.rescanTimer = setInterval(() => this.rescan(), this.svc.rescanMs);
    this.rescanTimer.unref?.();
    this.svc.deps.log('watch: watching', this.wf.folder, this.wf.action);
  }

  stop() {
    this.stopped = true;
    this.watcher?.close();
    clearInterval(this.rescanTimer);
  }

  private rescan() {
    if (this.stopped) return;
    let names: string[];
    try {
      names = readdirSync(this.wf.folder);
    } catch {
      return;
    }
    const present = new Set(names.map((n) => n.toLowerCase()));
    for (const k of [...this.known]) if (!present.has(k)) this.known.delete(k);
    for (const n of names) if (!this.known.has(n.toLowerCase())) this.onName(n);
  }

  private onName(name: string) {
    if (this.stopped || name.includes('\\') || name.includes('/')) return;
    const full = join(this.wf.folder, name);
    const key = name.toLowerCase();
    if (!existsSync(full)) {
      // Deleted or renamed away: a new file with this name later counts as new again.
      this.known.delete(key);
      return;
    }
    if (this.known.has(key)) return;
    this.known.add(key);
    if (!this.candidate(name, full)) return;
    void this.settle(full);
  }

  private candidate(name: string, full: string): boolean {
    const lower = name.toLowerCase();
    if (IGNORED_NAMES.has(lower) || lower.startsWith('~$') || lower.startsWith('.')) return false;
    const ext = extOfName(name);
    if (!ext || PARTIAL_EXTS.has(ext)) return false;
    // Exact outputs only here; the looser name rule is applied once the file has settled,
    // when the job that may have made it has finished.
    if (this.svc.isOwn(full, false)) return false;
    const exts = normalizeExts(this.wf.exts ?? []);
    if (exts.length && !exts.includes(ext)) return false;
    return actionFits(this.wf.action, ext, this.svc.deps.presets());
  }

  /** Waits until the file stops changing and is not locked, then queues it. */
  private async settle(full: string) {
    const key = keyOf(full);
    if (this.settling.has(key)) return;
    this.settling.add(key);
    try {
      let last = '';
      let emptySince = Date.now();
      for (;;) {
        await sleep(this.svc.settleMs);
        if (this.stopped) return;
        let st: Stats;
        try {
          st = statSync(full);
        } catch {
          return; // gone (renamed or deleted)
        }
        if (!st.isFile()) return;
        if (st.size === 0) {
          // Placeholders (Firefox) are filled in later; give up on files that stay empty.
          if (Date.now() - emptySince > 10 * 60_000) return;
          last = '';
          continue;
        }
        emptySince = Date.now();
        const sig = `${st.size}:${st.mtimeMs}`;
        if (sig === last && !isLocked(full, st)) break;
        last = sig;
      }
      this.svc.enqueue(this, full);
    } finally {
      this.settling.delete(key);
    }
  }
}

export class WatchService {
  readonly settleMs: number;
  readonly rescanMs: number;
  private watches = new Map<string, FolderWatch>(); // by watch-folder id
  private own = new Set<string>(); // outputs Orange made (resolved, lower-case)
  /** Inputs whose outputs aren't known exactly: new files starting with their name are ours. */
  private inflight = new Map<string, { dir: string[]; stem: string; until: number }>();
  private queue: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(readonly deps: WatchDeps) {
    this.settleMs = deps.settleMs ?? 1000;
    this.rescanMs = deps.rescanMs ?? 15000;
  }

  start() {
    this.sync();
  }

  /** Applies the current watch-folder list, keeping watchers whose folder didn't change. */
  sync() {
    const wanted = new Map<string, WatchFolder>();
    for (const wf of this.deps.folders()) {
      if (!wf.enabled || !wf.folder || !actionAllowed(wf.action)) continue;
      try {
        if (!statSync(wf.folder).isDirectory()) continue;
      } catch {
        this.deps.log('watch: folder missing', wf.folder);
        continue;
      }
      wanted.set(wf.id, wf);
    }
    for (const [id, w] of this.watches) {
      const next = wanted.get(id);
      if (!next || keyOf(next.folder) !== keyOf(w.wf.folder)) {
        w.stop();
        this.watches.delete(id);
      } else {
        w.wf = next; // same folder: keep what it has seen, take the new settings
      }
    }
    for (const [id, wf] of wanted) {
      if (this.watches.has(id)) continue;
      const w = new FolderWatch(wf, this);
      this.watches.set(id, w);
      w.start();
    }
  }

  stop() {
    for (const w of this.watches.values()) w.stop();
    this.watches.clear();
  }

  get watching(): string[] {
    return [...this.watches.values()].map((w) => w.wf.folder);
  }

  isOwn(full: string, byName = true): boolean {
    const k = keyOf(full);
    if (this.own.has(k)) return true;
    if (!byName) return false;
    const now = Date.now();
    const name = basename(full).toLowerCase();
    const dir = keyOf(join(full, '..'));
    for (const [id, f] of this.inflight) {
      if (f.until < now) {
        this.inflight.delete(id);
        continue;
      }
      if (f.dir.includes(dir) && name.startsWith(f.stem)) return true;
    }
    return false;
  }

  markOwn(paths: string[]) {
    for (const p of paths) this.own.add(keyOf(p));
  }

  enqueue(w: FolderWatch, full: string) {
    this.queue = this.queue.then(() => this.process(w, full)).catch((e) => this.deps.log('watch: run failed', full, e));
  }

  private async process(w: FolderWatch, full: string) {
    const wf = w.wf;
    if (!existsSync(full) || this.isOwn(full)) return;
    // Settings may have changed while the file settled.
    if (!wf.enabled || !actionAllowed(wf.action)) return;
    const exts = normalizeExts(wf.exts ?? []);
    const ext = extOfName(full);
    if ((exts.length && !exts.includes(ext)) || !actionFits(wf.action, ext, this.deps.presets())) return;

    const outDir = wf.outFolder && this.deps.withOutputDir ? wf.outFolder : '';
    if (wf.outFolder && !this.deps.withOutputDir) this.deps.log('watch: output folder override unavailable; saving beside the file');
    const id = ++this.seq;
    const dirs = [keyOf(join(full, '..'))];
    if (outDir) dirs.push(keyOf(outDir));
    // Until we know the exact outputs, anything new named after this file is ours.
    this.inflight.set(String(id), { dir: dirs, stem: stemOf(full), until: Number.MAX_SAFE_INTEGER });
    this.deps.log('watch: running', wf.action, full);
    let outputs: string[] | null = null;
    try {
      const run = () => {
        if (wf.action.startsWith('preset:')) return this.deps.runPreset(wf.action.slice(7), [full]);
        return this.deps.runChoice(wf.action, [full]);
      };
      const res = await (outDir ? this.deps.withOutputDir!(outDir, run) : run());
      outputs = Array.isArray(res) ? (res as string[]) : null;
    } finally {
      if (outputs) {
        this.markOwn(outputs);
        this.inflight.delete(String(id));
      } else {
        // Outputs unknown: keep the name rule alive a little longer for late writes.
        const f = this.inflight.get(String(id));
        if (f) f.until = Date.now() + 5 * 60_000;
      }
    }
    if (wf.recycleOriginal) {
      const made = (outputs ?? []).filter((o) => keyOf(o) !== keyOf(full) && existsSync(o));
      if (!made.length) {
        this.deps.log('watch: keeping original, no confirmed output', full);
        return;
      }
      try {
        await this.deps.trash(full);
        this.deps.log('watch: recycled', full);
      } catch (e) {
        this.deps.log('watch: recycle failed', full, e);
      }
    }
  }
}

// ------------------------------------------------------------- app wiring

let service: WatchService | null = null;
let lastConfig = '';
let subscribed = false;

function defaultDeps(): WatchDeps {
  // Automatic runs don't touch "last used" slices or open Explorer (see jobs.autoRun).
  return {
    runChoice: (itemId, paths) => jobs.autoRun.run(true, () => jobs.runChoice(itemId, paths)),
    runPreset: (id, paths) => jobs.autoRun.run(true, () => runPreset(id, paths)),
    presets: () => settings.get().presets ?? [],
    folders: () => settings.get().watchFolders ?? [],
    trash: (p) => shell.trashItem(p),
    withOutputDir: (dir, fn) => jobs.outputDirOverride.run(dir, fn),
    log,
  };
}

export function startWatching() {
  if (!service) service = new WatchService(defaultDeps());
  lastConfig = JSON.stringify(settings.get().watchFolders ?? []);
  service.start();
  if (!subscribed) {
    subscribed = true;
    // Pick up edits from the settings page without extra wiring.
    settings.on('change', (s: { watchFolders?: WatchFolder[] }) => {
      const next = JSON.stringify(s.watchFolders ?? []);
      if (next !== lastConfig && service) restartWatching();
    });
  }
}

export function restartWatching() {
  lastConfig = JSON.stringify(settings.get().watchFolders ?? []);
  if (!service) return startWatching();
  service.sync();
}

export function stopWatching() {
  service?.stop();
}
