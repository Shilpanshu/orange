// Clipboard popover: shows what's on the clipboard and offers formats to save it as.
// Keyboard: arrows move between choices, Enter picks, Esc closes.
import { icon } from '../shared/icons';

declare const orange: import('../../preload/preload').OrangeApi;

interface ClipContent {
  kind: 'image' | 'files' | 'text' | 'empty';
  thumb?: string;
  width?: number;
  height?: number;
  files?: string[];
  text?: string;
  chars?: number;
  lines?: number;
  html?: boolean;
  saveTo: string;
}

interface Choice {
  id: string;
  label: string;
  sub: string;
  wide?: boolean;
}

const COLS = 2;
const root = document.getElementById('pop')!;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

const CHOICES: Record<ClipContent['kind'], Choice[]> = {
  image: [
    { id: 'png', label: 'PNG', sub: 'Lossless' },
    { id: 'jpg', label: 'JPG', sub: 'Smaller, for photos' },
    { id: 'webp', label: 'WebP', sub: 'Small, for the web' },
    { id: 'pdf', label: 'PDF', sub: 'One page' },
    { id: 'copy-png', label: 'Copy as PNG', sub: 'Back to the clipboard', wide: true },
  ],
  text: [
    { id: 'txt', label: 'TXT', sub: 'Plain text' },
    { id: 'md', label: 'Markdown', sub: '.md file' },
    { id: 'pdf', label: 'PDF', sub: 'Formatted page' },
    { id: 'docx', label: 'Word', sub: '.docx document' },
  ],
  files: [{ id: 'wheel', label: 'Open the wheel', sub: 'Convert, tools and actions', wide: true }],
  empty: [],
};

function folderLabel(p: string) {
  const b = base(p);
  return /^downloads$/i.test(b) ? 'Downloads' : b || p;
}

function preview(c: ClipContent): string {
  if (c.kind === 'image') {
    return `<div class="thumb"><img src="${c.thumb}" alt="Image on the clipboard" /></div>
      <p class="meta">Image · ${c.width} × ${c.height} px</p>`;
  }
  if (c.kind === 'text') {
    return `<div class="text">${esc(c.text ?? '')}</div>
      <p class="meta">${c.html ? 'Formatted text' : 'Text'} · ${plural(c.chars ?? 0, 'character')} · ${plural(c.lines ?? 0, 'line')}</p>`;
  }
  if (c.kind === 'files') {
    const f = c.files ?? [];
    const shown = f.slice(0, 4).map((p) => `<li title="${esc(p)}">${icon('file', 14)}<span>${esc(base(p))}</span></li>`).join('');
    return `<ul class="files">${shown}${f.length > 4 ? `<li class="more">+${f.length - 4} more</li>` : ''}</ul>
      <p class="meta">${plural(f.length, 'file')} copied in Explorer</p>`;
  }
  return `<div class="empty">${icon('clipboard', 22)}<p>There's nothing on the clipboard that Orange can convert. Copy an image, some text, or files in Explorer.</p></div>`;
}

let buttons: HTMLButtonElement[] = [];

function render(c: ClipContent) {
  const choices = CHOICES[c.kind];
  const where = c.kind === 'files' ? '' : `Saves to ${esc(folderLabel(c.saveTo))}`;
  root.innerHTML = `
    <header><span class="mark">${icon('clipboard', 15)}</span><h1>Clipboard</h1></header>
    <section class="preview">${preview(c)}</section>
    ${
      choices.length
        ? `<h2>${c.kind === 'files' ? 'Files' : 'Save as'}</h2>
    <div class="choices" role="listbox" aria-label="Formats">${choices
      .map(
        (x, i) =>
          `<button class="choice${x.wide ? ' wide' : ''}" role="option" data-id="${x.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">
            <span class="label">${esc(x.label)}</span><span class="sub">${esc(x.sub)}</span></button>`,
      )
      .join('')}</div>`
        : ''
    }
    <footer><span>${where}</span><span class="keys"><kbd>Enter</kbd> pick <kbd>Esc</kbd> close</span></footer>`;
  buttons = [...root.querySelectorAll<HTMLButtonElement>('.choice')];
  buttons.forEach((b) => b.addEventListener('click', () => pick(b.dataset.id!)));
  buttons.forEach((b) => b.addEventListener('focus', () => buttons.forEach((x) => x.setAttribute('aria-selected', String(x === b)))));
  requestAnimationFrame(() => {
    orange.send('clip:height', Math.ceil(root.getBoundingClientRect().height) + 2);
    (buttons[0] ?? root).focus();
  });
}

function pick(id: string) {
  orange.send('clip:action', id);
}

/** Grid position of each button: wide ones take a whole row. */
function layout(): { row: number; col: number }[] {
  const pos: { row: number; col: number }[] = [];
  let row = 0;
  let col = 0;
  for (const b of buttons) {
    if (b.classList.contains('wide')) {
      if (col) (row++, (col = 0));
      pos.push({ row, col: 0 });
      row++;
      continue;
    }
    pos.push({ row, col });
    if (++col === COLS) (row++, (col = 0));
  }
  return pos;
}

function move(key: string) {
  if (!buttons.length) return;
  const i = Math.max(0, buttons.findIndex((b) => b.getAttribute('aria-selected') === 'true'));
  const pos = layout();
  const here = pos[i];
  let target = i;
  if (key === 'ArrowRight') target = Math.min(buttons.length - 1, i + 1);
  else if (key === 'ArrowLeft') target = Math.max(0, i - 1);
  else {
    const dir = key === 'ArrowDown' ? 1 : -1;
    const row = here.row + dir;
    const inRow = pos.map((p, j) => ({ ...p, j })).filter((p) => p.row === row);
    if (inRow.length) target = (inRow.find((p) => p.col === here.col) ?? inRow[inRow.length - 1]).j;
  }
  buttons.forEach((b, j) => {
    b.tabIndex = j === target ? 0 : -1;
    b.setAttribute('aria-selected', String(j === target));
  });
  buttons[target].focus();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    orange.send('clip:close');
  } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    move(e.key);
  } else if (e.key === 'Enter') {
    const b = buttons.find((x) => x.getAttribute('aria-selected') === 'true') ?? buttons[0];
    if (b) {
      e.preventDefault();
      pick(b.dataset.id!);
    }
  }
});

orange.on('clip:content', (c: ClipContent) => render(c));
