// Shared pieces for the AI tool windows: model status and time estimates, first-use download
// progress, and a before/after compare view with a draggable divider.
import { api, h, section } from '../../shared/ui';

export interface AiStatus {
  models: { id: string; label: string; mb: number; ready: boolean; licence: string }[];
  downloadMB: number;
  device: 'dml' | 'cpu';
  ms: number;
  files: { path: string; w: number; h: number; pages?: number; todo?: number; units: number }[];
  note?: string;
}

export const aiStatus = (tool: string, paths: string[], options: unknown) => api().invoke<AiStatus>('ai:status', tool, paths, options);

/** "under a second", "about 8 s", "about 3 min", "about 1 h 10 min". */
export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return 'under a second';
  if (s < 60) return `about ${Math.max(1, Math.round(s))} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} min`;
  return `about ${Math.floor(m / 60)} h ${m % 60} min`;
}

export const fmtMB = (mb: number) => `${Math.max(1, Math.round(mb))} MB`;

/** Subscribe to first-use download / preview progress from the main process. */
export function onAiProgress(fn: (fraction: number, note?: string) => void): () => void {
  return api().on('ai:progress', (p: { fraction: number; note?: string }) => fn(p.fraction, p.note));
}

/** The "Model" panel section: where it runs, how long it will take, the one-time download, licence. */
export function modelSection(credit: string) {
  const where = h('div', { class: 'ai-kv' });
  const time = h('div', { class: 'ai-kv' });
  const dl = h('div', { class: 'ai-kv' });
  const lic = h('p', { class: 'hint ai-licence' }, credit);
  const el = section('Model', where, time, dl, lic);
  const row = (host: HTMLElement, k: string, v: string, tone = '') => host.replaceChildren(h('span', {}, k), h('strong', { class: tone }, v));
  return {
    el,
    update(st: AiStatus, timeLabel = 'Time') {
      row(where, 'Runs on', st.device === 'dml' ? 'Graphics chip' : 'Processor');
      row(time, timeLabel, st.ms > 0 ? fmtDuration(st.ms) : '–');
      if (st.downloadMB > 0) row(dl, 'First use', `Downloads ${fmtMB(st.downloadMB)} once`, 'ai-warn');
      else row(dl, 'Status', 'Ready, works offline', 'ai-ok');
    },
  };
}

/** A progress card for the stage (download or first preview). */
export function progressCard(title: string) {
  const bar = h('div', { class: 'ai-bar' }, h('div', { class: 'ai-bar-fill' }));
  const note = h('div', { class: 'ai-card-note' }, 'Starting…');
  const el = h('div', { class: 'ai-card' }, h('strong', {}, title), bar, note);
  return {
    el,
    set(f: number, text?: string) {
      (bar.firstChild as HTMLElement).style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
      if (text) note.textContent = text;
    },
  };
}

/** A card explaining a one-time download, with a button to start it. */
export function downloadCard(opts: { title: string; body: string; mb: number; credit: string; onStart: () => void }) {
  const btn = h('button', { class: 'btn primary', onclick: () => opts.onStart() }, `Download (${fmtMB(opts.mb)})`);
  return h(
    'div',
    { class: 'ai-card' },
    h('strong', {}, opts.title),
    h('p', {}, opts.body),
    h('div', { class: 'ai-card-actions' }, btn),
    h('p', { class: 'ai-card-note' }, opts.credit),
  );
}

/**
 * Before/after view. Both images are laid over each other at the same size; the "after" layer
 * (with its own backdrop, so transparency doesn't reveal the "before" image) is clipped by the
 * divider. Drag anywhere on the image, or use the arrow keys when it has focus.
 */
export function compareView(host: HTMLElement) {
  const before = h('img', { class: 'ai-cmp-img', alt: 'Before', draggable: false });
  const after = h('img', { class: 'ai-cmp-img', alt: 'After', draggable: false });
  const back = h('div', { class: 'ai-cmp-after checker' }, after);
  const line = h('div', { class: 'ai-cmp-line' }, h('div', { class: 'ai-cmp-knob' }));
  const tagB = h('span', { class: 'ai-tag left' }, 'Before');
  const tagA = h('span', { class: 'ai-tag right' }, 'After');
  const box = h('div', { class: 'ai-cmp', tabindex: 0, role: 'slider', 'aria-label': 'Before and after divider', 'aria-valuemin': 0, 'aria-valuemax': 100 }, before, back, line, tagB, tagA);
  host.append(box);
  let pos = 50;
  let nw = 1;
  let nh = 1;
  let pixelated = false;
  const place = () => {
    back.style.clipPath = `inset(0 0 0 ${pos}%)`;
    line.style.left = `${pos}%`;
    box.setAttribute('aria-valuenow', String(Math.round(pos)));
  };
  const fit = () => {
    const r = host.getBoundingClientRect();
    const k = Math.min((r.width - 48) / nw, (r.height - 48) / nh, pixelated ? 8 : 1);
    box.style.width = `${Math.max(40, Math.floor(nw * k))}px`;
    box.style.height = `${Math.max(40, Math.floor(nh * k))}px`;
  };
  new ResizeObserver(fit).observe(host);
  const fromEvent = (e: PointerEvent) => {
    const r = box.getBoundingClientRect();
    pos = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    place();
  };
  box.addEventListener('pointerdown', (e) => {
    try {
      box.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    fromEvent(e);
  });
  box.addEventListener('pointermove', (e) => {
    if (box.hasPointerCapture?.(e.pointerId)) fromEvent(e);
  });
  box.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') pos = Math.max(0, pos - step);
    else if (e.key === 'ArrowRight') pos = Math.min(100, pos + step);
    else return;
    e.preventDefault();
    place();
  });
  place();
  return {
    el: box,
    /** Show a pair; w/h is the pair's natural size. `upscale` lets small crops grow to fill. */
    set(b: string, a: string, w: number, hh: number, opts: { upscale?: boolean } = {}) {
      nw = Math.max(1, w);
      nh = Math.max(1, hh);
      pixelated = !!opts.upscale;
      before.src = b;
      after.src = a;
      box.hidden = false;
      fit();
    },
    /** The backdrop behind the "after" image: null for the transparency checkerboard. */
    backdrop(color: string | null) {
      back.classList.toggle('checker', !color);
      back.style.background = color ?? '';
    },
    busy(on: boolean) {
      box.classList.toggle('busy', on);
    },
    hide() {
      box.hidden = true;
    },
  };
}

/** Debounces a function (trailing call). */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Human message for an IPC error (strips Electron's "Error invoking remote method" prefix). */
export function errText(e: any): string {
  const m = String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (/network|fetch|ENOTFOUND|ERR_INTERNET|ERR_NAME/i.test(m)) return "Orange couldn't download the model. Check your internet connection and try again.";
  if (/Cancelled|AbortError/i.test(m)) return 'Cancelled.';
  return m.replace(/^UserError: /, '');
}
