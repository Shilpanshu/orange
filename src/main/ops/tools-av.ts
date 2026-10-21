// Video and audio tools. Windows gather options; everything is processed here with ffmpeg.
// Also registers the media IPC the tool windows use for previews (probe, proxy, waveform, thumbs,
// keyframes, loudness).
import { app, ipcMain } from 'electron';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Ctx, ToolFn } from './types';
import { UserError } from './types';
import {
  audioCopyOk,
  audioEncodeArgs,
  audioOutExt,
  even,
  extOf,
  ffmpeg,
  ffmpegAnalyze,
  pool,
  probe,
  sampleRateArgs,
  slices,
  stemOf,
  ts,
  videoAudioArgs,
  videoOutExt,
  x264,
  type MediaInfo,
} from './av-util';
import { log } from '../log';

// =================================================================== preview IPC

const NATIVE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);
const NATIVE_VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
const NATIVE_AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'webm', 'mp4']);

function playable(path: string, info: MediaInfo): boolean {
  const ext = extOf(path);
  if (info.hasAudio && !NATIVE_AUDIO.has(info.acodec)) return false;
  if (info.hasVideo) return NATIVE_VIDEO_EXT.has(ext) && NATIVE_VIDEO.has(info.vcodec);
  return NATIVE_AUDIO_EXT.has(ext);
}

