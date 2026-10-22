// Subtitles: speech to SRT/VTT/TXT (or burned in / added as a track), fully offline.
//
// Whisper runs in the main process through @huggingface/transformers on onnxruntime-node. Audio is
// decoded by the bundled ffmpeg to 16 kHz mono float32, cut into windows of at most 30 s at the
// quietest moments (so words aren't split and Cancel can stop between windows), and each window is
// transcribed with word timestamps. Words are then grouped into readable cues.
//
// The single-file window transcribes through IPC (speech:transcribe), lets the user review and
// edit the cues, then calls the `subtitles` tool with the edited cues. Multi-file runs go straight
// to the tool, which transcribes each file in turn and saves next to it.
import { ipcMain, type WebContents } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx, ToolFn } from './types';
import { UserError } from './types';
import { ffmpeg, probe, x264, videoOutExt, audioCopyOk, videoAudioArgs, extOf } from './av-util';
import { probe as probeStreams } from '../engines/ffmpeg';
import { registerModel, loadPipeline, isReady, estimateMs, recordTiming } from '../engines/ai';
import { log } from '../log';

// ------------------------------------------------------------------ models

export type ModelId = 'fast' | 'balanced' | 'best';

interface SpeechModel {
  id: ModelId;
  /** Key in the shared model manager (status, timings, delete). */
  key: string;
  label: string;
  repo: string;
  /** Download size in MB (q8 ONNX weights + tokenizer). */
  mb: number;
  /** Seconds of compute per second of audio on a typical laptop CPU (measured on a Core 5 120U). */
  rtf: number;
  blurb: string;
}

// q8 weights on the CPU. On the integrated GPUs we measured, DirectML was slower for every size
// (it runs quantized ops poorly, and Whisper's decoder works one token at a time), so these models
// stay on the CPU instead of taking part in the manager's DirectML trial.
const DTYPE = { encoder_model: 'q8', decoder_model_merged: 'q8' } as const;
const FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];

export const MODELS: SpeechModel[] = [
  { id: 'fast', key: 'whisper-base', label: 'Fast', repo: 'onnx-community/whisper-base_timestamped', mb: 79, rtf: 0.27, blurb: 'Whisper Base. Good for clear speech.' },
  { id: 'balanced', key: 'whisper-small', label: 'Balanced', repo: 'onnx-community/whisper-small_timestamped', mb: 252, rtf: 0.45, blurb: 'Whisper Small. Handles accents and noise better.' },
  { id: 'best', key: 'whisper-large-v3-turbo', label: 'Best', repo: 'onnx-community/whisper-large-v3-turbo_timestamped', mb: 1088, rtf: 1.2, blurb: 'Whisper Large v3 Turbo. Most accurate, slowest on a CPU.' },
];

for (const m of MODELS) {
  registerModel({ id: m.key, label: `the ${m.label} speech model`, repo: m.repo, files: FILES, mb: m.mb, licence: 'MIT', msPerUnit: { cpu: m.rtf * 1000 } });
}

const modelOf = (id: string) => MODELS.find((m) => m.id === id) ?? MODELS[0];

/** Seconds of compute per second of audio: measured on this PC once it has run, else the default. */
function speedOf(m: SpeechModel) {
  const ms = estimateMs(m.key, 1, 'cpu');
  return { rtf: ms / 1000, measured: Math.round(ms) !== Math.round(m.rtf * 1000) };
}

export function modelList() {
  return MODELS.map((m) => ({ id: m.id, label: m.label, blurb: m.blurb, bytes: m.mb * 1e6, cached: isReady(m.key), ...speedOf(m) }));
}

// ---------------------------------------------------------------- pipeline

type Asr = any;

