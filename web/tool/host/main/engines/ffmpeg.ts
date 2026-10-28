// ffmpeg / ffprobe helpers shared by every audio/video converter and tool.
//
//   const info = await probe(input, ctx.signal);
//   await ffmpeg(['-i', input, '-c:v', 'libx264', out], { ctx, duration: info.duration });
//
// `ffmpeg()` adds the boilerplate flags (-hide_banner -nostdin -y, quiet logging, machine-readable progress)
// and turns ffmpeg's progress into ctx.progress(0..1). Errors reject with ffmpeg's last error line.
import { spawn } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from './run';
import { UserError, type Ctx } from '../ops/types';
import { bin } from '../paths';
import { settings } from '../settings';
import { log } from '../log';

export interface StreamInfo {
  /** Absolute stream index in the file (use with `-map 0:<index>`). */
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment';
  /** ffmpeg codec name, e.g. "h264", "hevc", "aac", "subrip". */
  codec: string;
  profile?: string;
  /** Video only. Coded size, before rotation. */
  width?: number;
  height?: number;
  /** Video only. Average frame rate (falls back to r_frame_rate). */
  fps?: number;
  pixFmt?: string;
  /** Video only. Display rotation in degrees (0, 90, 180, 270) from the display matrix / rotate tag. */
  rotation?: number;
  /** Audio only. */
  channels?: number;
  sampleRate?: number;
  sampleFmt?: string;
  /** Bits per sample for lossless/PCM audio when known (16, 24, 32). */
  bitDepth?: number;
  bitRate?: number;
  language?: string;
  /** True for embedded cover art (a "video" stream that is really one picture). */
  isCover: boolean;
  /** Raw ffprobe stream object for anything not covered above. */
  raw: any;
}

export interface ProbeInfo {
  /** ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm". */
  format: string;
  /** Seconds; 0 when unknown (e.g. some live streams). */
  duration: number;
  size: number;
  bitRate: number;
  tags: Record<string, string>;
  streams: StreamInfo[];
  /** First real video stream (cover art excluded). */
  video?: StreamInfo;
  /** First audio stream. */
  audio?: StreamInfo;
  /** All audio streams in file order. */
  audios: StreamInfo[];
  subtitles: StreamInfo[];
  /** Embedded cover art, if any. */
  cover?: StreamInfo;
}

const num = (v: any): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function rate(r?: string): number | undefined {
  if (!r) return undefined;
  const [a, b] = r.split('/').map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) && v > 0 && v < 1000 ? v : undefined;
}

/** Clockwise degrees a player turns the picture (iPhone portrait clips report 90). */
function rotationOf(s: any): number {
  let cw = num(s.tags?.rotate) ?? 0;
  for (const sd of s.side_data_list ?? []) if (sd.rotation !== undefined) cw = -Number(sd.rotation);
  return (((Math.round(cw / 90) * 90) % 360) + 360) % 360;
}

/** Read container + stream facts with ffprobe. Throws a readable error for unreadable files. */
export async function probe(path: string, signal?: AbortSignal): Promise<ProbeInfo> {
  let res: RunResult;
  try {
    res = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { signal });
  } catch (e: any) {
    if (signal?.aborted) throw e;
    // ffprobe's own message names the full path; keep the HUD text short. run() has logged the details.
    throw new UserError("This file can't be read as audio or video. It may be damaged or incomplete.");
  }
  const j = JSON.parse(res.stdout || '{}');
  const streams: StreamInfo[] = (j.streams ?? []).map((s: any) => {
    const type = s.codec_type as StreamInfo['type'];
    const isCover = type === 'video' && s.disposition?.attached_pic === 1;
    const st: StreamInfo = {
      index: s.index,
      type,
      codec: s.codec_name ?? 'unknown',
      profile: s.profile,
      bitRate: num(s.bit_rate),
      language: s.tags?.language,
      isCover: !!isCover,
      raw: s,
    };
    if (type === 'video') {
      st.width = s.width;
      st.height = s.height;
      st.fps = rate(s.avg_frame_rate) ?? rate(s.r_frame_rate);
      st.pixFmt = s.pix_fmt;
      st.rotation = rotationOf(s);
    } else if (type === 'audio') {
      st.channels = s.channels;
      st.sampleRate = num(s.sample_rate);
      st.sampleFmt = s.sample_fmt;
      st.bitDepth = num(s.bits_per_raw_sample) || num(s.bits_per_sample) || undefined;
    }
    return st;
  });
  const fmt = j.format ?? {};
  let duration = num(fmt.duration) ?? 0;
  if (!duration) duration = Math.max(0, ...streams.map((s) => num(s.raw.duration) ?? 0));
  const audios = streams.filter((s) => s.type === 'audio');
  return {
    format: fmt.format_name ?? '',
    duration,
    size: num(fmt.size) ?? 0,
    bitRate: num(fmt.bit_rate) ?? 0,
    tags: fmt.tags ?? {},
    streams,
    video: streams.find((s) => s.type === 'video' && !s.isCover),
    audio: audios[0],
    audios,
    subtitles: streams.filter((s) => s.type === 'subtitle'),
    cover: streams.find((s) => s.isCover),
  };
}

