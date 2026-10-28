// Metadata: a searchable, grouped view of everything embedded in a file, a few common fields to
// edit, and "Remove all" for the whole selection. Results are written as new files.
import { api, base, h, shell } from '../../shared/ui';
import { icon } from '../../shared/icons';

interface Row {
  label: string;
  value: string;
}
interface Group {
  name: string;
  rows: Row[];
}
interface MetaInfo {
  path: string;
  kind: 'image' | 'av' | 'pdf' | 'other';
  groups: Group[];
  fields: Record<string, string>;
  editable: string[];
  note?: string;
}

const LABELS: Record<string, string> = {
  make: 'Camera make',
  model: 'Camera model',
  dateTaken: 'Date taken',
  author: 'Author',
  copyright: 'Copyright',
  description: 'Description',
  gps: 'Location',
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  album_artist: 'Album artist',
  date: 'Year',
  genre: 'Genre',
  track: 'Track',
  comment: 'Comment',
  subject: 'Subject',
  keywords: 'Keywords',
  creator: 'Created with',
  producer: 'PDF producer',
};
const PLACEHOLDER: Record<string, string> = {
  gps: 'Latitude, longitude, e.g. 48.8584, 2.2945',
  keywords: 'Comma separated',
  date: 'e.g. 2024',
  track: 'e.g. 3 or 3/12',
};
const WIDE = new Set(['description', 'comment', 'gps', 'keywords', 'title']);

