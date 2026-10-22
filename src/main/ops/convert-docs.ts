// Document conversions: PDF, word-processing documents, slides, spreadsheets and EPUB.
//
// Engines, best first for each job:
//   Microsoft Office (COM)  - Office formats in/out, Word's PDF reflow for PDF→DOCX
//   LibreOffice (headless)  - everything Office does when Office is absent, plus Apple iWork files
//   Pandoc                  - Markdown / HTML / DOCX / ODT / RTF / EPUB / text
//   Ghostscript             - PDF pages → images
//   pdf.js                  - PDF text, structure and tables
//   exceljs                 - CSV / TSV / XLSX natively, without any office suite
//   Chromium (Electron)     - HTML → PDF printing for text formats when Word isn't needed
import { BrowserWindow, app } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { extOf, kindOfExt } from '../../shared/catalog';
import type { ConverterModule, Ctx } from './types';
import { UserError } from './types';
import { binDir } from '../paths';
import { run } from '../engines/run';
import { libreConvert, moveFile, needOfficeError, officeConvert, officeStatus, OfficeUnavailableError, wordPdfReflowUsable, type OfficeApp } from '../engines/office';
import { hasPandoc, pandocConvert, pandocReader, pandocWriter, READING_CSS } from '../engines/pandoc';
import { log } from '../log';

// ------------------------------------------------------------------ helpers

const norm = (ext: string) => ({ markdown: 'md', htm: 'html' })[ext] ?? ext;

function stemOf(p: string) {
  const b = basename(p);
  const e = extname(b);
  return e ? b.slice(0, -e.length) : b;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Progress for a sub-step: maps 0..1 into [a, b] of the overall bar. */
function span(ctx: Ctx, a: number, b: number) {
  return (f: number) => ctx.progress(a + (b - a) * Math.max(0, Math.min(1, f)));
}

function checkCancel(ctx: Ctx) {
  if (ctx.signal.aborted) throw new Error('Cancelled');
}

/** Decode text files that may be UTF-8 (with or without BOM), UTF-16, or legacy Windows-1252. */
function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** A sibling path that doesn't exist yet ("x files", "x files 2", …). */
function freeSibling(p: string) {
  if (!existsSync(p)) return p;
  for (let i = 2; ; i++) if (!existsSync(`${p} ${i}`)) return `${p} ${i}`;
}

// --------------------------------------------------------- office routing

const LO_FILTER: Record<string, string> = {
  docx: 'docx:"MS Word 2007 XML"',
  doc: 'doc:"MS Word 97"',
  odt: 'odt',
  rtf: 'rtf:"Rich Text Format"',
  pdf: 'pdf',
  pptx: 'pptx:"Impress MS PowerPoint 2007 XML"',
  xlsx: 'xlsx:"Calc MS Excel 2007 XML"',
  ods: 'ods',
};

interface OfficeRoute {
  /** Microsoft Office app able to open the input, if any. */
  app?: OfficeApp;
  /** LibreOffice import filter (for PDFs). */
  infilter?: string;
  /** False to skip LibreOffice (e.g. its result would be worse than our own fallback). */
  libre?: boolean;
  /** Describes the job in "X needs Office or LibreOffice" errors. */
  what: string;
  /** Give up after this long (Office can hang on hostile files). */
  timeoutMs?: number;
}

/** True when some installed suite can do this route. */
async function officeCan(route: OfficeRoute): Promise<boolean> {
  const st = await officeStatus();
  return !!((route.app && st[route.app]) || (route.libre !== false && st.libreoffice));
}

/** Convert with Microsoft Office if it can, else LibreOffice. Throws a helpful UserError when neither exists. */
async function viaOffice(input: string, output: string, fmt: string, ctx: Ctx, route: OfficeRoute, a = 0.05, b = 0.95): Promise<string> {
  const st = await officeStatus();
  const prog = span(ctx, a, b);
  let officeErr: unknown = null;
  if (route.app && st[route.app]) {
    try {
      await officeConvert(route.app, input, output, fmt, { signal: ctx.signal, onProgress: prog, timeoutMs: route.timeoutMs });
      if (existsSync(output)) return output;
      throw new Error('Office produced no output');
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      officeErr = e;
      log('office route failed, trying LibreOffice', route.app, e);
    }
  }
  if (route.libre !== false && st.libreoffice) {
    prog(0.2);
    await libreConvert(input, output, LO_FILTER[fmt] ?? fmt, { signal: ctx.signal, infilter: route.infilter, timeoutMs: route.timeoutMs });
    prog(1);
    return output;
  }
  // Office was tried and failed (not activated, hung, crashed) and there's no LibreOffice.
  // Report it as "unavailable" so callers with a built-in route (CSV/XLSX → PDF, DOCX via
  // pandoc, …) fall back to it instead of failing; their own error surfaces if they can't.
  if (officeErr) {
    if (officeErr instanceof OfficeUnavailableError) throw officeErr;
    throw new OfficeUnavailableError(officeErr instanceof Error ? officeErr.message : String(officeErr));
  }
  throw needOfficeError(route.what);
}

// -------------------------------------------------------------- Chromium print

function pageSizeForLocale(): 'A4' | 'Letter' {
  try {
    const cc = (app.getLocaleCountryCode?.() || '').toUpperCase();
    if (['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE'].includes(cc)) return 'Letter';
  } catch {
    /* default below */
  }
  return 'A4';
}

/** Render an HTML file to PDF in a hidden, script-less Chromium window. */
async function htmlToPdf(htmlFile: string, outPdf: string, ctx: Ctx, opts: { landscape?: boolean; pageNumbers?: boolean } = {}) {
  checkCancel(ctx);
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  const onAbort = () => win.destroy();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    // Never let a document navigate away or open windows.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    await win.loadFile(htmlFile);
    checkCancel(ctx);
    const pdf = await win.webContents.printToPDF({
      pageSize: pageSizeForLocale(),
      landscape: !!opts.landscape,
      printBackground: true,
      margins: { top: 0.7, bottom: 0.7, left: 0.75, right: 0.75 },
      displayHeaderFooter: opts.pageNumbers !== false,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font:8px Segoe UI,Arial,sans-serif;color:#8a8580;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    await writeFile(outPdf, pdf);
  } catch (e) {
    if (ctx.signal.aborted) throw new Error('Cancelled');
    throw e;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Wrap a fragment in a styled standalone HTML page. */
function htmlPage(title: string, body: string, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${READING_CSS}${extraCss}</style></head><body>${body}</body></html>`;
}

// -------------------------------------------------------------------- pandoc

/** Plain text → simple HTML (paragraphs on blank lines, line breaks kept). */
function textToHtml(text: string, title: string): string {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.replace(/^\n+|\n+$/g, '')).filter((p) => p.trim());
  const body = paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>\n')}</p>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>\n${body}\n</body></html>`;
}

/**
 * Run pandoc from `input` (treated by its extension) to `output` of `target` format.
 * Plain text is wrapped into HTML first so stray Markdown characters are kept literally.
 * Markdown output extracts embedded images into a sibling "<name> files" folder.
 */
async function pandocTo(input: string, srcExt: string, output: string, target: string, ctx: Ctx, title: string): Promise<string[]> {
  if (!hasPandoc()) throw new UserError('The document converter is missing. Reinstall Orange.');
  let src = input;
  let from = pandocReader(srcExt);
  const resourcePath = [dirname(input)];
  if (srcExt === 'txt') {
    src = join(ctx.tmp(), 'text.html');
    writeFileSync(src, textToHtml(decodeText(readFileSync(input)), title));
    from = 'html';
  }
  const to = pandocWriter(target);
  if (!from || !to) throw new UserError(`Can't convert ${srcExt.toUpperCase()} to ${target.toUpperCase()}.`);
  const extra: string[] = [];
  let media: string | null = null;
  if (target === 'md' && ['docx', 'odt', 'epub', 'rtf'].includes(srcExt)) {
    media = freeSibling(join(dirname(output), `${stemOf(output)} files`));
    extra.push(`--extract-media=${basename(media)}`);
  }
  // pandoc runs in the output folder (so extracted media links are relative), but Windows can't start a
  // process in a folder path past ~258 characters: work in temp then and move the results over.
  const work = dirname(output).length >= 240 ? ctx.tmp() : null;
  const written = work ? join(work, basename(output)) : output;
  await pandocConvert(src, from, written, to, {
    signal: ctx.signal,
    cwd: work ?? dirname(output),
    resourcePath,
    fallbackTitle: title,
    extra,
    tmp: ctx.tmp(),
  });
  if (work) {
    moveFile(written, output);
    const made = media && join(work, basename(media));
    if (made && existsSync(made)) {
      try {
        renameSync(made, media!);
      } catch {
        cpSync(made, media!, { recursive: true });
      }
    }
  }
  return media && existsSync(media) ? [output, media] : [output];
}

/** Any pandoc-readable input → styled standalone HTML (images embedded) in a temp folder. */
async function toPrintableHtml(input: string, srcExt: string, ctx: Ctx, title: string): Promise<string> {
  const html = join(ctx.tmp(), 'print.html');
  // Chromium can't load a file past MAX_PATH; pandoc can, and embeds the page's images on the way.
  if (srcExt === 'html' && input.length < 240) return input;
  await pandocTo(input, srcExt, html, 'html', ctx, title);
  return html;
}

// ------------------------------------------------------------------ pdf.js

type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    // pdf.js ships as ES modules; load the Node-friendly legacy build at runtime (kept external by the bundler).
    const url = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
    const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<PdfjsModule>;
    pdfjsPromise = dynamicImport(url);
    pdfjsPromise.catch(() => (pdfjsPromise = null));
  }
  return pdfjsPromise;
}

async function openPdf(input: string) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await readFile(input));
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    stopAtErrors: false,
  } as any);
  try {
    const doc = await task.promise;
    return Object.assign(doc, { destroy: () => task.destroy() });
  } catch (e: any) {
    void task.destroy();
    if (e?.name === 'PasswordException') throw new UserError('The PDF is password-protected.');
    if (e?.name === 'InvalidPDFException') throw new UserError("This file isn't a valid PDF.");
    throw e;
  }
}

