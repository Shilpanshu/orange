import { app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// dist/ when running from source, resources/app.asar/dist when packaged.
export const distDir = __dirname;

// Bundled command-line tools (ffmpeg, 7z, pandoc, magick, gs, helper).
export const binDir = app.isPackaged ? join(process.resourcesPath, 'bin') : join(__dirname, '..', 'vendor', 'bin');

export function bin(name: string): string {
  const exe = join(binDir, name.endsWith('.exe') ? name : `${name}.exe`);
  return exe;
}

export function hasBin(name: string): boolean {
  return existsSync(bin(name));
}

export const page = (name: string) => join(distDir, 'renderer', name, 'index.html');
export const asset = (name: string) => join(distDir, 'assets', name);
