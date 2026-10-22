// Every test case. Conversions are generated from the catalog so new targets are covered automatically;
// tools use the option shapes their renderer windows send.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { conversionTargets, extOf, kindOfExt, toolsFor, type Kind } from '../src/shared/catalog';
import type { ConverterModule, ToolFn } from '../src/main/ops/types';
import { makeCtx, outputDirOverride } from '../src/main/jobs';
import { converter as imageConv } from '../src/main/ops/convert-image';
import { converter as avConv } from '../src/main/ops/convert-av';
import { converter as docConv } from '../src/main/ops/convert-docs';
import { converter as archiveConv } from '../src/main/ops/convert-archive';
import { converter as subtitleConv } from '../src/main/ops/convert-subtitle';
import { tools as imageTools } from '../src/main/ops/tools-image';
import { tools as avTools } from '../src/main/ops/tools-av';
import { tools as pdfTools } from '../src/main/ops/tools-pdf';
import { tools as fileTools } from '../src/main/ops/tools-file';
import { tools as aiTools } from '../src/main/ops/tools-ai';
import { tools as utilTools, undoLastRename } from '../src/main/ops/tools-util';
import { tools as speechTools } from '../src/main/ops/tools-speech';
import type { OfficeStatus } from '../src/main/engines/office';
import { need } from './fixtures';
import * as v from './verify';
import { check, CheckError } from './verify';

const CONVERTERS: ConverterModule[] = [imageConv, avConv, docConv, archiveConv, subtitleConv];
const TOOLS: Record<string, ToolFn> = { ...imageTools, ...avTools, ...pdfTools, ...fileTools, ...aiTools, ...utilTools, ...speechTools };

export class Skip extends Error {}

export interface T {
  /** This case's own output folder (every ctx.out() lands here). */
  dir: string;
  signal: AbortSignal;
  /** One-shot conversion, routed like jobs.ts runChoice() (validated against the catalog first). */
  convert(input: string | string[], target: string): Promise<string[]>;
  /** A tool through its ToolFn, like jobs.ts runTool() (validated against the catalog first). */
  tool(id: string, inputs: string[], options?: any): Promise<string[]>;
  /** Copy a file into the case folder (for tools that change their inputs). */
  copy(src: string, name?: string): string;
}

