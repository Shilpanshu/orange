// AI tools that run fully on this PC: OCR (tesseract.js), Remove BG (RMBG-1.4) and Upscale (Real-ESRGAN).
// Models download once through engines/ai.ts and then work offline. Heavy pixel work goes through sharp
// (libvips thread pool) and ONNX Runtime (its own threads), so the main process stays responsive; Cancel
// is checked between tiles, pages and files.
//
// Windows talk to this module over IPC:
//   ai:status   (tool, paths, options) → model state, device and a time estimate
//   ai:bgPreview (path, options)        → before/after cut-out at screen size (model runs once per file)
//   ai:upPreview (path, options)        → before/after crop of the upscaled image
// Long first-use downloads triggered by a preview report progress on 'ai:progress'.
import { ipcMain, type WebContents } from 'electron';
import sharp, { type Sharp } from 'sharp';
import { PDFDocument, degrees } from 'pdf-lib';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extOf } from '../../shared/catalog';
import { binDir } from '../paths';
import { run } from '../engines/run';
import { log } from '../log';
import {
  type AiCtx,
  type Device,
  ensureFiles,
  estimateMs,
  floatTensor,
  isReady,
  loadModel,
  loadOnnx,
  markDmlFailed,
  modelDef,
  modelFile,
  modelStatus,
  recordTiming,
  registerModel,
  transformers,
} from '../engines/ai';
import { toBrowserImage } from './convert-image';
import { loadPdf } from './tools-pdf';
import type { Ctx, ToolFn } from './types';
import { UserError } from './types';

const nodeRequire = createRequire(__filename);
const stem = (p: string) => basename(p, extname(p));

// ===================================================================== models

registerModel({
  id: 'rmbg',
  label: 'the background-removal model',
  repo: 'briaai/RMBG-1.4',
  files: ['config.json', 'onnx/model.onnx'],
  mb: 176,
  licence: 'BRIA RMBG-1.4 licence: free for non-commercial use',
  msPerUnit: { cpu: 2300, dml: 650 },
});

// Real-ESRGAN's compact networks: tiny, fast on a CPU, and good. Pinned to a commit and checksummed.
registerModel({
  id: 'upscale-photo',
  label: 'the photo upscaler',
  repo: 'vlad-grig/realesr-general-x4v3-onnx',
  revision: '0e95d93e454cf6b5de9bdf5a1c9e7ec340d38231',
  files: ['onnx/model.onnx'],
  sha256: { 'onnx/model.onnx': '7b10e80021ec3e0ff35017ae5022791879d93a799b2e201e1010a37510202266' },
  mb: 5,
  licence: 'BSD-3-Clause (Real-ESRGAN general v3)',
  msPerUnit: { cpu: 850, dml: 300 },
});
registerModel({
  id: 'upscale-art',
  label: 'the illustration upscaler',
  repo: 'xiongjie/lightweight-real-ESRGAN-anime',
  revision: '695895c3a4ab540e3710b5e4a3d6f7e734bc1668',
  files: ['RealESRGAN_x4plus_anime_4B32F.onnx'],
  sha256: { 'RealESRGAN_x4plus_anime_4B32F.onnx': '2208c7ae8db793330abf1248fbce15585ad317e921c456265572836b92926c9a' },
  mb: 5,
  licence: 'MIT (Real-ESRGAN anime, 4 blocks)',
  msPerUnit: { cpu: 1600, dml: 500 },
});

/** OCR languages. English ships with Orange; the rest download once (1–3 MB each) from jsDelivr. */
export const OCR_LANGS: { code: string; name: string; mb: number }[] = [
  { code: 'eng', name: 'English', mb: 3 },
  { code: 'spa', name: 'Spanish', mb: 2 },
  { code: 'fra', name: 'French', mb: 1 },
  { code: 'deu', name: 'German', mb: 1 },
  { code: 'ita', name: 'Italian', mb: 2 },
  { code: 'por', name: 'Portuguese', mb: 1 },
  { code: 'nld', name: 'Dutch', mb: 3 },
  { code: 'pol', name: 'Polish', mb: 3 },
  { code: 'tur', name: 'Turkish', mb: 2 },
  { code: 'rus', name: 'Russian', mb: 3 },
  { code: 'ukr', name: 'Ukrainian', mb: 2 },
  { code: 'hin', name: 'Hindi', mb: 1 },
  { code: 'ben', name: 'Bengali', mb: 1 },
  { code: 'tam', name: 'Tamil', mb: 1 },
  { code: 'ara', name: 'Arabic', mb: 2 },
  { code: 'chi_sim', name: 'Chinese (Simplified)', mb: 2 },
  { code: 'jpn', name: 'Japanese', mb: 2 },
  { code: 'kor', name: 'Korean', mb: 2 },
  { code: 'vie', name: 'Vietnamese', mb: 1 },
];
for (const l of OCR_LANGS) {
  const file = `${l.code}.traineddata.gz`;
  registerModel({
    id: `ocr-${l.code}`,
    label: `${l.name} text recognition`,
    repo: 'tessdata',
    files: [file],
    urls: { [file]: `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${l.code}/4.0.0_best_int/${file}` },
    mb: l.mb,
    licence: 'Apache-2.0 (Tesseract)',
    msPerUnit: { cpu: 3500 },
  });
}

// ===================================================================== shared helpers

// Formats sharp decodes in this build; others (HEIC, BMP, ICO, JXL) are decoded to PNG first.
const SHARP_IN = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'tif', 'tiff', 'avif', 'gif', 'svg']);

async function readable(input: string, tmp: () => string): Promise<string> {
  if (SHARP_IN.has(extOf(input))) return input;
  const out = join(tmp(), `${stem(input)}.png`);
  await toBrowserImage(input, out);
  return out;
}

const LIMIT = { limitInputPixels: 268_402_689, failOn: 'none' as const };