interface TItem {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  eol: boolean;
}

interface PLine {
  text: string;
  /** The line split at wide gaps; 2+ aligned cells over several lines make a table. */
  cells: string[];
  boxes: { x: number; right: number }[];
  /** Set by detectTables() when the line is part of a table. */
  row?: boolean;
  x: number;
  right: number;
  y: number;
  size: number;
}

interface PdfPage {
  items: TItem[];
  lines: PLine[];
  width: number;
  height: number;
}

interface PdfText {
  pages: PdfPage[];
  title: string | null;
}

async function readPdfText(input: string, ctx: Ctx, prog: (f: number) => void): Promise<PdfText> {
  const doc = await openPdf(input);
  try {
    const pages: PdfPage[] = [];
    let title: string | null = null;
    try {
      const meta: any = await doc.getMetadata();
      const t = String(meta?.info?.Title ?? '').trim();
      if (t && !/^(untitled|microsoft word|document\d*)\b/i.test(t) && !/\.(docx?|pdf)$/i.test(t)) title = t;
    } catch {
      /* no metadata */
    }
    for (let p = 1; p <= doc.numPages; p++) {
      checkCancel(ctx);
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items: TItem[] = [];
      for (const it of tc.items as any[]) {
        if (typeof it.str !== 'string') continue;
        const t = it.transform as number[];
        const size = Math.hypot(t[2], t[3]) || it.height || 10;
        items.push({ str: it.str, x: t[4], y: t[5], w: it.width ?? 0, size, eol: !!it.hasEOL });
      }
      pages.push({ items, lines: itemsToLines(items), width: vp.width, height: vp.height });
      page.cleanup();
      prog(p / doc.numPages);
    }
    return { pages, title };
  } finally {
    void doc.destroy();
  }
}