export interface Case {
  group: 'convert' | 'instant' | 'tool' | 'ai';
  name: string;
  run(t: T): Promise<void>;
  timeoutMs?: number;
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

export function makeT(dir: string, signal: AbortSignal): T {
  const inCase = <R>(fn: () => Promise<R>) => outputDirOverride.run(dir, fn);
  return {
    dir,
    signal,
    async convert(input, target) {
      const paths = Array.isArray(input) ? input : [input];
      const exts = paths.filter((p) => !isDir(p)).map(extOf);
      const hasFolder = paths.some(isDir);
      const valid = hasFolder ? ['zip'] : conversionTargets(exts).map((x) => (x.id === 'extract' ? 'extract' : x.ext));
      check(valid.includes(target), `catalog does not offer ${target} for ${paths.map((p) => basename(p)).join(', ')} (offers ${valid.join(', ')})`);
      const { ctx, cleanup } = makeCtx(signal, () => {});
      try {
        if (hasFolder || new Set(exts.map(kindOfExt)).size > 1) return await inCase(() => archiveConv.convert(paths.join('\n'), target, ctx));
        const kind = kindOfExt(exts[0]);
        const conv = ['zip', 'tar', 'gz', '7z'].includes(target) && kind !== 'archive' ? archiveConv : CONVERTERS.find((c) => c.kinds.includes(kind));
        check(conv, `no converter for ${kind}`);
        return await inCase(() => conv.convert(paths[0], target, ctx));
      } finally {
        cleanup();
      }
    },
    async tool(id, inputs, options) {
      const fn = TOOLS[id];
      check(fn, `tool ${id} has no ToolFn`);
      const offered = toolsFor(inputs.filter((p) => !isDir(p)).map(extOf), inputs.some(isDir)).some((x) => x.id === id);
      check(offered, `catalog does not offer ${id} for ${inputs.map((p) => basename(p)).join(', ')}`);
      const { ctx, cleanup } = makeCtx(signal, () => {}, options);
      try {
        return await inCase(() => fn(inputs, ctx));
      } finally {
        cleanup();
      }
    },
    copy(src, name) {
      const dest = join(dir, name ?? basename(src));
      copyFileSync(src, dest);
      return dest;
    },
  };
}

/** Expect `p` to reject; returns the message. */
async function rejects(p: Promise<unknown>, re: RegExp, what: string): Promise<string> {
  try {
    await p;
  } catch (e: any) {
    const m = String(e?.message ?? e);
    check(re.test(m), `${what}: failed with "${m.slice(0, 160)}", expected ${re}`);
    return m;
  }
  throw new CheckError(`${what}: succeeded, expected an error`);
}

const one = (outs: string[]) => {
  check(outs.length === 1, `expected 1 output, got ${outs.length}`);
  v.nonEmpty(outs[0]);
  return outs[0];
};
const size = (p: string) => statSync(p).size;

// =================================================================== conversion verifiers

const VCODEC: Record<string, string[]> = { mp4: ['h264', 'hevc'], mov: ['h264', 'hevc'], mkv: ['h264', 'hevc'], webm: ['vp9', 'vp8', 'av1'], avi: ['mpeg4'], wmv: ['wmv2', 'wmv1', 'vc1'], gif: ['gif'] };
const VACODEC: Record<string, string[]> = { mp4: ['aac'], mov: ['aac'], mkv: ['aac'], webm: ['opus', 'vorbis'], avi: ['mp3'], wmv: ['wmav2'] };
const ACODEC: Record<string, string[]> = { mp3: ['mp3'], m4a: ['aac'], wav: ['pcm_s16le'], flac: ['flac'], ogg: ['vorbis'], opus: ['opus'], aiff: ['pcm_s16be'], wma: ['wmav2'] };
const IMAGE_EXTS = ['jpg', 'png', 'webp', 'tiff', 'avif', 'heic', 'bmp'];
const TEXT_MARK = /quick brown fox/i;

interface Src {
  key: string; // fixture name
  /** Image size, media duration (s) or PDF page count, for the checks. */
  w?: number;
  h?: number;
  dur?: number;
  pages?: number;
}

async function verifyConversion(kind: Kind, src: Src, target: string, outs: string[]) {
  if (['image'].includes(kind)) {
    const out = one(outs);
    if (target === 'pdf') return void (await v.pdf(out, 1));
    return void (await v.image(out, target, { width: src.w!, height: src.h! }));
  }
  if (kind === 'video') {
    const out = one(outs);
    if (target === 'mp3') return void v.media(out, { a: 'mp3', noVideo: true, duration: src.dur });
    if (target === 'gif') return void v.media(out, { v: 'gif', width: src.w, height: src.h });
    return void v.media(out, { v: VCODEC[target], a: VACODEC[target], duration: src.dur, width: src.w, height: src.h });
  }
  if (kind === 'audio') return void v.media(one(outs), { a: ACODEC[target], noVideo: true, duration: src.dur });
  if (kind === 'subtitle') {
    const out = one(outs);
    if (target === 'srt') v.text(out, /00:00:00,500 --> 00:00:02,000/, /Hello from/);
    else if (target === 'vtt') check(v.text(out, /00:00:00\.500 --> 00:00:02\.000/).startsWith('WEBVTT'), 'VTT without WEBVTT header');
    else {
      const s = v.text(out, 'Hello from Orange');
      check(!/-->|<i>/.test(s), 'TXT still has timings or tags');
    }
    return;
  }
  if (kind === 'archive' || kind === 'folder' || kind === 'other') {
    if (target === 'extract') {
      const files = v.filesOf(outs);
      const a = files.find((f) => basename(f) === 'a.txt');
      check(a && readFileSync(a, 'utf8').includes('Orange archive file A'), 'extracted files are missing a.txt');
      check(files.some((f) => basename(f) === 'b.txt'), 'extracted files are missing sub/b.txt');
      return;
    }
    const out = one(outs);
    check(extOf(out) === target, `output extension .${extOf(out)}, expected .${target}`);
    return void v.archive(out);
  }
  // pdf, document, ebook, slides, spreadsheet
  if (target === 'jpg' || target === 'png') {
    const files = v.filesOf(outs).filter((f) => extOf(f) === target);
    if (src.pages) check(files.length === src.pages, `${files.length} page images, expected ${src.pages}`);
    check(files.length > 0, 'no page images');
    for (const f of files) await v.image(f, target);
    return;
  }
  if (target === 'csv' || target === 'tsv') {
    // A one-sheet book gives one file; several sheets give a folder with one file per sheet.
    const files = v.filesOf(outs).filter((f) => extOf(f) === target);
    const sales = files.find((f) => /Sales\.(csv|tsv)$/.test(f)) ?? files[0];
    check(sales, `no .${target} among outputs`);
    if (src.key === 'xlsx') check(files.length === 2, `${files.length} sheet files, expected 2 (Sales, Notes)`);
    if (target === 'csv') v.text(sales, /Orange,12,3\.5/, /"Lime, Persian"/);
    else v.text(sales, /Orange\t12\t3\.5/);
    return;
  }
  const out = outs.find((p) => extOf(p) === target) ?? '';
  check(out, `no .${target} among outputs: ${outs.map((p) => basename(p)).join(', ')}`);
  if (target === 'pdf') return void (await v.pdf(out));
  if (v.DOC_PARTS[target]) {
    const names = await v.officeDoc(out, target);
    if (target === 'pptx' && src.pages) {
      const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
      check(slides === src.pages, `${slides} slides, expected ${src.pages}`);
    }
    return;
  }
  if (target === 'rtf') return void check(v.text(out).startsWith('{\\rtf'), 'not RTF');
  if (target === 'html') return void v.text(out, /<html/i, TEXT_MARK);
  if (target === 'txt' || target === 'md') return void v.text(out, kind === 'spreadsheet' ? /Orange/ : TEXT_MARK);
  throw new CheckError(`no verifier for ${kind} → ${target}`);
}

// =================================================================== conversion cases

interface KindPlan {
  kind: Kind;
  /** Representative first; later inputs only add the targets the first one hides (its own format). */
  reps: Src[];
  /** Extra input formats worth decoding (one target each). */
  extras?: [Src, string][];
  /** Why every case of this kind is skipped, if it is. */
  skip?: () => string | undefined;
  /** Why one target is skipped, if it is. */
  skipTarget?: (target: string) => string | undefined;
}

export function conversionCases(office: OfficeStatus): Case[] {
  const img = (key: string, w = 640, h = 480): Src => ({ key, w, h });
  const anyOffice = (app: 'word' | 'powerpoint' | 'excel') => office[app] || !!office.libreoffice;
  const plans: KindPlan[] = [
    { kind: 'image', reps: [img('png'), img('jpg')], extras: [[img('heic'), 'jpg'], [img('tiff'), 'png'], [img('avif'), 'png'], [img('webp'), 'jpg'], [img('bmp'), 'png'], [img('gif', 160, 120), 'png']] },
    { kind: 'video', reps: [{ key: 'mp4', w: 320, h: 240, dur: 3 }, { key: 'mov', w: 320, h: 240, dur: 3 }] },
    { kind: 'audio', reps: [{ key: 'wav', dur: 3 }, { key: 'mp3', dur: 3 }] },
    { kind: 'pdf', reps: [{ key: 'pdf', pages: 3 }] },
    { kind: 'document', reps: [{ key: 'docx' }, { key: 'md' }], extras: [[{ key: 'md' }, 'pdf'], [{ key: 'txt' }, 'docx']] },
    { kind: 'ebook', reps: [{ key: 'epub' }] },
    {
      kind: 'slides',
      reps: [{ key: 'pptx' }],
      skip: () => (anyOffice('powerpoint') ? undefined : 'needs PowerPoint or LibreOffice; none usable here (Office is kept off unless ORANGE_TEST_OFFICE=1)'),
      // PPTX → PPTX is hidden; the PPTX target needs a PPT/ODP/Key input, which can't be generated without an office suite.
    },
    { kind: 'spreadsheet', reps: [{ key: 'xlsx' }, { key: 'csv' }], extras: [[{ key: 'csv' }, 'pdf']] },
    { kind: 'subtitle', reps: [{ key: 'srt' }, { key: 'vtt' }] },
    { kind: 'archive', reps: [{ key: 'zip' }], extras: [[{ key: '7z' }, 'extract'], [{ key: 'tgz' }, 'extract']] },
  ];

  const cases: Case[] = [];
  const add = (plan: KindPlan, src: Src, target: string) =>
    cases.push({
      group: 'convert',
      name: `${plan.kind} ${src.key === 'tgz' ? 'tar.gz' : src.key} → ${target}`,
      timeoutMs: plan.kind === 'video' ? 240_000 : undefined,
      async run(t) {
        const why = plan.skip?.() ?? plan.skipTarget?.(target);
        if (why) throw new Skip(why);
        const input = need(src.key);
        await verifyConversion(plan.kind, src, target, await t.convert(input, target));
      },
    });

  for (const plan of plans) {
    const covered = new Set<string>();
    for (const src of plan.reps) {
      // Fixture names double as extensions except a few.
      const ext = { tgz: 'gz' }[src.key] ?? src.key;
      for (const target of conversionTargets([ext])) {
        const id = target.id === 'extract' ? 'extract' : target.ext;
        if (covered.has(id)) continue;
        covered.add(id);
        add(plan, src, id);
      }
    }
    for (const [src, target] of plan.extras ?? []) add(plan, src, target);
  }

  // Folders and mixed selections become one ZIP.
  cases.push({
    group: 'convert',
    name: 'folder → zip',
    async run(t) {
      const out = one(await t.convert(need('folder'), 'zip'));
      v.archive(out);
    },
  });
  cases.push({
    group: 'convert',
    name: 'mixed (png + wav) → zip',
    async run(t) {
      const out = one(await t.convert([need('png'), need('wav')], 'zip'));
      v.archive(out);
    },
  });
  return cases;
}

// =================================================================== tools

export function toolCases(opts: { ai: boolean }): Case[] {
  const c: Case[] = [];
  const add = (group: Case['group'], name: string, run: Case['run'], timeoutMs?: number) => c.push({ group, name, run, timeoutMs });

  // ---------------------------------------------------------------- instant
  add('instant', 'extractArchive zip', async (t) => {
    await verifyConversion('archive', { key: 'zip' }, 'extract', await t.tool('extractArchive', [need('zip')]));
  });
  add('instant', 'extractArchive 7z + tar.gz together', async (t) => {
    const outs = await t.tool('extractArchive', [need('7z'), need('tgz')]);
    check(outs.length === 2, `expected 2 outputs, got ${outs.length}`);
    for (const o of outs) await verifyConversion('archive', { key: '7z' }, 'extract', [o]);
  });

  // ---------------------------------------------------------------- compress
  add('tool', 'compress image (jpg, quality 60)', async (t) => {
    const src = need('jpg');
    const out = one(await t.tool('compress', [src], { image: { mode: 'quality', quality: 60, strip: true } }));
    check(basename(out) === 'photo compressed.jpg', `named ${basename(out)}`);
    check(size(out) < size(src), `not smaller (${size(out)} >= ${size(src)})`);
    const info = await v.image(out, 'jpg', { width: 640, height: 480 });
    check(!info.exif, 'metadata was not stripped');
  });
  add('tool', 'compress image (target size)', async (t) => {
    const src = need('png');
    const out = one(await t.tool('compress', [src], { image: { mode: 'size', targetBytes: 60_000 } }));
    check(size(out) <= 60_000 * 1.05, `${size(out)} bytes, target 60000`);
    await v.image(out, 'png');
  });
  add('tool', 'compress video (preset small)', async (t) => {
    const src = need('mp4');
    const out = one(await t.tool('compress', [src], { video: { mode: 'preset', preset: 'small' } }));
    check(size(out) < size(src), `not smaller (${size(out)} >= ${size(src)})`);
    v.media(out, { v: 'h264', a: 'aac', duration: 3, width: 320, height: 240 });
  }, 240_000);
  add('tool', 'compress audio (wav → m4a 128k)', async (t) => {
    const src = need('wav');
    const out = one(await t.tool('compress', [src], { audio: { kbps: 128 } }));
    check(size(out) < size(src), 'not smaller');
    v.media(out, { a: 'aac', duration: 3 });
  });
  add('tool', 'compress pdf (ebook)', async (t) => {
    const src = need('pdfPhoto');
    const out = one(await t.tool('compress', [src], { pdf: { level: 'ebook' } }));
    check(size(out) < size(src) / 2, `only ${Math.round((100 * size(out)) / size(src))}% of the original: Ghostscript's downsampling did not run`);
    await v.pdf(out, 1);
  });
  add('tool', 'compress folder → zip', async (t) => {
    v.archive(one(await t.tool('compress', [need('folder')], {})));
  });

  // ---------------------------------------------------------------- video
  add('tool', 'trimVideo precise 0.5–2.0 s', async (t) => {
    const out = one(await t.tool('trimVideo', [need('mp4')], { start: 0.5, end: 2, mode: 'precise' }));
    check(/ trimmed\.mp4$/.test(out), `named ${basename(out)}`);
    v.media(out, { v: 'h264', a: 'aac', duration: 1.5, tol: 0.15, width: 320, height: 240 });
  });
  add('tool', 'trimVideo fast (stream copy) 0–2.0 s', async (t) => {
    const out = one(await t.tool('trimVideo', [need('mp4')], { start: 0, end: 2, mode: 'fast' }));
    v.media(out, { v: 'h264', a: 'aac', duration: 2, tol: 0.2 });
  });
  add('tool', 'joinVideos (2 clips, fast path)', async (t) => {
    const out = one(await t.tool('joinVideos', [need('mp4'), need('mp4b')]));
    v.media(out, { v: 'h264', a: 'aac', duration: 5, tol: 0.3, width: 320, height: 240 });
  });
  add('tool', 'joinVideos (mp4 + mov, re-encode)', async (t) => {
    const out = one(await t.tool('joinVideos', [need('mp4b'), need('mov')], { reencode: true }));
    v.media(out, { v: 'h264', a: 'aac', duration: 5, tol: 0.3, width: 320, height: 240 });
  });
  add('tool', 'cropVideo 160×120', async (t) => {
    const out = one(await t.tool('cropVideo', [need('mp4')], { x: 80, y: 60, w: 160, h: 120 }));
    v.media(out, { v: 'h264', duration: 3, width: 160, height: 120 });
  });
  add('tool', 'speedVideo 2×', async (t) => {
    const out = one(await t.tool('speedVideo', [need('mp4')], { speed: 2 }));
    v.media(out, { v: 'h264', a: 'aac', duration: 1.5, tol: 0.25 });
  });
  add('tool', 'videoFrames (2 frames)', async (t) => {
    const files = v.filesOf(await t.tool('videoFrames', [need('mp4')], { times: [0.5, 1.5] }));
    check(files.length === 2, `${files.length} frames, expected 2`);
    for (const f of files) await v.image(f, 'png', { width: 320, height: 240 });
  });
  add('tool', 'splitVideo into 3 parts', async (t) => {
    const files = v.filesOf(await t.tool('splitVideo', [need('mp4')], { parts: 3 })).filter((f) => /\.(mp4|mkv|mov)$/i.test(f));
    check(files.length === 3, `${files.length} parts, expected 3`);
    const total = files.reduce((a, f) => a + v.media(f, { v: 'h264' }).duration, 0);
    check(Math.abs(total - 3) < 0.4, `parts add up to ${total.toFixed(2)} s, expected ~3 s`);
  });
  add('tool', 'redactVideo (one box)', async (t) => {
    const out = one(await t.tool('redactVideo', [need('mp4')], { boxes: [{ x: 10, y: 10, w: 100, h: 80, start: 0, end: 3, style: 'blur' }] }));
    v.media(out, { v: 'h264', duration: 3, width: 320, height: 240 });
  });

  // ---------------------------------------------------------------- audio
  add('tool', 'normalizeAudio (-16 LUFS)', async (t) => {
    const out = one(await t.tool('normalizeAudio', [need('wav')], { I: -16, TP: -1.5, LRA: 11 }));
    v.media(out, { duration: 3 });
  });
  add('tool', 'trimAudio 0.5–2.5 s', async (t) => {
    const out = one(await t.tool('trimAudio', [need('mp3')], { start: 0.5, end: 2.5 }));
    v.media(out, { a: 'mp3', duration: 2, tol: 0.15 });
  });
  add('tool', 'audioChannels → mono', async (t) => {
    const out = one(await t.tool('audioChannels', [need('wav')], { output: 'mono' }));
    v.media(out, { channels: 1, duration: 3 });
  });
  add('tool', 'bleepAudio (1.0–1.5 s)', async (t) => {
    const out = one(await t.tool('bleepAudio', [need('mp3')], { ranges: [{ start: 1, end: 1.5 }] }));
    v.media(out, { duration: 3 });
  });
  add('tool', 'joinAudio (2 mp3)', async (t) => {
    const out = one(await t.tool('joinAudio', [need('mp3'), need('mp3b')]));
    v.media(out, { a: 'mp3', duration: 5, tol: 0.3 });
  });
  add('tool', 'audioToVideo (waveform)', async (t) => {
    const out = one(await t.tool('audioToVideo', [need('wav')], { style: 'wave', size: 'square' }));
    v.media(out, { v: 'h264', a: 'aac', duration: 3, width: 1080, height: 1080 });
  }, 240_000);

  // ---------------------------------------------------------------- subtitles without a model (reviewed cues)
  const cues = [
    { start: 0.5, end: 1.5, text: 'Hello from Orange' },
    { start: 1.8, end: 2.8, text: 'Second cue' },
  ];
  add('tool', 'subtitles from reviewed cues → srt', async (t) => {
    const out = one(await t.tool('subtitles', [need('mp4')], { cues, output: 'srt' }));
    v.text(out, /00:00:00,500 --> 00:00:01,500/, 'Hello from Orange');
  });
  add('tool', 'subtitles from reviewed cues → track', async (t) => {
    const out = one(await t.tool('subtitles', [need('mp4')], { cues, output: 'track', cueLanguage: 'en' }));
    const info = v.media(out, { v: 'h264', duration: 3 });
    check(info.subs.length === 1, `${info.subs.length} subtitle tracks, expected 1`);
  });
  add('tool', 'subtitles from reviewed cues → burn', async (t) => {
    const out = one(await t.tool('subtitles', [need('mp4')], { cues, output: 'burn' }));
    v.media(out, { v: 'h264', duration: 3, width: 320, height: 240 });
  }, 240_000);

  // ---------------------------------------------------------------- images
  add('tool', 'cropImage centre half', async (t) => {
    const spec = { aspect: null, cx: 0.5, cy: 0.5, nw: 0.5, nh: 0.5, f: 1 };
    const out = one(await t.tool('cropImage', [need('jpg')], { rotate: 0, flipH: false, flipV: false, spec, out: null }));
    await v.image(out, 'jpg', { width: 320, height: 240 });
  });
  add('tool', 'cropImage rotate 90 + flip (heic in)', async (t) => {
    const spec = { aspect: null, cx: 0.5, cy: 0.5, nw: 1, nh: 1, f: 1 };
    const out = one(await t.tool('cropImage', [need('heic')], { rotate: 90, flipH: true, flipV: false, spec, out: null }));
    await v.image(out, 'jpg', { width: 480, height: 640 });
  });
  add('tool', 'createPdf (2 images, A4)', async (t) => {
    const out = one(await t.tool('createPdf', [need('jpg'), need('png')], { page: 'a4', orientation: 'auto', margin: 10 }));
    await v.pdf(out, 2);
  });

  // ---------------------------------------------------------------- PDF
  add('tool', 'mergePdf (custom order)', async (t) => {
    const a = need('pdf');
    const b = need('pdf2');
    const out = one(await t.tool('mergePdf', [a, b], { order: [b, a] }));
    check(basename(out) === 'Merged.pdf', `named ${basename(out)}`);
    await v.pdf(out, 5);
  });
  add('tool', 'splitPdf ranges [1] [2-3]', async (t) => {
    const outs = await t.tool('splitPdf', [need('pdf')], { groups: [[0], [1, 2]], mode: 'ranges' });
    check(outs.length === 2, `${outs.length} files, expected 2`);
    await v.pdf(outs[0], 1);
    await v.pdf(outs[1], 2);
  });
  add('tool', 'splitPdf extract page 2', async (t) => {
    const out = one(await t.tool('splitPdf', [need('pdf')], { groups: [[1]], mode: 'extract' }));
    check(/ p2\.pdf$/.test(out), `named ${basename(out)}`);
    await v.pdf(out, 1);
  });
  add('tool', 'organizePdf reorder + rotate', async (t) => {
    const src = need('pdf');
    const out = one(await t.tool('organizePdf', [src], { pages: [{ src, index: 2, rotate: 90 }, { src, index: 0 }] }));
    const info = await v.pdf(out, 2);
    check(info.rotation[0] === 90 && info.rotation[1] === 0, `rotations ${info.rotation.join(',')}, expected 90,0`);
  });

  // ---------------------------------------------------------------- rename (in place, so on copies)
  add('tool', 'rename swap a↔b + rename c, then undo', async (t) => {
    const a = join(t.dir, 'a.txt');
    const b = join(t.dir, 'b.txt');
    const cc = join(t.dir, 'c.txt');
    writeFileSync(a, 'A');
    writeFileSync(b, 'B');
    writeFileSync(cc, 'C');
    const outs = await t.tool('rename', [a, b, cc], { pairs: [{ from: a, name: 'b.txt' }, { from: b, name: 'a.txt' }, { from: cc, name: 'c renamed.txt' }] });
    check(outs.length === 3, `${outs.length} results, expected 3`);
    check(readFileSync(a, 'utf8') === 'B' && readFileSync(b, 'utf8') === 'A', 'a.txt and b.txt were not swapped');
    check(!existsSync(cc) && readFileSync(join(t.dir, 'c renamed.txt'), 'utf8') === 'C', 'c.txt was not renamed');
    check(!readdirSync(t.dir).some((f) => f.startsWith('.orange-rename')), 'temporary rename files left behind');
    const r = await undoLastRename();
    check(r.ok, `undo failed: ${r.message}`);
    check(readFileSync(a, 'utf8') === 'A' && readFileSync(b, 'utf8') === 'B' && readFileSync(cc, 'utf8') === 'C', 'undo did not restore the names');
  });
  add('tool', 'rename rejects invalid / clashing names', async (t) => {
    const a = join(t.dir, 'a.txt');
    const b = join(t.dir, 'b.txt');
    writeFileSync(a, 'A');
    writeFileSync(b, 'B');
    await rejects(t.tool('rename', [a], { pairs: [{ from: a, name: 'bad:name.txt' }] }), /can't be used/i, 'invalid character');
    await rejects(t.tool('rename', [a], { pairs: [{ from: a, name: 'b.txt' }] }), /already exists/i, 'clash with an existing file');
    check(readFileSync(a, 'utf8') === 'A' && readFileSync(b, 'utf8') === 'B', 'files changed after a rejected rename');
  });

  // ---------------------------------------------------------------- protect / unlock
  const PW = 'Orange-T3st pw';
  add('tool', 'protect PDF (AES-256) → unlock', async (t) => {
    const src = need('pdf');
    const locked = one(await t.tool('protect', [src], { mode: 'pdf', password: PW, permissions: { print: true, copy: true, edit: true } }));
    const info = await v.pdfInfo(locked);
    check(info.encrypted, 'protected PDF is not encrypted');
    check(/\/R\s+6\b/.test(readFileSync(locked, 'latin1')), 'not AES-256 (no /R 6 in the encryption dictionary)');
    await rejects(t.tool('unlock', [locked], { password: 'wrong password' }), /wrong/i, 'unlock with a wrong password');
    const open = one(await t.tool('unlock', [locked], { password: PW }));
    await v.pdf(open, 3);
    await rejects(t.tool('unlock', [open], { password: PW }), /isn't password-protected/i, 'unlock an unprotected PDF');
  });
  add('tool', 'protect ZIP (AES-256) → unlock', async (t) => {
    const file = t.copy(need('folder') + '\\a.txt');
    const zip = one(await t.tool('protect', [file], { mode: 'zip', password: PW }));
    check(extOf(zip) === 'zip', `output ${basename(zip)}`);
    v.archive(zip, PW);
    check(!v.sevenZipTest(zip, 'not the password').ok, '7z t accepted a wrong password');
    check(!v.sevenZipTest(zip).ok, '7z t passed without a password');
    await rejects(t.tool('unlock', [zip], { password: 'nope' }), /wrong/i, 'unlock with a wrong password');
    const dir = one(await t.tool('unlock', [zip], { password: PW }));
    const got = v.filesOf([dir]).find((f) => basename(f) === 'a.txt');
    check(got && readFileSync(got, 'utf8').includes('Orange archive file A'), 'unlocked archive lost a.txt');
  });
  add('tool', 'protect 7z (encrypted names)', async (t) => {
    const zip = one(await t.tool('protect', [need('folder')], { mode: '7z', password: PW }));
    v.archive(zip, PW);
    check(!v.sevenZipTest(zip).ok, '7z t passed without a password');
  });

  add('tool', 'protect PDF with a non-ASCII password → unlock', async (t) => {
    const pw = 'Grüße-日本-ß';
    const locked = one(await t.tool('protect', [need('pdf2')], { mode: 'pdf', password: pw }));
    check((await v.pdfInfo(locked)).encrypted, 'protected PDF is not encrypted');
    const open = one(await t.tool('unlock', [locked], { password: pw }));
    await v.pdf(open, 2);
  });
  add('tool', 'protect 7z with a non-ASCII password → unlock', async (t) => {
    const pw = 'Grüße-日本';
    const file = t.copy(need('folder') + '\\a.txt');
    const arc = one(await t.tool('protect', [file], { mode: '7z', password: pw }));
    const dir = one(await t.tool('unlock', [arc], { password: pw }));
    check(v.filesOf([dir]).some((f) => basename(f) === 'a.txt'), 'unlocked archive lost a.txt');
  });

  // ---------------------------------------------------------------- awkward paths: non-ASCII, spaces, &, and %
  type Put = (key: string, ext: string) => string;
  const awkward = (label: string, folder: string, file: string) => (name: string, run: (t: T, put: Put) => Promise<void>, timeoutMs?: number) =>
    add('tool', `${label}: ${name}`, (t) => {
      const sub = join(t.dir, folder);
      mkdirSync(sub, { recursive: true });
      return run(t, (key, ext) => {
        const dest = join(sub, `${file} ${key}.${ext}`);
        copyFileSync(need(key), dest);
        return dest;
      });
    }, timeoutMs);
  const tricky = awkward('unicode path', 'Ünïcödé 日本 & co', 'Résumé 日本');
  // Ghostscript expands %d/%s in -sOutputFile, so a literal % in a path must reach it as %%.
  const percent = awkward('% in path', '100% done', '50% off');
  percent('pdf → png (Ghostscript pages)', async (t, put) => {
    check(v.filesOf(await t.convert(put('pdf', 'pdf'), 'png')).length === 3, 'expected 3 page images');
  });
  percent('compress pdf uses Ghostscript (not the pdf-lib fallback)', async (t, put) => {
    const src = put('pdfPhoto', 'pdf');
    const out = one(await t.tool('compress', [src], { pdf: { level: 'ebook' } }));
    await v.pdf(out, 1);
    // Ghostscript's "ebook" downsampling takes this fixture well under half; pdf-lib's resave can't.
    check(size(out) < size(src) / 2, `only ${Math.round((100 * size(out)) / size(src))}% of the original: Ghostscript did not run`);
  });
  percent('protect → unlock pdf (Ghostscript pdfwrite)', async (t, put) => {
    const locked = one(await t.tool('protect', [put('pdf2', 'pdf')], { mode: 'pdf', password: PW }));
    await v.pdf(one(await t.tool('unlock', [locked], { password: PW })), 2);
  });
  percent('videoFrames 1 and 2 frames (FFmpeg image2)', async (t, put) => {
    const input = put('mp4', 'mp4');
    const single = one(await t.tool('videoFrames', [input], { times: [1] }));
    await v.image(single, 'png', { width: 320, height: 240 });
    check(v.filesOf(await t.tool('videoFrames', [input], { times: [0.5, 2] })).length === 2, 'expected 2 frames');
  });
  percent('ocr scanned pdf → txt (Ghostscript render)', async (t, put) => {
    const scan = one(await t.convert(put('textImage', 'png'), 'pdf'));
    v.text(one(await t.tool('ocr', [scan], { output: 'txt', langs: ['eng'] })), /ORANGE/i);
  }, 240_000);
  tricky('pdf → png (Ghostscript)', async (t, put) => {
    const files = v.filesOf(await t.convert(put('pdf', 'pdf'), 'png'));
    check(files.length === 3, `${files.length} page images, expected 3`);
  });
  tricky('pdf → txt, docx (pdf.js + pandoc)', async (t, put) => {
    const input = put('pdf', 'pdf');
    v.text(one(await t.convert(input, 'txt')), TEXT_MARK);
    await v.officeDoc(one(await t.convert(input, 'docx')), 'docx');
  });
  tricky('docx → pdf (pandoc + Chromium)', async (t, put) => {
    await v.pdf(one(await t.convert(put('docx', 'docx'), 'pdf')));
  });
  tricky('heic → jpg (ImageMagick)', async (t, put) => {
    await v.image(one(await t.convert(put('heic', 'heic'), 'jpg')), 'jpg', { width: 640, height: 480 });
  });
  tricky('mp4 → webm, wav → mp3 (FFmpeg)', async (t, put) => {
    v.media(one(await t.convert(put('mp4', 'mp4'), 'webm')), { v: VCODEC.webm, duration: 3 });
    v.media(one(await t.convert(put('wav', 'wav'), 'mp3')), { a: 'mp3', duration: 3 });
  });
  tricky('zip → extract, 7z (7-Zip)', async (t, put) => {
    const input = put('zip', 'zip');
    await verifyConversion('archive', { key: 'zip' }, 'extract', await t.convert(input, 'extract'));
    v.archive(one(await t.convert(input, '7z')));
  });
  tricky('compress pdf + protect/unlock pdf (Ghostscript)', async (t, put) => {
    const src = put('pdfPhoto', 'pdf');
    const out = one(await t.tool('compress', [src], { pdf: { level: 'ebook' } }));
    await v.pdf(out, 1);
    check(size(out) < size(src) / 2, `only ${Math.round((100 * size(out)) / size(src))}% of the original: Ghostscript did not run`);
    const locked = one(await t.tool('protect', [put('pdf2', 'pdf')], { mode: 'pdf', password: PW }));
    await v.pdf(one(await t.tool('unlock', [locked], { password: PW })), 2);
  });
  tricky('ocr scanned pdf → txt (Ghostscript + Tesseract)', async (t, put) => {
    const scan = one(await t.convert(put('textImage', 'png'), 'pdf'));
    v.text(one(await t.tool('ocr', [scan], { output: 'txt', langs: ['eng'] })), /ORANGE/i);
  }, 240_000);

  // ---------------------------------------------------------------- edge cases the wheel hits in real life
  add('tool', 'edge: converting twice never overwrites ("name 2")', async (t) => {
    const a = one(await t.convert(need('png'), 'jpg'));
    const b = one(await t.convert(need('png'), 'jpg'));
    check(basename(a) === 'sample.jpg' && basename(b) === 'sample 2.jpg', `names ${basename(a)}, ${basename(b)}`);
  });
  add('tool', 'edge: transparent png → jpg is flattened on white', async (t) => {
    const src = join(t.dir, 'alpha.png');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: { create: { width: 32, height: 32, channels: 4, background: { r: 230, g: 100, b: 20, alpha: 1 } } }, left: 16, top: 16 }])
      .png()
      .toFile(src);
    const out = one(await t.convert(src, 'jpg'));
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    check(data[0] > 240 && data[1] > 240 && data[2] > 240, `corner pixel ${data[0]},${data[1]},${data[2]}, expected white`);
  });
  add('tool', 'edge: EXIF-rotated jpg → png is upright', async (t) => {
    const src = join(t.dir, 'rotated.jpg');
    await sharp(need('png')).jpeg().withMetadata({ orientation: 6 }).toFile(src);
    await v.image(one(await t.convert(src, 'png')), 'png', { width: 480, height: 640 });
  });
  add('tool', 'edge: odd-sized video → mp4 (even dimensions)', async (t) => {
    const src = join(t.dir, 'odd.avi');
    execFileSync(v.exe('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=321x241:rate=25:duration=1', '-c:v', 'mpeg4', src], { windowsHide: true });
    v.media(one(await t.convert(src, 'mp4')), { v: 'h264', width: 320, height: 240, duration: 1 });
  });
  add('tool', 'edge: video without audio → mp3 says so', async (t) => {
    const src = join(t.dir, 'silent.mp4');
    execFileSync(v.exe('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src], { windowsHide: true });
    await rejects(t.convert(src, 'mp3'), /no sound/i, 'mp3 from a silent video');
  });
  add('tool', 'edge: damaged archive gives a clear error', async (t) => {
    const src = join(t.dir, 'broken.zip');
    writeFileSync(src, readFileSync(need('zip')).subarray(0, 120));
    await rejects(t.convert(src, 'extract'), /damaged|not a supported/i, 'extract a truncated zip');
    check(readdirSync(t.dir).length === 1, `left behind: ${readdirSync(t.dir).join(', ')}`);
  });

  // ---------------------------------------------------------------- metadata
  add('tool', 'metadata strip (jpg EXIF)', async (t) => {
    const src = need('jpg');
    check((await v.imageInfo(src)).exif, 'fixture has no EXIF to strip');
    const out = one(await t.tool('metadata', [src], { action: 'strip' }));
    check(/ clean\.jpg$/.test(out), `named ${basename(out)}`);
    const info = await v.image(out, 'jpg', { width: 640, height: 480 });
    check(!info.exif, 'EXIF still present');
  });
  add('tool', 'metadata strip (pdf info)', async (t) => {
    const src = need('pdf');
    check((await v.pdfInfo(src)).title, 'fixture has no title');
    const out = one(await t.tool('metadata', [src], { action: 'strip' }));
    const info = await v.pdf(out, 3);
    check(!info.title, `title still "${info.title}"`);
  });
  add('tool', 'metadata strip (mp4 tags)', async (t) => {
    const src = need('mp4');
    check(v.ffprobe(src).tags.title, 'fixture has no title tag');
    const out = one(await t.tool('metadata', [src], { action: 'strip' }));
    const info = v.media(out, { v: 'h264', a: 'aac', duration: 3 });
    check(!info.tags.title, `title tag still "${info.tags.title}"`);
  });
  add('tool', 'metadata edit (mp3 title, pdf title)', async (t) => {
    const mp3 = need('mp3');
    const pdfIn = need('pdf');
    const outs = await t.tool('metadata', [mp3, pdfIn], { action: 'edit', edits: { [mp3]: { title: 'Edited tone' }, [pdfIn]: { title: 'Edited PDF' } } });
    check(outs.length === 2, `${outs.length} outputs, expected 2`);
    const m = outs.find((o) => extOf(o) === 'mp3')!;
    check(v.media(m, { a: 'mp3' }).tags.title === 'Edited tone', 'mp3 title not changed');
    check((await v.pdf(outs.find((o) => extOf(o) === 'pdf')!)).title === 'Edited PDF', 'pdf title not changed');
  });

  // ---------------------------------------------------------------- OCR (English data ships with Orange: no download)
  add('tool', 'ocr image → txt', async (t) => {
    const out = one(await t.tool('ocr', [need('textImage')], { output: 'txt', langs: ['eng'], combine: false }));
    v.text(out, /ORANGE/i, /TEST/i);
  }, 240_000);
  add('tool', 'ocr image → searchable pdf', async (t) => {
    const out = one(await t.tool('ocr', [need('textImage')], { output: 'pdf', langs: ['eng'], combine: false }));
    await v.pdf(out, 1);
    // Read the new text layer back with Orange's own PDF → TXT.
    const txt = one(await t.convert(out, 'txt'));
    v.text(txt, /ORANGE/i);
  }, 240_000);
  add('tool', 'ocr scanned pdf → md', async (t) => {
    const scanPdf = one(await t.convert(need('textImage'), 'pdf'));
    const out = one(await t.tool('ocr', [scanPdf], { output: 'md', langs: ['eng'], combine: false }));
    v.text(out, /ORANGE/i);
  }, 240_000);

  // ---------------------------------------------------------------- AI tools that download models
  const ai = (name: string, run: Case['run']) =>
    add('ai', name, async (t) => {
      if (!opts.ai) throw new Skip('model download; set ORANGE_TEST_AI=1 to run');
      await run(t);
    }, 900_000);
  ai('removeBg (RMBG-1.4, 176 MB)', async (t) => {
    const out = one(await t.tool('removeBg', [need('jpg')], { format: 'png' }));
    const m = await v.image(out, 'png');
    check(m.width > 0, 'empty cut-out');
  });
  ai('upscale 2× photo (Real-ESRGAN)', async (t) => {
    const out = one(await t.tool('upscale', [need('gif')], { model: 'photo', scale: 2 }));
    const info = await v.imageInfo(out);
    check(info.width === 320 && info.height === 240, `size ${info.width}x${info.height}, expected 320x240`);
  });
  ai('subtitles from speech (Whisper fast)', async (t) => {
    const out = one(await t.tool('subtitles', [need('mp4')], { model: 'fast', language: 'en', output: 'srt' }).catch((e) => {
      // A sine tone has no words: "No speech was found" proves the model loaded and ran.
      if (/No speech was found/i.test(String(e?.message))) return [] as string[];
      throw e;
    }).then((o) => (o.length ? o : [need('srt')])));
    v.text(out, /-->/);
  });

  return c;
}