/** Upright sRGB pixels of an image: RGB plus its alpha channel when it has one. */
async function decodeRgb(path: string): Promise<{ rgb: Buffer; alpha: Buffer | null; w: number; h: number; icc: boolean }> {
  const meta = await sharp(path, LIMIT).metadata();
  const base = () => sharp(path, { ...LIMIT, animated: false }).autoOrient().toColourspace('srgb');
  const { data, info } = await base().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let alpha: Buffer | null = null;
  if (meta.hasAlpha) {
    alpha = await base().ensureAlpha().extractChannel(3).raw().toBuffer();
    // Fully opaque alpha is no alpha.
    if (alpha.every((v) => v === 255)) alpha = null;
  }
  return { rgb: data, alpha, w: info.width, h: info.height, icc: !!meta.icc };
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

/** A progress reporter for part of a job: maps 0..1 into [a, b] of the parent's progress. */
function sub(ctx: AiCtx, a: number, b: number, prefix = ''): AiCtx {
  return {
    signal: ctx.signal,
    progress: (f, note) => ctx.progress?.(a + (b - a) * Math.min(1, Math.max(0, f)), note ? prefix + note : undefined),
  };
}

/** Output extension for "same format as the source" (formats sharp can't write become JPG or PNG). */
function sameFormat(input: string, hasAlpha: boolean): 'jpg' | 'png' | 'webp' | 'tiff' | 'avif' {
  const e = extOf(input);
  if (['jpg', 'jpeg', 'jfif'].includes(e)) return 'jpg';
  if (e === 'webp') return 'webp';
  if (e === 'tif' || e === 'tiff') return 'tiff';
  if (e === 'avif') return 'avif';
  if (['heic', 'heif'].includes(e)) return hasAlpha ? 'png' : 'jpg';
  return 'png';
}

function encode(img: Sharp, fmt: string): Sharp {
  switch (fmt) {
    case 'jpg':
      return img.jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' });
    case 'webp':
      return img.webp({ quality: 92, alphaQuality: 100, effort: 4 });
    case 'tiff':
      return img.tiff({ compression: 'lzw', predictor: 'horizontal' });
    case 'avif':
      return img.avif({ quality: 70, effort: 4 });
    default:
      return img.png({ compressionLevel: 6, adaptiveFiltering: true });
  }
}

async function pngDataUrl(img: Sharp): Promise<string> {
  const buf = await img.png({ compressionLevel: 3 }).toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function jpgDataUrl(img: Sharp): Promise<string> {
  const buf = await img.jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const hexColour = (c: unknown, fallback = '#ffffff') => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);

// ===================================================================== Remove BG

export interface BgOptions {
  /** 'png' keeps transparency; 'jpg' always gets a solid background. */
  format: 'png' | 'jpg';
  /** Fill the background with `color` instead of leaving it transparent (PNG). */
  fill: boolean;
  color: string;
  /** Edge softness, 0..10. */
  feather: number;
  /** Crop the result to the subject's bounds (plus a small margin). */
  trim: boolean;
}

const BG_DEFAULTS: BgOptions = { format: 'png', fill: false, color: '#ffffff', feather: 2, trim: false };
const RMBG_SIZE = 1024;

interface MaskEntry {
  key: string;
  mask: Buffer; // RMBG_SIZE² 8-bit, min-max normalised
}
const maskCache: MaskEntry[] = [];

function fileKey(path: string) {
  try {
    const s = statSync(path);
    return `${path}|${s.mtimeMs}|${s.size}`;
  } catch {
    return path;
  }
}

async function rmbgModel(ctx: AiCtx, span: [number, number]) {
  const T = transformers();
  return loadModel(
    'briaai/RMBG-1.4',
    {
      id: 'rmbg',
      dtype: 'fp32',
      span,
      warmUp: async (m) => {
        await m({ input: new T.Tensor('float32', new Float32Array(3 * RMBG_SIZE * RMBG_SIZE), [1, 3, RMBG_SIZE, RMBG_SIZE]) });
      },
    },
    ctx,
  );
}

/** The subject mask for an image (model-sized), computed once per file version. */
async function subjectMask(path: string, src: string, ctx: AiCtx, span: [number, number] = [0, 0.4]): Promise<Buffer> {
  const key = fileKey(path);
  const hit = maskCache.find((m) => m.key === key);
  if (hit) return hit.mask;
  const T = transformers();
  const { model, device } = await rmbgModel(ctx, span);
  aborted(ctx.signal);
  ctx.progress?.(span[1], 'Finding the subject…');
  const { data } = await sharp(src, { ...LIMIT, animated: false })
    .autoOrient()
    .toColourspace('srgb')
    .removeAlpha()
    .resize(RMBG_SIZE, RMBG_SIZE, { fit: 'fill', kernel: 'linear' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = RMBG_SIZE * RMBG_SIZE;
  const f = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    f[i] = data[j] / 255 - 0.5;
    f[n + i] = data[j + 1] / 255 - 0.5;
    f[2 * n + i] = data[j + 2] / 255 - 0.5;
  }
  const input = new T.Tensor('float32', f, [1, 3, RMBG_SIZE, RMBG_SIZE]);
  const t0 = Date.now();
  let out: any;
  try {
    out = await model({ input });
  } catch (e) {
    if (device !== 'dml') throw e;
    // A GPU driver hiccup: remember it and redo this one on the CPU.
    log('removeBg: DirectML run failed, retrying on CPU', e);
    markDmlFailed('rmbg');
    const cpu = await loadModel('briaai/RMBG-1.4', { id: 'rmbg', dtype: 'fp32', device: 'cpu' }, ctx);
    out = await cpu.model({ input });
  }
  recordTiming('rmbg', device, Date.now() - t0);
  const t = (out.output ?? Object.values(out)[0]) as { data: Float32Array };
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = t.data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = hi > lo ? 255 / (hi - lo) : 0;
  const mask = Buffer.alloc(n);
  for (let i = 0; i < n; i++) mask[i] = Math.round((t.data[i] - lo) * k);
  maskCache.unshift({ key, mask });
  if (maskCache.length > 6) maskCache.pop();
  return mask;
}

/** The model mask scaled to w×h with refined, feathered edges. */
async function alphaAt(mask: Buffer, w: number, h: number, feather: number, refScale: number): Promise<Buffer> {
  let img = sharp(mask, { raw: { width: RMBG_SIZE, height: RMBG_SIZE, channels: 1 } }).resize(w, h, { fit: 'fill', kernel: 'cubic' });
  // Pull near-transparent haze to 0 and near-solid to 255, keeping the soft ramp at the edge.
  img = img.linear(255 / (247 - 10), (-10 * 255) / (247 - 10));
  const sigma = Math.max(0, feather) * 0.6 * refScale;
  if (sigma >= 0.3) img = img.blur(sigma);
  // sharp writes single-channel raw input back out as RGB unless told otherwise.
  return img.extractChannel(0).raw().toBuffer();
}

/** Bounds of the subject in an alpha channel, or null when nothing is opaque enough. */
function subjectBox(alpha: Buffer, w: number, h: number) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[row + x] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03);
  const left = Math.max(0, x0 - m);
  const top = Math.max(0, y0 - m);
  return { left, top, width: Math.min(w, x1 + m + 1) - left, height: Math.min(h, y1 + m + 1) - top };
}

/** Crops a joined RGBA pipeline (sharp would otherwise extract before joining the alpha). */
async function cropRgba(img: Sharp, w: number, h: number, box: { left: number; top: number; width: number; height: number }): Promise<Sharp> {
  const rgba = await img.raw().toBuffer();
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).extract(box);
}

