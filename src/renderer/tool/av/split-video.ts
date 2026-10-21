import { h, shell, section, field, segmented, numberInput, runAndClose, base, fmtTime } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { probe, loadMedia, Player, bindKeys, transport, videoStage, Timeline, timelineBlock, keyframes, kbdHints, describeVideo, gbtn, clamp } from './media';

export async function splitVideo([path]: string[]) {
  const info = await probe(path);
  const D = info.duration;
  const s = shell({ title: 'Split video', file: base(path), plainStage: true });
  s.primary.textContent = 'Split';
  const { dock, frame, video } = videoStage(s.stage, info);
  const player = new Player(video, D, info.fps);
  void loadMedia(path, video, frame);

  let mode: 'markers' | 'equal' = 'markers';
  let parts = 2;
  let exportMode: 'precise' | 'fast' = 'precise';
  let markers: number[] = [D / 2];
  let selected = -1;
  let kf: number[] = [];
  let kfLoaded = false;

  const tl = new Timeline({ duration: D, kind: 'thumbs' });
  const segLayer = h('div', { class: 'av-segs' });
  const markLayer = h('div', { class: 'av-splits' });
  tl.layer.append(segLayer, markLayer);
  tl.onSeek((t) => (player.pause(), player.seek(t)));
  player.onTime((t) => tl.setTime(t));

  const points = () => (mode === 'equal' ? Array.from({ length: parts - 1 }, (_, i) => ((i + 1) * D) / parts) : [...markers].sort((a, b) => a - b));
  const snapped = (p: number) => kf.reduce((best, k) => (Math.abs(k - p) < Math.abs(best - p) ? k : best), kf[0] ?? p);
  const effective = () => {
    let ps = points();
    if (exportMode === 'fast' && kf.length) ps = [...new Set(ps.map(snapped))].filter((p) => p > 0.05 && p < D - 0.05).sort((a, b) => a - b);
    return ps;
  };

  const partList = h('div', { class: 'av-parts' });
  const hint = h('p', { class: 'hint' });
  const addBtn = h('button', { class: 'btn av-add', html: `${icon('plus', 16)}<span>Split at playhead</span>`, onclick: () => addMarker(player.time) });
  const partsInput = numberInput(parts, (v) => {
    parts = v;
    render();
  }, { min: 2, max: 50 });
  const markerBox = h('div', {}, addBtn, h('p', { class: 'hint' }, 'Drag a marker to move it. Double-click a marker to remove it.'));
  const equalBox = field('Number of parts', partsInput);

  function addMarker(t: number) {
    t = clamp(t, 0.1, D - 0.1);
    if (markers.some((m) => Math.abs(m - t) < 0.05)) return;
    markers.push(t);
    selected = markers.length - 1;
    render();
  }

  function render() {
    markerBox.hidden = mode !== 'markers';
    equalBox.hidden = mode !== 'equal';
    const ps = effective();
    const bounds = [0, ...ps, D];
    // Alternating segment bands with part numbers.
    segLayer.innerHTML = '';
    for (let i = 0; i < bounds.length - 1; i++) {
      segLayer.append(h('div', { class: `av-seg ${i % 2 ? 'odd' : ''}`, style: { left: tl.pct(bounds[i]), width: `calc(${tl.pct(bounds[i + 1])} - ${tl.pct(bounds[i])})` } }, h('span', {}, String(i + 1))));
    }
    markLayer.innerHTML = '';
    if (mode === 'markers') {
      markers.forEach((m, i) => {
        const el = h('div', { class: `av-split${i === selected ? ' sel' : ''}`, style: { left: tl.pct(m) }, title: `${fmtTime(m)} · double-click to remove` });
        tl.drag(el, (t) => {
          markers[i] = clamp(t, 0.05, D - 0.05);
          selected = i;
          el.style.left = tl.pct(markers[i]);
          player.pause();
          player.seek(markers[i]);
          renderList();
        }, () => render());
        el.addEventListener('dblclick', () => {
          markers.splice(i, 1);
          selected = -1;
          render();
        });
        markLayer.append(el);
      });
    } else {
      for (const p of points()) markLayer.append(h('div', { class: 'av-split fixed', style: { left: tl.pct(p) } }));
    }
    if (exportMode === 'fast' && kf.length) for (const p of ps) markLayer.append(h('div', { class: 'av-split ghost', style: { left: tl.pct(p) } }));
    renderList();
  }

  function renderList() {
    const ps = effective();
    const bounds = [0, ...ps, D];
    partList.innerHTML = '';
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i];
      const b = bounds[i + 1];
      partList.append(
        h(
          'div',
          { class: 'av-part', onclick: () => player.play(a, b), title: 'Play this part' },
          h('span', { class: 'av-idx' }, String(i + 1)),
          h('span', { class: 'time' }, `${fmtTime(a)} – ${fmtTime(b)}`),
          h('span', { class: 'muted time' }, fmtTime(b - a, false)),
        ),
      );
    }
    const n = bounds.length - 1;
    const noKeys = exportMode === 'fast' && kfLoaded && kf.length < 2;
    s.status.textContent = n < 2 ? 'Add at least one split point' : `${n} parts, saved together in one folder`;
    s.primary.disabled = n < 2 || noKeys;
    hint.textContent = noKeys
      ? 'This video has too few keyframes to split without re-encoding. Choose Precise.'
      : exportMode === 'fast'
        ? 'Copies the original streams: instant and lossless. Each cut moves to the nearest keyframe (shown dashed).'
        : 'Re-encodes each part so every cut lands on the exact frame.';
    hint.classList.toggle('av-bad', noKeys);
  }

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0 && mode === 'markers' && !(e.target as HTMLElement).closest('input')) {
      markers.splice(selected, 1);
      selected = -1;
      render();
    }
  });

  s.panel.append(
    section(
      'Split',
      segmented(
        [
          { value: 'markers', label: 'At markers' },
          { value: 'equal', label: 'Equal parts' },
        ],
        mode,
        (v) => {
          mode = v as any;
          render();
        },
      ),
      markerBox,
      equalBox,
    ),
    section('Parts', partList),
    section(
      'Export',
      segmented(
        [
          { value: 'precise', label: 'Precise' },
          { value: 'fast', label: 'Fast (no re-encode)' },
        ],
        exportMode,
        (v) => {
          exportMode = v as any;
          render();
        },
      ),
      hint,
    ),
    section('Keys', kbdHints([['S', 'Split at playhead'], ['Del', 'Remove selected marker'], ['← →', 'One frame (Shift: 1 s)']])),
  );

  dock.append(transport(player), timelineBlock(tl));
  dock.querySelector('.av-transport')!.append(h('span', { class: 'muted' }, describeVideo(info)), gbtn('marker', 'Split at playhead (S)', () => addMarker(player.time)));
  bindKeys(player, { s: () => mode === 'markers' && addMarker(player.time) });
  render();

  s.primary.addEventListener('click', () =>
    runAndClose(s.primary, 'splitVideo', [path], mode === 'equal' ? { parts, mode: exportMode } : { points: points(), mode: exportMode }, s.status),
  );
  requestAnimationFrame(() => void tl.thumbs(path, (info.width || 16) / (info.height || 9)));
  keyframes(path)
    .then((k) => {
      kf = k;
      kfLoaded = true;
      render();
    })
    .catch(() => {});
}
