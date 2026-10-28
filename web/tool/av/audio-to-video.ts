import { api, h, shell, section, field, segmented, runAndClose, base, fileUrl } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { probe, loadMedia, Player, bindKeys, transport, Timeline, timelineBlock, fitFrame } from './media';

type Style = 'wave' | 'bars' | 'image';
const SIZES = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] } as const;
type Size = keyof typeof SIZES;
const BG = { dark: '#1a1816', light: '#f6f3ef' };

export async function audioToVideo([path]: string[]) {
  const info = await probe(path);
  const D = info.duration;
  const s = shell({ title: 'Audio to video', file: base(path), plainStage: true });
  s.primary.textContent = 'Make video';
  s.stage.classList.add('av-stage');

  let style: Style = 'wave';
  let theme: 'dark' | 'light' = 'dark';
  let size: Size = 'landscape';
  let color = '#ee6a1f';
  let image = '';

  const view = h('div', { class: 'av-view' });
  const dock = h('div', { class: 'av-dock' });
  const audio = h('audio', { preload: 'auto' }) as HTMLAudioElement;
  s.stage.append(view, dock, audio);
  const frame = fitFrame(view, 1920, 1080, 20);
  frame.classList.add('av-canvas-frame');
  const canvas = h('canvas', { class: 'av-viz' });
  const img = h('img', { class: 'av-viz-img', alt: '' }) as HTMLImageElement;
  const pick = h('div', { class: 'av-viz-empty' }, h('span', { html: icon('image', 28) }), h('span', {}, 'Choose an image for the video'));
  frame.append(canvas, img, pick);
  const player = new Player(audio, D, 0);
  void loadMedia(path, audio, frame);

  // Live preview: the analyser drives the same look the export will have.
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  audio.addEventListener('play', () => {
    if (!ctx) {
      ctx = new AudioContext();
      const src = ctx.createMediaElementSource(audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      analyser.connect(ctx.destination);
    }
    void ctx.resume();
  });
  const td = new Float32Array(2048);
  const fd = new Uint8Array(1024);
  let peak = 0.05;

  function draw() {
    requestAnimationFrame(draw);
    if (style === 'image') return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(frame.clientWidth * dpr);
    const H = Math.round(frame.clientHeight * dpr);
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const g = canvas.getContext('2d')!;
    g.fillStyle = BG[theme];
    g.fillRect(0, 0, W, H);
    g.fillStyle = color;
    g.strokeStyle = color;
    const live = !!analyser && player.playing;
    const bw = W * 0.86;
    const x0 = (W - bw) / 2;
    if (style === 'wave') {
      const bandH = H * 0.42;
      const mid = H / 2;
      if (live) analyser!.getFloatTimeDomainData(td);
      else td.fill(0);
      let m = 0;
      for (const v of td) m = Math.max(m, Math.abs(v));
      peak = Math.max(peak * 0.995, m, 0.02);
      g.beginPath();
      // Centre-line fill like ffmpeg's "cline" mode: mirror |sample| around the middle.
      const n = 512;
      for (let i = 0; i <= n; i++) {
        const v = Math.min(1, Math.sqrt(Math.abs(td[Math.floor((i / n) * (td.length - 1))]) / peak));
        const x = x0 + (i / n) * bw;
        g.lineTo(x, mid - (v * bandH) / 2 - dpr);
      }
      for (let i = n; i >= 0; i--) {
        const v = Math.min(1, Math.sqrt(Math.abs(td[Math.floor((i / n) * (td.length - 1))]) / peak));
        g.lineTo(x0 + (i / n) * bw, mid + (v * bandH) / 2 + dpr);
      }
      g.closePath();
      g.fill();
    } else {
      const bandH = H * 0.5;
      const base_ = H / 2 + bandH / 2;
      if (live) analyser!.getByteFrequencyData(fd);
      else fd.fill(0);
      const bars = 96;
      const gap = Math.max(1, (bw / bars) * 0.28);
      const w = bw / bars - gap;
      for (let i = 0; i < bars; i++) {
        // Log-spaced bins, like the export's log frequency scale.
        const a = Math.floor(Math.pow(fd.length, i / bars));
        const b = Math.max(a + 1, Math.floor(Math.pow(fd.length, (i + 1) / bars)));
        let m = 0;
        for (let k = a; k < b && k < fd.length; k++) m = Math.max(m, fd[k]);
        const hgt = Math.max(dpr * 2, (m / 255) * bandH);
        g.fillRect(x0 + i * (w + gap), base_ - hgt, w, hgt);
      }
    }
    if (!live) {
      g.fillStyle = theme === 'dark' ? 'rgba(243,238,232,.55)' : 'rgba(31,27,22,.5)';
      g.font = `${Math.round(13 * dpr)}px 'Segoe UI Variable Text', 'Segoe UI', sans-serif`;
      g.textAlign = 'center';
      g.fillText('Press play to preview the animation', W / 2, H - 22 * dpr);
    }
  }
  requestAnimationFrame(draw);

  function render() {
    const [w, hh] = SIZES[size];
    frame.setAspect(w, hh);
    frame.style.background = BG[theme];
    canvas.hidden = style === 'image';
    img.hidden = style !== 'image' || !image;
    pick.hidden = style !== 'image' || !!image;
    imageField.hidden = style !== 'image';
    colorField.hidden = style === 'image';
    imgName.textContent = image ? base(image) : 'No image chosen';
    s.primary.disabled = style === 'image' && !image;
    s.status.textContent = `${w}×${hh} MP4 · ${style === 'image' ? 'still image' : style === 'wave' ? 'waveform' : 'frequency bars'}`;
  }

  async function chooseImage() {
    const files = await api().invoke<string[]>('dialog:files', [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff'] }], false);
    if (files?.[0]) {
      image = files[0];
      img.src = fileUrl(image);
      render();
    }
  }
  pick.addEventListener('click', chooseImage);
  const imgName = h('div', { class: 'av-filename' });
  const imageField = field('Image', h('div', {}, h('button', { class: 'btn small', onclick: chooseImage }, 'Choose image…'), imgName));
  const colorIn = h('input', { type: 'color', value: color }) as HTMLInputElement;
  colorIn.addEventListener('input', () => (color = colorIn.value));
  const colorField = field('Colour', h('div', { class: 'row' }, colorIn, h('button', { class: 'btn small fixed', onclick: () => ((color = colorIn.value = '#ee6a1f'), void 0) }, 'Orange')));

  s.panel.append(
    section(
      'Picture',
      segmented(
        [
          { value: 'wave', label: 'Waveform' },
          { value: 'bars', label: 'Bars' },
          { value: 'image', label: 'Image' },
        ],
        style,
        (v) => ((style = v as Style), render()),
      ),
      imageField,
      colorField,
    ),
    section(
      'Background',
      segmented(
        [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ],
        theme,
        (v) => ((theme = v as any), render()),
      ),
    ),
    section(
      'Shape',
      segmented(
        [
          { value: 'landscape', label: '16:9' },
          { value: 'portrait', label: '9:16' },
          { value: 'square', label: '1:1' },
        ],
        size,
        (v) => ((size = v as Size), render()),
      ),
      h('p', { class: 'hint' }, '16:9 for YouTube, 9:16 for Shorts, Reels and TikTok, 1:1 for feeds.'),
    ),
  );

  const tl = new Timeline({ duration: D, kind: 'wave' });
  tl.onSeek((t) => player.seek(t));
  player.onTime((t) => tl.setTime(t));
  dock.append(transport(player, { steps: false }), timelineBlock(tl));
  bindKeys(player);
  render();

  s.primary.addEventListener('click', () => runAndClose(s.primary, 'audioToVideo', [path], { style, theme, size, color, image }, s.status));
  requestAnimationFrame(() => void tl.wave(path));
}
