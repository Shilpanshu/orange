// Upscale: 2× or 4× with Real-ESRGAN on this PC. The stage compares a crop at full output
// resolution (plain resize vs AI); click the thumbnail in the panel to look at another spot.
import { api, base, enablePresets, field, h, loadImage, runAndClose, section, segmented, shell } from '../../shared/ui';
import { aiStatus, compareView, debounce, errText, modelSection, onAiProgress, progressCard, type AiStatus } from './common';

interface Opts {
  model: 'photo' | 'art';
  scale: 2 | 4;
}

interface Preview {
  before: string;
  after: string;
  side: number;
  crop: { left: number; top: number; size: number; w: number; h: number };
  ms: number;
}

const MODEL_HINT: Record<Opts['model'], string> = {
  photo: 'For photos and scans. Removes blur, noise and JPEG blocks.',
  art: 'For drawings, anime, logos and screenshots. Keeps lines clean and colours flat.',
};

export async function upscaleImage(paths: string[]) {
  const s = shell({ title: 'Upscale', file: paths.length === 1 ? base(paths[0]) : `${paths.length} images` });
  s.primary.textContent = paths.length > 1 ? `Upscale ${paths.length} images` : 'Upscale';
  s.stage.classList.add('ai-stage');
  const o: Opts = { model: 'photo', scale: 4 };
  let current = paths[0];
  let cx = 0.5;
  let cy = 0.5;
  let st: AiStatus | null = null;

  // ---------------------------------------------------------------- stage
  const skel = h('div', { class: 'ai-skel square skeleton' });
  s.stage.append(skel);
  const cmp = compareView(s.stage);
  cmp.hide();
  cmp.el.querySelector('.ai-tag.left')!.textContent = 'Resized';
  cmp.el.querySelector('.ai-tag.right')!.textContent = 'Upscaled';
  let card: HTMLElement | null = null;
  const setCard = (el: HTMLElement | null) => {
    card?.remove();
    card = el;
    if (el) s.stage.append(el);
  };

  // ---------------------------------------------------------------- panel
  const thumbImg = h('img', { alt: '', draggable: false });
  const thumbBox = h('div', { class: 'ai-thumb-box' });
  const thumb = h('div', { class: 'ai-thumb', title: 'Click to preview another area' }, thumbImg, thumbBox);
  thumb.addEventListener('click', (e) => {
    const r = thumbImg.getBoundingClientRect();
    cx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    cy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    placeBox(null);
    void preview();
  });
  const fileSel = h('select', { 'aria-label': 'Image to preview' }) as HTMLSelectElement;
  for (const p of paths) fileSel.append(h('option', { value: p }, base(p)));
  fileSel.addEventListener('change', () => {
    current = fileSel.value;
    cx = cy = 0.5;
    void loadThumb().then(() => preview());
    void loadStatus();
  });

  const scaleSeg = segmented(
    [
      { value: '2', label: '2×' },
      { value: '4', label: '4×' },
    ],
    '4',
    (v) => {
      o.scale = Number(v) as 2 | 4;
      refresh();
    },
  );
  const sizeOut = h('p', { class: 'hint ai-size' });
  const modelHint = h('p', { class: 'hint' }, MODEL_HINT[o.model]);
  const modelSeg = segmented(
    [
      { value: 'photo', label: 'Photo' },
      { value: 'art', label: 'Illustration' },
    ],
    'photo',
    (v) => {
      o.model = v as Opts['model'];
      modelHint.textContent = MODEL_HINT[o.model];
      refresh();
    },
  );
  const model = modelSection('Real-ESRGAN (BSD-3-Clause; the illustration model is MIT). Saved in the original format; HEIC becomes JPG.');

  s.panel.append(
    section(
      'Preview area',
      paths.length > 1 ? field(`${paths.length} images, all get the same settings`, fileSel) : null,
      thumb,
      h('p', { class: 'hint' }, 'Click the picture to compare another spot.'),
    ),
    section('Size', h('div', { class: 'field' }, scaleSeg), sizeOut),
    section('Kind of image', h('div', { class: 'field' }, modelSeg), modelHint),
    model.el,
  );

  async function loadThumb() {
    thumbImg.removeAttribute('src');
    try {
      const img = await loadImage(current);
      thumbImg.src = img.src;
      await thumbImg.decode().catch(() => {});
    } catch {
      /* the preview still works without the thumbnail */
    }
  }

  /** Draws the preview area's outline on the thumbnail. */
  function placeBox(crop: Preview['crop'] | null) {
    const f = st?.files.find((x) => x.path === current);
    const w = crop?.w || f?.w || 1;
    const hh = crop?.h || f?.h || 1;
    const size = crop?.size ?? Math.min(256, Math.round(512 / o.scale), w, hh);
    const left = crop ? crop.left : Math.max(0, Math.min(w - size, cx * w - size / 2));
    const top = crop ? crop.top : Math.max(0, Math.min(hh - size, cy * hh - size / 2));
    Object.assign(thumbBox.style, { left: `${(left / w) * 100}%`, top: `${(top / hh) * 100}%`, width: `${(size / w) * 100}%`, height: `${(size / hh) * 100}%` });
  }

  async function loadStatus() {
    st = await aiStatus('upscale', paths, o);
    model.update(st, paths.length > 1 ? `${paths.length} images` : 'Time');
    const f = st.files.find((x) => x.path === current);
    if (f?.w) {
      const big = f.w * f.h * o.scale * o.scale > 120e6;
      sizeOut.textContent = `${f.w} × ${f.h} → ${f.w * o.scale} × ${f.h * o.scale} px${big ? '. Too large at this size; try 2×.' : ''}`;
      sizeOut.classList.toggle('ai-bad', big);
    }
    return st;
  }

  let seq = 0;
  let shownOnce = false;
  async function preview() {
    const my = ++seq;
    cmp.busy(true);
    const prog = progressCard(st && st.downloadMB > 0 ? 'Getting the upscaler ready' : 'Upscaling the preview');
    const t = setTimeout(() => {
      if (my === seq && !shownOnce) setCard(prog.el);
    }, 250);
    const off = onAiProgress((f, note) => prog.set(f, note));
    try {
      const r = await api().invoke<Preview>('ai:upPreview', current, { ...o, cx, cy });
      if (my !== seq) return;
      skel.remove();
      setCard(null);
      cmp.set(r.before, r.after, r.side, r.side, { upscale: true });
      placeBox(r.crop);
      shownOnce = true;
      if (st?.downloadMB) void loadStatus();
    } catch (e) {
      if (my !== seq) return;
      skel.remove();
      setCard(h('div', { class: 'ai-card' }, h('strong', {}, "Couldn't make a preview"), h('p', {}, errText(e))));
    } finally {
      clearTimeout(t);
      off();
      if (my === seq) cmp.busy(false);
    }
  }
  const refresh = debounce(() => {
    void loadStatus();
    void preview();
  }, 120);

  s.primary.onclick = () => runAndClose(s.primary, 'upscale', paths, { ...o }, s.status);
  enablePresets?.('upscale', () => ({ ...o }));

  await Promise.all([loadThumb(), loadStatus()]);
  placeBox(null);
  await preview();
}
