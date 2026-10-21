// Compress: one window for any selection. Each kind of file present gets its own small set of
// options; the list shows the original size and an estimate that updates as settings change.
import { api, base, checkbox, field, fmtBytes, h, numberInput, section, segmented, shell, slider } from '../../shared/ui';
import { icon } from '../../shared/icons';

type CKind = 'image' | 'video' | 'audio' | 'pdf' | 'office' | 'zip';
interface Info {
  path: string;
  kind: CKind;
  size: number;
  dir?: boolean;
  duration?: number;
  width?: number;
  height?: number;
  kbps?: number;
  audioKbps?: number;
  hasAudio?: boolean;
  outExt?: string;
  error?: string;
}
type Level = 'printer' | 'ebook' | 'screen';

const KIND_ICON: Record<CKind, string> = { image: 'image', video: 'frames', audio: 'wave', pdf: 'pdf', office: 'file', zip: 'extract' };
const LEVELS: { value: Level; label: string }[] = [
  { value: 'printer', label: 'Light' },
  { value: 'ebook', label: 'Balanced' },
  { value: 'screen', label: 'Strong' },
];

export async function compress(paths: string[]) {
  const s = shell({ title: 'Compress', file: paths.length === 1 ? base(paths[0]) : `${paths.length} items`, layout: 'full' });
  s.primary.textContent = 'Compress';
  s.primary.disabled = true;
  s.full.classList.add('fc-compress');

  // ------------------------------------------------------------- state
  const opts = {
    image: { mode: 'quality' as 'quality' | 'size' | 'percent', quality: 72, targetBytes: 500 * 1024, percent: 50, maxEdge: 0, strip: true },
    video: { mode: 'preset' as 'preset' | 'size', preset: 'medium' as 'high' | 'medium' | 'small', targetMB: 25, height: 0 },
    audio: { kbps: 128 },
    pdf: { level: 'ebook' as Level },
    office: { level: 'ebook' as Level },
  };
  const estimates = new Map<string, number>(); // bytes; -1 = can't estimate
  let infos: Info[] = [];
  let done = false;
  const rowsUsed = new Set<string>(); // outputs already matched to a row

  // skeleton while probing
  const summary = h('div', { class: 'fc-summary' }, h('div', { class: 'skeleton fc-sk-big' }), h('div', { class: 'skeleton fc-sk-line' }));
  const list = h('div', { class: 'fc-files' }, ...paths.slice(0, 4).map(() => h('div', { class: 'skeleton fc-sk-row' })));
  const optionsEl = h('div', { class: 'fc-options' });
  s.full.append(summary, list, optionsEl);

  infos = await api().invoke<Info[]>('compress:probe', paths);
  const by = (k: CKind) => infos.filter((i) => i.kind === k);

  // ----------------------------------------------------------- options
  const sections: HTMLElement[] = [];
  const imgs = by('image');
  if (imgs.length) {
    const qSlider = slider({ label: 'Quality', min: 10, max: 100, value: opts.image.quality, format: (v) => `${v}`, onInput: (v) => ((opts.image.quality = v), estimateImages()) });
    const unit = h('select', { class: 'fc-unit' }, h('option', { value: '1024' }, 'KB'), h('option', { value: '1048576' }, 'MB')) as HTMLSelectElement;
    const sizeNum = numberInput(500, () => setTarget(), { min: 1, step: 1 });
    const setTarget = () => {
      opts.image.targetBytes = Math.max(1, Number(sizeNum.value)) * Number(unit.value);
      estimateImages();
    };
    unit.addEventListener('change', setTarget);
    const sizeField = field(imgs.length > 1 ? 'Largest size per image' : 'Largest file size', h('div', { class: 'row' }, sizeNum, unit));
    const pctSlider = slider({ label: 'Target', min: 10, max: 90, step: 5, value: opts.image.percent, format: (v) => `${v}% of original`, onInput: (v) => ((opts.image.percent = v), estimateImages()) });
    const showMode = () => {
      qSlider.hidden = opts.image.mode !== 'quality';
      sizeField.hidden = opts.image.mode !== 'size';
      pctSlider.hidden = opts.image.mode !== 'percent';
    };
    const edge = h(
      'select',
      { onchange: (e: Event) => ((opts.image.maxEdge = Number((e.target as HTMLSelectElement).value)), estimateImages()) },
      ...[
        [0, 'Keep original size'],
        [3840, 'Fit within 3840 px'],
        [2560, 'Fit within 2560 px'],
        [1920, 'Fit within 1920 px'],
        [1280, 'Fit within 1280 px'],
        [800, 'Fit within 800 px'],
      ].map(([v, l]) => h('option', { value: String(v) }, String(l))),
    );
    sections.push(
      section(
        `${imgs.length === 1 ? 'Image' : `${imgs.length} images`}`,
        segmented(
          [
            { value: 'quality', label: 'Quality' },
            { value: 'size', label: 'Target size' },
            { value: 'percent', label: 'Percent' },
          ],
          opts.image.mode,
          (v) => {
            opts.image.mode = v;
            showMode();
            estimateImages();
          },
        ),
        h('div', { class: 'fc-gap' }),
        qSlider,
        sizeField,
        pctSlider,
        field('Dimensions', edge),
        checkbox('Remove metadata (camera, location, dates)', opts.image.strip, (v) => ((opts.image.strip = v), estimateImages())),
      ),
    );
    showMode();
  }

  const vids = by('video');
  if (vids.length) {
    const presetSeg = segmented(
      [
        { value: 'high', label: 'Best quality' },
        { value: 'medium', label: 'Balanced' },
        { value: 'small', label: 'Smallest' },
      ],
      opts.video.preset,
      (v) => ((opts.video.preset = v), refresh()),
    );
    const mb = numberInput(opts.video.targetMB, (v) => ((opts.video.targetMB = v), refresh()), { min: 1, step: 1 });
    const mbField = field(vids.length > 1 ? 'Size per video (MB)' : 'Target size (MB)', mb);
    const presetField = h('div', {}, presetSeg);
    const longest = Math.max(...vids.map((v) => v.duration ?? 0));
    const mbHint = h('p', { class: 'hint' }, 'Handy for email and chat limits. Very small targets also lower the resolution.');
    const show = () => {
      presetField.hidden = opts.video.mode !== 'preset';
      mbField.hidden = mbHint.hidden = opts.video.mode !== 'size';
    };
    const res = h(
      'select',
      { onchange: (e: Event) => ((opts.video.height = Number((e.target as HTMLSelectElement).value)), refresh()) },
      ...[
        [0, 'Keep resolution'],
        [1080, '1080p'],
        [720, '720p'],
        [480, '480p'],
      ].map(([v, l]) => h('option', { value: String(v) }, String(l))),
    );
    // A sensible default target: about a quarter of the smallest video, at least 5 MB.
    opts.video.targetMB = Math.max(5, Math.round(Math.min(...vids.map((v) => v.size)) / 4 / 1048576));
    mb.value = String(opts.video.targetMB);
    sections.push(
      section(
        vids.length === 1 ? `Video · ${fmtDuration(longest)}` : `${vids.length} videos`,
        segmented(
          [
            { value: 'preset', label: 'Preset' },
            { value: 'size', label: 'Target size' },
          ],
          opts.video.mode,
          (v) => ((opts.video.mode = v), show(), refresh()),
        ),
        h('div', { class: 'fc-gap' }),
        presetField,
        mbField,
        mbHint,
        h('div', { class: 'fc-gap' }),
        field('Resolution', res),
        h('p', { class: 'hint' }, 'Saved as H.264 MP4, which plays everywhere.'),
      ),
    );
    show();
  }

  const auds = by('audio');
  if (auds.length) {
    sections.push(
      section(
        auds.length === 1 ? 'Audio' : `${auds.length} audio files`,
        segmented(
          [256, 192, 128, 96, 64].map((k) => ({ value: String(k), label: `${k}` })),
          String(opts.audio.kbps),
          (v) => ((opts.audio.kbps = Number(v)), refresh()),
        ),
        h('p', { class: 'hint' }, 'Bitrate in kbps. 128 is fine for music on most speakers; 64 suits speech. Lossless files become AAC (.m4a).'),
      ),
    );
  }
  const levelSection = (title: string, key: 'pdf' | 'office', hint: string) =>
    section(title, segmented(LEVELS, opts[key].level, (v) => ((opts[key].level = v), refresh())), h('p', { class: 'hint' }, hint));
  const pdfs = by('pdf');
  if (pdfs.length) sections.push(levelSection(pdfs.length === 1 ? 'PDF' : `${pdfs.length} PDFs`, 'pdf', 'Light keeps print quality, Balanced suits screens and email, Strong makes images noticeably softer.'));
  const offs = by('office');
  if (offs.length) sections.push(levelSection(offs.length === 1 ? 'Office document' : `${offs.length} Office documents`, 'office', 'Shrinks the pictures inside and repacks the file. Text and layout stay the same.'));
  const zips = by('zip');
  if (zips.length)
    sections.push(
      section(
        'ZIP',
        h('p', { class: 'hint' }, zips.length === 1 ? `${base(zips[0].path)} is packed into a ZIP archive.` : `These ${zips.length} items are packed together into one ZIP archive.`),
      ),
    );
  optionsEl.append(...sections);

  // ----------------------------------------------------------- estimates
  function estimateNonImage(i: Info): number {
    if (i.error) return -1;
    if (i.kind === 'video') {
      const dur = i.duration ?? 0;
      if (!dur) return -1;
      if (opts.video.mode === 'size') return Math.min(i.size, opts.video.targetMB * 1048576);
      const h0 = i.height ?? 1080;
      const outH = opts.video.height && opts.video.height < h0 ? opts.video.height : h0;
      const px = outH * Math.round(((i.width ?? 1920) / h0) * outH);
      const factor = { high: 0.0024, medium: 0.0013, small: 0.0007 }[opts.video.preset];
      const vk = Math.min((i.kbps ?? 10000) * 0.95, px * factor);
      const ak = i.hasAudio ? (opts.video.preset === 'small' ? 96 : 128) : 0;
      return Math.min(i.size, ((vk + ak) * 1000 * dur) / 8);
    }
    if (i.kind === 'audio') {
      const dur = i.duration ?? 0;
      return dur ? Math.min(i.size, (opts.audio.kbps * 1000 * dur) / 8 + 4096) : -1;
    }
    return -1;
  }

  let estSeq = 0;
  let estTimer: number | undefined;
  function estimateImages() {
    clearTimeout(estTimer);
    for (const i of imgs) estimates.delete(i.path);
    refresh();
    estTimer = window.setTimeout(async () => {
      const seq = ++estSeq;
      const sample = imgs.filter((i) => !i.error).map((i) => i.path);
      if (!sample.length) return;
      const res = await api().invoke<Record<string, number>>('compress:estimate', sample.slice(0, 8), opts.image).catch(() => ({}) as Record<string, number>);
      if (seq !== estSeq) return;
      // Measure up to 8; scale the rest by the average ratio.
      let ratioSum = 0;
      let n = 0;
      for (const i of imgs) {
        const v = res[i.path];
        if (v === undefined) continue;
        estimates.set(i.path, v);
        if (v > 0) {
          ratioSum += v / i.size;
          n++;
        }
      }
      const avg = n ? ratioSum / n : -1;
      for (const i of imgs) if (!estimates.has(i.path)) estimates.set(i.path, avg > 0 ? i.size * avg : -1);
      refresh();
    }, 220);
  }

  // ------------------------------------------------------------- render
  const rows = new Map<string, { size: HTMLElement; est: HTMLElement }>();
  list.replaceChildren(
    ...infos.map((i) => {
      const size = h('span', { class: 'fc-size' }, fmtBytes(i.size));
      const est = h('span', { class: 'fc-est' });
      rows.set(i.path, { size, est });
      return h(
        'div',
        { class: 'fc-file', title: i.path },
        h('span', { class: 'fc-kind', html: icon(i.dir ? 'folder' : KIND_ICON[i.kind], 16) }),
        h('span', { class: 'fc-name' }, base(i.path)),
        size,
        h('span', { class: 'fc-arrow', 'aria-hidden': 'true' }, '→'),
        est,
      );
    }),
  );

  function estimateFor(i: Info): number | undefined {
    if (i.kind === 'image') return estimates.get(i.path);
    return estimateNonImage(i);
  }

  function refresh() {
    if (done) return;
    let before = 0;
    let after = 0;
    let unknown = 0;
    let pending = false;
    for (const i of infos) {
      const r = rows.get(i.path)!;
      const e = estimateFor(i);
      if (i.error) {
        r.est.textContent = "Can't read";
        r.est.className = 'fc-est bad';
        continue;
      }
      if (e === undefined) {
        r.est.replaceChildren(h('span', { class: 'skeleton fc-sk-est' }));
        r.est.className = 'fc-est';
        pending = true;
        continue;
      }
      if (e < 0) {
        r.est.textContent = i.kind === 'zip' ? 'ZIP' : 'Varies';
        r.est.className = 'fc-est muted';
        unknown++;
        continue;
      }
      before += i.size;
      after += e;
      const exact = i.kind === 'image' || (i.kind === 'video' && opts.video.mode === 'size');
      r.est.textContent = `${exact ? '' : '~'}${fmtBytes(Math.round(e))}`;
      r.est.className = `fc-est${e >= i.size * 0.98 ? ' muted' : ''}`;
    }
    const totalBefore = infos.reduce((a, i) => a + i.size, 0);
    const saved = before ? 1 - after / before : 0;
    summary.replaceChildren(
      h(
        'div',
        { class: 'fc-big' },
        h('span', {}, fmtBytes(totalBefore)),
        h('span', { class: 'fc-big-arrow' }, '→'),
        before && !pending
          ? h('span', { class: 'fc-big-after' }, `${unknown ? 'at most ' : '~'}${fmtBytes(Math.round(after + (totalBefore - before)))}`)
          : pending
            ? h('span', { class: 'skeleton fc-sk-inline' })
            : h('span', { class: 'fc-big-after muted' }, 'smaller'),
      ),
      h(
        'p',
        { class: 'muted' },
        pending
          ? 'Estimating…'
          : before
            ? `About ${Math.round(saved * 100)}% smaller${unknown ? `, plus whatever the other ${unknown === 1 ? 'file' : `${unknown} files`} save` : ''}. Originals stay untouched.`
            : 'The result depends on the content. Originals stay untouched.',
      ),
    );
    s.primary.disabled = false;
    s.status.textContent = `${infos.length} item${infos.length === 1 ? '' : 's'}`;
  }

  estimateImages();
  refresh();

  // --------------------------------------------------------------- run
  s.primary.addEventListener('click', async () => {
    if (done) return;
    s.primary.disabled = true;
    s.primary.textContent = 'Compressing…';
    s.status.textContent = 'Working. Progress shows in the corner; you can close this window.';
    const t0 = Date.now();
    try {
      const outputs = await api().invoke<string[]>('tool:run', 'compress', paths, opts);
      done = true;
      await showResults(outputs, Date.now() - t0);
    } catch (e: any) {
      s.primary.disabled = false;
      s.primary.textContent = 'Compress';
      s.status.textContent = e?.message ?? String(e);
    }
  });

  async function showResults(outputs: string[], _ms: number) {
    if (!outputs.length) {
      s.status.textContent = 'Nothing was made smaller.';
      s.primary.textContent = 'Close';
      s.primary.disabled = false;
      s.primary.onclick = () => api().send('window:close');
      return;
    }
    const sizes = await Promise.all(outputs.map((o) => api().invoke<{ size: number }>('file:stat', o).then((x) => x.size, () => 0)));
    const stemOf = (p: string) => base(p).replace(/\.[^.]+$/, '');
    let before = 0;
    let after = 0;
    for (const i of infos) {
      const r = rows.get(i.path)!;
      const k = outputs.findIndex((o) => stemOf(o).startsWith(`${stemOf(i.path)} compressed`) && !rowsUsed.has(o));
      if (k < 0) {
        r.est.textContent = i.kind === 'zip' ? 'In ZIP' : 'No gain';
        r.est.className = 'fc-est muted';
        continue;
      }
      rowsUsed.add(outputs[k]);
      before += i.size;
      after += sizes[k];
      r.est.textContent = fmtBytes(sizes[k]);
      r.est.className = 'fc-est ok';
    }
    const zipOut = outputs.find((o) => /\.zip$/i.test(o) && !rowsUsed.has(o));
    if (zipOut) {
      const zi = infos.filter((i) => i.kind === 'zip');
      before += zi.reduce((a, i) => a + i.size, 0);
      after += sizes[outputs.indexOf(zipOut)];
    }
    summary.replaceChildren(
      h('div', { class: 'fc-big' }, h('span', {}, fmtBytes(before)), h('span', { class: 'fc-big-arrow' }, '→'), h('span', { class: 'fc-big-after ok' }, fmtBytes(after))),
      h('p', { class: 'muted' }, before ? `Saved ${fmtBytes(Math.max(0, before - after))} (${Math.round((1 - after / before) * 100)}%). ${outputs.length === 1 ? 'The new file is' : `${outputs.length} new files are`} next to the original${outputs.length === 1 ? '' : 's'}.` : ''),
    );
    optionsEl.classList.add('fc-dim');
    s.status.textContent = 'Done';
    s.cancel.textContent = 'Close';
    s.primary.textContent = 'Show in folder';
    s.primary.disabled = false;
    s.primary.onclick = () => api().invoke('file:reveal', outputs[0]);
  }
}

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
