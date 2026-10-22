// Checks that outputs are real files of the right kind, not just non-empty.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { REPO } from './setup';

export const BIN = join(REPO, 'vendor', 'bin');
export const exe = (name: string) => join(BIN, `${name}.exe`);
export const MAGICK = join(BIN, 'imagemagick', 'magick.exe');

export class CheckError extends Error {}
export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new CheckError(msg);
}

export const extLower = (p: string) => extname(p).slice(1).toLowerCase();

export function nonEmpty(p: string) {
  check(existsSync(p), `missing output ${p}`);
  const st = statSync(p);
  if (st.isDirectory()) check(readdirSync(p).length > 0, `empty folder ${p}`);
  else check(st.size > 0, `empty file ${p}`);
}

/** All files under the outputs (a folder output contributes its files). */
export function filesOf(outputs: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f));
    else out.push(p);
  };
  outputs.forEach((p) => {
    nonEmpty(p);
    walk(p);
  });
  return out;
}

// ------------------------------------------------------------------ media

export interface Probe {
  duration: number;
  format: string;
  tags: Record<string, string>;
  v?: { codec: string; width: number; height: number };
  a?: { codec: string; channels: number; sampleRate: number };
  subs: string[];
}

export function ffprobe(p: string): Probe {
  const r = spawnSync(exe('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20 });
  check(r.status === 0, `ffprobe failed on ${p}: ${(r.stderr || '').trim().slice(0, 200)}`);
  const j = JSON.parse(r.stdout);
  const streams: any[] = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0,
    format: j.format?.format_name ?? '',
    tags: Object.fromEntries(Object.entries(j.format?.tags ?? {}).map(([k, val]) => [k.toLowerCase(), String(val)])),
    v: v && { codec: v.codec_name, width: v.width, height: v.height },
    a: a && { codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate) },
    subs: streams.filter((s) => s.codec_type === 'subtitle').map((s) => s.codec_name),
  };
}

export interface MediaExpect {
  v?: string | string[];
  a?: string | string[];
  noVideo?: boolean;
  duration?: number;
  /** Allowed duration error in seconds (default 0.35 s or 12 %, whichever is larger). */
  tol?: number;
  width?: number;
  height?: number;
  channels?: number;
}

export function media(p: string, e: MediaExpect): Probe {
  nonEmpty(p);
  const info = ffprobe(p);
  const one = (want: string | string[] | undefined, got: string | undefined, what: string) => {
    if (!want) return;
    const list = Array.isArray(want) ? want : [want];
    check(got && list.includes(got), `${what} codec ${got ?? 'none'}, expected ${list.join('/')}`);
  };
  one(e.v, info.v?.codec, 'video');
  one(e.a, info.a?.codec, 'audio');
  if (e.noVideo) check(!info.v, `unexpected video stream (${info.v?.codec})`);
  if (e.duration !== undefined) {
    const tol = e.tol ?? Math.max(0.35, e.duration * 0.12);
    check(Math.abs(info.duration - e.duration) <= tol, `duration ${info.duration.toFixed(2)} s, expected ~${e.duration} s`);
  }
  if (e.width) check(info.v?.width === e.width, `width ${info.v?.width}, expected ${e.width}`);
  if (e.height) check(info.v?.height === e.height, `height ${info.v?.height}, expected ${e.height}`);
  if (e.channels) check(info.a?.channels === e.channels, `${info.a?.channels} audio channels, expected ${e.channels}`);
  return info;
}

// ------------------------------------------------------------------ images

export interface ImageInfo {
  format: string;
  width: number;
  height: number;
  compression?: string;
  exif: boolean;
}

/** sharp metadata; BMP from its header and anything sharp can't parse via ImageMagick. */
export async function imageInfo(p: string): Promise<ImageInfo> {
  nonEmpty(p);
  if (extLower(p) === 'bmp') {
    const b = readFileSync(p);
    check(b.toString('latin1', 0, 2) === 'BM', 'not a BMP (no BM signature)');
    return { format: 'bmp', width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)), exif: false };
  }
  try {
    const m = await sharp(p, { failOn: 'none' }).metadata();
    return { format: m.format ?? '?', width: m.width ?? 0, height: m.height ?? 0, compression: (m as any).compression, exif: !!m.exif };
  } catch {
    const out = execFileSync(MAGICK, ['identify', '-format', '%m %w %h\n', p], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MAGICK_HOME: dirname(MAGICK) } });
    const [fmt, w, h] = out.trim().split(/\r?\n/)[0].split(' ');
    return { format: fmt.toLowerCase(), width: Number(w), height: Number(h), exif: false };
  }
}

/** Expected sharp format (and HEIF compression) per target extension. */
const IMAGE_FORMAT: Record<string, [string[], string?]> = {
  jpg: [['jpeg']],
  png: [['png']],
  webp: [['webp']],
  tiff: [['tiff']],
  avif: [['heif'], 'av1'],
  heic: [['heif', 'heic'], 'hevc'],
  bmp: [['bmp']],
  gif: [['gif']],
};

