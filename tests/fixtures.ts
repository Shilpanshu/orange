// Generates small, real sample files with the bundled tools. Everything lands in <run>/fixtures.
// A fixture that can't be made is recorded; only the cases that need it fail (with the reason).
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { makeCtx, outputDirOverride } from '../src/main/jobs';
import { converter as imageConv } from '../src/main/ops/convert-image';
import { pandocExe } from '../src/main/engines/pandoc';
import { CheckError, MAGICK, exe } from './verify';

export const fx: Record<string, string> = {};
export const fxErrors: Record<string, string> = {};

/** Path of a fixture, or a failure explaining why it is missing. */
export function need(name: string): string {
  if (fx[name] && existsSync(fx[name])) return fx[name];
  throw new CheckError(`fixture "${name}" unavailable: ${fxErrors[name] ?? 'not generated'}`);
}

function sh(file: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file.split(/[\\/]/).pop()} ${args.slice(0, 3).join(' ')}…: ${String(stderr || err.message).trim().split(/\r?\n/).slice(-2).join(' ')}`));
      else resolve(String(stdout));
    });
  });
}

const ffmpeg = (args: string[]) => sh(exe('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const sevenZip = (args: string[], cwd: string) => sh(exe('7z'), [...args, '-bso0', '-bsp0', '-y'], { cwd });

export const MARKDOWN = `---
title: Orange Fixture Document
---

# Orange regression fixture

The quick brown fox jumps over the lazy dog. This paragraph exists so converters have real text to carry.

## A list

- First point about oranges
- Second point about lemons

## A table

| Fruit | Qty | Price |
|-------|-----|-------|
| Orange | 12 | 3.50 |
| Lemon | 7 | 2.25 |
`;

const SRT = `1
00:00:00,500 --> 00:00:02,000
Hello from <i>Orange</i>.

2
00:00:02,500 --> 00:00:04,000
Second line & more
over two lines.
`;

const VTT = `WEBVTT

NOTE fixture

00:00.500 --> 00:02.000 align:start
Hello from Orange.

00:02.500 --> 00:04.000
<v Speaker>Second cue</v>
`;

async function makePdf(out: string, pages: number, title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor('Orange test suite');
  doc.setSubject('Regression fixture');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Orange Regression Fixture page ${i + 1}`, { x: 72, y: 760, size: 22, font: bold, color: rgb(0.1, 0.1, 0.1) });
    const lines = [
      'The quick brown fox jumps over the lazy dog. Orange converts files offline.',
      'This paragraph gives text extraction something real to work with, across',
      'several lines so that reflow into paragraphs can be checked as well.',
    ];
    lines.forEach((l, k) => page.drawText(l, { x: 72, y: 720 - k * 16, size: 12, font }));
    if (i === 1 || pages === 1) {
      const rows = [['Fruit', 'Qty', 'Price'], ['Orange', '12', '3.50'], ['Lemon', '7', '2.25'], ['Lime', '30', '9.00']];
      rows.forEach((r, ri) => r.forEach((c, ci) => page.drawText(c, { x: 72 + ci * 150, y: 620 - ri * 18, size: 12, font: ri ? font : bold })));
    }
    if (i === 2) {
      ['- First point about oranges', '- Second point about lemons'].forEach((l, k) => page.drawText(l, { x: 90, y: 620 - k * 16, size: 12, font }));
    }
  }
  writeFileSync(out, await doc.save());
}

type Step = [names: string[], fn: () => Promise<void>];