/** The Whisper pipeline from the shared model manager (downloads on first use, cached after). */
async function loadAsr(m: SpeechModel, onDownload: (loaded: number, total: number) => void, signal: AbortSignal): Promise<Asr> {
  const total = m.mb * 1e6;
  try {
    return await loadPipeline('automatic-speech-recognition', m.repo, { id: m.key, dtype: DTYPE as any, device: 'cpu', span: [0, 1] }, { signal, progress: (f) => onDownload(f * total, total) });
  } catch (e: any) {
    if (signal.aborted) throw new Error('Cancelled');
    log('subtitles: model load failed', m.repo, e);
    const msg = String(e?.message ?? e);
    if (/^network:/.test(msg)) throw new UserError(msg.replace(/^network:\s*/, '').replace(/^./, (c) => c.toUpperCase()));
    throw new UserError(`The ${m.label} speech model couldn't be loaded. ${msg.slice(0, 160)}`);
  }
}

// One transcription at a time: the models are large and already use every core.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------------ audio

const SR = 16000;
const FRAME = 320; // 20 ms

async function decodePcm(input: string, signal: AbortSignal): Promise<Float32Array> {
  const buf = await ffmpeg(['-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], { signal, binary: true });
  // Copy into an aligned buffer (Node's pooled Buffers may not be 4-byte aligned).
  const out = new Float32Array(Math.floor(buf.byteLength / 4));
  new Uint8Array(out.buffer).set(buf.subarray(0, out.length * 4));
  return out;
}

interface Energy {
  rms: Float32Array; // per 20 ms frame
  silence: number; // threshold below which a frame counts as silent
}

function energy(pcm: Float32Array): Energy {
  const n = Math.ceil(pcm.length / FRAME);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const a = f * FRAME;
    const b = Math.min(pcm.length, a + FRAME);
    for (let i = a; i < b; i++) s += pcm[i] * pcm[i];
    rms[f] = Math.sqrt(s / Math.max(1, b - a));
  }
  const sorted = Float32Array.from(rms).sort();
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const floor = pct(0.1);
  const speech = pct(0.9);
  const silence = Math.max(0.002, floor + (speech - floor) * 0.08);
  return { rms, silence };
}

/** Splits the audio into windows of at most ~29.5 s, cutting at the quietest moment. */
function planWindows(pcm: Float32Array, e: Energy): [number, number][] {
  const maxLen = Math.floor(29.5 * SR);
  const minLen = 12 * SR;
  const out: [number, number][] = [];
  let pos = 0;
  while (pcm.length - pos > maxLen) {
    // Lowest 300 ms average energy between minLen and maxLen; later cuts win ties (fewer windows).
    const f0 = Math.floor((pos + minLen) / FRAME);
    const f1 = Math.floor((pos + maxLen) / FRAME) - 15;
    let best = f1;
    let bestE = Infinity;
    let acc = 0;
    for (let f = f0; f < f0 + 15; f++) acc += e.rms[f] ?? 0;
    for (let f = f0; f <= f1; f++) {
      if (acc <= bestE * 1.02) {
        bestE = Math.min(acc, bestE);
        best = f;
      }
      acc += (e.rms[f + 15] ?? 0) - (e.rms[f] ?? 0);
    }
    const cut = (best + 7) * FRAME;
    out.push([pos, cut]);
    pos = cut;
  }
  if (pcm.length - pos > SR * 0.2) out.push([pos, pcm.length]);
  return out;
}

function hasSpeech(e: Energy, a: number, b: number) {
  let loud = 0;
  for (let f = Math.floor(a / FRAME); f < Math.ceil(b / FRAME); f++) if (e.rms[f] > e.silence * 2) loud++;
  return loud >= 10; // at least 200 ms above the noise floor
}

// --------------------------------------------------------------- language

/** Whisper's language token after <|startoftranscript|>; null when it can't tell. */
async function detectLanguage(pipe: Asr, audio: Float32Array): Promise<string | null> {
  try {
    const gc = pipe.model.generation_config;
    if (!gc?.is_multilingual || !gc.lang_to_id) return 'en';
    const { input_features } = await pipe.processor(audio);
    const out = await pipe.model.generate({ inputs: input_features, decoder_input_ids: [gc.decoder_start_token_id], max_new_tokens: 1, return_timestamps: false });
    const ids: any[] = (out.sequences ?? out).tolist()[0];
    const tok = Number(ids[ids.length - 1]);
    const hit = Object.entries(gc.lang_to_id as Record<string, number>).find(([, v]) => Number(v) === tok);
    return hit ? hit[0].slice(2, -2) : null;
  } catch (e) {
    log('subtitles: language detection failed', e);
    return null;
  }
}

// ------------------------------------------------------------------ words

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface SpeechOptions {
  model: ModelId;
  /** 'auto' or a Whisper language code ("en", "de"...). */
  language: string;
  task: 'transcribe' | 'translate';
  output: 'srt' | 'vtt' | 'txt' | 'burn' | 'track';
  maxChars: number;
  maxLines: number;
  style: 'outline' | 'box';
  /** Reviewed cues from the window (single file). */
  cues?: Cue[];
  /** Language the cues are in (for the track's language tag). */
  cueLanguage?: string;
}

export interface Progress {
  phase: 'download' | 'load' | 'decode' | 'detect' | 'transcribe';
  /** Bytes for download; seconds of audio for transcribe. */
  done: number;
  total: number;
  /** Seconds left, when it can be estimated. */
  eta?: number;
  /** Cues so far (transcribe phase). */
  cues?: Cue[];
  language?: string;
}

/** Pulls word boundaries off the silence on either side (Whisper tends to stretch the last word). */
function tightenWords(words: Word[], e: Energy) {
  const silent = (t: number) => (e.rms[Math.floor((t * SR) / FRAME)] ?? 0) < e.silence;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!(w.end > w.start)) w.end = w.start + 0.2;
    while (w.end - w.start > 0.15 && silent(w.end - 0.02)) w.end -= 0.02;
    if (silent(w.start)) {
      while (w.end - w.start > 0.15 && silent(w.start)) w.start += 0.02;
    } else {
      // Whisper often starts a word late; move back to the real onset if speech runs up to it.
      const floor = Math.max(i ? words[i - 1].end : 0, w.start - 0.4);
      while (w.start - 0.02 > floor && !silent(w.start - 0.02)) w.start -= 0.02;
    }
    w.start = Math.round(w.start * 1000) / 1000;
    w.end = Math.round(w.end * 1000) / 1000;
  }
  for (let i = 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].start) words[i].start = words[i - 1].start;
    if (words[i - 1].end > words[i].start) words[i - 1].end = Math.max(words[i - 1].start + 0.05, words[i].start);
    if (words[i].end < words[i].start) words[i].end = words[i].start + 0.05;
  }
}

