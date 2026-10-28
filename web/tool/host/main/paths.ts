// Orange 1.x's main/paths.ts for the tool window: where the bundled tools live (tools.rs finds them).
import { INFO } from '../native';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const distDir = '';
/** Folder of the bundled tools (read after initNative()). */
export let binDir = "";
export function setBinDir(d: string) {
  binDir = d;
}
const exeName = (name: string) => (name.endsWith('.exe') ? name : `${name}.exe`);

/** Path of a bundled tool ("ffmpeg", "gs/bin/gswin64c"). */
/** A source checkout's vendor/bin copy, else the bare name: tools_spawn then gets it from the
 *  engine store (downloaded on first use). */
export function bin(name: string): string {
  const local = join(INFO.binDir, exeName(name));
  return INFO.binDir && existsSync(local) ? local : name;
}
export function hasBin(_name: string): boolean {
  return true;
}
export const prepareBin = async (name: string) => bin(name);
export const page = (name: string) => name;
export const asset = (name: string) => name;
