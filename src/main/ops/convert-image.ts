// Image conversion. sharp (libvips) does the heavy lifting for speed; ImageMagick decodes what libvips can't
// (HEIC, BMP, ICO, JXL); HEIC is written with libx265 via engines/heif; BMP and PDF are written here.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import type { Sharp, SharpOptions, Metadata } from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { binDir } from '../paths';
import { run } from '../engines/run';
import { encodeHeic } from '../engines/heif';
import { settings } from '../settings';
import { extOf } from '../../shared/catalog';
import type { ConverterModule, Ctx } from './types';
import { UserError } from './types';

sharp.cache(false); // files change on disk between conversions; never serve a stale decode
sharp.concurrency(0);

const magickExe = () => join(binDir, 'imagemagick', 'magick.exe');

/** Formats libvips (sharp) can read directly. */
const SHARP_IN = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'tif', 'tiff', 'avif', 'svg']);
/** Formats that may carry animation worth keeping. */
const ANIMATED_IN = new Set(['gif', 'webp']);
const WHITE = { r: 255, g: 255, b: 255 };

function quality(): number {
  const q = Number(settings.get()?.jpgQuality ?? 88);
  return Math.min(100, Math.max(1, Math.round(Number.isFinite(q) ? q : 88)));
}

const LIMITS = { limitInputPixels: 1_000_000_000, failOn: 'none' as const };

// ------------------------------------------------------------------ decoding

interface Source {
  /** File sharp should read (the original, or a decoded PNG in temp). */
  file: string;
  ext: string;
  /** True when `file` is the untouched original. */
  original: boolean;
}

/**
 * Make `input` readable by sharp. HEIC/HEIF, BMP, ICO and JXL are decoded by ImageMagick to a lossless PNG
 * (keeping the ICC profile and 16-bit depth). HEIC falls back to the pure-JS decoder if ImageMagick is missing.
 */
async function decodable(input: string, tmpDir: string, signal?: AbortSignal): Promise<Source> {
  const ext = extOf(input);
  if (SHARP_IN.has(ext)) return { file: input, ext, original: true };
  const out = join(tmpDir, 'decoded.png');
  if (existsSync(magickExe())) {
    let frame = '[0]';
    if (ext === 'ico' || ext === 'cur') frame = `[${await largestFrame(input, signal)}]`;
    // -auto-orient: honour EXIF orientation for formats where ImageMagick (not libheif) applies it.
    // Fast PNG (zlib level 1, no filtering): keeps ICC, Exif and 16-bit depth; ImageMagick's default PNG
    // settings are ~10x slower on large 10-bit HEICs.
    await run(
      magickExe(),
      [`${input}${frame}`, '-auto-orient', '-define', 'png:compression-level=1', '-define', 'png:compression-filter=0', `PNG:${out}`],
      { signal, env: { MAGICK_HOME: dirname(magickExe()) } },
    );
    return { file: out, ext, original: false };
  }
  if (ext === 'heic' || ext === 'heif') {
    const decode = require('heic-decode');
    const img = await decode({ buffer: readFileSync(input) });
    await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } })
      .png()
      .toFile(out);
    return { file: out, ext, original: false };
  }
  throw new UserError(`Can't read ${ext.toUpperCase()} images (ImageMagick is missing). Reinstall Orange.`);
}

async function largestFrame(input: string, signal?: AbortSignal): Promise<number> {
  try {
    const { stdout } = await run(magickExe(), ['identify', '-format', '%p %w %h\n', input], { signal, env: { MAGICK_HOME: dirname(magickExe()) } });
    let best = 0;
    let area = -1;
    for (const line of stdout.trim().split(/\r?\n/)) {
      const [i, w, h] = line.split(' ').map(Number);
      if (w * h > area) [best, area] = [i, w * h];
    }
    return best;
  } catch {
    return 0;
  }
}

/** sharp pipeline for a source: auto-oriented, sensible SVG resolution, optional animation. */
async function open(src: Source, animated: boolean): Promise<Sharp> {
  const opts: SharpOptions = { ...LIMITS, animated };
  if (src.ext === 'svg') {
    // SVGs render at their intrinsic size (often tiny icons). Render so the long edge is at least 2048 px.
    const m = await sharp(src.file, LIMITS).metadata();
    const long = Math.max(m.width ?? 0, m.height ?? 0) || 300;
    opts.density = Math.min(72 * 40, Math.max(72, (72 * 2048) / long));
  }
  return sharp(src.file, opts).autoOrient();
}

// ------------------------------------------------------------------ public API

export const converter: ConverterModule = {
  kinds: ['image'],
  async convert(input, target, ctx) {
    const t = target === 'jpeg' ? 'jpg' : target === 'tif' ? 'tiff' : target === 'heif' ? 'heic' : target;
    if (!['jpg', 'png', 'webp', 'heic', 'tiff', 'avif', 'bmp', 'pdf'].includes(t)) {
      throw new UserError(`Can't convert images to ${target.toUpperCase()}.`);
    }
    ctx.progress(0.05);
    const src = await decodable(input, ctx.tmp(), ctx.signal);
    ctx.progress(0.25);
    const out = ctx.out(input, t);
    try {
      await write(src, t, out, ctx);
    } catch (e: any) {
      rmSync(out, { force: true });
      if (ctx.signal.aborted) throw e;
      if (/unsupported image format|Input file is missing|corrupt|premature end|bad seek/i.test(String(e?.message))) {
        throw new UserError("This image can't be read. It may be damaged or in an unusual format.");
      }
      throw e;
    }
    ctx.progress(1);
    return [out];
  },
};