export async function generateFixtures(dir: string): Promise<{ ms: number; made: number; failed: string[] }> {
  const t0 = Date.now();
  mkdirSync(dir, { recursive: true });
  const p = (n: string) => join(dir, n);
  const ac = new AbortController();

  // Runs the app's own image converter into the fixtures folder.
  const viaApp = async (input: string, target: string): Promise<string> => {
    const { ctx, cleanup } = makeCtx(ac.signal, () => {});
    try {
      const [out] = await outputDirOverride.run(dir, () => imageConv.convert(input, target, ctx));
      return out;
    } finally {
      cleanup();
    }
  };

  const steps: Step[] = [
    // ---------------------------------------------------------------- images
    [['png'], async () => {
      await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=1', '-frames:v', '1', p('sample.png')]);
    }],
    [['jpg'], async () => {
      await sharp(need('png'))
        .jpeg({ quality: 98 })
        .withExif({ IFD0: { Artist: 'Orange Test', Copyright: 'Orange fixture', ImageDescription: 'Orange regression' } })
        .toFile(p('photo.jpg'));
    }],
    // WebP / TIFF / AVIF / HEIC / BMP made by Orange's own converter from the PNG.
    ...(['webp', 'tiff', 'avif', 'heic', 'bmp'] as const).map((t): Step => [[t], async () => void (fx[t] = await viaApp(need('png'), t))]),
    [['gif'], async () => {
      await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', p('anim.gif')]);
    }],
    [['textImage'], async () => {
      // A clean scan-like image for OCR. ImageMagick renders text with Windows fonts; sharp's SVG is the fallback.
      try {
        await sh(MAGICK, ['-size', '1400x360', 'xc:white', '-font', 'Arial', '-pointsize', '96', '-fill', 'black', '-annotate', '+60+150', 'ORANGE TEST', '-annotate', '+60+290', 'Hello World 2026', p('scan.png')], {
          env: { MAGICK_HOME: dirname(MAGICK) },
        });
      } catch {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="360"><rect width="100%" height="100%" fill="white"/><text x="60" y="150" font-family="Arial" font-size="96">ORANGE TEST</text><text x="60" y="290" font-family="Arial" font-size="96">Hello World 2026</text></svg>`;
        await sharp(Buffer.from(svg)).png().toFile(p('scan.png'));
      }
    }],

    // ---------------------------------------------------------------- video / audio
    [['mp4'], async () => {
      await ffmpeg([
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', '30',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-metadata', 'title=Orange fixture video', '-shortest', p('sample.mp4'),
      ]);
    }],
    [['mp4b'], async () => {
      await ffmpeg([
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2',
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-shortest', p('clip2.mp4'),
      ]);
    }],
    [['mov'], async () => {
      await ffmpeg(['-i', need('mp4'), '-c', 'copy', p('sample.mov')]);
    }],
    [['wav'], async () => {
      await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-ac', '2', '-c:a', 'pcm_s16le', p('tone.wav')]);
    }],
    [['mp3'], async () => {
      await ffmpeg(['-i', need('wav'), '-c:a', 'libmp3lame', '-q:a', '2', '-metadata', 'title=Orange fixture tone', p('tone.mp3')]);
    }],
    [['mp3b'], async () => {
      await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=2', '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '2', p('tone2.mp3')]);
    }],

    // ---------------------------------------------------------------- PDFs
    [['pdf'], () => makePdf(p('doc.pdf'), 3, 'Orange fixture PDF')],
    [['pdf2'], () => makePdf(p('short.pdf'), 2, 'Orange short PDF')],
    [['pdfPhoto'], async () => {
      // A big noisy photo on a small page: Compress (Ghostscript "ebook", 150 dpi) has something to shrink.
      const jpg = p('noise.jpg');
      await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=2400x1800:rate=1', '-vf', 'noise=alls=30:allf=t', '-frames:v', '1', '-q:v', '2', jpg]);
      const doc = await PDFDocument.create();
      const img = await doc.embedJpg(readFileSync(jpg));
      const page = doc.addPage([595, 842]);
      page.drawImage(img, { x: 72, y: 400, width: 400, height: 300 });
      writeFileSync(p('photo.pdf'), await doc.save());
    }],

    // ---------------------------------------------------------------- documents (pandoc from Markdown)
    [['md'], async () => writeFileSync(p('doc.md'), MARKDOWN, 'utf8')],
    [['txt'], async () => writeFileSync(p('notes.txt'), 'Orange regression notes.\r\n\r\nSecond paragraph with *literal* stars.\r\n', 'utf8')],
    ...([['docx', 'doc.docx'], ['epub', 'book.epub'], ['pptx', 'deck.pptx']] as const).map(
      ([key, name]): Step => [[key], async () => {
        await sh(await pandocExe(), [need('md'), '-s', '-o', p(name)], { cwd: dir });
      }],
    ),

    // ---------------------------------------------------------------- spreadsheets
    [['xlsx'], async () => {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sales');
      ws.addRow(['Fruit', 'Qty', 'Price', 'Date']);
      ws.addRow(['Orange', 12, 3.5, new Date(Date.UTC(2026, 0, 15))]);
      ws.addRow(['Lemon', 7, 2.25, new Date(Date.UTC(2026, 1, 1))]);
      ws.addRow(['Lime, Persian', 30, 9, new Date(Date.UTC(2026, 2, 3))]);
      const notes = wb.addWorksheet('Notes');
      notes.addRow(['Orange regression workbook']);
      await wb.xlsx.writeFile(p('sheet.xlsx'));
    }],
    [['csv'], async () => writeFileSync(p('sheet.csv'), 'Fruit,Qty,Price\r\nOrange,12,3.50\r\n"Lime, Persian",30,9.00\r\n', 'utf8')],

    // ---------------------------------------------------------------- subtitles
    [['srt'], async () => writeFileSync(p('subs.srt'), SRT.replace(/\n/g, '\r\n'), 'utf8')],
    [['vtt'], async () => writeFileSync(p('subs.vtt'), VTT, 'utf8')],

    // ---------------------------------------------------------------- folders and archives (7-Zip)
    [['folder'], async () => {
      mkdirSync(p('payload/sub'), { recursive: true });
      writeFileSync(p('payload/a.txt'), 'Orange archive file A\n');
      writeFileSync(p('payload/sub/b.txt'), 'Orange archive file B\n');
      copyFileSync(need('png'), p('payload/picture.png'));
    }],
    [['zip'], () => sevenZip(['a', '-tzip', p('payload.zip'), 'payload'], dir).then(() => {})],
    [['7z'], () => sevenZip(['a', '-t7z', p('payload.7z'), 'payload'], dir).then(() => {})],
    [['tgz'], async () => {
      await sevenZip(['a', '-ttar', p('payload.tar'), 'payload'], dir);
      await sevenZip(['a', '-tgzip', p('payload.tar.gz'), p('payload.tar')], dir);
    }],
  ];

  // Default file names for steps that don't set fx themselves.
  const names: Record<string, string> = {
    png: 'sample.png', jpg: 'photo.jpg', gif: 'anim.gif', textImage: 'scan.png', mp4: 'sample.mp4', mp4b: 'clip2.mp4', mov: 'sample.mov',
    wav: 'tone.wav', mp3: 'tone.mp3', mp3b: 'tone2.mp3', pdf: 'doc.pdf', pdf2: 'short.pdf', pdfPhoto: 'photo.pdf', md: 'doc.md',
    txt: 'notes.txt', docx: 'doc.docx', epub: 'book.epub', pptx: 'deck.pptx', xlsx: 'sheet.xlsx', csv: 'sheet.csv', srt: 'subs.srt',
    vtt: 'subs.vtt', folder: 'payload', zip: 'payload.zip', '7z': 'payload.7z', tgz: 'payload.tar.gz',
  };

  const failed: string[] = [];
  for (const [keys, fn] of steps) {
    try {
      await fn();
      for (const k of keys) {
        if (!fx[k] && names[k]) fx[k] = p(names[k]);
        if (!fx[k] || !existsSync(fx[k])) throw new Error(`${names[k] ?? k} was not written`);
      }
    } catch (e: any) {
      for (const k of keys) {
        delete fx[k];
        fxErrors[k] = String(e?.message ?? e).slice(0, 240);
        failed.push(`${k}: ${fxErrors[k]}`);
      }
    }
  }
  return { ms: Date.now() - t0, made: Object.keys(fx).length, failed };
}
