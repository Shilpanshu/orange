// Orange test entry point (`npm test`): `node tests/run.mjs [--selftest] [--pending] [filter]`.
// 1. `cargo test` in src-tauri with the feature cfgs below. The tests fetch the engines they need
//    (FFmpeg, 7-Zip, Ghostscript, Pandoc, ImageMagick) with the app's own downloader into
//    ORANGE_ENGINES_DIR (default: the dev profile's engines folder), once, then reuse them.
// 2. With --selftest: builds with `--features selftest` and runs `orange.exe --selftest-scenarios`,
//    which drives the wheel through its own IDropTarget in-process (never real mouse/keyboard input).
// --pending also runs the ignored cases (cargo -- --include-ignored, ORANGE_SELFTEST_PENDING=1).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const crate = join(root, 'src-tauri');
const args = process.argv.slice(2);
const selftest = args.includes('--selftest');
const pending = args.includes('--pending');
const filter = args.find((a) => !a.startsWith('--'));

const cfgs = ['orange_converters', 'orange_settings', 'orange_updater', 'orange_tools'].map((c) => `--cfg ${c}`).join(' ');
const base = { ...process.env, RUSTFLAGS: [process.env.RUSTFLAGS, cfgs].filter(Boolean).join(' ') };
if (!base.ORANGE_ENGINES_DIR) base.ORANGE_ENGINES_DIR = join(process.env.LOCALAPPDATA ?? tmpdir(), 'app.orange.converter.dev', 'engines');
const run = (cmd, a, env = {}) => spawnSync(cmd, a, { cwd: crate, stdio: 'inherit', env: { ...base, ...env } }).status ?? 1;

const testArgs = ['test', '--tests', '--no-fail-fast'];
const after = [];
if (filter) after.push(filter);
if (pending) after.push('--include-ignored');
let code = run('cargo', after.length ? [...testArgs, '--', ...after] : testArgs);

if (selftest && code === 0) {
  code = run('cargo', ['build', '--features', 'selftest']);
  if (code === 0) {
    const dir = join(tmpdir(), 'orange2-selftest');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, 'result.json');
    const exe = join(process.env.CARGO_TARGET_DIR ?? join(crate, 'target'), 'debug', 'orange.exe');
    code = run(exe, ['--selftest-scenarios', out, filter ?? ''], pending ? { ORANGE_SELFTEST_PENDING: '1' } : {});
    try {
      const r = JSON.parse(readFileSync(out, 'utf8'));
      console.log(`selftest: ${r.passed ?? 0} passed, ${r.failed ?? 0} failed, ${r.ignored ?? 0} ignored  (${out})`);
      for (const s of r.scenarios ?? []) console.log(`  ${s.status.padEnd(8)} ${s.name}${s.error ? `: ${s.error}` : s.reason ? ` (${s.reason})` : ''}`);
      if (r.error) console.log(`  error: ${r.error}`);
    } catch {
      console.log(`selftest wrote no result (${out})`);
    }
  }
}
process.exit(code);
