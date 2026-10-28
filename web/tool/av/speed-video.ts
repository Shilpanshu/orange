import { h, shell, section, checkbox, runAndClose, base, fmtTime } from '../../shared/ui';
import { probe, loadMedia, Player, bindKeys, transport, videoStage, Timeline, timelineBlock, describeVideo } from './media';

const PRESETS = [0.25, 0.5, 0.75, 1.25, 1.5, 2, 3, 4];
const fmtX = (v: number) => `${Number(v.toFixed(2))}×`;

export async function speedVideo([path]: string[]) {
  const info = await probe(path);
  const s = shell({ title: 'Change speed', file: base(path), plainStage: true });
  s.primary.textContent = 'Save';
  const { dock, frame, video } = videoStage(s.stage, info);
  const player = new Player(video, info.duration, info.fps);
  void loadMedia(path, video, frame);

  let speed = 2;
  let keepPitch = true;
  let mute = false;

  // The slider is logarithmic so 0.25× and 4× sit at equal distances from 1×.
  const toPos = (v: number) => Math.log2(v);
  const fromPos = (p: number) => Math.pow(2, p);
  const readout = h('div', { class: 'av-speed-readout' });
  const slider = h('input', { type: 'range', min: -2, max: 2, step: 0.01, class: 'av-speed-slider' }) as HTMLInputElement;
  slider.addEventListener('input', () => {
    let v = fromPos(Number(slider.value));
    // Gentle detents on the presets and 1×.
    for (const p of [...PRESETS, 1]) if (Math.abs(Math.log2(v / p)) < 0.03) v = p;
    set(Math.round(v * 100) / 100, false);
  });
  const scale = h('div', { class: 'av-speed-scale' }, ...['0.25×', '0.5×', '1×', '2×', '4×'].map((t) => h('span', {}, t)));
  const chips = h('div', { class: 'av-chips' });
  for (const p of PRESETS) chips.append(h('button', { class: 'btn small', 'data-v': String(p), onclick: () => set(p) }, fmtX(p)));
  const lengthStat = h('strong', { class: 'time' });

  const pitch = checkbox('Keep the original pitch', keepPitch, (v) => {
    keepPitch = v;
    apply();
  });
  const muteBox = checkbox('Remove the audio', mute, (v) => {
    mute = v;
    pitch.querySelector('input')!.disabled = v;
    apply();
  });
  if (!info.hasAudio) {
    pitch.hidden = true;
    muteBox.hidden = true;
  }

  function apply() {
    video.playbackRate = speed;
    (video as any).preservesPitch = keepPitch;
    video.muted = mute;
  }
  function set(v: number, moveSlider = true) {
    speed = Math.max(0.25, Math.min(4, v));
    readout.textContent = fmtX(speed);
    if (moveSlider) slider.value = String(toPos(speed));
    chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === speed));
    lengthStat.textContent = fmtTime(info.duration / speed);
    s.status.textContent = speed === 1 ? 'Pick a speed other than 1×' : `${fmtTime(info.duration)} becomes ${fmtTime(info.duration / speed)}`;
    s.primary.disabled = speed === 1;
    apply();
  }
  video.addEventListener('loadeddata', apply);

  s.panel.append(
    section('Speed', readout, slider, scale, chips),
    section('Result', h('div', { class: 'av-stat' }, h('span', {}, 'New length'), lengthStat), pitch, muteBox,
      h('p', { class: 'hint' }, info.hasAudio ? 'The preview plays at the chosen speed.' : 'This video has no audio, so only the picture changes.')),
  );

  const tl = new Timeline({ duration: info.duration, kind: 'thumbs' });
  tl.onSeek((t) => (player.pause(), player.seek(t)));
  player.onTime((t) => tl.setTime(t));
  dock.append(transport(player), timelineBlock(tl));
  dock.querySelector('.av-transport')!.append(h('span', { class: 'muted' }, describeVideo(info)));
  bindKeys(player);
  set(speed);

  s.primary.addEventListener('click', () => runAndClose(s.primary, 'speedVideo', [path], { speed, keepPitch, mute }, s.status));
  requestAnimationFrame(() => void tl.thumbs(path, (info.width || 16) / (info.height || 9)));
}