async function cutOut(path: string, src: string, o: BgOptions, ctx: AiCtx, outPath: (ext: string) => string): Promise<string> {
  const mask = await subjectMask(path, src, ctx, [0, 0.6]);
  aborted(ctx.signal);
  ctx.progress?.(0.75, 'Cutting out…');
  const { rgb, w, h, icc } = await decodeRgb(src);
  const alpha = await alphaAt(mask, w, h, o.feather, Math.max(w, h) / 1000);
  aborted(ctx.signal);
  let img = sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).joinChannel(alpha, { raw: { width: w, height: h, channels: 1 } });
  if (o.trim) {
    const box = subjectBox(alpha, w, h);
    if (box) img = await cropRgba(img, w, h, box);
  }
  const solid = o.format === 'jpg' || o.fill;
  if (solid) img = img.flatten({ background: hexColour(o.color) });
  if (icc) img = img.withIccProfile('srgb');
  const out = outPath(o.format);
  await encode(img, o.format).toFile(out);
  ctx.progress?.(1);
  return out;
}

const removeBg: ToolFn = async (inputs, ctx) => {
  const o: BgOptions = { ...BG_DEFAULTS, ...(ctx.options ?? {}) };
  const outputs: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    aborted(ctx.signal);
    const input = inputs[i];
    const part = sub(ctx, i / inputs.length, (i + 1) / inputs.length, inputs.length > 1 ? `${i + 1} of ${inputs.length}: ` : '');
    try {
      const src = await readable(input, () => ctx.tmp());
      outputs.push(await cutOut(input, src, o, part, (ext) => ctx.out(input, ext, ' cutout')));
    } catch (e: any) {
      if (ctx.signal.aborted) throw e;
      if (/network/i.test(String(e?.message))) throw e;
      log('removeBg failed', input, e);
      errors.push(`${basename(input)}: ${e instanceof UserError ? e.message : String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  if (!outputs.length && errors.length) throw new UserError(errors.join('\n'));
  return outputs;
};

// ===================================================================== Upscale

export interface UpOptions {
  model: 'photo' | 'art';
  scale: 2 | 4;
}
const UP_DEFAULTS: UpOptions = { model: 'photo', scale: 4 };
const CORE = 256; // input pixels each tile contributes
const PAD = 16; // context around each tile so the seams match
const TILE = CORE + PAD * 2;
const NET_SCALE = 4;
/** Largest output we write, in pixels (keeps memory around 1.5 GB at worst). */
const MAX_OUT_PX = 120e6;

const upModelId = (m: string) => (m === 'art' ? 'upscale-art' : 'upscale-photo');

async function upSession(model: string, ctx: AiCtx, span: [number, number]) {
  const id = upModelId(model);
  const d = modelDef(id);
  return loadOnnx(id, d.files[0], { span, warm: () => ({ [id === 'upscale-art' ? 'image.1' : 'input']: floatTensor(new Float32Array(3 * TILE * TILE), [1, 3, TILE, TILE]) }) }, ctx);
}

/** Reads a TILE×TILE patch centred on (x0−PAD, y0−PAD), clamping at the image edges, as planar 0..1 floats. */
function readTile(rgb: Buffer, w: number, h: number, x0: number, y0: number): Float32Array {
  const n = TILE * TILE;
  const f = new Float32Array(3 * n);
  for (let ty = 0; ty < TILE; ty++) {
    const sy = Math.min(h - 1, Math.max(0, y0 - PAD + ty));
    const row = sy * w;
    for (let tx = 0; tx < TILE; tx++) {
      const sx = Math.min(w - 1, Math.max(0, x0 - PAD + tx));
      const s = (row + sx) * 3;
      const d = ty * TILE + tx;
      f[d] = rgb[s] / 255;
      f[n + d] = rgb[s + 1] / 255;
      f[2 * n + d] = rgb[s + 2] / 255;
    }
  }
  return f;
}

/** Network output (planar floats, side TILE·4) → interleaved 8-bit RGB. */
function toBytes(out: Float32Array, side: number): Buffer {
  const n = side * side;
  const b = Buffer.alloc(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const r = out[i] * 255;
    const g = out[n + i] * 255;
    const bl = out[2 * n + i] * 255;
    b[j] = r < 0 ? 0 : r > 255 ? 255 : r + 0.5;
    b[j + 1] = g < 0 ? 0 : g > 255 ? 255 : g + 0.5;
    b[j + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl + 0.5;
  }
  return b;
}

/** Upscales one tile; returns interleaved RGB at `scale`, side TILE·scale, context included. */
async function upTile(sess: Awaited<ReturnType<typeof upSession>>, id: string, rgb: Buffer, w: number, h: number, x0: number, y0: number, scale: number): Promise<Buffer> {
  const input = floatTensor(readTile(rgb, w, h, x0, y0), [1, 3, TILE, TILE]);
  const t0 = Date.now();
  const res = await sess.run({ [sess.inputNames[0]]: input });
  recordTiming(id, sess.device, Date.now() - t0);
  const bytes = toBytes(res[sess.outputNames[0]].data as Float32Array, TILE * NET_SCALE);
  if (scale === NET_SCALE) return bytes;
  // ×2 the way Real-ESRGAN does it: run ×4 and downscale (with the context, so no seams).
  return sharp(bytes, { raw: { width: TILE * NET_SCALE, height: TILE * NET_SCALE, channels: 3 } })
    .resize(TILE * scale, TILE * scale, { kernel: 'lanczos3' })
    .raw()
    .toBuffer();
}

export function tilesFor(w: number, h: number) {
  return Math.ceil(w / CORE) * Math.ceil(h / CORE);
}

async function upscaleOne(input: string, o: UpOptions, ctx: Ctx, part: AiCtx): Promise<string> {
  const scale = o.scale === 2 ? 2 : 4;
  const id = upModelId(o.model);
  const src = await readable(input, () => ctx.tmp());
  const { rgb, alpha, w, h, icc } = await decodeRgb(src);
  const W = w * scale;
  const H = h * scale;
  if (W * H > MAX_OUT_PX) {
    throw new UserError(`At ${scale}× it would be ${W} × ${H} pixels, too large to make. Try 2× or a smaller image.`);
  }
  let sess = await upSession(o.model, part, [0, 0.05]);
  const out = Buffer.alloc(W * H * 3);
  const cols = Math.ceil(w / CORE);
  const rows = Math.ceil(h / CORE);
  const total = cols * rows;
  let done = 0;
  const side = TILE * scale;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      aborted(ctx.signal);
      const x0 = c * CORE;
      const y0 = r * CORE;
      let tile: Buffer;
      try {
        tile = await upTile(sess, id, rgb, w, h, x0, y0, scale);
      } catch (e) {
        if (sess.device !== 'dml') throw e;
        log('upscale: DirectML run failed, continuing on CPU', e);
        markDmlFailed(id);
        sess = await loadOnnx(id, modelDef(id).files[0], { device: 'cpu' }, part);
        tile = await upTile(sess, id, rgb, w, h, x0, y0, scale);
      }
      // Copy the tile's core (without its context) into place.
      const cw = Math.min(CORE, w - x0) * scale;
      const ch = Math.min(CORE, h - y0) * scale;
      const off = PAD * scale;
      for (let y = 0; y < ch; y++) {
        const s = ((off + y) * side + off) * 3;
        tile.copy(out, ((y0 * scale + y) * W + x0 * scale) * 3, s, s + cw * 3);
      }
      done++;
      part.progress?.(0.05 + 0.85 * (done / total), `Upscaling… ${Math.round((done / total) * 100)}%`);
    }
  }
  aborted(ctx.signal);
  part.progress?.(0.92, 'Saving…');
  let img = sharp(out, { raw: { width: W, height: H, channels: 3 }, limitInputPixels: false });
  if (alpha) {
    const a = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).resize(W, H, { kernel: 'lanczos3' }).extractChannel(0).raw().toBuffer();
    img = img.joinChannel(a, { raw: { width: W, height: H, channels: 1 } });
  }
  let fmt = sameFormat(input, !!alpha);
  if (fmt === 'webp' && Math.max(W, H) > 16383) fmt = 'png'; // WebP's size limit
  if (icc) img = img.withIccProfile('srgb');
  const dest = ctx.out(input, fmt, ` ${scale}x`);
  await encode(img, fmt).toFile(dest);
  part.progress?.(1);
  return dest;
}

const upscale: ToolFn = async (inputs, ctx) => {
  const o: UpOptions = { ...UP_DEFAULTS, ...(ctx.options ?? {}) };
  const outputs: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    aborted(ctx.signal);
    const input = inputs[i];
    const part = sub(ctx, i / inputs.length, (i + 1) / inputs.length, inputs.length > 1 ? `${i + 1} of ${inputs.length}: ` : '');
    try {
      outputs.push(await upscaleOne(input, o, ctx, part));
    } catch (e: any) {
      if (ctx.signal.aborted) throw e;
      if (/network/i.test(String(e?.message))) throw e;
      log('upscale failed', input, e);
      errors.push(`${basename(input)}: ${e instanceof UserError ? e.message : String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  if (!outputs.length && errors.length) throw new UserError(errors.join('\n'));
  return outputs;
};

// ===================================================================== OCR

export interface OcrOptions {
  output: 'pdf' | 'txt' | 'md';
  /** Tesseract language codes, e.g. ['eng'] or ['eng', 'hin']. */
  langs: string[];
  /** Several images → one searchable PDF instead of one per image. */
  combine: boolean;
}
const OCR_DEFAULTS: OcrOptions = { output: 'pdf', langs: ['eng'], combine: false };
const OCR_DPI = 300;
/** A PDF page with at least this many non-space characters already has a text layer. */
const HAS_TEXT_CHARS = 20;

const GS = () => join(binDir, 'gs', 'bin', 'gswin64c.exe');

type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;
function pdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    const url = pathToFileURL(nodeRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
    const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<PdfjsModule>;
    pdfjsPromise = dynamicImport(url);
    pdfjsPromise.catch(() => (pdfjsPromise = null));
  }
  return pdfjsPromise;
}

interface PdfScan {
  pages: number;
  /** Existing text per page ('' when the page needs OCR). */
  text: string[];
}

/** Which PDF pages already carry text (and that text, for the TXT/Markdown outputs). */
async function scanPdf(path: string): Promise<PdfScan> {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false } as any);
  let doc: any;
  try {
    doc = await task.promise;
  } catch (e: any) {
    void task.destroy();
    if (e?.name === 'PasswordException') throw new UserError(`${basename(path)} is password-protected. Use Unlock on the Tools wheel first.`);
    throw new UserError(`${basename(path)} isn't a readable PDF.`);
  }
  try {
    const text: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let s = '';
      for (const it of tc.items as any[]) {
        if (typeof it.str !== 'string') continue;
        s += it.str + (it.hasEOL ? '\n' : '');
      }
      page.cleanup();
      text.push(s.replace(/\s/g, '').length >= HAS_TEXT_CHARS ? s.trim() : '');
    }
    return { pages: doc.numPages, text };
  } finally {
    void task.destroy();
  }
}

