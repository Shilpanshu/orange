import { h, shell, section, field, segmented, runAndClose, base, fmtTime } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { probe, loadMedia, Player, bindKeys, transport, videoStage, Timeline, timelineBlock, RectBox, timeField, describeVideo, clamp, isTyping } from './media';

type Style = 'blur' | 'pixelate' | 'solid';
interface Box {
  id: number;
  start: number;
  end: number;
  style: Style;
  color: string;
  rb: RectBox;
}

export async function redactVideo([path]: string[]) {
  const info = await probe(path);
  const W = info.width;
  const H = info.height;
  const D = info.duration;
  const s = shell({ title: 'Redact video', file: base(path), plainStage: true });
  s.primary.textContent = 'Save';
  const { dock, frame, video } = videoStage(s.stage, info);
  frame.classList.add('av-redact');
  const player = new Player(video, D, info.fps);
  void loadMedia(path, video, frame);

  const boxes: Box[] = [];
  let sel: Box | null = null;
  let nextId = 1;
  let lastStyle: Style = 'blur';

  const tl = new Timeline({ duration: D, kind: 'thumbs' });
  const tracks = h('div', { class: 'av-tracks' });
  const tracksHead = h('div', { class: 'av-tracks-head' });
  tl.onSeek((t) => (player.pause(), player.seek(t)));
  player.onTime((t) => {
    tl.setTime(t);
    tracksHead.style.left = tl.pct(t);
    syncVisibility(t);
  });

  // ------------------------------------------------------------- boxes
  function add(r: { x: number; y: number; w: number; h: number }) {
    const rb = new RectBox(frame, W, H, r, `redact ${lastStyle}`);
    rb.min = 8;
    const b: Box = { id: nextId++, start: 0, end: D, style: lastStyle, color: '#000000', rb };
    rb.el.addEventListener('pointerdown', () => select(b), true);
    rb.onChange(() => renderPanel());
    boxes.push(b);
    select(b);
    return b;
  }
  function remove(b: Box) {
    b.rb.el.remove();
    boxes.splice(boxes.indexOf(b), 1);
    if (sel === b) sel = boxes[boxes.length - 1] ?? null;
    renderAll();
  }
  function select(b: Box | null) {
    sel = b;
    renderAll();
  }
  function styleBox(b: Box) {
    b.rb.el.className = `av-rect redact ${b.style}${b === sel ? ' sel' : ''}`;
    b.rb.el.style.setProperty('--fill', b.color);
  }
  function syncVisibility(t = player.time) {
    for (const b of boxes) b.rb.el.classList.toggle('off', t < b.start || t > b.end);
  }

  // Drag on the picture to draw a new box.
  frame.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.av-rect')) return;
    player.pause();
    const r = frame.getBoundingClientRect();
    const k = W / r.width;
    const x0 = clamp((e.clientX - r.left) * k, 0, W);
    const y0 = clamp((e.clientY - r.top) * k, 0, H);
    let b: Box | null = null;
    frame.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x1 = clamp((ev.clientX - r.left) * k, 0, W);
      const y1 = clamp((ev.clientY - r.top) * k, 0, H);
      const nr = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      if (!b && nr.w * nr.h > 64 / (k * k)) b = add(nr);
      else if (b) b.rb.set(nr);
    };
    frame.addEventListener('pointermove', move);
    frame.addEventListener('pointerup', () => frame.removeEventListener('pointermove', move), { once: true });
  });

  // ------------------------------------------------------------- tracks
  function renderTracks() {
    tracks.innerHTML = '';
    tracks.append(tracksHead);
    if (!boxes.length) tracks.append(h('div', { class: 'av-tracks-empty' }, 'Each box gets a bar here showing when it is visible.'));
    boxes.forEach((b, i) => {
      const bar = h('div', { class: `av-bar ${b.style}${b === sel ? ' sel' : ''}`, style: { left: tl.pct(b.start), width: `calc(${tl.pct(b.end)} - ${tl.pct(b.start)})` } }, h('span', {}, `Box ${i + 1}`));
      const l = h('div', { class: 'av-bar-edge l' });
      const r = h('div', { class: 'av-bar-edge r' });
      bar.append(l, r);
      let s0 = 0;
      let e0 = 0;
      bar.addEventListener('pointerdown', () => ((s0 = b.start), (e0 = b.end), select(b)), true);
      const commit = () => renderAll();
      const place = () => {
        bar.style.left = tl.pct(b.start);
        bar.style.width = `calc(${tl.pct(b.end)} - ${tl.pct(b.start)})`;
        renderPanel();
        syncVisibility();
      };
      tl.drag(l, (t) => {
        b.start = clamp(t, 0, b.end - 0.1);
        player.seek(b.start);
        place();
      }, commit);
      tl.drag(r, (t) => {
        b.end = clamp(t, b.start + 0.1, D);
        player.seek(b.end);
        place();
      }, commit);
      tl.drag(bar, (t, _e, t0) => {
        const len = e0 - s0;
        b.start = clamp(s0 + t - t0, 0, D - len);
        b.end = b.start + len;
        place();
      }, commit);
      tracks.append(h('div', { class: 'av-track' }, bar));
    });
  }

  // -------------------------------------------------------------- panel
  const listBox = h('div', { class: 'av-boxlist' });
  const detail = h('div', {});
  function renderPanel() {
    listBox.innerHTML = '';
    if (!boxes.length) listBox.append(h('p', { class: 'hint' }, 'Drag on the video to cover a face, a plate or any area. Add as many boxes as you need.'));
    boxes.forEach((b, i) =>
      listBox.append(
        h(
          'button',
          { class: `av-boxrow${b === sel ? ' on' : ''}`, onclick: () => select(b) },
          h('span', { class: `av-swatch ${b.style}`, style: { background: b.style === 'solid' ? b.color : '' } }),
          h('span', {}, `Box ${i + 1}`),
          h('span', { class: 'muted time' }, `${fmtTime(b.start, false)}–${fmtTime(b.end, false)}`),
        ),
      ),
    );
    detail.innerHTML = '';
    if (!sel) return;
    const b = sel;
    const startF = timeField(b.start, (v) => setTimes(b, v, b.end), { max: D });
    const endF = timeField(b.end, (v) => setTimes(b, b.start, v), { max: D });
    const color = h('input', { type: 'color', value: b.color }) as HTMLInputElement;
    color.addEventListener('input', () => {
      b.color = color.value;
      styleBox(b);
      renderTracks();
    });
    const colorRow = field('Colour', color);
    colorRow.hidden = b.style !== 'solid';
    detail.append(
      section(
        `Box ${boxes.indexOf(b) + 1}`,
        segmented(
          [
            { value: 'blur', label: 'Blur' },
            { value: 'pixelate', label: 'Pixelate' },
            { value: 'solid', label: 'Solid' },
          ],
          b.style,
          (v) => {
            b.style = lastStyle = v as Style;
            renderAll();
          },
        ),
        colorRow,
        field('Visible from', h('div', { class: 'row' }, startF, h('button', { class: 'btn small fixed', onclick: () => setTimes(b, player.time, b.end), title: 'Start at the playhead' }, 'Playhead'))),
        field('Until', h('div', { class: 'row' }, endF, h('button', { class: 'btn small fixed', onclick: () => setTimes(b, b.start, player.time), title: 'End at the playhead' }, 'Playhead'))),
        h(
          'div',
          { class: 'row av-gap' },
          h('button', { class: 'btn small', onclick: () => setTimes(b, 0, D) }, 'Whole video'),
          h('button', { class: 'btn small av-danger', onclick: () => remove(b), html: `${icon('trash', 14)}<span>Remove</span>` }),
        ),
        h('p', { class: 'hint' }, `${b.rb.rect.w}×${b.rb.rect.h} px at ${b.rb.rect.x}, ${b.rb.rect.y}`),
      ),
    );
  }
  function setTimes(b: Box, a: number, e: number) {
    a = clamp(a, 0, D);
    e = clamp(e, 0, D);
    if (e - a < 0.1) {
      if (a !== b.start) a = Math.max(0, e - 0.1);
      else e = Math.min(D, a + 0.1);
    }
    b.start = a;
    b.end = e;
    renderAll();
  }
  function renderAll() {
    boxes.forEach(styleBox);
    renderTracks();
    renderPanel();
    syncVisibility();
    s.primary.disabled = !boxes.length;
    s.status.textContent = boxes.length ? `${boxes.length} box${boxes.length > 1 ? 'es' : ''}` : 'Drag on the video to add a box';
  }

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !isTyping(e)) remove(sel);
  });

  s.panel.append(section('Boxes', listBox), detail);
  dock.append(transport(player), timelineBlock(tl), tracks);
  dock.querySelector('.av-transport')!.append(h('span', { class: 'muted' }, describeVideo(info)));
  bindKeys(player);
  renderAll();

  s.primary.addEventListener('click', () =>
    runAndClose(s.primary, 'redactVideo', [path], { boxes: boxes.map((b) => ({ ...b.rb.rect, start: b.start, end: b.end, style: b.style, color: b.color })) }, s.status),
  );
  requestAnimationFrame(() => void tl.thumbs(path, W / H));
}
