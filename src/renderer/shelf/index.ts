// Shelf window: a list of parked files. Drag items out (one, the selection, or all), drop more in,
// remove, clear, or collapse to a slim tab on the screen edge.
import { icon } from '../shared/icons';

declare const orange: import('../../preload/preload').OrangeApi;

interface Item {
  path: string;
  name: string;
  size: number;
  dir: boolean;
  missing?: boolean;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string | null)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null) el.append(c);
  return el;
};

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

let items: Item[] = [];
let collapsed = false;
const selected = new Set<string>();
let anchor: string | null = null;
const edge: string = (orange.args as any)?.edge ?? 'right';
document.documentElement.dataset.edge = edge;

// ------------------------------------------------------------------ skeleton

const count = h('span', { class: 'count' });
const head = h(
  'header',
  { class: 'head' },
  h('span', { class: 'title' }, 'Shelf'),
  count,
  h('span', { class: 'spacer' }),
  h('button', { class: 'ib', title: 'Collapse to the edge', 'aria-label': 'Collapse', html: chevron(), onclick: () => orange.send('shelf:collapse', true) }),
  h('button', { class: 'ib', title: 'Close the shelf (removes everything)', 'aria-label': 'Close', html: icon('close', 15), onclick: () => orange.send('shelf:clear') }),
);
const list = h('div', { class: 'list', role: 'listbox', 'aria-multiselectable': 'true' });
const dragAll = h('div', { class: 'drag-all', draggable: 'true', title: 'Drag everything on the shelf at once' }, h('span', { class: 'grip', html: icon('grip', 14) }), h('span', { class: 'drag-label' }, 'Drag all'));
const clear = h('button', { class: 'link', onclick: () => orange.send('shelf:clear') }, 'Clear');
const foot = h('footer', { class: 'foot' }, dragAll, clear);
const tab = h(
  'button',
  { class: 'tab', title: 'Show the shelf', 'aria-label': 'Show the shelf', onclick: () => orange.send('shelf:collapse', false) },
  h('span', { class: 'tab-icon', html: icon('float', 16) }),
  h('span', { class: 'tab-count' }),
  h('span', { class: 'tab-icon', html: chevron(true) }),
);
const panel = h('div', { class: 'panel' }, head, list, foot);
const dropHint = h('div', { class: 'drop-hint' }, h('span', { html: icon('plus', 20) }), h('span', {}, 'Drop to add'));
document.body.append(panel, tab, dropHint);

