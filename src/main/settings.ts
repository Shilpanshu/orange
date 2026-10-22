import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';

export type ModKey = 'shift' | 'ctrl' | 'alt' | 'none';

export interface Settings {
  keys: { convert: ModKey; tools: ModKey; actions: ModKey };
  // Global shortcut that opens the wheel for the files selected in Explorer.
  selectionHotkey: string;
  // Where results go: next to the source, or a fixed folder.
  output: { mode: 'beside' | 'folder'; folder: string };
  revealWhenDone: boolean;
  replaceOriginal: boolean;
  jpgQuality: number;
  launchAtLogin: boolean;
  sounds: boolean;
  theme: 'system' | 'light' | 'dark';
  terminal: 'auto' | 'wt' | 'pwsh' | 'powershell' | 'cmd';
  shelfEdge: 'right' | 'left';
  // Last folder chosen for the Move action (empty = ask from the file's own folder).
  moveFolder?: string;
  onboarded: boolean;
  /** Pinned wheel slices per file kind (e.g. { image: ['to:jpg', 'tool:compress'] }); shown first. */
  favorites: Record<string, string[]>;
  /** Last slice chosen per extension (e.g. { heic: 'to:jpg' }); highlighted on the wheel. */
  recents: Record<string, string>;
  /** Saved tool settings that appear as their own slices on the Tools wheel. */
  presets: Preset[];
  /** Folders whose new files are converted automatically. */
  watchFolders: WatchFolder[];
  /** "Convert with Orange" in Explorer's right-click menu. */
  contextMenu: boolean;
  /** Global shortcut that converts whatever is on the clipboard ('' = off). */
  clipboardHotkey: string;
  /** Use the graphics card for video encoding when available. */
  gpuEncode: 'auto' | 'off';
}

export interface Preset {
  id: string;
  name: string;
  tool: string; // tool id from the catalog, e.g. 'compress'
  options: unknown; // the tool window's options object
  kinds: string[]; // file kinds it applies to
}

export interface WatchFolder {
  id: string;
  folder: string;
  /** Only files with these extensions (empty = any the action supports). */
  exts: string[];
  /** A wheel item id: 'to:webp', 'tool:compress' (instant tools) or 'preset:<id>'. */
  action: string;
  /** Put results here instead of next to the new file ('' = beside). */
  outFolder: string;
  /** Move the original to the Recycle Bin after a successful conversion. */
  recycleOriginal: boolean;
  enabled: boolean;
}

const DEFAULTS: Settings = {
  keys: { convert: 'shift', tools: 'ctrl', actions: 'alt' },
  selectionHotkey: 'Control+Shift+Space',
  output: { mode: 'beside', folder: '' },
  revealWhenDone: false,
  replaceOriginal: false,
  jpgQuality: 88,
  launchAtLogin: true,
  sounds: true,
  theme: 'system',
  terminal: 'auto',
  shelfEdge: 'right',
  moveFolder: '',
  onboarded: false,
  favorites: {},
  recents: {},
  presets: [],
  watchFolders: [],
  contextMenu: true,
  // Not Ctrl+Shift+V: that is "paste as plain text" in many apps.
  clipboardHotkey: 'Control+Alt+V',
  gpuEncode: 'auto',
};

class Store extends EventEmitter {
  // Resolved on use, not at import: main.ts may switch the profile (ORANGE_USER_DATA) first.
  private get file() {
    return join(app.getPath('userData'), 'settings.json');
  }
  private data: Settings = structuredClone(DEFAULTS);

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw, keys: { ...DEFAULTS.keys, ...raw.keys }, output: { ...DEFAULTS.output, ...raw.output } };
    } catch (e: any) {
      // Keep a damaged file for the problem report; the next save would overwrite it.
      if (e?.code !== 'ENOENT') {
        try {
          copyFileSync(this.file, this.file.replace(/\.json$/, '.corrupt.json'));
        } catch {
          /* unreadable as well */
        }
      }
      this.data = structuredClone(DEFAULTS);
    }
    return this.data;
  }

  get(): Settings {
    return this.data;
  }

  set(patch: Partial<Settings>) {
    this.data = { ...this.data, ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    // Write a sibling and swap it in, so a crash or power cut mid-write never leaves a truncated file
    // (which would silently reset every setting on the next start).
    const tmp = `${this.file}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    writeFileSync(tmp, json);
    try {
      renameSync(tmp, this.file);
    } catch {
      // Another program (antivirus, a backup tool) has the file open: fall back to writing in place.
      writeFileSync(this.file, json);
      rmSync(tmp, { force: true });
    }
    this.emit('change', this.data);
  }
}

export const settings = new Store();
