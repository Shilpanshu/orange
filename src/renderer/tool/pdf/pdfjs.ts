// pdf.js, loaded on demand from dist/vendor/pdfjs (copied there by scripts/build.mjs) so the
// tool bundle stays small for every other tool. Every document in the window shares one pdf.js
// worker, and big files are read in ranges (only the bytes a thumbnail needs cross IPC).
import { api } from '../../shared/ui';

type PdfJs = any;
export type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<any>;
  getPermissions(): Promise<number[] | null>;
  destroy(): Promise<void>;
};

let lib: Promise<PdfJs> | null = null;
let worker: any = null;

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

/** One pdf.js worker thread for every document this window opens (pdf.js starts one per document otherwise). */
function sharedWorker(m: PdfJs) {
  if (!worker || worker.destroyed) worker = new m.PDFWorker({ name: 'orange-pdf' });
  return worker;
}

/** Stops the shared worker (window teardown). Documents must be destroyed first. */
export function stopWorker() {
  worker?.destroy();
  worker = null;
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

/** Files up to this size are read in one go; bigger ones are read in ranges as pdf.js asks. */
const WHOLE_FILE = 4 * 1024 * 1024;
const OPEN_TIMEOUT = 30_000;

function timeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error('timed out'));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function openPdf(path: string): Promise<PdfDoc> {
  const [m, { size }] = await Promise.all([pdfjs(), api().invoke<{ size: number }>('file:stat', path)]);
  let source: Record<string, unknown>;
  let task: any = null;
  if (size <= WHOLE_FILE) {
    source = { data: await readBytes(path) };
  } else {
    const range = new m.PDFDataRangeTransport(size, null);
    range.requestDataRange = (begin: number, end: number) => {
      api()
        .invoke<Uint8Array>('pdf:range', path, begin, end)
        .then(
          (chunk) => range.onDataRange(begin, chunk),
          // The file went away or can't be read any more: fail the document instead of hanging.
          () => task?.destroy(),
        );
    };
    source = { range, rangeChunkSize: 256 * 1024, disableAutoFetch: true, disableStream: true };
  }
  task = m.getDocument({
    ...source,
    worker: sharedWorker(m),
    isEvalSupported: false,
    disableFontFace: false,
    // Copied by scripts/build.mjs: fonts for PDFs that don't embed them, and the JPEG 2000 decoder.
    standardFontDataUrl: vendorUrl('standard_fonts/'),
    wasmUrl: vendorUrl('wasm/'),
  });
  try {
    return await timeout<PdfDoc>(task.promise, OPEN_TIMEOUT, () => task.destroy());
  } catch (e: any) {
    if (e?.name === 'PasswordException') throw new PdfError('This PDF is password-protected. Remove the password first.', 'encrypted');
    throw new PdfError(`Couldn't read this PDF (${e?.message ?? e}).`, 'broken');
  }
}

/**
 * True when the file has an /Encrypt dictionary, even one that opens without a password (an
 * owner password). pdf-lib, which writes the results, refuses those files, so the windows do too.
 */
export async function isProtected(doc: PdfDoc): Promise<boolean> {
  try {
    return (await doc.getPermissions()) !== null;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ rendering

const RENDER_TIMEOUT = 15_000;

/**
 * Renders page `page` (1-based) so its longer side is `longSide` device pixels, with the page's
 * own /Rotate applied. Rejects after a timeout so a pathological page can't hold a slot forever.
 */
export async function renderPage(doc: PdfDoc, page: number, longSide: number): Promise<HTMLCanvasElement> {
  let task: any = null;
  let timedOut = false;
  const work = (async () => {
    const p = await doc.getPage(page);
    if (timedOut) return null as never;
    const base = p.getViewport({ scale: 1 });
    const scale = longSide / Math.max(base.width, base.height, 1);
    const vp = p.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    task = p.render({ canvasContext: ctx, canvas, viewport: vp });
    try {
      await task.promise;
    } finally {
      p.cleanup?.();
    }
    return canvas;
  })();
  return timeout(work, RENDER_TIMEOUT, () => {
    timedOut = true;
    task?.cancel?.();
  });
}
