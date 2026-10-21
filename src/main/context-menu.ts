// Explorer right-click menu: an "Orange" submenu on files and folders with Convert…, Tools… and
// Actions…. Registered per user under HKCU\Software\Classes (no administrator rights). On
// Windows 11 it sits under "Show more options".
//
// Each entry runs `Orange.exe --wheel=<kind> "<path>"`. Explorer starts one process per selected
// file, so launches that arrive close together are gathered into one wheel.
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WheelKind } from '../shared/catalog';
import { log } from './log';

const ROOT = 'HKEY_CURRENT_USER\\Software\\Classes';
// Files of every type, and folders.
const TARGETS = ['*', 'Directory'];
const KEY = 'Orange';
const ENTRIES: { kind: WheelKind; label: string }[] = [
  { kind: 'convert', label: 'Convert…' },
  { kind: 'tools', label: 'Tools…' },
  { kind: 'actions', label: 'Actions…' },
];

export interface Launcher {
  /** Executable Explorer runs. */
  exe: string;
  /** Arguments placed before ours (in development: the app folder for electron.exe). */
  pre: string[];
  /** Menu icon ("path,index" or an .ico path). */
  icon: string;
}

/** The command this copy of Orange should register: the installed exe, or electron + app path in development. */
export function currentLauncher(): Launcher {
  if (app.isPackaged) return { exe: process.execPath, pre: [], icon: `${process.execPath},0` };
  const ico = resolve(app.getAppPath(), 'assets', 'icon.ico');
  return { exe: process.execPath, pre: [app.getAppPath()], icon: existsSync(ico) ? ico : `${process.execPath},0` };
}

const q = (s: string) => `"${s}"`;
// .reg string values escape backslashes and quotes.
const regStr = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Builds the .reg file that adds (or, with launcher = null, removes) the menu under `root`. */
export function buildRegFile(launcher: Launcher | null, root = ROOT): string {
  const lines = ['Windows Registry Editor Version 5.00', ''];
  for (const t of TARGETS) {
    const base = `${root}\\${t}\\shell\\${KEY}`;
    // Always delete first so stale entries from an older version never linger.
    lines.push(`[-${base}]`, '');
    if (!launcher) continue;
    lines.push(`[${base}]`, `"MUIVerb"=${regStr('Orange')}`, `"Icon"=${regStr(launcher.icon)}`, `"SubCommands"=""`, '');
    ENTRIES.forEach((e, i) => {
      // Numeric prefixes keep Explorer's alphabetical order matching ours.
      const sub = `${base}\\shell\\${i + 1}${e.kind}`;
      const cmd = [q(launcher.exe), ...launcher.pre.map(q), `--wheel=${e.kind}`, '"%1"'].join(' ');
      // Player: one launch per item and no 15-item limit (the default model hides the verb past 15).
      lines.push(`[${sub}]`, `"MUIVerb"=${regStr(e.label)}`, `"MultiSelectModel"="Player"`, '');
      lines.push(`[${sub}\\command]`, `@=${regStr(cmd)}`, '');
    });
  }
  return lines.join('\r\n');
}

function regImport(content: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orange-reg-'));
  const file = join(dir, 'menu.reg');
  // reg.exe reads UTF-16LE with a BOM, which keeps the "…" in the labels intact.
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
  return new Promise<void>((res, rej) => {
    execFile('reg.exe', ['import', file], { windowsHide: true }, (err, _out, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) rej(new Error(`reg import failed: ${String(stderr || err.message).trim()}`));
      else res();
    });
  });
}

/**
 * Adds or removes the Explorer menu. Idempotent: enabling rewrites the keys for the current
 * executable, disabling removes them (no error when they are already gone).
 * `root` and `launcher` exist for tests; callers normally pass only `enabled`.
 */
export async function registerContextMenu(enabled: boolean, opts: { root?: string; launcher?: Launcher } = {}): Promise<void> {
  if (process.platform !== 'win32') return;
  const launcher = enabled ? (opts.launcher ?? currentLauncher()) : null;
  try {
    await regImport(buildRegFile(launcher, opts.root));
    log('context menu', enabled ? `registered for ${launcher!.exe}` : 'removed');
  } catch (e) {
    log('context menu update failed', e);
    throw e;
  }
}

// ------------------------------------------------------------ launches

const WHEEL_KINDS = new Set<WheelKind>(['convert', 'tools', 'actions']);
/** Quiet time that ends a burst of launches from one multi-selection. */
const GATHER_MS = 150;
/** Upper bound so a huge selection still opens promptly. */
const GATHER_MAX_MS = 1500;

let pending: { wheel: WheelKind; paths: string[]; seen: Set<string>; first: number; timer?: NodeJS.Timeout } | null = null;

/** Extracts `--wheel=<kind>` and the file paths from a command line. Null when it isn't a menu launch. */
export function parseArgv(argv: string[], skip: string[] = []): { wheel: WheelKind; paths: string[] } | null {
  let wheel: WheelKind | null = null;
  const paths: string[] = [];
  const skipKeys = new Set(skip.map((s) => resolve(s).toLowerCase()));
  // argv[0] is the executable. Chromium may add its own switches anywhere, so read by shape.
  for (const a of argv.slice(1)) {
    const m = /^--wheel=(\w+)$/i.exec(a);
    if (m) {
      const k = m[1].toLowerCase() as WheelKind;
      if (WHEEL_KINDS.has(k)) wheel = k;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(a)) continue; // absolute paths only
    if (skipKeys.has(resolve(a).toLowerCase())) continue;
    paths.push(a);
  }
  return wheel ? { wheel, paths } : null;
}

/**
 * Handles a command line from first launch or `second-instance`. Returns true when it was a
 * right-click launch (the caller should then not open Settings). The wheel opens once the
 * launches from one multi-selection have all arrived.
 */
export function handleArgv(argv: string[], open: (wheel: WheelKind, paths: string[]) => void, opts: { skip?: string[]; exists?: (p: string) => boolean } = {}): boolean {
  const skip = opts.skip ?? (app?.isPackaged === false ? [app.getAppPath()] : []);
  const parsed = parseArgv(argv, skip);
  if (!parsed) return false;
  const exists =
    opts.exists ??
    ((p: string) => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    });
  const now = Date.now();
  if (!pending) pending = { wheel: parsed.wheel, paths: [], seen: new Set(), first: now };
  // The last kind wins if they differ (they come from one click, so they normally don't).
  pending.wheel = parsed.wheel;
  for (const p of parsed.paths) {
    const k = resolve(p).toLowerCase();
    if (pending.seen.has(k) || !exists(p)) continue;
    pending.seen.add(k);
    pending.paths.push(p);
  }
  clearTimeout(pending.timer);
  const wait = Math.max(0, Math.min(GATHER_MS, pending.first + GATHER_MAX_MS - now));
  pending.timer = setTimeout(() => {
    const done = pending;
    pending = null;
    if (done && done.paths.length) open(done.wheel, done.paths);
  }, wait);
  return true;
}
