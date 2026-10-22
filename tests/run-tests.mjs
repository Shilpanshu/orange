// Orange regression suite launcher: `npm test`.
// Bundles tests/run.ts the way scripts/build.mjs bundles main (same externals), then runs it inside
// Electron's main process with a private userData folder, so it never touches (or collides with) an
// installed Orange that is running and holding the single-instance lock.
//
// Env knobs (all optional):
//   ORANGE_TEST_AI=1          also run the AI tools that download models (Remove BG, Upscale, Subtitles from speech)
//   ORANGE_TEST_OFFICE=1      let Word/PowerPoint run over hidden COM (Excel is always kept off; see run.ts)
//   ORANGE_TEST_FILTER=text   only run cases whose "group name" contains this text (case-insensitive)
//   ORANGE_TEST_JOBS=n        cases run in parallel (default 4)
//   ORANGE_TEST_REPORT_DIR=d  also copy report.json / junit.xml there (handy in CI)
//   ORANGE_TEST_KEEP=1        keep earlier runs' temp folders
import * as esbuild from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const buildDir = join(root, 'tests', '.build');
const bundle = join(buildDir, 'run.js');

// A fresh `npm ci` can skip Electron's postinstall download (npm allow-scripts); fetch the binary once.
if (!existsSync(electronExe)) {
  console.log('Electron binary missing; downloading it…');
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'electron', 'install.js')], { stdio: 'inherit' });
  if (r.status !== 0) console.error('Electron download failed.');
}

for (const need of [electronExe, join(root, 'vendor', 'bin', 'ffmpeg.exe'), join(root, 'vendor', 'bin', '7z.exe')]) {
  if (!existsSync(need)) {
    console.error(`Missing ${need}. Run "npm install" and "npm run vendor" first.`);
    process.exit(2);
  }
}

// ------------------------------------------------------------------ bundle
// Same externals as scripts/build.mjs: native / heavy modules load from node_modules at runtime.
const external = [
  'electron', 'uiohook-napi', 'sharp', 'exceljs', 'pdfjs-dist', 'heic-convert', 'heic-decode', 'libheif-js',
  '@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-common', 'tesseract.js',
];
const t0 = Date.now();
await esbuild.build({
  entryPoints: { run: join(root, 'tests', 'run.ts') },
  outdir: buildDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2023',
  sourcemap: 'linked',
  external,
  logLevel: 'warning',
  // src/main/paths.ts derives vendor/bin and dist/ from __dirname (dist/ when run from source). The test
  // bundle lives in tests/.build, so pin __dirname to <repo>/dist to resolve the very same folders.
  define: { __dirname: JSON.stringify(join(root, 'dist')) },
});

// ------------------------------------------------------------------ run folder (system temp, never the repo)
const base = join(tmpdir(), 'orange-tests');
mkdirSync(base, { recursive: true });
if (!process.env.ORANGE_TEST_KEEP) {
  for (const d of readdirSync(base)) {
    const p = join(base, d);
    // A model-cache junction may point at the real Orange profile: unlink it first, never recurse into it.
    const models = join(p, 'userdata', 'models');
    try {
      if (lstatSync(models).isSymbolicLink()) unlinkSync(models);
    } catch {
      /* none */
    }
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* a file still locked by an earlier crashed run; ignore */
    }
  }
}
const runDir = join(base, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(runDir, { recursive: true });

// ------------------------------------------------------------------ launch Electron
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set inside VS Code terminals; would make electron.exe act as plain node
env.ORANGE_REPO = root;
env.ORANGE_TEST_RUN_DIR = runDir;
env.ORANGE_USER_DATA = join(runDir, 'userdata');
env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

console.log(`Orange regression suite  (bundle ${Date.now() - t0} ms)  run folder: ${runDir}`);
// Chromium's own stderr chatter goes to a file; it is only shown when Electron itself crashes.
const errLog = createWriteStream(join(runDir, 'electron-stderr.log'));
const child = spawn(electronExe, [bundle], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
child.stdout.on('data', (chunk) => process.stdout.write(chunk));
const errTail = [];
child.stderr.on('data', (chunk) => {
  errLog.write(chunk);
  errTail.push(chunk.toString('utf8'));
  if (errTail.length > 40) errTail.shift();
});

const code = await new Promise((resolve) => {
  child.on('error', (e) => {
    console.error('Could not start Electron:', e.message);
    resolve(2);
  });
  child.on('close', (c) => resolve(c ?? 1));
});
errLog.end();
if (code !== 0 && code !== 1) {
  console.error(`\nElectron exited with code ${code}. Last stderr:\n${errTail.join('').split(/\r?\n/).slice(-25).join('\n')}`);
}
process.exit(code);
