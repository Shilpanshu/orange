// Client for orange-helper.exe (Explorer selection, file clipboard, share sheet).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { bin, hasBin } from './paths';
import { log } from './log';

let proc: ChildProcessWithoutNullStreams | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

export function startHelper() {
  if (proc || !hasBin('orange-helper')) return;
  proc = spawn(bin('orange-helper'), [], { windowsHide: true });
  createInterface({ input: proc.stdout }).on('line', (line) => {
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
  proc.on('exit', () => {
    proc = null;
    for (const p of pending.values()) p.reject(new Error('helper exited'));
    pending.clear();
  });
}

export function callHelper<T>(cmd: string, args: unknown[] = [], timeoutMs = 5000): Promise<T> {
  startHelper();
  if (!proc) return Promise.reject(new Error('Orange helper is missing'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`helper timeout: ${cmd}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    proc!.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
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
