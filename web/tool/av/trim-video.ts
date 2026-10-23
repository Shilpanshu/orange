import { h, shell, section, field, segmented, runAndClose, base, fmtTime } from '../../shared/ui';
import {
  probe, loadMedia, Player, bindKeys, transport, videoStage, Timeline, timelineBlock, rangeOnTimeline,
  timeField, keyframes, kbdHints, stat, describeVideo, gbtn, clamp,
} from './media';

export async function trimVideo([path]: string[]) {
  const info = await probe(path);
  const s = shell({ title: 'Trim video', file: base(path), plainStage: true });
  s.primary.textContent = 'Trim';
  const { dock, frame, video } = videoStage(s.stage, info);
  const player = new Player(video, info.duration, info.fps);
  void loadMedia(path, video, frame);

  let start = 0;
  let end = info.duration;
  let mode: 'fast' | 'precise' = 'precise';
  let kf: number[] = [];

  const tl = new Timeline({ duration: info.duration, kind: 'thumbs' });
  const ticks = h('div', { class: 'av-ticks' });
  tl.layer.append(ticks);
  tl.onSeek((t) => {
    player.pause();
    player.seek(t);
  });
  player.onTime((t) => tl.setTime(t));

  const startField = timeField(start, (v) => setRange(v, end, 'start'), { step: 1 / (info.fps || 30), max: info.duration });
  const endField = timeField(end, (v) => setRange(start, v, 'end'), { step: 1 / (info.fps || 30), max: info.duration });
  const length = h('strong', { class: 'time' });
  const hint = h('p', { class: 'hint' });

  const renderRange = rangeOnTimeline(tl, () => [start, end], (a, b, which) => {
    setRange(a, b, which);
    player.pause();
    player.seek(which === 'end' ? b : a);
  });

  function setRange(a: number, b: number, which: 'start' | 'end' | 'both') {
    const min = Math.min(0.1, info.duration / 10);
    a = clamp(a, 0, info.duration);
    b = clamp(b, 0, info.duration);
    if (b - a < min) {
      if (which === 'end') a = Math.max(0, b - min);
      else b = Math.min(info.duration, a + min);
      // Pinned against the end (or start) of the file: move the other point instead, so the
      // selection never collapses to nothing.
      if (b - a < min) {
        if (which === 'end') b = Math.min(info.duration, a + min);
        else a = Math.max(0, b - min);
      }
    }
    start = a;
    end = b;
    startField.show(start);
    endField.show(end);
    length.textContent = fmtTime(end - start);
    s.status.textContent = `Keeps ${fmtTime(end - start)} of ${fmtTime(info.duration)}`;
    renderRange();
    renderHint();
  }

  const keyframeBefore = (t: number) => kf.filter((k) => k <= t + 0.5 / (info.fps || 30)).pop() ?? 0;
  function renderHint() {
    const onKey = kf.length ? Math.abs(keyframeBefore(start) - start) <= 0.5 / (info.fps || 30) : start === 0;
    if (mode === 'fast') {
      const k = keyframeBefore(start);
      hint.textContent =
        !kf.length || onKey
          ? 'Copies the original streams: instant and lossless.'
          : `Copies the original streams: instant and lossless, but the clip will begin at the keyframe ${(start - k).toFixed(2)} s before your In point.`;
    } else {
      hint.textContent = onKey
        ? 'The In point sits on a keyframe, so this will be a lossless copy.'
        : 'Re-encodes so the cut lands on the exact frame. Takes a little longer.';
    }
    ticks.classList.toggle('show', mode === 'fast');
  }

  const setIn = () => setRange(Math.min(player.time, end - 0.05), end, 'start');
  const setOut = () => setRange(start, Math.max(player.time, start + 0.05), 'end');

  // Snap the In point to the nearest keyframe (useful for fast, lossless trims).
  const snap = h('button', { class: 'btn small', title: 'Move the In point to the keyframe before it' }, 'Snap to keyframe');
  snap.addEventListener('click', () => {
    setRange(keyframeBefore(start), end, 'start');
    player.seek(start);
  });

  s.panel.append(
    section(
      'Selection',
      field('In', h('div', { class: 'row' }, startField, h('button', { class: 'btn small fixed', title: 'Set In at the playhead (I)', onclick: setIn }, 'Set'))),
      field('Out', h('div', { class: 'row' }, endField, h('button', { class: 'btn small fixed', title: 'Set Out at the playhead (O)', onclick: setOut }, 'Set'))),
      stat('Length', length),
      h('div', { class: 'row av-gap' }, h('button', { class: 'btn small', onclick: () => player.play(start, end) }, 'Play selection'), h('button', { class: 'btn small', onclick: () => setRange(0, info.duration, 'both') }, 'Reset')),
    ),
    section(
      'Export',
      segmented(
        [
          { value: 'precise', label: 'Precise' },
          { value: 'fast', label: 'Fast (no re-encode)' },
        ],
        mode,
        (v) => {
          mode = v as any;
          snap.hidden = mode !== 'fast';
          renderHint();
        },
      ),
      hint,
      snap,
    ),
    section('Keys', kbdHints([['Space', 'Play / pause'], ['← →', 'One frame (Shift: 1 s)'], ['I  O', 'Set In / Out at playhead']])),
  );
  snap.hidden = true;

  dock.append(transport(player), timelineBlock(tl));
  dock.querySelector('.av-transport')!.append(h('span', { class: 'muted' }, describeVideo(info)), gbtn('loop', 'Play selection', () => player.play(start, end)));

  bindKeys(player, { i: setIn, o: setOut });
  setRange(0, info.duration, 'both');
  s.primary.addEventListener('click', () => runAndClose(s.primary, 'trimVideo', [path], { start, end, mode }, s.status));

  requestAnimationFrame(() => void tl.thumbs(path, (info.width || 16) / (info.height || 9)));
  keyframes(path)
    .then((list) => {
      kf = list;
      ticks.append(...kf.map((k) => h('i', { style: { left: tl.pct(k) } })));
      renderHint();
    })
    .catch(() => {});
}