function chevron(inward = false) {
  // Points towards the screen edge the shelf collapses into (or away from it, to expand).
  const left = (edge === 'left') !== inward;
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${left ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'}"/></svg>`;
}

// ------------------------------------------------------------------- render

const rows = new Map<string, HTMLElement>();

function row(it: Item) {
  let el = rows.get(it.path);
  if (!el) {
    const img = h('img', { alt: '', draggable: 'false' }) as HTMLImageElement;
    const thumb = h('div', { class: 'thumb loading' }, img);
    orange.invoke<string>('shelf:thumb', it.path).then(
      (url) => {
        if (url) img.src = url;
        else thumb.innerHTML = icon(it.dir ? 'folder' : 'file', 22);
        thumb.classList.remove('loading');
      },
      () => thumb.classList.remove('loading'),
    );
    el = h(
      'div',
      { class: 'item', role: 'option', draggable: 'true', title: it.path, 'data-path': it.path },
      thumb,
      h('div', { class: 'text' }, h('span', { class: 'name' }, it.name), h('span', { class: 'meta' })),
      h('button', {
        class: 'ib remove',
        title: 'Remove from the shelf',
        'aria-label': 'Remove',
        html: icon('close', 13),
        onclick: (e: Event) => {
          e.stopPropagation();
          orange.send('shelf:remove', [it.path]);
        },
      }),
    );
    rows.set(it.path, el);
  }
  el.classList.toggle('on', selected.has(it.path));
  el.classList.toggle('missing', !!it.missing);
  el.setAttribute('aria-selected', String(selected.has(it.path)));
  el.querySelector('.meta')!.textContent = it.missing ? 'Moved or deleted' : it.dir ? 'Folder' : fmtBytes(it.size);
  return el;
}

function render() {
  const live = new Set(items.map((i) => i.path));
  for (const k of [...rows.keys()]) if (!live.has(k)) rows.delete(k);
  for (const k of [...selected]) if (!live.has(k)) selected.delete(k);
  const els = items.map(row);
  if (!(els.length === list.children.length && els.every((e, i) => list.children[i] === e))) list.replaceChildren(...els);
  if (!items.length) list.append(h('div', { class: 'empty' }, h('span', { html: icon('float', 26) }), h('span', {}, 'Drop files here to keep them handy.')));
  count.textContent = items.length ? String(items.length) : '';
  (tab.querySelector('.tab-count') as HTMLElement).textContent = String(items.length);
  dragAll.querySelector('.drag-label')!.textContent = selected.size > 1 ? `Drag ${selected.size} selected` : items.length > 1 ? `Drag all ${items.length}` : 'Drag';
  foot.hidden = !items.length;
  document.body.classList.toggle('collapsed', collapsed);
  reportHeight();
}

function reportHeight() {
  requestAnimationFrame(() => {
    const hgt = head.offsetHeight + Math.min(list.scrollHeight, 2000) + (foot.hidden ? 0 : foot.offsetHeight) + 2;
    orange.send('shelf:height', hgt);
  });
}

orange.on('shelf:items', (next: Item[], c: boolean) => {
  items = next;
  collapsed = c;
  render();
});
orange.on('shelf:collapsed', (c: boolean) => {
  collapsed = c;
  render();
});
orange.on('shelf:edge', (e: string) => {
  document.documentElement.dataset.edge = e;
});

// ----------------------------------------------------------------- selection

list.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.item');
  if (!el) {
    selected.clear();
    return render();
  }
  const p = el.dataset.path!;
  if (e.shiftKey && anchor) {
    const a = items.findIndex((i) => i.path === anchor);
    const b = items.findIndex((i) => i.path === p);
    if (!e.ctrlKey) selected.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(items[i].path);
  } else if (e.ctrlKey) {
    selected.has(p) ? selected.delete(p) : selected.add(p);
    anchor = p;
  } else {
    selected.clear();
    selected.add(p);
    anchor = p;
  }
  render();
});
list.addEventListener('dblclick', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.item');
  if (el) orange.send('shelf:open', el.dataset.path);
});
list.addEventListener('contextmenu', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.item');
  if (el) orange.send('shelf:reveal', el.dataset.path);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selected.size) orange.send('shelf:remove', [...selected]);
  } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    items.forEach((i) => selected.add(i.path));
    render();
  } else if (e.key === 'Escape') {
    selected.clear();
    render();
  }
});

// -------------------------------------------------------------- drag out

let draggingOut = false;
function startDrag(e: DragEvent, paths: string[]) {
  e.preventDefault(); // the OS drag below replaces the HTML one
  draggingOut = true;
  setTimeout(() => (draggingOut = false), 400);
  orange.send('shelf:drag', paths.filter((p) => !items.find((i) => i.path === p)?.missing));
}
list.addEventListener('dragstart', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.item');
  if (!el) return;
  const p = el.dataset.path!;
  const paths = selected.has(p) && selected.size > 1 ? items.filter((i) => selected.has(i.path)).map((i) => i.path) : [p];
  startDrag(e, paths);
});
dragAll.addEventListener('dragstart', (e) => {
  const paths = selected.size > 1 ? items.filter((i) => selected.has(i.path)).map((i) => i.path) : items.map((i) => i.path);
  startDrag(e, paths);
});

// ---------------------------------------------------------------- drop in

let depth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || draggingOut) return;
  depth++;
  document.body.classList.add('dropping');
  if (collapsed) orange.send('shelf:collapse', false);
});
window.addEventListener('dragleave', () => {
  depth = Math.max(0, depth - 1);
  if (!depth) document.body.classList.remove('dropping');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = draggingOut ? 'none' : 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  document.body.classList.remove('dropping');
  if (draggingOut) return;
  const paths = [...(e.dataTransfer?.files ?? [])].map((f) => orange.pathForFile(f)).filter(Boolean);
  if (paths.length) orange.send('shelf:add', paths);
});

render();
