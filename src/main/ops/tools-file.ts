// File tools: Compress (anything), Metadata (inspect / edit / strip) and the instant Extract.
// Every tool writes new files next to the originals; nothing is overwritten unless the user turned
// on "Replace original" (metadata only).
import { ipcMain } from 'electron';
import { createWriteStream, readdirSync, statSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { cpus } from 'node:os';
import { crc32 } from 'node:zlib';
import { extOf, kindOfExt, type Kind } from '../../shared/catalog';
import type { Ctx, ToolFn } from './types';
import { UserError } from './types';
import { run } from '../engines/run';
import { bin, hasBin } from '../paths';
import { settings } from '../settings';
import { converter as archiveConverter } from './convert-archive';
import { log } from '../log';
import type sharpType from 'sharp';

const CPU = Math.max(1, cpus().length);
const stem = (p: string) => basename(p, extname(p));
// Loaded on first use: sharp's native module is slow to load and most runs never need it.
const sharpLib = (): typeof sharpType => require('sharp');

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function aborted(ctx: Ctx) {
  if (ctx.signal.aborted) throw new Error('Cancelled');
}

/** Runs `fn` over items with a concurrency cap, in order of completion. */
async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

// ------------------------------------------------------------------ ffmpeg bits
// A tiny local helper (kept independent of engines/ffmpeg.ts on purpose).

interface Probe {
  format?: { duration?: string; bit_rate?: string; tags?: Record<string, string>; format_name?: string; format_long_name?: string; size?: string };
  streams?: any[];
  chapters?: any[];
}

async function ffprobe(input: string, signal?: AbortSignal): Promise<Probe> {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', input], { signal });
  return JSON.parse(r.stdout || '{}');
}

async function ffmpeg(args: string[], out: string, ctx: Ctx, duration: number, onFrac: (f: number) => void) {
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args, '-progress', 'pipe:1', '-nostats', out], {
    signal: ctx.signal,
    onLine(line, stream) {
      if (stream !== 'stdout' || !duration) return;
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m) onFrac(Math.min(1, Number(m[1]) / 1e6 / duration));
    },
  });
}

// ---------------------------------------------------------------- compress: probe

type CKind = 'image' | 'video' | 'audio' | 'pdf' | 'office' | 'zip';

const IMAGE_OUT: Record<string, string> = {
  jpg: 'jpg', jpeg: 'jpg', jfif: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', tif: 'tiff', tiff: 'tiff',
  heic: 'jpg', heif: 'jpg', bmp: 'png', jxl: 'jpg',
};
const OFFICE = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'docm', 'pptm', 'xlsm']);

function compressKind(path: string): CKind {
  if (isDir(path)) return 'zip';
  const ext = extOf(path);
  const k: Kind = kindOfExt(ext);
  if (k === 'image') return IMAGE_OUT[ext] ? 'image' : 'zip';
  if (k === 'video') return 'video';
  if (k === 'audio') return 'audio';
  if (k === 'pdf') return 'pdf';
  if (OFFICE.has(ext)) return 'office';
  return 'zip';
}

function folderSize(p: string, budget = { n: 20000 }): number {
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (--budget.n < 0) break;
    const full = join(p, e.name);
    try {
      if (e.isDirectory()) total += folderSize(full, budget);
      else if (e.isFile()) total += statSync(full).size;
    } catch {
      /* unreadable entries don't count */
    }
  }
  return total;
}

export interface ProbeInfo {
  path: string;
  kind: CKind;
  size: number;
  dir?: boolean;
  duration?: number;
  width?: number;
  height?: number;
  /** total bitrate, kbps */
  kbps?: number;
  audioKbps?: number;
  hasAudio?: boolean;
  outExt?: string;
  error?: string;
}

async function probe(path: string): Promise<ProbeInfo> {
  const kind = compressKind(path);
  const dir = isDir(path);
  const info: ProbeInfo = { path, kind, size: dir ? folderSize(path) : statSync(path).size, dir };
  try {
    if (kind === 'image') {
      info.outExt = IMAGE_OUT[extOf(path)];
      const m = await sharpLib()(path, { failOn: 'none' }).metadata();
      info.width = m.autoOrient?.width ?? m.width;
      info.height = m.autoOrient?.height ?? m.height;
    } else if (kind === 'video' || kind === 'audio') {
      const p = await ffprobe(path);
      info.duration = Number(p.format?.duration) || 0;
      info.kbps = Math.round((Number(p.format?.bit_rate) || (info.size * 8) / Math.max(1, info.duration)) / 1000);
      const v = p.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
      const a = p.streams?.find((s) => s.codec_type === 'audio');
      if (v) {
        info.width = v.width;
        info.height = v.height;
      }
      info.hasAudio = !!a;
      info.audioKbps = a?.bit_rate ? Math.round(Number(a.bit_rate) / 1000) : undefined;
      info.outExt = kind === 'video' ? 'mp4' : audioPlan(extOf(path), 128).ext;
      if (kind === 'video' && !v) info.kind = 'audio';
    } else if (kind === 'pdf') info.outExt = 'pdf';
    else if (kind === 'office') info.outExt = extOf(path);
    else info.outExt = 'zip';
  } catch (e: any) {
    info.error = String(e?.message ?? e);
  }
  return info;
}

// ---------------------------------------------------------------- compress: images

export interface ImageOpts {
  mode: 'quality' | 'size' | 'percent';
  quality: number; // 1..100
  targetBytes: number;
  percent: number; // target size as % of the original
  maxEdge: number; // 0 = keep
  strip: boolean;
}
const IMAGE_DEFAULTS: ImageOpts = { mode: 'quality', quality: 75, targetBytes: 500_000, percent: 50, maxEdge: 0, strip: true };

async function decodable(path: string): Promise<Buffer | string> {
  const ext = extOf(path);
  if (ext !== 'heic' && ext !== 'heif') return path;
  try {
    await sharpLib()(path).metadata();
    await sharpLib()(path).resize(8).raw().toBuffer();
    return path;
  } catch {
    // The bundled libvips can't decode HEVC; fall back to the JS decoder.
    const convert = require('heic-convert');
    return Buffer.from(await convert({ buffer: await readFile(path), format: 'JPEG', quality: 0.98 }));
  }
}

async function encodeImage(src: Buffer | string, fmt: string, q: number, width: number | undefined, height: number | undefined, strip: boolean): Promise<Buffer> {
  const sharp = sharpLib();
  const animated = fmt === 'gif' || fmt === 'webp';
  let img = sharp(src, { failOn: 'none', animated, limitInputPixels: false }).autoOrient();
  if (width || height) img = img.resize({ width, height, fit: 'inside', withoutEnlargement: true });
  img = strip ? img.keepIccProfile() : img.keepExif().keepIccProfile().keepXmp();
  q = Math.max(1, Math.min(100, Math.round(q)));
  switch (fmt) {
    case 'jpg':
      return img.jpeg({ quality: q, mozjpeg: true }).toBuffer();
    case 'png':
      return q >= 100
        ? img.png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true }).toBuffer()
        : img.png({ palette: true, quality: q, effort: 10, compressionLevel: 9 }).toBuffer();
    case 'webp':
      return img.webp({ quality: q, effort: 5, smartSubsample: true }).toBuffer();
    case 'avif':
      return img.avif({ quality: Math.max(1, q - 10), effort: 4 }).toBuffer();
    case 'gif':
      return img.gif({ effort: 10, colours: Math.max(4, Math.round((q / 100) * 256)), dither: 0.6 }).toBuffer();
    case 'tiff':
      return img.tiff({ compression: 'jpeg', quality: q }).toBuffer();
    default:
      return img.jpeg({ quality: q, mozjpeg: true }).toBuffer();
  }
}

