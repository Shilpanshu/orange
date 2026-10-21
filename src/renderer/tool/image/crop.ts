// Crop: interactive crop box over a screen-size preview; the real work runs in the main
// process with sharp so it is fast for many files and keeps format and metadata.
// The crop is stored resolution-independently (centre + relative size + aspect) so one
// setting applies sensibly to every selected image.
import { base, h, numberInput, runAndClose, section, segmented, shell } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { FitView, HANDLE_CURSOR, clamp, cssVar, dims, dragRect, drawHandles, hitHandle, isTyping, loadPreview, rafThrottle, stageCanvas, toolButton, xicon, type Handle, type Rect, capture } from './common';

interface CropSpec {
  aspect: number | null;
  cx: number;
  cy: number;
  nw: number;
  nh: number;
  f: number;
}

/** Same maths as cropRect() in main/ops/tools-image.ts, without the integer rounding. */
function specRect(W: number, H: number, s: CropSpec): Rect {
  let w: number, hh: number;
  if (s.aspect) {
    w = Math.max(1, s.f * Math.min(W, H * s.aspect));
    hh = w / s.aspect;
  } else {
    w = Math.max(1, s.nw * W);
    hh = Math.max(1, s.nh * H);
  }
  w = Math.min(w, W);
  hh = Math.min(hh, H);
  const x = clamp(s.cx * W - w / 2, 0, W - w);
  const y = clamp(s.cy * H - hh / 2, 0, H - hh);
  return { x, y, w, h: hh };
}

function rectSpec(r: Rect, W: number, H: number, aspect: number | null): CropSpec {
  return {
    aspect,
    cx: (r.x + r.w / 2) / W,
    cy: (r.y + r.h / 2) / H,
    nw: r.w / W,
    nh: r.h / H,
    f: aspect ? clamp(r.w / Math.min(W, H * aspect), 0.0001, 1) : 1,
  };
}

type AspectKey = 'free' | 'original' | '1:1' | '4:3' | '3:2' | '16:9' | '5:4' | 'custom';
const ASPECTS: { v: AspectKey; label: string }[] = [
  { v: 'free', label: 'Free' },
  { v: 'original', label: 'Original' },
  { v: '1:1', label: '1:1' },
  { v: '4:3', label: '4:3' },
  { v: '3:2', label: '3:2' },
  { v: '5:4', label: '5:4' },
  { v: '16:9', label: '16:9' },
  { v: 'custom', label: 'Custom' },
];

