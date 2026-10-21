import { icon } from '../shared/icons';

declare const orange: import('../../preload/preload').OrangeApi;

interface Row {
  id: number;
  title: string;
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'notice';
  progress: number;
  note?: string;
  outputs?: string[];
  errors?: string[];
}

const root = document.getElementById('rows')!;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function rowHtml(r: Row): string {
  if (r.state === 'notice') return `<div class="row notice" data-id="${r.id}"><div class="title">${esc(r.title)}</div></div>`;
  const right =
    r.state === 'running'
      ? `<button class="btn" data-cancel="${r.id}">Cancel</button>`
      : r.state === 'done'
        ? `<span class="state">${icon('check', 18, 2)}</span>`
        : `<button class="btn" data-dismiss="${r.id}">${icon('close', 14)}</button>`;
  const bar =
    r.state === 'running'
      ? `<div class="bar${r.progress <= 0 ? ' indeterminate' : ''}"><i style="transform:scaleX(${r.progress <= 0 ? 1 : r.progress})"></i></div>`
      : '';
  let note = r.note ?? '';
  if (r.state === 'done') {
    const n = r.outputs?.length ?? 0;
    note = n === 1 ? 'Saved' : `Saved ${n} files`;
    if (r.errors?.length) note += ` · ${r.errors.length} failed\n${r.errors.join('\n')}`;
  }
  const outs =
    r.state === 'done' && r.outputs?.length
      ? `<div class="out">${r.outputs
          .slice(0, 3)
          .map((p) => `<button data-reveal="${esc(p)}" title="Show in folder">${icon('folder', 14)}${esc(base(p))}</button>`)
          .join('')}${r.outputs.length > 3 ? `<button data-reveal="${esc(r.outputs[0])}">+${r.outputs.length - 3} more</button>` : ''}</div>`
      : '';
  return `<div class="row ${r.state}" data-id="${r.id}">
    <div class="title">${esc(r.state === 'done' ? r.title.replace(/^Converting /, 'Converted ') : r.title)}</div>${right}
    ${note ? `<div class="note">${esc(note)}</div>` : ''}${bar}${outs}</div>`;
}

let last = '';
orange.on('hud:rows', (rows: Row[]) => {
  // Update bars in place when only progress changed, so animations stay smooth.
  const shape = rows.map((r) => `${r.id}:${r.state}:${r.note}:${r.outputs?.length}`).join('|');
  if (shape === last) {
    for (const r of rows) {
      const bar = root.querySelector<HTMLElement>(`.row[data-id="${r.id}"] .bar`);
      if (!bar) continue;
      bar.classList.toggle('indeterminate', r.progress <= 0);
      (bar.firstElementChild as HTMLElement).style.transform = `scaleX(${r.progress <= 0 ? 1 : r.progress})`;
    }
    return;
  }
  last = shape;
  root.innerHTML = rows.map(rowHtml).join('');
  requestAnimationFrame(() => orange.send('hud:height', root.scrollHeight + 8));
});

root.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('button');
  if (!t) return;
  if (t.dataset.cancel) orange.send('hud:cancel', Number(t.dataset.cancel));
  if (t.dataset.dismiss) orange.send('hud:dismiss', Number(t.dataset.dismiss));
  if (t.dataset.reveal) orange.send('hud:reveal', t.dataset.reveal);
});
root.addEventListener('dblclick', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-reveal]');
  if (t?.dataset.reveal) orange.send('hud:open', t.dataset.reveal);
});
root.addEventListener('mouseover', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (r) orange.send('hud:hold', Number(r.dataset.id), true);
});
root.addEventListener('mouseout', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (r && !r.contains(e.relatedTarget as Node)) orange.send('hud:hold', Number(r.dataset.id), false);
});