/** Compresses one image according to opts; returns the bytes (not written yet). */
async function compressImageBytes(path: string, opts: ImageOpts, signal?: AbortSignal): Promise<{ buf: Buffer; fmt: string }> {
  const fmt = IMAGE_OUT[extOf(path)] ?? 'jpg';
  const src = await decodable(path);
  const meta = await sharpLib()(src, { failOn: 'none' }).metadata();
  const w0 = meta.autoOrient?.width ?? meta.width ?? 0;
  const h0 = meta.autoOrient?.height ?? meta.height ?? 0;
  const edge = (scale: number) => {
    let w = Math.round(w0 * scale);
    let h = Math.round(h0 * scale);
    if (opts.maxEdge && Math.max(w, h) > opts.maxEdge) {
      const k = opts.maxEdge / Math.max(w, h);
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    return w && h && (w < w0 || h < h0) ? { w, h } : { w: undefined, h: undefined };
  };
  const enc = (q: number, scale = 1) => {
    if (signal?.aborted) throw new Error('Cancelled');
    const { w, h } = edge(scale);
    return encodeImage(src, fmt, q, w, h, opts.strip);
  };

  if (opts.mode === 'quality') return { buf: await enc(opts.quality), fmt };

  const original = statSync(path).size;
  const target = Math.max(2048, opts.mode === 'size' ? opts.targetBytes : (original * opts.percent) / 100);
  // Search quality first (keeps full resolution), then shrink dimensions if even the lowest
  // sensible quality is too big.
  let scale = 1;
  let smallest: Buffer | null = null;
  for (let round = 0; round < 5; round++) {
    const floor = fmt === 'png' || fmt === 'gif' ? 10 : 30;
    const low = await enc(floor, scale);
    if (!smallest || low.length < smallest.length) smallest = low;
    if (low.length > target) {
      scale *= Math.max(0.3, Math.min(0.95, Math.sqrt(target / low.length) * 0.95));
      continue;
    }
    let lo = floor;
    let hi = 95;
    let best = low;
    while (hi - lo > 4) {
      const mid = Math.round((lo + hi) / 2);
      const b = await enc(mid, scale);
      if (b.length <= target) {
        best = b;
        lo = mid;
      } else hi = mid;
    }
    return { buf: best, fmt };
  }
  return { buf: smallest!, fmt };
}

// ---------------------------------------------------------- compress: video/audio

export interface VideoOpts {
  mode: 'preset' | 'size';
  preset: 'high' | 'medium' | 'small';
  targetMB: number;
  height: number; // 0 = keep
}
const VIDEO_DEFAULTS: VideoOpts = { mode: 'preset', preset: 'medium', targetMB: 25, height: 0 };
const CRF = { high: 23, medium: 27, small: 31 };

async function compressVideo(input: string, out: string, opts: VideoOpts, ctx: Ctx, onFrac: (f: number) => void) {
  const info = await probe(input);
  const dur = info.duration ?? 0;
  const args = ['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium'];
  let height = opts.height;
  let audioK = 128;
  if (opts.mode === 'size') {
    if (!dur) throw new UserError(`Can't tell how long ${basename(input)} is, so a target size can't be planned.`);
    const totalK = (opts.targetMB * 8 * 1024 * 1024 * 0.96) / 1000 / dur; // kbps for the whole file
    if (info.hasAudio) audioK = totalK < 600 ? 64 : totalK < 1500 ? 96 : 128;
    const vk = Math.floor(totalK - (info.hasAudio ? audioK : 0));
    if (vk < 80) throw new UserError(`${opts.targetMB} MB is too small for ${Math.round(dur)} s of video. Try a larger size.`);
    // Very low bitrates look better at a lower resolution.
    if (!height && info.height) {
      if (vk < 500 && info.height > 480) height = 480;
      else if (vk < 1200 && info.height > 720) height = 720;
      else if (vk < 2500 && info.height > 1080) height = 1080;
    }
    args.push('-b:v', `${vk}k`, '-maxrate', `${Math.round(vk * 1.45)}k`, '-bufsize', `${vk * 2}k`);
  } else {
    args.push('-crf', String(CRF[opts.preset] ?? 27));
    if (opts.preset === 'small') audioK = 96;
  }
  if (height && info.height && info.height > height) args.push('-vf', `scale=-2:${height}`);
  if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', `${audioK}k`);
  args.push('-movflags', '+faststart', '-map_metadata', '0');
  await ffmpeg(args, out, ctx, dur, onFrac);
}

function audioPlan(ext: string, kbps: number): { ext: string; args: string[] } {
  switch (ext) {
    case 'mp3':
      return { ext: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`] };
    case 'ogg':
    case 'oga':
    case 'opus':
      return { ext, args: ['-c:a', 'libopus', '-b:a', `${Math.min(kbps, 256)}k`] };
    case 'm4a':
    case 'aac':
    default:
      // Lossless and uncommon formats become AAC in an .m4a.
      return { ext: 'm4a', args: ['-c:a', 'aac', '-b:a', `${kbps}k`] };
  }
}

async function compressAudio(input: string, kbps: number, ctx: Ctx, onFrac: (f: number) => void): Promise<string> {
  const info = await probe(input);
  const plan = audioPlan(extOf(input), kbps);
  const out = ctx.out(input, plan.ext, ' compressed');
  // Keep cover art when the container can hold it.
  const keepCover = plan.ext === 'mp3' || plan.ext === 'm4a';
  const args = ['-i', input, '-map', '0:a:0', ...(keepCover ? ['-map', '0:v?', '-c:v', 'copy', '-disposition:v', 'attached_pic'] : []), ...plan.args, '-map_metadata', '0'];
  if (plan.ext === 'mp3') args.push('-id3v2_version', '3');
  try {
    await ffmpeg(args, out, ctx, info.duration ?? 0, onFrac);
  } catch (e) {
    if (ctx.signal.aborted || !keepCover) throw e;
    await ffmpeg(['-i', input, '-map', '0:a:0', ...plan.args, '-map_metadata', '0'], out, ctx, info.duration ?? 0, onFrac);
  }
  return out;
}

// --------------------------------------------------------------- compress: PDF

export type PdfLevel = 'printer' | 'ebook' | 'screen';
const GS = 'gs/bin/gswin64c';
const PDF_IMG: Record<PdfLevel, { q: number; edge: number }> = {
  printer: { q: 85, edge: 3300 },
  ebook: { q: 70, edge: 1800 },
  screen: { q: 50, edge: 1100 },
};

async function compressPdf(input: string, out: string, level: PdfLevel, ctx: Ctx, onFrac: (f: number) => void) {
  const { PDFDocument } = await import('pdf-lib');
  const bytes = await readFile(input);
  const probeDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }).catch(() => null);
  if (probeDoc?.isEncrypted) throw new UserError(`${basename(input)} is password-protected. Remove the protection first.`);
  const pages = probeDoc?.getPageCount() ?? 0;

  if (hasBin(GS)) {
    try {
      await run(
        bin(GS),
        [
          '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.6', `-dPDFSETTINGS=/${level}`, '-dNOPAUSE', '-dBATCH', '-dSAFER',
          '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-dAutoRotatePages=/None',
          `-sOutputFile=${out}`, input,
        ],
        {
          signal: ctx.signal,
          onLine(line) {
            const m = /^Page (\d+)/.exec(line);
            if (m && pages) onFrac(Math.min(0.99, Number(m[1]) / pages));
          },
        },
      );
      return;
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      log('ghostscript failed, using pdf-lib', e);
      await rm(out, { force: true });
    }
  }

  // Fallback: recompress embedded JPEGs and re-save with object streams.
  const { PDFRawStream, PDFName, PDFNumber, PDFArray } = await import('pdf-lib');
  const doc = probeDoc ?? (await PDFDocument.load(bytes, { updateMetadata: false }));
  const { q, edge } = PDF_IMG[level];
  const objs = doc.context.enumerateIndirectObjects();
  let done = 0;
  for (const [ref, obj] of objs) {
    done++;
    if (done % 20 === 0) onFrac(Math.min(0.9, done / objs.length));
    aborted(ctx);
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const filter = dict.get(PDFName.of('Filter'));
    const isDct = filter === PDFName.of('DCTDecode') || (filter instanceof PDFArray && filter.size() === 1 && filter.get(0) === PDFName.of('DCTDecode'));
    if (!isDct || dict.get(PDFName.of('Decode'))) continue;
    try {
      const raw = Buffer.from(obj.contents);
      const sharp = sharpLib();
      const m = await sharp(raw).metadata();
      if (m.channels === 4 || m.space === 'cmyk') continue;
      const big = Math.max(m.width ?? 0, m.height ?? 0) > edge;
      let img = sharp(raw);
      if (big) img = img.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
      const { data, info } = await img.jpeg({ quality: q, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      if (data.length >= raw.length * 0.9) continue;
      const nd = dict.clone(doc.context);
      nd.set(PDFName.of('Width'), PDFNumber.of(info.width));
      nd.set(PDFName.of('Height'), PDFNumber.of(info.height));
      nd.set(PDFName.of('Length'), PDFNumber.of(data.length));
      nd.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      nd.set(PDFName.of('ColorSpace'), PDFName.of(info.channels === 1 ? 'DeviceGray' : 'DeviceRGB'));
      doc.context.assign(ref, PDFRawStream.of(nd, new Uint8Array(data)));
    } catch {
      /* leave images we can't decode alone */
    }
  }
  await writeFile(out, await doc.save({ useObjectStreams: true }));
}

// ------------------------------------------------------------- compress: Office

async function compressOffice(input: string, out: string, level: PdfLevel, ctx: Ctx, onFrac: (f: number) => void) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await readFile(input));
  const { q, edge } = PDF_IMG[level];
  const media = Object.values(zip.files).filter((f) => !f.dir && /(^|\/)media\/|^Pictures\//i.test(f.name) && /\.(jpe?g|png)$/i.test(f.name));
  let i = 0;
  await pool(media, Math.max(1, CPU - 1), async (f) => {
    aborted(ctx);
    const raw = await f.async('nodebuffer');
    try {
      const sharp = sharpLib();
      const isPng = /\.png$/i.test(f.name);
      let img = sharp(raw, { failOn: 'none' }).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
      const outBuf = isPng
        ? await img.png({ palette: level !== 'printer', quality: q + 10, compressionLevel: 9, effort: 10 }).toBuffer()
        : await img.jpeg({ quality: q, mozjpeg: true }).toBuffer();
      if (outBuf.length < raw.length * 0.95) zip.file(f.name, outBuf);
    } catch {
      /* keep the original image */
    }
    onFrac((++i / Math.max(1, media.length)) * 0.8);
  });
  // ODF packages need "mimetype" first and uncompressed.
  const mt = zip.file('mimetype');
  if (mt) zip.file('mimetype', await mt.async('nodebuffer'), { compression: 'STORE' });
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }, (m) =>
    onFrac(0.8 + (m.percent / 100) * 0.2),
  );
  await writeFile(out, buf);
}

// ------------------------------------------------------------------- compress: ZIP

async function zipItems(items: string[], out: string, ctx: Ctx, onFrac: (f: number) => void) {
  if (hasBin('7z')) {
    await run('7z', ['a', '-tzip', '-mx=9', '-mmt=on', '-bsp1', '-bso0', '-y', '--', out, ...items], {
      signal: ctx.signal,
      onLine(line) {
        const m = /(\d+)%/.exec(line);
        if (m) onFrac(Number(m[1]) / 100);
      },
    });
    return;
  }
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const add = (p: string, base: string) => {
    if (isDir(p)) {
      zip.folder(relative(base, p).replace(/\\/g, '/'));
      for (const e of readdirSync(p)) add(join(p, e), base);
    } else zip.file(relative(base, p).replace(/\\/g, '/'), readFile(p), { date: statSync(p).mtime });
  };
  for (const it of items) add(it, dirname(it));
  await new Promise<void>((resolve, reject) => {
    zip
      .generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } }, (m) => onFrac(m.percent / 100))
      .pipe(createWriteStream(out))
      .on('finish', () => resolve())
      .on('error', reject);
  });
}

// --------------------------------------------------------------- compress: tool

export interface CompressOptions {
  image?: Partial<ImageOpts>;
  video?: Partial<VideoOpts>;
  audio?: { kbps?: number };
  pdf?: { level?: PdfLevel };
  office?: { level?: PdfLevel };
}

const compress: ToolFn = async (inputs, ctx) => {
  const o = (ctx.options ?? {}) as CompressOptions;
  const img = { ...IMAGE_DEFAULTS, ...o.image };
  const vid = { ...VIDEO_DEFAULTS, ...o.video };
  const kbps = o.audio?.kbps ?? 128;
  const pdfLevel = o.pdf?.level ?? 'ebook';
  const officeLevel = o.office?.level ?? 'ebook';

  const groups = new Map<CKind, string[]>();
  for (const p of inputs) {
    const k = compressKind(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  // Progress weighted by size so one big video doesn't look stuck at 90%.
  const weights = new Map(inputs.map((p) => [p, Math.max(1, isDir(p) ? 1e6 : statSync(p).size)]));
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const frac = new Map<string, number>();
  const tick = (key: string, f: number, note?: string) => {
    frac.set(key, f);
    let sum = 0;
    for (const [p, w] of weights) sum += (frac.get(p) ?? 0) * w;
    ctx.progress(Math.min(0.999, sum / total), note);
  };

  const outputs: string[] = [];
  const skipped: string[] = [];
  const failures: string[] = [];
  /** Keep the result only when it actually saved space. */
  const keepIfSmaller = async (input: string, out: string) => {
    const before = weights.get(input)!;
    const after = (await stat(out)).size;
    if (after >= before) {
      await rm(out, { force: true });
      skipped.push(basename(input));
    } else outputs.push(out);
  };
  const guard = async (input: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e: any) {
      if (ctx.signal.aborted) throw e;
      log('compress failed', input, e);
      failures.push(`${basename(input)}: ${e instanceof UserError ? e.message : String(e?.message ?? e).slice(0, 160)}`);
    } finally {
      tick(input, 1);
    }
  };

  // Images: in parallel.
  await pool(groups.get('image') ?? [], Math.max(1, CPU - 1), (p) =>
    guard(p, async () => {
      const { buf, fmt } = await compressImageBytes(p, img, ctx.signal);
      if (buf.length >= weights.get(p)!) return void skipped.push(basename(p));
      const out = ctx.out(p, fmt, ' compressed');
      await writeFile(out, buf);
      outputs.push(out);
    }),
  );
  // Video and audio: one at a time (ffmpeg already uses every core).
  for (const p of groups.get('video') ?? []) {
    aborted(ctx);
    await guard(p, async () => {
      // Audio-only "videos" (an .mp4 or .webm with no picture) are treated as audio.
      if (!(await probe(p)).height) return void (await keepIfSmaller(p, await compressAudio(p, kbps, ctx, (f) => tick(p, f))));
      const out = ctx.out(p, 'mp4', ' compressed');
      await compressVideo(p, out, vid, ctx, (f) => tick(p, f, `Compressing ${basename(p)}`));
      await keepIfSmaller(p, out);
    });
  }
  await pool(groups.get('audio') ?? [], Math.max(1, Math.floor(CPU / 2)), (p) =>
    guard(p, async () => {
      const out = await compressAudio(p, kbps, ctx, (f) => tick(p, f));
      await keepIfSmaller(p, out);
    }),
  );
  for (const p of groups.get('pdf') ?? []) {
    aborted(ctx);
    await guard(p, async () => {
      const out = ctx.out(p, 'pdf', ' compressed');
      await compressPdf(p, out, pdfLevel, ctx, (f) => tick(p, f, `Compressing ${basename(p)}`));
      await keepIfSmaller(p, out);
    });
  }
  for (const p of groups.get('office') ?? []) {
    aborted(ctx);
    await guard(p, async () => {
      const out = ctx.out(p, extOf(p), ' compressed');
      await compressOffice(p, out, officeLevel, ctx, (f) => tick(p, f));
      await keepIfSmaller(p, out);
    });
  }
  // Everything else (folders, other files) goes into one ZIP.
  const rest = groups.get('zip') ?? [];
  if (rest.length) {
    aborted(ctx);
    const first = rest[0];
    const name = rest.length === 1 ? (isDir(first) ? join(dirname(first), basename(first)) : first) : join(dirname(first), 'Archive');
    const out = ctx.out(name, 'zip');
    try {
      await zipItems(rest, out, ctx, (f) => rest.forEach((p) => tick(p, f, 'Zipping')));
      outputs.push(out);
    } catch (e: any) {
      if (ctx.signal.aborted) throw e;
      failures.push(`ZIP: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }

  if (!outputs.length) {
    if (failures.length) throw new UserError(failures.join('\n'));
    throw new UserError(
      skipped.length === 1 ? `${skipped[0]} is already as small as these settings can make it.` : 'These files are already as small as these settings can make them.',
    );
  }
  if (failures.length) log('compress partial failures', failures);
  return outputs;
};

// IPC for the Compress window: sizes/durations, and real image estimates.
ipcMain.handle('compress:probe', (_e, paths: string[]) => Promise.all(paths.map((p) => probe(p).catch((e) => ({ path: p, kind: 'zip', size: 0, error: String(e) })))));

const estimateCache = new Map<string, number>();
ipcMain.handle('compress:estimate', async (_e, paths: string[], opts: ImageOpts) => {
  const out: Record<string, number> = {};
  await pool(paths.slice(0, 8), 3, async (p) => {
    const key = `${p}|${statSync(p).mtimeMs}|${JSON.stringify(opts)}`;
    let n = estimateCache.get(key);
    if (n === undefined) {
      try {
        n = (await compressImageBytes(p, { ...IMAGE_DEFAULTS, ...opts })).buf.length;
      } catch {
        n = -1;
      }
      if (estimateCache.size > 300) estimateCache.clear();
      estimateCache.set(key, n);
    }
    out[p] = n;
  });
  return out;
});

// ============================================================================ EXIF
// Just enough TIFF/EXIF to list tags like exiftool does and to rewrite a few of them losslessly.

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, SBYTE: 6, UNDEFINED: 7, SSHORT: 8, SLONG: 9, SRATIONAL: 10 };
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** raw value bytes (in the file's byte order) */
  bytes: Buffer;
}
interface Ifd {
  entries: Entry[];
  next: number;
}
interface Tiff {
  le: boolean;
  buf: Buffer;
  ifd0: Ifd;
  ifd0Offset: number;
  exif?: Ifd;
  gps?: Ifd;
  interop?: Ifd;
  ifd1?: Ifd;
}

const IFD_NAMES = { EXIF: 0x8769, GPS: 0x8825, INTEROP: 0xa005 };

function readIfd(buf: Buffer, off: number, le: boolean): Ifd | undefined {
  if (off < 8 || off + 2 > buf.length) return undefined;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const n = u16(off);
  if (n > 1000 || off + 2 + n * 12 > buf.length) return undefined;
  const entries: Entry[] = [];
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const tag = u16(e);
    const type = u16(e + 2);
    const count = u32(e + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    if (!TYPE_SIZE[type] || size > buf.length) continue;
    const at = size <= 4 ? e + 8 : u32(e + 8);
    if (at + size > buf.length) continue;
    entries.push({ tag, type, count, bytes: Buffer.from(buf.subarray(at, at + size)) });
  }
  const nextAt = off + 2 + n * 12;
  return { entries, next: nextAt + 4 <= buf.length ? u32(nextAt) : 0 };
}

function parseTiff(buf: Buffer): Tiff | undefined {
  if (buf.length < 8) return undefined;
  const order = buf.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return undefined;
  const le = order === 'II';
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd0Offset = u32(4);
  const ifd0 = readIfd(buf, ifd0Offset, le);
  if (!ifd0) return undefined;
  const ptr = (ifd: Ifd | undefined, tag: number) => {
    const e = ifd?.entries.find((x) => x.tag === tag);
    return e ? (le ? e.bytes.readUInt32LE(0) : e.bytes.readUInt32BE(0)) : 0;
  };
  const exif = readIfd(buf, ptr(ifd0, IFD_NAMES.EXIF), le);
  return {
    le,
    buf,
    ifd0,
    ifd0Offset,
    exif,
    gps: readIfd(buf, ptr(ifd0, IFD_NAMES.GPS), le),
    interop: readIfd(buf, ptr(exif, IFD_NAMES.INTEROP), le),
    ifd1: ifd0.next ? readIfd(buf, ifd0.next, le) : undefined,
  };
}

function values(e: Entry, le: boolean): (number | [number, number])[] {
  const out: (number | [number, number])[] = [];
  const b = e.bytes;
  for (let i = 0; i < e.count && i < 256; i++) {
    switch (e.type) {
      case T.BYTE:
      case T.UNDEFINED:
        out.push(b[i]);
        break;
      case T.SBYTE:
        out.push(b.readInt8(i));
        break;
      case T.SHORT:
        out.push(le ? b.readUInt16LE(i * 2) : b.readUInt16BE(i * 2));
        break;
      case T.SSHORT:
        out.push(le ? b.readInt16LE(i * 2) : b.readInt16BE(i * 2));
        break;
      case T.LONG:
        out.push(le ? b.readUInt32LE(i * 4) : b.readUInt32BE(i * 4));
        break;
      case T.SLONG:
        out.push(le ? b.readInt32LE(i * 4) : b.readInt32BE(i * 4));
        break;
      case T.RATIONAL:
        out.push([le ? b.readUInt32LE(i * 8) : b.readUInt32BE(i * 8), le ? b.readUInt32LE(i * 8 + 4) : b.readUInt32BE(i * 8 + 4)]);
        break;
      case T.SRATIONAL:
        out.push([le ? b.readInt32LE(i * 8) : b.readInt32BE(i * 8), le ? b.readInt32LE(i * 8 + 4) : b.readInt32BE(i * 8 + 4)]);
        break;
    }
  }
  return out;
}

const asciiOf = (e: Entry) => e.bytes.toString('utf8').replace(/\0+$/, '').replace(/\0/g, ' ').trim();
const ratio = (v: number | [number, number]) => (Array.isArray(v) ? (v[1] ? v[0] / v[1] : 0) : v);

const TAGS: Record<number, string> = {
  0x010e: 'Image description', 0x010f: 'Camera make', 0x0110: 'Camera model', 0x0112: 'Orientation', 0x011a: 'X resolution',
  0x011b: 'Y resolution', 0x0128: 'Resolution unit', 0x0131: 'Software', 0x0132: 'Modified', 0x013b: 'Artist', 0x013e: 'White point',
  0x0213: 'YCbCr positioning', 0x8298: 'Copyright', 0x9c9b: 'Title (Windows)', 0x9c9c: 'Comment (Windows)', 0x9c9d: 'Author (Windows)',
  0x9c9e: 'Keywords (Windows)', 0x9c9f: 'Subject (Windows)', 0x4746: 'Rating',
  0x829a: 'Exposure time', 0x829d: 'F-number', 0x8822: 'Exposure program', 0x8827: 'ISO', 0x8830: 'Sensitivity type',
  0x9000: 'Exif version', 0x9003: 'Date taken', 0x9004: 'Date digitized', 0x9010: 'Time zone', 0x9011: 'Time zone (taken)',
  0x9101: 'Components', 0x9201: 'Shutter speed value', 0x9202: 'Aperture value', 0x9203: 'Brightness', 0x9204: 'Exposure bias',
  0x9205: 'Max aperture', 0x9206: 'Subject distance', 0x9207: 'Metering mode', 0x9208: 'Light source', 0x9209: 'Flash',
  0x920a: 'Focal length', 0x9214: 'Subject area', 0x927c: 'Maker notes', 0x9286: 'User comment', 0x9290: 'Subsec time',
  0x9291: 'Subsec time (taken)', 0x9292: 'Subsec time (digitized)', 0xa000: 'FlashPix version', 0xa001: 'Color space',
  0xa002: 'Image width', 0xa003: 'Image height', 0xa20e: 'Focal plane X res', 0xa20f: 'Focal plane Y res', 0xa217: 'Sensing method',
  0xa300: 'File source', 0xa301: 'Scene type', 0xa401: 'Custom rendered', 0xa402: 'Exposure mode', 0xa403: 'White balance',
  0xa404: 'Digital zoom', 0xa405: 'Focal length (35mm)', 0xa406: 'Scene capture type', 0xa408: 'Contrast', 0xa409: 'Saturation',
  0xa40a: 'Sharpness', 0xa420: 'Image unique ID', 0xa430: 'Camera owner', 0xa431: 'Body serial number', 0xa432: 'Lens specification',
  0xa433: 'Lens make', 0xa434: 'Lens model', 0xa435: 'Lens serial number',
  0x0000: 'GPS version', 0x0001: 'Latitude ref', 0x0002: 'Latitude', 0x0003: 'Longitude ref', 0x0004: 'Longitude', 0x0005: 'Altitude ref',
  0x0006: 'Altitude', 0x0007: 'GPS time (UTC)', 0x0008: 'Satellites', 0x000c: 'Speed unit', 0x000d: 'Speed', 0x0010: 'Direction ref',
  0x0011: 'Direction', 0x0012: 'Map datum', 0x0017: 'Destination bearing ref', 0x0018: 'Destination bearing', 0x001b: 'Processing method',
  0x001d: 'GPS date', 0x001f: 'Horizontal error',
};
const GPS_TAGS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 0xc, 0xd, 0x10, 0x11, 0x12, 0x17, 0x18, 0x1b, 0x1d, 0x1f]);
const ENUMS: Record<number, Record<number, string>> = {
  0x0112: { 1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored vertically', 5: 'Mirrored, rotated 270°', 6: 'Rotated 90° CW', 7: 'Mirrored, rotated 90°', 8: 'Rotated 270° CW' },
  0x0128: { 1: 'None', 2: 'Inches', 3: 'Centimeters' },
  0x8822: { 0: 'Not defined', 1: 'Manual', 2: 'Program AE', 3: 'Aperture priority', 4: 'Shutter priority', 5: 'Creative', 6: 'Action', 7: 'Portrait', 8: 'Landscape' },
  0x9207: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot', 4: 'Multi-spot', 5: 'Multi-segment', 6: 'Partial' },
  0xa001: { 1: 'sRGB', 0xffff: 'Uncalibrated' },
  0xa402: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' },
  0xa403: { 0: 'Auto', 1: 'Manual' },
  0xa406: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' },
  0x0005: { 0: 'Above sea level', 1: 'Below sea level' },
};

function fmtNum(n: number, digits = 2) {
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function describe(e: Entry, le: boolean, gps: boolean): string {
  if (e.type === T.ASCII) {
    const s = asciiOf(e);
    // EXIF dates use colons in the date part ("2024:05:06 07:08:09"); show them readably.
    return [0x0132, 0x9003, 0x9004].includes(e.tag) && !gps ? s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : s;
  }
  if (e.tag >= 0x9c9b && e.tag <= 0x9c9f && !gps) return e.bytes.toString('utf16le').replace(/\0+$/, '');
  if (e.tag === 0x927c) return `${e.bytes.length} bytes`;
  if (e.tag === 0x9286 && !gps) return e.bytes.subarray(8).toString('utf8').replace(/\0+$/, '').trim();
  if (e.type === T.UNDEFINED && [0x9000, 0xa000].includes(e.tag)) return e.bytes.toString('latin1');
  const v = values(e, le);
  if (!gps && ENUMS[e.tag] && typeof v[0] === 'number') return ENUMS[e.tag][v[0]] ?? String(v[0]);
  if (gps && e.tag === 5 && typeof v[0] === 'number') return ENUMS[5][v[0]] ?? String(v[0]);
  if (!gps)
    switch (e.tag) {
      case 0x829a: {
        const t = ratio(v[0]);
        return t > 0 && t < 1 ? `1/${Math.round(1 / t)} s` : `${fmtNum(t)} s`;
      }
      case 0x829d:
        return `f/${fmtNum(ratio(v[0]), 1)}`;
      case 0x920a:
        return `${fmtNum(ratio(v[0]), 1)} mm`;
      case 0xa405:
        return `${v[0]} mm`;
      case 0x9209:
        return typeof v[0] === 'number' ? (v[0] & 1 ? 'Fired' : 'Did not fire') : '';
      case 0x9204:
        return `${fmtNum(ratio(v[0]))} EV`;
    }
  if (gps && (e.tag === 2 || e.tag === 4)) return dms(v);
  if (gps && e.tag === 6) return `${fmtNum(ratio(v[0]), 1)} m`;
  if (gps && e.tag === 7) return v.map((x) => String(Math.floor(ratio(x))).padStart(2, '0')).join(':');
  if (e.type === T.UNDEFINED && e.bytes.length > 32) return `${e.bytes.length} bytes`;
  return v.map((x) => (Array.isArray(x) ? fmtNum(ratio(x), 4) : String(x))).join(e.type === T.UNDEFINED || e.type === T.BYTE ? '.' : ', ');
}

function dms(v: (number | [number, number])[]) {
  const [d, m, s] = v.map(ratio);
  return `${Math.floor(d)}° ${Math.floor(m ?? 0)}' ${fmtNum(s ?? 0, 2)}"`;
}

function gpsDecimal(t: Tiff): { lat: number; lon: number } | null {
  const g = t.gps?.entries;
  if (!g) return null;
  const get = (tag: number) => g.find((e) => e.tag === tag);
  const lat = get(2);
  const lon = get(4);
  if (!lat || !lon) return null;
  const dec = (e: Entry) => {
    const [d, m, s] = values(e, t.le).map(ratio);
    return d + (m ?? 0) / 60 + (s ?? 0) / 3600;
  };
  const latRef = get(1) ? asciiOf(get(1)!) : 'N';
  const lonRef = get(3) ? asciiOf(get(3)!) : 'E';
  return { lat: dec(lat) * (latRef === 'S' ? -1 : 1), lon: dec(lon) * (lonRef === 'W' ? -1 : 1) };
}

// -------------------------------------------------------------- EXIF writing

function enc16(n: number, le: boolean) {
  const b = Buffer.alloc(2);
  le ? b.writeUInt16LE(n) : b.writeUInt16BE(n);
  return b;
}
function enc32(n: number, le: boolean) {
  const b = Buffer.alloc(4);
  le ? b.writeUInt32LE(n >>> 0) : b.writeUInt32BE(n >>> 0);
  return b;
}
const asciiEntry = (tag: number, s: string): Entry => {
  const bytes = Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
  return { tag, type: T.ASCII, count: bytes.length, bytes };
};
function rationalEntry(tag: number, nums: [number, number][], le: boolean): Entry {
  return { tag, type: T.RATIONAL, count: nums.length, bytes: Buffer.concat(nums.flatMap(([a, b]) => [enc32(a, le), enc32(b, le)])) };
}
function degToRational(deg: number): [number, number][] {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFull = (a - d) * 60;
  const m = Math.floor(mFull);
  const s = (mFull - m) * 60;
  return [
    [d, 1],
    [m, 1],
    [Math.round(s * 10000), 10000],
  ];
}

/**
 * Appends new copies of the changed IFDs to the end of the original TIFF block. Everything else
 * (maker notes, thumbnails, offsets into them) stays byte-for-byte where it was, so nothing the
 * camera wrote is damaged. The superseded IFDs remain as unreferenced bytes.
 */
function rewriteTiff(t: Tiff | undefined, changes: { ifd0?: Map<number, Entry | null>; exif?: Map<number, Entry | null>; gps?: Map<number, Entry | null> | null }): Buffer {
  const le = t?.le ?? false;
  let out = t ? Buffer.from(t.buf) : Buffer.concat([Buffer.from('MM'), enc16(42, false), enc32(8, false)]);
  const pad = () => {
    if (out.length % 2) out = Buffer.concat([out, Buffer.from([0])]);
  };
  const apply = (base: Entry[] | undefined, ch?: Map<number, Entry | null> | null) => {
    const m = new Map((base ?? []).map((e) => [e.tag, e] as const));
    if (ch) for (const [tag, e] of ch) e ? m.set(tag, e) : m.delete(tag);
    return [...m.values()].sort((a, b) => a.tag - b.tag);
  };
  /** Writes an IFD at the end; returns its offset. */
  const write = (entries: Entry[], next: number) => {
    pad();
    const start = out.length;
    const tableLen = 2 + entries.length * 12 + 4;
    let dataAt = start + tableLen;
    const table: Buffer[] = [enc16(entries.length, le)];
    const data: Buffer[] = [];
    for (const e of entries) {
      table.push(enc16(e.tag, le), enc16(e.type, le), enc32(e.count, le));
      if (e.bytes.length <= 4) table.push(Buffer.concat([e.bytes, Buffer.alloc(4 - e.bytes.length)]));
      else {
        table.push(enc32(dataAt, le));
        const b = e.bytes.length % 2 ? Buffer.concat([e.bytes, Buffer.from([0])]) : e.bytes;
        data.push(b);
        dataAt += b.length;
      }
    }
    table.push(enc32(next, le));
    out = Buffer.concat([out, ...table, ...data]);
    return start;
  };
  const pointer = (tag: number, off: number): Entry => ({ tag, type: T.LONG, count: 1, bytes: enc32(off, le) });

  const ifd0Changes = new Map(changes.ifd0 ?? []);
  if (changes.exif && changes.exif.size) {
    const off = write(apply(t?.exif?.entries, changes.exif), 0);
    ifd0Changes.set(IFD_NAMES.EXIF, pointer(IFD_NAMES.EXIF, off));
  }
  if (changes.gps === null) ifd0Changes.set(IFD_NAMES.GPS, null);
  else if (changes.gps && changes.gps.size) {
    const off = write(apply(t?.gps?.entries, changes.gps), 0);
    ifd0Changes.set(IFD_NAMES.GPS, pointer(IFD_NAMES.GPS, off));
  }
  const ifd0Off = write(apply(t?.ifd0.entries, ifd0Changes), t?.ifd0.next ?? 0);
  const head = Buffer.from(out.subarray(0, 8));
  enc32(ifd0Off, le).copy(head, 4);
  head.copy(out, 0);
  return out;
}

// ----------------------------------------------------------- container plumbing

interface JpegSeg {
  marker: number;
  data: Buffer; // payload without marker/length
}
function jpegSegments(buf: Buffer): { segs: JpegSeg[]; rest: Buffer } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const segs: JpegSeg[] = [];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda) return { segs, rest: buf.subarray(i) }; // start of scan: the rest is image data
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    segs.push({ marker, data: buf.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  return null;
}
function jpegJoin(segs: JpegSeg[], rest: Buffer) {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const s of segs) {
    const h = Buffer.alloc(4);
    h[0] = 0xff;
    h[1] = s.marker;
    h.writeUInt16BE(s.data.length + 2, 2);
    parts.push(h, s.data);
  }
  parts.push(rest);
  return Buffer.concat(parts);
}
const isExifSeg = (s: JpegSeg) => s.marker === 0xe1 && s.data.subarray(0, 6).toString('latin1') === 'Exif\0\0';
const isXmpSeg = (s: JpegSeg) => s.marker === 0xe1 && s.data.subarray(0, 29).toString('latin1') === 'http://ns.adobe.com/xap/1.0/\0';

interface PngChunk {
  type: string;
  data: Buffer;
}
function pngChunks(buf: Buffer): PngChunk[] | null {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  const out: PngChunk[] = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    out.push({ type, data: buf.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}
function pngJoin(chunks: PngChunk[]) {
  const parts: Buffer[] = [Buffer.from('89504e470d0a1a0a', 'hex')];
  for (const c of chunks) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(c.data.length);
    const td = Buffer.concat([Buffer.from(c.type, 'latin1'), c.data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    parts.push(len, td, crc);
  }
  return Buffer.concat(parts);
}
const PNG_META = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** The EXIF/TIFF block of a JPEG, PNG, WebP, TIFF… (via sharp for the formats we don't parse). */
async function exifBlock(path: string, buf: Buffer): Promise<Buffer | undefined> {
  const j = jpegSegments(buf);
  if (j) {
    const s = j.segs.find(isExifSeg);
    return s ? Buffer.from(s.data.subarray(6)) : undefined;
  }
  const p = pngChunks(buf);
  if (p) {
    const c = p.find((x) => x.type === 'eXIf');
    return c ? Buffer.from(c.data) : undefined;
  }
  try {
    const m = await sharpLib()(path, { failOn: 'none' }).metadata();
    if (!m.exif) return undefined;
    // sharp hands back "Exif\0\0" + TIFF
    return m.exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? m.exif.subarray(6) : m.exif;
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------- metadata: read

interface Row {
  label: string;
  value: string;
}
interface Group {
  name: string;
  rows: Row[];
}
export interface MetaInfo {
  path: string;
  kind: 'image' | 'av' | 'pdf' | 'other';
  groups: Group[];
  /** current values of the editable fields */
  fields: Record<string, string>;
  /** editable field ids for this file, in display order */
  editable: string[];
  note?: string;
}

const pushRow = (g: Group, label: string, value: unknown) => {
  const v = value === undefined || value === null ? '' : String(value).trim();
  if (v) g.rows.push({ label, value: v.length > 2000 ? v.slice(0, 2000) + '…' : v });
};

function exifDateToInput(s: string) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}` : '';
}
function inputToExifDate(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  return m ? `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}` : '';
}

const IMAGE_FIELDS = ['make', 'model', 'dateTaken', 'author', 'copyright', 'description', 'gps'];
const AV_FIELDS = ['title', 'artist', 'album', 'album_artist', 'date', 'genre', 'track', 'comment'];
const PDF_FIELDS = ['title', 'author', 'subject', 'keywords', 'creator', 'producer'];
const EDITABLE_IMAGE = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'tif', 'tiff', 'avif']);

function fileGroup(path: string): Group {
  const st = statSync(path);
  const g: Group = { name: 'File', rows: [] };
  pushRow(g, 'Name', basename(path));
  pushRow(g, 'Folder', dirname(path));
  pushRow(g, 'Size', `${(st.size / 1024 / 1024).toFixed(2)} MB (${st.size.toLocaleString('en-US')} bytes)`);
  pushRow(g, 'Created', st.birthtime.toLocaleString());
  pushRow(g, 'Modified', st.mtime.toLocaleString());
  return g;
}

async function readImageMeta(path: string): Promise<MetaInfo> {
  const buf = await readFile(path);
  const info: MetaInfo = { path, kind: 'image', groups: [fileGroup(path)], fields: {}, editable: [] };
  const img: Group = { name: 'Image', rows: [] };
  try {
    const m = await sharpLib()(path, { failOn: 'none' }).metadata();
    pushRow(img, 'Format', m.format?.toUpperCase());
    pushRow(img, 'Dimensions', m.width && m.height ? `${m.width} × ${m.height}` : '');
    pushRow(img, 'Color space', m.space);
    pushRow(img, 'Channels', m.channels);
    pushRow(img, 'Bit depth', m.depth);
    pushRow(img, 'Density', m.density ? `${m.density} dpi` : '');
    pushRow(img, 'Has alpha', m.hasAlpha ? 'Yes' : 'No');
    pushRow(img, 'Frames', m.pages && m.pages > 1 ? m.pages : '');
    pushRow(img, 'Color profile', m.icc ? iccName(m.icc) || 'Embedded' : 'None');
    if (m.xmp) {
      const xg: Group = { name: 'XMP', rows: [] };
      for (const [k, v] of xmpPairs(m.xmp.toString('utf8'))) pushRow(xg, k, v);
      if (xg.rows.length) info.groups.push(xg);
    }
    if (m.iptc) pushRow(img, 'IPTC', `${m.iptc.length} bytes`);
  } catch (e: any) {
    pushRow(img, 'Error', e?.message ?? e);
  }
  info.groups.splice(1, 0, img);

  const block = await exifBlock(path, buf);
  const t = block ? parseTiff(block) : undefined;
  if (t) {
    const main: Group = { name: 'Camera & capture', rows: [] };
    const gps: Group = { name: 'Location', rows: [] };
    const seen = new Set<number>();
    const list = (ifd: Ifd | undefined, isGps: boolean, g: Group) => {
      for (const e of ifd?.entries ?? []) {
        if (!isGps && [IFD_NAMES.EXIF, IFD_NAMES.GPS, IFD_NAMES.INTEROP].includes(e.tag)) continue;
        if (!isGps && seen.has(e.tag)) continue;
        if (!isGps) seen.add(e.tag);
        const name = isGps ? (GPS_TAGS.has(e.tag) ? TAGS[e.tag] : undefined) : !GPS_TAGS.has(e.tag) || e.tag > 0x1f ? TAGS[e.tag] : undefined;
        pushRow(g, name ?? `Tag 0x${e.tag.toString(16).padStart(4, '0')}`, describe(e, t.le, isGps));
      }
    };
    list(t.ifd0, false, main);
    list(t.exif, false, main);
    list(t.gps, true, gps);
    const dec = gpsDecimal(t);
    if (dec) {
      gps.rows.unshift({ label: 'Coordinates', value: `${dec.lat.toFixed(6)}, ${dec.lon.toFixed(6)}` });
      info.fields.gps = `${dec.lat.toFixed(6)}, ${dec.lon.toFixed(6)}`;
    }
    if (t.ifd1) pushRow(main, 'Embedded thumbnail', 'Yes');
    if (main.rows.length) info.groups.splice(2, 0, main);
    if (gps.rows.length) info.groups.splice(3, 0, gps);
    const s = (ifd: Ifd | undefined, tag: number) => {
      const e = ifd?.entries.find((x) => x.tag === tag);
      return e ? describe(e, t.le, false) : '';
    };
    info.fields.make = s(t.ifd0, 0x010f);
    info.fields.model = s(t.ifd0, 0x0110);
    info.fields.dateTaken = exifDateToInput(s(t.exif, 0x9003) || s(t.ifd0, 0x0132));
    info.fields.author = s(t.ifd0, 0x013b) || s(t.ifd0, 0x9c9d);
    info.fields.copyright = s(t.ifd0, 0x8298);
    info.fields.description = s(t.ifd0, 0x010e);
  }
  if (EDITABLE_IMAGE.has(extOf(path))) info.editable = IMAGE_FIELDS;
  else info.note = `Orange can show and remove metadata in ${extOf(path).toUpperCase()} files, but not edit it.`;
  return info;
}

function iccName(icc: Buffer) {
  // 'desc' tag text
  try {
    const n = icc.readUInt32BE(128);
    for (let i = 0; i < n && i < 100; i++) {
      const o = 132 + i * 12;
      if (icc.toString('latin1', o, o + 4) !== 'desc') continue;
      const off = icc.readUInt32BE(o + 4);
      const type = icc.toString('latin1', off, off + 4);
      if (type === 'desc') return icc.toString('latin1', off + 12, off + 12 + icc.readUInt32BE(off + 8) - 1);
      if (type === 'mluc') {
        const len = icc.readUInt32BE(off + 20);
        const at = icc.readUInt32BE(off + 24);
        return icc.subarray(off + at, off + at + len).swap16().toString('utf16le');
      }
    }
  } catch {
    /* odd profile */
  }
  return '';
}

function xmpPairs(xml: string): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  // attributes like xmp:CreatorTool="…" and simple elements <dc:title>…</dc:title>
  for (const m of xml.matchAll(/\s([a-zA-Z]+):([A-Za-z]+)="([^"]{1,300})"/g)) {
    if (['xmlns', 'rdf', 'x', 'stEvt', 'stRef'].includes(m[1])) continue;
    const k = `${m[1]}:${m[2]}`;
    if (!seen.has(k)) seen.add(k), out.push([k, m[3]]);
  }
  for (const m of xml.matchAll(/<([a-zA-Z]+):([A-Za-z]+)>\s*(?:<rdf:(?:Alt|Seq|Bag)>\s*)?(?:<rdf:li[^>]*>)?([^<]{1,300})</g)) {
    if (['rdf', 'x'].includes(m[1])) continue;
    const k = `${m[1]}:${m[2]}`;
    if (!seen.has(k) && m[3].trim()) seen.add(k), out.push([k, m[3].trim()]);
  }
  return out.slice(0, 80);
}

async function readAvMeta(path: string): Promise<MetaInfo> {
  const info: MetaInfo = { path, kind: 'av', groups: [fileGroup(path)], fields: {}, editable: AV_FIELDS };
  const p = await ffprobe(path);
  const tags = lower(p.format?.tags);
  const fmt: Group = { name: 'Container', rows: [] };
  pushRow(fmt, 'Format', p.format?.format_long_name ?? p.format?.format_name);
  const dur = Number(p.format?.duration);
  pushRow(fmt, 'Duration', dur ? fmtDur(dur) : '');
  pushRow(fmt, 'Bitrate', p.format?.bit_rate ? `${Math.round(Number(p.format.bit_rate) / 1000)} kbps` : '');
  info.groups.push(fmt);
  const tg: Group = { name: 'Tags', rows: [] };
  for (const [k, v] of Object.entries(p.format?.tags ?? {})) pushRow(tg, k, v);
  if (tg.rows.length) info.groups.push(tg);
  (p.streams ?? []).forEach((s, i) => {
    const g: Group = { name: `Stream ${i} · ${s.codec_type ?? 'data'}${s.disposition?.attached_pic ? ' (cover art)' : ''}`, rows: [] };
    pushRow(g, 'Codec', s.codec_long_name ?? s.codec_name);
    pushRow(g, 'Profile', s.profile);
    if (s.width) pushRow(g, 'Dimensions', `${s.width} × ${s.height}`);
    if (s.avg_frame_rate && s.avg_frame_rate !== '0/0' && s.codec_type === 'video') {
      const [a, b] = s.avg_frame_rate.split('/').map(Number);
      pushRow(g, 'Frame rate', b ? `${fmtNum(a / b)} fps` : '');
    }
    pushRow(g, 'Pixel format', s.pix_fmt);
    pushRow(g, 'Sample rate', s.sample_rate ? `${s.sample_rate} Hz` : '');
    pushRow(g, 'Channels', s.channel_layout ?? s.channels);
    pushRow(g, 'Bitrate', s.bit_rate ? `${Math.round(Number(s.bit_rate) / 1000)} kbps` : '');
    pushRow(g, 'Language', s.tags?.language);
    for (const [k, v] of Object.entries(s.tags ?? {})) if (k !== 'language') pushRow(g, k, v);
    info.groups.push(g);
  });
  if (p.chapters?.length) {
    const g: Group = { name: `Chapters (${p.chapters.length})`, rows: [] };
    for (const c of p.chapters) pushRow(g, fmtDur(Number(c.start_time)), c.tags?.title ?? `Chapter ${c.id}`);
    info.groups.push(g);
  }
  for (const f of AV_FIELDS) info.fields[f] = tags[f] ?? (f === 'date' ? tags.year ?? '' : f === 'album_artist' ? tags['album artist'] ?? '' : '');
  return info;
}

function lower(o?: Record<string, string>) {
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) r[k.toLowerCase()] = v;
  return r;
}
function fmtDur(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
}

async function readPdfMeta(path: string): Promise<MetaInfo> {
  const { PDFDocument } = await import('pdf-lib');
  const bytes = await readFile(path);
  const info: MetaInfo = { path, kind: 'pdf', groups: [fileGroup(path)], fields: {}, editable: PDF_FIELDS };
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const g: Group = { name: 'Document', rows: [] };
  pushRow(g, 'PDF version', /%PDF-(\d\.\d)/.exec(bytes.subarray(0, 32).toString('latin1'))?.[1]);
  pushRow(g, 'Pages', doc.getPageCount());
  const first = doc.getPageCount() ? doc.getPage(0).getSize() : null;
  if (first) pushRow(g, 'Page size', `${Math.round((first.width / 72) * 25.4)} × ${Math.round((first.height / 72) * 25.4)} mm`);
  pushRow(g, 'Protected', doc.isEncrypted ? 'Yes' : 'No');
  const d: Group = { name: 'Properties', rows: [] };
  const safe = <T>(fn: () => T) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const vals: Record<string, string | undefined> = {
    title: safe(() => doc.getTitle()),
    author: safe(() => doc.getAuthor()),
    subject: safe(() => doc.getSubject()),
    keywords: safe(() => doc.getKeywords()),
    creator: safe(() => doc.getCreator()),
    producer: safe(() => doc.getProducer()),
  };
  const labels: Record<string, string> = { title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords', creator: 'Created with', producer: 'PDF producer' };
  for (const k of PDF_FIELDS) {
    pushRow(d, labels[k], vals[k]);
    info.fields[k] = vals[k] ?? '';
  }
  pushRow(d, 'Created', safe(() => doc.getCreationDate()?.toLocaleString()));
  pushRow(d, 'Modified', safe(() => doc.getModificationDate()?.toLocaleString()));
  info.groups.push(d, g);
  const xmp = doc.catalog.get((await import('pdf-lib')).PDFName.of('Metadata'));
  if (xmp) pushRow(g, 'XMP metadata', 'Yes');
  if (doc.isEncrypted) {
    info.editable = [];
    info.note = 'This PDF is protected, so its properties can only be viewed.';
  }
  return info;
}

async function readMeta(path: string): Promise<MetaInfo> {
  const k = kindOfExt(extOf(path));
  try {
    if (k === 'image') return await readImageMeta(path);
    if (k === 'video' || k === 'audio') return await readAvMeta(path);
    if (k === 'pdf') return await readPdfMeta(path);
  } catch (e: any) {
    return { path, kind: 'other', groups: [fileGroup(path)], fields: {}, editable: [], note: `Couldn't read this file's metadata (${String(e?.message ?? e).slice(0, 120)}).` };
  }
  return { path, kind: 'other', groups: [fileGroup(path)], fields: {}, editable: [] };
}

ipcMain.handle('meta:read', (_e, path: string) => readMeta(path));

// ----------------------------------------------------------- metadata: write

/** Output for a metadata change: a new file, or the original when the user chose that. */
async function finalOut(input: string, ctx: Ctx, suffix: string, write: (out: string) => Promise<void>): Promise<string> {
  if (settings.get().replaceOriginal) {
    const tmp = join(ctx.tmp(), basename(input));
    await write(tmp);
    try {
      await rename(tmp, input);
    } catch {
      await writeFile(input, await readFile(tmp));
    }
    return input;
  }
  const out = ctx.out(input, extOf(input), suffix);
  await write(out);
  return out;
}

async function stripImage(input: string, out: string) {
  const buf = await readFile(input);
  const j = jpegSegments(buf);
  if (j) {
    // Drop APPn (except JFIF/ICC/Adobe colour info) and comments, keep the image data untouched.
    const keep = j.segs.filter((s) => {
      if (s.marker === 0xfe) return false;
      if (s.marker === 0xe0) return true; // JFIF
      if (s.marker === 0xe2) return s.data.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0';
      if (s.marker === 0xee) return true; // Adobe (colour transform)
      if (s.marker >= 0xe1 && s.marker <= 0xef) return false;
      return true;
    });
    // Orientation lives in EXIF: bake it into the pixels first if the photo is rotated.
    const orient = (await sharpLib()(buf).metadata()).orientation ?? 1;
    if (orient !== 1) {
      await writeFile(out, await sharpLib()(buf).autoOrient().keepIccProfile().jpeg({ quality: 95, mozjpeg: true }).toBuffer());
      return;
    }
    await writeFile(out, jpegJoin(keep, j.rest));
    return;
  }
  const p = pngChunks(buf);
  if (p) {
    await writeFile(out, pngJoin(p.filter((c) => !PNG_META.has(c.type))));
    return;
  }
  // Other formats: re-encode without metadata (lossless where the format allows).
  const fmt = extOf(input);
  let img = sharpLib()(buf, { failOn: 'none', animated: true }).autoOrient().keepIccProfile();
  if (fmt === 'webp') img = img.webp({ quality: 95, effort: 5 });
  else if (fmt === 'avif') img = img.avif({ quality: 80 });
  else if (fmt === 'tif' || fmt === 'tiff') img = img.tiff({ compression: 'lzw' });
  else if (fmt === 'gif') img = img.gif();
  else throw new UserError(`Can't rewrite ${fmt.toUpperCase()} files.`);
  await writeFile(out, await img.toBuffer());
}

function imageChanges(fields: Record<string, string>, t: Tiff | undefined) {
  const le = t?.le ?? false;
  const ifd0 = new Map<number, Entry | null>();
  const exif = new Map<number, Entry | null>();
  let gps: Map<number, Entry | null> | null | undefined;
  const str = (m: Map<number, Entry | null>, tag: number, v: string | undefined) => {
    if (v === undefined) return;
    m.set(tag, v.trim() ? asciiEntry(tag, v.trim()) : null);
  };
  str(ifd0, 0x010f, fields.make);
  str(ifd0, 0x0110, fields.model);
  str(ifd0, 0x013b, fields.author);
  if (fields.author !== undefined) ifd0.set(0x9c9d, fields.author.trim() ? { tag: 0x9c9d, type: T.BYTE, count: 0, bytes: Buffer.from(fields.author.trim() + '\0', 'utf16le') } : null);
  const xp = ifd0.get(0x9c9d);
  if (xp) xp.count = xp.bytes.length;
  str(ifd0, 0x8298, fields.copyright);
  str(ifd0, 0x010e, fields.description);
  if (fields.dateTaken !== undefined) {
    const d = inputToExifDate(fields.dateTaken);
    exif.set(0x9003, d ? asciiEntry(0x9003, d) : null);
    exif.set(0x9004, d ? asciiEntry(0x9004, d) : null);
  }
  if (fields.gps !== undefined) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(fields.gps);
    if (!fields.gps.trim()) gps = null;
    else if (!m) throw new UserError('Location should look like "48.858370, 2.294481" (latitude, longitude).');
    else {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new UserError('That location is out of range.');
      gps = new Map<number, Entry | null>([
        [0, { tag: 0, type: T.BYTE, count: 4, bytes: Buffer.from([2, 3, 0, 0]) }],
        [1, asciiEntry(1, lat < 0 ? 'S' : 'N')],
        [2, rationalEntry(2, degToRational(lat), le)],
        [3, asciiEntry(3, lon < 0 ? 'W' : 'E')],
        [4, rationalEntry(4, degToRational(lon), le)],
      ]);
    }
  }
  return { ifd0, exif, gps };
}

async function editImage(input: string, out: string, fields: Record<string, string>) {
  const buf = await readFile(input);
  const j = jpegSegments(buf);
  const p = j ? null : pngChunks(buf);
  if (j || p) {
    const block = await exifBlock(input, buf);
    const t = block ? parseTiff(block) : undefined;
    const tiff = rewriteTiff(t, imageChanges(fields, t));
    if (j) {
      if (tiff.length + 8 > 65533) throw new UserError('The EXIF data in this photo is too large to edit.');
      const seg: JpegSeg = { marker: 0xe1, data: Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]) };
      const segs = j.segs.filter((s) => !isExifSeg(s));
      // EXIF goes right after JFIF (if any) so every reader finds it.
      const at = segs.length && segs[0].marker === 0xe0 ? 1 : 0;
      segs.splice(at, 0, seg);
      await writeFile(out, jpegJoin(segs, j.rest));
    } else {
      const chunks = p!.filter((c) => c.type !== 'eXIf');
      const at = chunks.findIndex((c) => c.type === 'IDAT');
      chunks.splice(at < 0 ? 1 : at, 0, { type: 'eXIf', data: tiff });
      await writeFile(out, pngJoin(chunks));
    }
    return;
  }
  // WebP / TIFF / AVIF: let libvips write the EXIF (string values).
  const exif: Record<string, Record<string, string>> = { IFD0: {}, IFD2: {} };
  if (fields.make !== undefined) exif.IFD0.Make = fields.make;
  if (fields.model !== undefined) exif.IFD0.Model = fields.model;
  if (fields.author !== undefined) exif.IFD0.Artist = fields.author;
  if (fields.copyright !== undefined) exif.IFD0.Copyright = fields.copyright;
  if (fields.description !== undefined) exif.IFD0.ImageDescription = fields.description;
  if (fields.dateTaken !== undefined) exif.IFD2.DateTimeOriginal = inputToExifDate(fields.dateTaken);
  const fmt = extOf(input);
  let img = sharpLib()(buf, { failOn: 'none', animated: true }).keepMetadata().withExifMerge(exif);
  if (fmt === 'webp') img = img.webp({ quality: 95, effort: 5 });
  else if (fmt === 'avif') img = img.avif({ quality: 80 });
  else img = img.tiff({ compression: 'lzw' });
  await writeFile(out, await img.toBuffer());
}

const AV_KEYS: Record<string, string> = { album_artist: 'album_artist', track: 'track', date: 'date' };

async function avRewrite(input: string, out: string, ctx: Ctx, meta: string[]) {
  const base = ['-i', input, '-map', '0', '-c', 'copy', ...meta];
  const ext = extOf(input);
  if (ext === 'mp3') base.push('-id3v2_version', '3', '-write_id3v1', '1');
  if (['mp4', 'm4a', 'mov', 'm4v'].includes(ext)) base.push('-movflags', '+faststart');
  try {
    await ffmpeg(base, out, ctx, 0, () => {});
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    // Some containers carry data streams ffmpeg can't copy; keep audio/video/subtitles only.
    const i = base.indexOf('0');
    base.splice(i - 1, 2, '-map', '0:v?', '-map', '0:a?', '-map', '0:s?');
    await ffmpeg(base, out, ctx, 0, () => {});
  }
}

async function editPdf(input: string, out: string, fields: Record<string, string> | null) {
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const doc = await PDFDocument.load(await readFile(input), { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new UserError(`${basename(input)} is password-protected; its properties can't be changed.`);
  if (!fields) {
    const info = (doc as any).getInfoDict() as import('pdf-lib').PDFDict;
    for (const k of info.keys()) info.delete(k);
    doc.catalog.delete(PDFName.of('Metadata'));
  } else {
    const set = (k: string, fn: (v: string) => void) => fields[k] !== undefined && fn(fields[k].trim());
    set('title', (v) => doc.setTitle(v));
    set('author', (v) => doc.setAuthor(v));
    set('subject', (v) => doc.setSubject(v));
    set('keywords', (v) => doc.setKeywords(v ? [v] : [])); // kept verbatim
    set('creator', (v) => doc.setCreator(v));
    set('producer', (v) => doc.setProducer(v));
    doc.setModificationDate(new Date());
    // A stale XMP packet would contradict the new values in some readers.
    doc.catalog.delete(PDFName.of('Metadata'));
  }
  await writeFile(out, await doc.save({ useObjectStreams: true }));
}

export interface MetadataOptions {
  action: 'strip' | 'edit';
  /** per file: changed field values only */
  edits?: Record<string, Record<string, string>>;
}

const metadata: ToolFn = async (inputs, ctx) => {
  const o = (ctx.options ?? { action: 'strip' }) as MetadataOptions;
  const targets = o.action === 'edit' ? inputs.filter((p) => o.edits?.[p] && Object.keys(o.edits[p]).length) : inputs;
  if (!targets.length) throw new UserError('Nothing was changed.');
  const outputs: string[] = [];
  const failures: string[] = [];
  let n = 0;
  await pool(targets, Math.max(1, Math.min(4, CPU)), async (input) => {
    aborted(ctx);
    const k = kindOfExt(extOf(input));
    const fields = o.action === 'edit' ? o.edits![input] : null;
    try {
      const out = await finalOut(input, ctx, fields ? ' edited' : ' clean', async (dest) => {
        if (k === 'image') return fields ? editImage(input, dest, fields) : stripImage(input, dest);
        if (k === 'pdf') return editPdf(input, dest, fields);
        if (k === 'video' || k === 'audio') {
          if (!fields) return avRewrite(input, dest, ctx, ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact']);
          const meta: string[] = ['-map_metadata', '0'];
          for (const [key, v] of Object.entries(fields)) if (AV_FIELDS.includes(key)) meta.push('-metadata', `${AV_KEYS[key] ?? key}=${v}`);
          return avRewrite(input, dest, ctx, meta);
        }
        throw new UserError(`${basename(input)} has no metadata Orange can change.`);
      });
      outputs.push(out);
    } catch (e: any) {
      if (ctx.signal.aborted) throw e;
      log('metadata failed', input, e);
      failures.push(`${basename(input)}: ${e instanceof UserError ? e.message : String(e?.message ?? e).slice(0, 160)}`);
    }
    ctx.progress(++n / targets.length);
  });
  if (!outputs.length) throw new UserError(failures.join('\n') || 'Nothing was changed.');
  return outputs;
};

// ------------------------------------------------------------------- extract

const extractArchive: ToolFn = async (inputs, ctx) => {
  const outputs: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    aborted(ctx);
    const base = i / inputs.length;
    const sub: Ctx = { ...ctx, progress: (f, note) => ctx.progress(base + Math.min(1, f) / inputs.length, note) };
    outputs.push(...(await archiveConverter.convert(inputs[i], 'extract', sub)));
  }
  return outputs;
};

export const tools: Record<string, ToolFn> = { compress, metadata, extractArchive };

// Exposed for tests.
export const _internal = { parseTiff, rewriteTiff, imageChanges, compressImageBytes, probe, readMeta };