export interface FfmpegOptions {
  /** Progress + cancel come from here. */
  ctx?: Pick<Ctx, 'progress' | 'signal'>;
  /** Used instead of ctx.signal when there is no ctx. */
  signal?: AbortSignal;
  /** Seconds of OUTPUT expected; needed to turn ffmpeg's clock into a fraction. Omit for no progress. */
  duration?: number;
  /**
   * Map this run onto part of the overall bar, e.g. a two-pass job uses [0, 0.5] then [0.5, 1].
   * Default [0, 1].
   */
  range?: [number, number];
  /** Optional note shown in the HUD with the progress. */
  note?: string;
  /** Every stderr line (warnings/errors; loglevel is "error" unless you pass your own -loglevel). */
  onStderr?: (line: string) => void;
  /** Bytes for stdin (use with `-i pipe:0`). */
  input?: Buffer;
}

/**
 * Run the bundled ffmpeg. `args` are the normal ffmpeg arguments (inputs, filters, codecs, output);
 * this adds `-hide_banner -nostdin -y -loglevel error -progress pipe:1 -nostats` in front.
 * Resolves when ffmpeg exits 0; rejects with its last error line (or "Cancelled").
 */
export async function ffmpeg(args: string[], opts: FfmpegOptions = {}): Promise<RunResult> {
  const { ctx, duration, note } = opts;
  const [lo, hi] = opts.range ?? [0, 1];
  const signal = ctx?.signal ?? opts.signal;
  const pre = ['-hide_banner', ...(opts.input ? [] : ['-nostdin']), '-y'];
  if (!args.includes('-loglevel') && !args.includes('-v')) pre.push('-loglevel', 'error');
  pre.push('-progress', 'pipe:1', '-nostats');
  let last = -1;
  const report = (f: number) => {
    if (!ctx) return;
    const v = lo + (hi - lo) * Math.min(1, Math.max(0, f));
    if (v - last < 0.005 && f < 1) return;
    last = v;
    ctx.progress(v, note);
  };
  const res = await run('ffmpeg', [...pre, ...args], {
    signal,
    input: opts.input,
    onLine(line, stream) {
      if (stream === 'stderr') return opts.onStderr?.(line);
      if (!duration || duration <= 0) {
        if (line === 'progress=end') report(1);
        return;
      }
      // out_time_us is the position in the output; out_time_ms is (despite its name) also microseconds.
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m) report(Number(m[1]) / 1e6 / duration);
      else if (line === 'progress=end') report(1);
    },
  });
  report(1);
  return res;
}

/** "00:01:02.500" style timestamp for -ss/-to from seconds. */
export function ts(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
}

// ------------------------------------------------------------------ GPU encoders

export type GpuCodec = 'h264' | 'hevc';

/** Hardware encoders in order of preference: NVIDIA NVENC, Intel Quick Sync, AMD AMF. */
const GPU_CANDIDATES: Record<GpuCodec, string[]> = {
  h264: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
  hevc: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf'],
};

/**
 * Encoder settings for a hardware encoder at roughly the same visual quality as libx264/libx265 at
 * `crf` (constant-quality modes throughout; the hardware scales run one step above x264's CRF).
 */
export function gpuQualityArgs(encoder: string, crf: number): string[] {
  const q = String(Math.min(51, Math.max(1, Math.round(crf) + 1)));
  if (encoder.endsWith('_nvenc')) return ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', q, '-b:v', '0'];
  if (encoder.endsWith('_qsv')) return ['-preset', 'medium', '-global_quality', q];
  if (encoder.endsWith('_amf')) return ['-quality', 'quality', '-rc', 'qvbr', '-qvbr_quality_level', q];
  return [];
}

/** Pixel format to hand a hardware encoder for 8-bit 4:2:0 output (Quick Sync wants NV12). */
export function gpuPixFmt(encoder: string): string {
  return encoder.endsWith('_qsv') ? 'nv12' : 'yuv420p';
}