/** Decode any supported image (HEIC, TIFF, …) to a PNG at `out` so a browser can show it (≤ 4096 px). */
export async function toBrowserImage(input: string, out: string): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'orange-preview-'));
  try {
    const src = await decodable(input, tmp);
    const img = await open(src, false);
    await img
      .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .png({ compressionLevel: 3 })
      .toFile(out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ writers

async function write(src: Source, t: string, out: string, ctx: Ctx) {
  const q = quality();
  const meta = await sharp(src.file, LIMITS).metadata();
  const animated = ANIMATED_IN.has(src.ext) && (meta.pages ?? 1) > 1 && t === 'webp';
  const img = await open(src, animated);
  // Keep the camera's colour profile (Display P3 stays P3) and its Exif (date, camera, GPS);
  // autoOrient() has already rotated the pixels and reset Orientation.
  const keep = (s: Sharp) => (meta.icc ? s.keepIccProfile() : s).keepExif();

  switch (t) {
    case 'jpg':
      await keep(img.flatten({ background: WHITE }))
        .jpeg({ quality: q, mozjpeg: true, chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0' })
        .toFile(out);
      return;
    case 'png':
      await keep(img).png({ compressionLevel: 6, adaptiveFiltering: true }).toFile(out);
      return;
    case 'webp':
      await keep(img).webp({ quality: q, alphaQuality: 100, effort: 4, smartSubsample: true }).toFile(out);
      return;
    case 'tiff':
      await keep(img).tiff({ compression: 'lzw', predictor: 'horizontal' }).toFile(out);
      return;
    case 'avif':
      // AVIF's quality scale runs lower than JPEG's for the same visual result.
      await keep(img).avif({ quality: Math.max(30, Math.min(90, q - 25)), effort: 4, chromaSubsampling: q >= 95 ? '4:4:4' : '4:2:0' }).toFile(out);
      return;
    case 'bmp':
      await writeBmp(img, out);
      return;
    case 'heic': {
      const { data, info } = await img.flatten({ background: WHITE }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
      ctx.progress(0.45);
      const heic = await encodeHeic(data, info.width, info.height, { quality: q, exif: meta.exif, signal: ctx.signal, tmpDir: ctx.tmp() });
      writeFileSync(out, heic);
      return;
    }
    case 'pdf':
      await writePdf(src, img, meta, out, q);
      return;
  }
}

/** 24-bit BMP (BITMAPINFOHEADER, bottom-up), flattened onto white. */
async function writeBmp(img: Sharp, out: string) {
  const { data, info } = await img.flatten({ background: WHITE }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const stride = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + stride * h;
  if (size > 0xffffffff) throw new UserError('This image is too large for BMP.');
  const buf = Buffer.alloc(size);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(stride * h, 34);
  buf.writeInt32LE(2835, 38); // 72 dpi
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * stride;
    const srcRow = y * w * 3;
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * 3;
      const d = row + x * 3;
      buf[d] = data[s + 2];
      buf[d + 1] = data[s + 1];
      buf[d + 2] = data[s];
    }
  }
  writeFileSync(out, buf);
}

/** One page sized to the image (using its DPI when it has one), scaled down to A4 if it would be huge. */
async function writePdf(src: Source, img: Sharp, meta: Metadata, out: string, q: number) {
  const pdf = await PDFDocument.create();
  pdf.setProducer('Orange');
  pdf.setCreator('Orange');
  const photo = ['jpg', 'jpeg', 'jfif', 'heic', 'heif', 'avif', 'webp'].includes(src.ext);
  const orientedOk = !meta.orientation || meta.orientation === 1;
  let embedded;
  if (src.original && (src.ext === 'jpg' || src.ext === 'jpeg' || src.ext === 'jfif') && orientedOk && !meta.icc && meta.channels !== 4 && meta.space !== 'cmyk') {
    embedded = await pdf.embedJpg(readFileSync(src.file)); // lossless pass-through
  } else if (photo && !meta.hasAlpha) {
    const jpg = await img.flatten({ background: WHITE }).toColourspace('srgb').jpeg({ quality: Math.max(q, 85), mozjpeg: true }).toBuffer();
    embedded = await pdf.embedJpg(jpg);
  } else {
    embedded = await pdf.embedPng(await img.toColourspace('srgb').png({ compressionLevel: 6 }).toBuffer());
  }
  const dpi = meta.density && meta.density >= 72 && meta.density <= 1200 ? meta.density : 72;
  let w = (embedded.width * 72) / dpi;
  let h = (embedded.height * 72) / dpi;
  const long = Math.max(w, h);
  if (long > 1190) {
    const k = 842 / long; // fit the long edge to A4 so it prints sensibly
    w *= k;
    h *= k;
  }
  const page = pdf.addPage([w, h]);
  page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
  writeFileSync(out, await pdf.save());
}