export async function image(p: string, ext: string, size?: { width: number; height: number }): Promise<ImageInfo> {
  const info = await imageInfo(p);
  const [formats, compression] = IMAGE_FORMAT[ext] ?? [[ext]];
  check(formats.includes(info.format), `image format ${info.format}, expected ${formats.join('/')}`);
  if (compression && info.compression) check(info.compression === compression, `HEIF compression ${info.compression}, expected ${compression}`);
  if (ext === 'heic') check(readFileSync(p).subarray(4, 12).toString('latin1').startsWith('ftyp'), 'HEIC without an ftyp box');
  if (size) check(info.width === size.width && info.height === size.height, `size ${info.width}x${info.height}, expected ${size.width}x${size.height}`);
  return info;
}

// ------------------------------------------------------------------ PDF

export interface PdfInfo {
  pages: number;
  encrypted: boolean;
  title?: string;
  rotation: number[];
}

export async function pdfInfo(p: string): Promise<PdfInfo> {
  nonEmpty(p);
  const bytes = readFileSync(p);
  check(bytes.subarray(0, 5).toString('latin1') === '%PDF-', 'not a PDF (no %PDF- header)');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const encrypted = doc.isEncrypted;
  let title: string | undefined;
  try {
    title = encrypted ? undefined : doc.getTitle();
  } catch {
    title = undefined;
  }
  return { pages: doc.getPageCount(), encrypted, title, rotation: doc.getPages().map((pg) => pg.getRotation().angle) };
}

export async function pdf(p: string, pages?: number): Promise<PdfInfo> {
  const info = await pdfInfo(p);
  check(!info.encrypted, 'PDF is unexpectedly encrypted');
  check(info.pages > 0, 'PDF has no pages');
  if (pages !== undefined) check(info.pages === pages, `${info.pages} pages, expected ${pages}`);
  return info;
}

// ------------------------------------------------------------------ zip-based documents and archives

export async function zipParts(p: string, parts: (string | RegExp)[], mimetype?: string): Promise<string[]> {
  nonEmpty(p);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(readFileSync(p));
  } catch (e: any) {
    throw new CheckError(`not a valid zip container: ${e?.message ?? e}`);
  }
  const names = Object.keys(zip.files);
  for (const part of parts) {
    const ok = typeof part === 'string' ? names.includes(part) : names.some((n) => part.test(n));
    check(ok, `zip is missing part ${part}`);
  }
  if (mimetype) {
    const m = await zip.file('mimetype')?.async('string');
    check(m?.trim() === mimetype, `mimetype "${m}", expected "${mimetype}"`);
  }
  return names;
}

export const DOC_PARTS: Record<string, [(string | RegExp)[], string?]> = {
  docx: [['[Content_Types].xml', 'word/document.xml']],
  xlsx: [['[Content_Types].xml', 'xl/workbook.xml', /^xl\/worksheets\/sheet\d+\.xml$/]],
  pptx: [['[Content_Types].xml', 'ppt/presentation.xml', /^ppt\/slides\/slide\d+\.xml$/]],
  epub: [['mimetype', 'META-INF/container.xml'], 'application/epub+zip'],
  odt: [['mimetype', 'content.xml'], 'application/vnd.oasis.opendocument.text'],
  ods: [['mimetype', 'content.xml'], 'application/vnd.oasis.opendocument.spreadsheet'],
};

export async function officeDoc(p: string, ext: string) {
  const [parts, mime] = DOC_PARTS[ext];
  return zipParts(p, parts, mime);
}

/** `7z t`: the archive opens and every CRC matches. Password via stdin is never prompted for. */
export function sevenZipTest(p: string, password?: string): { ok: boolean; out: string } {
  const r = spawnSync(exe('7z'), ['t', '-bso1', '-bse1', `-p${password ?? '__orange_no_password__'}`, p], { encoding: 'utf8', windowsHide: true, input: '' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function archive(p: string, password?: string) {
  nonEmpty(p);
  const r = sevenZipTest(p, password);
  check(r.ok, `7z t failed: ${r.out.split(/\r?\n/).filter((l) => /error|wrong|can.?not/i.test(l)).join(' ').slice(0, 200) || 'non-zero exit'}`);
}

// ------------------------------------------------------------------ text

export function text(p: string, ...needles: (string | RegExp)[]): string {
  nonEmpty(p);
  const s = readFileSync(p, 'utf8').replace(/^﻿/, '');
  for (const n of needles) {
    const ok = typeof n === 'string' ? s.toLowerCase().includes(n.toLowerCase()) : n.test(s);
    check(ok, `text does not contain ${n}`);
  }
  return s;
}
