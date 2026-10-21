// Add BG: places the photo on a backdrop (solid, gradient or image) at a chosen aspect ratio,
// with padding, rounded corners and a soft shadow. One render function serves both the live
// preview (scaled) and the full-resolution export.
import { api, base, h, numberInput, saveBytes, section, segmented, shell, slider } from '../../shared/ui';
import { FitView, canvasBytes, clamp, colorPicker, cssVar, dims, flatten, formatSection, loadBitmap, rafThrottle, stageCanvas } from './common';

type BgType = 'solid' | 'gradient' | 'image';
type Aspect = 'original' | '1:1' | '4:5' | '16:9' | '9:16' | '4:3' | '3:2' | 'custom';

const SOLIDS = ['#f6f3ef', '#ffffff', '#e9dccb', '#f3d3c4', '#cfe0d6', '#d6e2f0', '#1d1b18', '#ee6a1f'];
const GRADIENTS: [string, string][] = [
  ['#fbe3d0', '#f2a07b'],
  ['#efebe6', '#c9c1b6'],
  ['#d7ecef', '#7fb2c4'],
  ['#e3ecd6', '#8fb08a'],
  ['#f6e7b4', '#e7a35a'],
  ['#2b2a33', '#5b4a5f'],
  ['#16181d', '#3a3f4b'],
];
const ASPECTS: { v: Aspect; label: string }[] = [
  { v: 'original', label: 'Original' },
  { v: '1:1', label: '1:1' },
  { v: '4:5', label: '4:5' },
  { v: '4:3', label: '4:3' },
  { v: '3:2', label: '3:2' },
  { v: '16:9', label: '16:9' },
  { v: '9:16', label: '9:16' },
  { v: 'custom', label: 'Custom' },
];

