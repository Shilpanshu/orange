// Crash capture and "Report a problem". Everything stays on this PC: crash dumps are written
// locally (never uploaded) and the report is a zip the user can attach to a GitHub issue.
import { app, crashReporter, shell, BrowserWindow, dialog } from 'electron';
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import os from 'node:os';
import type JSZip from 'jszip';
import { log } from './log';

/** Call before app 'ready' so native crashes are captured from the start. */
export function startCrashCapture() {
  crashReporter.start({ uploadToServer: false, submitURL: '', compress: true });

  process.on('uncaughtException', (e) => log('uncaughtException', e));
  process.on('unhandledRejection', (e) => log('unhandledRejection', e as any));

  app.on('render-process-gone', (_e, wc, d) => log('renderer gone', d.reason, d.exitCode, wc.getURL().split('#')[0]));
  app.on('child-process-gone', (_e, d) => log('child process gone', d.type, d.reason, d.exitCode, d.name ?? ''));
  app.on('web-contents-created', (_e, wc) => {
    wc.on('preload-error', (_ev, path, err) => log('preload error', path, err));
    wc.on('console-message', (ev) => {
      if (ev.level === 'error') log('[renderer error]', page(wc.getURL()), ev.message, `${ev.sourceId}:${ev.lineNumber}`);
    });
    wc.on('unresponsive', () => log('window unresponsive', page(wc.getURL())));
  });
}

function page(url: string) {
  return url.split('#')[0].split('/renderer/')[1] ?? url;
}

function addDir(zip: JSZip, dir: string, into: string, maxFiles = 20) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath ?? (d as any).path, d.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, maxFiles);
  for (const f of files) zip.file(`${into}/${basename(f)}`, readFileSync(f));
}

/** Builds Orange-report-<date>.zip on the Desktop, reveals it, and offers to open a GitHub issue. */
export async function reportProblem(extra: Record<string, unknown> = {}) {
  // Loaded here, not at startup: only a problem report needs it.
  const Zip: typeof JSZip = require('jszip');
  const zip = new Zip();
  const info = {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    locale: app.getLocale(),
    packaged: app.isPackaged,
    ...extra,
  };
  zip.file('system.json', JSON.stringify(info, null, 2));
  addDir(zip, app.getPath('logs'), 'logs');
  addDir(zip, app.getPath('crashDumps'), 'crashes', 10);
  const settingsFile = join(app.getPath('userData'), 'settings.json');
  if (existsSync(settingsFile)) zip.file('settings.json', readFileSync(settingsFile));

  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const out = join(app.getPath('desktop'), `Orange-report-${stamp}.zip`);
  writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  log('problem report written', out);
  shell.showItemInFolder(out);

  const win = BrowserWindow.getFocusedWindow();
  const opts: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'Report a problem',
    message: 'A report was saved to your Desktop.',
    detail: `${basename(out)} contains Orange's logs, crash files, settings and basic system details. It does not include any of your files.\n\nOpen a GitHub issue and attach the zip?`,
    buttons: ['Open GitHub issue', 'Close'],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (response === 0) {
    const body = encodeURIComponent(
      `**What happened?**\n\n\n**What did you expect?**\n\n\n**Steps to reproduce**\n1. \n\n---\nOrange ${info.app} · ${info.os}\nPlease attach ${basename(out)} from your Desktop.`,
    );
    shell.openExternal(`https://github.com/Shilpanshu/orange/issues/new?title=${encodeURIComponent('Problem: ')}&body=${body}`);
  }
  return out;
}
