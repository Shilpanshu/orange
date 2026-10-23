// Rename: build a new name from ordered steps (replace, prefix/suffix, number, case, date) and see the
// result for every item before anything changes. The main process renames all-or-nothing.
import { api, base, checkbox, dir, field, h, iconButton, numberInput, section, segmented, shell } from '../../shared/ui';
import { icon } from '../../shared/icons';

interface Info {
  path: string;
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}
interface DateInfo {
  ms: number;
  source: 'photo' | 'media' | 'modified';
}

type StepType = 'replace' | 'affix' | 'number' | 'case' | 'date';
type Pos = 'prefix' | 'suffix' | 'replace';
interface Step {
  id: number;
  type: StepType;
  find: string;
  with: string;
  regex: boolean;
  matchCase: boolean;
  prefix: string;
  suffix: string;
  start: number;
  by: number;
  pad: number;
  pos: Pos;
  sep: string;
  caseMode: 'lower' | 'upper' | 'title' | 'sentence';
  format: string;
}

const STEP_LABEL: Record<StepType, string> = {
  replace: 'Replace text',
  affix: 'Add text',
  number: 'Number',
  case: 'Change case',
  date: 'Date',
};

const DATE_FORMATS: { value: string; label: string }[] = [
  { value: 'YYYY-MM-DD', label: '2026-10-21' },
  { value: 'YYYY-MM-DD HH-mm-ss', label: '2026-10-21 14-03-22' },
  { value: 'YYYYMMDD_HHmmss', label: '20261021_140322' },
  { value: 'YYYYMMDD', label: '20261021' },
  { value: 'YYYY-MM', label: '2026-10' },
  { value: 'DD-MM-YYYY', label: '21-10-2026' },
];

// Small direction glyphs (the shared set only has a diagonal arrow).
const svg = (d: string, size = 15) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const CHEVRON_UP = svg('M6 15l6-6 6 6');
const CHEVRON_DOWN = svg('M6 9l6 6 6-6');
const ARROW_RIGHT = svg('M5 12h14M13 6l6 6-6 6', 14);

let seq = 0;
function newStep(type: StepType): Step {
  return {
    id: ++seq,
    type,
    find: '',
    with: '',
    regex: false,
    matchCase: false,
    prefix: '',
    suffix: '',
    start: 1,
    by: 1,
    pad: 2,
    pos: type === 'date' ? 'prefix' : 'suffix',
    sep: type === 'date' ? ' ' : ' ',
    caseMode: 'title',
    format: 'YYYY-MM-DD',
  };
}

// ------------------------------------------------------------------ naming

const INVALID = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export function nameProblem(name: string): string | null {
  if (!name.trim()) return 'Empty name';
  if (INVALID.test(name)) return 'Not allowed: < > : " / \\ | ? *';
  if (/[. ]$/.test(name)) return 'Ends with a dot or space';
  if (RESERVED.test(name)) return 'Reserved by Windows';
  if (name.length > 255) return 'Longer than 255 characters';
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export function formatDate(ms: number, fmt: string): string {
  const d = new Date(ms);
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
  };
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => map[t]);
}

