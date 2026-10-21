// Lazily rendered page thumbnails shared by the PDF windows. Each page renders once into a blob
// URL that any number of <img> elements can show (duplicated pages cost nothing extra).
import { openPdf, renderThumb, type PdfDoc } from './pdfjs';

export interface Thumb {
  url: string;
  /** width / height of the unrotated page */
  aspect: number;
}

const docs = new Map<string, Promise<PdfDoc>>();
const cache = new Map<string, Promise<Thumb>>();

export function docFor(path: string): Promise<PdfDoc> {
  let d = docs.get(path);
  if (!d) {
    d = openPdf(path);
    docs.set(path, d);
    d.catch(() => docs.delete(path));
  }
  return d;
}

/** Thumbnail of page `index` (0-based) of `path`. */
export function thumb(path: string, index: number, width = 200, priority = false): Promise<Thumb> {
  const key = `${path}#${index}@${width}`;
  let t = cache.get(key);
  if (!t) {
    t = docFor(path).then(async (doc) => {
      const canvas = await renderThumb(doc, index + 1, width, priority);
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('render failed'))), 'image/png'));
      return { url: URL.createObjectURL(blob), aspect: canvas.width / canvas.height };
    });
    cache.set(key, t);
    t.catch(() => cache.delete(key));
  }
  return t;
}

/** Calls `load` the first time `el` scrolls near the viewport. */
const pending = new WeakMap<Element, () => void>();
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      pending.get(e.target)?.();
      pending.delete(e.target);
    }
  },
  { rootMargin: '400px' },
);
export function whenVisible(el: Element, load: () => void) {
  pending.set(el, load);
  io.observe(el);
}

/**
 * Fits a page image into a box, honouring an extra rotation. The <img> keeps the page's own
 * proportions and is rotated with a transform, so it is sized with width/height swapped for
 * quarter turns.
 */
export function fitRotated(img: HTMLImageElement, aspect: number, rotate: number, boxW: number, boxH: number) {
  const quarter = ((rotate / 90) % 2 + 2) % 2 === 1;
  const shownAspect = quarter ? 1 / aspect : aspect;
  let w = boxW;
  let h = w / shownAspect;
  if (h > boxH) {
    h = boxH;
    w = h * shownAspect;
  }
  // Unrotated element size
  const ew = quarter ? h : w;
  const eh = quarter ? w : h;
  img.style.width = `${ew}px`;
  img.style.height = `${eh}px`;
  img.style.transform = `rotate(${rotate}deg)`;
}

export function pdfBlurb(pages: number) {
  return `${pages} page${pages === 1 ? '' : 's'}`;
}
