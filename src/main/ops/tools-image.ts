// Image tools that run in the main process: batch crop (sharp) and images → PDF (pdf-lib).
// Renderer-only tools (edit, annotate, frame, redact, collage) save through file:saveBytes.
import sharp, { type Sharp } from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { extOf } from '../../shared/catalog';
import { toBrowserImage } from './convert-image';
import type { Ctx, ToolFn } from './types';
import { UserError } from './types';

// Formats sharp can decode in this build; anything else is decoded by toBrowserImage first.
const SHARP_IN = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'tif', 'tiff', 'avif', 'gif', 'svg']);

/** A path sharp can read: the file itself, or a PNG decoded from HEIC/BMP/ICO/JXL. */
async function readable(input: string, ctx: Ctx): Promise<{ path: string; decoded: boolean }> {
  if (SHARP_IN.has(extOf(input))) return { path: input, decoded: false };
  const out = join(ctx.tmp(), `${basename(input, extname(input))}.png`);
  await toBrowserImage(input, out);
  return { path: out, decoded: true };
}

async function pool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>, signal: AbortSignal) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// ------------------------------------------------------------------------- crop

export interface CropSpec {
  /** Width / height of the crop in pixels, or null for a free crop. */
  aspect: number | null;
  /** Centre of the crop, 0..1 of the (rotated) image. */
  cx: number;
  cy: number;
  /** Free crop: size as a fraction of the image. */
  nw: number;
  nh: number;
  /** Fixed aspect: width as a fraction of the largest crop of that aspect that fits. */
  f: number;
}

export interface CropOptions {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  spec: CropSpec;
  /** Exact output size in px (the aspect then matches it), or null to keep the crop size. */
  out: { w: number; h: number } | null;
}

/** The crop rectangle (px, integer) for an image of size W×H. Mirrors the renderer's function. */
export function cropRect(W: number, H: number, s: CropSpec) {
  let w: number, h: number;
  if (s.aspect) {
    const maxW = Math.min(W, H * s.aspect);
    w = Math.max(1, s.f * maxW);
    h = w / s.aspect;
  } else {
    w = Math.max(1, s.nw * W);
    h = Math.max(1, s.nh * H);
  }
  w = Math.min(w, W);
  h = Math.min(h, H);
  let x = s.cx * W - w / 2;
  let y = s.cy * H - h / 2;
  x = Math.min(Math.max(0, x), W - w);
  y = Math.min(Math.max(0, y), H - h);
  const left = Math.round(x);
  const top = Math.round(y);
  return {
    left,
    top,
    width: Math.max(1, Math.min(W - left, Math.round(w))),
    height: Math.max(1, Math.min(H - top, Math.round(h))),
  };
}

function outFormat(input: string): 'jpg' | 'png' | 'webp' | 'tiff' | 'avif' | 'gif' {
  const e = extOf(input);
  if (['jpg', 'jpeg', 'jfif'].includes(e)) return 'jpg';
  if (e === 'webp') return 'webp';
  if (e === 'tif' || e === 'tiff') return 'tiff';
  if (e === 'avif') return 'avif';
  if (e === 'gif') return 'gif';
  if (e === 'heic' || e === 'heif') return 'jpg';
  return 'png';
}

function encode(img: Sharp, fmt: ReturnType<typeof outFormat>) {
  switch (fmt) {
    case 'jpg':
      return img.jpeg({ quality: 92, mozjpeg: true });
    case 'webp':
      return img.webp({ quality: 92 });
    case 'tiff':
      return img.tiff({ compression: 'lzw' });
    case 'avif':
      return img.avif({ quality: 70 });
    case 'gif':
      return img.gif();
    default:
      return img.png({ compressionLevel: 8 });
  }
}

const cropImage: ToolFn = async (inputs, ctx) => {
  const o = ctx.options as CropOptions;
  if (!o?.spec) throw new UserError('No crop was set.');
  const outputs: string[] = [];
  const errors: string[] = [];
  let done = 0;
  await pool(
    inputs,
    3,
    async (input) => {
      try {
        const src = await readable(input, ctx);
        const meta = await sharp(src.path).metadata();
        let W = meta.autoOrient?.width ?? meta.width;
        let H = meta.autoOrient?.height ?? meta.height;
        if (o.rotate === 90 || o.rotate === 270) [W, H] = [H, W];
        const r = cropRect(W, H, o.spec);
        // Order matters: orient → rotate → flip → extract → resize. sharp reorders flip/flop
        // inside one pipeline, so mirrored crops go through raw intermediate buffers.
        let img: Sharp;
        if (!o.flipH && !o.flipV) {
          img = sharp(src.path, { autoOrient: true, animated: false });
          if (o.rotate) img = img.rotate(o.rotate);
          if (!src.decoded) img = img.keepMetadata();
        } else {
          const a = await sharp(src.path, { autoOrient: true, animated: false }).rotate(o.rotate || 0).raw().toBuffer({ resolveWithObject: true });
          const b = await sharp(a.data, { raw: { width: a.info.width, height: a.info.height, channels: a.info.channels } })
            .flip(o.flipV)
            .flop(o.flipH)
            .raw()
            .toBuffer({ resolveWithObject: true });
          img = sharp(b.data, { raw: { width: b.info.width, height: b.info.height, channels: b.info.channels } });
        }
        img = img.extract(r);
        if (o.out) img = img.resize(Math.round(o.out.w), Math.round(o.out.h), { fit: 'fill', kernel: 'lanczos3' });
        const fmt = outFormat(input);
        const out = ctx.out(input, fmt, ' cropped');
        await encode(img, fmt).toFile(out);
        outputs.push(out);
      } catch (e: any) {
        if (inputs.length === 1) throw e;
        errors.push(`${basename(input)}: ${e?.message ?? e}`);
      } finally {
        ctx.progress(++done / inputs.length);
      }
    },
    ctx.signal,
  );
  if (!outputs.length && errors.length) throw new UserError(errors.join('\n'));
  return outputs;
};

