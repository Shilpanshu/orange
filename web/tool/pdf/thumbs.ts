// Page thumbnails shared by the PDF windows.
//
// A window creates one loader for its scrolling list and registers each thumbnail box with
// watch(). Only boxes in or near the visible part of the list are rendered: the visible ones
// first, at the size they're shown (× devicePixelRatio), a few at a time. Boxes scrolled away
// lose their queued work, and boxes far away hand their image back so memory stays bounded.
// Each rendered page is kept as a blob URL that any number of <img>s can share (duplicated
// pages cost nothing extra); unused ones are dropped oldest-first.
import { isProtected, openPdf, renderPage, stopWorker, type PdfDoc } from './pdfjs';

export interface Thumb {
  url: string;
  /** width / height of the page as shown (its own /Rotate applied) */
  aspect: number;
}

// ------------------------------------------------------------------ documents

const docs = new Map<string, Promise<PdfDoc>>();

/** The one pdf.js document for `path` (opened on first use, shared by everything in the window). */
export function docFor(path: string): Promise<PdfDoc> {
  let d = docs.get(path);
  if (!d) {
    d = openPdf(path);
    docs.set(path, d);
    d.catch(() => {
      if (docs.get(path) === d) docs.delete(path);
    });
  }
  return d;
}

/** Closes the document for `path` and forgets its cached pages (e.g. a file removed from a list). */
export function closeDoc(path: string) {
  const d = docs.get(path);
  if (!d) return;
  docs.delete(path);
  for (const [key, e] of cache) {
    if (e.path === path && !e.users.size) {
      URL.revokeObjectURL(e.thumb.url);
      cache.delete(key);
    }
  }
  d.then((doc) => doc.destroy(), () => {});
}

/** Page count and protection, read with pdf.js (only the bytes it needs). */
export async function inspectPdf(path: string): Promise<{ pages: number; encrypted: boolean; error?: string }> {
  try {
    const doc = await docFor(path);
    return { pages: doc.numPages, encrypted: await isProtected(doc) };
  } catch (e: any) {
    if (e?.kind === 'encrypted') return { pages: 0, encrypted: true };
    return { pages: 0, encrypted: false, error: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------- bitmap cache

interface CacheEntry {
  path: string;
  thumb: Thumb;
  /** Boxes currently showing it. */
  users: Set<Element>;
}
const cache = new Map<string, CacheEntry>(); // insertion order = least recently used first
const inflight = new Map<string, Promise<Thumb>>();
/** Unused rendered pages kept around for scrolling back. */
const SPARE = 240;

function cacheKey(path: string, index: number, px: number) {
  return `${px}|${index}|${path}`;
}

function touch(key: string, e: CacheEntry) {
  cache.delete(key);
  cache.set(key, e);
}

function trimCache() {
  let spare = 0;
  for (const e of cache.values()) if (!e.users.size) spare++;
  for (const [key, e] of cache) {
    if (spare <= SPARE) break;
    if (e.users.size) continue;
    URL.revokeObjectURL(e.thumb.url);
    cache.delete(key);
    spare--;
  }
}

/** Device-pixel sizes thumbnails are rendered at; a box uses the smallest that covers it. */
const STEPS = [64, 96, 128, 160, 192, 256, 320, 384, 448, 512, 640, 768, 1024];
function stepFor(px: number) {
  return STEPS.find((s) => s >= px) ?? STEPS[STEPS.length - 1];
}

async function produce(path: string, index: number, px: number): Promise<Thumb> {
  const doc = await docFor(path);
  const canvas = await renderPage(doc, index + 1, px);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('render failed'))), 'image/jpeg', 0.9));
  // Release the canvas backing store now rather than at the next GC.
  const aspect = canvas.width / canvas.height;
  canvas.width = canvas.height = 0;
  return { url: URL.createObjectURL(blob), aspect };
}

// --------------------------------------------------------------------- loader

export interface ThumbLoaderOptions {
  /** The scrolling element the boxes live in. */
  root: HTMLElement;
  /** Longest side of a box in CSS px (read when a box is about to render). */
  side: () => number;
  /** Sizes the box's <img> for a page of `aspect` (width / height). */
  fit: (box: HTMLElement, img: HTMLImageElement, aspect: number) => void;
  /** Renders at once (default 4). */
  concurrency?: number;
}

interface Watch {
  path: string;
  index: number;
  img: HTMLImageElement;
  near: boolean;
  visible: boolean;
  /** cache key of what the box shows now */
  shown: string | null;
  state: 'idle' | 'queued' | 'running' | 'shown' | 'failed';
}

