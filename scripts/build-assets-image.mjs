// Copies the offline runtimes the image tools need into dist/vendor:
//   dist/vendor/mediapipe/  MediaPipe Tasks Vision wasm (face detection in Redact)
//   dist/vendor/tesseract/  tesseract.js worker + LSTM cores + English data (text detection in Redact)
// The BlazeFace model itself lives in assets/models/ (copied with the rest of assets/).
// Usage: import { copyImageAssets } from './build-assets-image.mjs'; copyImageAssets(root, out)
//    or: node scripts/build-assets-image.mjs
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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

  const mp = join(out, 'vendor/mediapipe');
  for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
    copy(`@mediapipe/tasks-vision/wasm/${f}`, mp);
  }

  const ts = join(out, 'vendor/tesseract');
  copy('tesseract.js/dist/worker.min.js', ts);
  // LSTM-only cores (the page asks for OEM 1); tesseract.js picks the variant by SIMD support.
  for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
    copy(`tesseract.js-core/${f}`, ts);
  }
  copy('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', join(ts, 'lang'));
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('build-assets-image.mjs')) {
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  copyImageAssets(root, join(root, 'dist'));
  console.log('[image assets] copied to dist/vendor');
}
