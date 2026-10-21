import { h, shell, section, field, checkbox, slider, runAndClose, base, fmtTime } from '../../shared/ui';
import { probe, loadMedia, Player, bindKeys, transport, Timeline, timelineBlock, rangeOnTimeline, timeField, kbdHints, stat, clamp, gbtn, type MediaInfo } from './media';

/** Stage for the audio editors: file header, a tall waveform and the transport underneath. */
export function audioStage(stage: HTMLElement, path: string, info: MediaInfo, tl: Timeline) {
  stage.classList.add('av-stage', 'av-audio');
  const audio = h('audio', { preload: 'auto' }) as HTMLAudioElement;
  const meta = [fmtTime(info.duration), info.acodec.toUpperCase().replace(/^PCM_.*/, 'PCM'), info.sampleRate ? `${(info.sampleRate / 1000).toFixed(1)} kHz` : '', info.channels === 1 ? 'Mono' : info.channels === 2 ? 'Stereo' : info.channels ? `${info.channels} channels` : '']
    .filter(Boolean)
    .join(' · ');
  const head = h('div', { class: 'av-audio-head' }, h('div', { class: 'av-audio-name' }, base(path)), h('div', { class: 'muted' }, meta));
  const view = h('div', { class: 'av-view av-wave-view' }, h('div', { class: 'av-wave-box' }, head, timelineBlock(tl)));
  const dock = h('div', { class: 'av-dock' });
  stage.append(view, dock, audio);
  return { view, dock, audio };
}

export async function trimAudio([path]: string[]) {
  const info = await probe(path);
  const D = info.duration;
  const s = shell({ title: 'Trim audio', file: base(path), plainStage: true });
  s.primary.textContent = 'Trim';
  const tl = new Timeline({ duration: D, kind: 'wave', tall: true });
  const { view, dock, audio } = audioStage(s.stage, path, info, tl);
  const player = new Player(audio, D, 0);
  void loadMedia(path, audio, view.querySelector('.av-wave-box') as HTMLElement);

  let start = 0;
  let end = D;
  let silence = false;
  let threshold = -50;

  tl.onSeek((t) => player.seek(t));
  player.onTime((t) => tl.setTime(t));
  const startField = timeField(start, (v) => setRange(v, end, 'start'), { step: 0.01, max: D });
  const endField = timeField(end, (v) => setRange(start, v, 'end'), { step: 0.01, max: D });
  const length = h('strong', { class: 'time' });

  const renderRange = rangeOnTimeline(tl, () => [start, end], (a, b, which) => {
    setRange(a, b, which);
    if (!player.playing) player.seek(which === 'end' ? b : a);
  });
  function setRange(a: number, b: number, which: 'start' | 'end' | 'both') {
    const min = Math.min(0.05, D / 10);
    a = clamp(a, 0, D);
    b = clamp(b, 0, D);
    if (b - a < min) {
      if (which === 'end') a = Math.max(0, b - min);
      else b = Math.min(D, a + min);
    }
    start = a;
    end = b;
    startField.show(a);
    endField.show(b);
    length.textContent = fmtTime(b - a);
    s.status.textContent = `Keeps ${fmtTime(b - a)} of ${fmtTime(D)}${silence ? ', minus silence at the edges' : ''}`;
    renderRange();
  }
  const setIn = () => setRange(Math.min(player.time, end - 0.05), end, 'start');
  const setOut = () => setRange(start, Math.max(player.time, start + 0.05), 'end');

  const th = slider({ label: 'Counts as silence below', min: -80, max: -20, step: 1, value: threshold, format: (v) => `${v} dB`, onInput: (v) => (threshold = v) });
  th.hidden = true;

  s.panel.append(
    section(
      'Selection',
      field('In', h('div', { class: 'row' }, startField, h('button', { class: 'btn small fixed', onclick: setIn, title: 'Set In at the playhead (I)' }, 'Set'))),
      field('Out', h('div', { class: 'row' }, endField, h('button', { class: 'btn small fixed', onclick: setOut, title: 'Set Out at the playhead (O)' }, 'Set'))),
      stat('Length', length),
      h('div', { class: 'row av-gap' }, h('button', { class: 'btn small', onclick: () => player.play(start, end) }, 'Play selection'), h('button', { class: 'btn small', onclick: () => setRange(0, D, 'both') }, 'Reset')),
    ),
    section(
      'Silence',
      checkbox('Also remove silence at the start and end', silence, (v) => {
        silence = v;
        th.hidden = !v;
        setRange(start, end, 'both');
      }),
      th,
      h('p', { class: 'hint' }, 'Quiet lead-in and tail are cut from the selection; pauses in the middle stay.'),
    ),
    section('Keys', kbdHints([['Space', 'Play / pause'], ['← →', '1 second'], ['I  O', 'Set In / Out at playhead']])),
  );
  dock.append(transport(player, { steps: false }));
  dock.querySelector('.av-transport')!.append(gbtn('loop', 'Play selection', () => player.play(start, end)));
  bindKeys(player, { i: setIn, o: setOut });
  setRange(0, D, 'both');

  s.primary.addEventListener('click', () => runAndClose(s.primary, 'trimAudio', [path], { start, end, trimSilence: silence, threshold }, s.status));
  requestAnimationFrame(() => void tl.wave(path));
}
