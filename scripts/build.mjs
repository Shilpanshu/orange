// Bundles main, preload and every renderer page with esbuild.
// Usage: node scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { copyImageAssets } from './build-assets-image.mjs';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
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

const toolConfig = await toolPageConfig();

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
    // The tool window hosts 30-odd tools: it is ES modules split per tool instead (below).
    ...(p === 'tool' ? toolConfig : {}),
  })),
];

/**
 * The tool window: a small router plus one entry per tool page (renderer/tool/pages/<id>.js,
 * listed in src/renderer/tool/pages.ts), sharing code through chunks. A window then fetches and
 * parses only the tool it shows instead of all of them.
 */
async function toolPageConfig() {
  const dir = join(root, 'src/renderer/tool');
  const { outputFiles } = await esbuild.build({ entryPoints: [join(dir, 'pages.ts')], bundle: true, write: false, format: 'esm', logLevel: 'silent' });
  const { PAGES } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
  const entryPoints = { 'renderer/tool/index': 'src/renderer/tool/index.ts' };
  for (const id of Object.keys(PAGES)) entryPoints[`renderer/tool/pages/${id}`] = `tool-page:${id}`;
  const toolPages = {
    name: 'tool-pages',
    setup(b) {
      b.onResolve({ filter: /^tool-page:/ }, (a) => ({ path: a.path.slice('tool-page:'.length), namespace: 'tool-page' }));
      b.onLoad({ filter: /.*/, namespace: 'tool-page' }, (a) => {
        const [mod, name] = PAGES[a.path];
        const contents = [`import { start } from './start';`, `import { ${name} } from './${mod}';`, `start(${name});`].join('\n');
        return { resolveDir: dir, loader: 'ts', contents };
      });
    },
  };
  return { format: 'esm', splitting: true, entryPoints, chunkNames: 'renderer/tool/chunks/[name]-[hash]', plugins: [toolPages] };
}

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
    // Standard fonts (for PDFs that don't embed them) and the JPEG 2000 / colour wasm decoders.
    for (const d of ['standard_fonts', 'wasm']) {
      const src = join(pdfjs, '..', d);
      if (existsSync(src)) cpSync(src, join(out, 'vendor/pdfjs', d), { recursive: true });
    }
  }
}

copyStatic();
// Chunk names carry a content hash: drop the previous build's so stale chunks don't pile up in dist.
if (!watch) for (const d of ['chunks', 'pages']) rmSync(join(out, 'renderer/tool', d), { recursive: true, force: true });
if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
