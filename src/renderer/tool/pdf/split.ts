// Split a PDF: every page, every N pages, custom ranges, or extract a hand-picked selection.
// The page grid shows exactly how the parts will fall before anything is written.
import { api, base, field, h, numberInput, section, segmented, shell } from '../../shared/ui';
import { thumb, fitRotated, docFor, whenVisible } from './thumbs';
import { PdfError } from './pdfjs';

type Mode = 'every' | 'chunks' | 'ranges' | 'extract';

/** "1-3, 5, 8-" → [[0,1,2],[4],[7..total-1]] (0-based). Throws with a readable message. */
export function parseRanges(text: string, total: number): number[][] {
  const groups: number[][] = [];
  const parts = text.split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Type page ranges, for example 1-3, 5, 8-');
  for (const part of parts) {
    const m = /^(\d*)\s*(?:(-|–|to)\s*(\d*))?$/i.exec(part);
    if (!m || (!m[1] && !m[3])) throw new Error(`"${part}" isn't a page or range`);
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : total) : a;
    if (a < 1 || b < 1) throw new Error('Pages start at 1');
    if (a > total || b > total) throw new Error(`This PDF has ${total} page${total === 1 ? '' : 's'}`);
    const g: number[] = [];
    if (a <= b) for (let i = a; i <= b; i++) g.push(i - 1);
    else for (let i = a; i >= b; i--) g.push(i - 1);
    groups.push(g);
  }
  return groups;
}

