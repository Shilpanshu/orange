// Copies the offline runtimes the image tools need into dist/vendor:
//   dist/vendor/mediapipe/  MediaPipe Tasks Vision wasm (face detection in Redact)
//   dist/vendor/tesseract/  tesseract.js worker + LSTM cores + English data (text detection in Redact)
// The BlazeFace model itself lives in assets/models/ (copied with the rest of assets/).
// Usage: import { copyImageAssets } from './build-assets-image.mjs'; copyImageAssets(root, out)
//    or: node scripts/build-assets-image.mjs
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function copyImageAssets(root, out) {
  const nm = join(root, 'node_modules');
  const copy = (from, toDir, name) => {
    const src = join(nm, from);
    if (!existsSync(src)) {
      console.warn(`[image assets] missing ${from}`);
      return;
    }
    mkdirSync(toDir, { recursive: true });
    cpSync(src, join(toDir, name ?? from.split('/').pop()));
  };

  // Only the SIMD build: FilesetResolver picks it whenever WebAssembly SIMD validates, which it always
  // does in Electron's Chromium (SIMD shipped in Chrome 91), so the ~13 MB no-SIMD build is never loaded.
  const mp = join(out, 'vendor/mediapipe');
  // Only the small loader script ships; the 13 MB .wasm downloads on first use (src-tauri/src/engines.rs "mediapipe").
  copy('@mediapipe/tasks-vision/wasm/vision_wasm_internal.js', mp);
  for (const f of ['vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm', 'vision_wasm_internal.wasm']) rmSync(join(mp, f), { force: true });

  const ts = join(out, 'vendor/tesseract');
  copy('tesseract.js/dist/worker.min.js', ts);
  // LSTM-only cores (the page asks for OEM 1). tesseract.js picks relaxed-SIMD, then SIMD, then plain by
  // feature detection; Electron's Chromium has relaxed SIMD (Chrome 114+), so the plain build is dropped
  // and the SIMD one is kept only as the next step down.
  // Only the relaxed-SIMD core ships (WebView2 is Chromium 114+, which has it); the plain SIMD core would add
  // about 1.7 MB to the exe for runtimes that no longer exist.
  copy('tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', ts);
  for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) rmSync(join(ts, f), { force: true });
  // English data (3 MB) is not shipped: it downloads on first use (src-tauri/src/engines.rs "tesseract-eng").
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('build-assets-image.mjs')) {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
  copyImageAssets(root, join(root, 'dist'));
  console.log('[image assets] copied to dist/vendor');
}