function joinItems(items: TItem[]): string {
  let text = '';
  let prev: TItem | null = null;
  for (const it of items) {
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > Math.min(it.size, prev.size) * 0.12 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
    }
    text += it.str;
    prev = it;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function makeLine(items: TItem[]): PLine {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let size = 0;
  let longest = -1;
  for (const it of sorted) {
    if (it.str.trim().length > longest) {
      longest = it.str.trim().length;
      size = it.size;
    }
  }
  const last = sorted[sorted.length - 1];
  // Cells: split where the gap between inked pieces is clearly wider than a word space.
  // (Word fills table gaps with wide whitespace items, so those are skipped when measuring.)
  const cells: string[] = [];
  const boxes: { x: number; right: number }[] = [];
  let group: TItem[] = [];
  const flush = () => {
    const ink = group.filter((g) => g.str.trim());
    if (ink.length) {
      cells.push(joinItems(group));
      boxes.push({ x: ink[0].x, right: ink[ink.length - 1].x + ink[ink.length - 1].w });
    }
    group = [];
  };
  for (const it of sorted) {
    if (!it.str.trim()) {
      group.push(it);
      continue;
    }
    const ink = group.filter((g) => g.str.trim());
    const prev = ink[ink.length - 1];
    if (prev && it.x - (prev.x + prev.w) > Math.max(it.size, prev.size) * 0.8) flush();
    group.push(it);
  }
  flush();
  return { text: joinItems(sorted), cells, boxes, x: sorted[0].x, right: last.x + last.w, y: sorted[0].y, size };
}

/**
 * Marks table rows: runs of 2+ consecutive lines with the same number (2+) of cells whose
 * columns line up (left or right edges). A justified paragraph's odd wide gap never lines up.
 */
function detectTables(lines: PLine[]) {
  const candidate = (l: PLine) => l.cells.length >= 2 && !(l.cells.length === 2 && LIST_NUMBER.test(l.cells[0]));
  for (let i = 0; i < lines.length; ) {
    if (!candidate(lines[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    const n = lines[i].cells.length;
    const tol = lines[i].size * 0.75;
    const aligned = (a: PLine, b: PLine) =>
      a.boxes.every((box, c) => Math.abs(box.x - b.boxes[c].x) <= tol || Math.abs(box.right - b.boxes[c].right) <= tol);
    while (j < lines.length && candidate(lines[j]) && lines[j].cells.length === n && aligned(lines[i], lines[j])) j++;
    if (j - i >= 2) for (let k = i; k < j; k++) lines[k].row = true;
    i = j;
  }
}

/** Group text items into visual lines, keeping the content-stream order (which follows columns). */
function itemsToLines(items: TItem[]): PLine[] {
  const lines: PLine[] = [];
  let cur: TItem[] = [];
  const flush = () => {
    if (cur.some((i) => i.str.trim())) lines.push(makeLine(cur.filter((i) => i.str)));
    cur = [];
  };
  for (const it of items) {
    if (cur.length && it.str) {
      const last = cur[cur.length - 1];
      const dy = Math.abs(it.y - last.y);
      const tol = Math.max(1, Math.min(it.size, last.size) * 0.45);
      const backwards = it.x < last.x - last.size;
      if (dy > tol || (backwards && dy > 0.5)) flush();
    }
    if (it.str) cur.push(it);
    if (it.eol) flush();
  }
  flush();
  return lines;
}

/** Text repeated at the top/bottom of most pages (running headers, footers, page numbers). */
function furniture(pages: PdfPage[]): Set<PLine> {
  const drop = new Set<PLine>();
  const key = (l: PLine) => l.text.replace(/\d+/g, '#').toLowerCase();
  const counts = new Map<string, number>();
  // Only the outermost lines, and only when they sit in the top or bottom margin band.
  const edges: PLine[][] = pages.map((pg) => {
    if (!pg.lines.length) return [];
    const byY = [...pg.lines].sort((a, b) => b.y - a.y);
    const e = [byY[0], byY[byY.length - 1]];
    if (byY.length > 3) e.push(byY[1], byY[byY.length - 2]);
    const band = pg.height * 0.1;
    return [...new Set(e)].filter((l) => l.y > pg.height - band - l.size || l.y < band);
  });
  for (const e of edges) for (const k of new Set(e.map(key))) counts.set(k, (counts.get(k) ?? 0) + 1);
  const need = Math.max(3, Math.ceil(pages.length * 0.5));
  edges.forEach((e) => {
    for (const l of e) {
      const isPageNo = /^(page\s*)?#(\s*(of|\/)\s*#)?$/i.test(key(l).trim()) || /^[-–—]?\s*#\s*[-–—]?$/.test(key(l).trim());
      if (isPageNo || (pages.length >= 3 && (counts.get(key(l)) ?? 0) >= need)) drop.add(l);
    }
  });
  return drop;
}

interface Para {
  text: string;
  size: number;
  kind: 'p' | 'li' | 'h1' | 'h2' | 'h3' | 'row';
  cells?: string[];
}

// Includes the private-use glyphs Word's Symbol/Wingdings bullets come out as.
const BULLET = /^([•◦▪▫●○■□‣⁃∙·*]|[-–—](?=\s))\s*/;
const LIST_NUMBER = /^(\d{1,3}|[a-z]|[ivx]{1,5})[.)]$/i;
const ENDS_SENTENCE = /[.!?:;。！？”"')\]]$/;

/** Rebuild paragraphs, list items and headings from visual lines. */
function linesToParas(doc: PdfText): Para[] {
  const drop = furniture(doc.pages);
  const paras: Para[] = [];
  let cur: (Para & { last: PLine }) | null = null;
  const push = () => {
    if (cur && cur.text.trim()) paras.push({ text: cur.text.trim(), size: cur.size, kind: cur.kind });
    cur = null;
  };
  for (const page of doc.pages) {
    const pageRight = Math.max(0, ...page.lines.map((l) => l.right));
    detectTables(page.lines.filter((l) => !drop.has(l)));
    let firstOnPage = true;
    for (const line of page.lines) {
      if (drop.has(line)) continue;
      const bullet = BULLET.exec(line.text);
      const text = bullet ? line.text.slice(bullet[0].length) : line.text;
      if (!text) continue;
      if (line.row) {
        push();
        paras.push({ text: line.cells.join(' '), size: line.size, kind: 'row', cells: line.cells });
        firstOnPage = false;
        continue;
      }
      let fresh = true;
      if (cur) {
        const prev: PLine = (cur as any).last;
        const lh = Math.max(prev.size, line.size);
        if (firstOnPage) {
          // Carry a sentence over the page break.
          fresh = ENDS_SENTENCE.test(cur.text) || !/^[a-z(]/.test(text) || Math.abs(prev.size - line.size) > lh * 0.15;
        } else {
          const gap = prev.y - line.y;
          fresh =
            !!bullet ||
            gap < -lh * 0.5 ||
            gap > lh * 1.75 ||
            Math.abs(prev.size - line.size) > lh * 0.15 ||
            line.x - prev.x > lh * 1.2 ||
            (prev.right < pageRight - lh * 4 && ENDS_SENTENCE.test(prev.text));
        }
      }
      if (fresh) {
        push();
        cur = { text, size: line.size, kind: bullet ? 'li' : 'p', last: line };
      } else if (cur) {
        const c: Para & { last: PLine } = cur;
        if (/[a-z]-$/.test(c.text) && /^[a-z]/.test(text)) c.text = c.text.slice(0, -1) + text;
        else c.text += ' ' + text;
        c.last = line;
      }
      firstOnPage = false;
    }
  }
  push();

  // Body size = the size carrying the most characters; noticeably larger short paragraphs are headings.
  const weight = new Map<number, number>();
  for (const p of paras) weight.set(Math.round(p.size * 2) / 2, (weight.get(Math.round(p.size * 2) / 2) ?? 0) + p.text.length);
  const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const headingSizes = [...new Set(paras.filter((p) => isHeading(p, body)).map((p) => Math.round(p.size * 2) / 2))].sort((a, b) => b - a);
  for (const p of paras) {
    if (!isHeading(p, body)) continue;
    const rank = headingSizes.indexOf(Math.round(p.size * 2) / 2);
    p.kind = rank <= 0 ? 'h1' : rank === 1 ? 'h2' : 'h3';
  }
  return paras;
}

function isHeading(p: Para, body: number) {
  return p.kind === 'p' && p.size >= body * 1.18 && p.text.length <= 160 && !/[.,;]$/.test(p.text);
}

function parasToHtml(paras: Para[], title: string): string {
  const out: string[] = [];
  for (let i = 0; i < paras.length; ) {
    const p = paras[i];
    if (p.kind === 'li') {
      out.push('<ul>');
      for (; i < paras.length && paras[i].kind === 'li'; i++) out.push(`<li>${escapeHtml(paras[i].text)}</li>`);
      out.push('</ul>');
    } else if (p.kind === 'row') {
      const rows: string[][] = [];
      for (; i < paras.length && paras[i].kind === 'row'; i++) rows.push(paras[i].cells ?? [paras[i].text]);
      if (rows.length === 1) {
        out.push(`<p>${escapeHtml(rows[0].join(' '))}</p>`);
        continue;
      }
      const width = Math.max(...rows.map((r) => r.length));
      const tr = (r: string[], tag: string) => `<tr>${Array.from({ length: width }, (_, c) => `<${tag}>${escapeHtml(r[c] ?? '')}</${tag}>`).join('')}</tr>`;
      out.push(`<table><thead>${tr(rows[0], 'th')}</thead><tbody>${rows.slice(1).map((r) => tr(r, 'td')).join('')}</tbody></table>`);
    } else {
      out.push(`<${p.kind}>${escapeHtml(p.text)}</${p.kind}>`);
      i++;
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>\n${out.join('\n')}\n</body></html>`;
}

function parasToText(paras: Para[]): string {
  const out: string[] = [];
  paras.forEach((p, i) => {
    const text = p.kind === 'li' ? `• ${p.text}` : p.kind === 'row' ? (p.cells ?? [p.text]).join('\t') : p.text;
    // List items and table rows stay together; a blank line separates everything else.
    const tight = i > 0 && p.kind === paras[i - 1].kind && (p.kind === 'li' || p.kind === 'row');
    out.push((i === 0 || tight ? '' : '\n') + text);
  });
  return out.join('\n') + '\n';
}

function noTextError() {
  return new UserError("This PDF has no selectable text (it's probably a scan), so there's nothing to extract.");
}

// ------------------------------------------------------------- Ghostscript

const GS = () => join(binDir, 'gs', 'bin', 'gswin64c.exe');

async function pdfPageCount(input: string): Promise<number> {
  const doc = await openPdf(input);
  try {
    return doc.numPages;
  } finally {
    void doc.destroy();
  }
}

/** Rasterise PDF pages with Ghostscript. Returns the image paths in page order. */
async function renderPdf(
  input: string,
  outDir: string,
  fmt: 'png' | 'jpg',
  ctx: Ctx,
  prog: (f: number) => void,
  opts: { dpi?: number; prefix?: string; pages?: number } = {},
): Promise<string[]> {
  if (!existsSync(GS())) throw new UserError('The PDF renderer is missing. Reinstall Orange.');
  const n = opts.pages ?? (await pdfPageCount(input));
  const pad = Math.max(2, String(n).length);
  const prefix = opts.prefix ?? 'Page ';
  // Ghostscript expands %d in the output name, so escape any literal % in the path.
  // It can't open paths past MAX_PATH (260) without the \\?\ prefix.
  const longSafe = (p: string) => (p.length >= 240 ? toNamespacedPath(p) : p);
  const pattern = longSafe(join(outDir.replace(/%/g, '%%'), `${prefix.replace(/%/g, '%%')}%0${pad}d.${fmt}`));
  const dev = fmt === 'png' ? ['-sDEVICE=png16m'] : ['-sDEVICE=jpeg', '-dJPEGQ=92'];
  let done = 0;
  await run(
    GS(),
    [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      ...dev,
      `-r${opts.dpi ?? 300}`,
      '-dTextAlphaBits=4',
      '-dGraphicsAlphaBits=4',
      '-dUseCropBox',
      '-dNumRenderingThreads=4',
      `-sOutputFile=${pattern}`,
      longSafe(input),
    ],
    {
      signal: ctx.signal,
      onLine: (line) => {
        if (/^Page \d+/.test(line)) prog(++done / n);
      },
    },
  );
  const files: string[] = [];
  for (let i = 1; i <= n; i++) {
    const f = join(outDir, `${prefix}${String(i).padStart(pad, '0')}.${fmt}`);
    if (existsSync(f)) files.push(f);
  }
  if (!files.length) throw new UserError("Couldn't render this PDF.");
  return files;
}

/** Images of a PDF's pages: one file next to the PDF, or a folder for several pages. */
async function pdfToImages(input: string, fmt: 'png' | 'jpg', ctx: Ctx, a = 0.05): Promise<string[]> {
  const n = await pdfPageCount(input);
  if (n === 1) {
    const tmp = ctx.tmp();
    const [img] = await renderPdf(input, tmp, fmt, ctx, span(ctx, a, 0.95), { pages: 1 });
    const out = ctx.out(input, fmt);
    moveFile(img, out);
    return [out];
  }
  const dir = ctx.outDir(input);
  await removeOnFailure(dir, () => renderPdf(input, dir, fmt, ctx, span(ctx, a, 0.98), { pages: n }));
  return [dir];
}

/** A cancelled or failed multi-file export must not leave a half-filled output folder behind. */
async function removeOnFailure<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

// ------------------------------------------------------------ PDF → XLSX

/** Reconstructs tables from text positions: rows by baseline, columns by vertical whitespace. */
function pageToRows(page: PdfPage): string[][] {
  const items = page.items.filter((i) => i.str.trim());
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  // Rows.
  const rows: TItem[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) <= Math.max(1.5, Math.min(row[0].size, it.size) * 0.45)) row.push(it);
    else rows.push([it]);
  }
  // Cells: items close together on a row belong to one cell.
  type Cell = { text: string; x: number; right: number };
  const cellRows: Cell[][] = rows.map((r) => {
    r.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    let group: TItem[] = [];
    const flush = () => {
      if (!group.length) return;
      const last = group[group.length - 1];
      cells.push({ text: joinItems(group), x: group[0].x, right: last.x + last.w });
      group = [];
    };
    for (const it of r) {
      const prev = group[group.length - 1];
      if (prev && it.x - (prev.x + prev.w) > Math.max(it.size, prev.size) * 0.9) flush();
      group.push(it);
    }
    flush();
    return cells;
  });
  // Column separators = x ranges no multi-cell row covers.
  const tableRows = cellRows.filter((r) => r.length >= 2);
  const covered: [number, number][] = [];
  for (const r of tableRows) for (const c of r) covered.push([c.x, c.right]);
  covered.sort((a, b) => a[0] - b[0]);
  const seps: number[] = [];
  let reach = -Infinity;
  for (const [s, e] of covered) {
    if (reach > -Infinity && s - reach > 2) seps.push((s + reach) / 2);
    reach = Math.max(reach, e);
  }
  const colOf = (x: number) => {
    let c = 0;
    while (c < seps.length && x > seps[c]) c++;
    return c;
  };
  return cellRows.map((r) => {
    const out: string[] = [];
    for (const c of r) {
      const col = colOf(r.length >= 2 ? (c.x + c.right) / 2 : c.x);
      out[col] = out[col] ? `${out[col]} ${c.text}` : c.text;
    }
    return Array.from(out, (v) => v ?? '');
  });
}

function parseNumberish(s: string): { v: number; fmt?: string } | null {
  const t = s.trim();
  if (!t || t.length > 24) return null;
  const m = /^([-+]?)\(?([$€£¥₹]?)\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\)?(%?)$/.exec(t);
  if (!m) return null;
  const neg = m[1] === '-' || (t.startsWith('(') && t.endsWith(')'));
  if (/^0\d/.test(m[3]) && !m[4]) return null; // leading zeros: an ID, keep as text
  let v = Number(m[3].replace(/,/g, '') + (m[4] ?? ''));
  if (!Number.isFinite(v)) return null;
  if (neg) v = -v;
  const decimals = m[4] ? m[4].length - 1 : 0;
  if (m[5]) return { v: v / 100, fmt: decimals ? `0.${'0'.repeat(decimals)}%` : '0%' };
  if (m[3].includes(',')) return { v, fmt: decimals ? `#,##0.${'0'.repeat(decimals)}` : '#,##0' };
  return { v };
}

async function pdfToXlsx(input: string, ctx: Ctx): Promise<string[]> {
  const doc = await readPdfText(input, ctx, span(ctx, 0.05, 0.6));
  if (!doc.pages.some((p) => p.items.some((i) => i.str.trim()))) throw noTextError();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Orange';
  doc.pages.forEach((page, i) => {
    const rows = pageToRows(page);
    if (!rows.length) return;
    const ws = wb.addWorksheet(doc.pages.length === 1 ? 'Sheet1' : `Page ${i + 1}`);
    const widths: number[] = [];
    rows.forEach((r, ri) => {
      r.forEach((text, ci) => {
        if (!text) return;
        const cell = ws.getCell(ri + 1, ci + 1);
        const num = parseNumberish(text);
        if (num) {
          cell.value = num.v;
          if (num.fmt) cell.numFmt = num.fmt;
        } else cell.value = text;
        widths[ci] = Math.max(widths[ci] ?? 8, Math.min(60, text.length + 2));
      });
    });
    widths.forEach((w, ci) => (ws.getColumn(ci + 1).width = w));
  });
  if (!wb.worksheets.length) throw noTextError();
  ctx.progress(0.8);
  const out = ctx.out(input, 'xlsx');
  await wb.xlsx.writeFile(out);
  return [out];
}

// ------------------------------------------------------------ PDF → PPTX

const EMU_PER_PT = 12700;

/** A minimal, valid PowerPoint file with one full-bleed picture per slide. */
async function imagesToPptx(images: { file: string; wPt: number; hPt: number }[], out: string) {
  const first = images[0];
  let cx = Math.round(first.wPt * EMU_PER_PT);
  let cy = Math.round(first.hPt * EMU_PER_PT);
  const max = 51206400;
  const min = 914400;
  const k = Math.min(1, max / Math.max(cx, cy));
  cx = Math.max(min, Math.round(cx * k));
  cy = Math.max(min, Math.round(cy * k));

  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = (items: [string, string, string][]) =>
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
      .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
      .join('')}</Relationships>`;
  const emptyTree =
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

  const zip = new JSZip();
  const n = images.length;
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${Array.from(
      { length: n },
      (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    ).join('')}</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file(
    'docProps/core.xml',
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Orange</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  );
  zip.file(
    'docProps/app.xml',
    `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Orange</Application><Slides>${n}</Slides></Properties>`,
  );
  zip.file(
    'ppt/presentation.xml',
    `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${Array.from(
      { length: n },
      (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`,
    ).join('')}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'theme', 'theme/theme1.xml'],
      ...Array.from({ length: n }, (_, i) => [`rId${i + 3}`, 'slide', `slides/slide${i + 1}.xml`] as [string, string, string]),
    ]),
  );
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
  );
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'],
    ]),
  );
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  );
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file('ppt/theme/theme1.xml', THEME_XML);

  for (let i = 0; i < n; i++) {
    const img = images[i];
    // Fit each page inside the slide, centred (pages of a PDF can differ in size).
    const s = Math.min(cx / (img.wPt * EMU_PER_PT), cy / (img.hPt * EMU_PER_PT));
    const w = Math.round(img.wPt * EMU_PER_PT * s);
    const h = Math.round(img.hPt * EMU_PER_PT * s);
    const x = Math.round((cx - w) / 2);
    const y = Math.round((cy - h) / 2);
    const ext = extname(img.file).slice(1).toLowerCase() === 'png' ? 'png' : 'jpeg';
    zip.file(`ppt/media/image${i + 1}.${ext}`, readFileSync(img.file));
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `${XML}<p:sld ${NS}><p:cSld><p:spTree>${emptyTree}<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${i + 1}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      rels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'image', `../media/image${i + 1}.${ext}`],
      ]),
    );
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await writeFile(out, buf);
}

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Orange"><a:themeElements><a:clrScheme name="Orange"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B2A29"/></a:dk2><a:lt2><a:srgbClr val="EEECE8"/></a:lt2><a:accent1><a:srgbClr val="E8711A"/></a:accent1><a:accent2><a:srgbClr val="3E6E8E"/></a:accent2><a:accent3><a:srgbClr val="7A9A3A"/></a:accent3><a:accent4><a:srgbClr val="B8484F"/></a:accent4><a:accent5><a:srgbClr val="6B5B95"/></a:accent5><a:accent6><a:srgbClr val="C9A227"/></a:accent6><a:hlink><a:srgbClr val="1F5F99"/></a:hlink><a:folHlink><a:srgbClr val="7F4F99"/></a:folHlink></a:clrScheme><a:fontScheme name="Orange"><a:majorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Orange"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

async function pdfToPptxImages(input: string, ctx: Ctx, out: string) {
  const doc = await openPdf(input);
  const sizes: { w: number; h: number }[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const vp = (await doc.getPage(p)).getViewport({ scale: 1 });
      sizes.push({ w: vp.width, h: vp.height });
    }
  } finally {
    void doc.destroy();
  }
  const tmp = ctx.tmp();
  const files = await renderPdf(input, tmp, 'jpg', ctx, span(ctx, 0.1, 0.85), { dpi: 200, pages: sizes.length });
  await imagesToPptx(
    files.map((file, i) => ({ file, wPt: sizes[i].w, hPt: sizes[i].h })),
    out,
  );
}

// ----------------------------------------------------------- spreadsheets

/** Guess the delimiter of a CSV-ish text from its first lines. */
function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64_000).split(/\r\n|\n|\r/).slice(0, 30).filter((l) => l.trim());
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => {
      let n = 0;
      let q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === d && !q) n++;
      }
      return n;
    });
    const nonZero = counts.filter((c) => c > 0);
    if (!nonZero.length) continue;
    const mode = nonZero.sort((a, b) => nonZero.filter((x) => x === b).length - nonZero.filter((x) => x === a).length)[0];
    const consistent = counts.filter((c) => c === mode).length;
    const score = consistent * 100 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** RFC 4180 parser: quoted fields, doubled quotes, embedded newlines, any line ending. */