// -------------------------------------------------------------------------- PDF

export interface PdfOptions {
  page: 'fit' | 'a4' | 'letter';
  orientation: 'auto' | 'portrait' | 'landscape';
  /** Margin in millimetres. */
  margin: number;
  /** File name without extension. */
  name?: string;
}

const PAGE: Record<'a4' | 'letter', [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };
const MM = 72 / 25.4;

/** JPEG or PNG bytes pdf-lib can embed, avoiding re-encoding when the file is already fine. */
async function embeddable(input: string, ctx: Ctx): Promise<{ kind: 'jpg' | 'png'; bytes: Uint8Array }> {
  const e = extOf(input);
  const src = await readable(input, ctx);
  const meta = await sharp(src.path).metadata();
  const upright = !meta.orientation || meta.orientation === 1;
  if (!src.decoded && ['jpg', 'jpeg', 'jfif'].includes(e) && upright && meta.space !== 'cmyk') {
    return { kind: 'jpg', bytes: readFileSync(input) };
  }
  if (!src.decoded && e === 'png' && meta.depth === 'uchar' && !meta.isProgressive) {
    return { kind: 'png', bytes: readFileSync(input) };
  }
  const img = sharp(src.path, { autoOrient: true, animated: false }).toColourspace('srgb');
  if (meta.hasAlpha) return { kind: 'png', bytes: await img.png({ compressionLevel: 8 }).toBuffer() };
  return { kind: 'jpg', bytes: await img.jpeg({ quality: 90, mozjpeg: true }).toBuffer() };
}

const createPdf: ToolFn = async (inputs, ctx) => {
  const o: PdfOptions = { page: 'fit', orientation: 'auto', margin: 0, ...(ctx.options ?? {}) };
  const doc = await PDFDocument.create();
  doc.setCreator('Orange');
  doc.setProducer('Orange');
  const margin = Math.max(0, o.margin) * MM;
  // Decode in parallel, add pages in order.
  const parts: ({ kind: 'jpg' | 'png'; bytes: Uint8Array } | null)[] = new Array(inputs.length).fill(null);
  let done = 0;
  await pool(
    inputs,
    3,
    async (input, i) => {
      parts[i] = await embeddable(input, ctx);
      ctx.progress((++done / inputs.length) * 0.8, basename(input));
    },
    ctx.signal,
  );
  if (ctx.signal.aborted) return [];
  for (let i = 0; i < inputs.length; i++) {
    const p = parts[i]!;
    const img = p.kind === 'jpg' ? await doc.embedJpg(p.bytes) : await doc.embedPng(p.bytes);
    const iw = img.width * 0.75; // 96 dpi → points
    const ih = img.height * 0.75;
    let pw: number, ph: number;
    if (o.page === 'fit') {
      const k = Math.min(1, 14000 / Math.max(iw + margin * 2, ih + margin * 2));
      pw = iw * k + margin * 2;
      ph = ih * k + margin * 2;
    } else {
      [pw, ph] = PAGE[o.page];
      const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && iw > ih);
      if (landscape) [pw, ph] = [ph, pw];
    }
    const page = doc.addPage([pw, ph]);
    const aw = Math.max(1, pw - margin * 2);
    const ah = Math.max(1, ph - margin * 2);
    const k = Math.min(aw / iw, ah / ih);
    const dw = iw * k;
    const dh = ih * k;
    page.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
    parts[i] = null;
  }
  ctx.progress(0.95, 'Writing PDF');
  const bytes = await doc.save();
  const name = (o.name ?? '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || basename(inputs[0], extname(inputs[0]));
  const out = ctx.out(join(dirname(inputs[0]), `${name}.pdf`), 'pdf');
  writeFileSync(out, bytes);
  return [out];
};

export const tools: Record<string, ToolFn> = { cropImage, createPdf };
