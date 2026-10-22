// Regression cases for converter/engine bugs: hostile inputs the main matrix in cases.ts doesn't cover.
// Every case builds its own input inside its case folder, so it needs no shared fixture.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { makeCtx, outputDirOverride } from '../src/main/jobs';
import { converter as imageConv } from '../src/main/ops/convert-image';
import { converter as docConv } from '../src/main/ops/convert-docs';
import { downloadFile } from '../src/main/engines/ai';
import type { Case } from './cases';
import { BIN, MAGICK, check, exe } from './verify';
import * as v from './verify';

const sh = (file: string, args: string[], cwd?: string) =>
  execFileSync(file, args, { cwd, windowsHide: true, maxBuffer: 64 << 20, env: { ...process.env, MAGICK_HOME: dirname(MAGICK) } }).toString();
const ff = (args: string[]) => sh(exe('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const gs = (args: string[]) => sh(join(BIN, 'gs', 'bin', 'gswin64c.exe'), ['-q', '-dNOPAUSE', '-dBATCH', ...args]);

/** Raw ffprobe streams (verify.ffprobe drops pix_fmt / channel layout). */
function streams(p: string): any[] {
  const r = spawnSync(exe('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_streams', p], { encoding: 'utf8', windowsHide: true });
  check(r.status === 0, `ffprobe failed on ${p}`);
  return JSON.parse(r.stdout).streams ?? [];
}

/** A folder path well past MAX_PATH (260) under the case folder. */
function longDir(dir: string): string {
  const d = join(dir, ...Array.from({ length: 6 }, (_, i) => `a rather long folder name, number ${i}, for path tests`));
  mkdirSync(d, { recursive: true });
  return d;
}

/** Run a converter with a private Ctx so the case controls cancellation and where outputs go. */
async function convertWith(conv: { convert: (i: string, t: string, c: any) => Promise<string[]> }, input: string, target: string, outDir: string, signal: AbortSignal) {
  const { ctx, cleanup } = makeCtx(signal, () => {});
  try {
    return await outputDirOverride.run(outDir, () => conv.convert(input, target, ctx));
  } finally {
    cleanup();
  }
}

export const convCases: Case[] = [
  {
    group: 'convert',
    name: 'audio 5.1(side) AC-3 in FLAC → opus',
    async run(t) {
      const src = join(t.dir, 'surround.flac');
      ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2:sample_rate=48000', '-filter_complex', '[0]asplit=6[a][b][c][d][e][f];[a][b][c][d][e][f]join=inputs=6:channel_layout=5.1(side)', '-c:a', 'flac', src]);
      check(streams(src)[0]?.channel_layout === '5.1(side)', 'fixture is not 5.1(side)');
      const [out] = await t.convert(src, 'opus');
      v.media(out, { a: 'opus', channels: 6, duration: 2 });
    },
  },
  {
    group: 'convert',
    name: 'video with 5.1(side) audio → webm',
    async run(t) {
      const src = join(t.dir, 'surround.mkv');
      ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-filter_complex', '[1]asplit=6[a][b][c][d][e][f];[a][b][c][d][e][f]join=inputs=6:channel_layout=5.1(side)[o]', '-map', '0:v', '-map', '[o]', '-c:v', 'libx264', '-c:a', 'ac3', src]);
      const [out] = await t.convert(src, 'webm');
      v.media(out, { v: 'vp9', a: 'opus', channels: 6, duration: 2 });
    },
  },
  {
    group: 'convert',
    name: 'H.264 10-bit → mp4 re-encodes to 8-bit',
    async run(t) {
      const src = join(t.dir, 'hi10.mkv');
      ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', src]);
      const [out] = await t.convert(src, 'mp4');
      const vs = streams(out).find((s) => s.codec_type === 'video');
      check(vs?.codec_name === 'h264' && vs?.pix_fmt === 'yuv420p', `video ${vs?.codec_name} ${vs?.pix_fmt}, expected 8-bit h264 (High 10 doesn't play in the built-in players)`);
    },
  },
  {
    group: 'convert',
    name: 'image HEIC named with %d → png',
    async run(t) {
      const png = join(t.dir, 'seed.png');
      sh(MAGICK, ['-size', '64x48', 'xc:red', png]);
      const [heic] = await t.convert(png, 'heic');
      const odd = join(t.dir, 'photo %03d 50%.heic');
      copyFileSync(heic, odd);
      const outs = await t.convert(odd, 'png');
      await v.image(outs[0], 'png', { width: 64, height: 48 });
    },
  },
  {
    group: 'convert',
    name: 'image 0-byte HEIC → readable error',
    async run(t) {
      const src = join(t.dir, 'empty.heic');
      writeFileSync(src, '');
      try {
        await t.convert(src, 'jpg');
      } catch (e: any) {
        check(e?.name === 'UserError', `raw error instead of a readable one: ${e?.message}`);
        return;
      }
      throw new Error('converting an empty HEIC succeeded');
    },
  },
  {
    group: 'convert',
    name: 'image 8200 px → heic opens in libheif',
    timeoutMs: 240_000,
    async run(t) {
      const src = join(t.dir, 'big.png');
      sh(MAGICK, ['-size', '8200x8200', 'xc:skyblue', src]);
      const [out] = await t.convert(src, 'heic');
      // 512 px tiles would make 289 items; libheif refuses files with more than 256.
      const m = await sharp(out).metadata();
      check(m.width === 8200 && m.height === 8200, `heic reads as ${m.width}x${m.height}`);
    },
  },
  {
    group: 'convert',
    name: 'image/pdf/md in a >260-char folder',
    async run(t) {
      const d = longDir(t.dir);
      const png = join(d, 'pic.png');
      sh(exe('ffmpeg'), ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=64x48', '-frames:v', '1', png]);
      const pdf = join(d, 'doc.pdf');
      gs(['-sDEVICE=pdfwrite', '-o', join(t.dir, 'short.pdf'), '-c', '/Helvetica findfont 20 scalefont setfont 72 700 moveto (quick brown fox) show showpage showpage']);
      copyFileSync(join(t.dir, 'short.pdf'), pdf);
      const md = join(d, 'notes.md');
      writeFileSync(md, '# quick brown fox\n');
      check(png.length > 300, 'test path is not long');
      // Results land next to the input, i.e. in the long folder too.
      const jpg = await convertWith(imageConv, png, 'jpg', d, t.signal);
      await v.image(jpg[0], 'jpg', { width: 64, height: 48 });
      const pages = await convertWith(docConv, pdf, 'png', d, t.signal);
      check(v.filesOf(pages).filter((f) => f.endsWith('.png')).length === 2, 'expected 2 page images');
      const docx = await convertWith(docConv, md, 'docx', d, t.signal);
      await v.officeDoc(docx[0], 'docx');
      const page = join(d, 'page.html');
      writeFileSync(page, '<h1>quick brown fox</h1>');
      const printed = await convertWith(docConv, page, 'pdf', d, t.signal);
      await v.pdf(printed[0]);
    },
  },
  {
    group: 'convert',
    name: 'pdf → png cancelled leaves no folder',
    async run(t) {
      const pdf = join(t.dir, 'long.pdf');
      gs(['-sDEVICE=pdfwrite', '-o', pdf, '-c', '1 1 150 { /Helvetica findfont 20 scalefont setfont 72 700 moveto (Page ) show 10 string cvs show showpage } for']);
      const out = join(t.dir, 'out');
      mkdirSync(out);
      const ac = new AbortController();
      // Cancel once Ghostscript has written its first pages.
      const poll = setInterval(() => {
        const d = join(out, 'long');
        if (existsSync(d) && readdirSync(d).length >= 2) ac.abort();
      }, 20);
      try {
        await convertWith(docConv, pdf, 'png', out, ac.signal);
        throw new Error('finished before it could be cancelled');
      } catch (e: any) {
        check(/Cancelled/.test(String(e?.message)), `failed with ${e?.message}`);
      } finally {
        clearInterval(poll);
      }
      check(readdirSync(out).length === 0, `left behind: ${readdirSync(out).join(', ')}`);
    },
  },
  {
    group: 'convert',
    name: 'spreadsheet sheets "A_B" + "A<B" → csv',
    async run(t) {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      for (const n of ['A_B', 'A<B', 'A|B']) wb.addWorksheet(n).addRow([n]);
      const src = join(t.dir, 'names.xlsx');
      await wb.xlsx.writeFile(src);
      const outs = await t.convert(src, 'csv');
      const files = v.filesOf(outs).map((f) => basename(f)).sort();
      check(files.join('|') === 'A_B 2.csv|A_B 3.csv|A_B.csv', `got ${files.join(', ')}`);
    },
  },
  {
    group: 'convert',
    name: 'archive tar with symlinks → extract',
    async run(t) {
      // ustar entries: a link to an absolute path, a relative one, one escaping the folder, and a file.
      const hdr = (name: string, type: string, size: number, link = '') => {
        const b = Buffer.alloc(512);
        b.write(name, 0);
        b.write('0000644\0', 100);
        b.write('0000000\0', 108);
        b.write('0000000\0', 116);
        b.write(size.toString(8).padStart(11, '0') + '\0', 124);
        b.write('00000000000\0', 136);
        b.write('        ', 148);
        b.write(type, 156);
        b.write(link, 157);
        b.write('ustar\0', 257);
        b.write('00', 263);
        let s = 0;
        for (const x of b) s += x;
        b.write(s.toString(8).padStart(6, '0') + '\0 ', 148);
        return b;
      };
      const data = Buffer.from('payload');
      const tar = join(t.dir, 'links.tar');
      writeFileSync(tar, Buffer.concat([hdr('pkg/abs', '2', 0, '/usr/lib/libfoo.so'), hdr('pkg/rel', '2', 0, 'a.txt'), hdr('pkg/up', '2', 0, '../../../../outside'), hdr('pkg/a.txt', '0', data.length), data, Buffer.alloc(512 - data.length), Buffer.alloc(1024)]));
      const outs = await t.convert(tar, 'extract');
      const a = v.filesOf(outs).find((f) => basename(f) === 'a.txt');
      check(a && readFileSync(a, 'utf8') === 'payload', 'a.txt was not extracted');
      check(!existsSync(join(t.dir, '..', 'outside')), 'a link escaped the output folder');
    },
  },
  {
    group: 'convert',
    name: 'AI model download: two jobs fetch the same file',
    async run(t) {
      const payload = randomBytes(8 << 20);
      const sha = createHash('sha256').update(payload).digest('hex');
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-length': payload.length });
        let off = 0;
        const tick = () => {
          if (off >= payload.length) return res.end();
          res.write(payload.subarray(off, (off += 256 << 10)));
          setTimeout(tick, 10);
        };
        tick();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      try {
        const url = `http://127.0.0.1:${(server.address() as any).port}/model.onnx`;
        const dest = join(t.dir, 'models', 'model.onnx');
        const second = new Promise((r) => setTimeout(r, 150)).then(() => downloadFile(url, dest, { sha256: sha, signal: t.signal }));
        await Promise.all([downloadFile(url, dest, { sha256: sha, signal: t.signal }), second]);
        check(createHash('sha256').update(readFileSync(dest)).digest('hex') === sha, 'downloaded model is damaged');
        check(readdirSync(dirname(dest)).join() === 'model.onnx', `left behind: ${readdirSync(dirname(dest)).join(', ')}`);
        check(statSync(dest).size === payload.length, 'size mismatch');
      } finally {
        server.close();
      }
    },
  },
];
