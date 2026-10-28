// Small DOM helpers shared by tool windows. No framework: windows open fast.
import { icon } from './icons';
import { TOOLS } from '../../shared/catalog';

declare const orange: import('../../shared/orange-api').OrangeApi;
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

// Any text cut short with an ellipsis shows its full value as a tooltip on hover, so long file
// names stay readable everywhere without every list having to remember a title attribute.
document.addEventListener(
  'mouseover',
  (e) => {
    let el = e.target as HTMLElement | null;
    for (let i = 0; el && i < 3; i++, el = el.parentElement) {
      if (el.hasAttribute('title') && !el.dataset.autoTitle) return;
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis') {
        el.title = el.textContent ?? '';
        el.dataset.autoTitle = '1';
        return;
      }
      if (el.dataset.autoTitle) {
        el.removeAttribute('title');
        delete el.dataset.autoTitle;
      }
    }
  },
  { passive: true },
);

export const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
// A file dropped where the page doesn't take drops is ignored cleanly (no-drop cursor, nothing
// happens). Pages that accept drops handle them on their own elements first and call
// preventDefault, which this window-level fallback leaves alone.
window.addEventListener('dragover', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (e) => {
  if (!e.defaultPrevented) e.preventDefault();
});

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
    opts.file ? h('span', { class: 'file', title: opts.file }, opts.file) : null,
  );
  const main = h('div', { class: 'main' });
  const stage = h('div', { class: `stage${opts.plainStage ? ' plain' : ''}` });
  const panel = h('div', { class: `panel${opts.wide ? ' wide' : ''}` });
  const full = h('div', { class: 'full' });
  const layout = opts.layout ?? 'split';
  if (layout === 'full') main.append(full);
  else if (layout === 'stage') main.append(stage);
  else main.append(stage, panel);
  const status = h('span', { class: 'status', role: 'status' });
  // The status line is clamped to two lines; the full text stays available as a tooltip.
  new MutationObserver(() => {
    status.title = (status.textContent ?? '').length > 60 ? (status.textContent ?? '') : '';
  }).observe(status, { childList: true, characterData: true, subtree: true });
  const cancel = h('button', { class: 'btn', onclick: () => orange.send('window:close') }, 'Cancel');
  const primary = h('button', { class: 'btn primary' }, 'Save');
  const footer = h('div', { class: 'footer' }, status, presetSlot(primary, status), h('div', { class: 'spacer' }), cancel, primary);
  document.body.append(bar, main, footer);
  document.title = opts.title;
  // Esc closes, Ctrl+Enter / Ctrl+S triggers the primary action.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      // A field with something typed in it gives up focus first, so a half-typed value isn't lost;
      // the next Esc closes the window.
      const field = (e.target as HTMLElement).closest<HTMLInputElement | HTMLTextAreaElement>('input:not([type=range]):not([type=checkbox]),textarea');
      if (field && field.value) field.blur();
      else orange.send('window:close');
    }
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
  const el = h('div', { class: 'seg', role: 'group' });
  const render = (v: T) => {
    el.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === v);
      b.setAttribute('aria-pressed', String(b.dataset.v === v));
    });
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
    // Without an explicit step the value is a count or a pixel size: "2.5 parts" or a
    // 1080.4 px width would reach the tool as a fraction.
    if (opts.step === undefined) v = Math.round(v);
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    input.value = String(v);
    value = v; // a cleared or invalid entry falls back to the last good value, not the first
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
  // "Save as preset" clicks the primary button to read the options without running anything.
  if (capturing) return capturing(toolId, options);
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

// ------------------------------------------------------------------ presets
// "Save as preset…" in the footer stores the window's current options under a name; the preset
// then appears on the Tools wheel. Tools whose options don't depend on one particular file get
// the link automatically: the link presses the primary button with runAndClose switched into a
// capture mode, so no tool page needs changing. Other pages can opt in with enablePresets().

/** Tools whose runAndClose options make sense for any file of the right kind. */
const PRESET_TOOLS = new Set(['speedVideo', 'normalizeAudio', 'audioChannels', 'joinAudio', 'audioToVideo', 'cropImage', 'createPdf']);