/** Whisper hallucinations on near-silence ("Thank you.", "Subtitles by…"); dropped when isolated. */
const HALLUCINATION = /^(thanks? (you )?(for watching|so much)?[.!]?|subtitles? by.*|transcribed by.*|♪+|\.+|you)$/i;

export async function transcribe(input: string, o: SpeechOptions, signal: AbortSignal, onProgress: (p: Progress) => void): Promise<{ cues: Cue[]; words: Word[]; language: string | null; duration: number }> {
  return exclusive(async () => {
    const info = await probe(input, signal);
    if (!info.hasAudio) throw new UserError(`${input.split(/[\\/]/).pop()} has no audio track to transcribe.`);
    const m = modelOf(o.model);
    const needsDownload = !isReady(m.key);
    onProgress({ phase: needsDownload ? 'download' : 'load', done: 0, total: m.mb * 1e6 });
    const pipe = await loadAsr(m, needsDownload ? (l, t) => onProgress({ phase: 'download', done: l, total: t }) : () => {}, signal);
    if (signal.aborted) throw new Error('Cancelled');
    onProgress({ phase: 'decode', done: 0, total: info.duration });
    const pcm = await decodePcm(input, signal);
    const duration = pcm.length / SR;
    const e = energy(pcm);
    const windows = planWindows(pcm, e).filter(([a, b]) => hasSpeech(e, a, b));

    let language: string | null = o.language && o.language !== 'auto' ? o.language : null;
    if (!language && windows.length) {
      onProgress({ phase: 'detect', done: 0, total: duration });
      // Use the window with the most speech in the first few for a confident guess.
      const cand = windows.slice(0, 4).map(([a, b]) => {
        let s = 0;
        for (let f = Math.floor(a / FRAME); f < b / FRAME; f++) if (e.rms[f] > e.silence * 2) s++;
        return { a, b, s };
      });
      cand.sort((x, y) => y.s - x.s);
      language = await detectLanguage(pipe, pcm.subarray(cand[0].a, cand[0].b));
    }

    const words: Word[] = [];
    const t0 = Date.now();
    const speechTotal = windows.reduce((s, [a, b]) => s + (b - a), 0) / SR || 1;
    let speechDone = 0;
    const rtf0 = speedOf(m).rtf;
    // Whisper writes timestamp tokens as it goes, so the position inside a window is known.
    const tsBegin = Number(pipe.model?.generation_config?.no_timestamps_token_id) + 1 || 0;
    const report = (pos: number, inWindow: number, withCues: boolean) => {
      const elapsed = (Date.now() - t0) / 1000;
      const doneSpeech = speechDone + inWindow;
      const rtf = doneSpeech > 15 ? elapsed / doneSpeech : rtf0;
      onProgress({ phase: 'transcribe', done: pos, total: duration, eta: Math.max(0, (speechTotal - doneSpeech) * rtf), cues: withCues ? makeCues(words, o) : undefined, language: language ?? undefined });
    };
    for (const [a, b] of windows) {
      if (signal.aborted) throw new Error('Cancelled');
      const off = a / SR;
      const len = (b - a) / SR;
      report(off, 0, true);
      let lastEmit = Date.now();
      let base = 0;
      let prevRaw = 0;
      let maxPos = 0;
      const r = await pipe(pcm.subarray(a, b), {
        return_timestamps: 'word',
        task: o.task,
        ...(language ? { language } : {}),
        // Runs before every generated token: throwing here stops the window mid-way on Cancel.
        // (A fresh array each call: Whisper's generate() pushes its own processors onto it.)
        logits_processor: [
          (ids: any[][], logits: unknown) => {
            if (signal.aborted) throw new Error('Cancelled');
            const now = Date.now();
            if (tsBegin && now - lastEmit > 400) {
              const seq = ids?.[0] ?? [];
              for (let j = seq.length - 1; j >= Math.max(0, seq.length - 4); j--) {
                const t = Number(seq[j]);
                if (t >= tsBegin && t < tsBegin + 1501) {
                  // Timestamps restart from 0 when Whisper continues a window in a second pass.
                  const raw = (t - tsBegin) * 0.02;
                  if (raw + 1 < prevRaw) base = maxPos;
                  prevRaw = raw;
                  const pos = Math.min(len, base + raw);
                  if (pos > maxPos) {
                    maxPos = pos;
                    lastEmit = now;
                    report(off + pos, pos, false);
                  }
                  break;
                }
              }
            }
            return logits;
          },
        ],
      });
      const got: Word[] = [];
      for (const c of r?.chunks ?? []) {
        const text = String(c.text ?? '');
        if (!text.trim()) continue;
        const s = Number(c.timestamp?.[0]);
        const en = Number(c.timestamp?.[1]);
        const start = off + (Number.isFinite(s) ? Math.min(s, len) : 0);
        const end = off + (Number.isFinite(en) ? Math.min(en, len) : Math.min(len, (Number.isFinite(s) ? s : 0) + 0.4));
        got.push({ text, start, end });
      }
      const joined = got.map((w) => w.text).join('').trim();
      if (!(got.length <= 4 && HALLUCINATION.test(joined))) {
        tightenWords(got, e);
        words.push(...got);
      }
      speechDone += len;
    }
    tightenWords(words, e);
    const secs = (Date.now() - t0) / 1000;
    if (speechDone > 20) recordTiming(m.key, 'cpu', (secs / speechDone) * 1000);
    const cues = makeCues(words, o);
    onProgress({ phase: 'transcribe', done: duration, total: duration, eta: 0, cues, language: language ?? undefined });
    return { cues, words, language: o.task === 'translate' ? 'en' : language, duration };
  });
}