/** Renders the given 1-based pages at 300 DPI (greyscale PNG). Returns paths in the same order. */
async function renderPages(pdf: string, pages: number[], dir: string, signal: AbortSignal): Promise<string[]> {
  if (!existsSync(GS())) throw new UserError('The PDF renderer is missing. Reinstall Orange.');
  mkdirSync(dir, { recursive: true });
  const pattern = join(dir.replace(/%/g, '%%'), 'p%05d.png');
  await run(
    GS(),
    ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=pnggray', `-r${OCR_DPI}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-dUseCropBox', `-sPageList=${pages.join(',')}`, `-sOutputFile=${pattern}`, pdf],
    { signal },
  );
  const files = readdirSync(dir)
    .filter((f) => /^p\d{5}\.png$/.test(f))
    .sort()
    .map((f) => join(dir, f));
  if (files.length !== pages.length) throw new UserError(`Couldn't render the pages of ${basename(pdf)}.`);
  return files;
}

async function langPathFor(langs: string[], ctx: AiCtx): Promise<string> {
  for (const code of langs) {
    const id = `ocr-${code}`;
    modelDef(id); // throws on unknown codes
    if (code === 'eng' && !isReady(id)) {
      // English ships with Orange: copy it into the model folder instead of downloading.
      try {
        const src = join(dirname(nodeRequire.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int', 'eng.traineddata.gz');
        mkdirSync(dirname(modelFile(id, 'eng.traineddata.gz')), { recursive: true });
        copyFileSync(src, modelFile(id, 'eng.traineddata.gz'));
      } catch (e) {
        log('ocr: bundled English data missing, downloading', e);
      }
    }
    await ensureFiles(id, ctx, [0, 0.05]);
  }
  return dirname(modelFile('ocr-eng', 'eng.traineddata.gz'));
}

interface OcrPage {
  text: string;
  md: string;
  pdf?: Uint8Array;
}

interface Recognizer {
  recognize(image: Buffer, wantPdf: boolean): Promise<OcrPage>;
  close(): Promise<void>;
}

async function recognizer(langs: string[], workers: number, ctx: AiCtx): Promise<Recognizer> {
  const T = nodeRequire('tesseract.js') as typeof import('tesseract.js');
  const langPath = await langPathFor(langs, ctx);
  aborted(ctx.signal);
  const scheduler = T.createScheduler();
  const made = await Promise.all(
    Array.from({ length: workers }, () => T.createWorker(langs.join('+'), 1, { langPath, cacheMethod: 'none', gzip: true, errorHandler: (e: any) => log('ocr worker', e) })),
  );
  for (const w of made) {
    // Rendered pages are 300 DPI; it also stops "Invalid resolution" guesses for images without DPI.
    await w.setParameters({ user_defined_dpi: String(OCR_DPI) } as any);
    scheduler.addWorker(w);
  }
  const onAbort = () => void scheduler.terminate().catch(() => {});
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  return {
    async recognize(image, wantPdf) {
      aborted(ctx.signal);
      // A terminated scheduler never settles its pending jobs, so race them against Cancel.
      const job = scheduler.addJob('recognize', image, { pdfTextOnly: true } as any, { text: true, blocks: true, pdf: wantPdf } as any);
      job.catch(() => {});
      const r: any = await Promise.race([
        job,
        new Promise((_, reject) => {
          if (ctx.signal?.aborted) reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
          ctx.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true });
        }),
      ]);
      aborted(ctx.signal);
      return { text: (r.data.text ?? '').trim(), md: toMarkdown(r.data.blocks ?? []), pdf: wantPdf && r.data.pdf ? Uint8Array.from(r.data.pdf as ArrayLike<number>) : undefined };
    },
    async close() {
      ctx.signal?.removeEventListener('abort', onAbort);
      await scheduler.terminate().catch(() => {});
    },
  };
}

