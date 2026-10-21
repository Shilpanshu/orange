// Small DOM helpers shared by tool windows. No framework: windows open fast.
import { icon } from './icons';

declare const orange: import('../../preload/preload').OrangeApi;
export const api = () => orange;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const dir = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
export const extOf = (p: string) => (/\.([^.\\/]+)$/.exec(p)?.[1] ?? '').toLowerCase();
export const fileUrl = (p: string) => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');

/** Standard tool window shell. Returns the regions to fill. */
export function shell(opts: { title: string; file?: string; layout?: 'split' | 'full' | 'stage'; wide?: boolean; plainStage?: boolean }) {
  document.body.innerHTML = '';
  const bar = h(
    'div',
    { class: 'titlebar' },
    h('img', { class: 'app-mark', src: '../../assets/icon-32.png', alt: '' }),
    h('h1', {}, opts.title),
    opts.file ? h('span', { class: 'file' }, opts.file) : null,
  );
  const main = h('div', { class: 'main' });
  const stage = h('div', { class: `stage${opts.plainStage ? ' plain' : ''}` });
  const panel = h('div', { class: `panel${opts.wide ? ' wide' : ''}` });
  const full = h('div', { class: 'full' });
  const layout = opts.layout ?? 'split';
  if (layout === 'full') main.append(full);
  else if (layout === 'stage') main.append(stage);
  else main.append(stage, panel);
  const status = h('span', { class: 'status' });
  const cancel = h('button', { class: 'btn', onclick: () => orange.send('window:close') }, 'Cancel');
  const primary = h('button', { class: 'btn primary' }, 'Save');
  const footer = h('div', { class: 'footer' }, status, h('div', { class: 'spacer' }), cancel, primary);
  document.body.append(bar, main, footer);
  document.title = opts.title;
  // Esc closes, Ctrl+Enter / Ctrl+S triggers the primary action.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input,textarea,select')) orange.send('window:close');
    if ((e.key === 'Enter' && e.ctrlKey) || (e.key.toLowerCase() === 's' && e.ctrlKey)) {
      e.preventDefault();
      primary.click();
    }
  });
  return { bar, main, stage, panel, full, footer, status, cancel, primary };
}

export function section(title: string | null, ...children: (Node | null | false)[]) {
  return h('div', { class: 'section' }, title ? h('h2', {}, title) : null, ...children);
}

export function field(label: string, control: Node, value?: HTMLOutputElement) {
  return h('div', { class: 'field' }, h('label', {}, h('span', {}, label), value ?? null), control);
}

export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}) {
  const out = h('output', {}) as HTMLOutputElement;
  const fmt = opts.format ?? ((v: number) => String(v));
  const input = h('input', { type: 'range', min: opts.min, max: opts.max, step: opts.step ?? 1 }) as HTMLInputElement;
  input.value = String(opts.value);
  out.textContent = fmt(opts.value);
  input.addEventListener('input', () => {
    out.textContent = fmt(Number(input.value));
    opts.onInput(Number(input.value));
  });
  // Double-click resets to the starting value.
  input.addEventListener('dblclick', () => {
    input.value = String(opts.value);
    input.dispatchEvent(new Event('input'));
  });
  const el = field(opts.label, input, out);
  return Object.assign(el, {
    set(v: number) {
      input.value = String(v);
      out.textContent = fmt(v);
    },
    input,
  });
}

export function segmented<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void) {
  const el = h('div', { class: 'seg' });
  const render = (v: T) => {
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  };
  for (const o of options) {
    el.append(
      h(
        'button',
        {
          'data-v': o.value,
          onclick: () => {
            render(o.value);
            onChange(o.value);
          },
        },
        o.label,
      ),
    );
  }
  render(value);
  return Object.assign(el, { set: render });
}

export function numberInput(value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; step?: number; suffix?: string } = {}) {
  const input = h('input', { type: 'number', min: opts.min, max: opts.max, step: opts.step ?? 1 }) as HTMLInputElement;
  input.value = String(value);
  input.addEventListener('change', () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = value;
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    input.value = String(v);
    onChange(v);
  });
  return input;
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void) {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check' }, input, h('span', {}, label));
}

export function iconButton(name: string, title: string, onClick: () => void, extra = '') {
  return h('button', { class: `btn icon ghost ${extra}`, title, 'aria-label': title, html: icon(name, 18), onclick: onClick });
}

export function fmtTime(sec: number, withMs = true) {
  if (!Number.isFinite(sec)) sec = 0;
  const s = Math.max(0, sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s % 1) * 1000);
  const core = `${hh ? hh + ':' : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
  return withMs ? `${core}.${String(ms).padStart(3, '0')}` : core;
}

export function parseTime(s: string): number | null {
  const m = /^\s*(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((x) => x !== undefined).map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

/** Makes a .list of .item rows reorderable by dragging. Calls back with the new index order. */
export function sortable(list: HTMLElement, onReorder: (from: number, to: number) => void) {
  let from = -1;
  list.addEventListener('dragstart', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.item');
    if (!item) return;
    from = [...list.children].indexOf(item);
    item.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const item = (e.target as HTMLElement).closest<HTMLElement>('.item');
    list.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
    item?.classList.add('over');
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const item = (e.target as HTMLElement).closest<HTMLElement>('.item');
    const to = item ? [...list.children].indexOf(item) : list.children.length - 1;
    if (from >= 0 && to >= 0 && from !== to) onReorder(from, to);
    from = -1;
  });
  list.addEventListener('dragend', () => {
    list.querySelectorAll('.dragging,.over').forEach((x) => x.classList.remove('dragging', 'over'));
  });
}

/** Run a tool in the main process; disables the button and closes the window on success. */
export async function runAndClose(button: HTMLButtonElement, toolId: string, paths: string[], options: any, status?: HTMLElement) {
  button.disabled = true;
  const prev = button.textContent;
  button.textContent = 'Working…';
  try {
    // The HUD shows progress; this window can go away immediately.
    const p = orange.invoke<string[]>('tool:run', toolId, paths, options);
    orange.send('window:close');
    await p;
  } catch (e: any) {
    button.disabled = false;
    button.textContent = prev;
    if (status) status.textContent = e?.message ?? String(e);
  }
}

/** Save image/video data produced in the renderer (canvas exports) through the main process. */
export function saveBytes(source: string, ext: string, suffix: string, bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return orange.invoke<string>('file:saveBytes', source, ext, suffix, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/** Load an image file into an HTMLImageElement (HEIC and other formats are decoded by the main process). */
export async function loadImage(path: string): Promise<HTMLImageElement> {
  const url = await orange.invoke<string>('image:previewUrl', path);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

export function args<T = any>(): T {
  return orange.args as T;
}
