// Regression cases for bugs fixed in the tool handlers (src/main/ops/tools-*.ts, av-util.ts).
// Each case makes its own small inputs in its case folder, so it doesn't depend on shared fixtures.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { makeCtx, outputDirOverride } from '../src/main/jobs';
import { tools as avTools } from '../src/main/ops/tools-av';
import { _internal as fileInternal } from '../src/main/ops/tools-file';
import type { Case, T } from './cases';
import * as v from './verify';
import { check, CheckError, exe } from './verify';

const ff = (...args: string[]) => execFileSync(exe('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });

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

const files = (dir: string, re: RegExp) => readdirSync(dir).filter((f) => re.test(f));

function sub(t: T, ...parts: string[]) {
  const d = join(t.dir, 'in', ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

function tone(path: string, seconds = 3, rate = 44100) {
  ff('-f', 'lavfi', '-i', `sine=f=440:d=${seconds}:sample_rate=${rate}`, '-ac', '2', path);
  return path;
}

function clip(path: string, size = '320x240', extra: string[] = []) {
  ff('-f', 'lavfi', '-i', `testsrc2=s=${size}:r=25:d=2`, '-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=48000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...extra, path);
  return path;
}

async function pdf(path: string, pages: number) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage().drawText(`Page ${i + 1}`, { x: 50, y: 700, font });
  writeFileSync(path, await doc.save());
  return path;
}

export const toolCases = (_opts: { ai: boolean }): Case[] => {
  const c: Case[] = [];
  const add = (name: string, run: Case['run'], timeoutMs?: number) => c.push({ group: 'tool', name, run, timeoutMs });

  // ---------------------------------------------------------------- outputs with the same name
  // Parallel workers all pick a name before any of them writes, so these need 3 files of some size.
  const unique = (outs: string[]) => check(outs.length === 3 && new Set(outs).size === 3 && outs.every((o) => existsSync(o)), `outputs ${outs.map((o) => basename(o)).join(', ')}`);
  add('cropImage: same-named images from different folders all survive', async (t) => {
    const ins = ['a', 'b', 'c'].map((d) => join(sub(t, d), 'photo.png'));
    for (const [i, p] of ins.entries()) await sharp({ create: { width: 1600, height: 1200, channels: 3, background: ['#e05a1a', '#1a5ae0', '#1ae05a'][i] } }).png().toFile(p);
    const outs = await t.tool('cropImage', ins, { rotate: 0, flipH: false, flipV: false, spec: { aspect: null, cx: 0.5, cy: 0.5, nw: 0.5, nh: 0.5, f: 1 }, out: null });
    unique(outs);
    for (const o of outs) await v.image(o, 'png', { width: 800, height: 600 });
  });
  add('compress audio: same-named files from different folders all survive', async (t) => {
    const ins = ['a', 'b', 'c'].map((d) => tone(join(sub(t, d), 'song.wav'), 20));
    const outs = await t.tool('compress', ins, { audio: { kbps: 96 } });
    unique(outs);
    for (const o of outs) v.media(o, { a: 'aac', duration: 20 });
  });
  add('metadata strip: same-named files from different folders all survive', async (t) => {
    const ins = ['a', 'b', 'c'].map((d) => join(sub(t, d), 'pic.png'));
    for (const p of ins) await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#888' } }).png().withExif({ IFD0: { Artist: 'Someone' } }).toFile(p);
    const outs = await t.tool('metadata', ins, { action: 'strip' });
    unique(outs);
    for (const o of outs) check(!(await v.imageInfo(o)).exif, `${basename(o)} still has EXIF`);
  });

  // ---------------------------------------------------------------- batches that fail part-way
  add('normalizeAudio: a file without audio fails before anything is written', async (t) => {
    const a = tone(join(sub(t), 'voice.wav'));
    const silentVideo = join(sub(t), 'mute.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentVideo);
    await rejects(t.tool('normalizeAudio', [a, silentVideo], {}), /has no audio/i, 'normalize with a silent video');
    check(!files(t.dir, /normalized/).length, `left behind: ${files(t.dir, /normalized/).join(', ')}`);
  });
  add('protect PDF batch: one already-protected PDF leaves no partial results', async (t) => {
    const a = await pdf(join(sub(t), 'a.pdf'), 1);
    const b = await pdf(join(sub(t), 'b.pdf'), 1);
    const locked = (await t.tool('protect', [b], { mode: 'pdf', password: 'first' }))[0];
    await rejects(t.tool('protect', [a, locked], { mode: 'pdf', password: 'second' }), /already password-protected/i, 'protect a locked PDF');
    check(!existsSync(join(t.dir, 'a protected.pdf')), 'a protected.pdf was left behind');
  });

  // ---------------------------------------------------------------- media edge cases
  add('videoFrames: a time past the end is skipped, not reported as saved', async (t) => {
    const src = clip(join(sub(t), 'clip.mp4'));
    const outs = await t.tool('videoFrames', [src], { times: [1, 30] });
    check(outs.length === 1 && existsSync(outs[0]) && /\.png$/.test(outs[0]), `outputs ${outs.join(', ')}`);
    await rejects(t.tool('videoFrames', [src], { times: [30] }), /past the end/i, 'only a frame past the end');
  });
  add('joinVideos: clips with different rotation are not stream-copied', async (t) => {
    const plain = clip(join(sub(t), 'landscape.mp4'));
    const rotated = join(sub(t), 'rotated.mp4');
    ff('-display_rotation', '90', '-i', plain, '-c', 'copy', rotated); // shows as 240×320
    const portrait = clip(join(sub(t), 'portrait.mp4'), '240x320');
    const out = (await t.tool('joinVideos', [rotated, portrait], {}))[0];
    // Copying would keep clip 1's rotation for both, showing the portrait clip sideways (320×240 + rotation).
    v.media(out, { v: 'h264', width: 240, height: 320, duration: 4 });
  });
  add('joinAudio: 96 kHz FLAC joined to MP3 is resampled', async (t) => {
    const hi = join(sub(t), 'hi.flac');
    tone(hi, 2, 96000);
    const lo = tone(join(sub(t), 'lo.wav'), 2);
    const out = (await t.tool('joinAudio', [hi, lo], { format: 'mp3', crossfade: 0 }))[0];
    const info = v.media(out, { a: 'mp3', duration: 4 });
    check(info.a?.sampleRate === 48000, `sample rate ${info.a?.sampleRate}`);
  });
  add('trimAudio: removing silence from pure silence fails clearly', async (t) => {
    const src = join(sub(t), 'quiet.wav');
    ff('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '3', src);
    await rejects(t.tool('trimAudio', [src], { start: 0, end: 3, trimSilence: true, threshold: -50 }), /all silence/i, 'trim silence of silence');
    check(!files(t.dir, /trimmed/).length, 'an empty result was left behind');
  });
  add('cancelled ffmpeg run leaves no half-written file', async (t) => {
    const src = join(sub(t), 'long.mp4');
    ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src);
    const ac = new AbortController();
    const { ctx, cleanup } = makeCtx(ac.signal, () => {}, { speed: 0.25 });
    setTimeout(() => ac.abort(), 700);
    try {
      await outputDirOverride.run(t.dir, () => avTools.speedVideo([src], ctx));
      throw new CheckError('finished before it could be cancelled');
    } catch (e: any) {
      if (e instanceof CheckError) throw e;
    } finally {
      cleanup();
    }
    check(!files(t.dir, /0\.25x/).length, `left behind: ${files(t.dir, /0\.25x/).join(', ')}`);
  });
  add('ffmpeg errors name the cause, not "Terminating thread"', async (t) => {
    const src = clip(join(sub(t), 'clip.mp4'));
    const m = await rejects(t.tool('redactVideo', [src], { boxes: [{ x: 5, y: 5, w: 2, h: 2, start: 0, end: 9, style: 'blur' }] }), /./, 'a 2-pixel blur box');
    check(!/Terminating thread|return code/i.test(m), `message: ${m}`);
  });
  add('subtitles burn-in works from a temp folder with an apostrophe', async (t) => {
    const src = clip(join(sub(t), 'clip.mp4'));
    const tmp = join(t.dir, "O'Neil temp");
    mkdirSync(tmp, { recursive: true });
    const old = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TEMP = process.env.TMP = tmp;
    try {
      const out = (await t.tool('subtitles', [src], { output: 'burn', cues: [{ start: 0.2, end: 1.5, text: 'Hello' }] }))[0];
      v.media(out, { v: 'h264', duration: 2 });
    } finally {
      process.env.TEMP = old.TEMP;
      process.env.TMP = old.TMP;
    }
  });

  // ---------------------------------------------------------------- PDFs, images, metadata
  add('createPdf: a tiny JPEG (under 4 KB) embeds', async (t) => {
    // Node returns small files as a slice of a shared pool; pdf-lib's JPEG reader ignored the offset.
    const small = join(sub(t), 'small.jpg');
    const small2 = join(sub(t), 'small2.jpg');
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#4a8' } }).jpeg().toFile(small);
    await sharp({ create: { width: 30, height: 40, channels: 3, background: '#a48' } }).jpeg().toFile(small2);
    const out = (await t.tool('createPdf', [small, small2], { page: 'fit', orientation: 'auto', margin: 0 }))[0];
    await v.pdf(out, 2);
  });
  add('organizePdf: no valid pages is an error, not a blank page', async (t) => {
    const src = await pdf(join(sub(t), 'doc.pdf'), 2);
    await rejects(t.tool('organizePdf', [src], { pages: [{ src, index: 9 }] }), /pages/i, 'organize with missing pages');
  });
  add('metadata: Date taken reads back after an edit', async (t) => {
    const src = join(sub(t), 'p.jpg');
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#888' } }).jpeg().toFile(src);
    const out = (await t.tool('metadata', [src], { action: 'edit', edits: { [src]: { dateTaken: '2024-05-06T07:08' } } }))[0];
    const info = await fileInternal.readMeta(out);
    check(info.fields.dateTaken === '2024-05-06T07:08:00', `dateTaken "${info.fields.dateTaken}"`);
  });
  add('metadata: WebP location is written; TIFF edits are refused, not silently dropped', async (t) => {
    const webp = join(sub(t), 'p.webp');
    const tiff = join(sub(t), 'p.tiff');
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#888' } }).webp().toFile(webp);
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#888' } }).tiff().toFile(tiff);
    const out = (await t.tool('metadata', [webp], { action: 'edit', edits: { [webp]: { gps: '-33.8688, 151.2093' } } }))[0];
    const info = await fileInternal.readMeta(out);
    check(info.fields.gps === '-33.868800, 151.209300', `gps "${info.fields.gps}"`);
    await rejects(t.tool('metadata', [tiff], { action: 'edit', edits: { [tiff]: { make: 'Acme' } } }), /can't edit metadata in TIFF/i, 'TIFF edit');
  });

  // ---------------------------------------------------------------- archives with clashing names
  add('protect ZIP / compress ZIP: two items with the same name fail clearly', async (t) => {
    const a = join(sub(t, 'a'), 'note.txt');
    const b = join(sub(t, 'b'), 'note.txt');
    writeFileSync(a, 'a'.repeat(4000));
    writeFileSync(b, 'b'.repeat(4000));
    await rejects(t.tool('protect', [a, b], { mode: 'zip', password: 'pw' }), /Two of these items are named "note\.txt"/, 'protect ZIP');
    await rejects(t.tool('compress', [a, b], {}), /Two items are named "note\.txt"/, 'compress ZIP');
    check(!files(t.dir, /\.zip$/).length, 'a ZIP was left behind');
  });

  return c;
};