// ------------------------------------------------------------------- cues

const SENTENCE_END = /[.!?…。！？؟]["'»”’)\]]*$/;
const CLAUSE_END = /[,;:，、；：–—-]["'»”’)\]]*$/;

const joinWords = (ws: Word[]) => ws.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();

/** Breaks text into at most `maxLines` lines of `maxChars`, balanced; null when it can't fit. */
export function wrapLines(text: string, maxChars: number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (text.length <= maxChars) return [text];
  if (maxLines < 2) return null;
  if (maxLines === 2) {
    let best: string[] | null = null;
    let score = Infinity;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' ');
      const b = words.slice(k).join(' ');
      if (a.length > maxChars || b.length > maxChars) continue;
      // Balanced lines, preferring a break after punctuation and a slightly shorter top line.
      let s = Math.abs(a.length - b.length) + (a.length > b.length ? 2 : 0);
      if (SENTENCE_END.test(a)) s -= 14;
      else if (CLAUSE_END.test(a)) s -= 8;
      if (s < score) {
        score = s;
        best = [a, b];
      }
    }
    return best;
  }
  // 3+ lines: greedy fill.
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
    if (w.length > maxChars) return null;
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

/**
 * Groups words into cues: at most maxLines × maxChars, at most 7 s, a new cue after a pause and,
 * when the cue is reasonably full, after a sentence or clause. Overflow breaks at the best spot
 * in the second half of the cue instead of mid-phrase.
 */
export function makeCues(words: Word[], o: Pick<SpeechOptions, 'maxChars' | 'maxLines'>): Cue[] {
  const maxChars = Math.max(16, Math.min(80, Math.round(o.maxChars || 42)));
  const maxLines = Math.max(1, Math.min(3, Math.round(o.maxLines || 2)));
  const cap = maxChars * maxLines;
  const MAX_DUR = 7;
  const groups: Word[][] = [];
  let cur: Word[] = [];
  const fits = (ws: Word[]) => {
    const t = joinWords(ws);
    return t.length <= cap && !!wrapLines(t, maxChars, maxLines);
  };
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const prevText = prev.text.trim();
      const curLen = joinWords(cur).length;
      const gap = w.start - prev.end;
      if (gap > 0.75 || (SENTENCE_END.test(prevText) && curLen >= Math.min(20, cap * 0.35)) || (CLAUSE_END.test(prevText) && curLen >= cap * 0.65)) {
        groups.push(cur);
        cur = [];
      } else if (!fits([...cur, w]) || w.end - cur[0].start > MAX_DUR) {
        // Find a better break inside the current cue (after punctuation or at a pause).
        // Without punctuation or a pause, carry the last third over so no word is left alone.
        let k = -1;
        let bestScore = 0;
        let fallback = -1;
        for (let i = 1; i < cur.length; i++) {
          const head = joinWords(cur.slice(0, i)).length;
          if (head < curLen * 0.3) continue;
          if (fallback < 0 && head >= curLen * 0.62) fallback = i;
          const t = cur[i - 1].text.trim();
          const pause = cur[i].start - cur[i - 1].end;
          const s = (SENTENCE_END.test(t) ? 3 : CLAUSE_END.test(t) ? 2 : 0) + Math.min(2, pause * 6) + head / curLen;
          if (s > bestScore) {
            bestScore = s;
            k = i;
          }
        }
        if (bestScore < 1.5) k = fallback;
        if (k > 0) {
          groups.push(cur.slice(0, k));
          cur = cur.slice(k);
          if (!fits([...cur, w])) {
            groups.push(cur);
            cur = [];
          }
        } else {
          groups.push(cur);
          cur = [];
        }
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  const cues: Cue[] = groups
    .map((g) => {
      const text = joinWords(g);
      const lines = wrapLines(text, maxChars, maxLines) ?? [text];
      return { start: g[0].start, end: g[g.length - 1].end, text: lines.join('\n') };
    })
    .filter((c) => c.text);
  // Give short cues enough time to read (about 17 characters a second, at least 1 s) without
  // running into the next cue, and never longer than 1.5 s past the speech.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    // Show each cue a moment before the first word; never before the previous one ends.
    c.start = Math.max(i ? cues[i - 1].end + 0.02 : 0, c.start - 0.08, 0);
    const next = cues[i + 1]?.start ?? Infinity;
    const want = Math.max(1, c.text.length / 17);
    const end = Math.min(Math.max(c.end, c.start + want), c.end + 1.5, next - 0.05);
    c.end = Math.max(c.end, end);
    if (c.end > next) c.end = Math.max(c.start + 0.1, next - 0.01);
    c.start = Math.round(c.start * 1000) / 1000;
    c.end = Math.round(c.end * 1000) / 1000;
  }
  return cues;
}

// ----------------------------------------------------------------- writers

function stamp(t: number, sep: ',' | '.') {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}

const clean = (cues: Cue[]) =>
  cues
    .map((c) => ({ start: Math.max(0, Number(c.start) || 0), end: Math.max(0, Number(c.end) || 0), text: String(c.text ?? '').replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim() }))
    .filter((c) => c.text && c.end > c.start)
    .sort((a, b) => a.start - b.start);

export function toSrt(cues: Cue[]) {
  return clean(cues)
    .map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`)
    .join('\n');
}

export function toVtt(cues: Cue[]) {
  // "-->" can't appear in cue text; a blank line would end the cue.
  return 'WEBVTT\n\n' + clean(cues).map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text.replace(/-->/g, '->')}\n`).join('\n');
}

