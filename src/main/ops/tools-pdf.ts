// PDF tools: merge, organize (reorder/rotate/duplicate/delete/insert) and split. pdf-lib does the
// page surgery; the windows render thumbnails themselves with pdf.js.
import { ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import type { Ctx, ToolFn } from './types';
import { UserError } from './types';

const stem = (p: string) => basename(p, extname(p));

export async function loadPdf(path: string): Promise<PDFDocument> {
  const bytes = await readFile(path);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e: any) {
    throw new UserError(`${basename(path)} isn't a readable PDF (${String(e?.message ?? e).slice(0, 80)}).`);
  }
  if (doc.isEncrypted) throw new UserError(`${basename(path)} is password-protected. Remove the protection first.`);
  return doc;
}

async function save(doc: PDFDocument, out: string) {
  await writeFile(out, await doc.save({ useObjectStreams: true }));
  return out;
}

function aborted(ctx: Ctx) {
  if (ctx.signal.aborted) throw new Error('Cancelled');
}

// ------------------------------------------------------------------- merge

interface MergeOptions {
  /** Files in the order to combine them. */
  order?: string[];
}

const mergePdf: ToolFn = async (inputs, ctx) => {
  const o = (ctx.options ?? {}) as MergeOptions;
  const order = (o.order?.length ? o.order : inputs).filter((p) => inputs.includes(p));
  if (order.length < 2) throw new UserError('Choose at least two PDFs to merge.');
  const out = await PDFDocument.create();
  for (let i = 0; i < order.length; i++) {
    aborted(ctx);
    ctx.progress(i / order.length, `Adding ${basename(order[i])}`);
    const src = await loadPdf(order[i]);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  ctx.progress(0.95, 'Saving');
  const first = order[0];
  return [await save(out, ctx.out(join(dirname(first), 'Merged'), 'pdf'))];
};

// ---------------------------------------------------------------- organize

interface PageRef {
  /** Source file (the original or an inserted PDF). */
  src: string;
  /** 0-based page index in that file. */
  index: number;
  /** Extra clockwise rotation in degrees (multiple of 90). */
  rotate?: number;
}

const organizePdf: ToolFn = async (inputs, ctx) => {
  const pages = (ctx.options?.pages ?? []) as PageRef[];
  if (!pages.length) throw new UserError('There are no pages left to save.');
  const docs = new Map<string, PDFDocument>();
  const out = await PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    aborted(ctx);
    const ref = pages[i];
    let src = docs.get(ref.src);
    if (!src) {
      src = await loadPdf(ref.src);
      docs.set(ref.src, src);
    }
    if (ref.index < 0 || ref.index >= src.getPageCount()) continue;
    const [page] = await out.copyPages(src, [ref.index]);
    const extra = (((ref.rotate ?? 0) % 360) + 360) % 360;
    if (extra) page.setRotation(degrees((page.getRotation().angle + extra) % 360));
    out.addPage(page);
    if (i % 10 === 0) ctx.progress(i / pages.length);
  }
  ctx.progress(0.95, 'Saving');
  return [await save(out, ctx.out(inputs[0], 'pdf', ' organized'))];
};

// -------------------------------------------------------------------- split

interface SplitOptions {
  /** Groups of 0-based page indices; each becomes one file. */
  groups: number[][];
  /** "extract" writes a single file next to the original instead of a folder. */
  mode?: 'every' | 'chunks' | 'ranges' | 'extract';
}

function pageLabel(group: number[]) {
  const sorted = [...group].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1) && sorted.join() === group.join();
  if (group.length === 1) return `p${group[0] + 1}`;
  if (contiguous) return `p${group[0] + 1}-${group[group.length - 1] + 1}`;
  if (group.length <= 6) return `p${group.map((i) => i + 1).join(',')}`;
  return `${group.length} pages`;
}

const splitPdf: ToolFn = async (inputs, ctx) => {
  const input = inputs[0];
  const o = (ctx.options ?? {}) as SplitOptions;
  const src = await loadPdf(input);
  const total = src.getPageCount();
  const groups = (o.groups ?? []).map((g) => g.filter((i) => Number.isInteger(i) && i >= 0 && i < total)).filter((g) => g.length);
  if (!groups.length) throw new UserError('Choose which pages to split out.');

  if (o.mode === 'extract' || groups.length === 1) {
    const doc = await PDFDocument.create();
    (await doc.copyPages(src, groups[0])).forEach((p) => doc.addPage(p));
    return [await save(doc, ctx.out(input, 'pdf', ` ${pageLabel(groups[0])}`))];
  }

  const dir = ctx.outDir(input, `${stem(input)} split`);
  const outputs: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    aborted(ctx);
    ctx.progress(i / groups.length, `Part ${i + 1} of ${groups.length}`);
    const doc = await PDFDocument.create();
    (await doc.copyPages(src, groups[i])).forEach((p) => doc.addPage(p));
    let name = `${stem(input)} ${pageLabel(groups[i])}`;
    if (used.has(name)) name = `${name} (${i + 1})`;
    used.add(name);
    outputs.push(await save(doc, join(dir, `${name}.pdf`)));
  }
  return outputs;
};

export const tools: Record<string, ToolFn> = { mergePdf, organizePdf, splitPdf };

// ------------------------------------------------------------- window IPC

ipcMain.handle('pdf:read', async (_e, path: string) => {
  if (extname(path).toLowerCase() !== '.pdf') throw new Error('Not a PDF');
  return new Uint8Array(await readFile(path));
});

/** Page count + protection check, used by the merge list before anything renders. */
ipcMain.handle('pdf:inspect', async (_e, path: string) => {
  try {
    const doc = await PDFDocument.load(await readFile(path), { ignoreEncryption: true, updateMetadata: false });
    return { pages: doc.getPageCount(), encrypted: doc.isEncrypted };
  } catch (e: any) {
    return { pages: 0, encrypted: false, error: String(e?.message ?? e) };
  }
});