export async function cropImage(paths: string[]) {
  const multi = paths.length > 1;
  const s = shell({ title: 'Crop', file: multi ? `${paths.length} images` : base(paths[0]) });
  s.primary.textContent = multi ? `Crop ${paths.length} images` : 'Crop';
  s.primary.disabled = true;
  s.stage.classList.add('ix-stage');

  const cache = new Map<number, Promise<{ bmp: ImageBitmap; w: number; h: number }>>();
  const preview = (i: number) => {
    if (!cache.has(i)) cache.set(i, loadPreview(paths[i], 2048));
    return cache.get(i)!;
  };

  const st = {
    idx: 0,
    rotate: 0 as 0 | 90 | 180 | 270,
    flipH: false,
    flipV: false,
    aspectKey: 'free' as AspectKey,
    portrait: false,
    custom: { w: 4, h: 3 },
    exact: false,
    outW: 1080,
    outH: 1080,
    spec: { aspect: null, cx: 0.5, cy: 0.5, nw: 1, nh: 1, f: 1 } as CropSpec,
  };

  let cur = await preview(0);
  let rotated: HTMLCanvasElement | OffscreenCanvas = new OffscreenCanvas(1, 1);
  // Rotated full-res size of the current image.
  const RW = () => (st.rotate % 180 ? cur.h : cur.w);
  const RH = () => (st.rotate % 180 ? cur.w : cur.h);

  function buildRotated() {
    const b = cur.bmp;
    const swap = st.rotate % 180 !== 0;
    const w = swap ? b.height : b.width;
    const hh = swap ? b.width : b.height;
    const c = new OffscreenCanvas(w, hh);
    const x = c.getContext('2d')!;
    x.translate(w / 2, hh / 2);
    x.scale(st.flipH ? -1 : 1, st.flipV ? -1 : 1);
    x.rotate((st.rotate * Math.PI) / 180);
    x.drawImage(b, -b.width / 2, -b.height / 2);
    rotated = c;
  }

  function aspectValue(): number | null {
    if (st.exact) return st.outW / st.outH;
    let a: number | null;
    switch (st.aspectKey) {
      case 'free':
        return null;
      case 'original':
        return RW() / RH();
      case 'custom':
        a = st.custom.w / st.custom.h;
        break;
      default: {
        const [x, y] = st.aspectKey.split(':').map(Number);
        a = x / y;
      }
    }
    return st.portrait ? 1 / a : a;
  }

  /** Largest crop of the current aspect, centred on the current crop. */
  function applyAspect() {
    const a = aspectValue();
    const r = specRect(RW(), RH(), st.spec);
    // Free keeps the current box; a ratio takes the largest box of that shape around its centre.
    st.spec = a ? { aspect: a, cx: (r.x + r.w / 2) / RW(), cy: (r.y + r.h / 2) / RH(), nw: 1, nh: 1, f: 1 } : rectSpec(r, RW(), RH(), null);
    sync();
  }

  // ------------------------------------------------------------ stage
  const view = new FitView(1, 1, 32);
  const sc = stageCanvas(s.stage, () => draw());
  const canvas = sc.canvas;
  let dragging = false;

  const draw = rafThrottle(() => {
    view.w = RW();
    view.h = RH();
    view.fit(sc.w, sc.h);
    sc.begin();
    const ctx = sc.ctx;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(rotated, view.ox, view.oy, RW() * view.scale, RH() * view.scale);
    const r = specRect(RW(), RH(), st.spec);
    const p = view.toView(r.x, r.y);
    const vr = { x: p.x, y: p.y, w: r.w * view.scale, h: r.h * view.scale };
    // Dim outside the crop.
    ctx.save();
    ctx.fillStyle = 'rgba(12,10,8,0.55)';
    ctx.beginPath();
    ctx.rect(view.ox, view.oy, RW() * view.scale, RH() * view.scale);
    ctx.rect(vr.x, vr.y, vr.w, vr.h);
    ctx.fill('evenodd');
    ctx.restore();
    // Thirds while dragging.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    if (dragging) {
      ctx.beginPath();
      for (const k of [1 / 3, 2 / 3]) {
        ctx.moveTo(vr.x + vr.w * k, vr.y);
        ctx.lineTo(vr.x + vr.w * k, vr.y + vr.h);
        ctx.moveTo(vr.x, vr.y + vr.h * k);
        ctx.lineTo(vr.x + vr.w, vr.y + vr.h * k);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vr.x, vr.y, vr.w, vr.h);
    ctx.restore();
    drawHandles(ctx, vr, cssVar('--accent'));
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const r = specRect(RW(), RH(), st.spec);
    const p = view.toView(r.x, r.y);
    let hd = hitHandle({ x: p.x, y: p.y, w: r.w * view.scale, h: r.h * view.scale }, vx, vy, 9);
    const start = view.toImg(vx, vy);
    let base = r;
    if (!hd) {
      // Drag on the image outside the box draws a new box.
      if (start.x < 0 || start.y < 0 || start.x > RW() || start.y > RH()) return;
      base = { x: start.x, y: start.y, w: 0, h: 0 };
      hd = 'se';
    }
    const aspect = aspectValue();
    const bounds = { x: 0, y: 0, w: RW(), h: RH() };
    capture(canvas, e.pointerId);
    dragging = true;
    const fresh = base.w === 0;
    const move = (ev: PointerEvent) => {
      const rr = canvas.getBoundingClientRect();
      const q = view.toImg(ev.clientX - rr.left, ev.clientY - rr.top);
      let nr: Rect;
      if (fresh) {
        // Grow from the press point in whichever direction the pointer went.
        const dx = q.x - start.x, dy = q.y - start.y;
        const hdl: Handle = `${dy < 0 ? 'n' : 's'}${dx < 0 ? 'w' : 'e'}` as Handle;
        nr = dragRect({ x: start.x, y: start.y, w: 0.001, h: 0.001 }, hdl, dx, dy, aspect, bounds, 8 / view.scale);
      } else nr = dragRect(base, hd!, q.x - start.x, q.y - start.y, aspect, bounds, 16 / view.scale);
      st.spec = rectSpec(nr, RW(), RH(), aspect);
      sync(false);
    };
    const up = () => {
      dragging = false;
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      sync();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) return;
    const rect = canvas.getBoundingClientRect();
    const r = specRect(RW(), RH(), st.spec);
    const p = view.toView(r.x, r.y);
    const hd = hitHandle({ x: p.x, y: p.y, w: r.w * view.scale, h: r.h * view.scale }, e.clientX - rect.left, e.clientY - rect.top, 9);
    canvas.style.cursor = hd ? HANDLE_CURSOR[hd] : 'crosshair';
  });
  canvas.addEventListener('dblclick', () => {
    // Double-click resets to the largest crop.
    st.spec = { ...st.spec, cx: 0.5, cy: 0.5, nw: 1, nh: 1, f: 1 };
    sync();
  });
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || !e.key.startsWith('Arrow')) return;
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) / view.scale;
    const r = specRect(RW(), RH(), st.spec);
    r.x = clamp(r.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0), 0, RW() - r.w);
    r.y = clamp(r.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0), 0, RH() - r.h);
    st.spec = rectSpec(r, RW(), RH(), st.spec.aspect);
    sync();
  });

  // ------------------------------------------------------------ panel
  const rotate = (d: 90 | -90) => {
    const flipped = st.flipH !== st.flipV;
    st.rotate = (((st.rotate + (flipped ? -d : d)) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
    // The crop follows the picture: rotate its centre and swap its proportions.
    const { cx, cy } = st.spec;
    st.spec = { ...st.spec, cx: d === 90 ? 1 - cy : cy, cy: d === 90 ? cx : 1 - cx, nw: st.spec.nh, nh: st.spec.nw };
    if (st.spec.aspect && !st.exact) {
      st.portrait = !st.portrait;
      st.spec.aspect = aspectValue();
    }
    buildRotated();
    sync();
  };
  const flip = (hz: boolean) => {
    if (hz) {
      st.flipH = !st.flipH;
      st.spec = { ...st.spec, cx: 1 - st.spec.cx };
    } else {
      st.flipV = !st.flipV;
      st.spec = { ...st.spec, cy: 1 - st.spec.cy };
    }
    buildRotated();
    sync();
  };
  const xform = h(
    'div',
    { class: 'row' },
    toolButton(xicon('rotL'), 'Rotate left', () => rotate(-90), 'fixed'),
    toolButton(xicon('rotR'), 'Rotate right', () => rotate(90), 'fixed'),
    toolButton(xicon('flipH'), 'Flip horizontally', () => flip(true), 'fixed'),
    toolButton(xicon('flipV'), 'Flip vertically', () => flip(false), 'fixed'),
    h('span', {}),
    h(
      'button',
      {
        class: 'btn small ghost fixed',
        onclick: () => {
          st.rotate = 0;
          st.flipH = st.flipV = false;
          st.exact = false;
          st.aspectKey = 'free';
          st.portrait = false;
          outSeg.set('crop');
          st.spec = { aspect: null, cx: 0.5, cy: 0.5, nw: 1, nh: 1, f: 1 };
          buildRotated();
          sync();
        },
      },
      'Reset',
    ),
  );

  const aspBtns = h('div', { class: 'ix-grid-btns' });
  for (const a of ASPECTS) {
    aspBtns.append(
      h(
        'button',
        {
          class: 'btn',
          'data-v': a.v,
          onclick: () => {
            st.aspectKey = a.v;
            st.exact = false;
            outSeg.set('crop');
            applyAspect();
          },
        },
        a.label,
      ),
    );
  }
  const orientBtn = h(
    'button',
    {
      class: 'btn small',
      onclick: () => {
        st.portrait = !st.portrait;
        applyAspect();
      },
    },
    h('span', { html: icon('rotate', 14) }),
    h('span', {}, 'Portrait'),
  );
  const customRow = h(
    'div',
    { class: 'ix-dims' },
    numberInput(st.custom.w, (v) => ((st.custom.w = v), applyAspect()), { min: 0.01, step: 0.01 }),
    h('span', { class: 'x' }, ':'),
    numberInput(st.custom.h, (v) => ((st.custom.h = v), applyAspect()), { min: 0.01, step: 0.01 }),
  );

  const outW = numberInput(st.outW, (v) => ((st.outW = v), st.exact && applyAspect()), { min: 1, max: 30000 });
  const outH = numberInput(st.outH, (v) => ((st.outH = v), st.exact && applyAspect()), { min: 1, max: 30000 });
  const exactRow = h('div', { class: 'ix-dims' }, outW, h('span', { class: 'x' }, '×'), outH);
  const outSeg = segmented(
    [
      { value: 'crop', label: 'Crop size' },
      { value: 'exact', label: 'Exact size' },
    ],
    'crop',
    (v) => {
      st.exact = v === 'exact';
      if (st.exact) {
        const r = specRect(RW(), RH(), st.spec);
        st.outW = Math.round(r.w);
        st.outH = Math.round(r.h);
        outW.value = String(st.outW);
        outH.value = String(st.outH);
      }
      applyAspect();
    },
  );
  const readout = h('div', { class: 'ix-readout' });

  const strip = h('div', { class: 'ix-crop-strip' });
  if (multi) {
    paths.forEach((p, i) => {
      const b = h('button', { title: base(p), 'aria-label': base(p), onclick: () => show(i) });
      strip.append(b);
      preview(i).then(async (pv) => {
        const c = new OffscreenCanvas(104, 104);
        const x = c.getContext('2d')!;
        const k = Math.max(104 / pv.bmp.width, 104 / pv.bmp.height);
        x.drawImage(pv.bmp, (104 - pv.bmp.width * k) / 2, (104 - pv.bmp.height * k) / 2, pv.bmp.width * k, pv.bmp.height * k);
        const blob = await c.convertToBlob();
        b.style.backgroundImage = `url(${URL.createObjectURL(blob)})`;
      });
    });
  }

  if (multi) {
    s.panel.append(
      section(
          `${paths.length} images`,
          strip,
          h('p', { class: 'hint' }, 'The same crop is applied to each image, centred where you place it. Click a thumbnail to check how it lands.'),
      ),
    );
  }
  s.panel.append(
    section('Rotate and flip', h('div', { class: 'field' }, xform)),
    section('Aspect ratio', h('div', { class: 'field' }, aspBtns), h('div', { class: 'field row' }, customRow), h('div', { class: 'field' }, orientBtn)),
    section('Output', h('div', { class: 'field' }, outSeg), h('div', { class: 'field' }, exactRow), readout),
  );

  async function show(i: number) {
    st.idx = i;
    cur = await preview(i);
    if (st.aspectKey === 'original' && !st.exact) st.spec.aspect = aspectValue();
    buildRotated();
    sync();
  }

  function sync(full = true) {
    const a = aspectValue();
    if (full || st.exact) {
      aspBtns.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', !st.exact && b.dataset.v === st.aspectKey));
      customRow.style.display = st.aspectKey === 'custom' && !st.exact ? '' : 'none';
      const showOrient = !st.exact && a !== null && Math.abs(a - 1) > 1e-6 && st.aspectKey !== 'original';
      orientBtn.style.display = showOrient ? '' : 'none';
      orientBtn.lastElementChild!.textContent = st.portrait ? 'Landscape' : 'Portrait';
      exactRow.style.display = st.exact ? '' : 'none';
      strip.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === st.idx));
    }
    const r = specRect(RW(), RH(), st.spec);
    readout.textContent = `${dims(r.w, r.h)} px${st.exact ? ` → ${dims(st.outW, st.outH)} px` : ''}${multi ? ` on ${base(paths[st.idx])}` : ''}`;
    s.status.textContent = `${dims(RW(), RH())} original`;
    draw();
  }

  buildRotated();
  sync();
  s.primary.disabled = false;
  s.primary.onclick = () => {
    const spec = { ...st.spec, aspect: aspectValue() };
    runAndClose(s.primary, 'cropImage', paths, {
      rotate: st.rotate,
      flipH: st.flipH,
      flipV: st.flipV,
      spec,
      out: st.exact ? { w: st.outW, h: st.outH } : null,
    }, s.status);
  };
  (window as any).__crop = { st, sync, rotate, flip };
}
