// Collage: grid, row, column or featured layouts on one canvas. Preview draws from screen-size
// copies; Save reloads each photo at the size its cell needs and renders full resolution.
import { api, base, h, numberInput, saveBytes, section, segmented, shell, slider, sortable } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { FitView, canvasBytes, colorPicker, cssVar, dims, flatten, formatSection, loadBitmap, loadPreview, rafThrottle, stageCanvas, type Rect, capture } from './common';

type Layout = 'grid' | 'row' | 'column' | 'featured';
type SizeKey = 'auto' | 'square' | 'landscape' | 'wide' | 'portrait' | 'story' | 'custom';
const SIZES: { v: SizeKey; label: string; w?: number; h?: number }[] = [
  { v: 'auto', label: 'Auto' },
  { v: 'square', label: '1:1', w: 3000, h: 3000 },
  { v: 'landscape', label: '3:2', w: 3600, h: 2400 },
  { v: 'wide', label: '16:9', w: 3840, h: 2160 },
  { v: 'portrait', label: '4:5', w: 2400, h: 3000 },
  { v: 'story', label: '9:16', w: 2160, h: 3840 },
  { v: 'custom', label: 'Custom' },
];
const BG = ['#ffffff', '#f6f3ef', '#1d1b18', '#000000', '#e9dccb', '#cfe0d6', '#d6e2f0'];

interface Item {
  path: string;
  bmp: ImageBitmap | null;
  w: number;
  h: number;
}

