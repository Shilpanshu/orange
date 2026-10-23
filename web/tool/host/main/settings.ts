// The settings the tool modules read, fetched once from the native store (settings:get) when the
// window opens. Defaults match Orange 1.x for anything the store doesn't answer.
export interface Settings {
  output: { mode: 'beside' | 'folder'; folder: string };
  revealWhenDone: boolean;
  replaceOriginal: boolean;
  jpgQuality: number;
  sounds: boolean;
  gpuEncode: 'auto' | 'off';
  presets: { id: string; name: string; tool: string; options: unknown; kinds: string[] }[];
  recents: Record<string, string>;
  [k: string]: any;
}

const DEFAULTS: Settings = {
  output: { mode: 'beside', folder: '' },
  revealWhenDone: false,
  replaceOriginal: false,
  jpgQuality: 90,
  sounds: true,
  gpuEncode: 'auto',
  presets: [],
  recents: {},
};

let current: Settings = { ...DEFAULTS };

export async function loadSettings() {
  try {
    const s = await (window as any).orange.invoke('settings:get');
    if (s && typeof s === 'object') current = { ...DEFAULTS, ...s, output: { ...DEFAULTS.output, ...(s.output ?? {}) } };
  } catch {
    /* no settings store in this build: defaults */
  }
}

export const settings = {
  get: (): Settings => current,
  set(patch: Partial<Settings>) {
    current = { ...current, ...patch };
    (window as any).orange.invoke('settings:set', patch).catch(() => {});
    return current;
  },
  on: () => settings,
};
