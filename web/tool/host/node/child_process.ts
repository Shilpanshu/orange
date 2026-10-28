// node:child_process over tools_spawn (src-tauri/src/tools.rs). spawn() returns a ChildProcess-like
// emitter: stdout/stderr 'data' chunks (Buffers, binary-safe), 'close'/'exit' with the code,
// 'error' when the exe can't start, kill(). Data written to stdin before the next tick is sent in
// one piece (all the ported code writes stdin synchronously, right after spawning).
import { Buffer } from 'buffer';
import { Channel, b64ToBytes, bytesToB64, invoke, uniqueId } from '../native';
import { EventEmitter } from './events';

class Pipe extends EventEmitter {
  setEncoding(e: BufferEncoding) {
    this.enc = e;
    return this;
  }
  enc: BufferEncoding | null = null;
  push(b: Uint8Array) {
    const buf = Buffer.from(b);
    this.emit('data', this.enc ? buf.toString(this.enc) : buf);
  }
  destroy() {}
  resume() {
    return this;
  }
}

class Stdin extends EventEmitter {
  chunks: Uint8Array[] = [];
  ended = false;
  write(c: any) {
    this.chunks.push(typeof c === 'string' ? new TextEncoder().encode(c) : new Uint8Array(c.buffer ?? c, c.byteOffset ?? 0, c.byteLength ?? c.length));
    return true;
  }
  end(c?: any) {
    if (c !== undefined && c !== null) this.write(c);
    this.ended = true;
  }
  destroy() {}
}

export class ChildProcess extends EventEmitter {
  stdout = new Pipe();
  stderr = new Pipe();
  stdin = new Stdin();
  pid: number;
  exitCode: number | null = null;
  killed = false;
  constructor(exe: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
    super();
    this.pid = uniqueId();
    const id = this.pid;
    let result: { code: number; killed: boolean } | null = null;
    let ended = false;
    const maybeFinish = () => {
      if (!result || !ended) return;
      const r = result;
      result = null;
      this.finish(r.killed || this.killed ? null : r.code, r.killed || this.killed ? 'SIGKILL' : null);
    };
    const ch = new Channel<[string, string]>((m) => {
      if (m[0] === 'x') {
        ended = true;
        maybeFinish();
        return;
      }
      const bytes = b64ToBytes(m[1]);
      (m[0] === 'o' ? this.stdout : this.stderr).push(bytes);
    });
    // Let the caller attach listeners and write stdin first.
    setTimeout(() => {
      if (this.killed) {
        this.finish(null, 'SIGKILL');
        return;
      }
      const input = this.stdin.chunks.length ? concat(this.stdin.chunks) : null;
      const env: Record<string, string> = {};
      // Extras only: the child inherits this app's own environment.
      for (const [k, v] of Object.entries(opts.env ?? {})) if (typeof v === 'string') env[k] = v;
      invoke<{ code: number; killed: boolean }>('tools_spawn', {
        op: { exe, args, cwd: opts.cwd ?? null, env, stdinB64: input ? bytesToB64(input) : null, id },
        onData: ch,
      }).then(
        (r) => {
          result = r;
          maybeFinish();
        },
        (e) => {
          const msg = String(e);
          const err = Object.assign(new Error(msg), { code: /ENOENT/.test(msg) ? 'ENOENT' : 'EIO', errno: -1, path: exe, spawnargs: args });
          this.emit('error', err);
        },
      );
    }, 0);
  }
  private finish(code: number | null, signal: string | null) {
    this.exitCode = code;
    this.stdout.emit('end');
    this.stderr.emit('end');
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
  kill(_sig?: string) {
    this.killed = true;
    void invoke('tools_kill', { id: this.pid });
    return true;
  }
}

function concat(list: Uint8Array[]) {
  const n = list.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of list) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function spawn(exe: string, args: string[] = [], opts: { cwd?: string; env?: Record<string, string | undefined>; windowsHide?: boolean } = {}) {
  return new ChildProcess(exe, args, opts);
}

export function execFile(
  exe: string,
  args: string[],
  opts: any,
  cb?: (err: Error | null, stdout: string, stderr: string) => void,
) {
  if (typeof opts === 'function') {
    cb = opts;
    opts = {};
  }
  const c = spawn(exe, args, opts);
  let out = '';
  let err = '';
  c.stdout.on('data', (d: Buffer) => (out += d.toString()));
  c.stderr.on('data', (d: Buffer) => (err += d.toString()));
  c.on('error', (e: Error) => cb?.(e, out, err));
  c.on('close', (code: number) => cb?.(code === 0 ? null : Object.assign(new Error(`exit ${code}: ${err.slice(-500)}`), { code }), out, err));
  return c;
}

export default { spawn, execFile, ChildProcess };
