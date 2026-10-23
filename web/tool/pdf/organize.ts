// Organize a PDF: a grid of pages to reorder (drag), rotate, duplicate, delete and insert into.
// Nothing touches the file until Save, which writes a new PDF next to the original.
import { api, base, h, shell } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { fitRotated, docFor, createThumbLoader, inspectPdf } from './thumbs';
import { isProtected, PdfError } from './pdfjs';

interface Page {
  key: number; // stable identity for selection/DOM reuse
  src: string;
  index: number; // 0-based page in src
  rotate: number;
}

let seq = 0;

export async function organizePdf(paths: string[]) {
  const file = paths[0];
  const s = shell({ title: 'Organize PDF', file: base(file), layout: 'full' });
  s.primary.textContent = 'Save as new PDF';
  s.full.classList.add('pf-organize');

  let pages: Page[] = [];
  const selected = new Set<number>();
  let anchor: number | null = null; // key of the last plainly clicked page
  const history: Page[][] = [];
  const future: Page[][] = [];
  let size = 150;

  const grid = h('div', { class: 'pf-grid', role: 'listbox', 'aria-multiselectable': 'true', tabindex: 0 });
  const tb = (name: string, label: string, fn: () => void, extra = '') =>
    h('button', { class: `btn small ghost ${extra}`, title: label, onclick: fn, html: `${icon(name, 16)}<span>${label}</span>` });

  const rotL = tb('rotate', 'Rotate left', () => rotate(-90), 'pf-flip');
  const rotR = tb('rotate', 'Rotate right', () => rotate(90));
  const dup = tb('copy', 'Duplicate', duplicate);
  const del = tb('trash', 'Delete', remove);
  const undoBtn = h('button', { class: 'btn small icon ghost', title: 'Undo (Ctrl+Z)', html: icon('undo', 16), onclick: undo });
  const redoBtn = h('button', { class: 'btn small icon ghost', title: 'Redo (Ctrl+Y)', html: icon('redo', 16), onclick: redo });
  const zoom = h('input', { type: 'range', min: 90, max: 260, step: 10, class: 'pf-zoom', title: 'Thumbnail size' }) as HTMLInputElement;
  zoom.value = String(size);
  zoom.addEventListener('input', () => {
    size = Number(zoom.value);
    grid.style.setProperty('--pf-thumb', `${size}px`);
    for (const el of grid.children) if ((el as HTMLElement).dataset.key) layoutCard(el as HTMLElement);
    thumbs.refresh();
  });
  const toolbar = h(
    'div',
    { class: 'toolbar pf-toolbar' },
    rotL,
    rotR,
    dup,
    del,
    h('span', { class: 'sep' }),
    tb('plus', 'Insert PDF…', insertPdf),
    h('span', { class: 'sep' }),
    undoBtn,
    redoBtn,
    h('div', { style: { flex: '1' } }),
    h('span', { class: 'muted pf-zoom-label', html: icon('magnify', 15) }),
    zoom,
  );
  const wrap = h('div', { class: 'pf-organize-wrap' });
  s.full.before(wrap);
  wrap.append(toolbar, s.full);
  grid.style.setProperty('--pf-thumb', `${size}px`);
  s.full.append(grid);

  // ------------------------------------------------------------- load
  try {
    const doc = await docFor(file);
    // An owner password opens fine here but saving (pdf-lib) refuses the file.
    if (await isProtected(doc)) throw new PdfError('This PDF is protected. Remove the protection with Unlock first.', 'encrypted');
    if (!doc.numPages) throw new PdfError('This PDF has no pages.', 'broken');
    pages = Array.from({ length: doc.numPages }, (_, i) => ({ key: ++seq, src: file, index: i, rotate: 0 }));
  } catch (e) {
    const msg = e instanceof PdfError ? e.message : String((e as Error)?.message ?? e);
    s.full.replaceChildren(h('p', { class: 'empty-state pf-empty' }, msg));
    s.primary.disabled = true;
    return;
  }

  // ------------------------------------------------------------ state
  function snapshot() {
    note = '';
    history.push(pages.map((p) => ({ ...p })));
    if (history.length > 100) history.shift();
    future.length = 0;
  }
  function undo() {
    const prev = history.pop();
    if (!prev) return;
    note = '';
    future.push(pages);
    pages = prev;
    render();
  }
  function redo() {
    const next = future.pop();
    if (!next) return;
    note = '';
    history.push(pages);
    pages = next;
    render();
  }
  const targets = () => pages.filter((p) => selected.has(p.key));

  function rotate(deg: number) {
    const t = targets();
    if (!t.length) return;
    snapshot();
    pages = pages.map((p) => (selected.has(p.key) ? { ...p, rotate: (((p.rotate + deg) % 360) + 360) % 360 } : p));
    render();
  }
  function duplicate() {
    const t = targets();
    if (!t.length) return;
    snapshot();
    const lastIdx = Math.max(...t.map((p) => pages.indexOf(p)));
    const copies = t.map((p) => ({ ...p, key: ++seq }));
    pages = [...pages.slice(0, lastIdx + 1), ...copies, ...pages.slice(lastIdx + 1)];
    selected.clear();
    copies.forEach((c) => selected.add(c.key));
    render();
  }
  function remove() {
    const t = targets();
    if (!t.length) return;
    snapshot();
    const firstIdx = pages.indexOf(t[0]);
    pages = pages.filter((p) => !selected.has(p.key));
    selected.clear();
    const next = pages[Math.min(firstIdx, pages.length - 1)];
    if (next) selected.add(next.key);
    render();
  }
  async function insertPdf() {
    const files = await api().invoke<string[]>('dialog:files', [{ name: 'PDF', extensions: ['pdf'] }], true);
    if (!files.length) return;
    const added: Page[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const info = await inspectPdf(f);
      if (info.encrypted) skipped.push(`${base(f)} is password-protected.`);
      else if (info.error) skipped.push(`${base(f)} isn't a readable PDF.`);
      else if (!info.pages) skipped.push(`${base(f)} has no pages.`);
      else for (let i = 0; i < info.pages; i++) added.push({ key: ++seq, src: f, index: i, rotate: 0 });
    }
    if (!added.length) {
      note = skipped.join(' ');
      return render();
    }
    snapshot();
    // Shown until the next change, so a skipped file isn't hidden behind the page count.
    note = skipped.join(' ');
    const t = targets();
    const at = t.length ? Math.max(...t.map((p) => pages.indexOf(p))) + 1 : pages.length;
    pages = [...pages.slice(0, at), ...added, ...pages.slice(at)];
    selected.clear();
    added.forEach((p) => selected.add(p.key));
    render();
    grid.querySelector<HTMLElement>(`[data-key="${added[0].key}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ cards
  const cards = new Map<number, HTMLElement>();
  let note = '';
  const thumbs = createThumbLoader({
    root: s.full,
    side: () => size * 1.3,
    fit: (box, _img, aspect) => {
      const el = box.parentElement as HTMLElement;
      el.dataset.aspect = String(aspect);
      layoutCard(el);
    },
  });

  function layoutCard(card: HTMLElement) {
    const img = card.querySelector('img') as HTMLImageElement;
    const aspect = Number(card.dataset.aspect || 0.77);
    fitRotated(img, aspect, Number(card.dataset.rotate || 0), size, size * 1.3);
  }

  function card(p: Page) {
    let c = cards.get(p.key);
    if (!c) {
      const img = h('img', { alt: '', draggable: false });
      const box = h('div', { class: 'pf-thumb skeleton' }, img);
      c = h(
        'div',
        { class: 'pf-card', role: 'option', draggable: true, 'data-key': String(p.key) },
        box,
        h('div', { class: 'pf-cap' }),
      );
      c.dataset.aspect = '0.77';
      thumbs.watch(box, p.src, p.index);
      cards.set(p.key, c);
    }
    c.dataset.rotate = String(p.rotate);
    c.classList.toggle('on', selected.has(p.key));
    c.setAttribute('aria-selected', String(selected.has(p.key)));
    const n = pages.indexOf(p) + 1;
    const cap = c.querySelector('.pf-cap')!;
    const fromOther = p.src !== file;
    cap.replaceChildren(
      ...[
        h('span', { class: 'pf-num' }, String(n)),
        fromOther ? h('span', { class: 'pf-src', title: p.src }, `${base(p.src)} · p${p.index + 1}`) : null,
        p.rotate ? h('span', { class: 'pf-rot' }, `${p.rotate}°`) : null,
      ].filter((x): x is HTMLSpanElement => !!x),
    );
    c.title = `Page ${n}${fromOther ? ` (page ${p.index + 1} of ${base(p.src)})` : p.index + 1 !== n ? ` (was page ${p.index + 1})` : ''}`;
    layoutCard(c);
    return c;
  }

  function render() {
    const live = new Set(pages.map((p) => p.key));
    for (const [k, c] of [...cards]) {
      if (live.has(k)) continue;
      thumbs.unwatch(c.firstElementChild as HTMLElement);
      cards.delete(k);
    }
    for (const k of [...selected]) if (!live.has(k)) selected.delete(k);
    const els = pages.map(card);
    // Only re-attach when the order changed: detaching a card mid-click would cancel a drag.
    const same = els.length === grid.children.length && els.every((el, i) => grid.children[i] === el);
    if (!same) grid.replaceChildren(...els);
    if (!pages.length) grid.append(h('p', { class: 'empty-state pf-empty' }, 'Every page has been removed. Undo to bring them back.'));
    const n = selected.size;
    for (const b of [rotL, rotR, dup, del]) b.disabled = n === 0;
    undoBtn.disabled = !history.length;
    redoBtn.disabled = !future.length;
    s.primary.disabled = !pages.length;
    const count = pages.length ? `${pages.length} page${pages.length === 1 ? '' : 's'}${n ? ` · ${n} selected` : ''}` : 'No pages';
    s.status.textContent = note ? `${note} ${count}` : count;
  }

  // ------------------------------------------------------- selection
  // A plain click on an already-selected page narrows the selection on mouseup, unless it turned
  // into a drag (so dragging a multi-selection still works).
  let narrowTo: number | null = null;
  grid.addEventListener('mouseup', () => {
    const key = narrowTo;
    narrowTo = null;
    if (key === null || dragging) return;
    selected.clear();
    selected.add(key);
    render();
  });
  grid.addEventListener('mousedown', (e) => {
    narrowTo = null;
    const c = (e.target as HTMLElement).closest<HTMLElement>('.pf-card');
    if (!c) {
      if (!e.ctrlKey && !e.shiftKey) {
        selected.clear();
        render();
      }
      return;
    }
    const key = Number(c.dataset.key);
    if (e.shiftKey && anchor !== null) {
      const a = pages.findIndex((p) => p.key === anchor);
      const b = pages.findIndex((p) => p.key === key);
      if (!e.ctrlKey) selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(pages[i].key);
    } else if (e.ctrlKey) {
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      anchor = key;
    } else if (!selected.has(key)) {
      selected.clear();
      selected.add(key);
      anchor = key;
    } else {
      anchor = key;
      narrowTo = key;
    }
    render();
  });

  // ------------------------------------------------------------- drag
  let dragging: number[] | null = null;
  let dropAt = -1;
  const marker = h('div', { class: 'pf-drop' });

  grid.addEventListener('dragstart', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('.pf-card');
    if (!c) return;
    narrowTo = null;
    const key = Number(c.dataset.key);
    if (!selected.has(key)) {
      selected.clear();
      selected.add(key);
      render();
    }
    dragging = pages.filter((p) => selected.has(p.key)).map((p) => p.key);
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', 'pages');
    if (dragging.length > 1) {
      const ghost = h('div', { class: 'pf-ghost' }, `${dragging.length} pages`);
      document.body.append(ghost);
      e.dataTransfer!.setDragImage(ghost, 20, 20);
      setTimeout(() => ghost.remove());
    }
    requestAnimationFrame(() => dragging?.forEach((k) => cards.get(k)?.classList.add('dragging')));
  });
  grid.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const c = (e.target as HTMLElement).closest<HTMLElement>('.pf-card');
    if (!c) return;
    const r = c.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    const idx = pages.findIndex((p) => p.key === Number(c.dataset.key));
    dropAt = after ? idx + 1 : idx;
    const g = grid.getBoundingClientRect();
    marker.style.height = `${r.height - 8}px`;
    marker.style.top = `${r.top - g.top + 4}px`;
    marker.style.left = `${(after ? r.right + 3 : r.left - 3) - g.left}px`;
    if (!marker.isConnected) grid.append(marker);
  });
  grid.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    if (dropAt < 0) return;
    const moving = new Set(dragging);
    const before = pages.slice(0, dropAt).filter((p) => !moving.has(p.key));
    const after = pages.slice(dropAt).filter((p) => !moving.has(p.key));
    const moved = pages.filter((p) => moving.has(p.key));
    const next = [...before, ...moved, ...after];
    if (next.some((p, i) => p !== pages[i])) {
      snapshot();
      pages = next;
    }
  });
  grid.addEventListener('dragend', () => {
    dragging = null;
    dropAt = -1;
    marker.remove();
    grid.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
    render();
  });

  // --------------------------------------------------------- keyboard
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'a') {
      e.preventDefault();
      pages.forEach((p) => selected.add(p.key));
      render();
    } else if (e.ctrlKey && k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (e.ctrlKey && k === 'd') {
      e.preventDefault();
      duplicate();
    } else if (k === 'delete' || k === 'backspace') {
      e.preventDefault();
      remove();
    } else if (e.ctrlKey || e.altKey || e.metaKey) return;
    else if (k === '[' || (k === 'r' && e.shiftKey)) rotate(-90);
    else if (k === ']' || k === 'r') rotate(90);
    else if (k === 'arrowleft' || k === 'arrowright') {
      e.preventDefault();
      const cur = pages.findIndex((p) => p.key === anchor);
      const i = Math.max(0, Math.min(pages.length - 1, (cur < 0 ? -1 : cur) + (k === 'arrowright' ? 1 : -1)));
      if (!pages[i]) return;
      if (!e.shiftKey) selected.clear();
      selected.add(pages[i].key);
      anchor = pages[i].key;
      render();
      cards.get(pages[i].key)?.scrollIntoView({ block: 'nearest' });
    }
  });

  render();

  s.primary.addEventListener('click', async () => {
    s.primary.disabled = true;
    s.primary.textContent = 'Saving…';
    const options = { pages: pages.map(({ src, index, rotate }) => ({ src, index, rotate })) };
    const inputs = [file, ...new Set(pages.map((p) => p.src).filter((p) => p !== file))];
    try {
      const p = api().invoke<string[]>('tool:run', 'organizePdf', inputs, options);
      api().send('window:close');
      await p;
    } catch (e: any) {
      s.primary.disabled = false;
      s.primary.textContent = 'Save as new PDF';
      s.status.textContent = e?.message ?? String(e);
    }
  });
}
