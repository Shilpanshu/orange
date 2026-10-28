// Small, self-contained ffmpeg/ffprobe helpers for the video and audio tools.
// Runs the bundled binaries, reports progress from `-progress pipe:1`, honours cancellation and
// can return binary stdout (for PCM waveforms and JPEG thumbnails).
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { bin } from '../paths';
import { log } from '../log';
import { gpuArgsFor } from '../engines/ffmpeg';
import type { Ctx } from './types';
import { UserError } from './types';

// ------------------------------------------------------------------ spawning

interface SpawnOpts {
  signal?: AbortSignal;
  /** Collect stdout as a Buffer (binary-safe). */
  binary?: boolean;
  onStdoutLine?: (line: string) => void;
  cwd?: string;
}

interface SpawnResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function spawnTool(exe: 'ffmpeg' | 'ffprobe', args: string[], opts: SpawnOpts = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('Cancelled'));
    const child = spawn(bin(exe), args, { windowsHide: true, cwd: opts.cwd });
    const chunks: Buffer[] = [];
    let stderr = '';
    let lineBuf = '';
    child.stdout.on('data', (c: Buffer) => {
      if (opts.binary || !opts.onStdoutLine) chunks.push(c);
      if (opts.onStdoutLine) {
        lineBuf += c.toString('utf8');
        const parts = lineBuf.split(/\r?\n/);
        lineBuf = parts.pop() ?? '';
        for (const l of parts) opts.onStdoutLine(l);
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-32_000);
    });
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error('Cancelled'));
      const res = { code: code ?? -1, stdout: Buffer.concat(chunks), stderr };
      if (res.code === 0) return resolve(res);
      log(`${exe} failed (${res.code})`, args.join(' '), stderr.slice(-2000));
      reject(new Error(explain(stderr) || `${exe} exited with code ${res.code}`));
    });
    child.stdin.end();
  });
}

/** Turns the tail of ffmpeg's stderr into one readable sentence. */
function explain(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame|size|video:|audio:|\[out#|Press \[q\])/.test(l));
  if (/Invalid data found when processing input/i.test(stderr)) return 'This file could not be read as audio or video.';
  if (/No such file or directory/i.test(stderr)) return 'The file could not be found.';
  if (/Permission denied/i.test(stderr)) return 'The file is in use or read-only.';
  // The first specific complaint is the cause; ffmpeg follows it with generic knock-on lines
  // ("Terminating thread with return code -22 (Invalid argument)") that tell the user nothing.
  const generic = /Terminating thread|Task finished with error|Nothing was written into output|Error opening output files?\b|Error while (filtering|opening encoder|processing the decoded)|Error reinitializing filters|Error initializing filters|Failed to configure (input|output) pad|Failed to evaluate filter params|Could not open encoder before EOF|Error sending frames to consumers|Conversion failed|Supported sample rates/i;
  const err = lines.find((l) => /error|invalid|failed|cannot|could not|not supported|unable|matches no streams|not divisible|unknown encoder/i.test(l) && !generic.test(l));
  const msg = (err ?? [...lines].reverse().find((l) => !generic.test(l)) ?? lines[lines.length - 1] ?? '').replace(/^(\[[^\]]+\]\s*)+/, '');
  return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
}

export interface FfOptions {
  ctx?: Ctx;
  signal?: AbortSignal;
  /** Output duration in seconds, used to turn out_time into a fraction. */
  duration?: number;
  /** Maps the 0..1 fraction of this run into the job's range [from, to]. */
  range?: [number, number];
  note?: string;
  binary?: boolean;
  /** Working folder, so a filter can name a file there without escaping its full path. */
  cwd?: string;
}

/**
 * Runs ffmpeg with progress reporting. `args` are everything after the global flags.
 * A constant-quality libx264/libx265 encode runs on the graphics card when one is available
 * (Settings → GPU encoding); if that fails for any reason the same job runs again on the CPU.
 */
export async function ffmpeg(args: string[], o: FfOptions = {}): Promise<Buffer> {
  const gpu = await gpuArgsFor(args).catch(() => null);
  if (gpu) {
    try {
      return await runFfmpeg(gpu, o);
    } catch (e) {
      if ((o.signal ?? o.ctx?.signal)?.aborted) throw e;
      log('GPU encode failed; encoding on the CPU instead', e);
    }
  }
  return runFfmpeg(args, o);
}

