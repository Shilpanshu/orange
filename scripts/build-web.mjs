// Builds the Orange 2 (Tauri) frontend into web-dist/: the wheel and HUD pages from
// src/renderer (shared with Orange 1.x), plus web/ pages, each with the Tauri bridge injected.
// Usage: node scripts/build-web.mjs
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const out = join(root, 'web-dist');
rmSync(out, { recursive: true, force: true });

// page name -> source folder
const pages = {
  wheel: join(root, 'src/renderer/wheel'),
  hud: join(root, 'src/renderer/hud'),
  settings: join(root, 'web/settings'),
  // phase 2: actions/shelf/clipboard
  shelf: join(root, 'web/shelf'),
  clipboard: join(root, 'web/clipboard'),
};

await Promise.all(
  Object.entries(pages).map(([name, dir]) =>
    esbuild.build({
      entryPoints: { index: join(dir, 'index.ts') },
      outdir: join(out, 'renderer', name),
      bundle: true,
      minify: true,
      format: 'iife',
      target: 'es2022',
      inject: [join(root, 'web/bridge.ts')],
      loader: { '.svg': 'text' },
      logLevel: 'warning',
    }),
  ),
);

for (const [name, dir] of Object.entries(pages)) {
  const dest = join(out, 'renderer', name);
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.css')) cpSync(join(dir, f), join(dest, f));
    // Tauri sets the Content-Security-Policy itself (it must allow its IPC endpoint), so the
    // Electron pages' meta CSP is dropped.
    if (f.endsWith('.html')) {
      const html = readFileSync(join(dir, f), 'utf8').replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, '');
      writeFileSync(join(dest, f), html);
    }
  }
}