/** Plain transcript: lines joined into paragraphs, a new paragraph after a pause of 2 s or more. */
export function toTxt(cues: Cue[]) {
  const paras: string[][] = [];
  let last = -Infinity;
  for (const c of clean(cues)) {
    if (c.start - last >= 2 || !paras.length) paras.push([]);
    paras[paras.length - 1].push(c.text.replace(/\n/g, ' '));
    last = c.end;
  }
  return paras.map((p) => p.join(' ')).join('\n\n') + '\n';
}

// ISO 639-2 codes for the subtitle track's language tag (MP4/MKV want three letters).
const ISO3: Record<string, string> = {
  en: 'eng', de: 'ger', fr: 'fre', es: 'spa', it: 'ita', pt: 'por', nl: 'dut', sv: 'swe', no: 'nor', da: 'dan', fi: 'fin', pl: 'pol', cs: 'cze', sk: 'slo', hu: 'hun', ro: 'rum', bg: 'bul', el: 'gre', ru: 'rus', uk: 'ukr', tr: 'tur', ar: 'ara', he: 'heb', fa: 'per', hi: 'hin', bn: 'ben', ur: 'urd', ta: 'tam', te: 'tel', mr: 'mar', gu: 'guj', kn: 'kan', ml: 'mal', pa: 'pan', th: 'tha', vi: 'vie', id: 'ind', ms: 'may', tl: 'tgl', zh: 'chi', ja: 'jpn', ko: 'kor', ca: 'cat', hr: 'hrv', sr: 'srp', sl: 'slv', lt: 'lit', lv: 'lav', et: 'est', is: 'ice', ga: 'gle', cy: 'wel', sw: 'swa', af: 'afr',
};