function titleCase(s: string) {
  return s.toLocaleLowerCase().replace(/(^|[\s_\-.(\[])(\p{L})/gu, (_m, a: string, b: string) => a + b.toLocaleUpperCase());
}
function sentenceCase(s: string) {
  const low = s.toLocaleLowerCase();
  return low.replace(/\p{L}/u, (c) => c.toLocaleUpperCase());
}

function place(stem: string, text: string, pos: Pos, sep: string) {
  if (pos === 'replace') return text;
  if (!stem) return text;
  return pos === 'prefix' ? `${text}${sep}${stem}` : `${stem}${sep}${text}`;
}

export function buildRegex(step: Step): RegExp | null {
  if (!step.find) return null;
  const flags = step.matchCase ? 'g' : 'gi';
  try {
    return new RegExp(step.regex ? step.find : step.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch {
    return null;
  }
}

interface Ctx {
  index: number;
  date?: number;
}

function applyStep(step: Step, stem: string, c: Ctx): string {
  switch (step.type) {
    case 'replace': {
      const re = buildRegex(step);
      if (!re) return stem;
      // Plain mode inserts the replacement literally; regex mode allows $1 references.
      return step.regex ? stem.replace(re, step.with) : stem.replace(re, () => step.with);
    }
    case 'affix':
      return `${step.prefix}${stem}${step.suffix}`;
    case 'number': {
      const n = step.start + c.index * step.by;
      const txt = (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(step.pad, '0');
      return place(stem, txt, step.pos, step.sep);
    }
    case 'case':
      return step.caseMode === 'lower'
        ? stem.toLocaleLowerCase()
        : step.caseMode === 'upper'
          ? stem.toLocaleUpperCase()
          : step.caseMode === 'title'
            ? titleCase(stem)
            : sentenceCase(stem);
    case 'date':
      if (c.date === undefined) return stem;
      return place(stem, formatDate(c.date, step.format), step.pos, step.sep);
  }
}

export function splitName(name: string, isDir: boolean, keepExt: boolean): [string, string] {
  if (isDir || !keepExt) return [name, ''];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// ------------------------------------------------------------------ window

export async function rename(paths: string[]) {
  const s = shell({ title: 'Rename', file: paths.length === 1 ? base(paths[0]) : `${paths.length} items`, layout: 'split', wide: true, plainStage: true });
  s.primary.textContent = 'Rename';
  s.primary.disabled = true;
  s.stage.classList.add('rn-stage');
  s.panel.classList.add('rn-panel');

  const head = h('div', { class: 'rn-head' }, h('div', { class: 'skeleton ut-sk-line' }));
  const table = h('div', { class: 'rn-table', role: 'table', 'aria-label': 'Preview of the new names' });
  const tableHead = h(
    'div',
    { class: 'rn-row rn-th', role: 'row' },
    h('span', { class: 'rn-n', role: 'columnheader' }, '#'),
    h('span', { class: 'rn-old', role: 'columnheader' }, 'Current name'),
    h('span', { class: 'rn-arrow', 'aria-hidden': 'true' }),
    h('span', { class: 'rn-new', role: 'columnheader' }, 'New name'),
  );
  const body = h('div', { class: 'rn-body', role: 'rowgroup' }, ...paths.slice(0, 8).map(() => h('div', { class: 'rn-row' }, h('span', { class: 'skeleton rn-sk' }))));
  table.append(tableHead, body);
  s.stage.append(head, table);

  // --------------------------------------------------------------- state
  const steps: Step[] = [newStep('replace')];
  let keepExt = true;
  let order: 'given' | 'name' | 'date' | 'size' = 'given';
  let dates: Record<string, DateInfo> | null = null;
  let datesLoading = false;
  let existing = new Set<string>();
  let applied: string[] | null = null;

  const infos = await api().invoke<Info[]>('rename:info', paths);
  const selected = new Set(infos.map((i) => i.path.toLowerCase()));

  // -------------------------------------------------------------- panel
  const stepsEl = h('div', { class: 'rn-steps' });
  const addSel = h(
    'select',
    { class: 'rn-add', 'aria-label': 'Add a step' },
    h('option', { value: '' }, 'Add a step…'),
    ...(Object.keys(STEP_LABEL) as StepType[]).map((t) => h('option', { value: t }, STEP_LABEL[t])),
  ) as HTMLSelectElement;
  addSel.addEventListener('change', () => {
    const t = addSel.value as StepType;
    addSel.value = '';
    if (!t) return;
    const st = newStep(t);
    steps.push(st);
    renderSteps(st.id);
    recompute();
  });
  const orderSel = h(
    'select',
    { onchange: (e: Event) => ((order = (e.target as HTMLSelectElement).value as typeof order), order === 'date' && loadDates(), recompute()) },
    h('option', { value: 'given' }, 'As selected'),
    h('option', { value: 'name' }, 'By name'),
    h('option', { value: 'date' }, 'By date'),
    h('option', { value: 'size' }, 'By size'),
  );
  s.panel.append(
    section('Steps', stepsEl, addSel),
    section(
      'Options',
      checkbox('Keep the original extension', keepExt, (v) => ((keepExt = v), recompute())),
      field('Order for numbering', orderSel),
      h('p', { class: 'hint' }, 'Steps run from top to bottom. By date uses the date a photo or video was taken when it has one.'),
    ),
  );

  function renderSteps(focusId?: number) {
    stepsEl.replaceChildren(...steps.map((st, i) => stepCard(st, i)));
    if (focusId) stepsEl.querySelector<HTMLElement>(`[data-step="${focusId}"] input, [data-step="${focusId}"] select`)?.focus();
  }

  function stepCard(st: Step, i: number) {
    const ch = () => recompute();
    const text = (val: string, set: (v: string) => void, ph = '', label = '') => {
      const el = h('input', { type: 'text', placeholder: ph, spellcheck: false, 'aria-label': label || ph }) as HTMLInputElement;
      el.value = val;
      el.addEventListener('input', () => (set(el.value), ch()));
      return el;
    };
    const posSeg = (withReplace: boolean) =>
      segmented<Pos>(
        [{ value: 'prefix', label: 'Before' }, { value: 'suffix', label: 'After' }, ...(withReplace ? [{ value: 'replace' as Pos, label: 'Instead' }] : [])],
        st.pos,
        (v) => ((st.pos = v), ch()),
      );
    let bodyEls: Node[] = [];
    switch (st.type) {
      case 'replace': {
        const findEl = text(st.find, (v) => (st.find = v), 'Find', 'Find');
        const err = h('p', { class: 'rn-step-err' });
        const check = () => {
          err.textContent = st.find && st.regex && !buildRegex(st) ? 'This pattern is not a valid regular expression.' : '';
          findEl.classList.toggle('invalid', !!err.textContent);
        };
        findEl.addEventListener('input', check);
        bodyEls = [
          findEl,
          text(st.with, (v) => (st.with = v), 'Replace with (empty removes it)', 'Replace with'),
          h(
            'div',
            { class: 'rn-checks' },
            checkbox('Match case', st.matchCase, (v) => ((st.matchCase = v), ch())),
            checkbox('Regular expression', st.regex, (v) => ((st.regex = v), check(), ch())),
          ),
          err,
        ];
        queueMicrotask(check);
        break;
      }
      case 'affix':
        bodyEls = [h('div', { class: 'row' }, text(st.prefix, (v) => (st.prefix = v), 'Prefix'), text(st.suffix, (v) => (st.suffix = v), 'Suffix'))];
        break;
      case 'number':
        bodyEls = [
          h(
            'div',
            { class: 'rn-grid3' },
            h('label', {}, h('span', {}, 'Start'), numberInput(st.start, (v) => ((st.start = v), ch()), { min: -99999, max: 999999 })),
            h('label', {}, h('span', {}, 'Step'), numberInput(st.by, (v) => ((st.by = v), ch()), { min: -1000, max: 1000 })),
            h('label', {}, h('span', {}, 'Digits'), numberInput(st.pad, (v) => ((st.pad = v), ch()), { min: 1, max: 8 })),
          ),
          posSeg(true),
          sepField(st, ch),
        ];
        break;
      case 'case':
        bodyEls = [
          segmented(
            [
              { value: 'lower', label: 'lower' },
              { value: 'upper', label: 'UPPER' },
              { value: 'title', label: 'Title' },
              { value: 'sentence', label: 'Sentence' },
            ],
            st.caseMode,
            (v) => ((st.caseMode = v), ch()),
          ),
        ];
        break;
      case 'date': {
        const fmt = h('select', { 'aria-label': 'Date format', onchange: (e: Event) => ((st.format = (e.target as HTMLSelectElement).value), ch()) }, ...DATE_FORMATS.map((f) => h('option', { value: f.value }, f.label))) as HTMLSelectElement;
        fmt.value = st.format;
        bodyEls = [fmt, posSeg(true), sepField(st, ch), h('p', { class: 'hint' }, 'Date taken for photos, recording date for video and audio, otherwise the date modified.')];
        loadDates();
        break;
      }
    }
    const typeSel = h('select', { class: 'rn-type', 'aria-label': 'Step type' }, ...(Object.keys(STEP_LABEL) as StepType[]).map((t) => h('option', { value: t }, STEP_LABEL[t]))) as HTMLSelectElement;
    typeSel.value = st.type;
    typeSel.addEventListener('change', () => {
      const fresh = newStep(typeSel.value as StepType);
      steps[i] = { ...fresh, id: st.id };
      renderSteps(st.id);
      recompute();
    });
    const move = (d: number) => {
      const j = i + d;
      if (j < 0 || j >= steps.length) return;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      renderSteps();
      recompute();
    };
    return h(
      'div',
      { class: 'rn-step', 'data-step': st.id },
      h(
        'div',
        { class: 'rn-step-head' },
        h('span', { class: 'rn-step-n' }, String(i + 1)),
        typeSel,
        h('button', { class: `btn icon ghost${i === 0 ? ' rn-dim' : ''}`, title: 'Move up', 'aria-label': 'Move up', html: CHEVRON_UP, onclick: () => move(-1) }),
        h('button', { class: `btn icon ghost${i === steps.length - 1 ? ' rn-dim' : ''}`, title: 'Move down', 'aria-label': 'Move down', html: CHEVRON_DOWN, onclick: () => move(1) }),
        iconButton('close', 'Remove step', () => {
          steps.splice(i, 1);
          renderSteps();
          recompute();
        }),
      ),
      ...bodyEls,
    );
  }

  function sepField(st: Step, ch: () => void) {
    const sel = h(
      'select',
      { 'aria-label': 'Separator', onchange: (e: Event) => ((st.sep = (e.target as HTMLSelectElement).value), ch()) },
      ...[
        [' ', 'Space'],
        ['_', 'Underscore  _'],
        ['-', 'Hyphen  -'],
        [' - ', 'Spaced hyphen  " - "'],
        ['', 'Nothing'],
      ].map(([v, l]) => h('option', { value: v }, l)),
    ) as HTMLSelectElement;
    sel.value = st.sep;
    return h('div', { class: 'rn-inline' }, h('span', { class: 'muted' }, 'Separator'), sel);
  }

  async function loadDates() {
    if (dates || datesLoading) return;
    datesLoading = true;
    recompute();
    dates = await api().invoke<Record<string, DateInfo>>('rename:dates', paths).catch(() => ({}));
    datesLoading = false;
    recompute();
  }

  // ------------------------------------------------------------ compute
  interface Row {
    info: Info;
    next: string;
    problem: string | null;
    changed: boolean;
  }
  let rows: Row[] = [];
  let checkSeq = 0;

  function sorted(): Info[] {
    const list = [...infos];
    const dateOf = (i: Info) => dates?.[i.path]?.ms ?? i.mtime;
    if (order === 'name') list.sort((a, b) => collator.compare(a.name, b.name));
    else if (order === 'date') list.sort((a, b) => dateOf(a) - dateOf(b) || collator.compare(a.name, b.name));
    else if (order === 'size') list.sort((a, b) => a.size - b.size || collator.compare(a.name, b.name));
    return list;
  }

  function recompute() {
    if (applied) return;
    const list = sorted();
    rows = list.map((info, index) => {
      const [stem0, ext] = splitName(info.name, info.dir, keepExt);
      let stem = stem0;
      for (const st of steps) stem = applyStep(st, stem, { index, date: dates?.[info.path]?.ms });
      const next = stem + ext;
      return { info, next, problem: null, changed: next !== info.name };
    });
    // Problems: invalid names, two items with one name, or a name taken by something not being renamed.
    const count = new Map<string, number>();
    for (const r of rows) {
      const k = `${dir(r.info.path)}\\${r.next}`.toLowerCase();
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    for (const r of rows) {
      if (!r.changed) continue;
      const full = `${dir(r.info.path)}\\${r.next}`;
      r.problem =
        nameProblem(r.next) ??
        ((count.get(full.toLowerCase()) ?? 0) > 1 ? 'Same name as another item' : null) ??
        (existing.has(full.toLowerCase()) && !selected.has(full.toLowerCase()) ? 'A file with this name already exists' : null);
    }
    render();
    // Ask the main process which targets already exist (debounced; results come back async).
    const mine = ++checkSeq;
    const targets = rows.filter((r) => r.changed && !nameProblem(r.next)).map((r) => `${dir(r.info.path)}\\${r.next}`);
    setTimeout(async () => {
      if (mine !== checkSeq || !targets.length) return;
      const ex = await api().invoke<string[]>('rename:existing', targets).catch(() => [] as string[]);
      if (mine !== checkSeq) return;
      const next = new Set(ex.map((x) => x.toLowerCase()));
      const same = next.size === existing.size && [...next].every((x) => existing.has(x));
      existing = next;
      if (!same) recompute();
    }, 120);
  }

  function highlight(oldName: string, newName: string): Node[] {
    // Mark the part that changed between a common prefix and suffix.
    let a = 0;
    while (a < oldName.length && a < newName.length && oldName[a] === newName[a]) a++;
    let b = 0;
    while (b < oldName.length - a && b < newName.length - a && oldName[oldName.length - 1 - b] === newName[newName.length - 1 - b]) b++;
    const mid = newName.slice(a, newName.length - b);
    return [newName.slice(0, a), mid ? h('mark', {}, mid) : '', newName.slice(newName.length - b)].filter((x) => x !== '') as Node[];
  }

  function render() {
    const changed = rows.filter((r) => r.changed);
    const bad = changed.filter((r) => r.problem);
    head.replaceChildren(
      h(
        'div',
        { class: 'rn-summary' },
        h('strong', {}, changed.length ? `${changed.length} of ${rows.length} will be renamed` : 'No names change yet'),
        bad.length ? h('span', { class: 'rn-bad-count' }, `${bad.length} ${bad.length === 1 ? 'problem' : 'problems'}`) : null,
        datesLoading ? h('span', { class: 'muted' }, 'Reading dates…') : null,
      ),
    );
    body.replaceChildren(
      ...rows.map((r, i) =>
        h(
          'div',
          { class: `rn-row${r.changed ? ' changed' : ''}${r.problem ? ' bad' : ''}`, role: 'row', title: r.info.path },
          h('span', { class: 'rn-n', role: 'cell' }, String(i + 1)),
          h('span', { class: 'rn-old', role: 'cell' }, h('span', { class: 'rn-kind', html: icon(r.info.dir ? 'folder' : 'file', 14) }), h('span', { class: 'rn-text' }, r.info.name)),
          h('span', { class: 'rn-arrow', 'aria-hidden': 'true', html: r.changed ? ARROW_RIGHT : '' }),
          h(
            'span',
            { class: 'rn-new', role: 'cell' },
            r.changed ? h('span', { class: 'rn-text' }, ...highlight(r.info.name, r.next)) : h('span', { class: 'rn-same' }, 'No change'),
            r.problem ? h('span', { class: 'rn-problem' }, r.problem) : null,
          ),
        ),
      ),
    );
    s.primary.disabled = !changed.length || bad.length > 0;
    s.primary.textContent = changed.length ? `Rename ${changed.length}` : 'Rename';
    s.status.textContent = bad.length ? 'Fix the highlighted names to continue' : '';
  }

  renderSteps();
  recompute();
  requestAnimationFrame(() => stepsEl.querySelector<HTMLInputElement>('input')?.focus());

  // -------------------------------------------------------------- apply
  s.primary.addEventListener('click', async () => {
    if (applied) return api().send('window:close');
    const pairs = rows.filter((r) => r.changed).map((r) => ({ from: r.info.path, name: r.next }));
    if (!pairs.length || rows.some((r) => r.problem)) return;
    s.primary.disabled = true;
    s.primary.textContent = 'Renaming…';
    const out = await api().invoke<string[]>('tool:run', 'rename', paths, { pairs }).catch(() => [] as string[]);
    if (!out.length) {
      // The HUD shows why; refresh the preview in case files changed underneath.
      s.status.textContent = 'Nothing was renamed. See the message in the corner.';
      existing = new Set();
      recompute();
      return;
    }
    applied = out;
    head.replaceChildren(h('div', { class: 'rn-summary' }, h('strong', {}, `Renamed ${out.length} ${out.length === 1 ? 'item' : 'items'}`)));
    body.querySelectorAll('.rn-row.changed').forEach((r) => r.classList.add('done'));
    s.panel.classList.add('rn-dim-panel');
    s.status.textContent = 'Done';
    s.cancel.remove();
    const undo = h('button', { class: 'btn' }, h('span', { html: icon('undo', 16) }), 'Undo');
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      const r = await api().invoke<{ ok: boolean; message: string }>('rename:undo');
      s.status.textContent = r.message;
      if (r.ok) {
        undo.remove();
        body.querySelectorAll('.rn-row.done').forEach((x) => x.classList.remove('done'));
        head.replaceChildren(h('div', { class: 'rn-summary' }, h('strong', {}, 'Original names restored')));
      } else undo.disabled = false;
    });
    s.primary.before(undo);
    s.primary.textContent = 'Close';
    s.primary.disabled = false;
  });
}
