import { app } from 'electron';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

let file = '';
let lines = 0;
const MAX = 5 * 1024 * 1024;

// Circular objects and BigInts make JSON.stringify throw, and log() runs inside the
// uncaughtException handler, where a throw ends the process.
function safeJson(p: unknown): string {
  try {
    return JSON.stringify(p);
  } catch {
    return String(p);
  }
}

export function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === 'string' ? p : safeJson(p)))
    .join(' ')}\n`;
  if (!app.isPackaged) process.stdout.write(line);
  try {
    if (!file) {
      const dir = app.getPath('logs');
      mkdirSync(dir, { recursive: true });
      file = join(dir, 'orange.log');
    }
    // Keep one previous log; cap each at ~5 MB. Checked now and then, not only at start: Orange
    // runs in the tray for weeks.
    if (lines++ % 500 === 0 && existsSync(file) && statSync(file).size > MAX) renameSync(file, join(dirname(file), 'orange.old.log'));
    appendFileSync(file, line);
  } catch {
    /* logging must never throw */
  }
}