async function runFfmpeg(args: string[], o: FfOptions): Promise<Buffer> {
  const [from, to] = o.range ?? [0, 1];
  const dur = o.duration && o.duration > 0 ? o.duration : 0;
  let last = -1;
  const report = (f: number) => {
    if (!o.ctx) return;
    const v = from + (to - from) * Math.min(1, Math.max(0, f));
    if (v - last < 0.004 && f < 1) return;
    last = v;
    o.ctx.progress(v, o.note);
  };
  report(0);
  const full = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...(o.binary ? [] : ['-progress', 'pipe:1', '-nostats']), ...args];
  const res = await spawnTool('ffmpeg', full, {
    signal: o.signal ?? o.ctx?.signal,
    binary: o.binary,
    cwd: o.cwd,
    onStdoutLine: o.binary
      ? undefined
      : (line) => {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m && dur) report(Number(m[1]) / 1e6 / dur);
          else if (line === 'progress=end') report(1);
        },
  }).catch((e) => {
    // A failed or cancelled run must not leave a half-written file behind (the output is always last).
    const last = full[full.length - 1];
    if (/^([a-z]:)?[\\/]/i.test(last)) rmSync(last, { force: true });
    throw e;
  });
  report(1);
  return res.stdout;
}

/** ffmpeg run that also returns stderr (used for analysis filters that print to the log). */
export async function ffmpegAnalyze(args: string[], o: FfOptions = {}): Promise<string> {
  const [from, to] = o.range ?? [0, 1];
  const dur = o.duration ?? 0;
  const full = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'info', '-progress', 'pipe:1', '-nostats', ...args];
  const res = await spawnTool('ffmpeg', full, {
    signal: o.signal ?? o.ctx?.signal,
    onStdoutLine: (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && dur && o.ctx) o.ctx.progress(from + (to - from) * Math.min(1, Number(m[1]) / 1e6 / dur), o.note);
    },
  });
  return res.stderr;
}

// ------------------------------------------------------------------- probing

export interface MediaInfo {
  duration: number;
  /** Display size (rotation applied). 0 when there is no video. */
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  vcodec: string;
  acodec: string;
  sampleRate: number;
  channels: number;
  /** Display rotation of the video in degrees (0, 90, 180 or 270). */
  rotation: number;
  /** Container format name(s) from ffprobe, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  format: string;
  bitrate: number;
  audioBitrate: number;
  startTime: number;
}

const probeCache = new Map<string, { key: string; info: MediaInfo }>();

export async function probe(path: string, signal?: AbortSignal): Promise<MediaInfo> {
  const { statSync } = await import('node:fs');
  let key = '';
  try {
    const s = statSync(path);
    key = `${s.size}:${s.mtimeMs}`;
    const hit = probeCache.get(path);
    if (hit && hit.key === key) return hit.info;
  } catch {
    throw new UserError('The file could not be found.');
  }
  const res = await spawnTool(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { signal, binary: true },
  ).catch(() => {
    throw new UserError(`${path.split(/[\\/]/).pop()} could not be read as audio or video.`);
  });
  const j = JSON.parse(res.stdout.toString('utf8') || '{}');
  const streams: any[] = j.streams ?? [];
  // Attached pictures (album art) are "video" streams; ignore them.
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const rate = (r?: string) => {
    if (!r) return 0;
    const [n, d] = r.split('/').map(Number);
    return d ? n / d : n || 0;
  };
  let width = v ? Number(v.width) || 0 : 0;
  let height = v ? Number(v.height) || 0 : 0;
  const rot = (((Math.round(Number(v?.side_data_list?.find((x: any) => x.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0) / 90) * 90) % 360) + 360) % 360;
  if (rot === 90 || rot === 270) [width, height] = [height, width];
  let fps = rate(v?.avg_frame_rate);
  if (!fps || fps > 240) fps = rate(v?.r_frame_rate);
  if (!fps || fps > 240) fps = 30;
  const duration =
    Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0;
  const info: MediaInfo = {
    duration,
    width,
    height,
    fps: v ? fps : 0,
    hasVideo: !!v,
    hasAudio: !!a,
    vcodec: v?.codec_name ?? '',
    acodec: a?.codec_name ?? '',
    sampleRate: Number(a?.sample_rate) || 0,
    channels: Number(a?.channels) || 0,
    rotation: v ? rot : 0,
    format: j.format?.format_name ?? '',
    bitrate: Number(j.format?.bit_rate) || 0,
    audioBitrate: Number(a?.bit_rate) || 0,
    startTime: Number(j.format?.start_time) || 0,
  };
  if (!info.hasVideo && !info.hasAudio) throw new UserError(`${path.split(/[\\/]/).pop()} has no audio or video.`);
  probeCache.set(path, { key, info });
  return info;
}

// ------------------------------------------------------------- codec choices

export const extOf = (p: string) => (/\.([^.\\/]+)$/.exec(p)?.[1] ?? '').toLowerCase();

/** Containers we write video into with H.264 + AAC as-is. Everything else becomes MP4. */
const H264_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'mkv']);

