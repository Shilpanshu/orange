import { api, h, shell, section, slider, runAndClose, base } from '../../shared/ui';

interface Loudness {
  I: number;
  TP: number;
  LRA: number;
}
interface Target {
  I: number;
  TP: number;
  LRA: number;
}

const PRESETS: { id: string; label: string; sub: string; t: Target }[] = [
  { id: 'podcast', label: 'Podcast', sub: '−16 LUFS', t: { I: -16, TP: -1.5, LRA: 11 } },
  { id: 'streaming', label: 'Streaming', sub: '−14 LUFS', t: { I: -14, TP: -1, LRA: 11 } },
  { id: 'broadcast', label: 'Broadcast', sub: '−23 LUFS', t: { I: -23, TP: -1, LRA: 15 } },
  { id: 'custom', label: 'Custom', sub: 'Your values', t: { I: -18, TP: -1, LRA: 11 } },
];

// Meter scale in LUFS.
const LO = -50;
const HI = 0;
const pos = (v: number) => `${((Math.min(HI, Math.max(LO, v)) - LO) / (HI - LO)) * 100}%`;
const sign = (v: number) => (v >= 0 ? `+${v.toFixed(1)}` : `−${Math.abs(v).toFixed(1)}`);
const lufs = (v: number) => (v <= -69 ? 'silent' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);

export async function normalizeAudio(paths: string[]) {
  const s = shell({ title: 'Normalize loudness', file: paths.length === 1 ? base(paths[0]) : `${paths.length} files`, plainStage: true });
  s.primary.textContent = 'Normalize';
  s.stage.classList.add('av-norm-stage');

  let preset = PRESETS[0];
  let target: Target = { ...preset.t };
  const measured = new Map<string, Loudness | Error>();

  const rows = h('div', { class: 'av-norm-list' });
  const scale = h('div', { class: 'av-norm-scale' }, ...[-50, -40, -30, -20, -10, 0].map((v) => h('span', { style: { left: pos(v) } }, v === 0 ? '0' : `−${-v}`)));
  s.stage.append(h('div', { class: 'av-norm-wrap' }, h('div', { class: 'av-norm-title' }, h('strong', {}, 'Measured loudness'), h('span', { class: 'muted' }, 'LUFS, EBU R128')), rows, scale));

  function render() {
    rows.innerHTML = '';
    let pending = 0;
    for (const p of paths) {
      const m = measured.get(p);
      const meter = h('div', { class: 'av-meter' });
      meter.append(h('div', { class: 'av-meter-target', style: { left: pos(target.I) }, title: `Target ${lufs(target.I)} LUFS` }));
      const line = h('div', { class: 'av-norm-line' });
      const notes = h('div', { class: 'av-norm-notes' });
      if (!m) {
        pending++;
        meter.classList.add('skeleton');
        line.append(h('span', { class: 'muted' }, 'Measuring…'));
      } else if (m instanceof Error) {
        line.append(h('span', { class: 'av-bad' }, m.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
      } else {
        const gain = target.I - m.I;
        const a = Math.min(m.I, target.I);
        const b = Math.max(m.I, target.I);
        meter.append(
          h('div', { class: `av-meter-move ${gain >= 0 ? 'up' : 'down'}`, style: { left: pos(a), width: `calc(${pos(b)} - ${pos(a)})` } }),
          h('div', { class: 'av-meter-now', style: { left: pos(m.I) }, title: `Now ${lufs(m.I)} LUFS` }),
        );
        line.append(
          h('span', { class: 'time' }, `${lufs(m.I)} → ${lufs(target.I)} LUFS`),
          h('strong', { class: `time ${Math.abs(gain) < 0.5 ? '' : gain > 0 ? 'av-up' : 'av-down'}` }, `${sign(gain)} dB`),
        );
        notes.append(h('span', {}, `Peak ${m.TP.toFixed(1)} dBTP`), h('span', {}, `Range ${m.LRA.toFixed(1)} LU`));
        if (m.I <= -69) notes.append(h('span', { class: 'av-warn' }, 'Silent: nothing to normalize'));
        else if (gain > 15) notes.append(h('span', { class: 'av-warn' }, 'Very quiet: background noise will rise too'));
        else if (m.TP + gain > target.TP) notes.append(h('span', { class: 'av-note' }, 'Peaks will be gently limited'));
        else if (Math.abs(gain) < 0.5) notes.append(h('span', { class: 'av-note' }, 'Already on target'));
      }
      rows.append(h('div', { class: 'av-norm-row' }, h('div', { class: 'av-norm-name' }, base(p)), meter, line, notes));
    }
    s.status.textContent = pending ? `Measuring ${paths.length - pending + 1} of ${paths.length}…` : `Target ${lufs(target.I)} LUFS · peak ${target.TP} dBTP`;
  }

  // Measure sequentially so one long file doesn't starve the others.
  async function measureAll() {
    for (const p of paths) {
      if (measured.has(p)) continue;
      try {
        measured.set(p, await api().invoke<Loudness>('av:loudness', p, target));
      } catch (e: any) {
        measured.set(p, new Error(String(e?.message ?? e)));
      }
      render();
    }
  }

  const presetBox = h('div', { class: 'av-presets' });
  const custom = h('div', {});
  const iS = slider({ label: 'Loudness', min: -35, max: -8, step: 0.5, value: target.I, format: (v) => `${v} LUFS`, onInput: (v) => ((target.I = v), render()) });
  const tpS = slider({ label: 'True peak ceiling', min: -6, max: -0.1, step: 0.1, value: target.TP, format: (v) => `${v} dBTP`, onInput: (v) => ((target.TP = v), render()) });
  const lraS = slider({ label: 'Loudness range', min: 3, max: 20, step: 1, value: target.LRA, format: (v) => `${v} LU`, onInput: (v) => ((target.LRA = v), render()) });
  custom.append(iS, tpS, lraS);
  function pick(p: (typeof PRESETS)[number]) {
    preset = p;
    if (p.id !== 'custom') target = { ...p.t };
    iS.set(target.I);
    tpS.set(target.TP);
    lraS.set(target.LRA);
    custom.hidden = p.id !== 'custom';
    presetBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === p.id));
    render();
  }
  for (const p of PRESETS) presetBox.append(h('button', { class: 'av-preset', 'data-id': p.id, onclick: () => pick(p) }, h('strong', {}, p.label), h('span', {}, p.sub)));

  s.panel.append(
    section('Target', presetBox, custom),
    section(null, h('p', { class: 'hint' }, 'Two-pass EBU R128 normalization: the whole file is measured first, then adjusted evenly so it sounds as loud as the target without clipping. Video is copied untouched.')),
  );
  pick(preset);
  void measureAll();

  s.primary.addEventListener('click', () => runAndClose(s.primary, 'normalizeAudio', paths, { ...target }, s.status));
}
