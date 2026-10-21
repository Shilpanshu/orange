import { h, shell, section, field, checkbox, runAndClose, base, numberInput } from '../../shared/ui';
import { probe, loadMedia, Player, bindKeys, transport, videoStage, Timeline, timelineBlock, RectBox, fitAspect, describeVideo, type Rect } from './media';

const ASPECTS: { label: string; v: number | 'free' | 'source' }[] = [
  { label: 'Free', v: 'free' },
  { label: 'Original', v: 'source' },
  { label: '16:9', v: 16 / 9 },
  { label: '9:16', v: 9 / 16 },
  { label: '1:1', v: 1 },
  { label: '4:3', v: 4 / 3 },
  { label: '4:5', v: 4 / 5 },
  { label: '21:9', v: 21 / 9 },
];

export async function cropVideo([path]: string[]) {
  const info = await probe(path);
  const W = info.width;
  const H = info.height;
  const s = shell({ title: 'Crop video', file: base(path), plainStage: true });
  s.primary.textContent = 'Crop';
  const { dock, frame, video } = videoStage(s.stage, info);
  frame.classList.add('av-crop');
  const player = new Player(video, info.duration, info.fps);
  void loadMedia(path, video, frame);

  // Dimmed surround + rule-of-thirds guides follow the box.
  const box = new RectBox(frame, W, H, { x: 0, y: 0, w: W, h: H }, 'crop');
  box.min = 16;
  box.el.append(h('div', { class: 'av-thirds' }));

  const inputs = {
    x: numberInput(0, (v) => box.set({ ...box.rect, x: v }), { min: 0, max: W }),
    y: numberInput(0, (v) => box.set({ ...box.rect, y: v }), { min: 0, max: H }),
    w: numberInput(W, (v) => setSize(v, box.aspect ? v / box.aspect : box.rect.h), { min: 16, max: W }),
    h: numberInput(H, (v) => setSize(box.aspect ? v * box.aspect : box.rect.w, v), { min: 16, max: H }),
  };
  function setSize(w: number, hh: number) {
    const r = box.rect;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    box.set({ x: cx - w / 2, y: cy - hh / 2, w, h: hh });
  }

  let resize = false;
  let outW = W;
  let outH = H;
  const outWIn = numberInput(W, (v) => {
    outW = v;
    outH = Math.round(v / (box.rect.w / box.rect.h));
    outHIn.value = String(outH);
    render();
  }, { min: 16, max: 7680 });
  const outHIn = numberInput(H, (v) => {
    outH = v;
    outW = Math.round(v * (box.rect.w / box.rect.h));
    outWIn.value = String(outW);
    render();
  }, { min: 16, max: 4320 });
  const outRow = h('div', { class: 'row' }, outWIn, h('span', { class: 'fixed muted' }, '×'), outHIn);

  const chips = h('div', { class: 'av-chips' });
  for (const a of ASPECTS) {
    const b = h('button', { class: 'btn small', 'data-k': a.label }, a.label);
    b.addEventListener('click', () => setAspect(a.label, a.v));
    chips.append(b);
  }
  function setAspect(key: string, v: number | 'free' | 'source') {
    chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === key));
    if (v === 'free') box.aspect = null;
    else {
      box.aspect = v === 'source' ? W / H : v;
      // Largest box of that shape, centred on the current one.
      const f = fitAspect(W, H, box.aspect);
      box.set(f);
    }
  }

  function render() {
    const r = box.rect;
    inputs.x.value = String(r.x);
    inputs.y.value = String(r.y);
    inputs.w.value = String(r.w);
    inputs.h.value = String(r.h);
    if (!resize) {
      outW = r.w;
      outH = r.h;
      outWIn.value = String(outW);
      outHIn.value = String(outH);
    }
    const ew = Math.round(r.w / 2) * 2;
    const eh = Math.round(r.h / 2) * 2;
    s.status.textContent = `Output ${resize ? `${outW}×${outH}` : `${ew}×${eh}`} · from ${W}×${H}`;
  }
  box.onChange(() => {
    if (resize) {
      outH = Math.round(outW / (box.rect.w / box.rect.h));
      outHIn.value = String(outH);
    }
    render();
  });

  // Drag on the picture outside the box to draw a new crop.
  frame.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.av-rect')) return;
    const r = frame.getBoundingClientRect();
    const k = W / r.width;
    const x0 = (e.clientX - r.left) * k;
    const y0 = (e.clientY - r.top) * k;
    frame.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x1 = Math.max(0, Math.min(W, (ev.clientX - r.left) * k));
      let y1 = Math.max(0, Math.min(H, (ev.clientY - r.top) * k));
      if (box.aspect) y1 = y0 + (Math.sign(y1 - y0) || 1) * (Math.abs(x1 - x0) / box.aspect);
      const nr: Rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      if (nr.w > 8 && nr.h > 8) box.set(nr);
    };
    frame.addEventListener('pointermove', move);
    frame.addEventListener('pointerup', () => frame.removeEventListener('pointermove', move), { once: true });
  });

  const reset = h('button', { class: 'btn small', onclick: () => (setAspect('Free', 'free'), box.set({ x: 0, y: 0, w: W, h: H })) }, 'Reset');
  const resizeCheck = checkbox('Resize the result', false, (v) => {
    resize = v;
    outRow.hidden = !v;
    render();
  });
  outRow.hidden = true;

  s.panel.append(
    section('Aspect ratio', chips),
    section(
      'Crop area (pixels)',
      h('div', { class: 'av-grid2' }, field('X', inputs.x), field('Y', inputs.y), field('Width', inputs.w), field('Height', inputs.h)),
      reset,
    ),
    section('Output', resizeCheck, outRow, h('p', { class: 'hint' }, info.hasAudio ? 'The audio is kept as it is.' : 'This video has no audio.')),
  );

  const tl = new Timeline({ duration: info.duration, kind: 'thumbs' });
  tl.onSeek((t) => (player.pause(), player.seek(t)));
  player.onTime((t) => tl.setTime(t));
  dock.append(transport(player), timelineBlock(tl));
  dock.querySelector('.av-transport')!.append(h('span', { class: 'muted' }, describeVideo(info)));
  bindKeys(player);
  setAspect('Free', 'free');
  render();

  s.primary.addEventListener('click', () => {
    const r = box.rect;
    runAndClose(s.primary, 'cropVideo', [path], { ...r, ...(resize ? { outW, outH } : {}) }, s.status);
  });
  requestAnimationFrame(() => void tl.thumbs(path, W / H));
}
