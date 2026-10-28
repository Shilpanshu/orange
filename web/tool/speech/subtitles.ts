// Subtitles: transcribe speech offline, review and edit the cues, then save as SRT/VTT/TXT,
// burn them into a copy of the video, or add them as a subtitle track.
// The speech model runs in the main process (ops/tools-speech.ts).
import { api, h, shell, section, segmented, slider, runAndClose, base, fmtTime, fmtBytes } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { probe, loadMedia, Player, bindKeys, transport, Timeline, videoStage, timelineBlock, timeField, gbtn, isTyping, fmtDur, type MediaInfo } from '../av/media';
import { audioStage } from '../av/trim-audio';
import { languageName, languageOptions } from './languages';

type ModelId = 'fast' | 'balanced' | 'best';
type Output = 'srt' | 'vtt' | 'txt' | 'burn' | 'track';

interface Opts {
  model: ModelId;
  language: string;
  task: 'transcribe' | 'translate';
  output: Output;
  maxChars: number;
  maxLines: number;
  style: 'outline' | 'box';
}

interface ModelInfo {
  id: ModelId;
  label: string;
  blurb: string;
  bytes: number;
  cached: boolean;
  rtf: number;
  measured: boolean;
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

interface Progress {
  phase: 'download' | 'load' | 'decode' | 'detect' | 'transcribe';
  done: number;
  total: number;
  eta?: number;
  cues?: Cue[];
  language?: string;
  note: string;
}

const DEFAULTS: Opts = { model: 'fast', language: 'auto', task: 'transcribe', output: 'srt', maxChars: 42, maxLines: 2, style: 'outline' };
const STORE = 'orange:subtitles';

function loadOpts(): Opts {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveOpts(o: Opts) {
  try {
    localStorage.setItem(STORE, JSON.stringify(o));
  } catch {
    /* remembering is a convenience */
  }
}

const OUTPUTS: { id: Output; label: string; hint: string; video?: boolean }[] = [
  { id: 'srt', label: 'SRT file', hint: 'Works with almost every player and editor' },
  { id: 'vtt', label: 'WebVTT file', hint: 'For web pages and HTML5 video' },
  { id: 'txt', label: 'Plain text', hint: 'The transcript in paragraphs, no times' },
  { id: 'burn', label: 'Burn into a copy', hint: 'Always visible. Re-encodes the video', video: true },
  { id: 'track', label: 'Add as a subtitle track', hint: 'Players can switch it on and off. No re-encoding', video: true },
];

const minutes = (s: number) => (s < 60 ? 'under a minute' : s < 3600 ? `about ${Math.round(s / 60)} min` : `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// ------------------------------------------------------------------ options

/** The option sections shared by the single-file and multi-file windows. */
function optionsPanel(o: Opts, models: ModelInfo[], ctx: { duration: number; estLabel: string; hasVideo: boolean; onChange: () => void }) {
  const change = () => {
    saveOpts(o);
    ctx.onChange();
  };

  // Model
  const modelRows = h('div', { class: 'sp-choices', role: 'radiogroup', 'aria-label': 'Model' });
  const renderModels = () => {
    modelRows.innerHTML = '';
    for (const m of models) {
      const est = ctx.duration ? m.rtf * ctx.duration : 0;
      const size = m.cached ? h('span', { class: 'sp-ok', html: `${icon('check', 13)}<span>Downloaded</span>` }) : h('span', {}, `${fmtBytes(m.bytes)} download`);
      modelRows.append(
        h(
          'button',
          {
            class: `sp-choice${o.model === m.id ? ' on' : ''}`,
            role: 'radio',
            'aria-checked': String(o.model === m.id),
            onclick: () => {
              o.model = m.id;
              renderModels();
              renderTaskHint();
              change();
            },
          },
          h('span', { class: 'sp-dot' }),
          h(
            'span',
            { class: 'sp-choice-body' },
            h('span', { class: 'sp-choice-head' }, h('strong', {}, m.label), h('span', { class: 'sp-meta' }, size)),
            h('span', { class: 'sp-sub' }, m.blurb),
            est
              ? h(
                  'span',
                  { class: 'sp-sub sp-est' },
                  cap(`${minutes(est)} ${ctx.estLabel}${m.measured ? '' : ' (estimate)'}${m.rtf > 1 ? (m.measured ? ' · slower than real time on this PC' : ' · slower than real time on most laptops') : ''}`),
                )
              : null,
          ),
        ),
      );
    }
  };
  renderModels();

  // Language
  const lang = h('select', { 'aria-label': 'Language' }) as HTMLSelectElement;
  const { common, rest } = languageOptions();
  lang.append(h('option', { value: 'auto' }, 'Detect automatically'));
  const g1 = h('optgroup', { label: 'Common' });
  common.forEach((l) => g1.append(h('option', { value: l.code }, l.name)));
  const g2 = h('optgroup', { label: 'All languages' });
  rest.forEach((l) => g2.append(h('option', { value: l.code }, l.name)));
  lang.append(g1, g2);
  lang.value = o.language;
  if (lang.value !== o.language) lang.value = o.language = 'auto';
  lang.addEventListener('change', () => {
    o.language = lang.value;
    change();
  });

  // Task
  const taskHint = h('p', { class: 'hint' });
  const renderTaskHint = () => {
    taskHint.textContent =
      o.task === 'translate'
        ? o.model === 'best'
          ? 'Large v3 Turbo was not trained to translate and often keeps the original language. Balanced translates better.'
          : 'Speech in any language becomes English subtitles.'
        : 'Subtitles in the language that is spoken.';
  };
  renderTaskHint();
  const task = segmented(
    [
      { value: 'transcribe', label: 'Transcribe' },
      { value: 'translate', label: 'Translate to English' },
    ],
    o.task,
    (v) => {
      o.task = v as Opts['task'];
      renderTaskHint();
      change();
    },
  );

  // Output
  const outRows = h('div', { class: 'sp-choices compact', role: 'radiogroup', 'aria-label': 'Save as' });
  const style = segmented(
    [
      { value: 'outline', label: 'Outline' },
      { value: 'box', label: 'Box' },
    ],
    o.style,
    (v) => {
      o.style = v as Opts['style'];
      change();
    },
  );
  const styleField = h('div', { class: 'field sp-style' }, h('div', { class: 'label' }, h('span', {}, 'Burned-in style')), style);
  if (!ctx.hasVideo && OUTPUTS.find((x) => x.id === o.output)?.video) o.output = 'srt';
  const renderOutputs = () => {
    outRows.innerHTML = '';
    for (const x of OUTPUTS) {
      const off = !!x.video && !ctx.hasVideo;
      outRows.append(
        h(
          'button',
          {
            class: `sp-choice${o.output === x.id ? ' on' : ''}`,
            role: 'radio',
            'aria-checked': String(o.output === x.id),
            disabled: off,
            title: off ? 'Needs a video file' : undefined,
            onclick: () => {
              o.output = x.id;
              renderOutputs();
              change();
            },
          },
          h('span', { class: 'sp-dot' }),
          h('span', { class: 'sp-choice-body' }, h('strong', {}, x.label), h('span', { class: 'sp-sub' }, off ? 'Video files only' : x.hint)),
        ),
      );
    }
    styleField.hidden = o.output !== 'burn';
  };
  renderOutputs();

  // Lines
  const chars = slider({ label: 'Characters per line', min: 24, max: 60, value: o.maxChars, onInput: (v) => ((o.maxChars = v), change()) });
  const lines = segmented(
    [
      { value: '1', label: '1 line' },
      { value: '2', label: '2 lines' },
      { value: '3', label: '3 lines' },
    ],
    String(o.maxLines),
    (v) => {
      o.maxLines = Number(v);
      change();
    },
  );

  const sections = {
    model: section('Model', modelRows),
    language: section('Speech', h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Language')), lang), h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Task')), task), taskHint),
    output: section('Save as', outRows, styleField),
    lines: section('Cues', chars, h('div', { class: 'field' }, h('div', { class: 'label' }, h('span', {}, 'Lines per cue')), lines), h('p', { class: 'hint' }, 'Cues split at sentence ends and pauses, and stay on screen long enough to read.')),
  };
  return {
    sections,
    setModels(next: ModelInfo[]) {
      models = next;
      renderModels();
    },
    outputs: outRows,
    styleField,
    renderOutputs,
  };
}

// --------------------------------------------------------------- multi-file

async function multi(paths: string[], o: Opts, models: ModelInfo[]) {
  const s = shell({ title: 'Subtitles', file: `${paths.length} files`, wide: true, plainStage: true });
  s.primary.textContent = 'Make subtitles';
  const infos = await Promise.all(paths.map((p) => probe(p).catch(() => null)));
  const total = infos.reduce((a, i) => a + (i?.duration ?? 0), 0);
  const anyVideo = infos.some((i) => i?.hasVideo);

  const list = h('div', { class: 'sp-files' });
  paths.forEach((p, i) => {
    const info = infos[i];
    list.append(
      h(
        'div',
        { class: 'sp-file' },
        h('span', { class: 'sp-file-icon', html: icon(info?.hasVideo ? 'frames' : 'wave', 18) }),
        h('span', { class: 'name' }, base(p)),
        h('span', { class: 'time muted' }, info ? fmtTime(info.duration, false) : 'Unreadable'),
      ),
    );
  });
  s.stage.classList.add('sp-multi');
  s.stage.append(
    h(
      'div',
      { class: 'sp-files-wrap' },
      h('div', { class: 'sp-files-head' }, h('strong', {}, `${paths.length} files · ${fmtDur(total)} of audio`), h('span', { class: 'muted' }, 'Transcribed one after another. Each result is saved next to its file.')),
      list,
    ),
  );

  const status = () => {
    const m = models.find((x) => x.id === o.model);
    s.status.textContent = m ? `${cap(minutes(m.rtf * total))} in total${m.cached ? '' : ` plus a ${fmtBytes(m.bytes)} download`}` : '';
  };
  const panel = optionsPanel(o, models, { duration: total, estLabel: 'for all files', hasVideo: anyVideo, onChange: status });
  const sec = panel.sections;
  s.panel.append(sec.model, sec.language, sec.output, sec.lines);
  if (anyVideo && infos.some((i) => i && !i.hasVideo)) sec.output.append(h('p', { class: 'hint' }, 'Audio files get an SRT file when burning in or adding a track.'));
  status();
  s.primary.addEventListener('click', () => runAndClose(s.primary, 'subtitles', paths, { ...o }, s.status));
}

// -------------------------------------------------------------- single file

async function single(path: string, o: Opts, models: ModelInfo[]) {
  const info: MediaInfo = await probe(path);
  const D = info.duration;
  const s = shell({ title: 'Subtitles', file: base(path), wide: true, plainStage: !info.hasVideo });
  s.primary.textContent = 'Transcribe';
  if (!info.hasAudio) {
    s.panel.append(section(null, h('p', { class: 'hint' }, 'This file has no audio track, so there is nothing to transcribe.')));
    s.primary.disabled = true;
  }

  let cues: Cue[] = [];
  let language: string | null = null;
  let edited = false;
  let phase: 'setup' | 'working' | 'review' = 'setup';
  let current = -1;

  // ------------------------------------------------------------ stage
  const tl = new Timeline({ duration: D || 1, kind: info.hasVideo ? 'thumbs' : 'wave', tall: !info.hasVideo });
  const marks = h('div', { class: 'sp-marks' });
  tl.layer.append(marks);
  const caption = h('div', { class: 'sp-caption', hidden: true });
  let media: HTMLMediaElement;
  let dock: HTMLElement;
  if (info.hasVideo) {
    const st = videoStage(s.stage, info);
    media = st.video;
    dock = st.dock;
    st.frame.append(caption);
    void loadMedia(path, media, st.frame);
  } else {
    const st = audioStage(s.stage, path, info, tl);
    media = st.audio;
    dock = st.dock;
    const box = st.view.querySelector('.av-wave-box') as HTMLElement;
    box.append(h('div', { class: 'sp-caption-slot' }, caption));
    void loadMedia(path, media, box);
  }
  const player = new Player(media, D, info.fps);
  dock.append(transport(player, { steps: false }));
  if (info.hasVideo) {
    dock.append(timelineBlock(tl));
    requestAnimationFrame(() => void tl.thumbs(path, (info.width || 16) / (info.height || 9)));
  } else requestAnimationFrame(() => void tl.wave(path));
  bindKeys(player);
  tl.onSeek((t) => player.seek(t));
  player.onTime((t) => {
    tl.setTime(t);
    showAt(t);
  });

  function cueAt(t: number) {
    // Cues are kept in time order; a linear scan is fine for a few thousand.
    for (let i = 0; i < cues.length; i++) if (t >= cues[i].start && t < cues[i].end) return i;
    return -1;
  }
  function showAt(t: number) {
    const i = cueAt(t);
    caption.classList.toggle('box', o.style === 'box' && o.output === 'burn');
    if (i >= 0) {
      caption.hidden = false;
      caption.innerHTML = '';
      cues[i].text.split('\n').forEach((line) => caption.append(h('span', {}, line)));
    } else caption.hidden = true;
    if (i !== current) {
      current = i;
      list.querySelectorAll('.sp-cue.now').forEach((el) => el.classList.remove('now'));
      const row = i >= 0 ? (list.children[i] as HTMLElement | undefined) : undefined;
      if (row) {
        row.classList.add('now');
        if (player.playing && !row.contains(document.activeElement)) row.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  function renderMarks() {
    marks.innerHTML = '';
    for (const c of cues) marks.append(h('i', { style: { left: tl.pct(c.start), width: `calc(${tl.pct(c.end)} - ${tl.pct(c.start)})` } }));
  }

  // ------------------------------------------------------------ panel
  const panel = optionsPanel(o, models, {
    duration: D,
    estLabel: 'for this file',
    hasVideo: info.hasVideo,
    onChange: () => {
      if (phase === 'setup') setupStatus();
      else if (phase === 'review') {
        reviewStatus();
        showAt(player.time);
      }
    },
  });
  const sec = panel.sections;
  const setupView = h('div', {}, sec.model, sec.language, sec.output, sec.lines);

  const progressLabel = h('div', { class: 'sp-progress-label' });
  const bar = h('div', { class: 'sp-bar' }, h('i', {}));
  const progressView = h('div', { class: 'section sp-progress' }, progressLabel, bar);

  const list = h('div', { class: 'sp-cues', role: 'list' });
  const summary = h('div', { class: 'sp-summary' });
  const startOver = h('button', { class: 'btn small ghost', onclick: () => backToSetup() }, 'Start over');
  const reviewHead = h('div', { class: 'section sp-review-head' }, h('div', { class: 'row' }, summary, h('span', { class: 'fixed' }, startOver)));
  const reviewOutput = h('div', { class: 'sp-review-output' });
  const reviewView = h('div', { class: 'sp-review' }, reviewHead, list, reviewOutput);

  s.panel.classList.add('sp-panel');
  s.panel.append(setupView);

  function setupStatus() {
    const m = models.find((x) => x.id === o.model);
    if (!m) return;
    s.status.textContent = `${cap(minutes(m.rtf * D))} to transcribe${m.cached ? '' : ` after a ${fmtBytes(m.bytes)} download`}`;
  }
  function reviewStatus() {
    const out = OUTPUTS.find((x) => x.id === o.output)!;
    s.status.textContent = `${cues.length} cue${cues.length === 1 ? '' : 's'}${edited ? ' · edited' : ''} · saves as ${out.label.toLowerCase()}`;
  }
  setupStatus();

  // Live progress from the main process.
  const off = api().on('speech:progress', (p: Progress) => {
    if (phase !== 'working') return;
    progressLabel.textContent = p.note;
    const f = p.phase === 'download' ? p.done / Math.max(1, p.total) : p.phase === 'transcribe' ? p.done / Math.max(1, p.total) : 0;
    bar.classList.toggle('indeterminate', p.phase === 'load' || p.phase === 'decode' || p.phase === 'detect');
    (bar.firstElementChild as HTMLElement).style.width = `${Math.round(f * 1000) / 10}%`;
    if (p.cues && p.cues.length > cues.length) {
      cues = p.cues;
      renderList(true);
      renderMarks();
    }
    if (p.language) summary.textContent = languageName(p.language);
  });
  window.addEventListener('beforeunload', off);

  // The footer's Cancel stops a running transcription instead of closing the window.
  const cancelBtn = h('button', { class: 'btn' }, 'Cancel');
  s.cancel.replaceWith(cancelBtn);
  cancelBtn.addEventListener('click', () => {
    if (phase === 'working') {
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Stopping…';
      void api().invoke('speech:cancel');
    } else api().send('window:close');
  });

  async function startTranscription() {
    phase = 'working';
    cues = [];
    edited = false;
    language = null;
    s.panel.innerHTML = '';
    summary.textContent = '';
    progressLabel.textContent = 'Starting…';
    (bar.firstElementChild as HTMLElement).style.width = '0%';
    bar.classList.add('indeterminate');
    s.panel.append(progressView, list);
    list.innerHTML = '';
    list.append(h('div', { class: 'sp-wait' }, ...Array.from({ length: 5 }, () => h('div', { class: 'skeleton sp-skel' }))));
    s.primary.disabled = true;
    s.primary.textContent = 'Transcribing…';
    s.status.textContent = '';
    const r = await api().invoke<{ cues?: Cue[]; language?: string | null; cancelled?: boolean; error?: string }>('speech:transcribe', path, { ...o });
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel';
    models = await api().invoke<ModelInfo[]>('speech:models');
    panel.setModels(models);
    if (r.cancelled || r.error) {
      backToSetup(true);
      s.status.textContent = r.cancelled ? 'Stopped. Nothing was saved.' : r.error!;
      return;
    }
    cues = r.cues ?? [];
    language = r.language ?? null;
    enterReview();
  }

  function enterReview() {
    phase = 'review';
    s.panel.innerHTML = '';
    reviewOutput.innerHTML = '';
    reviewOutput.append(section('Save as', panel.outputs, panel.styleField));
    reviewView.append(reviewHead, list, reviewOutput);
    s.panel.append(reviewView);
    summary.innerHTML = '';
    summary.append(h('strong', {}, `${cues.length} cue${cues.length === 1 ? '' : 's'}`), h('span', { class: 'muted' }, language ? ` · ${languageName(language)}` : ''));
    renderList(false);
    renderMarks();
    s.primary.disabled = !cues.length;
    s.primary.textContent = 'Save';
    reviewStatus();
    if (!cues.length) list.append(h('p', { class: 'empty-state sp-empty' }, 'No speech was found. Try another model or pick the language by hand.'));
    showAt(player.time);
  }

  function backToSetup(force = false) {
    if (!force && edited && !confirm('Start over? Your edits to the cues will be lost.')) return;
    phase = 'setup';
    cues = [];
    renderMarks();
    caption.hidden = true;
    s.panel.innerHTML = '';
    panel.sections.output.append(panel.outputs, panel.styleField);
    s.panel.append(setupView);
    s.primary.disabled = !info.hasAudio;
    s.primary.textContent = 'Transcribe';
    setupStatus();
  }

  // ------------------------------------------------------------ cue list
  function markEdited() {
    edited = true;
    reviewStatus();
    renderMarks();
    showAt(player.time);
  }

  function renderList(live: boolean) {
    list.innerHTML = '';
    cues.forEach((c, i) => list.append(live ? liveRow(c, i) : cueRow(c, i)));
    if (live) list.lastElementChild?.scrollIntoView({ block: 'nearest' });
    current = -2;
  }

  function liveRow(c: Cue, i: number) {
    return h('div', { class: 'sp-cue live', role: 'listitem' }, h('div', { class: 'sp-cue-head' }, h('span', { class: 'av-idx' }, String(i + 1)), h('span', { class: 'time muted' }, `${fmtTime(c.start)} – ${fmtTime(c.end)}`)), h('div', { class: 'sp-cue-text' }, c.text));
  }

  function cueRow(c: Cue, i: number) {
    const start = timeField(c.start, (v) => {
      c.start = Math.min(v, c.end - 0.05);
      start.show(c.start);
      markEdited();
    }, { step: 0.05, max: D });
    const end = timeField(c.end, (v) => {
      c.end = Math.max(v, c.start + 0.05);
      end.show(c.end);
      markEdited();
    }, { step: 0.05, max: D });
    const text = h('textarea', { class: 'sp-cue-input', rows: Math.max(1, c.text.split('\n').length), spellcheck: true, 'aria-label': `Cue ${i + 1} text` }) as HTMLTextAreaElement;
    text.value = c.text;
    text.addEventListener('input', () => {
      c.text = text.value;
      text.rows = Math.max(1, text.value.split('\n').length);
      markEdited();
    });
    text.addEventListener('focus', () => {
      if (!player.playing) player.seek(c.start + 0.01);
    });
    const play = gbtn('play', 'Play this cue', () => player.play(c.start, c.end), 'av-mini');
    const merge =
      i < cues.length - 1
        ? gbtn('join', 'Merge with the next cue', () => {
            const n = cues[i + 1];
            c.text = `${c.text} ${n.text}`.replace(/\s*\n\s*/g, ' ').trim();
            c.end = n.end;
            cues.splice(i + 1, 1);
            renderList(false);
            markEdited();
          }, 'av-mini')
        : null;
    const del = gbtn('trash', 'Delete this cue', () => {
      cues.splice(i, 1);
      renderList(false);
      markEdited();
      s.primary.disabled = !cues.length;
      summary.querySelector('strong')!.textContent = `${cues.length} cue${cues.length === 1 ? '' : 's'}`;
    }, 'av-mini');
    const row = h(
      'div',
      { class: 'sp-cue', role: 'listitem' },
      h('div', { class: 'sp-cue-head' }, h('span', { class: 'av-idx' }, String(i + 1)), start, h('span', { class: 'muted' }, '–'), end, h('span', { class: 'spacer' }), play, merge, del),
      text,
    );
    row.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('input,textarea,button')) return;
      player.play(c.start, c.end);
    });
    return row;
  }

  window.addEventListener('keydown', (e) => {
    if (phase !== 'review' || isTyping(e)) return;
    // Up/Down move between cues and play them.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = Math.max(0, Math.min(cues.length - 1, (current < 0 ? cueAfter(player.time) - (e.key === 'ArrowDown' ? 1 : 0) : current) + (e.key === 'ArrowDown' ? 1 : -1)));
      if (cues[i]) {
        player.play(cues[i].start, cues[i].end);
        (list.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
      }
    }
  });
  function cueAfter(t: number) {
    const i = cues.findIndex((c) => c.start >= t);
    return i < 0 ? cues.length : i;
  }

  s.primary.addEventListener('click', () => {
    if (phase === 'setup') void startTranscription();
    else if (phase === 'review') {
      player.pause();
      void runAndClose(s.primary, 'subtitles', [path], { ...o, cues: cues.map((c) => ({ start: c.start, end: c.end, text: c.text })), cueLanguage: language }, s.status);
    }
  });
}

export async function subtitles(paths: string[]) {
  const o = loadOpts();
  const models = await api().invoke<ModelInfo[]>('speech:models');
  if (paths.length > 1) return multi(paths, o, models);
  return single(paths[0], o, models);
}
