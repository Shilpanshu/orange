// Saved tool settings ("presets"). A tool window can save its current options under a name; the
// preset then shows up as its own slice on the Tools wheel and can drive a watch folder.
// Stored in settings.presets. IPC: presets:list / presets:save / presets:rename / presets:delete.
import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { TOOLS, extOf, kindOfExt, toolsFor, type Kind } from '../shared/catalog';
import { settings, type Preset } from './settings';
import { runTool } from './jobs';
import { hud } from './hud';
import { log } from './log';

const MAX_NAME = 60;

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function cleanName(name: unknown, fallback: string) {
  const n = String(name ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return n || fallback;
}

/** Kinds the preset applies to: the tool's kinds, narrowed to the files it was saved from. */
function kindsFor(toolId: string, paths: string[] | undefined): Kind[] {
  const def = TOOLS.find((t) => t.id === toolId);
  if (!def) return [];
  const from = new Set<Kind>((paths ?? []).map((p) => (isDir(p) ? 'folder' : kindOfExt(extOf(p)))));
  const narrowed = def.kinds.filter((k) => from.has(k));
  return narrowed.length ? narrowed : [...def.kinds];
}

export function listPresets(): Preset[] {
  return settings.get().presets ?? [];
}

export function getPreset(id: string): Preset | undefined {
  return listPresets().find((p) => p.id === id);
}

export function savePreset(input: { name: string; tool: string; options: unknown; paths?: string[] }): Preset {
  const def = TOOLS.find((t) => t.id === input.tool);
  if (!def) throw new Error(`Unknown tool "${input.tool}".`);
  const preset: Preset = {
    id: randomUUID().slice(0, 8),
    name: cleanName(input.name, def.label),
    tool: def.id,
    // Round-trip through JSON so only plain data is stored.
    options: JSON.parse(JSON.stringify(input.options ?? {})),
    kinds: kindsFor(def.id, input.paths),
  };
  settings.set({ presets: [...listPresets(), preset] });
  log('preset saved', preset.id, preset.tool);
  return preset;
}

export function renamePreset(id: string, name: string): Preset[] {
  settings.set({ presets: listPresets().map((p) => (p.id === id ? { ...p, name: cleanName(name, p.name) } : p)) });
  return listPresets();
}

export function deletePreset(id: string): Preset[] {
  settings.set({ presets: listPresets().filter((p) => p.id !== id) });
  return listPresets();
}

/** Whether a preset can run on these files (same rules as the tool itself). */
export function presetFits(p: Preset, paths: string[]): boolean {
  const hasFolder = paths.some(isDir);
  const exts = paths.filter((x) => !isDir(x)).map(extOf);
  if (!toolsFor(exts, hasFolder).some((t) => t.id === p.tool)) return false;
  const kinds = new Set<Kind>(exts.map(kindOfExt));
  if (hasFolder) kinds.add('folder');
  return [...kinds].every((k) => p.kinds.includes(k));
}

/** Wheel slices for the presets that fit a selection (for the Tools wheel). */
export function presetWheelItems(exts: string[], hasFolder = false) {
  const kinds = new Set<Kind>(exts.map(kindOfExt));
  if (hasFolder) kinds.add('folder');
  const fitting = new Set(toolsFor(exts, hasFolder).map((t) => t.id));
  return listPresets()
    .filter((p) => fitting.has(p.tool) && [...kinds].every((k) => p.kinds.includes(k)))
    .map((p) => {
      const def = TOOLS.find((t) => t.id === p.tool);
      return { id: `preset:${p.id}`, label: p.name, icon: def?.icon, sub: def ? `${def.label} preset` : 'Preset' };
    });
}

/** Runs a saved preset without opening the tool window. Resolves with the created files. */
export function runPreset(id: string, paths: string[]): Promise<string[]> {
  const p = getPreset(id);
  if (!p) {
    hud.notice('That preset no longer exists.');
    return Promise.resolve([]);
  }
  if (!presetFits(p, paths)) {
    hud.notice(`"${p.name}" doesn't work with ${paths.length === 1 ? 'this file' : 'these files'}.`);
    return Promise.resolve([]);
  }
  // Each run gets its own copy so a tool can't mutate the stored options.
  return runTool(p.tool, paths, structuredClone(p.options));
}

ipcMain.handle('presets:list', () => listPresets());
ipcMain.handle('presets:save', (_e, input: { name: string; tool: string; options: unknown; paths?: string[] }) => savePreset(input));
ipcMain.handle('presets:rename', (_e, id: string, name: string) => renamePreset(id, name));
ipcMain.handle('presets:delete', (_e, id: string) => deletePreset(id));
