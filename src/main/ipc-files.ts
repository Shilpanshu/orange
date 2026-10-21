// File IPC used by tool windows: saving renderer-produced bytes and previewing any image format.
import { ipcMain } from 'electron';
import { writeFileSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
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

export function registerFileIpc() {
  ipcMain.handle('file:saveBytes', (_e, source: string, ext: string, suffix: string, bytes: Uint8Array) => {
    const { ctx } = makeCtx(new AbortController().signal, () => {});
    const out = ctx.out(source, ext, suffix);
    writeFileSync(out, Buffer.from(bytes));
    const job = hud.start(`Saved ${out.split(/[\/]/).pop()}`, 1, () => {});
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
