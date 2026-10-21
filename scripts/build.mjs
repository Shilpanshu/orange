// Bundles main, preload and every renderer page with esbuild.
// Usage: node scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { copyImageAssets } from './build-assets-image.mjs';

const watch = process.argv.includes('--watch');
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });

// Native / heavy modules stay external and are shipped in node_modules. Everything else is bundled, so
// only these (plus what the AI tools load with createRequire: transformers.js, onnxruntime-node,
// tesseract.js) need to be production "dependencies" in package.json; bundled-only packages are
// devDependencies, which keeps them out of the installer.
const external = [
  'electron', 'uiohook-napi', 'sharp', 'exceljs', 'pdfjs-dist', 'heic-convert', 'heic-decode', 'libheif-js',
  '@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-common', 'tesseract.js',
];

const common = {
  bundle: true,
  sourcemap: 'linked',
  logLevel: 'info',
  target: 'es2023',
};

const pages = readdirSync(join(root, 'src/renderer')).filter(
  (d) => d !== 'shared' && existsSync(join(root, 'src/renderer', d, 'index.ts')),
);

const configs = [
  { ...common, platform: 'node', format: 'cjs', external, entryPoints: { main: 'src/main/main.ts' }, outdir: out },
  { ...common, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: { preload: 'src/preload/preload.ts' }, outdir: out },
  ...pages.map((p) => ({
    ...common,
    platform: 'browser',
    format: 'iife',
    entryPoints: { [`renderer/${p}/index`]: `src/renderer/${p}/index.ts` },
    outdir: out,
    loader: { '.svg': 'text', '.woff2': 'file' },
  })),
];

function copyStatic() {
  for (const p of pages) {
    const dir = join(root, 'src/renderer', p);
    for (const f of readdirSync(dir)) {
      if (/\.(html|css)$/.test(f)) cpSync(join(dir, f), join(out, 'renderer', p, f));
    }
  }
  const shared = join(root, 'src/renderer/shared');
  for (const f of readdirSync(shared)) {
    if (/\.(css|woff2|svg|png)$/.test(f) && statSync(join(shared, f)).isFile()) {
      mkdirSync(join(out, 'renderer/shared'), { recursive: true });
      cpSync(join(shared, f), join(out, 'renderer/shared', f));
    }
  }
  cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });
  // MediaPipe wasm + tesseract worker/core/language data for offline redaction.
  copyImageAssets(root, out);
  // pdf.js worker for the PDF renderer page.
  const pdfjs = join(root, 'node_modules/pdfjs-dist/build');
  if (existsSync(pdfjs)) {
    mkdirSync(join(out, 'vendor/pdfjs'), { recursive: true });
    for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
      if (existsSync(join(pdfjs, f))) cpSync(join(pdfjs, f), join(out, 'vendor/pdfjs', f));
    }
  }
}

copyStatic();
if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
