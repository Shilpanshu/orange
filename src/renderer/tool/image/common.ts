// Shared pieces for the image tool windows: loading, export, history, keyboard, format picker,
// a fit-to-stage view transform and box handles used by crop / redact / annotate / frame.
import { h, extOf, loadImage, section, segmented, slider } from '../../shared/ui';

// ------------------------------------------------------------------ extra icons

const XP: Record<string, string> = {
  cursor: '<path d="M5 3l14 7-6 2-2 6z"/>',
  line: '<path d="M5 19L19 5"/>',
  flipH: '<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M9 7L3 17h6zM15 7l6 10h-6z"/>',
  flipV: '<path d="M3 12h18" stroke-dasharray="2 2.5"/><path d="M7 9L17 3v6zM7 15l10 6v-6z"/>',
  rotL: '<path d="M4 11a8 8 0 1 1 2.3 5.7"/><path d="M4 4v7h7"/>',
  rotR: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  compare: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/><path d="M12 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7z" fill="currentColor" opacity=".3" stroke="none"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>',
  textScan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 10h8M8 14h5"/>',
  faceScan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="11" r="3"/><path d="M8 17c1-2 7-2 8 0"/>',
  box: '<rect x="4" y="6" width="16" height="12" rx="1" fill="currentColor" stroke="none" opacity=".85"/>',
  blur: '<circle cx="8" cy="8" r="2"/><circle cx="16" cy="8" r="2" opacity=".6"/><circle cx="8" cy="16" r="2" opacity=".6"/><circle cx="16" cy="16" r="2" opacity=".35"/>',
  pixel: '<rect x="4" y="4" width="8" height="8" fill="currentColor" stroke="none" opacity=".8"/><rect x="12" y="12" width="8" height="8" fill="currentColor" stroke="none" opacity=".5"/><rect x="4" y="4" width="16" height="16"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
};