let gpuDetection: Promise<Record<GpuCodec, string | null>> | null = null;

/**
 * A one-second test encode with the same quality settings real jobs use; true when it produced a file.
 * Spawned directly rather than through run(): a missing driver is the normal case and shouldn't fill
 * the log with ffmpeg errors.
 */
function gpuWorks(encoder: string): Promise<boolean> {
  const out = join(tmpdir(), `orange-gpu-probe-${process.pid}-${encoder}.mp4`);
  const args = [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1',
    '-c:v', encoder, ...gpuQualityArgs(encoder, 20), '-pix_fmt', gpuPixFmt(encoder),
    '-f', 'mp4', out,
  ];
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      let made = false;
      try {
        made = ok && statSync(out).size > 0;
      } catch {
        /* no file */
      }
      rmSync(out, { force: true });
      resolve(made);
    };
    const child = spawn(bin('ffmpeg'), args, { windowsHide: true, stdio: 'ignore' });
    // A wedged driver must not hold up every video job.
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0));
  });
}

/**
 * Finds the working hardware encoders once per run (all candidates are tried in parallel; a missing
 * driver fails in well under a second) and caches the answer.
 */
export function detectGpuEncoders(): Promise<Record<GpuCodec, string | null>> {
  if (!gpuDetection) {
    gpuDetection = (async () => {
      const started = Date.now();
      const pick = async (codec: GpuCodec) => {
        const ok = await Promise.all(GPU_CANDIDATES[codec].map(gpuWorks));
        return GPU_CANDIDATES[codec].find((_, i) => ok[i]) ?? null;
      };
      const [h264, hevc] = await Promise.all([pick('h264'), pick('hevc')]);
      log(`GPU video encoders: h264=${h264 ?? 'none'} hevc=${hevc ?? 'none'} (checked in ${Date.now() - started} ms)`);
      return { h264, hevc };
    })().catch((e) => {
      log('GPU encoder detection failed', e);
      return { h264: null, hevc: null };
    });
  }
  return gpuDetection;
}

/**
 * The hardware encoder to use for `codec` ("h264_nvenc", "h264_qsv", "h264_amf", or the hevc_ ones),
 * or null when there is none or Settings turned GPU encoding off. Detection runs once and is cached.
 */
export async function gpuEncoder(codec: GpuCodec = 'h264'): Promise<string | null> {
  if (settings.get().gpuEncode === 'off') return null;
  return (await detectGpuEncoders())[codec];
}

/**
 * Rewrites a constant-quality libx264/libx265 command line (`-c:v libx264 … -crf N`) for the GPU
 * encoder, or returns null when it doesn't apply: no GPU encoder, GPU encoding off, bitrate-targeted
 * or two-pass encodes (the CPU encoders spend bits better there), lossless, or encoder-private options.
 */
export async function gpuArgsFor(args: string[]): Promise<string[] | null> {
  const ci = args.findIndex((a, i) => (a === '-c:v' || a === '-vcodec') && /^libx26[45]$/.test(args[i + 1] ?? ''));
  if (ci < 0) return null;
  if (args.filter((a) => a === '-c:v' || a === '-vcodec').length !== 1) return null;
  const crfAt = args.indexOf('-crf');
  const crf = crfAt >= 0 ? Number(args[crfAt + 1]) : NaN;
  if (!Number.isFinite(crf) || crf <= 0) return null;
  if (args.some((a) => /^-(b:v|pass|passlogfile|qp|x264-params|x264opts|x265-params)$/.test(a))) return null;
  // Throwaway previews at ultrafast/superfast are already cheap on the CPU; a GPU session costs more to open.
  const presetAt = args.indexOf('-preset');
  if (presetAt >= 0 && /^(ultrafast|superfast)$/.test(args[presetAt + 1] ?? '')) return null;
  const encoder = await gpuEncoder(args[ci + 1] === 'libx265' ? 'hevc' : 'h264');
  if (!encoder) return null;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (i === ci) {
      out.push('-c:v', encoder, ...gpuQualityArgs(encoder, crf));
      i++;
    } else if (a === '-crf' || a === '-preset' || a === '-tune') i++; // x264/x265 vocabulary; replaced above
    else if (a === '-pix_fmt' && args[i + 1] === 'yuv420p') {
      out.push(a, gpuPixFmt(encoder));
      i++;
    } else out.push(a);
  }
  return out;
}

// Look for a hardware encoder in the background shortly after start-up, so the first video job
// doesn't wait for it.
setTimeout(() => {
  if (settings.get().gpuEncode !== 'off') void detectGpuEncoders();
}, 20_000).unref?.();
