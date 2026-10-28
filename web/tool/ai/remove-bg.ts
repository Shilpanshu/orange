// Remove BG: cuts the subject out with RMBG-1.4 on this PC. The model runs once per image (at its
// own 1024 px input); the preview and the full-size result both reuse that mask, so changing the
// edge softness or background is instant and Save only has to compose the full-resolution file.
import { api, base, checkbox, enablePresets, field, h, runAndClose, section, segmented, shell, slider } from '../../shared/ui';
import { colorPicker } from '../image/common';
import { aiStatus, compareView, debounce, downloadCard, errText, modelSection, onAiProgress, progressCard, type AiStatus } from './common';

const COLORS = ['#ffffff', '#f6f3ef', '#1f1b16', '#e9dccb', '#d6e2f0', '#cfe0d6', '#f3d3c4', '#ee6a1f'];

interface Opts {
  format: 'png' | 'jpg';
  fill: boolean;
  color: string;
  feather: number;
  trim: boolean;
}

interface Preview {
  before: string;
  after: string;
  w: number;
  h: number;
  box: { left: number; top: number; width: number; height: number } | null;
  fullW: number;
  fullH: number;
}

export async function removeBackground(paths: string[]) {
  const s = shell({ title: 'Remove background', file: paths.length === 1 ? base(paths[0]) : `${paths.length} images` });
  s.primary.textContent = paths.length > 1 ? `Save ${paths.length} images` : 'Save';
  s.stage.classList.add('ai-stage');
  const o: Opts = { format: 'png', fill: false, color: '#ffffff', feather: 2, trim: false };
  let current = paths[0];
  let st: AiStatus | null = null;
  let ready = false;

  // ---------------------------------------------------------------- stage
  const skel = h('div', { class: 'ai-skel skeleton' });
  s.stage.append(skel);
  const cmp = compareView(s.stage);
  cmp.hide();
  let card: HTMLElement | null = null;
  const setCard = (el: HTMLElement | null) => {
    card?.remove();
    card = el;
    if (el) s.stage.append(el);
  };

  // ---------------------------------------------------------------- panel
  const colours = colorPicker(COLORS, o.color, (c) => {
    o.color = c;
    applyBackdrop();
  });
  const colourField = field('Colour', colours);
  const bgSeg = segmented(
    [
      { value: 'clear', label: 'Transparent' },
      { value: 'fill', label: 'Colour' },
    ],
    'clear',
    (v) => {
      o.fill = v === 'fill';
      applyBackdrop();
    },
  );
  const jpgHint = h('p', { class: 'hint' }, 'JPG has no transparency, so the background is filled with the colour above.');
  const fmtSeg = segmented(
    [
      { value: 'png', label: 'PNG' },
      { value: 'jpg', label: 'JPG' },
    ],
    'png',
    (v) => {
      o.format = v as Opts['format'];
      applyBackdrop();
    },
  );
  const feather = slider({
    label: 'Edge softness',
    min: 0,
    max: 10,
    value: o.feather,
    format: (v) => (v === 0 ? 'Crisp' : String(v)),
    onInput: (v) => {
      o.feather = v;
      refresh();
    },
  });
  const trim = checkbox('Crop to the subject', o.trim, (v) => {
    o.trim = v;
    refresh();
  });
  const model = modelSection('RMBG-1.4 by BRIA AI, free for personal, non-commercial use. Your images never leave this PC.');

  const fileSel = h('select', { 'aria-label': 'Image to preview' }) as HTMLSelectElement;
  for (const p of paths) fileSel.append(h('option', { value: p }, base(p)));
  fileSel.addEventListener('change', () => {
    current = fileSel.value;
    void preview();
  });
  const sizeNote = h('p', { class: 'hint ai-size' });

  if (paths.length > 1) s.panel.append(section('Preview', field(`${paths.length} images, all get the same settings`, fileSel)));
  s.panel.append(
    section('Background', h('div', { class: 'field' }, bgSeg), colourField),
    section('Edges', feather, trim),
    section('Save as', h('div', { class: 'field' }, fmtSeg), jpgHint, sizeNote),
    model.el,
  );

  function applyBackdrop() {
    const solid = o.fill || o.format === 'jpg';
    colourField.hidden = !solid;
    jpgHint.hidden = o.format !== 'jpg' || o.fill;
    bgSeg.set(o.fill ? 'fill' : 'clear');
    cmp.backdrop(solid ? o.color : null);
  }
  applyBackdrop();

  // ---------------------------------------------------------------- status + preview
  async function loadStatus() {
    st = await aiStatus('removeBg', paths, o);
    model.update(st, paths.length > 1 ? `${paths.length} images` : 'Time');
    const f = st.files.find((x) => x.path === current);
    if (f?.w) sizeNote.textContent = `Full size: ${f.w} × ${f.h} px`;
    s.status.textContent = st.downloadMB > 0 ? 'The model downloads once, then everything stays on this PC.' : '';
    return st;
  }

  let seq = 0;
  async function preview() {
    const my = ++seq;
    cmp.busy(true);
    const prog = progressCard('Finding the subject');
    // Only show the card if the first run takes a moment (the model may still be loading).
    const t = setTimeout(() => {
      if (my === seq && !ready) {
        setCard(prog.el);
      }
    }, 300);
    const off = onAiProgress((f, note) => prog.set(f, note));
    try {
      const r = await api().invoke<Preview>('ai:bgPreview', current, { feather: o.feather, trim: o.trim });
      if (my !== seq) return;
      skel.remove();
      setCard(null);
      // With "Crop to the subject", crop the original the same way so the comparison lines up.
      const before = r.box ? await cropDataUrl(r.before, r.box) : r.before;
      if (my !== seq) return;
      cmp.set(before, r.after, r.box?.width ?? r.w, r.box?.height ?? r.h);
      ready = true;
      s.status.textContent = '';
      void loadStatus();
    } catch (e) {
      if (my !== seq) return;
      skel.remove();
      const msg = errText(e);
      setCard(h('div', { class: 'ai-card' }, h('strong', {}, "Couldn't preview this image"), h('p', {}, msg)));
    } finally {
      clearTimeout(t);
      off();
      if (my === seq) cmp.busy(false);
    }
  }
  const refresh = debounce(() => {
    if (ready) void preview();
  }, 140);

  s.primary.onclick = () => runAndClose(s.primary, 'removeBg', paths, { ...o }, s.status);
  enablePresets?.('removeBg', () => ({ ...o }));

  st = await loadStatus();
  if (st.models[0] && !st.models[0].ready) {
    skel.remove();
    setCard(
      downloadCard({
        title: 'One download, then offline',
        body: `Remove BG uses an AI model that runs on this PC. It downloads once (${Math.round(st.models[0].mb)} MB) and is kept for next time.`,
        mb: st.models[0].mb,
        credit: 'RMBG-1.4 by BRIA AI, for non-commercial use.',
        onStart: () => void preview(),
      }),
    );
  } else {
    await preview();
  }
}

/** Crops a data URL image (the "before" preview) to the box used for the cut-out. */
async function cropDataUrl(url: string, box: { left: number; top: number; width: number; height: number }): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = box.width;
  c.height = box.height;
  c.getContext('2d')!.drawImage(img, box.left, box.top, box.width, box.height, 0, 0, box.width, box.height);
  return c.toDataURL('image/jpeg', 0.9);
}
