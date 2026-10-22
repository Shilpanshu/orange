// Clipboard convert: a global shortcut opens a small popover near the pointer that shows what's on the
// clipboard (an image, files copied in Explorer, or text/HTML) and saves it in another format.
import { app, BrowserWindow, clipboard, ClipboardItem, globalShortcut, ipcMain, nativeImage, nativeTheme, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { page, distDir } from './paths';
import { releaseWhenHidden } from './windows';
import { settings } from './settings';
import { runJob } from './jobs';
import { hud } from './hud';
import { log } from './log';
import type { Ctx } from './ops/types';
import { imageConverter, docsConverter } from './ops/registry';

const W = 344;

export type ClipKind = 'image' | 'files' | 'text' | 'empty';

export interface ClipContent {
  kind: ClipKind;
  /** image: a small PNG data URL for the preview */
  thumb?: string;
  width?: number;
  height?: number;
  files?: string[];
  /** text: the first part, for the preview */
  text?: string;
  chars?: number;
  lines?: number;
  html?: boolean;
  /** Where saved files go, for the footer. */
  saveTo: string;
}

let win: BrowserWindow | null = null;
let openWheel: ((paths: string[]) => void) | null = null;
let registered = '';
let listening = false;
let current: ClipContent | null = null;

// ----------------------------------------------------------------- hotkey

/** Register the clipboard shortcut from settings. `openWheelForPaths` shows the wheel for copied files. */
export function registerClipboardHotkey(openWheelForPaths: (paths: string[]) => void) {
  openWheel = openWheelForPaths;
  applyHotkey();
  if (!listening) {
    listening = true;
    // Re-apply after any settings change. Deferred so it runs after other code that may have called
    // globalShortcut.unregisterAll() while handling the same change.
    settings.on('change', () => setImmediate(applyHotkey));
  }
}

export function unregisterClipboardHotkey() {
  if (registered) {
    try {
      globalShortcut.unregister(registered);
    } catch {
      /* already gone */
    }
  }
  registered = '';
  openWheel = null;
}

function applyHotkey() {
  if (!openWheel) return;
  const hk = settings.get().clipboardHotkey;
  if (registered && registered === hk && globalShortcut.isRegistered(hk)) return;
  if (registered && registered !== hk) {
    try {
      globalShortcut.unregister(registered);
    } catch {
      /* ignore */
    }
  }
  registered = '';
  if (!hk) return;
  try {
    if (globalShortcut.register(hk, () => void openClipboardPopover())) registered = hk;
    else log('clipboard hotkey is taken by another app', hk);
  } catch (e) {
    log('clipboard hotkey register failed', hk, e);
  }
}

// --------------------------------------------------------------- reading

function saveDir(): string {
  const o = settings.get().output;
  if (o.mode === 'folder' && o.folder) return o.folder;
  return app.getPath('downloads');
}

interface Snapshot {
  files: string[];
  png?: Buffer;
  text: string;
  html: string;
}

/** Read the clipboard once (Electron's clipboard API is asynchronous, W3C style). */
async function snapshot(): Promise<Snapshot> {
  const snap: Snapshot = { files: [], text: '', html: '' };
  let items: Electron.ClipboardItem[] = [];
  try {
    items = await clipboard.read();
  } catch (e) {
    log('clipboard read failed', e);
  }
  const blobText = async (item: Electron.ClipboardItem, type: string) => {
    const v = await item.getType(type);
    return typeof v === 'string' ? v : v instanceof Blob ? await v.text() : '';
  };
  for (const item of items) {
    const types = item.types;
    try {
      // Files copied in Explorer arrive as file:/// URLs.
      if (!snap.files.length && types.includes('text/uri-list')) {
        snap.files = (await blobText(item, 'text/uri-list'))
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^file:/i.test(l))
          .map((l) => {
            try {
              return fileURLToPath(l);
            } catch {
              return '';
            }
          })
          .filter((p) => p && existsSync(p));
      }
      if (!snap.png && types.includes('image/png')) {
        const v = await item.getType('image/png');
        if (v instanceof Blob) snap.png = Buffer.from(await v.arrayBuffer());
      }
      if (!snap.html && types.includes('text/html')) snap.html = await blobText(item, 'text/html');
      if (!snap.text && types.includes('text/plain')) snap.text = await blobText(item, 'text/plain');
    } catch (e) {
      log('clipboard item failed', e);
    }
  }
  return snap;
}

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function readClipboard(): Promise<ClipContent> {
  const saveTo = saveDir();
  const snap = await snapshot();
  if (snap.files.length) return { kind: 'files', files: snap.files, saveTo };
  const img = snap.png ? nativeImage.createFromBuffer(snap.png) : null;
  if (img && !img.isEmpty()) {
    const { width, height } = img.getSize();
    const scale = Math.min(1, 624 / width, 320 / height);
    const thumb = (scale < 1 ? img.resize({ width: Math.max(1, Math.round(width * scale)), quality: 'good' }) : img).toDataURL();
    return { kind: 'image', thumb, width, height, saveTo };
  }
  const text = snap.text;
  const htmlText = snap.html ? htmlToText(snap.html) : '';
  if (text.trim() || htmlText) {
    const t = text.trim() ? text : htmlText;
    return { kind: 'text', text: t.slice(0, 600), chars: t.length, lines: t.split(/\r?\n/).length, html: !!htmlText, saveTo };
  }
  return { kind: 'empty', saveTo };
}

// ---------------------------------------------------------------- popover

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: W,
    height: 260,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: dark ? '#23201d' : '#fffdfa',
    title: 'Orange clipboard',
    webPreferences: { preload: join(distDir, 'preload.js'), sandbox: false, spellcheck: false },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.loadFile(page('clipboard'));
  win.on('blur', () => hidePopover());
  win.on('closed', () => (win = null));
  releaseWhenHidden(win);
  return win;
}

