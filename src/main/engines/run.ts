// Spawns command-line tools with cancellation, stderr capture and optional progress parsing.
import { spawn } from 'node:child_process';
import { bin } from '../paths';
import { log } from '../log';

export interface RunOptions {
  signal?: AbortSignal;
  cwd?: string;
  /** Called with each stderr/stdout line; use to parse progress. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Bytes to write to stdin. */
  input?: string | Buffer;
  env?: Record<string, string>;
  /** Treat these exit codes as success too (e.g. 7z returns 1 for warnings). */
  okCodes?: number[];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run an executable. `exe` may be a bundled tool name ("ffmpeg") or an absolute path. */
export function run(exe: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const path = /[\\/]/.test(exe) ? exe : bin(exe);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('Cancelled'));
    const child = spawn(path, args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    const feed = (stream: 'stdout' | 'stderr') => {
      let buf = '';
      return (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        if (stream === 'stdout') stdout += s;
        else stderr = (stderr + s).slice(-64_000);
        if (!opts.onLine) return;
        buf += s;
        const parts = buf.split(/\r\n|\n|\r/);
        buf = parts.pop() ?? '';
        for (const line of parts) opts.onLine(line, stream);
      };
    };
    child.stdout.on('data', feed('stdout'));
    child.stderr.on('data', feed('stderr'));
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error('Cancelled'));
      const c = code ?? -1;
      if (c === 0 || opts.okCodes?.includes(c)) resolve({ code: c, stdout, stderr });
      else {
        log(`${exe} failed (${c})`, args.join(' '), stderr.slice(-2000));
        reject(new Error(lastMeaningfulLine(stderr) || `${exe} exited with code ${c}`));
      }
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function lastMeaningfulLine(s: string) {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-1)[0] ?? '';
}