export async function metadata(paths: string[]) {
  const s = shell({ title: 'Metadata', file: paths.length === 1 ? base(paths[0]) : `${paths.length} files`, layout: 'full' });
  s.primary.textContent = 'Save changes';
  s.primary.disabled = true;
  s.full.classList.add('fm-root');

  const strip = h('button', { class: 'btn', html: `${icon('trash', 16)}<span>${paths.length > 1 ? `Remove all from ${paths.length} files` : 'Remove all metadata'}</span>` });
  s.cancel.before(strip);

  const infos = new Map<string, MetaInfo>();
  const edits = new Map<string, Record<string, string>>();
  let current = paths[0];
  let query = '';
  let replaces = false;
  api()
    .invoke<{ replaceOriginal?: boolean }>('settings:get')
    .then((st) => ((replaces = !!st?.replaceOriginal), update()))
    .catch(() => {});

  // ----------------------------------------------------------- layout
  const side = h('div', { class: 'fm-side' });
  const search = h('input', { type: 'search', placeholder: 'Search tags and values', spellcheck: false, class: 'fm-search' }) as HTMLInputElement;
  const editBox = h('div', { class: 'fm-edit' });
  const table = h('div', { class: 'fm-table' }, ...Array.from({ length: 6 }, () => h('div', { class: 'skeleton fm-sk' })));
  const body = h('div', { class: 'fm-body' }, h('div', { class: 'fm-searchbar' }, h('span', { class: 'fm-search-icon', html: icon('magnify', 15) }), search), editBox, table);
  if (paths.length > 1) s.full.append(side);
  s.full.append(body);
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderTable();
  });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  // ------------------------------------------------------------- data
  const loading = new Map<string, Promise<MetaInfo>>();
  const load = (p: string) => {
    let pr = loading.get(p);
    if (!pr) {
      pr = api()
        .invoke<MetaInfo>('meta:read', p)
        .then((m) => {
          infos.set(p, m);
          return m;
        });
      loading.set(p, pr);
      pr.catch(() => loading.delete(p));
    }
    return pr;
  };

  // ------------------------------------------------------------- side
  function renderSide() {
    side.replaceChildren(
      ...paths.map((p) =>
        h(
          'button',
          {
            class: `fm-file${p === current ? ' on' : ''}`,
            title: p,
            onclick: () => select(p),
          },
          h('span', { class: 'fm-file-name' }, base(p)),
          edits.has(p) ? h('span', { class: 'fm-dot', title: 'Edited' }) : null,
        ),
      ),
    );
  }

  async function select(p: string) {
    current = p;
    renderSide();
    table.replaceChildren(...Array.from({ length: 6 }, () => h('div', { class: 'skeleton fm-sk' })));
    editBox.replaceChildren();
    const m = await load(p);
    if (current !== p) return;
    renderEdit(m);
    renderTable();
  }

  // ------------------------------------------------------------- edit
  function renderEdit(m: MetaInfo) {
    editBox.replaceChildren();
    if (m.note) editBox.append(h('p', { class: 'hint fm-note' }, m.note));
    if (!m.editable.length) return;
    const mine = edits.get(m.path) ?? {};
    const grid = h('div', { class: 'fm-fields' });
    for (const f of m.editable) {
      const value = mine[f] ?? m.fields[f] ?? '';
      const input = h('input', {
        type: f === 'dateTaken' ? 'datetime-local' : 'text',
        step: f === 'dateTaken' ? '1' : undefined,
        placeholder: PLACEHOLDER[f] ?? '',
        spellcheck: false,
      }) as HTMLInputElement;
      input.value = value;
      input.classList.toggle('changed', f in mine);
      input.addEventListener('input', () => {
        const e = edits.get(m.path) ?? {};
        if (input.value === (m.fields[f] ?? '')) delete e[f];
        else e[f] = input.value;
        if (Object.keys(e).length) edits.set(m.path, e);
        else edits.delete(m.path);
        input.classList.toggle('changed', f in e);
        update();
      });
      const extra =
        f === 'gps' && (m.fields.gps || mine.gps)
          ? h(
              'button',
              {
                class: 'btn small ghost fm-clear',
                title: 'Remove the location',
                onclick: () => {
                  input.value = '';
                  input.dispatchEvent(new Event('input'));
                },
              },
              'Clear',
            )
          : null;
      grid.append(
        h(
          'label',
          { class: `fm-field${WIDE.has(f) ? ' wide' : ''}` },
          h('span', {}, LABELS[f] ?? f),
          extra ? h('div', { class: 'row' }, input, extra) : input,
        ),
      );
    }
    editBox.append(h('details', { class: 'fm-details', open: true }, h('summary', {}, 'Edit'), grid));
  }

  // ------------------------------------------------------------ table
  function renderTable() {
    const m = infos.get(current);
    if (!m) return;
    const out: HTMLElement[] = [];
    let shown = 0;
    for (const g of m.groups) {
      const groupHit = query && g.name.toLowerCase().includes(query);
      const rows = g.rows.filter((r) => !query || groupHit || r.label.toLowerCase().includes(query) || r.value.toLowerCase().includes(query));
      if (!rows.length) continue;
      shown += rows.length;
      out.push(
        h(
          'section',
          { class: 'fm-group' },
          h('h3', {}, g.name, h('span', { class: 'fm-count' }, String(rows.length))),
          h(
            'dl',
            {},
            ...rows.flatMap((r) => [
              h('dt', { title: r.label }, mark(r.label)),
              h('dd', { title: 'Double-click to copy', ondblclick: () => navigator.clipboard.writeText(r.value).then(() => flash('Copied')) }, mark(r.value)),
            ]),
          ),
        ),
      );
    }
    if (!shown) out.push(h('p', { class: 'empty-state fm-empty' }, query ? `Nothing matches "${search.value}".` : 'No metadata found.'));
    table.replaceChildren(...out);
  }

  function mark(text: string): Node {
    if (!query) return document.createTextNode(text);
    const i = text.toLowerCase().indexOf(query);
    if (i < 0) return document.createTextNode(text);
    const f = document.createDocumentFragment();
    f.append(text.slice(0, i), h('mark', {}, text.slice(i, i + query.length)), text.slice(i + query.length));
    return f;
  }

  let flashTimer: number | undefined;
  function flash(msg: string) {
    const prev = s.status.textContent;
    s.status.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => ((s.status.textContent = prev), update()), 1200);
  }

  function update() {
    const n = edits.size;
    s.primary.disabled = n === 0;
    s.primary.textContent = n > 1 ? `Save ${n} files` : 'Save changes';
    const where = replaces ? `replaces the original${n === 1 ? '' : 's'}` : n === 1 ? 'saved as a new copy' : 'saved as new copies';
    s.status.textContent = n ? `${n} file${n === 1 ? '' : 's'} with changes · ${where}` : paths.length > 1 ? `${paths.length} files` : '';
    if (paths.length > 1) renderSide();
  }

  // -------------------------------------------------------------- run
  async function run(options: any, targets: string[], button: HTMLButtonElement) {
    s.primary.disabled = true;
    strip.disabled = true;
    const label = button.innerHTML;
    button.textContent = 'Working…';
    try {
      const p = api().invoke<string[]>('tool:run', 'metadata', targets, options);
      api().send('window:close');
      await p;
    } catch (e: any) {
      button.innerHTML = label;
      strip.disabled = false;
      update();
      s.status.textContent = e?.message ?? String(e);
    }
  }

  s.primary.addEventListener('click', () => {
    if (!edits.size) return;
    const targets = [...edits.keys()];
    run({ action: 'edit', edits: Object.fromEntries(edits) }, targets, s.primary);
  });
  strip.addEventListener('click', () => run({ action: 'strip' }, paths, strip));

  renderSide();
  update();
  await select(current);
  // Warm up the others in the background so switching is instant.
  paths.slice(1, 12).forEach((p) => load(p).catch(() => {}));
}