let cacheDir = '';
const cache = () => (cacheDir ||= mkdtempSync(join(tmpdir(), 'orange-av-')));
const fileKey = (p: string) => {
  const s = statSync(p);
  return `${p}|${s.size}|${s.mtimeMs}`;
};
const proxies = new Map<string, Promise<string>>();
// Preview proxies live for the session only.
app?.on?.('will-quit', () => {
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

/** A path Chromium can play for `path`: the file itself, or a fast low-res H.264/AAC proxy. */
async function previewPath(path: string, force: boolean, onProgress?: (f: number) => void): Promise<string> {
  const info = await probe(path);
  if (!force && playable(path, info)) return path;
  const key = fileKey(path);
  let job = proxies.get(key);
  if (!job) {
    const out = join(cache(), `proxy-${proxies.size}-${Date.now()}.${info.hasVideo ? 'mp4' : 'm4a'}`);
    const args = info.hasVideo
      ? [
          '-i', path, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
          // Downscale only; short GOP keeps scrubbing snappy.
          '-vf', `scale=-2:'min(540,ih)':flags=fast_bilinear,format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '26', '-g', '12',
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', out,
        ]
      : ['-i', path, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out];
    job = ffmpeg(args, {
      duration: info.duration,
      ctx: onProgress ? ({ progress: (f: number) => onProgress(f), signal: new AbortController().signal } as any) : undefined,
    }).then(() => out);
    proxies.set(key, job);
    job.catch(() => proxies.delete(key));
  }
  return job;
}

const waveCache = new Map<string, number[]>();

/** Peak envelope of the first audio stream: `buckets` values in 0..1 (full scale). */
async function waveform(path: string, buckets: number, channel?: number): Promise<number[]> {
  const key = `${fileKey(path)}|${buckets}|${channel ?? 'mix'}`;
  const hit = waveCache.get(key);
  if (hit) return hit;
  const info = await probe(path);
  if (!info.hasAudio) return new Array(buckets).fill(0);
  // Keep the PCM buffer bounded (~16M samples) for very long recordings.
  const rate = Math.max(1000, Math.min(8000, Math.floor(16_000_000 / Math.max(1, info.duration))));
  const mix = channel === 0 || channel === 1 ? ['-af', `aformat=channel_layouts=stereo,pan=mono|c0=c${channel}`] : ['-ac', '1'];
  const pcm = await ffmpeg(['-i', path, '-map', '0:a:0', '-vn', ...mix, '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], {
    binary: true,
  });
  const n = Math.floor(pcm.length / 2);
  const peaks = new Array(buckets).fill(0);
  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.min(n, Math.max(s + 1, Math.floor((b + 1) * per)));
    let m = 0;
    for (let i = s; i < e; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > m) m = v;
    }
    peaks[b] = m / 32768;
  }
  waveCache.set(key, peaks);
  return peaks;
}

const thumbCache = new Map<string, string>();

async function thumbAt(path: string, t: number, height: number): Promise<string> {
  const key = `${fileKey(path)}|${t.toFixed(2)}|${height}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const grab = (at: number) =>
    ffmpeg(['-ss', ts(at), '-i', path, '-map', '0:v:0', '-an', '-sn', '-frames:v', '1', '-vf', `scale=-2:${height}`, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], {
      binary: true,
    });
  let buf = await grab(t).catch(() => Buffer.alloc(0));
  if (!buf.length && t > 0.5) buf = await grab(Math.max(0, t - 1)).catch(() => Buffer.alloc(0));
  const url = buf.length ? `data:image/jpeg;base64,${buf.toString('base64')}` : '';
  if (url) thumbCache.set(key, url);
  return url;
}

const keyframeCache = new Map<string, number[]>();

/** Keyframe times (seconds from the start) of the first video stream, read from packets (no decoding). */
async function keyframes(path: string): Promise<number[]> {
  const key = fileKey(path);
  const hit = keyframeCache.get(key);
  if (hit) return hit;
  const info = await probe(path);
  if (!info.hasVideo) return [];
  const { spawn } = await import('node:child_process');
  const { bin } = await import('../paths');
  const out: number[] = await new Promise((resolve) => {
    const child = spawn(bin('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path], { windowsHide: true });
    const list: number[] = [];
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const [t, flags] = l.split(',');
        if (flags?.includes('K') && t !== 'N/A') list.push(Number(t) - info.startTime);
      }
    });
    child.on('close', () => resolve(list.sort((a, b) => a - b)));
    child.on('error', () => resolve([]));
  });
  keyframeCache.set(key, out);
  return out;
}

export interface Loudness {
  I: number;
  TP: number;
  LRA: number;
  thresh: number;
  offset: number;
}
const loudCache = new Map<string, { target: string; r: Loudness }>();

/** EBU R128 analysis (loudnorm pass 1) of the first audio stream. */
async function measureLoudness(path: string, target: { I: number; TP: number; LRA: number }, ctx?: Ctx, range?: [number, number]): Promise<Loudness> {
  // Input statistics don't depend on the target; only the small offset does.
  const key = fileKey(path);
  const tkey = `${target.I}|${target.TP}|${target.LRA}`;
  const hit = loudCache.get(key);
  if (hit) return hit.target === tkey ? hit.r : { ...hit.r, offset: 0 };
  const info = await probe(path);
  if (!info.hasAudio) throw new UserError(`${path.split(/[\\/]/).pop()} has no audio.`);
  const stderr = await ffmpegAnalyze(
    ['-i', path, '-map', '0:a:0', '-vn', '-sn', '-af', `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}:print_format=json`, '-f', 'null', '-'],
    { ctx, duration: info.duration, range, note: 'Measuring loudness' },
  );
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr);
  if (!m) throw new Error('Loudness analysis failed.');
  const j = JSON.parse(m[0]);
  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : -70);
  const r: Loudness = { I: num(j.input_i), TP: num(j.input_tp), LRA: Math.max(0, num(j.input_lra)), thresh: num(j.input_thresh), offset: Number(j.target_offset) || 0 };
  loudCache.set(key, { target: tkey, r });
  return r;
}

ipcMain.handle('av:probe', (_e, path: string) => probe(path));
ipcMain.handle('av:preview', async (e, path: string, force = false) => {
  const p = await previewPath(path, !!force, (f) => {
    if (!e.sender.isDestroyed()) e.sender.send('av:preview-progress', path, f);
  });
  return { url: pathToFileURL(p).href, proxy: p !== path };
});
ipcMain.handle('av:waveform', (_e, path: string, buckets = 1000, channel?: number) =>
  waveform(path, Math.max(16, Math.min(20000, Math.round(buckets))), channel === 0 || channel === 1 ? channel : undefined),
);
ipcMain.handle('av:thumbs', async (_e, path: string, count = 10, height = 72) => {
  const info = await probe(path);
  if (!info.hasVideo) return [];
  const n = Math.max(1, Math.min(60, Math.round(count)));
  const times = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * info.duration);
  return pool(times, 4, (t) => thumbAt(path, t, Math.round(height)));
});
ipcMain.handle('av:thumb', (_e, path: string, t: number, height = 72) => thumbAt(path, t, Math.round(height)));
ipcMain.handle('av:keyframes', (_e, path: string) => keyframes(path));
ipcMain.handle('av:loudness', (_e, path: string, target: { I: number; TP: number; LRA: number }) => measureLoudness(path, target));

// ======================================================================== tools

const faststart = (ext: string) => (['mp4', 'm4v', 'mov'].includes(ext) ? ['-movflags', '+faststart'] : []);

/** Audio args for a video re-encode: copy when the container takes the codec, else encode. */
function videoAudio(info: MediaInfo, ext: string): string[] {
  if (!info.hasAudio) return ['-an'];
  return audioCopyOk(ext, info.acodec) ? ['-c:a', 'copy'] : videoAudioArgs(ext);
}