export async function splitPdf(paths: string[]) {
  const file = paths[0];
  const s = shell({ title: 'Split PDF', file: base(file), layout: 'split', plainStage: true });
  s.primary.textContent = 'Split';
  s.stage.classList.add('pf-split-stage');

  let total = 0;
  try {
    total = (await docFor(file)).numPages;
  } catch (e) {
    s.stage.append(h('p', { class: 'empty-state' }, e instanceof PdfError ? e.message : String((e as Error)?.message ?? e)));
    s.primary.disabled = true;
    return;
  }

  let mode: Mode = total > 1 ? 'every' : 'extract';
  let n = Math.min(2, total);
  let rangeText = total > 2 ? `1-${Math.ceil(total / 2)}, ${Math.ceil(total / 2) + 1}-` : '1';
  const picked = new Set<number>();
  let lastPick: number | null = null;

  // ------------------------------------------------------------- panel
  const nInput = numberInput(n, (v) => ((n = v), update()), { min: 1, max: Math.max(1, total) });
  const rangeInput = h('input', { type: 'text', spellcheck: false, placeholder: '1-3, 5, 8-' }) as HTMLInputElement;
  rangeInput.value = rangeText;
  rangeInput.addEventListener('input', () => ((rangeText = rangeInput.value), update()));
  const rangeError = h('div', { class: 'pf-error', role: 'alert' });
  const nField = field('Pages per file', nInput);
  const rangeField = h(
    'div',
    {},
    field('Ranges', rangeInput),
    h('p', { class: 'hint' }, 'Each range becomes one file. "8-" runs to the last page, "5" is a single page.'),
    rangeError,
  );
  const pickHint = h('p', { class: 'hint' }, 'Click pages to pick them (Shift selects a run, Ctrl toggles). They are saved together as one PDF.');
  const pickTools = h(
    'div',
    { class: 'row pf-pick-tools' },
    h('button', { class: 'btn small', onclick: () => (Array.from({ length: total }, (_, i) => picked.add(i)), update()) }, 'All'),
    h('button', { class: 'btn small', onclick: () => (picked.clear(), update()) }, 'None'),
    h('button', { class: 'btn small', onclick: () => (Array.from({ length: total }, (_, i) => (i % 2 === 0 ? picked.add(i) : picked.delete(i))), update()) }, 'Odd'),
    h('button', { class: 'btn small', onclick: () => (Array.from({ length: total }, (_, i) => (i % 2 === 1 ? picked.add(i) : picked.delete(i))), update()) }, 'Even'),
  );
  const summary = h('div', { class: 'pf-summary' });
  const modes = segmented<Mode>(
    [
      { value: 'every', label: 'Each page' },
      { value: 'chunks', label: 'Every N' },
      { value: 'ranges', label: 'Ranges' },
      { value: 'extract', label: 'Pick pages' },
    ],
    mode,
    (v) => ((mode = v), update()),
  );
  s.panel.append(
    section('Split into', modes, h('div', { class: 'pf-mode-body' }, nField, rangeField, pickHint, pickTools)),
    section('Result', summary),
  );

  // -------------------------------------------------------------- grid
  const grid = h('div', { class: 'pf-grid pf-grid-small' });
  grid.style.setProperty('--pf-thumb', '96px');
  s.stage.append(grid);
  const cards: HTMLElement[] = [];
  for (let i = 0; i < total; i++) {
    const img = h('img', { alt: '', draggable: false });
    const box = h('div', { class: 'pf-thumb skeleton' }, img);
    fitRotated(img, 0.77, 0, 96, 124);
    const c = h('div', { class: 'pf-card', 'data-i': String(i), title: `Page ${i + 1}` }, box, h('div', { class: 'pf-cap' }, h('span', { class: 'pf-num' }, String(i + 1)), h('span', { class: 'pf-part' })));
    whenVisible(c, () =>
      thumb(file, i, 192).then(
        (t) => {
          img.src = t.url;
          fitRotated(img, t.aspect, 0, 96, 124);
          box.classList.remove('skeleton');
        },
        () => box.classList.remove('skeleton'),
      ),
    );
    cards.push(c);
  }
  grid.append(...cards);

  grid.addEventListener('mousedown', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('.pf-card');
    if (!c) return;
    const i = Number(c.dataset.i);
    if (mode !== 'extract') {
      // Clicking a page while in another mode switches to picking, starting from that page.
      mode = 'extract';
      modes.set('extract');
      picked.clear();
    }
    if (e.shiftKey && lastPick !== null) {
      for (let k = Math.min(lastPick, i); k <= Math.max(lastPick, i); k++) picked.add(k);
    } else if (picked.has(i)) picked.delete(i);
    else picked.add(i);
    lastPick = i;
    update();
  });

  // ------------------------------------------------------------ compute
  function groups(): number[][] {
    switch (mode) {
      case 'every':
        return Array.from({ length: total }, (_, i) => [i]);
      case 'chunks': {
        const out: number[][] = [];
        for (let i = 0; i < total; i += Math.max(1, n)) out.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
        return out;
      }
      case 'ranges':
        return parseRanges(rangeText, total);
      case 'extract':
        return picked.size ? [[...picked].sort((a, b) => a - b)] : [];
    }
  }

  function update() {
    nField.hidden = mode !== 'chunks';
    rangeField.hidden = mode !== 'ranges';
    pickHint.hidden = pickTools.hidden = mode !== 'extract';
    rangeError.textContent = '';
    rangeInput.classList.remove('invalid');
    let g: number[][] = [];
    try {
      g = groups();
    } catch (e: any) {
      rangeError.textContent = e.message;
      rangeInput.classList.add('invalid');
    }
    // Paint the grid: part number + alternating tint per part; picked pages get the accent ring.
    const partOf = new Map<number, number>();
    g.forEach((grp, gi) => grp.forEach((p) => (partOf.has(p) ? null : partOf.set(p, gi))));
    cards.forEach((c, i) => {
      const part = partOf.get(i);
      c.classList.toggle('on', mode === 'extract' && picked.has(i));
      c.classList.toggle('pf-out', part === undefined);
      c.classList.toggle('pf-alt', part !== undefined && part % 2 === 1 && mode !== 'extract');
      const label = c.querySelector('.pf-part')!;
      label.textContent = part === undefined || mode === 'extract' || mode === 'every' ? '' : `Part ${part + 1}`;
    });

    const pagesOut = g.reduce((a, x) => a + x.length, 0);
    const files = g.length;
    if (!files) {
      summary.replaceChildren(h('p', { class: 'muted' }, mode === 'extract' ? 'Pick the pages to extract.' : 'Nothing to split yet.'));
      s.primary.disabled = true;
      s.status.textContent = `${total} pages`;
      return;
    }
    const oneFile = mode === 'extract' || files === 1;
    s.primary.disabled = false;
    s.primary.textContent = oneFile ? 'Extract' : 'Split';
    const stem = base(file).replace(/\.pdf$/i, '');
    summary.replaceChildren(
      h('div', { class: 'pf-big' }, oneFile ? '1 PDF' : `${files} PDFs`),
      h('p', { class: 'muted' }, `${pagesOut} page${pagesOut === 1 ? '' : 's'} in total`),
      h(
        'p',
        { class: 'hint' },
        oneFile ? `Saved next to the original as a new file.` : `Saved in a new folder "${stem} split" next to the original.`,
      ),
    );
    s.status.textContent = `${total} pages`;
  }

  modes.set(mode);
  update();

  s.primary.addEventListener('click', async () => {
    let g: number[][];
    try {
      g = groups();
    } catch {
      return;
    }
    s.primary.disabled = true;
    try {
      const p = api().invoke<string[]>('tool:run', 'splitPdf', [file], { groups: g, mode });
      api().send('window:close');
      await p;
    } catch (e: any) {
      s.primary.disabled = false;
      s.status.textContent = e?.message ?? String(e);
    }
  });
}
