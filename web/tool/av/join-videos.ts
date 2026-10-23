import { api, h, shell, section, runAndClose, base, extOf, sortable, fmtTime } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { probe, loadMedia, gbtn, stat, fmtDur, fitFrame, type MediaInfo } from './media';

interface Clip {
  path: string;
  info: MediaInfo;
  thumb: string;
}

/** Same rule the main process uses for its lossless fast path. */
function canCopy(clips: Clip[]) {
  const f = clips[0].info;
  return clips.every(
    ({ path, info: x }) =>
      ['mp4', 'm4v', 'mov'].includes(extOf(path)) &&
      ['h264', 'hevc'].includes(x.vcodec) &&
      x.vcodec === f.vcodec &&
      x.width === f.width &&
      x.height === f.height &&
      Math.abs(x.fps - f.fps) < 0.01 &&
      x.hasAudio === f.hasAudio &&
      (!x.hasAudio || (x.acodec === 'aac' && x.sampleRate === f.sampleRate && x.channels === f.channels)),
  );
}

export async function joinVideos(paths: string[]) {
  const s = shell({ title: 'Join videos', file: `${paths.length} clips`, plainStage: true, wide: true });
  s.primary.textContent = 'Join';
  s.stage.classList.add('av-liststage');
  const list = h('div', { class: 'list av-cliplist' });
  const lead = h('p', { class: 'av-lead' }, 'Drag to set the order. The first clip sets the frame size; others are fitted inside it.');
  s.stage.append(h('div', { class: 'av-listwrap' }, lead, list));
  // Skeleton rows while probing.
  for (let i = 0; i < paths.length; i++) list.append(h('div', { class: 'item av-clip' }, h('div', { class: 'skeleton av-clip-thumb' }), h('div', { class: 'skeleton av-skel-line' })));

  const infos = await Promise.all(paths.map((p) => probe(p)));
  let clips: Clip[] = paths.map((p, i) => ({ path: p, info: infos[i], thumb: '' }));
  let selected = 0;

  // Preview of the selected clip lives in the panel.
  const view = h('div', { class: 'av-mini-view' });
  const pframe = fitFrame(view, 16, 9, 0);
  const video = h('video', { class: 'av-video', controls: true, disablePictureInPicture: true }) as HTMLVideoElement;
  pframe.append(video);
  const previewName = h('div', { class: 'av-mini-name' });
  const summary = h('div', {});

  async function preview(i: number) {
    selected = i;
    const c = clips[i];
    previewName.textContent = base(c.path);
    pframe.setAspect(c.info.width || 16, c.info.height || 9);
    video.pause();
    pframe.querySelector('.av-loading')?.remove();
    await loadMedia(c.path, video, pframe);
    render();
  }

  function render() {
    list.innerHTML = '';
    clips.forEach((c, i) => {
      const img = c.thumb ? h('img', { class: 'av-clip-thumb', src: c.thumb, alt: '' }) : h('div', { class: 'av-clip-thumb skeleton' });
      const meta = [fmtDur(c.info.duration), `${c.info.width}×${c.info.height}`, `${Math.round(c.info.fps * 100) / 100} fps`];
      if (!c.info.hasAudio) meta.push('no audio');
      const row = h(
        'div',
        { class: `item av-clip${i === selected ? ' sel' : ''}`, draggable: true, onclick: () => void preview(i) },
        h('span', { class: 'grip', html: icon('grip', 16) }),
        h('span', { class: 'av-idx' }, String(i + 1)),
        img,
        h('div', { class: 'av-clip-text' }, h('div', { class: 'name' }, base(c.path)), h('div', { class: 'muted' }, meta.join(' · '))),
        i === 0 ? h('span', { class: 'av-badge' }, 'Frame size') : null,
        h(
          'div',
          { class: 'av-row-actions' },
          gbtn('up', 'Move up', () => move(i, i - 1), i === 0 ? 'hide' : ''),
          gbtn('down', 'Move down', () => move(i, i + 1), i === clips.length - 1 ? 'hide' : ''),
          clips.length > 2 ? gbtn('close', 'Remove from the list', () => remove(i)) : null,
        ),
      );
      row.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => e.stopPropagation()));
      list.append(row);
    });
    const first = clips[0].info;
    const total = clips.reduce((a, c) => a + c.info.duration, 0);
    const copy = canCopy(clips);
    summary.innerHTML = '';
    summary.append(
      stat('Total length', fmtTime(total)),
      stat('Frame size', `${first.width}×${first.height}`),
      stat('Frame rate', `${Math.round(Math.min(60, first.fps) * 100) / 100} fps`),
      stat('Format', 'MP4'),
      h('p', { class: 'hint' }, copy ? 'These clips match, so they are joined without re-encoding: fast and lossless.' : 'The clips differ, so they are re-encoded to H.264. Clips without sound get silence.'),
    );
    s.status.textContent = `${clips.length} clips · ${fmtTime(total)}`;
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= clips.length) return;
    const sel = clips[selected];
    const [c] = clips.splice(from, 1);
    clips.splice(to, 0, c);
    selected = clips.indexOf(sel);
    render();
  }
  function remove(i: number) {
    clips.splice(i, 1);
    selected = Math.min(selected, clips.length - 1);
    render();
  }
  sortable(list, move);

  s.panel.append(section('Preview', view, previewName), section('Result', summary));
  render();
  void preview(0);

  // Thumbnails arrive one by one.
  for (const c of clips) {
    api()
      .invoke<string>('av:thumb', c.path, Math.min(1, c.info.duration / 2), 96)
      .then((u) => {
        c.thumb = u;
        render();
      })
      .catch(() => {});
  }

  s.primary.addEventListener('click', () => runAndClose(s.primary, 'joinVideos', clips.map((c) => c.path), {}, s.status));
}