/**
 * Recognised blocks → Markdown. Tesseract's own paragraphs are often a whole column, so paragraphs
 * are split again at vertical gaps between lines; short, noticeably taller lines become headings.
 */
function toMarkdown(blocks: any[]): string {
  interface L {
    text: string;
    x0: number;
    y0: number;
    y1: number;
    para: number;
  }
  const lines: L[] = [];
  let para = 0;
  for (const b of blocks) {
    for (const p of b.paragraphs ?? []) {
      para++;
      for (const l of p.lines ?? []) {
        let words: any[] = (l.words ?? []).filter((w: any) => String(w.text ?? '').trim());
        if (!words.length) continue;
        // Margin marks (a vertical watermark, a punch hole) read as a short "word" far left of the
        // rest of the line: drop them so they don't leak into the text or the size estimate.
        const wh = (w: any) => w.bbox.y1 - w.bbox.y0;
        const typical = [...words].map(wh).sort((a, b) => a - b)[Math.floor(words.length / 2)] || 1;
        while (words.length > 1 && String(words[0].text).length <= 3 && words[1].bbox.x0 - words[0].bbox.x1 > typical * 2.5) words = words.slice(1);
        const text = words.map((w) => String(w.text).trim()).join(' ');
        // Skip specks: lines of one or two stray symbols (scan noise, margin marks).
        if (!text || (text.length <= 2 && !/[\p{L}\p{N}]{2}/u.test(text))) continue;
        // Size from the words' median height: robust to one tall glyph or a merged margin mark.
        const hs = words.filter((w) => /[\p{L}\p{N}]{2}/u.test(w.text)).map(wh).sort((a, b) => a - b);
        const size = hs.length ? hs[Math.floor(hs.length / 2)] : typical;
        const top = Math.min(...words.map((w) => w.bbox.y0));
        lines.push({ text, x0: words[0].bbox.x0, y0: top, y1: top + size, para });
      }
    }
  }
  if (!lines.length) return '';
  const heights = lines.map((l) => l.y1 - l.y0).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 1;
  // Group lines into paragraphs.
  const groups: L[][] = [];
  for (const l of lines) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    const gap = prev ? l.y0 - prev.y1 : Infinity;
    const sizeJump = prev ? Math.abs((l.y1 - l.y0) - (prev.y1 - prev.y0)) > median * 0.35 : true;
    const bullet = /^[•●▪◦·*\-–]\s/.test(l.text);
    const newPara = !prev || l.para !== prev.para || gap > median * 0.75 || gap < -median || sizeJump || bullet || /[.:!?]$/.test(prev.text) && l.x0 - prev.x0 > median * 1.2;
    if (newPara) groups.push([l]);
    else g!.push(l);
  }
  return groups
    .map((g) => {
      let text = '';
      for (const l of g) {
        if (text.endsWith('-') && /^\p{Ll}/u.test(l.text)) text = text.slice(0, -1) + l.text;
        else text += (text ? ' ' : '') + l.text;
      }
      const size = g.reduce((a, l) => a + (l.y1 - l.y0), 0) / g.length;
      const r = size / median;
      if (g.length <= 2 && text.length < 120 && !/[.,;]$/.test(text)) {
        if (r >= 1.8) return `# ${text}`;
        if (r >= 1.3) return `## ${text}`;
      }
      return text.replace(/^[•●▪◦·*–]\s+/, '- ');
    })
    .join('\n\n');
}