export async function createCollage(paths: string[]) {
  const s = shell({ title: 'Collage', file: `${paths.length} images` });
  s.primary.disabled = true;
  s.stage.classList.add('ix-stage', 'plainbg');
  const st = {
    layout: 'grid' as Layout,
    size: 'auto' as SizeKey,
    cw: 3000,
    ch: 2000,
    spacing: 12, // ‰ of the long side
    radius: 0, // % of the cell's short side / 2
    bg: BG[0],
    fit: 'fill' as 'fill' | 'fit',
  };
  let items: Item[] = paths.map((p) => ({ path: p, bmp: null, w: 4, h: 3 }));

  const aspects = () => items.map((it) => it.w / it.h);

  function canvasSize(): { W: number; H: number } {
    const preset = SIZES.find((x) => x.v === st.size)!;
    if (st.size === 'custom') return { W: st.cw, H: st.ch };
    if (preset.w && preset.h) return { W: preset.w, H: preset.h };
    // Auto: size the canvas around the photos so nothing needs cropping.
    const a = aspects();
    const n = a.length;
    const base = 3000;
    const sp = (st.spacing / 1000) * base;
    if (st.layout === 'row') {
      const hh = 1600;
      return { W: Math.round(a.reduce((x, y) => x + y, 0) * hh + sp * (n + 1)), H: Math.round(hh + 2 * sp) };
    }
    if (st.layout === 'column') {
      const w = 1600;
      return { W: Math.round(w + 2 * sp), H: Math.round(a.reduce((x, y) => x + 1 / y, 0) * w + sp * (n + 1)) };
    }
    if (st.layout === 'featured') return a[0] >= 1 ? { W: base, H: 2000 } : { W: 2400, H: base };
    const avg = a.reduce((x, y) => x + y, 0) / n;
    const cols = Math.max(1, Math.round(Math.sqrt(n * avg)));
    const rows = Math.ceil(n / cols);
    return { W: base, H: Math.round((base / cols / avg) * rows) };
  }

  function cells(W: number, H: number): Rect[] {
    const n = items.length;
    const sp = (st.spacing / 1000) * Math.max(W, H);
    const a = aspects();
    const out: Rect[] = [];
    if (st.layout === 'row' || st.layout === 'column') {
      const horiz = st.layout === 'row';
      const along = (horiz ? W : H) - sp * (n + 1);
      const weights = a.map((x) => (horiz ? x : 1 / x));
      const sum = weights.reduce((x, y) => x + y, 0);
      let pos = sp;
      for (let i = 0; i < n; i++) {
        const len = (along * weights[i]) / sum;
        out.push(horiz ? { x: pos, y: sp, w: len, h: H - 2 * sp } : { x: sp, y: pos, w: W - 2 * sp, h: len });
        pos += len + sp;
      }
      return out;
    }
    if (st.layout === 'featured' && n > 1) {
      const wide = W >= H;
      const rest = n - 1;
      if (wide) {
        const bw = (W - 3 * sp) * (rest > 3 ? 0.58 : 0.64);
        out.push({ x: sp, y: sp, w: bw, h: H - 2 * sp });
        out.push(...gridIn({ x: bw + 2 * sp, y: sp, w: W - bw - 3 * sp, h: H - 2 * sp }, rest, rest > 3 ? 2 : 1, sp));
      } else {
        const bh = (H - 3 * sp) * (rest > 3 ? 0.58 : 0.64);
        out.push({ x: sp, y: sp, w: W - 2 * sp, h: bh });
        const rows = rest > 3 ? 2 : 1;
        out.push(...gridIn({ x: sp, y: bh + 2 * sp, w: W - 2 * sp, h: H - bh - 3 * sp }, rest, Math.ceil(rest / rows), sp));
      }
      return out;
    }
    const avg = a.reduce((x, y) => x + y, 0) / n;
    const cols = Math.min(n, Math.max(1, Math.round(Math.sqrt((n * (W / H)) / avg))));
    return gridIn({ x: sp, y: sp, w: W - 2 * sp, h: H - 2 * sp }, n, cols, sp);
  }

  /** n cells in `cols` columns filling r; a short last row is stretched to the full width. */
  function gridIn(r: Rect, n: number, cols: number, sp: number): Rect[] {
    const rows = Math.ceil(n / cols);
    const ch = (r.h - sp * (rows - 1)) / rows;
    const out: Rect[] = [];
    for (let row = 0; row < rows; row++) {
      const inRow = Math.min(cols, n - row * cols);
      const cw = (r.w - sp * (inRow - 1)) / inRow;
      for (let c = 0; c < inRow; c++) out.push({ x: r.x + c * (cw + sp), y: r.y + row * (ch + sp), w: cw, h: ch });
    }
    return out;
  }

  function paint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, W: number, H: number, k: number, srcs: (ImageBitmap | null)[]) {
    ctx.fillStyle = st.bg;
    ctx.fillRect(0, 0, W * k, H * k);
    const cs = cells(W, H);
    cs.forEach((c, i) => {
      const src = srcs[i];
      const x = c.x * k, y = c.y * k, w = c.w * k, hh = c.h * k;
      const rad = (st.radius / 100) * (Math.min(w, hh) / 2);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, hh, rad);
      ctx.clip();
      if (!src) {
        ctx.fillStyle = 'rgba(128,128,128,0.18)';
        ctx.fillRect(x, y, w, hh);
      } else if (st.fit === 'fill') {
        const sk = Math.max(w / src.width, hh / src.height);
        const sw = w / sk, sh = hh / sk;
        ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, x, y, w, hh);
      } else {
        const sk = Math.min(w / src.width, hh / src.height);
        const dw = src.width * sk, dh = src.height * sk;
        ctx.drawImage(src, x + (w - dw) / 2, y + (hh - dh) / 2, dw, dh);
      }
      ctx.restore();
    });
    return cs;
  }

  // ------------------------------------------------------------ stage
  const view = new FitView(1, 1, 28);
  const sc = stageCanvas(s.stage, () => draw());
  const canvas = sc.canvas;
  let dragFrom = -1;
  let dragOver = -1;
  const draw = rafThrottle(() => {
    const { W, H } = canvasSize();
    view.w = W;
    view.h = H;
    view.fit(sc.w, sc.h);
    sc.begin();
    const ctx = sc.ctx;
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.imageSmoothingQuality = 'high';
    const cs = paint(ctx, W, H, view.scale, items.map((it) => it.bmp));
    ctx.restore();
    ctx.strokeStyle = cssVar('--line');
    ctx.strokeRect(Math.round(view.ox) - 0.5, Math.round(view.oy) - 0.5, Math.round(W * view.scale) + 1, Math.round(H * view.scale) + 1);
    if (dragFrom >= 0) {
      const accent = cssVar('--accent');
      for (const [i, dash] of [[dragFrom, [4, 3]], [dragOver, []]] as [number, number[]][]) {
        if (i < 0 || !cs[i]) continue;
        const c = cs[i];
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.setLineDash(dash);
        ctx.strokeRect(view.ox + c.x * view.scale + 1, view.oy + c.y * view.scale + 1, c.w * view.scale - 2, c.h * view.scale - 2);
        ctx.restore();
      }
    }
    s.status.textContent = `${dims(W, H)} px · ${items.length} photos`;
  });

  const cellAt = (vx: number, vy: number) => {
    const { W, H } = canvasSize();
    const p = view.toImg(vx, vy);
    return cells(W, H).findIndex((c) => p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h);
  };
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    dragFrom = cellAt(e.clientX - r.left, e.clientY - r.top);
    if (dragFrom < 0) return;
    dragOver = dragFrom;
    capture(canvas, e.pointerId);
    canvas.style.cursor = 'grabbing';
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const i = cellAt(e.clientX - r.left, e.clientY - r.top);
    if (dragFrom < 0) {
      canvas.style.cursor = i >= 0 ? 'grab' : 'default';
      return;
    }
    if (i !== dragOver) {
      dragOver = i;
      draw();
    }
  });
  const endDrag = () => {
    if (dragFrom >= 0 && dragOver >= 0 && dragOver !== dragFrom) {
      // Swap the two photos: the natural gesture on a fixed grid.
      [items[dragFrom], items[dragOver]] = [items[dragOver], items[dragFrom]];
      renderList();
    }
    dragFrom = dragOver = -1;
    canvas.style.cursor = 'grab';
    draw();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ panel
  const list = h('div', { class: 'list ix-thumbs' });
  const thumbs = new Map<string, string>();
  function renderList() {
    list.replaceChildren(
      ...items.map((it, i) =>
        h(
          'div',
          { class: 'item', draggable: true, title: it.path },
          h('span', { class: 'grip', html: icon('grip', 14) }),
          h('span', { class: 'idx' }, String(i + 1)),
          thumbs.get(it.path) ? h('img', { src: thumbs.get(it.path), alt: '', draggable: false }) : h('span', { class: 'skeleton', style: { width: '36px', height: '36px', flex: 'none' } }),
          h('span', { class: 'name' }, base(it.path)),
        ),
      ),
    );
  }
  sortable(list, (from, to) => {
    const [m] = items.splice(from, 1);
    items.splice(to, 0, m);
    renderList();
    draw();
  });

  const sizeBtns = h('div', { class: 'ix-grid-btns' });
  const customRow = h(
    'div',
    { class: 'ix-dims' },
    numberInput(st.cw, (v) => ((st.cw = v), draw()), { min: 100, max: 16000 }),
    h('span', { class: 'x' }, '×'),
    numberInput(st.ch, (v) => ((st.ch = v), draw()), { min: 100, max: 16000 }),
  );
  const syncSize = () => {
    sizeBtns.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.size));
    customRow.style.display = st.size === 'custom' ? '' : 'none';
  };
  for (const z of SIZES) sizeBtns.append(h('button', { class: 'btn', 'data-v': z.v, onclick: () => ((st.size = z.v), syncSize(), draw()) }, z.label));
  syncSize();

  const fmt = formatSection('jpg');
  s.panel.append(
    section(
      'Layout',
      h(
        'div',
        { class: 'field' },
        segmented(
          [
            { value: 'grid', label: 'Grid' },
            { value: 'row', label: 'Row' },
            { value: 'column', label: 'Column' },
            { value: 'featured', label: 'Featured' },
          ],
          st.layout,
          (v) => ((st.layout = v as Layout), draw()),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        segmented(
          [
            { value: 'fill', label: 'Fill cells' },
            { value: 'fit', label: 'Whole photos' },
          ],
          st.fit,
          (v) => ((st.fit = v as 'fill' | 'fit'), draw()),
        ),
      ),
    ),
    section('Photos', list, h('p', { class: 'hint' }, 'Drag here or on the preview to change the order. In Featured the first photo is the large one.')),
    section('Size', h('div', { class: 'field' }, sizeBtns), h('div', { class: 'field' }, customRow)),
    section(
      'Style',
      slider({ label: 'Spacing', min: 0, max: 60, value: st.spacing, onInput: (v) => ((st.spacing = v), draw()) }),
      slider({ label: 'Corner radius', min: 0, max: 100, value: 0, format: (v) => `${v}%`, onInput: (v) => ((st.radius = v), draw()) }),
      h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Background')), colorPicker(BG, st.bg, (c) => ((st.bg = c), draw()))),
    ),
    fmt.el,
  );
  renderList();
  draw();

  // Load previews (in order of appearance).
  await Promise.all(
    items.map(async (it) => {
      try {
        const pv = await loadPreview(it.path, 1600);
        it.bmp = pv.bmp;
        it.w = pv.w;
        it.h = pv.h;
        const c = new OffscreenCanvas(72, 72);
        const x = c.getContext('2d')!;
        const k = Math.max(72 / pv.bmp.width, 72 / pv.bmp.height);
        x.drawImage(pv.bmp, (72 - pv.bmp.width * k) / 2, (72 - pv.bmp.height * k) / 2, pv.bmp.width * k, pv.bmp.height * k);
        thumbs.set(it.path, URL.createObjectURL(await c.convertToBlob()));
      } catch (e) {
        console.error(e);
      }
      renderList();
      draw();
    }),
  );
  s.primary.disabled = false;

  s.primary.onclick = async () => {
    s.primary.disabled = true;
    s.primary.textContent = 'Saving…';
    try {
      let { W, H } = canvasSize();
      const cap = Math.min(1, 16000 / Math.max(W, H), Math.sqrt(150e6 / (W * H)));
      W = Math.round(W * cap);
      H = Math.round(H * cap);
      const cs = cells(W, H);
      // Each photo at roughly the resolution its cell needs (never more than the original).
      const full: ImageBitmap[] = [];
      for (const [i, it] of items.entries()) {
        const need = Math.ceil(Math.max(cs[i].w, cs[i].h) * (st.fit === 'fill' ? Math.max(it.w / it.h, it.h / it.w) : 1));
        full.push(await loadBitmap(it.path, Math.max(64, need)));
        s.status.textContent = `Preparing ${i + 1} of ${items.length}…`;
      }
      const out = new OffscreenCanvas(W, H);
      const ctx = out.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      paint(ctx, W, H, 1, full);
      full.forEach((b) => b.close());
      const { fmt: f, quality } = fmt.get();
      const bytes = await canvasBytes(f === 'jpg' ? flatten(out, st.bg) : out, f, quality);
      await saveBytes(items[0].path, f, ' collage', bytes);
      api().send('window:close');
    } catch (e: any) {
      s.status.textContent = e?.message ?? String(e);
      s.primary.disabled = false;
      s.primary.textContent = 'Save';
    }
  };
  (window as any).__collage = { st, draw, get items() { return items; } };
}
