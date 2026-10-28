import { api, h, shell, section, runAndClose, base, fmtTime } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { probe, loadMedia, Player, bindKeys, transport, videoStage, Timeline, timelineBlock, kbdHints, describeVideo, gbtn } from './media';

interface Grab {
  n: number;
  thumb: string;
}

export async function videoFrames([path]: string[]) {
  const info = await probe(path);
  const fps = info.fps || 30;
  const s = shell({ title: 'Save frames', file: base(path), plainStage: true });
  const { dock, frame, video } = videoStage(s.stage, info);
  const player = new Player(video, info.duration, fps);
  void loadMedia(path, video, frame);

  const grabs: Grab[] = [];
  const list = h('div', { class: 'av-frames' });
  const empty = h('p', { class: 'hint av-empty' }, 'Step to the exact frame you want, then add it. You can add as many as you like.');
  const marks = h('div', { class: 'av-marks' });

  const tl = new Timeline({ duration: info.duration, kind: 'thumbs' });
  tl.layer.append(marks);
  tl.onSeek((t) => {
    player.pause();
    player.seekFrame(Math.floor(t * fps));
  });
  player.onTime((t) => tl.setTime(t));

  /** Small snapshot of what the video element shows right now (preview resolution). */
  function snapshot(): string {
    try {
      const c = document.createElement('canvas');
      const hgt = 90;
      c.height = hgt;
      c.width = Math.round((hgt * (info.width || 16)) / (info.height || 9));
      c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.8);
    } catch {
      return '';
    }
  }

  function add() {
    player.pause();
    const n = player.frameAt();
    if (grabs.some((g) => g.n === n)) return flash(n);
    const g: Grab = { n, thumb: snapshot() };
    grabs.push(g);
    grabs.sort((a, b) => a.n - b.n);
    render();
    flash(n);
    if (!g.thumb) {
      // Canvas snapshots can be blocked for local files; ask ffmpeg for that exact frame instead.
      api()
        .invoke<string>('av:thumb', path, Math.max(0, (n - 0.5) / fps), 90)
        .then((u) => {
          g.thumb = u;
          render();
        })
        .catch(() => {});
    }
  }
  function flash(n: number) {
    list.querySelector(`[data-n="${n}"]`)?.scrollIntoView({ block: 'nearest' });
    list.querySelector(`[data-n="${n}"]`)?.classList.add('flash');
    setTimeout(() => list.querySelector(`[data-n="${n}"]`)?.classList.remove('flash'), 500);
  }

  function render() {
    list.innerHTML = '';
    marks.innerHTML = '';
    empty.hidden = grabs.length > 0;
    for (const g of grabs) {
      const t = g.n / fps;
      marks.append(h('i', { style: { left: tl.pct(t + 0.5 / fps) } }));
      list.append(
        h(
          'div',
          { class: 'av-frame-item', 'data-n': String(g.n), onclick: () => player.seekFrame(g.n), title: 'Show this frame' },
          g.thumb ? h('img', { src: g.thumb, alt: '' }) : h('div', { class: 'av-noimg' }),
          h('div', { class: 'av-frame-meta' }, h('strong', {}, `Frame ${g.n + 1}`), h('span', { class: 'time' }, fmtTime(t))),
          gbtn('close', 'Remove', () => {
            grabs.splice(grabs.indexOf(g), 1);
            render();
          }),
        ),
      );
    }
    list.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => e.stopPropagation()));
    const n = grabs.length;
    s.primary.textContent = n > 1 ? `Save ${n} PNGs` : 'Save PNG';
    s.primary.disabled = n === 0;
    s.status.textContent = n ? `${n} frame${n > 1 ? 's' : ''} · full size ${info.width}×${info.height} PNG` : 'No frames added yet';
  }

  const addBtn = h('button', { class: 'btn primary av-add', onclick: add, html: `${icon('plus', 16)}<span>Add this frame</span>` });
  s.panel.append(
    section('Frames', addBtn, empty, list),
    section('Keys', kbdHints([['← →', 'Previous / next frame'], ['Shift', 'With arrows: 1 second'], ['Enter', 'Add the current frame']])),
  );
  s.panel.classList.add('av-panel-col');

  dock.append(transport(player, { frames: true }), timelineBlock(tl));
  dock.querySelector('.av-transport')!.append(h('span', { class: 'muted' }, describeVideo(info)));
  bindKeys(player, { Enter: add, f: add });
  render();

  // Show the first frame exactly.
  video.addEventListener('loadeddata', () => player.seekFrame(0), { once: true });
  s.primary.addEventListener('click', () => runAndClose(s.primary, 'videoFrames', [path], { times: grabs.map((g) => g.n / fps) }, s.status));
  requestAnimationFrame(() => void tl.thumbs(path, (info.width || 16) / (info.height || 9)));
}
