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
// Tauri wants an index page at the root; nothing loads it.
writeFileSync(join(out, 'index.html'), '<!doctype html><title>Orange</title>');
if (!existsSync(join(out, 'renderer/wheel/index.js'))) throw new Error('wheel bundle missing');
console.log('web-dist built');
