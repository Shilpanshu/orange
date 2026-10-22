// Make PDF: one page per image. The stage shows every page as it will come out (drag to
// reorder); the PDF itself is assembled in the main process with pdf-lib.
import { base, h, runAndClose, section, segmented, shell, slider, sortable } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { loadPreview, xicon } from './common';

type PageSize = 'fit' | 'a4' | 'letter';
type Orient = 'auto' | 'portrait' | 'landscape';
const PAGE = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const MM = 72 / 25.4;

interface Entry {
  path: string;
  url: string | null;
  w: number;
  h: number;
  el: HTMLElement;
}

export async function createPdf(paths: string[]) {
  const s = shell({ title: 'Make PDF', file: `${paths.length} images` });
  s.primary.textContent = 'Create PDF';
  s.stage.classList.add('ix-stage', 'plainbg');
  const st = { page: 'fit' as PageSize, orient: 'auto' as Orient, margin: 0, name: base(paths[0]).replace(/\.[^.]+$/, '') };

  const grid = h('div', { class: 'ix-pages list', role: 'list' });
  s.stage.append(grid);
  let entries: Entry[] = paths.map((p) => ({ path: p, url: null, w: 3, h: 4, el: h('div') }));

  function pageBox(e: Entry) {
    const iw = e.w * 0.75;
    const ih = e.h * 0.75;
    const m = st.margin * MM;
    let pw: number, ph: number;
    if (st.page === 'fit') {
      pw = iw + 2 * m;
      ph = ih + 2 * m;
    } else {
      [pw, ph] = PAGE[st.page];
      if (st.orient === 'landscape' || (st.orient === 'auto' && iw > ih)) [pw, ph] = [ph, pw];
    }
    const k = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
    return { pw, ph, dw: iw * k, dh: ih * k };
  }

  function card(e: Entry, i: number) {
    const sheet = h('div', { class: 'ix-sheet' });
    const box = pageBox(e);
    const k = Math.min(134 / box.pw, 160 / box.ph);
    Object.assign(sheet.style, { width: `${box.pw * k}px`, height: `${box.ph * k}px` });
    const pic = e.url
      ? h('img', { src: e.url, alt: '', draggable: false, style: { width: `${box.dw * k}px`, height: `${box.dh * k}px`, flex: 'none' } })
      : h('div', { class: 'skeleton', style: { width: `${box.dw * k}px`, height: `${box.dh * k}px` } });
    sheet.append(pic);
    const el = h(
      'div',
      { class: 'item', role: 'listitem', draggable: true, title: e.path },
      h('div', { class: 'ix-page' }, sheet),
      h('div', { class: 'cap' }, h('span', { class: 'num' }, String(i + 1)), h('span', { class: 'name' }, base(e.path))),
      entries.length > 2
        ? h('button', {
            class: 'btn icon rm',
            title: 'Leave this image out',
            'aria-label': `Remove ${base(e.path)}`,
            html: xicon('x', 14),
            onclick: (ev: Event) => {
              ev.stopPropagation();
              entries = entries.filter((x) => x !== e);
              render();
            },
          })
        : null,
    );
    e.el = el;
    return el;
  }

  function render() {
    grid.replaceChildren(...entries.map(card));
    const n = entries.length;
    s.status.textContent = `${n} page${n === 1 ? '' : 's'}`;
  }
  sortable(grid, (from, to) => {
    const [m] = entries.splice(from, 1);
    entries.splice(to, 0, m);
    render();
  });

  // Thumbnails stream in; the page layout needs each image's real proportions.
  render();
  // A snapshot of the work: pages removed or dragged into a new order while thumbnails are still
  // loading must not shift an index and leave some page without its thumbnail and proportions.
  const queue = [...entries];
  const loadNext = async () => {
    while (queue.length) {
      const e = queue.shift()!;
      try {
        const pv = await loadPreview(e.path, 320);
        e.w = pv.w;
        e.h = pv.h;
        const c = new OffscreenCanvas(pv.bmp.width, pv.bmp.height);
        c.getContext('2d')!.drawImage(pv.bmp, 0, 0);
        e.url = URL.createObjectURL(await c.convertToBlob({ type: 'image/webp', quality: 0.85 }));
      } catch {
        e.url = null;
      }
      const idx = entries.indexOf(e);
      if (idx >= 0) e.el.replaceWith(card(e, idx));
    }
  };
  void Promise.all([loadNext(), loadNext(), loadNext()]);

  const orientField = h(
    'div',
    { class: 'field' },
    h('div', { class: 'label' }, h('span', {}, 'Orientation')),
    segmented(
      [
        { value: 'auto', label: 'Auto' },
        { value: 'portrait', label: 'Portrait' },
        { value: 'landscape', label: 'Landscape' },
      ],
      st.orient,
      (v) => ((st.orient = v as Orient), render()),
    ),
  );
  const syncOrient = () => (orientField.style.display = st.page === 'fit' ? 'none' : '');
  const nameInput = h('input', { type: 'text', value: st.name, spellcheck: false }) as HTMLInputElement;
  nameInput.addEventListener('input', () => (st.name = nameInput.value));

  s.panel.append(
    section(
      'Pages',
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'label' }, h('span', {}, 'Page size')),
        segmented(
          [
            { value: 'fit', label: 'Fit image' },
            { value: 'a4', label: 'A4' },
            { value: 'letter', label: 'Letter' },
          ],
          st.page,
          (v) => {
            st.page = v as PageSize;
            syncOrient();
            render();
          },
        ),
      ),
      orientField,
      slider({ label: 'Margin', min: 0, max: 30, value: 0, format: (v) => `${v} mm`, onInput: (v) => ((st.margin = v), render()) }),
    ),
    section(
      'File',
      h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Name')), h('div', { class: 'row' }, nameInput, h('span', { class: 'muted fixed' }, '.pdf'))),
      h('p', { class: 'hint', html: `${icon('grip', 12)} Drag pages to change the order. JPEGs are embedded as they are, without recompressing.` }),
    ),
  );
  syncOrient();

  s.primary.onclick = () =>
    runAndClose(s.primary, 'createPdf', entries.map((e) => e.path), { page: st.page, orientation: st.orient, margin: st.margin, name: st.name }, s.status);
}
