import { h, shell, section, segmented, slider, checkbox, runAndClose, base } from '../../shared/ui';
import { probe, loadMedia, Player, bindKeys, transport, Timeline } from './media';

export async function audioChannels([path]: string[]) {
  const info = await probe(path);
  const D = info.duration;
  const mono = info.channels === 1;
  const s = shell({ title: 'Audio channels', file: base(path), plainStage: true });
  s.primary.textContent = 'Save';
  s.stage.classList.add('av-stage', 'av-audio');

  let output: 'stereo' | 'mono' = mono ? 'stereo' : 'mono';
  let left = 1;
  let right = 1;
  let swap = false;
  let solo: 'both' | 'left' | 'right' = 'both';

  // One waveform per source channel; rows show the OUTPUT channels (so swapping moves them).
  const tlA = new Timeline({ duration: D, kind: 'wave' });
  const tlB = new Timeline({ duration: D, kind: 'wave' });
  const rowL = h('div', { class: 'av-chan' }, h('div', { class: 'av-chan-label' }, h('strong', {}, 'L'), h('span', { class: 'muted' })));
  const rowR = h('div', { class: 'av-chan' }, h('div', { class: 'av-chan-label' }, h('strong', {}, 'R'), h('span', { class: 'muted' })));
  const caption = h('p', { class: 'hint av-chan-caption' });
  const head = h('div', { class: 'av-audio-head' }, h('div', { class: 'av-audio-name' }, base(path)), h('div', { class: 'muted' }, mono ? 'Mono source' : info.channels === 2 ? 'Stereo source' : `${info.channels}-channel source, mixed to stereo first`));
  const box = h('div', { class: 'av-wave-box' }, head, rowL, rowR, caption);
  const view = h('div', { class: 'av-view av-wave-view' }, box);
  const dock = h('div', { class: 'av-dock' });
  const audio = h('audio', { preload: 'auto' }) as HTMLAudioElement;
  s.stage.append(view, dock, audio);
  const player = new Player(audio, D, 0);
  void loadMedia(path, audio, box);
  for (const tl of [tlA, tlB]) {
    tl.onSeek((t) => player.seek(t));
    player.onTime((t) => tl.setTime(t));
  }

  // ------------------------------------------------------- Web Audio preview
  let ctx: AudioContext | null = null;
  let split: ChannelSplitterNode;
  let gL: GainNode, gR: GainNode, mixL: GainNode, mixR: GainNode, merge: ChannelMergerNode;
  function ensureGraph() {
    if (ctx) return;
    ctx = new AudioContext();
    const src = ctx.createMediaElementSource(audio);
    split = ctx.createChannelSplitter(2);
    src.connect(split);
    gL = ctx.createGain();
    gR = ctx.createGain();
    mixL = ctx.createGain();
    mixR = ctx.createGain();
    merge = ctx.createChannelMerger(2);
    mixL.connect(merge, 0, 0);
    mixR.connect(merge, 0, 1);
    merge.connect(ctx.destination);
    wire();
  }
  function wire() {
    if (!ctx) return;
    split.disconnect();
    gL.disconnect();
    gR.disconnect();
    // A mono source only has channel 0.
    const srcL = mono ? 0 : swap ? 1 : 0;
    const srcR = mono ? 0 : swap ? 0 : 1;
    split.connect(gL, srcL);
    split.connect(gR, srcR);
    gL.gain.value = left;
    gR.gain.value = right;
    if (output === 'mono') {
      const n = (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0) || 1;
      gL.gain.value = left / n;
      gR.gain.value = right / n;
      gL.connect(mixL);
      gR.connect(mixL);
      gL.connect(mixR);
      gR.connect(mixR);
    } else {
      gL.connect(mixL);
      gR.connect(mixR);
    }
    mixL.gain.value = solo === 'right' ? 0 : 1;
    mixR.gain.value = solo === 'left' ? 0 : 1;
  }
  audio.addEventListener('play', () => {
    ensureGraph();
    void ctx!.resume();
  });

  // ------------------------------------------------------------- render
  function render() {
    const first = swap && !mono ? tlB : tlA;
    const second = mono ? tlA : swap ? tlA : tlB;
    // Rows show the source channel feeding each output, scaled by its volume.
    rowL.querySelector('.muted')!.textContent = `${Math.round(left * 100)}%${swap && !mono ? '\nfrom R' : ''}`;
    rowR.querySelector('.muted')!.textContent = `${Math.round(right * 100)}%${swap && !mono ? '\nfrom L' : ''}`;
    if (mono) {
      // The same source channel drives both rows: give the second row its own copy.
      rowL.append(tlA.el);
      rowR.append(tlB.el);
    } else {
      rowL.append(first.el);
      rowR.append(second.el);
    }
    rowL.classList.toggle('muted-row', left === 0 || solo === 'right');
    rowR.classList.toggle('muted-row', right === 0 || solo === 'left');
    caption.textContent =
      output === 'mono'
        ? 'Saved as mono: both rows are mixed into a single channel.'
        : mono
          ? 'Saved as stereo: the mono source is copied to both sides.'
          : swap
            ? 'Saved as stereo with left and right swapped.'
            : 'Saved as stereo.';
    tlA.redraw();
    tlB.redraw();
    wire();
    s.status.textContent = `${output === 'mono' ? 'Mono' : 'Stereo'} · L ${Math.round(left * 100)}% · R ${Math.round(right * 100)}%${swap ? ' · swapped' : ''}`;
  }

  const fmt = (v: number) => `${v}%`;
  const lS = slider({ label: 'Left volume', min: 0, max: 200, step: 5, value: 100, format: fmt, onInput: (v) => ((left = v / 100), render()) });
  const rS = slider({ label: 'Right volume', min: 0, max: 200, step: 5, value: 100, format: fmt, onInput: (v) => ((right = v / 100), render()) });
  const swapBox = checkbox('Swap left and right', swap, (v) => ((swap = v), render()));
  if (mono) swapBox.hidden = true;

  s.panel.append(
    section(
      'Output',
      segmented(
        [
          { value: 'stereo', label: 'Stereo' },
          { value: 'mono', label: 'Mono' },
        ],
        output,
        (v) => ((output = v as any), render()),
      ),
      h('p', { class: 'hint' }, mono ? 'This file is mono. Stereo copies it to both sides, with separate volumes.' : 'Mono mixes both channels into one. Set a side to 0% to keep only the other.'),
    ),
    section('Volume', lS, rS, swapBox),
  );

  const listen = segmented(
    [
      { value: 'both', label: 'Both' },
      { value: 'left', label: 'Left' },
      { value: 'right', label: 'Right' },
    ],
    solo,
    (v) => ((solo = v as any), render()),
  );
  listen.classList.add('av-ab');
  dock.append(transport(player, { steps: false }));
  dock.querySelector('.av-transport')!.append(h('span', { class: 'muted' }, 'Hear'), listen);
  bindKeys(player);
  render();

  s.primary.addEventListener('click', () => runAndClose(s.primary, 'audioChannels', [path], { output, left, right, swap }, s.status));
  requestAnimationFrame(() => {
    void tlA.wave(path, { channel: 0, gain: () => (swap && !mono ? right : left) });
    void tlB.wave(path, { channel: mono ? 0 : 1, gain: () => (mono ? right : swap ? left : right) });
  });
}