export async function frameImage(paths: string[]) {
  const path = paths[0];
  const s = shell({ title: 'Add a background', file: base(path) });
  s.primary.disabled = true;
  s.stage.classList.add('ix-stage', 'plainbg');
  const skel = h('div', { class: 'ix-skel skeleton' });
  s.stage.append(skel);
  const bmp = await loadBitmap(path);
  skel.remove();
  const IW = bmp.width;
  const IH = bmp.height;
  // Screen-size copy for the live preview; the export always uses the full bitmap.
  const pk = Math.min(1, 1600 / Math.max(IW, IH));
  const small = pk < 1 ? await createImageBitmap(bmp, { resizeWidth: Math.round(IW * pk), resizeHeight: Math.round(IH * pk), resizeQuality: 'high' }) : bmp;

  const st = {
    bg: 'gradient' as BgType,
    solid: SOLIDS[0],
    g1: GRADIENTS[0][0],
    g2: GRADIENTS[0][1],
    angle: 135,
    bgImg: null as ImageBitmap | null, // null = the photo itself
    blur: 40,
    aspect: 'original' as Aspect,
    cw: 2000,
    ch: 2000,
    padding: 8,
    radius: 3,
    shadow: 40,
  };

  // Output geometry in px.
  function layout() {
    const p = (st.padding / 100) * Math.max(IW, IH);
    let W: number, H: number, k = 1;
    if (st.aspect === 'custom') {
      W = st.cw;
      H = st.ch;
      const pp = (st.padding / 100) * Math.max(W, H);
      k = Math.max(0.01, Math.min((W - 2 * pp) / IW, (H - 2 * pp) / IH));
    } else if (st.aspect === 'original') {
      W = IW + 2 * p;
      H = IH + 2 * p;
    } else {
      const [a, b] = st.aspect.split(':').map(Number);
      const ar = a / b;
      const nw = IW + 2 * p;
      const nh = IH + 2 * p;
      if (nw / nh > ar) {
        W = nw;
        H = nw / ar;
      } else {
        H = nh;
        W = nh * ar;
      }
    }
    // Keep exports within what a canvas can encode.
    const cap = Math.min(1, Math.sqrt(120e6 / (W * H)), 16000 / Math.max(W, H));
    W = Math.round(W * cap);
    H = Math.round(H * cap);
    k *= cap;
    const dw = IW * k;
    const dh = IH * k;
    return { W, H, x: (W - dw) / 2, y: (H - dh) / 2, dw, dh };
  }

  function render(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, scale: number) {
    const L = layout();
    const W = L.W * scale;
    const H = L.H * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    if (st.bg === 'solid') {
      ctx.fillStyle = st.solid;
      ctx.fillRect(0, 0, W, H);
    } else if (st.bg === 'gradient') {
      const a = ((st.angle - 90) * Math.PI) / 180;
      const r = (Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a))) / 2;
      const g = ctx.createLinearGradient(W / 2 - Math.cos(a) * r, H / 2 - Math.sin(a) * r, W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r);
      g.addColorStop(0, st.g1);
      g.addColorStop(1, st.g2);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    } else {
      const src = st.bgImg ?? (scale < 1 ? small : bmp);
      const blurPx = (st.blur / 100) * Math.max(W, H) * 0.04;
      const over = blurPx * 2;
      const k = Math.max((W + over * 2) / src.width, (H + over * 2) / src.height);
      const sw = src.width * k;
      const sh = src.height * k;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (blurPx > 0.3) ctx.filter = `blur(${blurPx.toFixed(1)}px)`;
      ctx.drawImage(src, (W - sw) / 2, (H - sh) / 2, sw, sh);
      ctx.filter = 'none';
    }
    // Shadow + rounded photo.
    const x = L.x * scale;
    const y = L.y * scale;
    const dw = L.dw * scale;
    const dh = L.dh * scale;
    const rad = (st.radius / 100) * Math.min(dw, dh);
    // The rounded photo is its own layer so the shadow follows its real outline (transparent PNGs too).
    const lw = Math.max(1, Math.round(dw));
    const lh = Math.max(1, Math.round(dh));
    const layer = new OffscreenCanvas(lw, lh);
    const lx = layer.getContext('2d')!;
    lx.beginPath();
    lx.roundRect(0, 0, lw, lh, rad);
    lx.clip();
    lx.imageSmoothingQuality = 'high';
    lx.drawImage(scale < 1 && Math.max(lw, lh) <= Math.max(small.width, small.height) ? small : bmp, 0, 0, lw, lh);
    ctx.save();
    if (st.shadow > 0) {
      const s01 = st.shadow / 100;
      ctx.shadowColor = `rgba(0,0,0,${(0.12 + 0.4 * s01).toFixed(3)})`;
      ctx.shadowBlur = s01 * Math.max(dw, dh) * 0.07;
      ctx.shadowOffsetY = s01 * Math.max(dw, dh) * 0.02;
    }
    ctx.drawImage(layer, x, y, dw, dh);
    ctx.restore();
    ctx.restore();
  }

  const view = new FitView(1, 1, 28);
  const sc = stageCanvas(s.stage, () => draw());
  const draw = rafThrottle(() => {
    const L = layout();
    view.w = L.W;
    view.h = L.H;
    view.fit(sc.w, sc.h);
    sc.begin();
    const ctx = sc.ctx;
    ctx.save();
    ctx.translate(view.ox, view.oy);
    render(ctx, view.scale);
    ctx.restore();
    ctx.strokeStyle = cssVar('--line');
    ctx.strokeRect(Math.round(view.ox) - 0.5, Math.round(view.oy) - 0.5, Math.round(L.W * view.scale) + 1, Math.round(L.H * view.scale) + 1);
    s.status.textContent = `${dims(L.W, L.H)} px`;
  });

  // ------------------------------------------------------------ panel
  const solidPick = colorPicker(SOLIDS, st.solid, (c) => ((st.solid = c), draw()));
  const gradSw = h('div', { class: 'ix-swatches' });
  const g1 = h('input', { type: 'color', value: st.g1, title: 'From' }) as HTMLInputElement;
  const g2 = h('input', { type: 'color', value: st.g2, title: 'To' }) as HTMLInputElement;
  const syncGrad = () => {
    g1.value = st.g1;
    g2.value = st.g2;
    gradSw.querySelectorAll<HTMLElement>('.ix-swatch').forEach((b) => b.classList.toggle('on', b.dataset.a === st.g1 && b.dataset.b === st.g2));
  };
  for (const [a, b] of GRADIENTS) {
    gradSw.append(
      h('button', {
        class: 'ix-swatch',
        'data-a': a,
        'data-b': b,
        title: `${a} → ${b}`,
        'aria-label': 'Gradient preset',
        style: { background: `linear-gradient(135deg, ${a}, ${b})` },
        onclick: () => {
          st.g1 = a;
          st.g2 = b;
          syncGrad();
          draw();
        },
      }),
    );
  }
  g1.addEventListener('input', () => ((st.g1 = g1.value), syncGrad(), draw()));
  g2.addEventListener('input', () => ((st.g2 = g2.value), syncGrad(), draw()));
  syncGrad();
  const angle = slider({ label: 'Angle', min: 0, max: 360, step: 5, value: 135, format: (v) => `${v}°`, onInput: (v) => ((st.angle = v), draw()) });
  const gradBox = h(
    'div',
    {},
    h('div', { class: 'field' }, gradSw),
    h('div', { class: 'field' }, h('div', { class: 'row' }, h('span', { class: 'muted fixed' }, 'From'), g1, h('span', { class: 'muted fixed' }, 'To'), g2)),
    angle,
  );

  const bgName = h('span', { class: 'muted' }, 'This photo');
  const pickBg = h('input', { type: 'file', accept: 'image/*,.heic,.heif,.tif,.tiff', hidden: true }) as HTMLInputElement;
  pickBg.addEventListener('change', async () => {
    const f = pickBg.files?.[0];
    pickBg.value = '';
    if (!f) return;
    try {
      st.bgImg = await createImageBitmap(f, { imageOrientation: 'from-image' });
    } catch {
      st.bgImg = await loadBitmap(api().pathForFile(f), 4096);
    }
    bgName.textContent = f.name;
    draw();
  });
  const imgBox = h(
    'div',
    {},
    h(
      'div',
      { class: 'field' },
      h(
        'div',
        { class: 'row' },
        bgName,
        h('button', { class: 'btn small fixed', onclick: () => pickBg.click() }, 'Choose…'),
        h('button', { class: 'btn small ghost fixed', onclick: () => ((st.bgImg = null), (bgName.textContent = 'This photo'), draw()) }, 'Reset'),
      ),
    ),
    slider({ label: 'Blur', min: 0, max: 100, value: 40, onInput: (v) => ((st.blur = v), draw()) }),
    pickBg,
  );

  const bodies: Record<BgType, HTMLElement> = { solid: h('div', { class: 'field' }, solidPick), gradient: gradBox, image: imgBox };
  const bgSeg = segmented(
    [
      { value: 'solid', label: 'Solid' },
      { value: 'gradient', label: 'Gradient' },
      { value: 'image', label: 'Image' },
    ],
    st.bg,
    (v) => {
      st.bg = v as BgType;
      syncBg();
      draw();
    },
  );
  const syncBg = () => (Object.keys(bodies) as BgType[]).forEach((k) => (bodies[k].style.display = k === st.bg ? '' : 'none'));
  syncBg();

  const aspBtns = h('div', { class: 'ix-grid-btns' });
  const custom = h(
    'div',
    { class: 'ix-dims' },
    numberInput(st.cw, (v) => ((st.cw = v), draw()), { min: 16, max: 16000 }),
    h('span', { class: 'x' }, '×'),
    numberInput(st.ch, (v) => ((st.ch = v), draw()), { min: 16, max: 16000 }),
  );
  const syncAspect = () => {
    aspBtns.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.aspect));
    custom.style.display = st.aspect === 'custom' ? '' : 'none';
  };
  for (const a of ASPECTS) {
    aspBtns.append(h('button', { class: 'btn', 'data-v': a.v, onclick: () => ((st.aspect = a.v), syncAspect(), draw()) }, a.label));
  }
  syncAspect();

  const fmt = formatSection('png');
  s.panel.append(
    section('Background', h('div', { class: 'field' }, bgSeg), bodies.solid, bodies.gradient, bodies.image),
    section('Canvas', h('div', { class: 'field' }, aspBtns), h('div', { class: 'field' }, custom)),
    section(
      'Photo',
      slider({ label: 'Padding', min: 0, max: 40, value: 8, format: (v) => `${v}%`, onInput: (v) => ((st.padding = v), draw()) }),
      slider({ label: 'Corner radius', min: 0, max: 50, value: 3, format: (v) => `${v}%`, onInput: (v) => ((st.radius = clamp(v, 0, 50)), draw()) }),
      slider({ label: 'Shadow', min: 0, max: 100, value: 40, onInput: (v) => ((st.shadow = v), draw()) }),
    ),
    fmt.el,
  );
  draw();

  s.primary.disabled = false;
  s.primary.onclick = async () => {
    s.primary.disabled = true;
    s.primary.textContent = 'Saving…';
    try {
      const L = layout();
      const out = new OffscreenCanvas(L.W, L.H);
      render(out.getContext('2d')!, 1);
      const { fmt: f, quality } = fmt.get();
      const bytes = await canvasBytes(f === 'jpg' ? flatten(out) : out, f, quality);
      await saveBytes(path, f, ' framed', bytes);
      api().send('window:close');
    } catch (e: any) {
      s.status.textContent = e?.message ?? String(e);
      s.primary.disabled = false;
      s.primary.textContent = 'Save';
    }
  };
}