let anchor = { x: 0, y: 0 };
let shownAt = 0;

/** Show the popover (or hide it when it is already open). Also handy for a tray menu item. */
export async function openClipboardPopover() {
  const w = ensureWindow();
  if (w.isVisible()) {
    hidePopover();
    return;
  }
  anchor = screen.getCursorScreenPoint();
  current = await readClipboard();
  const send = () => w.webContents.send('clip:content', current);
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
}

function place(height: number) {
  const w = ensureWindow();
  const wa = screen.getDisplayNearestPoint(anchor).workArea;
  const h = Math.min(Math.max(Math.round(height), 120), wa.height - 16);
  let x = anchor.x - 28;
  let y = anchor.y + 16;
  if (y + h > wa.y + wa.height - 8) y = anchor.y - h - 12; // flip above the pointer near the bottom edge
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - W - 8);
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - h - 8);
  w.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: h });
}

function hidePopover() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  // A blur right after showing comes from the hotkey's own focus juggling; ignore it.
  if (Date.now() - shownAt < 150) return;
  win.hide();
}

// ------------------------------------------------------------------ saving

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

function unique(p: string) {
  if (!existsSync(p)) return p;
  const ext = extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) {
    const c = `${stem} ${i}${ext}`;
    if (!existsSync(c)) return c;
  }
}

/** A job context whose outputs go to the save folder under `name`, whatever the temp input is called. */
function savingCtx(ctx: Ctx, dir: string, name: string): Ctx {
  return {
    ...ctx,
    out: (_input, ext, suffix = '') => unique(join(dir, `${name}${suffix}${ext ? '.' + ext : ''}`)),
    outDir: (_input, n) => {
      const d = unique(join(dir, n ?? name));
      mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

const LABEL: Record<string, string> = { png: 'PNG', jpg: 'JPG', webp: 'WebP', pdf: 'PDF', txt: 'TXT', md: 'Markdown', docx: 'Word' };

async function saveImage(target: string) {
  const { png } = await snapshot();
  if (!png?.length) return hud.notice('The clipboard no longer holds an image.');
  if (target === 'copy-png') {
    // Re-encode through nativeImage so odd sources (bitmaps from older apps) become a clean PNG.
    const clean = nativeImage.createFromBuffer(png).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(clean)], { type: 'image/png' }) })]);
    return hud.notice('Copied to the clipboard as PNG');
  }
  const dir = saveDir();
  mkdirSync(dir, { recursive: true });
  const name = `Clipboard ${stamp()}`;
  const work = mkdtempSync(join(tmpdir(), 'orange-clip-'));
  const src = join(work, `${name}.png`);
  writeFileSync(src, png);
  try {
    await runJob({
      title: `Clipboard image to ${LABEL[target] ?? target.toUpperCase()}`,
      inputs: [src],
      combined: async (ctx) => {
        const c = savingCtx(ctx, dir, name);
        if (target === 'png') {
          const out = c.out(src, 'png');
          writeFileSync(out, png);
          return [out];
        }
        return imageConverter().convert(src, target, c);
      },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const looksLikeMarkdown = (t: string) => /^(#{1,6} |\s*[-*+] |\s*\d+\. |> |```)/m.test(t) || /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/.test(t);

async function saveText(target: string) {
  const { text, html } = await snapshot();
  const hasHtml = !!html && !!htmlToText(html);
  if (!text.trim() && !hasHtml) return hud.notice('The clipboard no longer holds text.');
  const dir = saveDir();
  mkdirSync(dir, { recursive: true });
  const name = `Clipboard ${stamp()}`;

  // Plain text is saved as it is; nothing to convert.
  if (target === 'txt' || (target === 'md' && !hasHtml)) {
    const out = unique(join(dir, `${name}.${target}`));
    writeFileSync(out, text || htmlToText(html), 'utf8');
    const job = hud.start(`Clipboard text to ${LABEL[target]}`, 1, () => {});
    job.done([out]);
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'orange-clip-'));
  // Prefer the formatted copy (headings, lists, links); otherwise treat Markdown-looking text as Markdown.
  let src: string;
  if (hasHtml) {
    src = join(work, `${name}.html`);
    const body = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body>${html}</body></html>`;
    writeFileSync(src, body, 'utf8');
  } else {
    src = join(work, `${name}.${looksLikeMarkdown(text) ? 'md' : 'txt'}`);
    writeFileSync(src, text, 'utf8');
  }
  try {
    await runJob({
      title: `Clipboard text to ${LABEL[target] ?? target.toUpperCase()}`,
      inputs: [src],
      combined: (ctx) => docsConverter().convert(src, target, savingCtx(ctx, dir, name)),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------- IPC

ipcMain.on('clip:height', (e, height: number) => {
  if (!win || e.sender !== win.webContents) return;
  place(height);
  if (!win.isVisible()) {
    shownAt = Date.now();
    win.show();
    win.focus();
  }
});
ipcMain.on('clip:close', (e) => {
  if (win && e.sender === win.webContents) win.hide();
});
ipcMain.on('clip:action', (e, target: string) => {
  if (!win || e.sender !== win.webContents) return;
  const kind = current?.kind;
  win.hide();
  if (kind === 'files') {
    const files = current?.files ?? [];
    if (files.length && openWheel) openWheel(files);
    return;
  }
  const job = kind === 'image' ? saveImage(target) : kind === 'text' ? saveText(target) : Promise.resolve();
  job.catch((err) => {
    log('clipboard save failed', err);
    hud.notice(String(err?.message ?? err));
  });
});

/** Exposed for tests: what the popover would show right now. */
export const _internal = { readClipboard, looksLikeMarkdown, saveImage, saveText };
