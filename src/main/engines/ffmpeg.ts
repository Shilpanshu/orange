// ffmpeg / ffprobe helpers shared by every audio/video converter and tool.
//
//   const info = await probe(input, ctx.signal);
//   await ffmpeg(['-i', input, '-c:v', 'libx264', out], { ctx, duration: info.duration });
//
// `ffmpeg()` adds the boilerplate flags (-hide_banner -nostdin -y, quiet logging, machine-readable progress)
// and turns ffmpeg's progress into ctx.progress(0..1). Errors reject with ffmpeg's last error line.
import { run, type RunResult } from './run';
import { UserError, type Ctx } from '../ops/types';

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
