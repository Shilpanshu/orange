// Client for orange-helper.exe (Explorer selection, file clipboard, share sheet).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { bin, hasBin } from './paths';
import { log } from './log';

let proc: ChildProcessWithoutNullStreams | null = null;
let seq = 0;
const pending = new Map<number, { owner: ChildProcessWithoutNullStreams; resolve: (v: any) => void; reject: (e: Error) => void }>();

/** Forgets a helper that exited, failed to start or stopped answering; the next call starts a new one. */
function drop(child: ChildProcessWithoutNullStreams, why: string) {
  if (proc === child) proc = null;
  for (const [id, p] of pending) {
    if (p.owner !== child) continue;
    pending.delete(id);
    p.reject(new Error(why));
  }
}

export function startHelper() {
  if (proc || !hasBin('orange-helper')) return;
  const child = spawn(bin('orange-helper'), [], { windowsHide: true });
  proc = child;
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(String(msg.result)));
    } catch (e) {
      log('helper parse', e);
    }
  });
  // Without these, a failed spawn or a write to a dead helper is an uncaught error and the
  // stale process object is kept forever.
  child.on('error', (e) => {
    log('helper error', e);
    drop(child, 'helper failed');
  });
  child.stdin.on('error', (e) => log('helper stdin', e));
  child.on('exit', () => drop(child, 'helper exited'));
}

export function callHelper<T>(cmd: string, args: unknown[] = [], timeoutMs = 5000): Promise<T> {
  startHelper();
  const child = proc;
  if (!child) return Promise.reject(new Error('Orange helper is missing'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`helper timeout: ${cmd}`));
      // It answers one request at a time, so a stuck call (a hung Explorer, say) would block
      // every later one. Replace it.
      log('helper not answering; restarting', cmd);
      drop(child, 'helper restarted');
      child.kill();
    }, timeoutMs);
    pending.set(id, {
      owner: child,
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
  });
}

export async function explorerSelection(): Promise<string[]> {
  try {
    return (await callHelper<string[]>('selection')) ?? [];
  } catch (e) {
    log('selection failed', e);
    return [];
  }
}
