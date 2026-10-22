import { icon } from '../shared/icons';

declare const orange: import('../../preload/preload').OrangeApi;

// This window takes no drops: show the no-drop cursor and ignore a dropped file.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (e) => e.preventDefault());

interface Row {
  id: number;
  title: string;
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'notice';
  progress: number;
  note?: string;
  outputs?: string[];
  errors?: string[];
  undoable?: boolean;
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
        : `<button class="btn" data-dismiss="${r.id}" title="Dismiss" aria-label="Dismiss">${icon('close', 14)}</button>`;
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
  const undo = r.state === 'done' && r.undoable ? `<button class="undo" data-undo="${r.id}" title="Move the new files to the Recycle Bin">${icon('undo', 14)}Undo</button>` : '';
  const outs =
    r.state === 'done' && r.outputs?.length
      ? `<div class="out">${r.outputs
          .slice(0, 3)
          .map((p) => `<button data-reveal="${esc(p)}" title="${esc(base(p))}
Click to show in folder, double-click to open">${icon('folder', 14)}<span>${esc(base(p))}</span></button>`)
          .join('')}${r.outputs.length > 3 ? `<button data-reveal="${esc(r.outputs[0])}" title="Show in folder">+${r.outputs.length - 3} more</button>` : ''}${undo}</div>`
      : undo
        ? `<div class="out">${undo}</div>`
        : '';
  return `<div class="row ${r.state}" data-id="${r.id}">
    <div class="title" title="${esc(r.state === 'done' ? r.title.replace(/^Converting /, 'Converted ') : r.title)}">${esc(r.state === 'done' ? r.title.replace(/^Converting /, 'Converted ') : r.title)}</div>${right}
    ${note ? `<div class="note" title="${esc(note)}">${esc(note)}</div>` : ''}${bar}${outs}</div>`;
}

let last = '';
let sentHeight = 0;
// The main process sizes and places the window from this; after an in-place note change it is
// only re-sent when the height actually changed.
const fitWindow = (onlyIfChanged = false) =>
  requestAnimationFrame(() => {
    const hgt = root.scrollHeight + 8;
    if (!onlyIfChanged || hgt !== sentHeight) orange.send('hud:height', (sentHeight = hgt));
  });
const seen = new Set<number>(); // rows already on screen: they don't play the entrance again
orange.on('hud:rows', (rows: Row[]) => {
  // Progress ticks only move bars and change notes: update those in place (no re-render, no
  // re-measuring the window) so the bars glide and nothing re-animates. A running row's note
  // ("Page 3 of 12", "Saved 2 of 5") changes on most ticks, so only whether it has one counts.
  const shape = rows.map((r) => `${r.id}:${r.state}:${r.state === 'running' ? !!r.note : r.note}:${r.outputs?.length}`).join('|');
  if (shape === last) {
    let noted = false;
    for (const r of rows) {
      const row = root.querySelector<HTMLElement>(`.row[data-id="${r.id}"]`);
      if (!row) continue;
      const bar = row.querySelector<HTMLElement>('.bar');
      if (bar) {
        bar.classList.toggle('indeterminate', r.progress <= 0);
        (bar.firstElementChild as HTMLElement).style.transform = `scaleX(${r.progress <= 0 ? 1 : r.progress})`;
      }
      const note = row.querySelector<HTMLElement>('.note');
      if (note && r.state === 'running' && note.textContent !== (r.note ?? '')) {
        note.textContent = note.title = r.note ?? '';
        noted = true;
      }
    }
    // A longer note can wrap onto another line: re-measure only then.
    if (noted) fitWindow(true);
    return;
  }
  last = shape;
  root.innerHTML = rows.map(rowHtml).join('');
  for (const el of root.children) if (seen.has(Number((el as HTMLElement).dataset.id))) el.classList.add('seen');
  seen.clear();
  for (const r of rows) seen.add(r.id);
  fitWindow();
});

root.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('button');
  if (!t) return;
  if (t.dataset.cancel) orange.send('hud:cancel', Number(t.dataset.cancel));
  if (t.dataset.dismiss) orange.send('hud:dismiss', Number(t.dataset.dismiss));
  if (t.dataset.reveal) orange.send('hud:reveal', t.dataset.reveal);
  if (t.dataset.undo) {
    (t as HTMLButtonElement).disabled = true;
    orange.send('hud:undo', Number(t.dataset.undo));
  }
});

// A short, quiet two-note chime when a job finishes (only when Settings → Sounds is on).
let audio: AudioContext | null = null;
orange.on('hud:chime', () => {
  try {
    audio ??= new AudioContext();
    const t0 = audio.currentTime;
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.06, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.34);
    }
  } catch {
    /* audio is optional */
  }
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
