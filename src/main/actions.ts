// Actions wheel: share, shelf, copy, move, copy path, terminal. Quick things that report through
// a HUD notice instead of opening a window.
import { clipboard, dialog, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { callHelper } from './helper';
import { hud } from './hud';
import { settings } from './settings';
import { shelf } from './shelf';
import { log } from './log';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const what = (paths: string[]) => (paths.length === 1 ? basename(paths[0]) : plural(paths.length, 'item'));

export async function runAction(id: string, paths: string[]) {
  paths = paths.filter((p) => existsSync(p));
  if (!paths.length) return;
  try {
    switch (id) {
      case 'share':
        return await share(paths);
      case 'float':
        return shelf.add(paths);
      case 'copy':
        return await copy(paths);
      case 'move':
        return await move(paths);
      case 'copyPath':
        clipboard.writeText(paths.join('\r\n'));
        return hud.notice(paths.length === 1 ? 'Copied the path' : `Copied ${plural(paths.length, 'path')}`);
      case 'terminal':
        return openTerminal(paths[0]);
      default:
        hud.notice('That action is not available.');
    }
  } catch (e: any) {
    log('action failed', id, e);
    hud.notice(String(e?.message ?? e));
  }
}

// ---------------------------------------------------------------------- share

async function share(paths: string[]) {
  try {
    await callHelper('share', paths, 20000);
  } catch (e) {
    log('share failed', e);
    throw new Error("Couldn't open the Windows share sheet.");
  }
}

// ----------------------------------------------------------------------- copy

async function copy(paths: string[]) {
  try {
    await callHelper('copyFiles', paths);
  } catch (e) {
    log('copyFiles via helper failed', e);
    // Without the helper the best we can do is the paths as text.
    clipboard.writeText(paths.join('\r\n'));
    return hud.notice("Couldn't copy the files themselves, so their paths were copied instead.");
  }
  const files = paths.filter((p) => !isDir(p)).length;
  const folders = paths.length - files;
  const parts = [files && plural(files, 'file'), folders && plural(folders, 'folder')].filter(Boolean).join(' and ');
  hud.notice(`Copied ${parts}. Paste in any folder.`);
}

// ----------------------------------------------------------------------- move

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function freeName(dir: string, name: string) {
  let target = join(dir, name);
  if (!existsSync(target)) return target;
  const ext = isDir(target) ? '' : extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i++) {
    target = join(dir, `${stem} ${i}${ext}`);
    if (!existsSync(target)) return target;
  }
}

async function moveOne(src: string, dest: string) {
  try {
    await rename(src, dest);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    // Different drive: copy, then remove the original once the copy is complete.
    await cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await rm(src, { recursive: true, force: true });
  }
}

async function move(paths: string[]) {
  const last = settings.get().moveFolder;
  const start = last && existsSync(last) ? last : dirname(paths[0]);
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const opts: Electron.OpenDialogOptions = {
    title: `Move ${what(paths)} to…`,
    defaultPath: start,
    buttonLabel: 'Move here',
    properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
  };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return;
  const dest = r.filePaths[0];
  settings.set({ moveFolder: dest });

  const job = hud.start(`Moving ${what(paths)}`, paths.length, () => {});
  const moved: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const src = paths[i];
    try {
      if (resolve(dirname(src)).toLowerCase() === resolve(dest).toLowerCase()) continue; // already there
      if ((resolve(dest) + '\\').toLowerCase().startsWith((resolve(src) + '\\').toLowerCase())) throw new Error("can't move a folder into itself");
      const target = freeName(dest, basename(src));
      job.progress(i / paths.length, basename(src));
      await moveOne(src, target);
      moved.push(target);
    } catch (e: any) {
      log('move failed', src, e);
      errors.push(`${basename(src)}: ${e?.code === 'EBUSY' ? 'in use by another app' : String(e?.message ?? e)}`);
    }
  }
  if (!moved.length && errors.length) return job.failed(errors.join('\n'));
  if (!moved.length) {
    job.done([]);
    return hud.notice(`Already in ${basename(dest) || dest}`);
  }
  job.done(moved, errors);
}

// ------------------------------------------------------------------- terminal

function which(exe: string): string | null {
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean);
  for (const d of dirs) {
    const p = join(d, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

function findTerminal(pref: string): { kind: 'wt' | 'pwsh' | 'powershell' | 'cmd'; exe: string } {
  const local = process.env.LOCALAPPDATA ?? '';
  const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const candidates: Record<string, () => string | null> = {
    wt: () => which('wt.exe') ?? (existsSync(join(local, 'Microsoft', 'WindowsApps', 'wt.exe')) ? join(local, 'Microsoft', 'WindowsApps', 'wt.exe') : null),
    pwsh: () =>
      which('pwsh.exe') ??
      [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'), join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe')].find((p) => existsSync(p)) ??
      null,
    powershell: () => {
      const p = join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return existsSync(p) ? p : which('powershell.exe');
    },
    cmd: () => process.env.ComSpec ?? join(sys, 'cmd.exe'),
  };
  const order = pref && pref !== 'auto' ? [pref, 'wt', 'pwsh', 'powershell', 'cmd'] : ['wt', 'pwsh', 'powershell', 'cmd'];
  for (const k of order) {
    const exe = candidates[k]?.();
    if (exe) return { kind: k as any, exe };
  }
  return { kind: 'cmd', exe: 'cmd.exe' };
}

function openTerminal(p: string) {
  const folder = isDir(p) ? p : dirname(p);
  const { kind, exe } = findTerminal(settings.get().terminal);
  let child;
  if (kind === 'wt') {
    child = spawn(exe, ['-d', folder], { cwd: folder, detached: true, stdio: 'ignore' });
  } else {
    // Console shells need a real console: launched straight from Electron their stdin is NUL and
    // they exit at once. `start` gives them a fresh console window in the folder.
    const shellArgs = kind === 'cmd' ? '/K' : '-NoExit -NoLogo';
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    child = spawn(comspec, [`/d /s /c "start "" /D "${folder}" "${exe}" ${shellArgs}"`], {
      cwd: folder,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  child.on('error', (e) => {
    log('terminal failed', kind, e);
    hud.notice("Couldn't open a terminal.");
  });
  child.unref();
}

// Exposed for tests.
export const _actions = { findTerminal, freeName, moveOne };