export function xicon(name: string, size = 18, stroke = 1.7): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${XP[name] ?? ''}</svg>`;
}

export function toolButton(svg: string, title: string, onClick: () => void, extra = '') {
  return h('button', { class: `btn icon ghost ${extra}`, title, 'aria-label': title, html: svg, onclick: onClick });
}

// ------------------------------------------------------------------ loading

/** Loads any supported image as an ImageBitmap with EXIF orientation applied. */
export async function loadBitmap(path: string, maxSide = 0): Promise<ImageBitmap> {
  const img = await loadImage(path);
  const w = img.naturalWidth || 1;
  const hh = img.naturalHeight || 1;
  const opts: ImageBitmapOptions = { imageOrientation: 'from-image', premultiplyAlpha: 'none' };
  if (maxSide && Math.max(w, hh) > maxSide) {
    const k = maxSide / Math.max(w, hh);
    opts.resizeWidth = Math.max(1, Math.round(w * k));
    opts.resizeHeight = Math.max(1, Math.round(hh * k));
    opts.resizeQuality = 'high';
  }
  return createImageBitmap(img, opts);
}

/** A screen-size preview plus the full (oriented) pixel size of the file. */
export async function loadPreview(path: string, maxSide = 2048): Promise<{ bmp: ImageBitmap; w: number; h: number }> {
  const img = await loadImage(path);
  const w = img.naturalWidth || 1;
  const hh = img.naturalHeight || 1;
  const opts: ImageBitmapOptions = { imageOrientation: 'from-image' };
  if (Math.max(w, hh) > maxSide) {
    const k = maxSide / Math.max(w, hh);
    opts.resizeWidth = Math.max(1, Math.round(w * k));
    opts.resizeHeight = Math.max(1, Math.round(hh * k));
    opts.resizeQuality = 'high';
  }
  return { bmp: await createImageBitmap(img, opts), w, h: hh };
}

/** A small thumbnail data source for lists. */
export async function thumbBitmap(path: string, side = 160) {
  return loadBitmap(path, side);
}

// ------------------------------------------------------------------ export

export type OutFormat = 'jpg' | 'png' | 'webp';

/** The format a renderer export should default to for a given source file. */
export function defaultFormat(path: string, fallback: OutFormat = 'jpg'): OutFormat {
  const e = extOf(path);
  if (['jpg', 'jpeg', 'jfif'].includes(e)) return 'jpg';
  if (e === 'png') return 'png';
  if (e === 'webp') return 'webp';
  if (['gif', 'bmp', 'ico', 'svg'].includes(e)) return 'png';
  return fallback;
}

const MIME: Record<OutFormat, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export async function canvasBytes(canvas: HTMLCanvasElement | OffscreenCanvas, fmt: OutFormat, quality = 0.92): Promise<Uint8Array> {
  let blob: Blob | null;
  if (canvas instanceof HTMLCanvasElement) {
    blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, MIME[fmt], fmt === 'png' ? undefined : quality));
  } else {
    blob = await canvas.convertToBlob({ type: MIME[fmt], quality: fmt === 'png' ? undefined : quality });
  }
  if (!blob) throw new Error('The image is too large to export.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** JPG has no transparency: put a background under a canvas before encoding. */
export function flatten(canvas: HTMLCanvasElement | OffscreenCanvas, color = '#ffffff') {
  const c = new OffscreenCanvas(canvas.width, canvas.height);
  const x = c.getContext('2d')!;
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(canvas, 0, 0);
  return c;
}

/** "Save as" section: JPG / PNG / WebP + quality. Returns a getter. */
export function formatSection(initial: OutFormat, onChange?: () => void) {
  const state = { fmt: initial, quality: 92 };
  const q = slider({
    label: 'Quality',
    min: 50,
    max: 100,
    value: 92,
    format: (v) => `${v}`,
    onInput: (v) => {
      state.quality = v;
      onChange?.();
    },
  });
  const sync = () => (q.style.display = state.fmt === 'png' ? 'none' : '');
  const seg = segmented(
    [
      { value: 'jpg', label: 'JPG' },
      { value: 'png', label: 'PNG' },
      { value: 'webp', label: 'WebP' },
    ],
    initial,
    (v) => {
      state.fmt = v as OutFormat;
      sync();
      onChange?.();
    },
  );
  sync();
  const el = section('Save as', h('div', { class: 'field' }, seg), q);
  return { el, get: () => ({ fmt: state.fmt, quality: state.quality / 100 }) };
}

// ------------------------------------------------------------------ history

export class History<T> {
  private stack: string[] = [];
  private idx = -1;
  constructor(initial: T, public onChange?: () => void) {
    this.stack = [JSON.stringify(initial)];
    this.idx = 0;
  }
  push(state: T) {
    const s = JSON.stringify(state);
    if (this.stack[this.idx] === s) return;
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push(s);
    if (this.stack.length > 200) this.stack.shift();
    this.idx = this.stack.length - 1;
    this.onChange?.();
  }
  undo(): T | null {
    if (this.idx <= 0) return null;
    this.idx--;
    this.onChange?.();
    return JSON.parse(this.stack[this.idx]);
  }
  redo(): T | null {
    if (this.idx >= this.stack.length - 1) return null;
    this.idx++;
    this.onChange?.();
    return JSON.parse(this.stack[this.idx]);
  }
  get canUndo() {
    return this.idx > 0;
  }
  get canRedo() {
    return this.idx < this.stack.length - 1;
  }
}

export const isTyping = (e: Event) => !!(e.target as HTMLElement)?.closest?.('input[type=text],input[type=number],textarea,[contenteditable]');

/** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y outside text fields. */
export function undoKeys(undo: () => void, redo: () => void) {
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || isTyping(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      redo();
    }
  });
}

// ------------------------------------------------------------------ view

/** Fits a w×h image into an element, centred with padding. Image px ⇄ element px. */
export class FitView {
  scale = 1;
  ox = 0;
  oy = 0;
  cw = 0;
  ch = 0;
  constructor(public w: number, public h: number, public pad = 24) {}
  fit(cw: number, ch: number) {
    this.cw = cw;
    this.ch = ch;
    const s = Math.min((cw - this.pad * 2) / this.w, (ch - this.pad * 2) / this.h);
    this.scale = Math.max(0.01, Math.min(s, 8));
    this.ox = (cw - this.w * this.scale) / 2;
    this.oy = (ch - this.h * this.scale) / 2;
  }
  toImg(x: number, y: number) {
    return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale };
  }
  toView(x: number, y: number) {
    return { x: x * this.scale + this.ox, y: y * this.scale + this.oy };
  }
}

/** A canvas filling `host` at device resolution; calls draw on resize. */
export function stageCanvas(host: HTMLElement, onResize: (w: number, h: number) => void) {
  const canvas = h('canvas', { class: 'ix-canvas' });
  host.append(canvas);
  const ctx = canvas.getContext('2d')!;
  let w = 0;
  let hh = 0;
  const ro = new ResizeObserver(() => {
    const r = host.getBoundingClientRect();
    w = Math.max(1, Math.floor(r.width));
    hh = Math.max(1, Math.floor(r.height));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hh}px`;
    onResize(w, hh);
  });
  ro.observe(host);
  return {
    canvas,
    ctx,
    get w() {
      return w;
    },
    get h() {
      return hh;
    },
    /** Reset to CSS-pixel coordinates. */
    begin() {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hh);
    },
  };
}