/** Extension to use for a re-encoded video made from `input`. */
export function videoOutExt(input: string): string {
  const e = extOf(input);
  return H264_CONTAINERS.has(e) ? e : 'mp4';
}

/** Standard high-quality H.264 settings for tool output. */
export function x264(crf = 18, preset = 'fast'): string[] {
  return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p'];
}

const MP4ISH = new Set(['mp4', 'm4v', 'mov', '3gp']);

/** Audio args when re-encoding audio into a video container of extension `ext`. */
export function videoAudioArgs(ext: string, kbps = 192): string[] {
  if (ext === 'webm') return ['-c:a', 'libopus', '-b:a', `${Math.min(kbps, 192)}k`];
  return ['-c:a', 'aac', '-b:a', `${kbps}k`];
}

/** Can this audio codec be stream-copied into a container with extension `ext`? */
export function audioCopyOk(ext: string, acodec: string): boolean {
  if (MP4ISH.has(ext)) return ['aac', 'mp3', 'alac', 'ac3', 'eac3'].includes(acodec);
  if (ext === 'mkv') return true;
  if (ext === 'webm') return ['opus', 'vorbis'].includes(acodec);
  return false;
}

/** Container/extension to write an audio-only result for `input` (keeps the format when we can encode it). */
export function audioOutExt(input: string): string {
  const e = extOf(input);
  const ok = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'wma', 'alac'];
  if (ok.includes(e)) return e === 'alac' ? 'm4a' : e;
  return 'm4a';
}

/**
 * Encoder args for an audio file with extension `ext`. `info` (source) keeps lossless sources
 * lossless and lets lossy output roughly match the source bitrate.
 */
export function audioEncodeArgs(ext: string, info?: Partial<MediaInfo>): string[] {
  const srcK = Math.round((info?.audioBitrate || info?.bitrate || 0) / 1000);
  const k = (lo: number, hi: number, def: number) => `${Math.min(hi, Math.max(lo, srcK || def))}k`;
  switch (ext) {
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', k(128, 320, 192)];
    case 'm4a':
      if (info?.acodec === 'alac') return ['-c:a', 'alac'];
      return ['-c:a', 'aac', '-b:a', k(128, 320, 192)];
    case 'aac':
      return ['-c:a', 'aac', '-b:a', k(128, 320, 192), '-f', 'adts'];
    case 'wav': {
      const pcm = /^pcm_(s24|s32|f32|f64)/.test(info?.acodec ?? '') ? 'pcm_s24le' : 'pcm_s16le';
      return ['-c:a', pcm];
    }
    case 'flac':
      return ['-c:a', 'flac'];
    case 'aif':
    case 'aiff':
      return ['-c:a', /s24/.test(info?.acodec ?? '') ? 'pcm_s24be' : 'pcm_s16be', '-f', 'aiff'];
    case 'ogg':
    case 'oga':
      if (info?.acodec === 'opus') return ['-c:a', 'libopus', '-b:a', k(64, 256, 128)];
      return ['-c:a', 'libvorbis', '-q:a', '6'];
    case 'opus':
      return ['-c:a', 'libopus', '-b:a', k(64, 256, 128)];
    case 'wma':
      return ['-c:a', 'wmav2', '-b:a', k(128, 256, 192)];
    default:
      return ['-c:a', 'aac', '-b:a', '192k'];
  }
}

/** Opus only runs at 48 kHz (and a few lower rates); everything else keeps the source rate. */
export function sampleRateArgs(ext: string, sr: number): string[] {
  if (!sr) return [];
  if (ext === 'opus' || ext === 'webm') return ['-ar', '48000'];
  // MP3 (also inside AVI) and WMA stop at 48 kHz.
  if (['wma', 'mp3', 'avi'].includes(ext) && sr > 48000) return ['-ar', '48000'];
  return ['-ar', String(sr)];
}

// ------------------------------------------------------------------- helpers

/** Seconds with millisecond precision for ffmpeg args. */
export const ts = (s: number) => Math.max(0, s).toFixed(3);

export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Runs `fn` over items with limited parallelism, preserving result order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Combines progress of several sequential steps: step(i) maps 0..1 into the i-th slice. */
export function slices(n: number) {
  return (i: number): [number, number] => [i / n, (i + 1) / n];
}

export function stemOf(p: string) {
  const b = p.split(/[\\/]/).pop() ?? p;
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}