const shared = join(root, 'src/renderer/shared');
mkdirSync(join(out, 'renderer/shared'), { recursive: true });
for (const f of readdirSync(shared)) if (/\.(css|woff2)$/.test(f)) cpSync(join(shared, f), join(out, 'renderer/shared', f));
// [phase2-settings] The Settings page shows the app icon (../../assets from renderer/settings).
mkdirSync(join(out, 'assets'), { recursive: true });
for (const f of ['icon.png', 'icon-32.png']) cpSync(join(root, 'assets', f), join(out, 'assets', f));
// ---------------------------------------------------------------- [phase2-tools] tool windows
// renderer/tool: a small router plus one ES-module entry per tool page (web/tool/pages.ts), sharing
// chunks, as in 1.x. Each entry first loads the tool's "main process" (web/tool/host: the 1.x
// ops modules on Node shims, running in the page) and then builds the page.
{
  const toolDir = join(root, 'web/tool');
  const toolOut = join(out, 'renderer/tool');
  const node = (m) => join(toolDir, 'host/node', `${m}.ts`);
  const alias = {
    electron: node('electron'),
    sharp: node('sharp'),
    events: node('events'),
  };
  for (const m of ['fs', 'path', 'os', 'url', 'crypto', 'zlib', 'child_process', 'module', 'async_hooks', 'util', 'stream', 'events']) {
    alias[`node:${m}`] = node(m);
    alias[m] = node(m);
  }
  alias['node:fs/promises'] = node('fs');
  alias['fs/promises'] = node('fs');
  const { outputFiles } = await esbuild.build({ entryPoints: [join(toolDir, 'pages.ts')], bundle: true, write: false, format: 'esm', logLevel: 'silent' });
  const { PAGES } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
  const entryPoints = { index: join(toolDir, 'index.ts') };
  for (const id of Object.keys(PAGES)) entryPoints[`pages/${id}`] = `tool-page:${id}`;
  entryPoints['pages/_run'] = 'tool-page:_run'; // hidden window: instant tools and presets
  entryPoints['pages/_test'] = 'tool-page:_test'; // blank window the test runner drives (src-tauri/tests)
  const NL = String.fromCharCode(10);
  const toolPages = {
    name: 'tool-pages',
    setup(b) {
      b.onResolve({ filter: /^tool-page:/ }, (a) => ({ path: a.path.slice('tool-page:'.length), namespace: 'tool-page' }));
      b.onLoad({ filter: /.*/, namespace: 'tool-page' }, (a) => {
        const id = a.path;
        const contents =
          id === '_test'
            ? [`import { prepareTools } from './host/router';`, `import { ready } from './start';`, `import { args } from '../shared/ui';`, `await prepareTools(args().tools ?? []);`, `ready();`].join(NL)
            : id === '_run'
            ? [`import { prepare } from './host/router';`, `import { runInstant } from './start';`, `import { args } from '../shared/ui';`, `await prepare(args().tool);`, `runInstant();`].join(NL)
            : [`import { prepare } from './host/router';`, `import { start, ready } from './start';`, `import { ${PAGES[id][1]} as page } from './${PAGES[id][0]}';`, `await prepare(${JSON.stringify(id)});`, `start(page);`, `ready();`].join(NL);
        return { resolveDir: toolDir, loader: 'ts', contents };
      });
    },
  };
  await esbuild.build({
    entryPoints,
    outdir: toolOut,
    bundle: true,
    minify: true,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    target: 'es2023',
    inject: [join(root, 'web/bridge.ts'), node('globals')],
    alias,
    // Node-only optional requires inside the ported modules / their libraries.
    external: ['onnxruntime-node', 'heic-convert', 'heic-decode', 'libheif-js'],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': 'location.href' },
    loader: { '.svg': 'text', '.woff2': 'file', '.wasm': 'file' },
    plugins: [toolPages],
    logLevel: 'warning',
  });
  const html = readFileSync(join(toolDir, 'index.html'), 'utf8').replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, '');
  writeFileSync(join(toolOut, 'index.html'), html);
  cpSync(join(toolDir, 'tool.css'), join(toolOut, 'tool.css'));
  // The tool pages' own shared kit (web/shared: caption buttons for undecorated windows).
  for (const f of readdirSync(join(root, 'web/shared'))) if (/\.(css|woff2)$/.test(f)) cpSync(join(root, 'web/shared', f), join(out, 'renderer/shared', f));
  cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });
  // pdf.js (+ worker, fonts, wasm decoders), MediaPipe and tesseract.js for the image/PDF tools.
  const pdfjs = join(root, 'node_modules/pdfjs-dist/build');
  mkdirSync(join(out, 'vendor/pdfjs'), { recursive: true });
  for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) if (existsSync(join(pdfjs, f))) cpSync(join(pdfjs, f), join(out, 'vendor/pdfjs', f));
  for (const d of ['standard_fonts', 'wasm']) if (existsSync(join(pdfjs, '..', d))) cpSync(join(pdfjs, '..', d), join(out, 'vendor/pdfjs', d), { recursive: true });
  const { copyImageAssets } = await import('./build-assets-image.mjs');
  copyImageAssets(root, out);
  // tesseract.js's browser worker isn't prebuilt in node_modules: build it.
  const ts = join(out, 'vendor/tesseract');
  if (!existsSync(join(ts, 'worker.min.js'))) {
    await esbuild.build({
      entryPoints: [join(root, 'node_modules/tesseract.js/src/worker-script/browser/index.js')],
      outfile: join(ts, 'worker.min.js'),
      bundle: true,
      minify: true,
      format: 'iife',
      platform: 'browser',
      logLevel: 'warning',
    });
  }
  // onnxruntime-web's WebAssembly binary (27 MB) is NOT shipped: the AI tools download it on first use
  // (src-tauri/src/engines.rs "ai-runtime"). The glue script is inside the bundled onnxruntime-web/webgpu build.
  if (!existsSync(join(toolOut, 'pages/cropImage.js'))) throw new Error('tool pages missing');
}

// Tauri wants an index page at the root; nothing loads it.
writeFileSync(join(out, 'index.html'), '<!doctype html><title>Orange</title>');
if (!existsSync(join(out, 'renderer/wheel/index.js'))) throw new Error('wheel bundle missing');
console.log('web-dist built');
