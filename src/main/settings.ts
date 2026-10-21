import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
};

class Store extends EventEmitter {
  private file = join(app.getPath('userData'), 'settings.json');
  private data: Settings = structuredClone(DEFAULTS);

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw, keys: { ...DEFAULTS.keys, ...raw.keys }, output: { ...DEFAULTS.output, ...raw.output } };
    } catch {
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
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    this.emit('change', this.data);
  }
}

export const settings = new Store();
