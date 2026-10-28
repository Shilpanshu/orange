// Settings shapes shared by the settings page (the Rust side owns the real file: src-tauri/src/settings.rs).
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