const SOFT_CONTAINERS: Record<string, string> = { mp4: 'mov_text', m4v: 'mov_text', mov: 'mov_text', mkv: 'srt', webm: 'webvtt' };

async function writeOutputs(input: string, cues: Cue[], o: SpeechOptions, language: string | null, ctx: Ctx, range: [number, number]): Promise<string[]> {
  if (!clean(cues).length) throw new UserError(`No speech was found in ${input.split(/[\\/]/).pop()}.`);
  const info = await probe(input, ctx.signal);
  let output = o.output;
  // Audio files can't take burned-in or track subtitles; they get an SRT next to them.
  if ((output === 'burn' || output === 'track') && !info.hasVideo) output = 'srt';
  if (output === 'srt' || output === 'vtt' || output === 'txt') {
    const text = output === 'srt' ? toSrt(cues) : output === 'vtt' ? toVtt(cues) : toTxt(cues);
    const out = ctx.out(input, output);
    writeFileSync(out, (output === 'txt' ? '' : '\ufeff') + text, 'utf8');
    ctx.progress(range[1]);
    return [out];
  }
  const tmp = ctx.tmp();
  if (output === 'burn') {
    const srt = join(tmp, 'subs.srt');
    writeFileSync(srt, toSrt(cues), 'utf8');
    const ext = videoOutExt(input);
    const out = ctx.out(input, ext, ' subtitled');
    // ffmpeg runs in the temp folder and the filter names the file relatively: a full path would need
    // filter-graph escaping, and an apostrophe in it (C:\Users\O'Neil\...) can't be escaped inside quotes.
    const p = 'subs.srt';
    const style =
      o.style === 'box'
        ? 'FontName=Segoe UI Semibold,FontSize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&H59000000,BackColour=&H59000000,BorderStyle=4,Outline=4,Shadow=0,MarginV=22'
        : 'FontName=Segoe UI Semibold,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BackColour=&H80000000,BorderStyle=1,Outline=1.2,Shadow=0.5,MarginV=20';
    const audio = audioCopyOk(ext, info.acodec) ? ['-c:a', 'copy'] : videoAudioArgs(ext);
    await ffmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', `subtitles='${p}':force_style='${style}'`, ...x264(19, 'fast'), ...audio, ...(ext === 'mp4' || ext === 'mov' || ext === 'm4v' ? ['-movflags', '+faststart'] : []), out], {
      ctx,
      duration: info.duration,
      range,
      note: 'Burning in subtitles',
      cwd: tmp,
    });
    return [out];
  }
  // Soft subtitle track, streams copied.
  let ext = extOf(input);
  if (!SOFT_CONTAINERS[ext]) ext = 'mkv';
  const codec = SOFT_CONTAINERS[ext];
  const sub = join(tmp, ext === 'webm' ? 'subs.vtt' : 'subs.srt');
  writeFileSync(sub, ext === 'webm' ? toVtt(cues) : toSrt(cues), 'utf8');
  const streams = await probeStreams(input, ctx.signal);
  // Keep video, audio and (when the container can hold them) existing subtitles.
  const keepSubs = streams.subtitles.filter((s) => (codec === 'mov_text' ? s.codec === 'mov_text' : codec === 'webvtt' ? s.codec === 'webvtt' : true));
  const n = keepSubs.length;
  const lang = ISO3[language ?? ''] ?? 'und';
  const out = ctx.out(input, ext, ' subtitled');
  await ffmpeg(
    [
      '-i', input, '-i', sub,
      '-map', '0:v?', '-map', '0:a?', ...keepSubs.flatMap((s) => ['-map', `0:${s.index}`]), '-map', '1:0',
      '-c', 'copy', `-c:s:${n}`, codec,
      `-metadata:s:s:${n}`, `language=${lang}`, `-metadata:s:s:${n}`, 'title=Subtitles', `-disposition:s:${n}`, 'default',
      ...(codec === 'mov_text' ? ['-movflags', '+faststart'] : []),
      out,
    ],
    { ctx, duration: info.duration, range, note: 'Adding the subtitle track' },
  );
  return [out];
}