/** Upright 8-bit image bytes tesseract and pdf-lib can both use, plus pixel size and DPI. */
async function ocrImage(input: string, tmp: () => string): Promise<{ bytes: Buffer; kind: 'jpg' | 'png'; w: number; h: number; dpi: number }> {
  const src = await readable(input, tmp);
  const meta = await sharp(src, LIMIT).metadata();
  const e = extOf(src);
  const upright = !meta.orientation || meta.orientation === 1;
  let bytes: Buffer;
  let kind: 'jpg' | 'png';
  if (['jpg', 'jpeg', 'jfif'].includes(e) && upright && meta.space !== 'cmyk') {
    bytes = readFileSync(src);
    kind = 'jpg';
  } else if (e === 'png' && upright && meta.depth === 'uchar' && !meta.hasAlpha) {
    bytes = readFileSync(src);
    kind = 'png';
  } else {
    const img = sharp(src, { ...LIMIT, animated: false }).autoOrient().toColourspace('srgb');
    if (meta.hasAlpha) {
      bytes = await img.flatten({ background: '#ffffff' }).png().toBuffer();
      kind = 'png';
    } else {
      bytes = await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      kind = 'jpg';
    }
  }
  const swap = (meta.orientation ?? 1) >= 5;
  const w = (swap ? meta.height : meta.width) ?? 1;
  const h = (swap ? meta.width : meta.height) ?? 1;
  // Scans carry their DPI; phone photos say 72 and would make huge pages, so treat those as A4-ish.
  let dpi = meta.density && meta.density >= 100 && meta.density <= 1200 ? meta.density : Math.max(72, Math.max(w, h) / 11.69);
  if (!Number.isFinite(dpi)) dpi = OCR_DPI;
  return { bytes, kind, w, h, dpi };
}

/** Draws a tesseract text-only page over `page` so it lines up with what the page shows. */
async function overlayText(doc: PDFDocument, page: ReturnType<PDFDocument['getPage']>, textPdf: Uint8Array) {
  const [emb] = await doc.embedPdf(textPdf, [0]);
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const sideways = rot === 90 || rot === 270;
  const dw = sideways ? box.height : box.width;
  const dh = sideways ? box.width : box.height;
  const opts = { xScale: dw / emb.width, yScale: dh / emb.height };
  if (rot === 90) page.drawPage(emb, { ...opts, x: box.x + box.width, y: box.y, rotate: degrees(90) });
  else if (rot === 180) page.drawPage(emb, { ...opts, x: box.x + box.width, y: box.y + box.height, rotate: degrees(180) });
  else if (rot === 270) page.drawPage(emb, { ...opts, x: box.x, y: box.y + box.height, rotate: degrees(270) });
  else page.drawPage(emb, { ...opts, x: box.x, y: box.y });
}

interface OcrUnit {
  input: string;
  pdf?: PdfScan;
  /** 1-based PDF pages that need OCR. */
  todo: number[];
}

function writeText(out: string, pages: string[], md: boolean) {
  const body =
    pages.length === 1
      ? pages[0]
      : pages.map((p, i) => (md ? `${i ? '---\n\n' : ''}${p}` : `${i ? '\n' : ''}--- Page ${i + 1} ---\n\n${p}`)).join('\n\n');
  writeFileSync(out, body.trim() + '\n', 'utf8');
}

const ocr: ToolFn = async (inputs, ctx) => {
  const o: OcrOptions = { ...OCR_DEFAULTS, ...(ctx.options ?? {}) };
  const langs = (o.langs?.length ? o.langs : ['eng']).filter((c) => OCR_LANGS.some((l) => l.code === c)).slice(0, 3);
  if (!langs.length) langs.push('eng');
  ctx.progress(0.01, 'Reading files…');

  // 1. Work out what needs recognising.
  const units: OcrUnit[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    aborted(ctx.signal);
    if (extOf(input) === 'pdf') {
      try {
        const scan = await scanPdf(input);
        const todo = scan.text.map((t, i) => (t ? 0 : i + 1)).filter(Boolean);
        if (!todo.length && o.output === 'pdf') {
          errors.push(`${basename(input)}: every page already has text, so it's already searchable.`);
          continue;
        }
        units.push({ input, pdf: scan, todo });
      } catch (e: any) {
        errors.push(`${basename(input)}: ${e?.message ?? e}`);
      }
    } else units.push({ input, todo: [1] });
  }
  const totalPages = units.reduce((a, u) => a + u.todo.length, 0);
  if (!units.length) throw new UserError(errors.join('\n') || 'Nothing to recognise.');

  // 2. Start the recogniser (downloads missing language data once).
  const workers = Math.max(1, Math.min(totalPages, 4, Math.floor(cpus().length / 2)));
  const rec = totalPages ? await recognizer(langs, workers, sub(ctx, 0, 0.05)) : null;
  let donePages = 0;
  const tick = () => {
    donePages++;
    ctx.progress(0.05 + 0.9 * (donePages / Math.max(1, totalPages)), `Page ${donePages} of ${totalPages}`);
  };
  const t0 = Date.now();
  const outputs: string[] = [];
  const wantPdf = o.output === 'pdf';
  const combineImages = wantPdf && o.combine && units.filter((u) => !u.pdf).length > 1;
  let combined: PDFDocument | null = combineImages ? await PDFDocument.create() : null;
  const combinedFirst = units.find((u) => !u.pdf)?.input;

  try {
    for (const u of units) {
      aborted(ctx.signal);
      try {
        if (u.pdf) {
          // ---- PDF: render pages needing OCR in small batches; recognise while the next batch renders.
          const results = new Map<number, OcrPage>();
          const batches: number[][] = [];
          for (let i = 0; i < u.todo.length; i += 6) batches.push(u.todo.slice(i, i + 6));
          const tmp = ctx.tmp();
          const render = (b: number[], i: number) => {
            const pr = renderPages(u.input, b, join(tmp, `b${i}`), ctx.signal);
            pr.catch(() => {}); // awaited below; this only stops an unhandled rejection on Cancel
            return pr;
          };
          let next = batches.length ? render(batches[0], 0) : null;
          for (let bi = 0; bi < batches.length; bi++) {
            const files = await next!;
            next = bi + 1 < batches.length ? render(batches[bi + 1], bi + 1) : null;
            await Promise.all(
              files.map(async (f, k) => {
                const page = await rec!.recognize(readFileSync(f), wantPdf);
                results.set(batches[bi][k], page);
                tick();
              }),
            );
          }
          if (wantPdf) {
            const doc = await loadPdf(u.input);
            for (const [n, page] of results) if (page.pdf && page.text) await overlayText(doc, doc.getPage(n - 1), page.pdf);
            const dest = ctx.out(u.input, 'pdf', ' searchable');
            writeFileSync(dest, await doc.save({ useObjectStreams: true }));
            outputs.push(dest);
          } else {
            const md = o.output === 'md';
            const pages = u.pdf.text.map((t, i) => (t ? t : (md ? results.get(i + 1)?.md : results.get(i + 1)?.text) ?? ''));
            const dest = ctx.out(u.input, o.output);
            writeText(dest, pages, md);
            outputs.push(dest);
          }
        } else {
          // ---- Image.
          const img = await ocrImage(u.input, () => ctx.tmp());
          const page = await rec!.recognize(img.bytes, wantPdf);
          tick();
          if (!page.text) errors.push(`${basename(u.input)}: no text found.`);
          if (wantPdf) {
            const doc = combined ?? (await PDFDocument.create());
            doc.setProducer('Orange');
            const pic = img.kind === 'jpg' ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
            const pw = (img.w * 72) / img.dpi;
            const ph = (img.h * 72) / img.dpi;
            const p = doc.addPage([pw, ph]);
            p.drawImage(pic, { x: 0, y: 0, width: pw, height: ph });
            if (page.pdf && page.text) await overlayText(doc, p, page.pdf);
            if (!combined) {
              const dest = ctx.out(u.input, 'pdf');
              writeFileSync(dest, await doc.save({ useObjectStreams: true }));
              outputs.push(dest);
            }
          } else if (page.text) {
            const dest = ctx.out(u.input, o.output);
            writeText(dest, [o.output === 'md' ? page.md : page.text], o.output === 'md');
            outputs.push(dest);
          }
        }
      } catch (e: any) {
        if (ctx.signal.aborted) throw e;
        if (/network/i.test(String(e?.message))) throw e;
        log('ocr failed', u.input, e);
        errors.push(`${basename(u.input)}: ${e instanceof UserError ? e.message : String(e?.message ?? e).slice(0, 160)}`);
      }
    }
    if (combined && combinedFirst && combined.getPageCount()) {
      ctx.progress(0.97, 'Writing PDF…');
      const dest = ctx.out(combinedFirst, 'pdf', ' searchable');
      writeFileSync(dest, await combined.save({ useObjectStreams: true }));
      outputs.push(dest);
      combined = null;
    }
  } finally {
    await rec?.close();
  }
  if (totalPages) recordTiming(`ocr-${langs[0]}`, 'cpu', ((Date.now() - t0) * workers) / totalPages);
  if (!outputs.length) throw new UserError(errors.join('\n') || 'No text was found.');
  if (errors.length) log('ocr warnings', errors);
  return outputs;
};