/** Coalesces redraw requests into one per frame. */
export function rafThrottle(fn: () => void) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

// ------------------------------------------------------------------ boxes

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

export const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move',
};

export function normRect(r: Rect): Rect {
  return {
    x: r.w < 0 ? r.x + r.w : r.x,
    y: r.h < 0 ? r.y + r.h : r.y,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

/** Which handle of rect `r` (view px) is under (x, y)? */
export function hitHandle(r: Rect, x: number, y: number, tol = 7, corners = true, edges = true): Handle | null {
  const pts: [Handle, number, number][] = [];
  if (corners) pts.push(['nw', r.x, r.y], ['ne', r.x + r.w, r.y], ['se', r.x + r.w, r.y + r.h], ['sw', r.x, r.y + r.h]);
  for (const [hd, px, py] of pts) if (Math.abs(x - px) <= tol && Math.abs(y - py) <= tol) return hd;
  if (edges) {
    if (Math.abs(y - r.y) <= tol && x > r.x && x < r.x + r.w) return 'n';
    if (Math.abs(y - (r.y + r.h)) <= tol && x > r.x && x < r.x + r.w) return 's';
    if (Math.abs(x - r.x) <= tol && y > r.y && y < r.y + r.h) return 'w';
    if (Math.abs(x - (r.x + r.w)) <= tol && y > r.y && y < r.y + r.h) return 'e';
  }
  if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'move';
  return null;
}

/**
 * Applies a handle drag (dx, dy in the rect's own units) to a start rect.
 * `aspect` (w/h) keeps the ratio while resizing. `bounds` clamps the result.
 */
export function dragRect(start: Rect, handle: Handle, dx: number, dy: number, aspect: number | null, bounds?: Rect, minSize = 4): Rect {
  let { x, y, w, h: hh } = start;
  if (handle === 'move') {
    x += dx;
    y += dy;
    if (bounds) {
      x = Math.min(Math.max(x, bounds.x), bounds.x + bounds.w - w);
      y = Math.min(Math.max(y, bounds.y), bounds.y + bounds.h - hh);
    }
    return { x, y, w, h: hh };
  }
  let l = x, t = y, r = x + w, b = y + hh;
  if (handle.includes('w')) l += dx;
  if (handle.includes('e')) r += dx;
  if (handle.includes('n')) t += dy;
  if (handle.includes('s')) b += dy;
  if (bounds) {
    l = Math.max(l, bounds.x);
    t = Math.max(t, bounds.y);
    r = Math.min(r, bounds.x + bounds.w);
    b = Math.min(b, bounds.y + bounds.h);
  }
  if (r - l < minSize) handle.includes('w') ? (l = r - minSize) : (r = l + minSize);
  if (b - t < minSize) handle.includes('n') ? (t = b - minSize) : (b = t + minSize);
  if (aspect) {
    let nw = r - l;
    let nh = b - t;
    const horizontal = handle === 'e' || handle === 'w';
    const vertical = handle === 'n' || handle === 's';
    if (horizontal) nh = nw / aspect;
    else if (vertical) nw = nh * aspect;
    else if (nw / nh > aspect) nh = nw / aspect;
    else nw = nh * aspect;
    // Fit inside bounds keeping the ratio.
    if (bounds) {
      const maxW = handle.includes('w') ? r - bounds.x : horizontal || vertical ? bounds.w : bounds.x + bounds.w - l;
      const maxH = handle.includes('n') ? b - bounds.y : horizontal || vertical ? bounds.h : bounds.y + bounds.h - t;
      const k = Math.min(1, maxW / nw, maxH / nh);
      nw *= k;
      nh *= k;
    }
    if (horizontal) {
      const cy = (start.y + start.y + start.h) / 2;
      t = cy - nh / 2;
      b = cy + nh / 2;
      if (bounds) {
        if (t < bounds.y) (b += bounds.y - t), (t = bounds.y);
        if (b > bounds.y + bounds.h) (t -= b - bounds.y - bounds.h), (b = bounds.y + bounds.h);
      }
      handle === 'w' ? (l = r - nw) : (r = l + nw);
    } else if (vertical) {
      const cx = (start.x + start.x + start.w) / 2;
      l = cx - nw / 2;
      r = cx + nw / 2;
      if (bounds) {
        if (l < bounds.x) (r += bounds.x - l), (l = bounds.x);
        if (r > bounds.x + bounds.w) (l -= r - bounds.x - bounds.w), (r = bounds.x + bounds.w);
      }
      handle === 'n' ? (t = b - nh) : (b = t + nh);
    } else {
      handle.includes('w') ? (l = r - nw) : (r = l + nw);
      handle.includes('n') ? (t = b - nh) : (b = t + nh);
    }
  }
  return { x: l, y: t, w: r - l, h: b - t };
}

/** Draws the eight square handles for a rect in view px. */
export function drawHandles(ctx: CanvasRenderingContext2D, r: Rect, accent: string, edges = true) {
  const pts = [
    [r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h],
  ];
  if (edges) pts.push([r.x + r.w / 2, r.y], [r.x + r.w, r.y + r.h / 2], [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h / 2]);
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = accent;
  ctx.fillStyle = '#ffffff';
  for (const [px, py] of pts) {
    ctx.beginPath();
    ctx.rect(Math.round(px) - 4.5, Math.round(py) - 4.5, 9, 9);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Pointer capture that tolerates synthetic or already-released pointers. */
export function capture(el: Element, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* not an active pointer */
  }
}

/** Colour swatches + a custom colour input. */
export function colorPicker(colors: string[], value: string, onChange: (c: string) => void) {
  const wrap = h('div', { class: 'ix-swatches' });
  const input = h('input', { type: 'color', value, title: 'Custom colour' }) as HTMLInputElement;
  const render = (v: string) => {
    wrap.querySelectorAll<HTMLButtonElement>('.ix-swatch').forEach((b) => b.classList.toggle('on', b.dataset.c === v.toLowerCase()));
    input.value = v;
  };
  for (const c of colors) {
    wrap.append(
      h('button', {
        class: 'ix-swatch',
        'data-c': c.toLowerCase(),
        title: c,
        'aria-label': `Colour ${c}`,
        style: { background: c },
        onclick: () => {
          render(c);
          onChange(c);
        },
      }),
    );
  }
  input.addEventListener('input', () => {
    render(input.value);
    onChange(input.value);
  });
  wrap.append(input);
  render(value);
  return Object.assign(wrap, { set: render });
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Plain-language summary of an image size. */
export const dims = (w: number, hh: number) => `${Math.round(w)} × ${Math.round(hh)}`;