// -------------------------------------------------------------------- tool

const fmtClock = (s: number) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

export const fmtEta = (s: number) => (s < 45 ? 'less than a minute left' : s < 90 ? 'about a minute left' : s < 3600 ? `about ${Math.round(s / 60)} min left` : `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`);

function note(p: Progress, prefix = '') {
  switch (p.phase) {
    case 'download':
      return `${prefix}Downloading the speech model ${Math.round(p.done / 1e6)} / ${Math.round(p.total / 1e6)} MB`;
    case 'load':
      return `${prefix}Loading the speech model`;
    case 'decode':
      return `${prefix}Reading audio`;
    case 'detect':
      return `${prefix}Detecting the language`;
    default:
      return `${prefix}Transcribing ${fmtClock(p.done)} / ${fmtClock(p.total)}${p.eta ? ` · ${fmtEta(p.eta)}` : ''}`;
  }
}

const subtitles: ToolFn = async (inputs, ctx) => {
  const o: SpeechOptions = { model: 'fast', language: 'auto', task: 'transcribe', output: 'srt', maxChars: 42, maxLines: 2, style: 'outline', ...(ctx.options ?? {}) };
  const heavy = o.output === 'burn' || o.output === 'track';
  // Reviewed in the window: just write the result.
  if (o.cues && inputs.length === 1) {
    return writeOutputs(inputs[0], o.cues, o, o.cueLanguage ?? (o.task === 'translate' ? 'en' : o.language !== 'auto' ? o.language : null), ctx, [0, 1]);
  }
  const outputs: string[] = [];
  const errors: string[] = [];
  const n = inputs.length;
  for (let i = 0; i < n; i++) {
    if (ctx.signal.aborted) break;
    const input = inputs[i];
    const lo = i / n;
    const span = 1 / n;
    const tEnd = lo + span * (heavy ? 0.75 : 0.98);
    const prefix = n > 1 ? `${i + 1} of ${n} · ` : '';
    try {
      const r = await transcribe(input, o, ctx.signal, (p) => {
        const f = p.phase === 'transcribe' && p.total ? p.done / p.total : 0;
        ctx.progress(lo + (tEnd - lo) * f, note(p, prefix));
      });
      outputs.push(...(await writeOutputs(input, r.cues, o, r.language, ctx, [tEnd, lo + span])));
    } catch (e: any) {
      if (ctx.signal.aborted) break;
      log('subtitles failed', input, e);
      errors.push(`${input.split(/[\\/]/).pop()}: ${e instanceof UserError ? e.message : String(e?.message ?? e)}`);
    }
  }
  if (!outputs.length && errors.length) throw new UserError(errors.join('\n'));
  return outputs;
};

