// pdf.js, loaded on demand from dist/vendor/pdfjs (copied there by scripts/build.mjs) so the
// tool bundle stays small for every other tool. Renders page thumbnails through a small queue.
import { api } from '../../shared/ui';

type PdfJs = any;
export type PdfDoc = { numPages: number; getPage(n: number): Promise<any>; destroy(): Promise<void> };

let lib: Promise<PdfJs> | null = null;

function vendorUrl(file: string) {
  return new URL(`../../vendor/pdfjs/${file}`, location.href).href;
}

export function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = import(/* @vite-ignore */ vendorUrl('pdf.min.mjs')).then((m: any) => {
      m.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.mjs');
      return m;
    });
  }
  return lib;
}

export class PdfError extends Error {
  constructor(
    message: string,
    public kind: 'encrypted' | 'broken',
  ) {
    super(message);
  }
}

/** Bytes of a file via the main process (file:// fetches are not allowed here). */
export function readBytes(path: string): Promise<Uint8Array> {
  return api().invoke<Uint8Array>('pdf:read', path);
}

export async function openPdf(path: string): Promise<PdfDoc> {
  const [m, data] = await Promise.all([pdfjs(), readBytes(path)]);
  try {
    return await m.getDocument({ data, isEvalSupported: false, disableFontFace: false }).promise;
  } catch (e: any) {
    if (e?.name === 'PasswordException') throw new PdfError('This PDF is password-protected. Remove the password first.', 'encrypted');
    throw new PdfError(`Couldn't read this PDF (${e?.message ?? e}).`, 'broken');
  }
}

// ------------------------------------------------------------------ thumbnails

interface Job {
  doc: PdfDoc;
  page: number; // 1-based
  width: number;
  resolve: (c: HTMLCanvasElement) => void;
  reject: (e: unknown) => void;
}
const queue: Job[] = [];
let active = 0;
const MAX_ACTIVE = 3;

/** Renders page `page` (1-based) to a canvas `width` CSS px wide (HiDPI aware). */
export function renderThumb(doc: PdfDoc, page: number, width: number, priority = false): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const job = { doc, page, width, resolve, reject };
    if (priority) queue.unshift(job);
    else queue.push(job);
    pump();
  });
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift()!;
    active++;
    draw(job)
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function draw({ doc, page, width }: Job) {
  const p = await doc.getPage(page);
  const base = p.getViewport({ scale: 1 });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const scale = (width * dpr) / base.width;
  const vp = p.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  p.cleanup?.();
  return canvas;
}

/** Page sizes (points) without rendering, for layout before thumbnails arrive. */
export async function pageAspect(doc: PdfDoc, page: number): Promise<number> {
  const p = await doc.getPage(page);
  const v = p.getViewport({ scale: 1 });
  return v.width / v.height;
}
