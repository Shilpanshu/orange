import { h, shell, section, segmented, slider, runAndClose, base, fmtTime } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { probe, loadMedia, Player, bindKeys, transport, Timeline, kbdHints, clamp, gbtn, isTyping } from './media';
import { audioStage } from './trim-audio';

interface Range {
  start: number;
  end: number;
}

export async function bleepAudio([path]: string[]) {
  const info = await probe(path);
  const D = info.duration;
  const s = shell({ title: 'Bleep audio', file: base(path), plainStage: true });
  s.primary.textContent = 'Save';

  const ranges: Range[] = [];
  let sel: Range | null = null;
  let mode: 'tone' | 'silence' = 'tone';
  let level = 0.3;
  let listen: 'bleeped' | 'original' = 'bleeped';

  // Drag on empty waveform to create a bleep; a plain click just seeks.
  const tl = new Timeline({
    duration: D,
    kind: 'wave',
    tall: true,
    onBackgroundDown: (e, t0) => {
      const el = tl.el;
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      let r: Range | null = null;
      const move = (ev: PointerEvent) => {
        if (!r && Math.abs(ev.clientX - x0) < 4) return;
        const t = tl.timeAt(ev.clientX);
        if (!r) {
          r = { start: t0, end: t0 };
          ranges.push(r);
          sel = r;
        }
        r.start = Math.min(t0, t);
        r.end = Math.max(t0, t);
        render();
      };
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', move);
        if (!r) player.seek(tl.timeAt(ev.clientX));
        else if (r.end - r.start < 0.05) r.end = Math.min(D, r.start + 0.3);
        render();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
      return true;
    },
  });
  const layer = h('div', { class: 'av-bleeps' });
  tl.layer.append(layer);
  const { view, dock, audio } = audioStage(s.stage, path, info, tl);
  const player = new Player(audio, D, 0);
  // Web Audio graph for the A/B preview (created on first play).
  let ctx: AudioContext | null = null;
  let main: GainNode | null = null;
  let tone: GainNode | null = null;
  void loadMedia(path, audio, view.querySelector('.av-wave-box') as HTMLElement);
  player.onTime((t) => {
    tl.setTime(t);
    monitor(t);
  });

  // --------------------------------------------------------- A/B preview
  function ensureGraph() {
    if (ctx) return;
    ctx = new AudioContext();
    const src = ctx.createMediaElementSource(audio);
    main = ctx.createGain();
    src.connect(main).connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.frequency.value = 1000;
    tone = ctx.createGain();
    tone.gain.value = 0;
    osc.connect(tone).connect(ctx.destination);
    osc.start();
  }
  audio.addEventListener('play', () => {
    ensureGraph();
    void ctx!.resume();
  });
  function monitor(t: number) {
    if (!ctx || !main || !tone) return;
    const inside = listen === 'bleeped' && player.playing && ranges.some((r) => t >= r.start && t <= r.end);
    const now = ctx.currentTime;
    main.gain.setTargetAtTime(inside ? 0 : 1, now, 0.004);
    tone.gain.setTargetAtTime(inside && mode === 'tone' ? level : 0, now, 0.004);
  }
  audio.addEventListener('pause', () => monitor(player.time));

  // ---------------------------------------------------------- rendering
  const list = h('div', { class: 'av-parts' });
  function add(t: number) {
    const r = { start: clamp(t, 0, D - 0.1), end: clamp(t + 0.6, 0.1, D) };
    ranges.push(r);
    sel = r;
    render();
  }
  function remove(r: Range) {
    ranges.splice(ranges.indexOf(r), 1);
    if (sel === r) sel = null;
    render();
  }
  function render() {
    ranges.sort((a, b) => a.start - b.start);
    layer.innerHTML = '';
    for (const r of ranges) {
      const el = h('div', { class: `av-bleep${r === sel ? ' sel' : ''}`, style: { left: tl.pct(r.start), width: `calc(${tl.pct(r.end)} - ${tl.pct(r.start)})` }, title: 'Drag to move · double-click to remove' });
      const l = h('div', { class: 'av-bar-edge l' });
      const rr = h('div', { class: 'av-bar-edge r' });
      el.append(l, rr);
      const place = () => {
        el.style.left = tl.pct(r.start);
        el.style.width = `calc(${tl.pct(r.end)} - ${tl.pct(r.start)})`;
        renderList();
      };
      let s0 = 0;
      el.addEventListener('pointerdown', () => {
        s0 = r.start;
        sel = r;
        layer.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
      }, true);
      tl.drag(l, (t) => ((r.start = clamp(t, 0, r.end - 0.05)), place()), render);
      tl.drag(rr, (t) => ((r.end = clamp(t, r.start + 0.05, D)), place()), render);
      tl.drag(el, (t, _e, t0) => {
        const len = r.end - r.start;
        r.start = clamp(s0 + t - t0, 0, D - len);
        r.end = r.start + len;
        place();
      }, render);
      el.addEventListener('dblclick', () => remove(r));
      layer.append(el);
    }
    renderList();
  }
  function renderList() {
    list.innerHTML = '';
    if (!ranges.length) list.append(h('p', { class: 'hint' }, 'Drag across the waveform to mark a part to bleep, or press B at the playhead.'));
    ranges.forEach((r, i) =>
      list.append(
        h(
          'div',
          { class: `av-part${r === sel ? ' on' : ''}`, onclick: () => ((sel = r), player.play(Math.max(0, r.start - 1), Math.min(D, r.end + 1)), render()), title: 'Play around this bleep' },
          h('span', { class: 'av-idx' }, String(i + 1)),
          h('span', { class: 'time' }, `${fmtTime(r.start)} – ${fmtTime(r.end)}`),
          gbtn('close', 'Remove', () => remove(r), 'av-mini'),
        ),
      ),
    );
    list.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => e.stopPropagation()));
    const total = ranges.reduce((a, r) => a + r.end - r.start, 0);
    s.status.textContent = ranges.length ? `${ranges.length} bleep${ranges.length > 1 ? 's' : ''} · ${total.toFixed(1)} s covered` : 'Nothing marked yet';
    s.primary.disabled = !ranges.length;
  }

  const lvl = slider({ label: 'Tone volume', min: 5, max: 100, value: level * 100, format: (v) => `${v}%`, onInput: (v) => (level = v / 100) });
  s.panel.append(
    section(
      'Bleeps',
      h('button', { class: 'btn av-add', onclick: () => add(player.time), html: `${icon('plus', 16)}<span>Bleep at playhead</span>` }),
      list,
    ),
    section(
      'Sound',
      segmented(
        [
          { value: 'tone', label: 'Tone (1 kHz)' },
          { value: 'silence', label: 'Silence' },
        ],
        mode,
        (v) => {
          mode = v as any;
          lvl.hidden = mode !== 'tone';
        },
      ),
      lvl,
    ),
    section('Keys', kbdHints([['Space', 'Play / pause'], ['B', 'Bleep at playhead'], ['Del', 'Remove selected bleep']])),
  );

  const ab = segmented(
    [
      { value: 'bleeped', label: 'Bleeped' },
      { value: 'original', label: 'Original' },
    ],
    listen,
    (v) => {
      listen = v as any;
      monitor(player.time);
    },
  );
  ab.classList.add('av-ab');
  ab.title = 'Compare while playing';
  dock.append(transport(player, { steps: false }));
  dock.querySelector('.av-transport')!.append(h('span', { class: 'muted' }, 'Hear'), ab);
  bindKeys(player, { b: () => add(player.time) });
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !isTyping(e)) remove(sel);
  });
  render();

  s.primary.addEventListener('click', () => runAndClose(s.primary, 'bleepAudio', [path], { ranges, mode, level, freq: 1000 }, s.status));
  requestAnimationFrame(() => void tl.wave(path));
}