export const tools: Record<string, ToolFn> = { subtitles };

// --------------------------------------------------------------------- IPC

const running = new Map<number, AbortController>();

ipcMain.handle('speech:models', () => modelList());

ipcMain.handle('speech:transcribe', async (e, path: string, opts: SpeechOptions) => {
  const sender: WebContents = e.sender;
  running.get(sender.id)?.abort();
  const ac = new AbortController();
  running.set(sender.id, ac);
  const stop = () => ac.abort();
  sender.once('destroyed', stop);
  let last = 0;
  try {
    const r = await transcribe(path, opts, ac.signal, (p) => {
      // Throttle download chatter; always pass phase changes and window results through.
      const now = Date.now();
      if (p.phase === 'download' && now - last < 120 && p.done < p.total) return;
      last = now;
      if (!sender.isDestroyed()) sender.send('speech:progress', { ...p, note: note(p) });
    });
    return { cues: r.cues, language: r.language, duration: r.duration };
  } catch (err: any) {
    if (ac.signal.aborted) return { cancelled: true };
    if (err instanceof UserError) return { error: err.message };
    log('subtitles: transcribe failed', path, err);
    return { error: String(err?.message ?? err).slice(0, 240) };
  } finally {
    sender.removeListener('destroyed', stop);
    if (running.get(sender.id) === ac) running.delete(sender.id);
  }
});

ipcMain.handle('speech:cancel', (e) => {
  running.get(e.sender.id)?.abort();
});