/** Audio encoder for re-encoding the audio of a video file while copying the video. */
function audioForVideoContainer(ext: string): string[] {
  if (['mp4', 'm4v', 'mov', '3gp', 'mkv', 'flv', 'ts', 'mts'].includes(ext)) return ['-c:a', 'aac', '-b:a', '192k'];
  if (ext === 'webm') return ['-c:a', 'libopus', '-b:a', '160k'];
  if (ext === 'wmv') return ['-c:a', 'wmav2', '-b:a', '192k'];
  if (ext === 'avi') return ['-c:a', 'libmp3lame', '-b:a', '192k'];
  if (ext === 'mpg' || ext === 'mpeg') return ['-c:a', 'mp2', '-b:a', '224k'];
  return ['-c:a', 'aac', '-b:a', '192k'];
}

function num(v: any, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clampRange(info: MediaInfo, start: any, end: any): [number, number] {
  const s = Math.max(0, Math.min(info.duration, num(start, 0)));
  const e = Math.max(0, Math.min(info.duration, num(end, info.duration)));
  if (e - s < 0.04) throw new UserError('The selection is too short.');
  return [s, e];
}

// ------------------------------------------------------------------ trimVideo

async function nearKeyframe(path: string, t: number, fps: number): Promise<boolean> {
  if (t < 0.5 / (fps || 30)) return true;
  const kf = await keyframes(path);
  return kf.some((k) => Math.abs(k - t) <= 0.5 / (fps || 30));
}

const trimVideo: ToolFn = async ([input], ctx) => {
  const o = ctx.options ?? {};
  const info = await probe(input, ctx.signal);
  const [s, e] = clampRange(info, o.start, o.end);
  const dur = e - s;
  // Stream copy is lossless and instant; it is exact when the start sits on a keyframe.
  const copy = o.mode === 'fast' || (await nearKeyframe(input, s, info.fps));
  if (copy) {
    const ext = extOf(input) || 'mp4';
    const out = ctx.out(input, ext, ' trimmed');
    await ffmpeg(
      ['-ss', ts(s), '-i', input, '-t', ts(dur), '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-map_metadata', '0', ...faststart(ext), out],
      { ctx, duration: dur, note: 'Trimming (no re-encode)' },
    );
    return [out];
  }
  const ext = videoOutExt(input);
  const out = ctx.out(input, ext, ' trimmed');
  await ffmpeg(
    ['-ss', ts(s), '-i', input, '-t', ts(dur), '-map', '0:v:0', '-map', '0:a:0?', ...x264(18, 'fast'), ...(info.hasAudio ? videoAudioArgs(ext) : ['-an']), '-map_metadata', '0', ...faststart(ext), out],
    { ctx, duration: dur, note: 'Trimming' },
  );
  return [out];
};

// ------------------------------------------------------------------ cropVideo

const cropVideo: ToolFn = async ([input], ctx) => {
  const o = ctx.options ?? {};
  const info = await probe(input, ctx.signal);
  if (!info.hasVideo) throw new UserError('This file has no video.');
  const W = info.width;
  const H = info.height;
  let w = Math.min(W, even(num(o.w, W)));
  let h = Math.min(H, even(num(o.h, H)));
  const x = Math.max(0, Math.min(W - w, Math.round(num(o.x, 0))));
  const y = Math.max(0, Math.min(H - h, Math.round(num(o.y, 0))));
  if (w < 16 || h < 16) throw new UserError('The crop area is too small.');
  const vf = [`crop=${w}:${h}:${x}:${y}`];
  const ow = o.outW ? even(num(o.outW, w)) : 0;
  const oh = o.outH ? even(num(o.outH, h)) : 0;
  if (ow && oh && (ow !== w || oh !== h)) vf.push(`scale=${ow}:${oh}:flags=lanczos`);
  vf.push('setsar=1');
  const ext = videoOutExt(input);
  const out = ctx.out(input, ext, ' cropped');
  await ffmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a?', '-vf', vf.join(','), ...x264(18, 'fast'), ...videoAudio(info, ext), '-map_metadata', '0', ...faststart(ext), out], {
    ctx,
    duration: info.duration,
    note: 'Cropping',
  });
  return [out];
};

// ----------------------------------------------------------------- speedVideo

/** atempo factors in [0.5, 2] whose product is `speed` (best quality per stage). */
function atempoChain(speed: number): string[] {
  const parts: string[] = [];
  let r = speed;
  while (r > 2) {
    parts.push('atempo=2');
    r /= 2;
  }
  while (r < 0.5) {
    parts.push('atempo=0.5');
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 1e-6 || !parts.length) parts.push(`atempo=${r.toFixed(6)}`);
  return parts;
}

