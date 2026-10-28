// OCR: makes scans and photos of documents searchable (an invisible text layer placed over the
// original pages), or extracts their text as TXT or Markdown. Tesseract runs on this PC; English
// is built in and other languages download once (1–3 MB each).
import { api, base, checkbox, enablePresets, extOf, h, loadImage, runAndClose, section, segmented, shell } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { aiStatus, fmtDuration, fmtMB, type AiStatus } from './common';

interface Opts {
  output: 'pdf' | 'txt' | 'md';
  langs: string[];
  combine: boolean;
}

interface Lang {
  code: string;
  name: string;
  mb: number;
  ready: boolean;
}

const OUTPUT_HINT: Record<Opts['output'], string> = {
  pdf: 'Looks exactly like the original, but you can search, select and copy the text. PDF pages that already have text are kept as they are.',
  txt: 'Plain text, one file per document.',
  md: 'Text with paragraphs and headings kept, ready for notes apps.',
};
const PRIMARY: Record<Opts['output'], string> = { pdf: 'Make searchable', txt: 'Extract text', md: 'Extract text' };
const MAX_LANGS = 3;
// Small "downloads once" mark on language chips.
const DOWNLOAD_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

export async function ocrPage(paths: string[]) {
  const s = shell({ title: 'OCR', file: paths.length === 1 ? base(paths[0]) : `${paths.length} files` });
  s.stage.classList.add('plain', 'ai-files-stage');
  const o: Opts = { output: 'pdf', langs: ['eng'], combine: false };
  let st: AiStatus | null = null;
  const images = paths.filter((p) => extOf(p) !== 'pdf');

  // ---------------------------------------------------------------- stage: the files
  const list = h('div', { class: 'ai-files' });
  const head = h('div', { class: 'ai-files-head' }, h('strong', {}, paths.length === 1 ? 'Your file' : `${paths.length} files`), h('span', { class: 'muted' }, 'Everything is read on this PC.'));
  const rows = new Map<string, { detail: HTMLElement }>();
  for (const p of paths) {
    const pdf = extOf(p) === 'pdf';
    const thumb = h('div', { class: 'ai-file-thumb skeleton' });
    const detail = h('span', { class: 'muted' }, pdf ? 'Checking pages…' : 'Image');
    list.append(h('div', { class: 'ai-file' }, thumb, h('div', { class: 'ai-file-text' }, h('span', { class: 'name', title: p }, base(p)), detail)));
    rows.set(p, { detail });
    if (pdf) {
      thumb.classList.remove('skeleton');
      thumb.innerHTML = icon('pdf', 22);
    } else {
      void loadImage(p)
        .then((img) => {
          thumb.classList.remove('skeleton');
          thumb.append(h('img', { src: img.src, alt: '' }));
        })
        .catch(() => thumb.classList.remove('skeleton'));
    }
  }
  s.stage.append(h('div', { class: 'ai-files-wrap' }, head, list));

  // ---------------------------------------------------------------- panel
  const outHint = h('p', { class: 'hint' }, OUTPUT_HINT[o.output]);
  const combine = checkbox('Combine the images into one PDF', o.combine, (v) => (o.combine = v));
  combine.hidden = images.length < 2;
  const outSeg = segmented(
    [
      { value: 'pdf', label: 'Searchable PDF' },
      { value: 'txt', label: 'Text' },
      { value: 'md', label: 'Markdown' },
    ],
    'pdf',
    (v) => {
      o.output = v as Opts['output'];
      outHint.textContent = OUTPUT_HINT[o.output];
      combine.hidden = images.length < 2 || o.output !== 'pdf';
      s.primary.textContent = PRIMARY[o.output];
      void update();
    },
  );
  s.primary.textContent = PRIMARY[o.output];

  const langWrap = h('div', { class: 'ai-langs', role: 'group', 'aria-label': 'Languages in the document' });
  const langNote = h('p', { class: 'hint' });
  const langs: Lang[] = await api().invoke<Lang[]>('ai:langs');
  const renderLangs = () => {
    langWrap.replaceChildren(
      ...langs.map((l) => {
        const on = o.langs.includes(l.code);
        return h(
          'button',
          {
            class: `ai-chip${on ? ' on' : ''}`,
            'aria-pressed': String(on),
            title: l.ready ? `${l.name}` : `${l.name}: downloads ${fmtMB(l.mb)} once`,
            onclick: () => {
              if (on) {
                if (o.langs.length > 1) o.langs = o.langs.filter((c) => c !== l.code);
              } else {
                o.langs = [...o.langs, l.code].slice(-MAX_LANGS);
              }
              renderLangs();
              void update();
            },
          },
          l.name,
          l.ready ? null : h('span', { class: 'ai-chip-dl', 'aria-hidden': 'true', html: DOWNLOAD_SVG }),
        );
      }),
    );
    const extra = langs.filter((l) => o.langs.includes(l.code) && !l.ready);
    langNote.textContent =
      (o.langs.length > 1 ? `Reading as ${o.langs.map((c) => langs.find((l) => l.code === c)?.name).join(' + ')}. ` : 'Pick every language the document uses, up to three. ') +
      (extra.length ? `${extra.map((l) => l.name).join(', ')} downloads once (${fmtMB(extra.reduce((a, l) => a + l.mb, 0))}).` : '');
  };
  renderLangs();

  const timeRow = h('div', { class: 'ai-kv' });
  const pagesRow = h('div', { class: 'ai-kv' });
  s.panel.append(
    section('Output', h('div', { class: 'field' }, outSeg), outHint, combine),
    section('Language', langWrap, langNote),
    section('Estimate', pagesRow, timeRow, h('p', { class: 'hint ai-licence' }, 'Tesseract OCR (Apache-2.0). Accuracy is best on straight, sharp scans of 300 DPI or more.')),
  );

  let seq = 0;
  async function update() {
    const my = ++seq;
    st = await aiStatus('ocr', paths, o);
    if (my !== seq) return;
    let pages = 0;
    let skip = 0;
    for (const f of st.files) {
      const r = rows.get(f.path);
      if (f.pages !== undefined) {
        const has = f.pages - (f.todo ?? 0);
        pages += f.todo ?? 0;
        skip += has;
        if (r)
          r.detail.textContent = !f.pages
            ? "PDF · couldn't count the pages"
            : `PDF · ${f.pages.toLocaleString()} page${f.pages === 1 ? '' : 's'}` + (has ? (f.todo ? ` · ${has.toLocaleString()} already ${has === 1 ? 'has' : 'have'} text` : ' · already searchable') : '');
      } else {
        pages += 1;
        if (r && f.w) r.detail.textContent = `Image · ${f.w} × ${f.h}`;
      }
    }
    pagesRow.replaceChildren(h('span', {}, 'Pages to read'), h('strong', {}, pages.toLocaleString() + (skip ? ` (${skip.toLocaleString()} skipped)` : '')));
    timeRow.replaceChildren(h('span', {}, 'Time'), h('strong', {}, pages ? fmtDuration(st.ms) : '–'));
    const nothing = pages === 0 && o.output === 'pdf';
    s.primary.disabled = nothing;
    s.status.textContent = nothing ? st.note ?? 'Nothing needs OCR.' : st.downloadMB > 0 ? `Downloads ${fmtMB(st.downloadMB)} of language data first.` : '';
  }
  await update();

  s.primary.onclick = () => runAndClose(s.primary, 'ocr', paths, { ...o, langs: [...o.langs] }, s.status);
  enablePresets?.('ocr', () => ({ ...o, langs: [...o.langs] }));
}
