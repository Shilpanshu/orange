import { h, shell, section, segmented, slider, runAndClose, base, extOf, sortable, fmtTime } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { probe, waveform, loadMedia, gbtn, glyph, stat, fmtDur, type MediaInfo } from './media';

interface Item {
  path: string;
  info: MediaInfo;
  peaks: number[];
}

const SAME_OK = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'wma', 'alac'];

export async function joinAudio(paths: string[]) {
  const s = shell({ title: 'Join audio', file: `${paths.length} files`, plainStage: true });
  s.primary.textContent = 'Join';
  s.stage.classList.add('av-liststage');
  const list = h('div', { class: 'list av-cliplist' });
  s.stage.append(h('div', { class: 'av-listwrap' }, h('p', { class: 'av-lead' }, 'Drag to set the order. Click a row to listen.'), list));
  for (let i = 0; i < paths.length; i++) list.append(h('div', { class: 'item av-clip' }, h('div', { class: 'skeleton av-skel-line' })));

  const infos = await Promise.all(paths.map((p) => probe(p)));
  let items: Item[] = paths.map((p, i) => ({ path: p, info: infos[i], peaks: [] }));
  let format = 'same';
  let crossfade = 0;
  let playing: Item | null = null;

  const audio = h('audio', { preload: 'auto' }) as HTMLAudioElement;
  s.stage.append(audio);
  audio.addEventListener('ended', () => ((playing = null), render()));
  audio.addEventListener('pause', () => render());
  audio.addEventListener('play', () => render());
  async function listen(it: Item) {
    if (playing === it && !audio.paused) return audio.pause();
    if (playing !== it) {
      playing = it;
      const holder = h('div', { hidden: true });
      document.body.append(holder);
      await loadMedia(it.path, audio, holder);
      holder.remove();
    }
    void audio.play();
  }

  function waveCanvas(it: Item) {
    const c = h('canvas', { class: 'av-clip-wave', width: 240, height: 48 });
    const g = c.getContext('2d')!;
    const peaks = it.peaks;
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = playing === it ? css.getPropertyValue('--accent') : css.getPropertyValue('--ink-3');
    const max = Math.max(1e-4, ...peaks);
    peaks.forEach((v, i) => {
      const hh = Math.max(1, (v / max) * 22);
      g.fillRect(i * 2, 24 - hh, 1.4, hh * 2);
    });
    return c;
  }

  function render() {
    list.innerHTML = '';
    items.forEach((it, i) => {
      const meta = [fmtDur(it.info.duration), it.info.acodec.toUpperCase().replace(/^PCM_.*/, 'PCM'), it.info.sampleRate ? `${(it.info.sampleRate / 1000).toFixed(1)} kHz` : '', it.info.channels === 1 ? 'mono' : 'stereo'];
      const isPlaying = playing === it && !audio.paused;
      const row = h(
        'div',
        { class: `item av-clip${playing === it ? ' sel' : ''}`, draggable: true },
        h('span', { class: 'grip', html: icon('grip', 16) }),
        h('span', { class: 'av-idx' }, String(i + 1)),
        h('button', { class: 'btn icon av-rowplay', title: isPlaying ? 'Pause' : 'Listen', html: glyph(isPlaying ? 'pause' : 'play', 14), onclick: () => void listen(it) }),
        it.peaks.length ? waveCanvas(it) : h('div', { class: 'av-clip-wave skeleton' }),
        h('div', { class: 'av-clip-text' }, h('div', { class: 'name' }, base(it.path)), h('div', { class: 'muted' }, meta.filter(Boolean).join(' · '))),
        h(
          'div',
          { class: 'av-row-actions' },
          gbtn('up', 'Move up', () => move(i, i - 1), i === 0 ? 'hide' : ''),
          gbtn('down', 'Move down', () => move(i, i + 1), i === items.length - 1 ? 'hide' : ''),
          items.length > 2 ? gbtn('close', 'Remove from the list', () => remove(i)) : null,
        ),
      );
      list.append(row);
    });
    renderSummary();
  }

  const summary = h('div', {});
  function outExt() {
    if (format !== 'same') return format;
    const e = extOf(items[0].path);
    return SAME_OK.includes(e) ? (e === 'alac' ? 'm4a' : e) : 'm4a';
  }
  function renderSummary() {
    const minDur = Math.min(...items.map((x) => x.info.duration));
    const xf = Math.max(0, Math.min(crossfade, minDur / 2 - 0.05));
    const total = items.reduce((a, x) => a + x.info.duration, 0) - xf * (items.length - 1);
    const stereo = items.some((x) => x.info.channels >= 2);
    summary.innerHTML = '';
    summary.append(
      stat('Total length', fmtTime(total)),
      stat('Format', outExt().toUpperCase()),
      stat('Sample rate', `${((outExt() === 'opus' ? 48000 : items[0].info.sampleRate || 44100) / 1000).toFixed(1)} kHz`),
      stat('Channels', stereo ? 'Stereo' : 'Mono'),
    );
    if (crossfade > 0 && xf < crossfade) summary.append(h('p', { class: 'hint' }, `Crossfade shortened to ${xf.toFixed(1)} s to fit the shortest file.`));
    s.status.textContent = `${items.length} files · ${fmtTime(total)}`;
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= items.length) return;
    const [x] = items.splice(from, 1);
    items.splice(to, 0, x);
    render();
  }
  function remove(i: number) {
    const [x] = items.splice(i, 1);
    if (x === playing) {
      audio.pause();
      playing = null;
    }
    render();
  }
  sortable(list, move);

  const firstExt = extOf(items[0].path).toUpperCase();
  s.panel.append(
    section(
      'Format',
      segmented(
        [
          { value: 'same', label: `Same (${firstExt})` },
          { value: 'mp3', label: 'MP3' },
          { value: 'm4a', label: 'M4A' },
          { value: 'wav', label: 'WAV' },
        ],
        format,
        (v) => ((format = v), renderSummary()),
      ),
    ),
    section(
      'Transitions',
      slider({ label: 'Crossfade', min: 0, max: 5, step: 0.1, value: 0, format: (v) => (v ? `${v.toFixed(1)} s` : 'Off'), onInput: (v) => ((crossfade = v), renderSummary()) }),
      h('p', { class: 'hint' }, 'Blends the end of each file into the start of the next.'),
    ),
    section('Result', summary),
  );
  render();

  for (const it of items) {
    waveform(it.path, 120)
      .then((p) => {
        it.peaks = p;
        render();
      })
      .catch(() => {});
  }

  s.primary.addEventListener('click', () => {
    audio.pause();
    runAndClose(s.primary, 'joinAudio', items.map((x) => x.path), { format, crossfade }, s.status);
  });
}
