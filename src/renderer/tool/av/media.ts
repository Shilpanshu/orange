// Shared pieces for the video and audio tool windows: media loading (with proxy fallback),
// a player with frame stepping, a timeline (thumbnails or waveform), time fields, a resizable
// rectangle over the video, and a few small helpers.
import { api, h, fmtTime, parseTime } from '../../shared/ui';
import { icon } from '../../shared/icons';

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  vcodec: string;
  acodec: string;
  sampleRate: number;
  channels: number;
  format: string;
  bitrate: number;
  audioBitrate: number;
  startTime: number;
}

export const probe = (p: string) => api().invoke<MediaInfo>('av:probe', p);
export const waveform = (p: string, buckets: number, channel?: number) => api().invoke<number[]>('av:waveform', p, buckets, channel);
export const thumbs = (p: string, count: number, height: number) => api().invoke<string[]>('av:thumbs', p, count, height);
export const keyframes = (p: string) => api().invoke<number[]>('av:keyframes', p);

// Small extra glyphs the shared icon set doesn't have (same 24px stroke style).
const EXTRA: Record<string, string> = {
  stepBack: '<path d="M6 5v14"/><path d="M18 5.5v13L9 12z" fill="currentColor" stroke="none"/>',
  stepFwd: '<path d="M18 5v14"/><path d="M6 5.5v13L15 12z" fill="currentColor" stroke="none"/>',
  marker: '<path d="M12 3v18"/><path d="M8 3h8l-4 4z" fill="currentColor"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  loop: '<path d="M4 12V9a3 3 0 0 1 3-3h11M15 3l3 3-3 3"/><path d="M20 12v3a3 3 0 0 1-3 3H6M9 21l-3-3 3-3"/>',
  speaker: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
};
export function glyph(name: string, size = 18) {
  if (!EXTRA[name]) return icon(name, size);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EXTRA[name]}</svg>`;
}
export function gbtn(name: string, title: string, onClick: () => void, cls = '') {
  return h('button', { class: `btn icon ghost ${cls}`, title, 'aria-label': title, html: glyph(name), onclick: onClick });
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const fmtDur = (s: number) => fmtTime(s, s < 60);
export const isTyping = (e: Event) => !!(e.target as HTMLElement)?.closest?.('input,textarea,select');

// ------------------------------------------------------------------ loading

/** Shows a skeleton over `host` while `el` gets a playable source (proxying if needed). */
export async function loadMedia(path: string, el: HTMLMediaElement, host: HTMLElement): Promise<boolean> {
  const cover = h('div', { class: 'av-loading' }, h('div', { class: 'skeleton av-skel' }), h('div', { class: 'av-loading-text' }, 'Loading preview…'));
  host.append(cover);
  const text = cover.querySelector('.av-loading-text') as HTMLElement;
  const off = api().on('av:preview-progress', (p: string, f: number) => {
    if (p === path) text.textContent = `Preparing a preview… ${Math.round(f * 100)}%`;
  });
  const attempt = async (force: boolean) => {
    const r = await api().invoke<{ url: string; proxy: boolean }>('av:preview', path, force);
    if (r.proxy) text.textContent = 'Preparing a preview…';
    await new Promise<void>((resolve, reject) => {
      const ok = () => (cleanup(), resolve());
      const bad = () => (cleanup(), reject(new Error('unplayable')));
      const cleanup = () => {
        el.removeEventListener('loadeddata', ok);
        el.removeEventListener('error', bad);
      };
      el.addEventListener('loadeddata', ok);
      el.addEventListener('error', bad);
      el.preload = 'auto';
      el.src = r.url;
    });
    return r.proxy;
  };
  try {
    try {
      await attempt(false);
    } catch {
      // Chromium couldn't play the original after all: make a proxy.
      text.textContent = 'Preparing a preview…';
      await attempt(true);
    }
    cover.remove();
    return true;
  } catch {
    cover.classList.add('failed');
    cover.querySelector('.skeleton')?.remove();
    text.textContent = 'Preview isn’t available for this file. You can still set exact times.';
    return false;
  } finally {
    off();
  }
}

// ------------------------------------------------------------------- player

export class Player {
  private subs = new Set<(t: number) => void>();
  private raf = 0;
  /** Pause automatically when playback reaches this time. */
  stopAt: number | null = null;
  constructor(
    public el: HTMLMediaElement,
    public duration: number,
    public fps = 30,
  ) {
    el.addEventListener('play', () => this.loop());
    el.addEventListener('pause', () => this.emit());
    el.addEventListener('seeked', () => this.emit());
    el.addEventListener('ended', () => this.emit());
  }
  get time() {
    return this.el.currentTime || 0;
  }
  get playing() {
    return !this.el.paused && !this.el.ended;
  }
  onTime(fn: (t: number) => void) {
    this.subs.add(fn);
    fn(this.time);
  }
  emit(t = this.time) {
    this.subs.forEach((f) => f(t));
  }
  private loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (this.stopAt !== null && this.time >= this.stopAt) {
        this.el.pause();
        this.seek(this.stopAt);
        this.stopAt = null;
      }
      this.emit();
      if (this.playing) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  seek(t: number) {
    t = clamp(t, 0, this.duration);
    if (Number.isFinite(t)) this.el.currentTime = t;
    this.emit(t);
  }
  play(from?: number, until?: number) {
    if (from !== undefined) this.seek(from);
    this.stopAt = until ?? null;
    if (this.time >= this.duration - 0.02) this.seek(0);
    void this.el.play().catch(() => {});
  }
  pause() {
    this.el.pause();
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  /** Frame index shown at time t. */
  frameAt(t = this.time) {
    return Math.floor(t * this.fps + 1e-4);
  }
  /** Shows frame n (seeks to the middle of the frame so decoders land on it reliably). */
  seekFrame(n: number) {
    const last = Math.max(0, Math.floor(this.duration * this.fps) - 1);
    n = clamp(n, 0, last);
    this.pause();
    this.seek((n + 0.5) / this.fps);
  }
  step(frames: number) {
    if (this.fps > 0) this.seekFrame(this.frameAt() + frames);
    else this.seek(this.time + frames * 0.05);
  }
}

/** Space, arrows (frame / Shift = 1 s), Home/End, plus tool keys (lowercase key names). */
export function bindKeys(player: Player, extra: Record<string, (e: KeyboardEvent) => void> = {}) {
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (extra[k]) {
      e.preventDefault();
      extra[k](e);
      return;
    }
    if (k === ' ') {
      e.preventDefault();
      player.toggle();
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const dir = k === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey || !player.fps) {
        player.pause();
        player.seek(player.time + dir);
      } else player.step(dir);
    } else if (k === 'Home') {
      player.pause();
      player.seek(0);
    } else if (k === 'End') {
      player.pause();
      player.seek(player.duration);
    }
  });
}

/** Play/pause, frame step, and a running timecode. */
export function transport(player: Player, opts: { frames?: boolean; steps?: boolean } = {}) {
  const play = h('button', { class: 'btn icon av-play', title: 'Play (Space)', 'aria-label': 'Play' });
  const sync = () => {
    play.innerHTML = glyph(player.playing ? 'pause' : 'play', 16);
    play.title = player.playing ? 'Pause (Space)' : 'Play (Space)';
  };
  player.el.addEventListener('play', sync);
  player.el.addEventListener('pause', sync);
  player.el.addEventListener('ended', sync);
  sync();
  play.addEventListener('click', () => player.toggle());
  const now = h('span', { class: 'time av-now' });
  const total = h('span', { class: 'time av-total' }, ` / ${fmtTime(player.duration)}`);
  const frame = h('span', { class: 'time av-frame-no' });
  player.onTime((t) => {
    now.textContent = fmtTime(t);
    if (opts.frames) frame.textContent = `Frame ${player.frameAt(t) + 1}`;
  });
  const steps =
    opts.steps !== false && player.fps
      ? [gbtn('stepBack', 'Previous frame (←)', () => player.step(-1)), gbtn('stepFwd', 'Next frame (→)', () => player.step(1))]
      : [];
  const el = h('div', { class: 'av-transport' }, play, ...steps, h('div', { class: 'av-clock' }, now, total), opts.frames ? frame : null, h('div', { class: 'spacer' }));
  return el;
}

// ------------------------------------------------------------------- layout

/** Keeps `frame` at the largest size with aspect w:h that fits inside `view`. */
export function fitFrame(view: HTMLElement, w: number, h_: number, pad = 16) {
  const frame = h('div', { class: 'av-frame' });
  view.append(frame);
  const fit = () => {
    const W = view.clientWidth - pad * 2;
    const H = view.clientHeight - pad * 2;
    if (W <= 0 || H <= 0 || !w || !h_) return;
    const s = Math.min(W / w, H / h_);
    frame.style.width = `${Math.floor(w * s)}px`;
    frame.style.height = `${Math.floor(h_ * s)}px`;
  };
  new ResizeObserver(fit).observe(view);
  fit();
  return Object.assign(frame, {
    setAspect(nw: number, nh: number) {
      w = nw;
      h_ = nh;
      fit();
    },
  });
}

/** The standard video tool stage: a view area with a fitted frame and a dock underneath. */
export function videoStage(stage: HTMLElement, info: MediaInfo) {
  stage.classList.add('av-stage');
  const view = h('div', { class: 'av-view' });
  const dock = h('div', { class: 'av-dock' });
  stage.append(view, dock);
  const frame = fitFrame(view, info.width || 16, info.height || 9);
  const video = h('video', { class: 'av-video', playsInline: true, disablePictureInPicture: true }) as HTMLVideoElement;
  frame.append(video);
  return { view, dock, frame, video };
}

// ------------------------------------------------------------------ timeline

export interface TimelineOpts {
  duration: number;
  kind: 'thumbs' | 'wave';
  tall?: boolean;
  /** Return true to take over a pointer-down on empty timeline space (e.g. drag to create a range). */
  onBackgroundDown?: (e: PointerEvent, t: number) => boolean;
}

export class Timeline {
  el: HTMLDivElement;
  layer: HTMLDivElement;
  canvas: HTMLCanvasElement;
  playhead: HTMLDivElement;
  ruler: HTMLDivElement;
  private seekFns = new Set<(t: number) => void>();
  private draw: (() => void) | null = null;
  constructor(public o: TimelineOpts) {
    this.canvas = h('canvas', {});
    this.layer = h('div', { class: 'av-layer' });
    this.playhead = h('div', { class: 'playhead' });
    this.el = h('div', { class: `timeline av-tl ${o.kind === 'wave' ? 'wave' : 'thumbs'} ${o.tall ? 'tall' : ''}` }, this.canvas, this.layer, this.playhead);
    this.ruler = h('div', { class: 'av-ruler' });
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    new ResizeObserver(() => {
      this.renderRuler();
      this.draw?.();
    }).observe(this.el);
  }
  get duration() {
    return this.o.duration;
  }
  pct(t: number) {
    return `${(clamp(t, 0, this.duration) / this.duration) * 100}%`;
  }
  timeAt(clientX: number) {
    const r = this.el.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * this.duration, 0, this.duration);
  }
  onSeek(fn: (t: number) => void) {
    this.seekFns.add(fn);
  }
  setTime(t: number) {
    this.playhead.style.left = this.pct(t);
  }
  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-drag]')) return;
    const t = this.timeAt(e.clientX);
    if (this.o.onBackgroundDown?.(e, t)) return;
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.add('scrubbing');
    const go = (ev: PointerEvent) => this.seekFns.forEach((f) => f(this.timeAt(ev.clientX)));
    go(e);
    const up = () => {
      this.el.removeEventListener('pointermove', go);
      this.el.classList.remove('scrubbing');
    };
    this.el.addEventListener('pointermove', go);
    this.el.addEventListener('pointerup', up, { once: true });
    this.el.addEventListener('pointercancel', up, { once: true });
  }

  /** Makes `handle` draggable along the timeline; onMove gets the pointer time. */
  drag(handle: HTMLElement, onMove: (t: number, e: PointerEvent, t0: number) => void, onEnd?: () => void) {
    handle.dataset.drag = '1';
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const t0 = this.timeAt(e.clientX);
      handle.classList.add('active');
      const move = (ev: PointerEvent) => onMove(this.timeAt(ev.clientX), ev, t0);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.classList.remove('active');
        onEnd?.();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
  }

  private renderRuler() {
    const w = this.el.clientWidth;
    if (!w) return;
    const d = this.duration;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => (s / d) * w >= 70) ?? 3600;
    this.ruler.innerHTML = '';
    for (let t = 0; t <= d + 1e-6; t += step) {
      if ((t / d) * w > w - 44) break; // no room for a label at the far right
      this.ruler.append(h('span', { style: { left: this.pct(t) } }, fmtTime(t, step < 1)));
    }
  }

  async thumbs(path: string, aspect: number) {
    this.el.classList.add('loading');
    const dpr = window.devicePixelRatio || 1;
    const H = this.el.clientHeight || 56;
    const count = Math.max(4, Math.min(40, Math.ceil(this.el.clientWidth / (H * aspect))));
    let urls: string[] = [];
    try {
      urls = await thumbs(path, count, Math.round(H * dpr));
    } catch {
      /* keep the plain track */
    }
    const imgs = await Promise.all(
      urls.map(
        (u) =>
          new Promise<HTMLImageElement | null>((res) => {
            if (!u) return res(null);
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = () => res(null);
            i.src = u;
          }),
      ),
    );
    this.draw = () => {
      const c = this.canvas;
      const W = this.el.clientWidth;
      const Hh = this.el.clientHeight;
      c.width = Math.round(W * dpr);
      c.height = Math.round(Hh * dpr);
      const g = c.getContext('2d')!;
      const slot = c.width / imgs.length;
      imgs.forEach((img, i) => {
        if (!img) return;
        // Cover-fit each thumbnail into its slot.
        const s = Math.max(slot / img.width, c.height / img.height);
        const sw = slot / s;
        const sh = c.height / s;
        g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, Math.round(i * slot), 0, Math.ceil(slot), c.height);
      });
    };
    this.draw();
    this.el.classList.remove('loading');
  }

  /** Draws a mirrored peak waveform. Peaks are normalised to the loudest point. */
  async wave(path: string, opts: { channel?: number; gain?: () => number } = {}) {
    this.el.classList.add('loading');
    let peaks: number[] = [];
    try {
      peaks = await waveform(path, 2000, opts.channel);
    } catch {
      /* keep the plain track */
    }
    const max = Math.max(1e-4, ...peaks);
    const dpr = window.devicePixelRatio || 1;
    this.draw = () => {
      const c = this.canvas;
      const W = this.el.clientWidth;
      const H = this.el.clientHeight;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, c.width, c.height);
      const css = getComputedStyle(this.el);
      g.fillStyle = css.getPropertyValue('--wave').trim() || '#8a8177';
      const mid = c.height / 2;
      const gain = opts.gain?.() ?? 1;
      const n = peaks.length;
      if (!n) return;
      const bar = Math.max(1, Math.round(dpr * 2));
      const gap = Math.round(dpr);
      for (let x = 0; x < c.width; x += bar + gap) {
        const a = Math.floor((x / c.width) * n);
        const b = Math.max(a + 1, Math.floor(((x + bar + gap) / c.width) * n));
        let m = 0;
        for (let i = a; i < b && i < n; i++) m = Math.max(m, peaks[i]);
        const v = Math.min(1, (m / max) * gain);
        const hh = Math.max(dpr, v * (c.height * 0.46));
        g.fillRect(x, mid - hh, bar, hh * 2);
      }
    };
    this.draw();
    this.el.classList.remove('loading');
  }
  redraw() {
    this.draw?.();
  }
}

/** Wraps a timeline with its time ruler underneath. */
export function timelineBlock(tl: Timeline) {
  return h('div', { class: 'av-tl-wrap' }, tl.el, tl.ruler);
}

/** A selection range (with two handles) on a timeline. */
export function rangeOnTimeline(tl: Timeline, get: () => [number, number], set: (a: number, b: number, which: 'start' | 'end' | 'both') => void) {
  const range = h('div', { class: 'range av-range' });
  const shadeL = h('div', { class: 'av-shade' });
  const shadeR = h('div', { class: 'av-shade' });
  const hs = h('div', { class: 'handle start', title: 'In point (I)' });
  const he = h('div', { class: 'handle end', title: 'Out point (O)' });
  tl.layer.append(shadeL, shadeR, range, hs, he);
  const min = Math.min(0.1, tl.duration / 10);
  tl.drag(hs, (t) => {
    const [, b] = get();
    set(Math.min(t, b - min), b, 'start');
  });
  tl.drag(he, (t) => {
    const [a] = get();
    set(a, Math.max(t, a + min), 'end');
  });
  // Dragging the body moves the whole selection.
  let a0 = 0;
  let b0 = 0;
  range.addEventListener('pointerdown', () => ([a0, b0] = get()), true);
  tl.drag(range, (t, _e, t0) => {
    const len = b0 - a0;
    const a = clamp(a0 + (t - t0), 0, tl.duration - len);
    set(a, a + len, 'both');
  });
  const render = () => {
    const [a, b] = get();
    range.style.left = tl.pct(a);
    range.style.width = `calc(${tl.pct(b)} - ${tl.pct(a)})`;
    hs.style.left = tl.pct(a);
    he.style.left = tl.pct(b);
    shadeL.style.left = '0';
    shadeL.style.width = tl.pct(a);
    shadeR.style.left = tl.pct(b);
    shadeR.style.right = '0';
  };
  render();
  return render;
}

// ---------------------------------------------------------------- time field

/** A timecode input (m:ss.mmm). Enter or blur commits; ↑/↓ nudge by `step` seconds. */
export function timeField(value: number, onCommit: (v: number) => void, opts: { step?: number; max?: number } = {}) {
  const input = h('input', { type: 'text', class: 'time av-timefield', spellcheck: false }) as HTMLInputElement;
  let cur = value;
  const show = (v: number) => {
    cur = v;
    if (document.activeElement !== input) input.value = fmtTime(v);
  };
  show(value);
  const commit = () => {
    const v = parseTime(input.value);
    if (v === null) {
      input.value = fmtTime(cur);
      input.classList.add('bad');
      setTimeout(() => input.classList.remove('bad'), 600);
      return;
    }
    const c = clamp(v, 0, opts.max ?? Infinity);
    input.value = fmtTime(c);
    cur = c;
    onCommit(c);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = fmtTime(cur);
      input.blur();
      e.stopPropagation();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = (opts.step ?? 0.1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      input.value = fmtTime(clamp(cur + d, 0, opts.max ?? Infinity));
      commit();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('focus', () => input.select());
  return Object.assign(input, { show });
}

// ------------------------------------------------------------- rect editor

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A movable, resizable rectangle in source pixels drawn over `frame` (which shows the whole
 * source at any scale). `aspect` (w/h) locks the shape when set.
 */
export class RectBox {
  el: HTMLDivElement;
  aspect: number | null = null;
  min = 16;
  private subs = new Set<(r: Rect) => void>();
  constructor(
    public frame: HTMLElement,
    public W: number,
    public H: number,
    public rect: Rect,
    cls = '',
  ) {
    this.el = h('div', { class: `av-rect ${cls}` });
    for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) this.el.append(h('div', { class: `av-grip ${d}`, 'data-dir': d }));
    frame.append(this.el);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.render();
  }
  onChange(fn: (r: Rect) => void) {
    this.subs.add(fn);
  }
  set(r: Rect, emit = true) {
    const w = clamp(Math.round(r.w), this.min, this.W);
    const h_ = clamp(Math.round(r.h), this.min, this.H);
    this.rect = { w, h: h_, x: clamp(Math.round(r.x), 0, this.W - w), y: clamp(Math.round(r.y), 0, this.H - h_) };
    this.render();
    if (emit) this.subs.forEach((f) => f(this.rect));
  }
  render() {
    const { x, y, w, h: hh } = this.rect;
    Object.assign(this.el.style, {
      left: `${(x / this.W) * 100}%`,
      top: `${(y / this.H) * 100}%`,
      width: `${(w / this.W) * 100}%`,
      height: `${(hh / this.H) * 100}%`,
    });
  }
  /** Source pixels per CSS pixel at the current display size. */
  scale() {
    return this.W / (this.frame.clientWidth || 1);
  }
  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const dir = (e.target as HTMLElement).dataset.dir ?? 'move';
    const start = { ...this.rect };
    const sx = e.clientX;
    const sy = e.clientY;
    const k = this.scale();
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.add('active');
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) * k;
      const dy = (ev.clientY - sy) * k;
      if (dir === 'move') return this.set({ ...start, x: start.x + dx, y: start.y + dy });
      let { x, y, w, h: hh } = start;
      if (dir.includes('e')) w = clamp(start.w + dx, this.min, this.W - start.x);
      if (dir.includes('s')) hh = clamp(start.h + dy, this.min, this.H - start.y);
      if (dir.includes('w')) {
        w = clamp(start.w - dx, this.min, start.x + start.w);
        x = start.x + start.w - w;
      }
      if (dir.includes('n')) {
        hh = clamp(start.h - dy, this.min, start.y + start.h);
        y = start.y + start.h - hh;
      }
      if (this.aspect) {
        const a = this.aspect;
        // Width leads for side/corner drags, height for top/bottom.
        if (dir === 'n' || dir === 's') w = hh * a;
        else hh = w / a;
        const maxW = Math.min(dir.includes('w') ? start.x + start.w : this.W - start.x, (dir.includes('n') ? start.y + start.h : this.H - start.y) * a);
        if (w > maxW) {
          w = maxW;
          hh = w / a;
        }
        if (dir.includes('w')) x = start.x + start.w - w;
        if (dir.includes('n')) y = start.y + start.h - hh;
        if (dir === 'n' || dir === 's') x = start.x + (start.w - w) / 2;
        if (dir === 'e' || dir === 'w') y = start.y + (start.h - hh) / 2;
      }
      this.set({ x, y, w, h: hh });
    };
    const up = () => {
      this.el.removeEventListener('pointermove', move);
      this.el.classList.remove('active');
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up, { once: true });
    this.el.addEventListener('pointercancel', up, { once: true });
  }
}

/** Largest rect with aspect a (w/h) centred in W×H. */
export function fitAspect(W: number, H: number, a: number): Rect {
  let w = W;
  let hh = w / a;
  if (hh > H) {
    hh = H;
    w = hh * a;
  }
  return { x: (W - w) / 2, y: (H - hh) / 2, w, h: hh };
}

// ------------------------------------------------------------------- misc

export function kbdHints(rows: [string, string][]) {
  return h('div', { class: 'av-keys' }, ...rows.map(([k, label]) => h('div', {}, h('span', { class: 'kbd' }, k), h('span', {}, label))));
}

export function stat(label: string, value: string | Node) {
  return h('div', { class: 'av-stat' }, h('span', {}, label), typeof value === 'string' ? h('strong', {}, value) : value);
}

export function describeVideo(info: MediaInfo) {
  const parts = [fmtDur(info.duration)];
  if (info.hasVideo) parts.push(`${info.width}×${info.height}`, `${Math.round(info.fps * 100) / 100} fps`);
  if (!info.hasAudio) parts.push('no audio');
  return parts.join(' · ');
}