const speedVideo: ToolFn = async ([input], ctx) => {
  const o = ctx.options ?? {};
  const speed = Math.max(0.25, Math.min(4, num(o.speed, 1)));
  if (Math.abs(speed - 1) < 1e-3) throw new UserError('Pick a speed other than 1×.');
  const keepPitch = o.keepPitch !== false;
  const info = await probe(input, ctx.signal);
  const ext = videoOutExt(input);
  const label = `${String(speed).replace(/\.?0+$/, '')}x`;
  const out = ctx.out(input, ext, ` ${label}`);
  const fps = Math.min(60, info.fps || 30);
  const args = ['-i', input];
  const filters = [`[0:v:0]setpts=PTS/${speed},fps=${fps.toFixed(3)}[v]`];
  const withAudio = info.hasAudio && !o.mute;
  if (withAudio) {
    const sr = info.sampleRate || 48000;
    const af = keepPitch ? atempoChain(speed).join(',') : `asetrate=${Math.round(sr * speed)},aresample=${sr}`;
    filters.push(`[0:a:0]${af}[a]`);
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (withAudio) args.push('-map', '[a]', ...videoAudioArgs(ext));
  else args.push('-an');
  args.push(...x264(18, 'fast'), ...faststart(ext), out);
  await ffmpeg(args, { ctx, duration: info.duration / speed, note: `Changing speed to ${label}` });
  return [out];
};

// ----------------------------------------------------------------- joinVideos

const joinVideos: ToolFn = async (inputs, ctx) => {
  if (inputs.length < 2) throw new UserError('Choose at least two videos to join.');
  const infos = await Promise.all(inputs.map((p) => probe(p, ctx.signal)));
  infos.forEach((inf, i) => {
    if (!inf.hasVideo) throw new UserError(`${inputs[i].split(/[\\/]/).pop()} has no video.`);
  });
  const first = infos[0];
  const total = infos.reduce((a, b) => a + b.duration, 0);
  const out = ctx.out(inputs[0], 'mp4', ' joined');

  // Fast path: identical H.264/AAC MP4-family clips concatenate losslessly.
  const same = infos.every(
    (x, i) =>
      ['mp4', 'm4v', 'mov'].includes(extOf(inputs[i])) &&
      x.vcodec === first.vcodec &&
      ['h264', 'hevc'].includes(x.vcodec) &&
      x.width === first.width &&
      x.height === first.height &&
      Math.abs(x.fps - first.fps) < 0.01 &&
      x.hasAudio === first.hasAudio &&
      (!x.hasAudio || (x.acodec === 'aac' && x.sampleRate === first.sampleRate && x.channels === first.channels)),
  );
  if (same && ctx.options?.reencode !== true) {
    const list = join(ctx.tmp(), 'list.txt');
    writeFileSync(list, inputs.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    try {
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', out], {
        ctx,
        duration: total,
        note: 'Joining (no re-encode)',
      });
      return [out];
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      log('fast join failed, re-encoding', e);
    }
  }

  // The first clip defines the canvas; others are scaled to fit and letterboxed.
  const W = even(first.width);
  const H = even(first.height);
  const fps = Math.min(60, first.fps || 30);
  const args: string[] = [];
  inputs.forEach((p) => args.push('-i', p));
  let extra = inputs.length;
  const parts: string[] = [];
  const labels: string[] = [];
  infos.forEach((inf, i) => {
    parts.push(
      `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps.toFixed(3)},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`,
    );
    let a: string;
    if (inf.hasAudio) a = `${i}:a:0`;
    else {
      // Silent clips get generated silence of the same length.
      args.push('-f', 'lavfi', '-t', ts(inf.duration), '-i', 'anullsrc=r=48000:cl=stereo');
      a = `${extra++}:a`;
    }
    parts.push(`[${a}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad=whole_dur=${ts(inf.duration)}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${inputs.length}:v=1:a=1[v][a]`);
  args.push('-filter_complex', parts.join(';'), '-map', '[v]', '-map', '[a]', ...x264(20, 'fast'), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out);
  await ffmpeg(args, { ctx, duration: total, note: 'Joining' });
  return [out];
};

// ---------------------------------------------------------------- videoFrames

const stamp = (t: number) => {
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  return `${hh ? String(hh).padStart(2, '0') + '-' : ''}${String(mm).padStart(2, '0')}-${ss.toFixed(3).padStart(6, '0')}`;
};

const videoFrames: ToolFn = async ([input], ctx) => {
  const o = ctx.options ?? {};
  const info = await probe(input, ctx.signal);
  const times: number[] = [...new Set<number>((o.times ?? []).map((t: any) => num(t, -1)).filter((t: number) => t >= 0))].sort((a, b) => a - b);
  if (!times.length) throw new UserError('Add at least one frame.');
  const half = 0.5 / (info.fps || 30);
  const dir = times.length === 1 ? '' : ctx.outDir(input, `${stemOf(input)} frames`);
  let done = 0;
  const outs = await pool(times, 3, async (t) => {
    const out = dir ? join(dir, `${stemOf(input)} ${stamp(t)}.png`) : ctx.out(input, 'png', ` ${stamp(t)}`);
    // Seeking just before the frame's timestamp makes ffmpeg emit exactly that frame.
    await ffmpeg(['-ss', ts(Math.max(0, t - half)), '-i', input, '-map', '0:v:0', '-an', '-sn', '-frames:v', '1', '-update', '1', out], { signal: ctx.signal });
    ctx.progress(++done / times.length, `Saved ${done} of ${times.length}`);
    return out;
  });
  return dir ? [dir] : outs;
};

// ----------------------------------------------------------------- splitVideo

const splitVideo: ToolFn = async ([input], ctx) => {
  const o = ctx.options ?? {};
  const info = await probe(input, ctx.signal);
  let points: number[];
  if (o.parts) {
    const n = Math.max(2, Math.min(100, Math.round(num(o.parts, 2))));
    points = Array.from({ length: n - 1 }, (_, i) => ((i + 1) * info.duration) / n);
  } else points = (o.points ?? []).map((p: any) => num(p, -1));
  points = points.filter((p) => p > 0.05 && p < info.duration - 0.05);
  if (o.mode === 'fast') {
    // Without re-encoding, parts can only start on keyframes: snap each point to the nearest one.
    const kf = await keyframes(input);
    if (kf.length < 2) throw new UserError('This video has too few keyframes to split without re-encoding. Choose Precise.');
    points = points.map((p) => kf.reduce((best, k) => (Math.abs(k - p) < Math.abs(best - p) ? k : best), kf[0])).filter((p) => p > 0.05 && p < info.duration - 0.05);
  }
  points = [...new Set(points.map((p) => Math.round(p * 1000) / 1000))].sort((a, b) => a - b);
  if (!points.length) throw new UserError('Add at least one split point.');
  const bounds = [0, ...points, info.duration];
  const dir = ctx.outDir(input, `${stemOf(input)} parts`);
  const stem = stemOf(input);
  const pad = String(bounds.length - 1).length;

  const ext = o.mode === 'fast' ? extOf(input) || 'mp4' : videoOutExt(input);
  const slice = slices(bounds.length - 1);
  for (let i = 0; i < bounds.length - 1; i++) {
    const s = bounds[i];
    const d = bounds[i + 1] - s;
    const out = join(dir, `${stem} part ${String(i + 1).padStart(Math.max(2, pad), '0')}.${ext}`);
    const enc =
      o.mode === 'fast'
        ? ['-c', 'copy', '-avoid_negative_ts', 'make_zero']
        : [...x264(18, 'fast'), ...(info.hasAudio ? videoAudioArgs(ext) : ['-an'])];
    await ffmpeg(['-ss', ts(s), '-i', input, '-t', ts(d), '-map', '0:v:0', '-map', '0:a:0?', ...enc, ...faststart(ext), out], {
      ctx,
      duration: d,
      range: slice(i),
      note: `Part ${i + 1} of ${bounds.length - 1}`,
    });
  }
  return [dir];
};
// ---------------------------------------------------------------- redactVideo

interface RedactBox {
  x: number;
  y: number;
  w: number;
  h: number;
  start: number;
  end: number;
  style: 'blur' | 'pixelate' | 'solid';
  color?: string;
}

const redactVideo: ToolFn = async ([input], ctx) => {
  const info = await probe(input, ctx.signal);
  if (!info.hasVideo) throw new UserError('This file has no video.');
  const W = info.width;
  const H = info.height;
  const boxes: RedactBox[] = (ctx.options?.boxes ?? []).filter((b: RedactBox) => b && b.w > 1 && b.h > 1);
  if (!boxes.length) throw new UserError('Draw at least one box over the video.');
  const parts: string[] = [];
  let cur = '0:v:0';
  boxes.forEach((b, i) => {
    const w = Math.min(W, even(b.w));
    const h = Math.min(H, even(b.h));
    const x = Math.max(0, Math.min(W - w, Math.round(b.x)));
    const y = Math.max(0, Math.min(H - h, Math.round(b.y)));
    const s = Math.max(0, num(b.start, 0));
    const e = Math.min(info.duration + 1, num(b.end, info.duration + 1));
    const en = `enable='between(t,${s.toFixed(3)},${e.toFixed(3)})'`;
    const next = `r${i}`;
    if (b.style === 'solid') {
      const c = /^#?([0-9a-f]{6})$/i.exec(b.color ?? '')?.[1] ?? '000000';
      parts.push(`[${cur}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0x${c}@1:t=fill:${en}[${next}]`);
    } else {
      const m = Math.min(w, h);
      const fx =
        b.style === 'pixelate'
          ? `scale=${Math.max(1, Math.round(w / Math.max(8, m / 6)))}:${Math.max(1, Math.round(h / Math.max(8, m / 6)))}:flags=area,scale=${w}:${h}:flags=neighbor`
          : `boxblur=luma_radius=${Math.max(1, Math.min(Math.floor(m / 2) - 1, 40))}:luma_power=3:chroma_radius=${Math.max(1, Math.min(Math.floor(m / 4) - 1, 20))}:chroma_power=3`;
      parts.push(`[${cur}]split[m${i}][c${i}]`, `[c${i}]crop=${w}:${h}:${x}:${y},${fx}[f${i}]`, `[m${i}][f${i}]overlay=${x}:${y}:${en}[${next}]`);
    }
    cur = next;
  });
  parts.push(`[${cur}]format=yuv420p[v]`);
  const ext = videoOutExt(input);
  const out = ctx.out(input, ext, ' redacted');
  await ffmpeg(['-i', input, '-filter_complex', parts.join(';'), '-map', '[v]', '-map', '0:a?', ...x264(18, 'fast'), ...videoAudio(info, ext), ...faststart(ext), out], {
    ctx,
    duration: info.duration,
    note: 'Redacting',
  });
  return [out];
};

// ------------------------------------------------------------- normalizeAudio

const normalizeAudio: ToolFn = async (inputs, ctx) => {
  const o = ctx.options ?? {};
  const target = {
    I: Math.max(-70, Math.min(-5, num(o.I, -16))),
    TP: Math.max(-9, Math.min(0, num(o.TP, -1.5))),
    LRA: Math.max(1, Math.min(50, num(o.LRA, 11))),
  };
  const outs: string[] = [];
  const slice = slices(inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const [a, b] = slice(i);
    const mid = a + (b - a) * 0.4;
    const info = await probe(input, ctx.signal);
    if (!info.hasAudio) throw new UserError(`${input.split(/[\\/]/).pop()} has no audio.`);
    const m = await measureLoudness(input, target, ctx, [a, mid]);
    const af =
      `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}` +
      `:measured_I=${m.I}:measured_TP=${m.TP}:measured_LRA=${m.LRA}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true:print_format=summary`;
    const sr = info.sampleRate || 48000;
    let out: string;
    let args: string[];
    if (info.hasVideo) {
      const ext = extOf(input) || 'mp4';
      out = ctx.out(input, ext, ' normalized');
      args = ['-i', input, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', af, ...audioForVideoContainer(ext), ...sampleRateArgs(ext, sr), '-map_metadata', '0', ...faststart(ext), out];
    } else {
      const ext = audioOutExt(input);
      out = ctx.out(input, ext, ' normalized');
      args = ['-i', input, '-map', '0:a:0', '-vn', '-af', af, ...audioEncodeArgs(ext, info), ...sampleRateArgs(ext, sr), '-map_metadata', '0', out];
    }
    await ffmpeg(args, { ctx, duration: info.duration, range: [mid, b], note: inputs.length > 1 ? `Normalizing ${i + 1} of ${inputs.length}` : 'Normalizing' });
    outs.push(out);
  }
  return outs;
};

// --------------------------------------------------------------- audioToVideo

const SIZES: Record<string, [number, number]> = {
  landscape: [1920, 1080],
  portrait: [1080, 1920],
  square: [1080, 1080],
};

const hex = (c: any, def: string) => /^#?([0-9a-f]{6})$/i.exec(String(c ?? ''))?.[1] ?? def;

const audioToVideo: ToolFn = async ([input], ctx) => {
  const o = ctx.options ?? {};
  const info = await probe(input, ctx.signal);
  if (!info.hasAudio) throw new UserError('This file has no audio.');
  const [W, H] = SIZES[o.size] ?? SIZES.landscape;
  const dark = o.theme !== 'light';
  const bg = hex(o.background, dark ? '1a1816' : 'f6f3ef');
  const fg = hex(o.color, 'ee6a1f');
  const out = ctx.out(input, 'mp4', ' video');
  const args: string[] = [];
  let graph: string;
  if (o.style === 'image') {
    if (!o.image || !existsSync(o.image)) throw new UserError('Choose an image for the video.');
    args.push('-loop', '1', '-framerate', '6', '-i', o.image, '-i', input);
    graph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x${bg},setsar=1,format=yuv420p[v]`;
    args.push('-filter_complex', graph, '-map', '[v]', '-map', '1:a:0', ...x264(20, 'veryfast'), '-tune', 'stillimage', '-r', '6');
  } else {
    args.push('-i', input);
    const fps = 30;
    if (o.style === 'bars') {
      // 96 log-spaced frequency bars: showfreqs as a mask, quantised to columns, gaps cut,
      // then used as the alpha of a solid colour layer.
      const BARS = 96;
      const cell = Math.max(4, Math.round((W * 0.86) / BARS));
      const bandW = cell * BARS;
      const bandH = even(H * 0.5);
      const gap = Math.max(2, Math.round(cell * 0.28));
      graph =
        `[0:a:0]aformat=channel_layouts=mono,showfreqs=s=1024x${bandH}:mode=bar:ascale=log:fscale=log:win_size=4096:averaging=2:colors=white:rate=${fps},` +
        `format=gray,scale=${BARS}:${bandH}:flags=area,lut=y='if(gt(val,100),255,0)',scale=${bandW}:${bandH}:flags=neighbor,` +
        `drawgrid=w=${cell}:h=${bandH}:t=${gap}:c=black[m];` +
        `color=c=0x${fg}:s=${bandW}x${bandH}:r=${fps}[f];[f][m]alphamerge[w];` +
        `color=c=0x${bg}:s=${W}x${H}:r=${fps}[bg];` +
        `[bg][w]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[v]`;
    } else {
      // Scale the picture to the recording's peak so quiet files still fill the frame.
      const peak = Math.max(...(await waveform(input, 400)), 0.001);
      const gain = Math.min(30, 0.9 / peak).toFixed(3);
      const bandH = even(H * 0.42);
      const bandW = even(W * 0.86);
      graph =
        `[0:a:0]aformat=channel_layouts=mono,volume=${gain},showwaves=s=${bandW}x${bandH}:mode=cline:rate=${fps}:scale=sqrt:draw=full:colors=white,format=gray[m];` +
        `color=c=0x${fg}:s=${bandW}x${bandH}:r=${fps}[f];[f][m]alphamerge[w];` +
        `color=c=0x${bg}:s=${W}x${H}:r=${fps}[bg];` +
        `[bg][w]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[v]`;
    }
    args.push('-filter_complex', graph, '-map', '[v]', '-map', '0:a:0', ...x264(20, 'veryfast'));
  }
  args.push('-c:a', 'aac', '-b:a', '192k', '-t', ts(info.duration), '-shortest', '-movflags', '+faststart', out);
  await ffmpeg(args, { ctx, duration: info.duration, note: 'Making video' });
  return [out];
};

// ------------------------------------------------------------------ trimAudio

const trimAudio: ToolFn = async ([input], ctx) => {
  const o = ctx.options ?? {};
  const info = await probe(input, ctx.signal);
  if (!info.hasAudio) throw new UserError('This file has no audio.');
  const [s, e] = clampRange(info, o.start, o.end);
  const ext = audioOutExt(input);
  const out = ctx.out(input, ext, ' trimmed');
  const af: string[] = [];
  if (o.trimSilence) {
    const th = Math.max(-90, Math.min(-10, num(o.threshold, -50)));
    const sr = `silenceremove=start_periods=1:start_threshold=${th}dB:start_silence=0.05:detection=peak`;
    af.push(sr, 'areverse', sr, 'areverse');
  }
  await ffmpeg(
    ['-ss', ts(s), '-i', input, '-t', ts(e - s), '-map', '0:a:0', '-vn', ...(af.length ? ['-af', af.join(',')] : []), ...audioEncodeArgs(ext, info), ...sampleRateArgs(ext, info.sampleRate), '-map_metadata', '0', out],
    { ctx, duration: e - s, note: 'Trimming' },
  );
  return [out];
};

// -------------------------------------------------------------- audioChannels

const audioChannels: ToolFn = async ([input], ctx) => {
  const o = ctx.options ?? {};
  const info = await probe(input, ctx.signal);
  if (!info.hasAudio) throw new UserError('This file has no audio.');
  const L = Math.max(0, Math.min(2, num(o.left, 1)));
  const R = Math.max(0, Math.min(2, num(o.right, 1)));
  const [l, r] = o.swap ? ['c1', 'c0'] : ['c0', 'c1'];
  let pan: string;
  if (o.output === 'mono') {
    const n = (L > 0 ? 1 : 0) + (R > 0 ? 1 : 0) || 1;
    pan = `pan=mono|c0=${(L / n).toFixed(4)}*${l}+${(R / n).toFixed(4)}*${r}`;
  } else pan = `pan=stereo|c0=${L.toFixed(4)}*${l}|c1=${R.toFixed(4)}*${r}`;
  const ext = audioOutExt(input);
  const suffix = o.output === 'mono' ? ' mono' : o.swap ? ' swapped' : ' stereo';
  const out = ctx.out(input, ext, suffix);
  await ffmpeg(
    ['-i', input, '-map', '0:a:0', '-vn', '-af', `aformat=channel_layouts=stereo,${pan}`, ...audioEncodeArgs(ext, info), ...sampleRateArgs(ext, info.sampleRate), '-map_metadata', '0', out],
    { ctx, duration: info.duration, note: 'Remixing channels' },
  );
  return [out];
};

// ----------------------------------------------------------------- bleepAudio

const bleepAudio: ToolFn = async ([input], ctx) => {
  const o = ctx.options ?? {};
  const info = await probe(input, ctx.signal);
  if (!info.hasAudio) throw new UserError('This file has no audio.');
  const ranges: { start: number; end: number }[] = (o.ranges ?? [])
    .map((r: any) => ({ start: Math.max(0, num(r.start, 0)), end: Math.min(info.duration, num(r.end, 0)) }))
    .filter((r: any) => r.end - r.start > 0.01);
  if (!ranges.length) throw new UserError('Add at least one bleep.');
  const any = ranges.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join('+');
  const sr = info.sampleRate || 44100;
  const layout = info.channels === 1 ? 'mono' : 'stereo';
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${sr}:channel_layouts=${layout}`;
  let graph: string;
  if (o.mode === 'silence') graph = `[0:a:0]${fmt},volume=0:enable='${any}'[out]`;
  else {
    const f = Math.max(100, Math.min(4000, num(o.freq, 1000)));
    // ffmpeg's sine source peaks at 1/8 full scale; `level` is relative to full scale.
    const lvl = Math.max(0.02, Math.min(1, num(o.level, 0.3))) * 8;
    graph =
      `[0:a:0]${fmt},volume=0:enable='${any}'[m];` +
      `sine=frequency=${f}:sample_rate=${sr},${fmt},volume=${lvl.toFixed(3)},volume=0:enable='not(${any})'[s];` +
      `[m][s]amix=inputs=2:duration=first:normalize=0[out]`;
  }
  const ext = audioOutExt(input);
  const out = ctx.out(input, ext, ' bleeped');
  await ffmpeg(['-i', input, '-filter_complex', graph, '-map', '[out]', ...audioEncodeArgs(ext, info), ...sampleRateArgs(ext, sr), '-map_metadata', '0', out], {
    ctx,
    duration: info.duration,
    note: 'Bleeping',
  });
  return [out];
};

// ------------------------------------------------------------------ joinAudio

const joinAudio: ToolFn = async (inputs, ctx) => {
  if (inputs.length < 2) throw new UserError('Choose at least two recordings to join.');
  const o = ctx.options ?? {};
  const infos = await Promise.all(inputs.map((p) => probe(p, ctx.signal)));
  infos.forEach((inf, i) => {
    if (!inf.hasAudio) throw new UserError(`${inputs[i].split(/[\\/]/).pop()} has no audio.`);
  });
  const first = infos[0];
  const ext = o.format && o.format !== 'same' ? String(o.format) : audioOutExt(inputs[0]);
  let sr = first.sampleRate || 44100;
  if (ext === 'opus') sr = 48000;
  const layout = infos.some((x) => x.channels >= 2) ? 'stereo' : 'mono';
  const minDur = Math.min(...infos.map((x) => x.duration));
  const xf = Math.max(0, Math.min(num(o.crossfade, 0), 10, minDur / 2 - 0.05));
  const args: string[] = [];
  inputs.forEach((p) => args.push('-i', p));
  const parts = infos.map((_, i) => `[${i}:a:0]aformat=sample_fmts=fltp:sample_rates=${sr}:channel_layouts=${layout}[a${i}]`);
  if (xf > 0.01) {
    let cur = 'a0';
    for (let i = 1; i < inputs.length; i++) {
      const next = i === inputs.length - 1 ? 'out' : `x${i}`;
      parts.push(`[${cur}][a${i}]acrossfade=d=${xf.toFixed(3)}:c1=tri:c2=tri[${next}]`);
      cur = next;
    }
  } else parts.push(`${infos.map((_, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[out]`);
  const total = infos.reduce((a, b) => a + b.duration, 0) - xf * (inputs.length - 1);
  const out = ctx.out(inputs[0], ext, ' joined');
  const enc = ext === extOf(inputs[0]) ? audioEncodeArgs(ext, first) : audioEncodeArgs(ext);
  args.push('-filter_complex', parts.join(';'), '-map', '[out]', ...enc, '-ar', String(sr), out);
  await ffmpeg(args, { ctx, duration: total, note: 'Joining' });
  return [out];
};

export const tools: Record<string, ToolFn> = {
  trimVideo,
  cropVideo,
  speedVideo,
  joinVideos,
  videoFrames,
  splitVideo,
  redactVideo,
  normalizeAudio,
  audioToVideo,
  trimAudio,
  audioChannels,
  bleepAudio,
  joinAudio,
};

// Exposed for tests.
export const _internal = { previewPath, waveform, keyframes, measureLoudness, thumbAt };