/** Lazily renders the thumbnail boxes of one scrolling list. See the top of the file. */
export function createThumbLoader(opts: ThumbLoaderOptions) {
  const watched = new Map<HTMLElement, Watch>();
  const queue = new Set<HTMLElement>();
  const max = opts.concurrency ?? 4;
  let active = 0;
  let dead = false;

  // `near`: the visible area plus a screen above and below, rendered ahead of time.
  // `visible`: rendered first. `keep`: boxes outside it give their image back.
  // `visible` is created first so its callback (which sets the priorities) runs before `near`'s.
  const visible = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const w = watched.get(e.target as HTMLElement);
      if (w) w.visible = e.isIntersecting;
    }
    pump();
  }, { root: opts.root });
  const near = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const w = watched.get(e.target as HTMLElement);
      if (!w) continue;
      w.near = e.isIntersecting;
      if (w.near) want(e.target as HTMLElement, w);
      else if (w.state === 'queued') {
        queue.delete(e.target as HTMLElement);
        w.state = w.shown ? 'shown' : 'idle';
      }
    }
    pump();
  }, { root: opts.root, rootMargin: '100% 0px' });
  const keep = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const w = watched.get(e.target as HTMLElement);
      if (w && !e.isIntersecting && w.state === 'shown') release(e.target as HTMLElement, w, true);
    }
    trimCache();
  }, { root: opts.root, rootMargin: '400% 0px' });

  const px = () => stepFor(Math.ceil(opts.side() * Math.min(3, window.devicePixelRatio || 1)));

  function show(box: HTMLElement, w: Watch, key: string, e: CacheEntry) {
    if (w.shown && w.shown !== key) cache.get(w.shown)?.users.delete(box);
    e.users.add(box);
    touch(key, e);
    w.shown = key;
    w.state = 'shown';
    if (w.img.getAttribute('src') !== e.thumb.url) w.img.src = e.thumb.url;
    box.classList.remove('skeleton', 'pf-thumb-bad');
    box.querySelector('.pf-thumb-msg')?.remove();
    opts.fit(box, w.img, e.thumb.aspect);
  }

  function release(box: HTMLElement, w: Watch, backToSkeleton: boolean) {
    if (w.shown) cache.get(w.shown)?.users.delete(box);
    w.shown = null;
    w.state = 'idle';
    if (backToSkeleton) {
      w.img.removeAttribute('src');
      box.classList.add('skeleton');
    }
  }

  function fail(box: HTMLElement, w: Watch) {
    w.state = 'failed';
    box.classList.remove('skeleton');
    box.classList.add('pf-thumb-bad');
    w.img.removeAttribute('src');
    if (!box.querySelector('.pf-thumb-msg')) {
      const msg = document.createElement('span');
      msg.className = 'pf-thumb-msg';
      msg.textContent = "Couldn't preview this page";
      box.append(msg);
    }
  }

  /** Box came into range: show from cache or queue a render. */
  function want(box: HTMLElement, w: Watch) {
    if (w.state === 'running' || w.state === 'failed' || w.state === 'queued') return;
    const key = cacheKey(w.path, w.index, px());
    if (w.state === 'shown' && w.shown === key) return;
    const hit = cache.get(key);
    if (hit) return show(box, w, key, hit);
    // A sharper copy is as good (zooming out); a blurrier one stays up until the new one is ready.
    if (w.state === 'shown' && w.shown && Number(w.shown.split('|')[0]) >= Number(key.split('|')[0])) return;
    w.state = 'queued';
    queue.add(box);
  }

  function next(): HTMLElement | undefined {
    let fallback: HTMLElement | undefined;
    for (const box of queue) {
      const w = watched.get(box)!;
      if (w.visible) return box;
      fallback ??= box;
    }
    return fallback;
  }

  function pump() {
    while (!dead && active < max && queue.size) {
      const box = next()!;
      queue.delete(box);
      const w = watched.get(box)!;
      const size = px();
      const key = cacheKey(w.path, w.index, size);
      const hit = cache.get(key);
      if (hit) {
        show(box, w, key, hit);
        continue;
      }
      w.state = 'running';
      active++;
      let job = inflight.get(key);
      if (!job) {
        job = produce(w.path, w.index, size);
        inflight.set(key, job);
        const j = job;
        j.then(
          (thumb) => {
            if (inflight.get(key) === j) inflight.delete(key);
            cache.set(key, { path: w.path, thumb, users: new Set() });
          },
          () => inflight.get(key) === j && inflight.delete(key),
        );
      }
      job
        .then(
          () => {
            const e = cache.get(key);
            if (dead || watched.get(box) !== w || !e) return;
            if (w.near || w.visible) show(box, w, key, e);
            else w.state = w.shown ? 'shown' : 'idle';
          },
          () => {
            if (!dead && watched.get(box) === w) fail(box, w);
          },
        )
        .finally(() => {
          active--;
          trimCache();
          pump();
        });
    }
  }

  return {
    /** Starts rendering page `index` (0-based) of `path` into `box` (which holds an <img>) when it nears the view. */
    watch(box: HTMLElement, path: string, index: number) {
      const img = box.querySelector('img')!;
      watched.set(box, { path, index, img, near: false, visible: false, shown: null, state: 'idle' });
      near.observe(box);
      visible.observe(box);
      keep.observe(box);
    },
    /** Stops tracking `box` (its card was removed). */
    unwatch(box: HTMLElement) {
      const w = watched.get(box);
      if (!w) return;
      if (w.shown) cache.get(w.shown)?.users.delete(box);
      queue.delete(box);
      watched.delete(box);
      near.unobserve(box);
      visible.unobserve(box);
      keep.unobserve(box);
    },
    /** Re-checks the wanted size after the boxes were resized (zoom). */
    refresh() {
      for (const [box, w] of watched) if (w.near) want(box, w);
      pump();
    },
    destroy() {
      dead = true;
      near.disconnect();
      visible.disconnect();
      keep.disconnect();
      watched.clear();
      queue.clear();
    },
  };
}

/** Frees every document, bitmap and the pdf.js worker (window teardown). */
export function closeAll() {
  for (const e of cache.values()) URL.revokeObjectURL(e.thumb.url);
  cache.clear();
  const all = [...docs.values()];
  docs.clear();
  Promise.allSettled(all.map((d) => d.then((doc) => doc.destroy()))).then(stopWorker);
}
addEventListener('pagehide', closeAll);

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