let capturing: ((toolId: string, options: unknown) => void) | null = null;
let presetState: { slot: HTMLElement; primary: HTMLButtonElement; status: HTMLElement; tool: string; get?: () => unknown } | null = null;

function presetSlot(primary: HTMLButtonElement, status: HTMLElement) {
  const slot = h('div', { class: 'preset-slot', hidden: true });
  const tool = String((orange.args as { tool?: string }).tool ?? '');
  presetState = { slot, primary, status, tool };
  if (PRESET_TOOLS.has(tool)) showPresetLink();
  return slot;
}

/** Shows "Save as preset…" for a page that gathers its options itself (not via runAndClose). */
export function enablePresets(toolId: string, getOptions: () => unknown) {
  if (!presetState) return;
  presetState.tool = toolId;
  presetState.get = getOptions;
  showPresetLink();
}

function injectPresetStyles() {
  if (document.getElementById('preset-styles')) return;
  const css = `
.preset-slot{display:flex;align-items:center;gap:6px;min-width:0;flex:none}
.preset-slot[hidden]{display:none}
.preset-slot .preset-link{color:var(--accent-strong);font-weight:500}
.preset-slot input[type='text']{width:170px;height:26px;font-size:12px}
.preset-slot .btn.small.icon{width:26px;padding:0;color:var(--ink-2)}
.preset-slot .preset-note{color:var(--ink-2);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.preset-slot .preset-note.bad{color:var(--danger)}`;
  document.head.append(h('style', { id: 'preset-styles' }, css));
}

function showPresetLink(note?: { text: string; bad?: boolean }) {
  const st = presetState;
  if (!st) return;
  injectPresetStyles();
  st.slot.hidden = false;
  st.status.hidden = false;
  const link = h('button', { class: 'btn small ghost preset-link', title: 'Keep these settings as a slice on the Tools wheel', onclick: () => void startNaming() }, 'Save as preset…');
  st.slot.replaceChildren(link);
  if (note) {
    const n = h('span', { class: `preset-note${note.bad ? ' bad' : ''}`, role: 'status' }, note.text);
    st.slot.replaceChildren(n);
    setTimeout(() => {
      if (n.isConnected) st.slot.replaceChildren(link);
    }, 2600);
  }
}

/** The options the window would run with right now. */
function currentOptions(): Promise<unknown> {
  const st = presetState!;
  if (st.get) return Promise.resolve(st.get());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      capturing = null;
      reject(new Error('Not ready yet'));
    }, 800);
    capturing = (toolId, options) => {
      clearTimeout(timer);
      if (toolId) st.tool = toolId;
      capturing = null;
      resolve(options);
    };
    st.primary.click();
  });
}

async function startNaming() {
  const st = presetState;
  if (!st) return;
  let options: unknown;
  try {
    options = JSON.parse(JSON.stringify(await currentOptions()));
  } catch {
    return showPresetLink({ text: 'Set the options first', bad: true });
  }
  const label = TOOLS.find((t) => t.id === st.tool)?.label ?? 'Preset';
  const name = h('input', { type: 'text', maxlength: 60, placeholder: 'Preset name', 'aria-label': 'Preset name' }) as HTMLInputElement;
  name.value = label;
  const save = h('button', { class: 'btn small' }, 'Save') as HTMLButtonElement;
  const cancel = h('button', { class: 'btn small icon ghost', title: "Don't save", 'aria-label': "Don't save the preset", html: icon('close', 18) });
  const commit = async () => {
    const n = name.value.trim();
    if (!n) return name.focus();
    save.disabled = true;
    try {
      await orange.invoke('presets:save', { name: n, tool: st.tool, options, paths: (orange.args as { paths?: string[] }).paths ?? [] });
      showPresetLink({ text: `Saved “${n}” to the Tools wheel` });
    } catch (e: any) {
      save.disabled = false;
      showPresetLink({ text: e?.message ?? "Couldn't save the preset", bad: true });
    }
  };
  save.onclick = commit;
  cancel.onclick = () => showPresetLink();
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      showPresetLink();
    }
  });
  // Room for the name field: the status text comes back afterwards.
  st.status.hidden = true;
  st.slot.replaceChildren(name, save, cancel);
  name.focus();
  name.select();
}
