// Merge PDFs: a reorderable list with a first-page preview and page count per file.
import { api, base, dir, fmtBytes, h, iconButton, shell } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { thumb, fitRotated, pdfBlurb } from './thumbs';

interface Entry {
  path: string;
  pages?: number;
  size?: number;
  problem?: string;
}

export async function mergePdf(paths: string[]) {
  const s = shell({ title: 'Merge PDFs', layout: 'full' });
  s.primary.textContent = 'Merge';
  s.full.classList.add('pf-merge');

  const entries: Entry[] = paths.map((path) => ({ path }));
  const list = h('div', { class: 'list pf-list', role: 'list' });
  const add = h('button', { class: 'btn small', html: `${icon('plus', 15)}<span>Add PDFs…</span>`, onclick: () => addFiles() });
  s.full.append(
    h(
      'div',
      { class: 'pf-head' },
      h('p', { class: 'hint' }, 'Drag to change the order, or use Alt + ↑ / ↓. Pages go in exactly this order.'),
      add,
    ),
    list,
  );

  const inspect = (e: Entry) =>
    Promise.all([
      api().invoke<{ pages: number; encrypted: boolean; error?: string }>('pdf:inspect', e.path),
      api().invoke<{ size: number }>('file:stat', e.path).catch(() => ({ size: 0 })),
    ]).then(([info, st]) => {
      e.pages = info.pages;
      e.size = st.size;
      if (info.encrypted) e.problem = 'Password-protected. Remove the protection to merge it.';
      else if (info.error) e.problem = "Couldn't read this PDF.";
      render();
    });

  let dragFrom = -1;
  const rows = new Map<Entry, { item: HTMLElement; index: HTMLElement; meta: HTMLElement; state: string }>();

  function metaFor(e: Entry) {
    return e.problem
      ? h('span', { class: 'pf-warn' }, e.problem)
      : h('span', { class: 'muted' }, e.pages === undefined ? 'Reading…' : `${pdfBlurb(e.pages)} · ${fmtBytes(e.size ?? 0)}`);
  }

  function row(e: Entry) {
    const state = `${e.pages}|${e.problem}`;
    const have = rows.get(e);
    if (have) {
      if (have.state !== state) {
        const m = metaFor(e);
        have.meta.replaceWith(m);
        have.meta = m;
        have.state = state;
        have.item.classList.toggle('bad', !!e.problem);
      }
      have.index.textContent = String(entries.indexOf(e) + 1);
      return have.item;
    }
    const at = () => entries.indexOf(e);
    const img = h('img', { alt: '', draggable: false });
    const box = h('div', { class: 'pf-mini skeleton' }, img);
    if (!e.problem) {
      thumb(e.path, 0, 88).then(
        (t) => {
          img.src = t.url;
          fitRotated(img, t.aspect, 0, 44, 56);
          box.classList.remove('skeleton');
        },
        () => box.classList.remove('skeleton'),
      );
    } else box.classList.remove('skeleton');

    const meta = metaFor(e);
    const index = h('span', { class: 'pf-index' }, String(at() + 1));
    const item = h(
      'div',
      {
        class: `item pf-item${e.problem ? ' bad' : ''}`,
        draggable: true,
        tabindex: 0,
        role: 'listitem',
        title: e.path,
        onkeydown: (ev: KeyboardEvent) => {
          if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
          ev.preventDefault();
          const i = at();
          const to = ev.key === 'ArrowUp' ? i - 1 : i + 1;
          if (to < 0 || to >= entries.length) return;
          move(i, to);
          (list.children[to] as HTMLElement)?.focus();
        },
      },
      h('span', { class: 'grip', html: icon('grip', 16) }),
      index,
      box,
      h('div', { class: 'pf-text' }, h('span', { class: 'name' }, base(e.path)), meta),
      iconButton('close', 'Remove from the list', () => {
        entries.splice(at(), 1);
        rows.delete(e);
        render();
      }),
    );
    item.addEventListener('dragstart', (ev) => {
      dragFrom = at();
      item.classList.add('dragging');
      ev.dataTransfer!.effectAllowed = 'move';
      ev.dataTransfer!.setData('text/plain', String(at()));
    });
    item.addEventListener('dragend', () => {
      dragFrom = -1;
      list.querySelectorAll('.dragging,.over-top,.over-bottom').forEach((x) => x.classList.remove('dragging', 'over-top', 'over-bottom'));
    });
    item.addEventListener('dragover', (ev) => {
      if (dragFrom < 0) return;
      ev.preventDefault();
      const r = item.getBoundingClientRect();
      const top = ev.clientY < r.top + r.height / 2;
      list.querySelectorAll('.over-top,.over-bottom').forEach((x) => x.classList.remove('over-top', 'over-bottom'));
      item.classList.add(top ? 'over-top' : 'over-bottom');
    });
    item.addEventListener('drop', (ev) => {
      if (dragFrom < 0) return;
      ev.preventDefault();
      const r = item.getBoundingClientRect();
      const i = at();
      let to = ev.clientY < r.top + r.height / 2 ? i : i + 1;
      if (dragFrom < to) to--;
      if (to !== dragFrom) move(dragFrom, to);
    });
    rows.set(e, { item, index, meta, state });
    return item;
  }

  function move(from: number, to: number) {
    const [x] = entries.splice(from, 1);
    entries.splice(to, 0, x);
    render();
  }

  function render() {
    list.replaceChildren(...entries.map(row));
    const ok = entries.filter((e) => !e.problem);
    const pages = ok.reduce((a, e) => a + (e.pages ?? 0), 0);
    const bad = entries.length - ok.length;
    s.primary.disabled = ok.length < 2 || bad > 0;
    if (!entries.length) list.append(h('p', { class: 'empty-state pf-empty' }, 'No PDFs in the list. Add some to merge.'));
    s.status.textContent = bad
      ? `Remove ${bad === 1 ? 'the protected file' : `the ${bad} protected files`} to continue`
      : ok.length < 2
        ? 'Add at least two PDFs'
        : `${ok.length} files · ${pdfBlurb(pages)} → Merged.pdf in ${base(dir(ok[0].path)) || dir(ok[0].path)}`;
  }

  async function addFiles() {
    const more = await api().invoke<string[]>('dialog:files', [{ name: 'PDF', extensions: ['pdf'] }], true);
    for (const p of more) {
      const e = { path: p };
      entries.push(e);
      inspect(e);
    }
    render();
  }

  // Files dropped onto the window are appended too.
  s.full.addEventListener('dragover', (ev) => {
    if (dragFrom < 0 && ev.dataTransfer?.types.includes('Files')) ev.preventDefault();
  });
  s.full.addEventListener('drop', (ev) => {
    if (dragFrom >= 0 || !ev.dataTransfer?.files.length) return;
    ev.preventDefault();
    for (const f of ev.dataTransfer.files) {
      const p = api().pathForFile(f);
      if (!/\.pdf$/i.test(p)) continue;
      const e = { path: p };
      entries.push(e);
      inspect(e);
    }
    render();
  });

  render();
  entries.forEach(inspect);

  s.primary.addEventListener('click', async () => {
    const order = entries.filter((e) => !e.problem).map((e) => e.path);
    s.primary.disabled = true;
    s.primary.textContent = 'Merging…';
    try {
      const p = api().invoke<string[]>('tool:run', 'mergePdf', order, { order });
      api().send('window:close');
      await p;
    } catch (e: any) {
      s.primary.disabled = false;
      s.primary.textContent = 'Merge';
      s.status.textContent = e?.message ?? String(e);
    }
  });
}