export const tools: Record<string, ToolFn> = { ocr, removeBg, upscale };

// ===================================================================== window IPC

/** Cancels a window's in-flight preview when it closes or asks for a newer one. */
const previewJobs = new Map<number, AbortController>();
function previewSignal(wc: WebContents, slot: string): { ctx: AiCtx; done: () => void } {
  const key = wc.id * 10 + (slot === 'up' ? 1 : 0);
  previewJobs.get(key)?.abort();
  const ac = new AbortController();
  previewJobs.set(key, ac);
  const onGone = () => ac.abort();
  wc.once('destroyed', onGone);
  return {
    ctx: {
      signal: ac.signal,
      progress: (f, note) => {
        if (!wc.isDestroyed()) wc.send('ai:progress', { fraction: f, note });
      },
    },
    done: () => {
      wc.removeListener('destroyed', onGone);
      if (previewJobs.get(key) === ac) previewJobs.delete(key);
    },
  };
}

async function imageSize(path: string): Promise<{ w: number; h: number }> {
  try {
    if (SHARP_IN.has(extOf(path))) {
      const m = await sharp(path, LIMIT).metadata();
      const swap = (m.orientation ?? 1) >= 5;
      return { w: (swap ? m.height : m.width) ?? 0, h: (swap ? m.width : m.height) ?? 0 };
    }
  } catch {
    /* fall through */
  }
  return { w: 0, h: 0 };
}

export interface AiStatus {
  /** Models this run needs, with download state. */
  models: { id: string; label: string; mb: number; ready: boolean; licence: string }[];
  /** MB still to download before the first run. */
  downloadMB: number;
  device: Device;
  /** Expected compute time for all files, in ms (excludes the download). */
  ms: number;
  /** Per-file details the window may show. */
  files: { path: string; w: number; h: number; pages?: number; todo?: number; units: number }[];
  note?: string;
}

const pdfInfoCache = new Map<string, { pages: number; todo: number }>();

async function status(tool: string, paths: string[], options: any): Promise<AiStatus> {
  const files: AiStatus['files'] = [];
  let ids: string[] = [];
  let units = 0;
  let note: string | undefined;
  if (tool === 'removeBg') {
    ids = ['rmbg'];
    for (const p of paths) files.push({ path: p, ...(await imageSize(p)), units: 1 });
    units = paths.length;
  } else if (tool === 'upscale') {
    const o: UpOptions = { ...UP_DEFAULTS, ...(options ?? {}) };
    ids = [upModelId(o.model)];
    for (const p of paths) {
      const s = await imageSize(p);
      const u = s.w ? tilesFor(s.w, s.h) : 12;
      files.push({ path: p, ...s, units: u });
      units += u;
    }
  } else if (tool === 'ocr') {
    const o: OcrOptions = { ...OCR_DEFAULTS, ...(options ?? {}) };
    ids = (o.langs?.length ? o.langs : ['eng']).map((c) => `ocr-${c}`).filter((id) => OCR_LANGS.some((l) => `ocr-${l.code}` === id));
    for (const p of paths) {
      if (extOf(p) === 'pdf') {
        const key = fileKey(p);
        let info = pdfInfoCache.get(key);
        if (!info) {
          try {
            const scan = await scanPdf(p);
            info = { pages: scan.pages, todo: scan.text.filter((t) => !t).length };
          } catch {
            info = { pages: 0, todo: 0 };
          }
          pdfInfoCache.set(key, info);
        }
        files.push({ path: p, w: 0, h: 0, pages: info.pages, todo: info.todo, units: info.todo });
        units += info.todo;
      } else {
        files.push({ path: p, ...(await imageSize(p)), units: 1 });
        units += 1;
      }
    }
    const workers = Math.max(1, Math.min(units, 4, Math.floor(cpus().length / 2)));
    units = units / workers;
    if (paths.some((p) => extOf(p) === 'pdf') && files.every((f) => !f.units)) note = 'These PDFs already have text on every page.';
  }
  const states = modelStatus(ids);
  // English ships with Orange, so it never counts as a download.
  const downloadMB = states.filter((s) => !s.ready && s.id !== 'ocr-eng').reduce((a, s) => a + s.mb, 0);
  const id = ids[0];
  const device = states[0]?.device ?? 'cpu';
  let ms = id ? estimateMs(id, units) : 0;
  if (tool === 'removeBg') ms += files.reduce((a, f) => a + 150 + (f.w * f.h) / 60_000, 0); // compositing
  if (tool === 'upscale') ms += files.reduce((a, f) => a + (f.w * f.h * (options?.scale === 2 ? 4 : 16)) / 40_000, 0); // encoding
  return { models: states.map((s) => ({ id: s.id, label: s.label, mb: s.mb, ready: s.ready || s.id === 'ocr-eng', licence: s.licence })), downloadMB, device, ms, files, note };
}

