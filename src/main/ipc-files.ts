// File IPC used by tool windows: saving renderer-produced bytes and previewing any image format.
import { ipcMain } from 'electron';
import { writeFileSync, statSync, mkdtempSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { makeCtx } from './jobs';
import { extOf } from '../shared/catalog';
import { toBrowserImage } from './ops/convert-image';
import { hud } from './hud';

// Formats Chromium can draw directly.
const NATIVE = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico']);
const previewCache = new Map<string, { mtime: number; url: string }>();
let previewDir = '';
// What renderer tools export (see OutFormat in renderer/tool/image/common.ts).
const SAVE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

export function registerFileIpc() {
  ipcMain.handle('file:saveBytes', (_e, source: string, ext: string, suffix: string, bytes: Uint8Array) => {
    // The name is built from these, so a path separator or an unexpected extension could write
    // (say, a script into the Startup folder) anywhere. The tool pages only export images.
    if (!SAVE_EXTS.has(String(ext).toLowerCase()) || typeof suffix !== 'string' || /[\\/:*?"<>|]/.test(suffix)) {
      throw new Error('Unsupported output name.');
    }
    const { ctx, cleanup } = makeCtx(new AbortController().signal, () => {});
    const out = ctx.out(source, ext, suffix);
    try {
      writeFileSync(out, Buffer.from(bytes));
    } finally {
      cleanup();
    }
    const job = hud.start(`Saved ${basename(out)}`, 1, () => {});
    job.done([out]);
    return out;
  });

  ipcMain.handle('file:stat', (_e, p: string) => {
    const s = statSync(p);
    return { size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() };
  });

  ipcMain.handle('image:previewUrl', async (_e, p: string) => {
    if (NATIVE.has(extOf(p))) return pathToFileURL(p).href;
    const mtime = statSync(p).mtimeMs;
    const hit = previewCache.get(p);
    if (hit && hit.mtime === mtime) return hit.url;
    if (!previewDir) previewDir = mkdtempSync(join(tmpdir(), 'orange-preview-'));
    const out = join(previewDir, `${previewCache.size}-${Date.now()}.png`);
    await toBrowserImage(p, out);
    const url = pathToFileURL(out).href;
    previewCache.set(p, { mtime, url });
    return url;
  });
}