function parseDelimited(text: string, d: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === d) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function writeDelimited(rows: string[][], d: string): string {
  const q = (s: string) => (s.includes(d) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return '﻿' + rows.map((r) => r.map(q).join(d)).join('\r\n') + '\r\n';
}

function readDelimitedFile(input: string): string[][] {
  const text = decodeText(readFileSync(input));
  const d = extOf(input) === 'tsv' ? '\t' : sniffDelimiter(text);
  return parseDelimited(text, d);
}

/** CSV text → typed cell value: plain numbers become numbers, IDs with leading zeros stay text. */
function typedValue(s: string): string | number | boolean | null {
  if (s === '') return null;
  if (/^[-+]?(0|[1-9]\d{0,14})(\.\d+)?([eE][-+]?\d+)?$/.test(s)) {
    const v = Number(s);
    if (Number.isFinite(v)) return v;
  }
  if (/^(true|false)$/i.test(s)) return s.toUpperCase() === 'TRUE';
  return s;
}

function safeSheetName(s: string, used: Set<string>) {
  let name = (s.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31);
  const base = name;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

function rowsToWorkbook(sheets: { name: string; rows: string[][] }[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Orange';
  const used = new Set<string>();
  for (const s of sheets) {
    const ws = wb.addWorksheet(safeSheetName(s.name, used));
    const widths: number[] = [];
    for (const r of s.rows) {
      ws.addRow(r.map(typedValue));
      r.forEach((v, i) => (widths[i] = Math.max(widths[i] ?? 8, Math.min(50, v.length + 2))));
    }
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  }
  return wb;
}

function formatDate(d: Date): string {
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

function cellText(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(Number.isInteger(v) ? v : Number(v.toPrecision(15)));
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (v instanceof Date) return formatDate(v);
  if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text).join('');
  if ('result' in v || 'formula' in v || 'sharedFormula' in v) return cellText(v.result);
  if ('text' in v) return cellText(v.text);
  if ('error' in v) return String(v.error);
  return String(v);
}

/** Every (visible) worksheet as rows of display strings, trailing blanks trimmed. */
function workbookRows(wb: ExcelJS.Workbook): { name: string; rows: string[][] }[] {
  const visible = wb.worksheets.filter((ws) => ws.state === 'visible' || !ws.state);
  const sheets = (visible.length ? visible : wb.worksheets).map((ws) => {
    const rows: string[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const out: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = row.getCell(c);
        out.push(cell.isMerged && cell.master !== cell ? '' : cellText(cell.value));
      }
      while (out.length && out[out.length - 1] === '') out.pop();
      rows.push(out);
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    const width = Math.max(0, ...rows.map((r) => r.length));
    return { name: ws.name, rows: rows.map((r) => [...r, ...Array(width - r.length).fill('')]) };
  });
  return sheets;
}

async function loadXlsx(file: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(file);
  } catch (e: any) {
    if (/password|encrypt|zip/i.test(String(e?.message))) throw new UserError("This workbook can't be read. It may be password-protected or damaged.");
    throw e;
  }
  return wb;
}

/** Sheet data for any spreadsheet input (office suite used only for binary/foreign formats). */
async function readSheets(input: string, src: string, ctx: Ctx): Promise<{ name: string; rows: string[][] }[]> {
  if (src === 'csv' || src === 'tsv') return [{ name: stemOf(input), rows: readDelimitedFile(input) }];
  let xlsx = input;
  if (src !== 'xlsx') {
    xlsx = join(ctx.tmp(), 'book.xlsx');
    await viaOffice(input, xlsx, 'xlsx', ctx, { app: src === 'numbers' ? undefined : 'excel', what: `Reading ${src.toUpperCase()} files` }, 0.05, 0.6);
  }
  return workbookRows(await loadXlsx(xlsx));
}

async function writeSheetsAsText(input: string, sheets: { name: string; rows: string[][] }[], target: 'csv' | 'tsv', ctx: Ctx): Promise<string[]> {
  const d = target === 'csv' ? ',' : '\t';
  const nonEmpty = sheets.filter((s) => s.rows.length);
  const list = nonEmpty.length ? nonEmpty : sheets.slice(0, 1);
  if (list.length <= 1) {
    const out = ctx.out(input, target);
    await writeFile(out, writeDelimited(list[0]?.rows ?? [], d), 'utf8');
    return [out];
  }
  const dir = ctx.outDir(input);
  const used = new Set<string>();
  await removeOnFailure(dir, async () => {
    for (const s of list) {
      // Sheet names may hold characters file names can't (<>|"); the " 2" suffix goes on the cleaned name.
      const base = s.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'Sheet';
      let name = base;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} ${i}`;
      used.add(name.toLowerCase());
      await writeFile(join(dir, `${name}.${target}`), writeDelimited(s.rows, d), 'utf8');
    }
  });
  return [dir];
}

/** A plain OpenDocument spreadsheet (values only) for when no office suite is around. */
async function writeOds(sheets: { name: string; rows: string[][] }[], out: string) {
  const esc = (v: string) => escapeHtml(v).replace(/'/g, '&apos;');
  const used = new Set<string>();
  const tables = sheets
    .map((s) => {
      const width = Math.max(1, ...s.rows.map((r) => r.length));
      const rows = s.rows
        .map((r) => {
          const cells = r.map((raw) => {
            const v = typedValue(raw);
            if (v === null) return '<table:table-cell/>';
            if (typeof v === 'number') return `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${raw}</text:p></table:table-cell>`;
            if (typeof v === 'boolean') return `<table:table-cell office:value-type="boolean" office:boolean-value="${v}"><text:p>${raw}</text:p></table:table-cell>`;
            const date = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}:\d{2}))?$/.exec(raw);
            if (date) return `<table:table-cell office:value-type="date" office:date-value="${date[1]}${date[2] ? 'T' + date[2] : ''}"><text:p>${raw}</text:p></table:table-cell>`;
            return `<table:table-cell office:value-type="string">${raw.split(/\r?\n/).map((l) => `<text:p>${esc(l)}</text:p>`).join('')}</table:table-cell>`;
          });
          return `<table:table-row>${cells.join('') || '<table:table-cell/>'}</table:table-row>`;
        })
        .join('');
      return `<table:table table:name="${esc(safeSheetName(s.name, used))}"><table:table-column table:number-columns-repeated="${width}"/>${rows || '<table:table-row><table:table-cell/></table:table-row>'}</table:table>`;
    })
    .join('');
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
  );
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`,
  );
  await writeFile(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/vnd.oasis.opendocument.spreadsheet' }));
}

function sheetsToHtml(title: string, sheets: { name: string; rows: string[][] }[]): string {
  const multi = sheets.length > 1;
  const body = sheets
    .map((s) => {
      const rows = s.rows.map((r) => `<tr>${r.map((v) => `<td${/^[-+]?[\d.,]+%?$/.test(v) ? ' class="n"' : ''}>${escapeHtml(v)}</td>`).join('')}</tr>`).join('\n');
      return `${multi ? `<h2>${escapeHtml(s.name)}</h2>` : ''}<table>${rows}</table>`;
    })
    .join('\n');
  const css = `body{max-width:none;padding:0;font-size:9pt;line-height:1.35}table{border-collapse:collapse;margin-bottom:2em}td{border:1px solid #d9d6d1;padding:2px 6px;white-space:pre-wrap}td.n{text-align:right;font-variant-numeric:tabular-nums}tr:first-child td{background:#f3f1ee;font-weight:600}h2{font-size:12pt;margin:0 0 .6em}h2:not(:first-child){break-before:page}`;
  return htmlPage(title, body, css);
}

// ------------------------------------------------------------ the routes

async function fromPdf(input: string, target: string, ctx: Ctx): Promise<string[]> {
  const title = stemOf(input);
  switch (target) {
    case 'png':
    case 'jpg':
      return pdfToImages(input, target, ctx);

    case 'docx': {
      const out = ctx.out(input, 'docx');
      const route: OfficeRoute = {
        app: wordPdfReflowUsable() ? 'word' : undefined,
        infilter: 'writer_pdf_import',
        what: 'PDF to Word',
        timeoutMs: await reflowTimeout(input),
      };
      if (await officeCan(route)) {
        try {
          await viaOffice(input, out, 'docx', ctx, route);
          return [out];
        } catch (e) {
          // Whatever went wrong in the office suite, a clean text-structured DOCX beats no DOCX.
          if (ctx.signal.aborted) throw e;
          log('PDF→DOCX via office failed, rebuilding from text', e);
        }
      }
      // No office suite: rebuild the text structure and let pandoc write a clean DOCX.
      return pdfViaHtml(input, out, 'docx', ctx, title);
    }

    case 'pptx': {
      const out = ctx.out(input, 'pptx');
      const st = await officeStatus();
      if (st.libreoffice) {
        try {
          await libreConvert(input, out, LO_FILTER.pptx, { signal: ctx.signal, infilter: 'impress_pdf_import' });
          return [out];
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          log('LibreOffice PDF→PPTX failed, using page images', e);
        }
      }
      await pdfToPptxImages(input, ctx, out);
      return [out];
    }

    case 'xlsx':
      return pdfToXlsx(input, ctx);

    case 'epub': {
      const out = ctx.out(input, 'epub');
      const st = await officeStatus();
      if (st.word && wordPdfReflowUsable()) {
        // Word's reflow keeps headings, lists and images; pandoc packages them as an e-book.
        try {
          const docx = join(ctx.tmp(), 'reflow.docx');
          await officeConvert('word', input, docx, 'docx', { signal: ctx.signal, onProgress: span(ctx, 0.05, 0.75), timeoutMs: await reflowTimeout(input) });
          await pandocTo(docx, 'docx', out, 'epub', ctx, title);
          return [out];
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          log('Word PDF reflow failed, using text extraction', e);
        }
      }
      return pdfViaHtml(input, out, 'epub', ctx, title);
    }

    case 'txt': {
      const doc = await readPdfText(input, ctx, span(ctx, 0.05, 0.85));
      const paras = linesToParas(doc);
      if (!paras.length) throw noTextError();
      const out = ctx.out(input, 'txt');
      await writeFile(out, parasToText(paras), 'utf8');
      return [out];
    }

    case 'md': {
      const out = ctx.out(input, 'md');
      return pdfViaHtml(input, out, 'md', ctx, title);
    }
  }
  throw new UserError(`Can't convert PDF to ${target.toUpperCase()}.`);
}

/** Word's PDF reflow takes a few seconds a page; anything far beyond that is a hang. */
async function reflowTimeout(pdf: string): Promise<number> {
  const pages = await pdfPageCount(pdf).catch(() => 50);
  return Math.min(15 * 60_000, 60_000 + pages * 6_000);
}

/** PDF → structured HTML (headings, paragraphs, lists) → pandoc target. */
async function pdfViaHtml(input: string, out: string, target: string, ctx: Ctx, title: string): Promise<string[]> {
  const doc = await readPdfText(input, ctx, span(ctx, 0.05, 0.6));
  const paras = linesToParas(doc);
  if (!paras.length) throw noTextError();
  const html = join(ctx.tmp(), 'pdf.html');
  writeFileSync(html, parasToHtml(paras, doc.title ?? title));
  ctx.progress(0.7);
  return pandocTo(html, 'html', out, target, ctx, doc.title ?? title);
}

const RICH_DOC = new Set(['docx', 'doc', 'odt', 'rtf', 'pages']);
const PANDOC_DOC = new Set(['docx', 'odt', 'rtf', 'md', 'html', 'txt', 'epub']);

async function fromDocument(input: string, src: string, target: string, ctx: Ctx): Promise<string[]> {
  const title = stemOf(input);
  const out = ctx.out(input, target);
  const wordRoute: OfficeRoute = { app: src === 'pages' ? undefined : 'word', what: `Converting ${src.toUpperCase()} files` };

  // Rich source → rich target (or PDF): the office suite preserves layout, fonts and everything else.
  if (RICH_DOC.has(src) && ['pdf', 'docx', 'odt', 'rtf'].includes(target)) {
    if (await officeCan(wordRoute)) {
      try {
        await viaOffice(input, out, target, ctx, wordRoute);
        return [out];
      } catch (e) {
        if (!(e instanceof OfficeUnavailableError) || !PANDOC_DOC.has(src)) throw e;
      }
    }
    if (!PANDOC_DOC.has(src)) throw needOfficeError(wordRoute.what);
    // No office suite: pandoc for formats it understands.
    if (target === 'pdf') return printViaHtml(input, src, out, ctx, title);
    ctx.progress(0.2);
    return pandocTo(input, src, out, target, ctx, title);
  }

  // Text-like source → PDF: styled HTML printed by Chromium.
  if (target === 'pdf') return printViaHtml(input, src, out, ctx, title);

  // Everything else is pandoc's home turf; legacy/foreign formats go through DOCX first.
  let source = input;
  let from = src;
  if (!PANDOC_DOC.has(src)) {
    const docx = join(ctx.tmp(), `${title}.docx`);
    await viaOffice(input, docx, 'docx', ctx, wordRoute, 0.05, 0.6);
    source = docx;
    from = 'docx';
  }
  ctx.progress(0.65);
  return pandocTo(source, from, out, target, ctx, title);
}

async function printViaHtml(input: string, src: string, out: string, ctx: Ctx, title: string): Promise<string[]> {
  ctx.progress(0.1);
  const html = await toPrintableHtml(input, src, ctx, title);
  ctx.progress(0.5);
  await htmlToPdf(html, out, ctx);
  return [out];
}

async function fromEbook(input: string, target: string, ctx: Ctx): Promise<string[]> {
  const title = stemOf(input);
  const out = ctx.out(input, target);
  if (target === 'pdf') return printViaHtml(input, 'epub', out, ctx, title);
  ctx.progress(0.15);
  return pandocTo(input, 'epub', out, target, ctx, title);
}

async function fromSlides(input: string, src: string, target: string, ctx: Ctx): Promise<string[]> {
  const route: OfficeRoute = { app: src === 'key' ? undefined : 'powerpoint', what: 'Converting presentations' };
  if (target === 'pdf' || target === 'pptx') {
    const out = ctx.out(input, target);
    await viaOffice(input, out, target, ctx, route);
    return [out];
  }
  if (target === 'png' || target === 'jpg') {
    const st = await officeStatus();
    if (route.app && st.powerpoint) {
      try {
        const tmp = join(ctx.tmp(), 'slides');
        mkdirSync(tmp, { recursive: true });
        await officeConvert('powerpoint', input, tmp, target, { signal: ctx.signal, onProgress: span(ctx, 0.05, 0.95) });
        const files = readdirSync(tmp).filter((f) => f.toLowerCase().endsWith(`.${target}`)).sort();
        if (files.length === 1) {
          const out = ctx.out(input, target);
          moveFile(join(tmp, files[0]), out);
          return [out];
        }
        if (files.length > 1) {
          const dir = ctx.outDir(input);
          for (const f of files) moveFile(join(tmp, f), join(dir, f));
          return [dir];
        }
        throw new Error('PowerPoint exported no slides');
      } catch (e) {
        if (ctx.signal.aborted || !st.libreoffice) throw e;
        log('PowerPoint export failed, trying LibreOffice', e);
      }
    }
    // LibreOffice: slides → PDF → Ghostscript images.
    const pdf = join(ctx.tmp(), 'slides.pdf');
    await viaOffice(input, pdf, 'pdf', ctx, { ...route, app: undefined }, 0.05, 0.5);
    const n = await pdfPageCount(pdf);
    if (n === 1) {
      const [img] = await renderPdf(pdf, ctx.tmp(), target, ctx, span(ctx, 0.5, 0.95), { pages: 1, prefix: 'Slide ', dpi: 216 });
      const out = ctx.out(input, target);
      moveFile(img, out);
      return [out];
    }
    const dir = ctx.outDir(input);
    await removeOnFailure(dir, () => renderPdf(pdf, dir, target, ctx, span(ctx, 0.5, 0.98), { pages: n, prefix: 'Slide ', dpi: 216 }));
    return [dir];
  }
  throw new UserError(`Can't convert ${src.toUpperCase()} to ${target.toUpperCase()}.`);
}

async function fromSpreadsheet(input: string, src: string, target: string, ctx: Ctx): Promise<string[]> {
  const title = stemOf(input);
  const excelRoute: OfficeRoute = { app: src === 'numbers' ? undefined : 'excel', what: `Converting ${src.toUpperCase()} files` };
  const native = src === 'csv' || src === 'tsv';

  if (target === 'csv' || target === 'tsv') {
    const sheets = await readSheets(input, src, ctx);
    ctx.progress(0.8);
    return writeSheetsAsText(input, sheets, target, ctx);
  }

  if (target === 'xlsx') {
    const out = ctx.out(input, 'xlsx');
    if (native) {
      const wb = rowsToWorkbook([{ name: title, rows: readDelimitedFile(input) }]);
      ctx.progress(0.6);
      await wb.xlsx.writeFile(out);
      return [out];
    }
    await viaOffice(input, out, 'xlsx', ctx, excelRoute);
    return [out];
  }

  if (target === 'ods' || target === 'pdf') {
    const out = ctx.out(input, target);
    // CSV goes through a native XLSX first so delimiters and encodings are read correctly everywhere.
    let source = input;
    if (native) {
      source = join(ctx.tmp(), `${title}.xlsx`);
      await rowsToWorkbook([{ name: title, rows: readDelimitedFile(input) }]).xlsx.writeFile(source);
    }
    const route: OfficeRoute = native ? { app: 'excel', what: excelRoute.what } : excelRoute;
    // CSV/TSV/XLSX can be handled without an office suite (values only), others can't.
    const ownFallback = native || src === 'xlsx';
    if (!ownFallback || (await officeCan(route))) {
      try {
        await viaOffice(source, out, target, ctx, route, 0.1, 0.95);
        return [out];
      } catch (e) {
        if (!ownFallback || !(e instanceof OfficeUnavailableError)) throw e;
      }
    }
    if (target === 'ods') {
      await writeOds(await readSheets(source, 'xlsx', ctx), out);
      return [out];
    }
    // PDF without an office suite: print the sheets as tables.
    const sheets = await readSheets(source, 'xlsx', ctx);
    const html = join(ctx.tmp(), 'sheet.html');
    writeFileSync(html, sheetsToHtml(title, sheets));
    ctx.progress(0.5);
    const wide = Math.max(0, ...sheets.map((s) => s.rows[0]?.length ?? 0)) > 8;
    await htmlToPdf(html, out, ctx, { landscape: wide });
    return [out];
  }
  throw new UserError(`Can't convert ${src.toUpperCase()} to ${target.toUpperCase()}.`);
}

// ---------------------------------------------------------------- module

export const converter: ConverterModule = {
  kinds: ['pdf', 'document', 'slides', 'spreadsheet', 'ebook'],
  async convert(input, target, ctx) {
    const src = norm(extOf(input));
    const kind = kindOfExt(src);
    ctx.progress(0.02);
    let out: string[];
    switch (kind) {
      case 'pdf':
        out = await fromPdf(input, target, ctx);
        break;
      case 'document':
        out = await fromDocument(input, src, target, ctx);
        break;
      case 'ebook':
        out = await fromEbook(input, target, ctx);
        break;
      case 'slides':
        out = await fromSlides(input, src, target, ctx);
        break;
      case 'spreadsheet':
        out = await fromSpreadsheet(input, src, target, ctx);
        break;
      default:
        throw new UserError(`Can't convert ${basename(input)}.`);
    }
    ctx.progress(1);
    return out;
  },
};