ipcMain.handle('ai:status', (_e, tool: string, paths: string[], options: any) => status(tool, paths, options));
ipcMain.handle('ai:langs', () => OCR_LANGS.map((l) => ({ ...l, ready: l.code === 'eng' || isReady(`ocr-${l.code}`) })));

const PREVIEW_SIDE = 1200;

ipcMain.handle('ai:bgPreview', async (e, path: string, options: Partial<BgOptions>) => {
  const o: BgOptions = { ...BG_DEFAULTS, ...(options ?? {}) };
  const { ctx, done } = previewSignal(e.sender, 'bg');
  const tmpDirs: string[] = [];
  try {
    const src = await readable(path, () => {
      const d = mkdtempSync(join(tmpdir(), 'orange-ai-'));
      tmpDirs.push(d);
      return d;
    });
    const t0 = Date.now();
    const mask = await subjectMask(path, src, ctx, [0, 0.9]);
    const { data, info } = await sharp(src, { ...LIMIT, animated: false })
      .autoOrient()
      .toColourspace('srgb')
      .removeAlpha()
      .resize(PREVIEW_SIDE, PREVIEW_SIDE, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const full = await imageSize(src);
    // Same edge softness as the full-size result, scaled to the preview.
    const alpha = await alphaAt(mask, info.width, info.height, o.feather, Math.max(info.width, info.height) / 1000);
    let img = sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).joinChannel(alpha, { raw: { width: info.width, height: info.height, channels: 1 } });
    let box = null;
    if (o.trim) {
      box = subjectBox(alpha, info.width, info.height);
      if (box) img = await cropRgba(img, info.width, info.height, box);
    }
    const after = await pngDataUrl(img);
    const before = await jpgDataUrl(sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }));
    return { before, after, w: info.width, h: info.height, box, fullW: full.w, fullH: full.h, ms: Date.now() - t0 };
  } finally {
    done();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  }
});

ipcMain.handle('ai:upPreview', async (e, path: string, options: Partial<UpOptions> & { cx?: number; cy?: number }) => {
  const o: UpOptions = { ...UP_DEFAULTS, ...(options ?? {}) };
  const scale = o.scale === 2 ? 2 : 4;
  const id = upModelId(o.model);
  const { ctx, done } = previewSignal(e.sender, 'up');
  const tmpDirs: string[] = [];
  try {
    const src = await readable(path, () => {
      const d = mkdtempSync(join(tmpdir(), 'orange-ai-'));
      tmpDirs.push(d);
      return d;
    });
    const { w, h } = await imageSize(src);
    // A crop that comes out 512 px wide after upscaling.
    const side = Math.min(CORE, Math.round(512 / scale), w || CORE, h || CORE);
    const cx = Math.min(1, Math.max(0, options?.cx ?? 0.5));
    const cy = Math.min(1, Math.max(0, options?.cy ?? 0.5));
    const left = Math.max(0, Math.min((w || side) - side, Math.round(cx * (w || side) - side / 2)));
    const top = Math.max(0, Math.min((h || side) - side, Math.round(cy * (h || side) - side / 2)));
    // Take the crop with its context so the preview matches the real result exactly.
    const ext = { left: Math.max(0, left - PAD), top: Math.max(0, top - PAD) };
    const ew = Math.min(w, left + side + PAD) - ext.left;
    const eh = Math.min(h, top + side + PAD) - ext.top;
    const { data } = await sharp(src, { ...LIMIT, animated: false })
      .autoOrient()
      .toColourspace('srgb')
      .removeAlpha()
      .extract({ left: ext.left, top: ext.top, width: ew, height: eh })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sess = await upSession(o.model, ctx, [0, 0.9]);
    ctx.progress?.(0.92, 'Upscaling the preview…');
    const t0 = Date.now();
    // Place the crop so its top-left core pixel sits at PAD inside the tile.
    const tile = await upTile(sess, id, data, ew, eh, left - ext.left, top - ext.top, scale);
    const ts = TILE * scale;
    const after = sharp(tile, { raw: { width: ts, height: ts, channels: 3 } }).extract({ left: PAD * scale, top: PAD * scale, width: side * scale, height: side * scale });
    const plain = await sharp(src, { ...LIMIT, animated: false })
      .autoOrient()
      .toColourspace('srgb')
      .removeAlpha()
      .extract({ left, top, width: side, height: side })
      .resize(side * scale, side * scale, { kernel: 'cubic' })
      .png()
      .toBuffer();
    return {
      before: `data:image/png;base64,${plain.toString('base64')}`,
      after: await pngDataUrl(after),
      side: side * scale,
      crop: { left, top, size: side, w, h },
      ms: Date.now() - t0,
      device: sess.device,
    };
  } finally {
    done();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  }
});

ipcMain.handle('ai:download', async (e, ids: string[]) => {
  // Fetches models ahead of a run (used by the "Download" button when a model is large).
  const { ctx, done } = previewSignal(e.sender, 'bg');
  try {
    for (const id of ids) {
      if (id === 'rmbg') await rmbgModel(ctx, [0, 1]);
      else if (id.startsWith('upscale-')) await ensureFiles(id, ctx, [0, 1]);
      else if (id.startsWith('ocr-')) await langPathFor([id.slice(4)], ctx);
    }
    return true;
  } finally {
    done();
  }
});
ipcMain.on('ai:cancelPreview', (e) => {
  for (const slot of ['bg', 'up']) previewJobs.get(e.sender.id * 10 + (slot === 'up' ? 1 : 0))?.abort();
});
