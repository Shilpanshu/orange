// Runs a tool window's "main process" inside the window itself. The page keeps calling
// orange.invoke / orange.on / orange.send exactly as in 1.x; channels that a ported tool module
// registered with ipcMain (host/main/ops/*) are answered here, the rest go to the native side.
//
// Jobs run here too, so "close" while a job runs hides the window instead and it closes itself
// once the job is done (the HUD shows progress meanwhile, as in 1.x).
import { handlers, listeners, pageListeners, sender } from './node/electron';
import { initNative, INFO, fileSrc, windowOp, invoke, hudNative } from './native';
import { loadSettings } from './main/settings';
import { setBinDir } from './main/paths';
import { runTool, running, whenIdle, holdOpen } from './main/jobs';
import { makeCtx } from './main/jobs';
import { hud } from './main/hud';
import { extOf } from './shared/catalog';
import { statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ToolFn } from './main/ops/types';

type Api = {
  send(ch: string, ...a: unknown[]): void;
  invoke<R = unknown>(ch: string, ...a: unknown[]): Promise<R>;
  on(ch: string, fn: (...a: any[]) => void): () => void;
  args: any;
};
const orange = (window as unknown as { orange: Api }).orange;
const native = { send: orange.send, invoke: orange.invoke, on: orange.on };

/** Which ported modules each tool needs (their ipcMain handlers and tool functions). */
const MODULES: Record<string, () => Promise<{ tools: Record<string, ToolFn> }>> = {
  image: () => import('./main/ops/tools-image'),
  av: () => import('./main/ops/tools-av'),
  pdf: () => import('./main/ops/tools-pdf'),
  file: () => import('./main/ops/tools-file'),
  ai: () => import('./main/ops/tools-ai'),
  util: () => import('./main/ops/tools-util'),
  speech: () => import('./main/ops/tools-speech'),
};
const TOOL_MODULE: Record<string, string[]> = {
  editImage: ['image'], annotateImage: ['image'], frameImage: ['image'], cropImage: ['image'], redactImage: ['image'], createPdf: ['image'], createCollage: ['image'],
  trimVideo: ['av'], cropVideo: ['av'], speedVideo: ['av'], joinVideos: ['av'], videoFrames: ['av'], splitVideo: ['av'], redactVideo: ['av'],
  normalizeAudio: ['av'], audioToVideo: ['av'], trimAudio: ['av'], audioChannels: ['av'], bleepAudio: ['av'], joinAudio: ['av'],
  mergePdf: ['pdf'], organizePdf: ['pdf'], splitPdf: ['pdf'],
  compress: ['file', 'av'], metadata: ['file', 'av'], extractArchive: ['file'],
  ocr: ['ai', 'pdf'], removeBg: ['ai'], upscale: ['ai'],
  rename: ['util'], protect: ['util'], unlock: ['util'],
  subtitles: ['speech', 'av'],
};

const tools: Record<string, ToolFn> = {};

// Formats the webview draws directly.
const NATIVE_IMG = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico']);
const SAVE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const previews = new Map<string, string>();

handlers.set('tool:run', (_e, id: string, paths: string[], options: unknown, title?: string) => {
  const fn = tools[id];
  if (!fn) {
    hud.notice('This tool is not available yet.');
    return [];
  }
  const release = holdOpen(); // the window can't close under a job that hasn't started yet
  return (async () => {
    try {
      // AI jobs wait for the window's own preview computation to finish (see whenPreviewsIdle).
      if (TOOL_MODULE[id]?.includes('ai')) await (await import('./main/ops/tools-ai')).whenPreviewsIdle();
      return await runTool(fn, id, paths, options, title);
    } finally {
      release();
    }
  })();
});
handlers.set('file:stat', (_e, p: string) => {
  const s = statSync(p);
  return { size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() };
});
handlers.set('file:saveBytes', async (_e, source: string, ext: string, suffix: string, bytes: Uint8Array) => {
  // The name is built from these, so a separator or an unexpected extension could write anywhere.
  if (!SAVE_EXTS.has(String(ext).toLowerCase()) || typeof suffix !== 'string' || /[\\/:*?"<>|]/.test(suffix)) throw new Error('Unsupported output name.');
  const { ctx, cleanup } = makeCtx(new AbortController().signal, () => {});
  const out = ctx.out(source, ext, suffix);
  try {
    writeFileSync(out, bytes);
  } finally {
    cleanup();
  }
  // Awaited: the page closes its window right after this resolves.
  await hudNative.done(await hudNative.start(`Saved ${basename(out)}`), [out], []);
  return out;
});
handlers.set('image:previewUrl', async (_e, p: string) => {
  if (NATIVE_IMG.has(extOf(p))) return fileSrc(p);
  const mtime = statSync(p).mtimeMs;
  const key = `${p}|${mtime}`;
  const hit = previews.get(key);
  if (hit) return hit;
  const { toBrowserImage } = await import('./main/ops/convert-image');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const out = join(mkdtempSync(join(INFO.tmp, 'orange-preview-')), 'preview.png');
  await toBrowserImage(p, out);
  const url = fileSrc(out);
  previews.set(key, url);
  return url;
});
handlers.set('dialog:files', async (_e, filters?: { name: string; extensions: string[] }[], multi = true) =>
  invoke('tools_dialog', { op: { op: 'files', filters: filters ?? [], multi } }),
);
handlers.set('dialog:folder', async (_e, title?: string) => invoke('tools_dialog', { op: { op: 'folder', title: title ?? 'Choose a folder' } }));

let closing = false;
function closeWindow() {
  if (running) {
    // Keep running out of sight; close when the job is done.
    if (!closing) {
      closing = true;
      void windowOp('park');
      void whenIdle().then(() => windowOp('close'));
    }
    return;
  }
  void windowOp('close');
}

orange.invoke = (async (ch: string, ...args: unknown[]) => {
  const h = handlers.get(ch);
  if (h) return h({ sender }, ...args);
  return native.invoke(ch, ...args);
}) as Api['invoke'];

orange.send = (ch: string, ...args: unknown[]) => {
  if (ch === 'window:close') return closeWindow();
  const l = listeners.get(ch);
  if (l) {
    l({ sender }, ...args);
    return;
  }
  native.send(ch, ...args);
};

orange.on = (ch: string, fn: (...a: any[]) => void) => {
  let set = pageListeners.get(ch);
  if (!set) pageListeners.set(ch, (set = new Set()));
  set.add(fn);
  const off = native.on(ch, fn);
  return () => {
    set!.delete(fn);
    off();
  };
};

/** Loads what `tool` needs before its page builds. */
export async function prepare(tool: string) {
  const t0 = performance.now();
  const mark = (what: string) => orange.send('log', `prepare ${tool}: ${what} at ${Math.round(performance.now() - t0)} ms`);
  await initNative();
  setBinDir(INFO.binDir);
  mark('native');
  await loadSettings();
  mark('settings');
  for (const m of TOOL_MODULE[tool] ?? []) Object.assign(tools, (await MODULES[m]()).tools);
  mark('modules');
}
