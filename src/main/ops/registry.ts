// Converters and tools load the first time they're needed, not at startup. Between them they pull in
// sharp, exceljs, pdf-lib and the AI runtime, which would cost every launch a few hundred ms and
// several MB that a tray app sitting idle never uses. esbuild still bundles each module into
// dist/main.js, but only runs it when one of these require() calls does.
import { extOf, kindOfExt, type Kind, type WheelKind } from '../../shared/catalog';
import type { ConverterModule, ToolFn } from './types';
import { prepareBin } from '../paths';

type ImageModule = typeof import('./convert-image');

/** convert-image also configures sharp (no decode cache, default concurrency) for everything that uses it. */
export const imageModule = (): ImageModule => require('./convert-image');
export const imageConverter = (): ConverterModule => imageModule().converter;
export const docsConverter = (): ConverterModule => (require('./convert-docs') as typeof import('./convert-docs')).converter;
export const archiveConverter = (): ConverterModule => (require('./convert-archive') as typeof import('./convert-archive')).converter;

/** Which module converts each kind. Must match each module's own `kinds` (the test suite checks). */
export const CONVERTERS: { kinds: Kind[]; load: () => ConverterModule }[] = [
  { kinds: ['image'], load: imageConverter },
  { kinds: ['video', 'audio'], load: () => (require('./convert-av') as typeof import('./convert-av')).converter },
  { kinds: ['pdf', 'document', 'slides', 'spreadsheet', 'ebook'], load: docsConverter },
  { kinds: ['archive'], load: archiveConverter },
  { kinds: ['subtitle'], load: () => (require('./convert-subtitle') as typeof import('./convert-subtitle')).converter },
];

let tools: Record<string, ToolFn> | null = null;

/**
 * Every tool, by id. Loading the tool modules also registers the IPC handlers their windows call
 * (av:probe, pdf:read, ai:status…), so this runs before any tool window opens.
 */
export function loadTools(): Record<string, ToolFn> {
  if (tools) return tools;
  imageModule(); // sharp's settings first, before any tool can touch sharp
  tools = {
    ...(require('./tools-image') as typeof import('./tools-image')).tools,
    ...(require('./tools-av') as typeof import('./tools-av')).tools,
    ...(require('./tools-pdf') as typeof import('./tools-pdf')).tools,
    ...(require('./tools-file') as typeof import('./tools-file')).tools,
    ...(require('./tools-ai') as typeof import('./tools-ai')).tools,
    ...(require('./tools-util') as typeof import('./tools-util')).tools,
    ...(require('./tools-speech') as typeof import('./tools-speech')).tools,
  };
  return tools;
}

export function undoLastRename(outputs: string[]) {
  loadTools();
  return (require('./tools-util') as typeof import('./tools-util')).undoLastRename(outputs);
}

/** Long enough for the wheel to appear and its thumbnail to arrive before the main thread is busy. */
const PREWARM_DELAY_MS = 150;

/**
 * Loads what a choice on this wheel will need while the user is still aiming at a slice, so the
 * first job after launch doesn't wait for sharp or exceljs (100-300 ms each). Runs after the wheel
 * has opened and its preview has had a moment, and only for a single, known kind of file.
 */
export function prewarm(wheel: WheelKind, paths: string[], stillOpen: () => boolean) {
  if (wheel === 'actions' || !paths.length) return;
  setTimeout(() => {
    if (!stillOpen()) return;
    try {
      if (wheel === 'tools') {
        loadTools();
        return;
      }
      const kinds = new Set(paths.map((p) => kindOfExt(extOf(p))));
      if (kinds.size !== 1) return; // mixed selections and folders zip: nothing heavy to load
      const [kind] = kinds;
      // Unpack the packed ffmpeg/ffprobe off the main thread while the user aims at a slice.
      if (kind === 'video' || kind === 'audio') void prepareBin('ffprobe').catch(() => {});
      CONVERTERS.find((c) => c.kinds.includes(kind))?.load();
      if (kind === 'spreadsheet') require('exceljs');
    } catch {
      /* the job itself reports a module that fails to load */
    }
  }, PREWARM_DELAY_MS);
}
