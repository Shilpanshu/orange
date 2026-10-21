import { app } from 'electron';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

let file = '';

export function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}\n`;
  if (!app.isPackaged) process.stdout.write(line);
  try {
    if (!file) {
      const dir = app.getPath('logs');
      mkdirSync(dir, { recursive: true });
      file = join(dir, 'orange.log');
      // Keep one previous log; cap each at ~5 MB.
      if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, join(dir, 'orange.old.log'));
    }
    appendFileSync(file, line);
  } catch {
    /* logging must never throw */
  }
}
