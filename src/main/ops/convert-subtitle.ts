// SRT ↔ WebVTT and subtitles → plain text, in pure TypeScript.
// Tolerant of BOMs, CRLF/CR line endings, missing or wrong cue numbers, VTT headers/NOTE/STYLE/REGION blocks,
// cue settings ("align:start line:90%"), comma or dot milliseconds, hour-less timestamps and inline tags.
import { readFileSync, writeFileSync } from 'node:fs';
import type { ConverterModule } from './types';
import { UserError } from './types';

export interface Cue {
  start: number; // ms
  end: number; // ms
  text: string; // may contain line breaks and inline tags
}

const TIME = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?`;
const TIMING = new RegExp(`^\\s*${TIME}\\s*-->\\s*${TIME}`);

function toMs(h: string | undefined, m: string, s: string, f: string | undefined): number {
  const frac = f ? Number(f.padEnd(3, '0').slice(0, 3)) : 0;
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + frac;
}

/** Decode bytes to text: UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1252. */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2));
    b.swap16();
    return b.toString('utf16le');
  }
  const start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const body = buf.subarray(start);
  const utf8 = body.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return new TextDecoder('windows-1252').decode(body);
}

/** Parse SRT or WebVTT (auto-detected per cue, so mislabelled files still work). */
export function parseCues(text: string): Cue[] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const vtt = /^WEBVTT\b/.test(clean);
  const lines = clean.split('\n');
  const cues: Cue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip VTT blocks that aren't cues.
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(line.trim())) {
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }
    const m = TIMING.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const start = toMs(m[1], m[2], m[3], m[4]);
    const end = toMs(m[5], m[6], m[7], m[8]);
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      // A timing line straight after text means the blank separator was missing.
      if (TIMING.test(lines[i])) break;
      // A bare number followed by a timing line is the next cue's index, not dialogue.
      if (/^\s*\d+\s*$/.test(lines[i]) && i + 1 < lines.length && TIMING.test(lines[i + 1])) break;
      body.push(lines[i]);
      i++;
    }
    let t = body.join('\n').replace(/\s+$/, '');
    // Normalise to SRT-style text: VTT-only tags dropped, entities decoded. Writers re-escape as needed.
    if (vtt) t = decodeEntities(vttToSrtText(t));
    cues.push({ start, end: Math.max(end, start), text: t });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function stamp(ms: number, sep: ',' | '.'): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const f = t % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

/** Tags SRT players understand: <b> <i> <u> <font …>. VTT-only ones (<c.x>, <v Name>, <00:01.000>, <ruby>) are dropped. */
function vttToSrtText(s: string): string {
  return s
    .replace(/<v(?:\.[^\s>]*)?\s+([^>]*)>/g, '') // voice spans: keep the words, drop the speaker tag
    .replace(/<\/?(?:c|v|lang|ruby|rt)(?:[.\s][^>]*)?>/g, '')
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&lrm;/g, '\u200e')
    .replace(/&rlm;/g, '\u200f')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Characters that would break a VTT cue body. */
function srtToVttText(s: string): string {
  return s
    .replace(/\{\\[^}]*\}/g, '') // ASS-style overrides some SRTs carry, e.g. {\an8}
    .replace(/<font[^>]*>|<\/font>/gi, '')
    .replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;')
    .replace(/<(?!\/?(?:b|i|u)>)/gi, '&lt;')
    .replace(/-->/g, '--&gt;');
}

/** Dialogue only: no tags, no positioning codes, entities decoded, one cue per line. */
export function plainText(s: string): string {
  return s
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?(?:b|i|u|s|font)(?:\s[^>]*)?>/gi, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

export function toSrt(cues: Cue[]): string {
  return (
    cues
      .map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}`)
      .join('\n\n') + '\n'
  ).replace(/\n/g, '\r\n'); // CRLF is what Windows players expect for SRT
}

export function toVtt(cues: Cue[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${srtToVttText(c.text)}`).join('\n\n') + '\n';
}

export function toTxt(cues: Cue[]): string {
  const out: string[] = [];
  for (const c of cues) {
    const line = plainText(c.text);
    if (line && line !== out[out.length - 1]) out.push(line); // drop roll-up duplicates
  }
  return out.join('\r\n') + '\r\n';
}

export const converter: ConverterModule = {
  kinds: ['subtitle'],
  async convert(input, target, ctx) {
    const cues = parseCues(decodeText(readFileSync(input)));
    if (!cues.length) throw new UserError('No subtitles found in this file.');
    ctx.progress(0.5);
    const body = target === 'srt' ? toSrt(cues) : target === 'vtt' ? toVtt(cues) : target === 'txt' ? toTxt(cues) : null;
    if (body === null) throw new UserError(`Can't convert subtitles to ${target.toUpperCase()}.`);
    const out = ctx.out(input, target);
    // UTF-8 with a BOM for SRT/TXT so older players and editors detect the encoding; VTT is UTF-8 by spec.
    writeFileSync(out, (target === 'vtt' ? '' : '\uFEFF') + body, 'utf8');
    ctx.progress(1);
    return [out];
  },
};
