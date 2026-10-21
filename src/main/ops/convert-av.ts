// Video and audio conversion with ffmpeg.
// Speed first: streams whose codec already fits the target container are copied (a remux takes seconds);
// only the streams that don't fit are re-encoded, with quality-first defaults.
import { rmSync, existsSync, statSync } from 'node:fs';
import { ffmpeg, gpuEncoder, gpuPixFmt, gpuQualityArgs, probe, type ProbeInfo, type StreamInfo } from '../engines/ffmpeg';
import type { ConverterModule, Ctx } from './types';
import { UserError } from './types';
import { log } from '../log';

type Container = 'mp4' | 'mov' | 'mkv' | 'webm' | 'avi' | 'wmv';
const VIDEO_CONTAINERS: Container[] = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv'];
const AUDIO_TARGETS = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aiff', 'wma'] as const;
type AudioTarget = (typeof AUDIO_TARGETS)[number];

// ------------------------------------------------------------------ what fits where

const VIDEO_COPY: Record<Container, string[]> = {
  // Only codecs that play in the Windows and Apple built-in players; VP9/MPEG-4 Part 2 get re-encoded.
  mp4: ['h264', 'hevc', 'av1'],
  mov: ['h264', 'hevc', 'prores', 'mjpeg'],
  mkv: ['h264', 'hevc', 'av1', 'vp8', 'vp9', 'mpeg4', 'mpeg2video', 'mpeg1video', 'prores', 'mjpeg', 'ffv1', 'theora', 'msmpeg4v3', 'wmv3', 'vc1'],
  webm: ['vp8', 'vp9', 'av1'],
  avi: ['mpeg4', 'msmpeg4v3', 'msmpeg4v2', 'mjpeg'],
  wmv: ['wmv1', 'wmv2', 'wmv3', 'vc1'],
};

const AUDIO_COPY: Record<Container, string[]> = {
  mp4: ['aac', 'mp3', 'alac', 'ac3', 'eac3'],
  mov: ['aac', 'mp3', 'alac', 'ac3', 'eac3', 'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s24be', 'pcm_f32le'],
  mkv: ['aac', 'mp3', 'mp2', 'opus', 'vorbis', 'flac', 'ac3', 'eac3', 'dts', 'truehd', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le'],
  webm: ['opus', 'vorbis'],
  avi: ['mp3', 'ac3', 'pcm_s16le', 'mp2'],
  wmv: ['wmav1', 'wmav2', 'wmapro'],
};

/** H.264 quality for re-encodes (x264 CRF scale; the GPU encoders get the matching level). */
const H264_CRF = 20;

/** Video encoder settings when the source can't be copied. `gpu` is a hardware H.264 encoder to use instead of x264. */
function videoEncoder(c: Container, src: StreamInfo, gpu: string | null): string[] {
  switch (c) {
    case 'mp4':
    case 'mov':
    case 'mkv':
      if (gpu) return [gpu, ...gpuQualityArgs(gpu, H264_CRF), '-pix_fmt', gpuPixFmt(gpu), '-profile:v', 'high'];
      return ['libx264', '-preset', 'faster', '-crf', String(H264_CRF), '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
    case 'webm':
      // VP9 constant quality; row-mt + cpu-used 4 keeps it reasonably quick.
      return ['libvpx-vp9', '-crf', '32', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p'];
    case 'avi':
      return ['mpeg4', '-q:v', '3', '-tag:v', 'XVID', '-pix_fmt', 'yuv420p'];
    case 'wmv': {
      // wmv2 is quantiser based; scale bitrate ceiling with the picture size.
      const px = (src.width ?? 1280) * (src.height ?? 720);
      return ['wmv2', '-q:v', '3', '-maxrate', `${Math.round(Math.max(2, (px / 921600) * 6))}M`, '-bufsize', '16M', '-pix_fmt', 'yuv420p'];
    }
  }
}

function audioEncoder(c: Container): string[] {
  switch (c) {
    case 'mp4':
    case 'mov':
      return ['aac', '-b:a', '192k'];
    case 'mkv':
      return ['aac', '-b:a', '192k'];
    case 'webm':
      return ['libopus', '-b:a', '160k'];
    case 'avi':
      return ['libmp3lame', '-b:a', '192k'];
    case 'wmv':
      return ['wmav2', '-b:a', '192k'];
  }
}

/** Channel/sample-rate limits some encoders have. */
function audioLimits(enc: string, a: StreamInfo): string[] {
  const out: string[] = [];
  if (['libmp3lame', 'wmav2'].includes(enc) && (a.channels ?? 2) > 2) out.push('-ac', '2');
  if (['libmp3lame', 'wmav2', 'aac'].includes(enc) && (a.sampleRate ?? 44100) > 48000) out.push('-ar', '48000');
  if (enc === 'libvorbis' && (a.channels ?? 2) > 8) out.push('-ac', '2');
  return out;
}

// ------------------------------------------------------------------ public

export const converter: ConverterModule = {
  kinds: ['video', 'audio'],
  async convert(input, target, ctx) {
    const info = await probe(input, ctx.signal);
    ctx.progress(0.02);
    if (target === 'gif') return [await toGif(input, info, ctx)];
    if ((AUDIO_TARGETS as readonly string[]).includes(target)) return [await toAudio(input, info, target as AudioTarget, ctx)];
    if ((VIDEO_CONTAINERS as string[]).includes(target)) return [await toVideo(input, info, target as Container, ctx)];
    throw new UserError(`Can't convert to ${target.toUpperCase()}.`);
  },
};

// ------------------------------------------------------------------ video

async function toVideo(input: string, info: ProbeInfo, c: Container, ctx: Ctx): Promise<string> {
  if (!info.video && !info.audio) throw new UserError('This file has no video or audio in it.');
  const out = ctx.out(input, c);
  // H.264 re-encodes go to the graphics card when it has an encoder (Settings → GPU encoding).
  const gpu = info.video && (c === 'mp4' || c === 'mov' || c === 'mkv') ? await gpuEncoder('h264') : null;
  return produce(out, input, ctx, async (allowCopy) => {
    const args = videoArgs(input, info, c, allowCopy, gpu);
    const run = (a: string[]) => ffmpeg([...a, out], { ctx, duration: info.duration, range: [0.02, 1] });
    if (!gpu || !args.includes(gpu)) return run(args);
    try {
      return await run(args);
    } catch (e) {
      // Driver hiccup, unsupported size, too many sessions…: the same job on the CPU.
      if (ctx.signal.aborted) throw e;
      log('GPU encode failed; encoding on the CPU instead', input, e);
      rmSync(out, { force: true });
      return run(videoArgs(input, info, c, allowCopy, null));
    }
  });
}

function videoArgs(input: string, info: ProbeInfo, c: Container, allowCopy: boolean, gpu: string | null): string[] {
  const args = ['-i', input, '-map_metadata', '0'];
  const v = info.video;
  const singleAudio = c === 'avi' || c === 'wmv';
  const audios = singleAudio ? info.audios.slice(0, 1) : info.audios;

  if (v) {
    args.push('-map', `0:${v.index}`);
    // mp4/mov keep the rotation flag on copy; the others would lose it, so re-encode (which bakes it in).
    const rotationOk = !v.rotation || c === 'mp4' || c === 'mov';
    const copy = allowCopy && rotationOk && VIDEO_COPY[c].includes(v.codec);
    if (copy) {
      args.push('-c:v', 'copy');
      if (v.codec === 'hevc' && (c === 'mp4' || c === 'mov')) args.push('-tag:v', 'hvc1'); // plays on Windows/Apple
    } else {
      args.push('-c:v', ...videoEncoder(c, v, gpu));
      const odd = ((v.width ?? 0) | (v.height ?? 0)) & 1;
      if (odd) args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
      const fps = v.fps ?? 30;
      if (c === 'avi' || c === 'wmv') args.push('-g', String(Math.round(fps * 2)));
      if (fps > 120 && c !== 'mkv') args.push('-r', '60'); // bogus/variable rates from screen recorders
    }
  }
  audios.forEach((a, i) => {
    args.push('-map', `0:${a.index}`);
    const copy = allowCopy && AUDIO_COPY[c].includes(a.codec);
    if (copy) args.push(`-c:a:${i}`, 'copy');
    else {
      const enc = audioEncoder(c);
      args.push(`-c:a:${i}`, ...enc, ...audioLimits(enc[0], a).map((x, k) => (k % 2 === 0 ? `${x}:a:${i}` : x)));
    }
  });
  // Subtitles: keep what the container can hold.
  let si = 0;
  for (const s of info.subtitles) {
    const text = ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'].includes(s.codec);
    if (c === 'mkv') {
      const ok = text || ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'].includes(s.codec);
      if (!ok) continue;
      args.push('-map', `0:${s.index}`, `-c:s:${si++}`, s.codec === 'mov_text' || s.codec === 'text' ? 'srt' : 'copy');
    } else if ((c === 'mp4' || c === 'mov') && text) {
      args.push('-map', `0:${s.index}`, `-c:s:${si++}`, 'mov_text');
    } else if (c === 'webm' && text) {
      args.push('-map', `0:${s.index}`, `-c:s:${si++}`, 'webvtt');
    }
  }
  if (c === 'mp4' || c === 'mov') args.push('-movflags', '+faststart');
  if (c === 'mkv' || c === 'mp4' || c === 'mov') args.push('-map_chapters', '0');
  else args.push('-map_chapters', '-1');
  return args;
}

async function toGif(input: string, info: ProbeInfo, ctx: Ctx): Promise<string> {
  const v = info.video;
  if (!v) throw new UserError('This file has no video to turn into a GIF.');
  const out = ctx.out(input, 'gif');
  const fps = Math.min(15, v.fps ?? 15);
  const shownW = v.rotation === 90 || v.rotation === 270 ? v.height : v.width;
  const w = Math.min(720, shownW ?? 720);
  // One pass through the decoder: split the frames, build an optimal palette from them, then map onto it.
  const graph =
    `[0:v:0]fps=${+fps.toFixed(3)},scale=${w}:-2:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=256:stats_mode=diff[p];` +
    `[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  return produce(out, input, ctx, () =>
    ffmpeg(['-i', input, '-filter_complex', graph, '-loop', '0', out], { ctx, duration: info.duration, range: [0.02, 1] }),
  );
}

// ------------------------------------------------------------------ audio

const AUDIO_COPY_FOR: Record<AudioTarget, string[]> = {
  mp3: ['mp3'],
  m4a: ['aac', 'alac'],
  wav: [],
  flac: ['flac'],
  ogg: ['vorbis'],
  opus: ['opus'],
  aiff: [],
  wma: ['wmav2', 'wmav1', 'wmapro'],
};

function audioEncoderFor(t: AudioTarget, a: StreamInfo): string[] {
  // 24-bit output only when the source really is high-resolution lossless; decoded MP3/AAC are float
  // internally but 16 bits is all they carry.
  const lossless = /^(pcm_|flac|alac|wavpack|ape|truehd|tta|mlp)/.test(a.codec);
  const deep = lossless && ((a.bitDepth ?? 0) > 16 || (!a.bitDepth && /^(s32|flt|dbl)/.test(a.sampleFmt ?? '')));
  switch (t) {
    case 'mp3':
      return ['libmp3lame', '-q:a', '2']; // VBR ~190 kbps, transparent for almost everything
    case 'm4a':
      return ['aac', '-b:a', '256k'];
    case 'wav':
      return [deep ? 'pcm_s24le' : 'pcm_s16le'];
    case 'flac':
      return ['flac', '-compression_level', '5', ...(deep ? ['-sample_fmt', 's32'] : ['-sample_fmt', 's16'])];
    case 'ogg':
      return ['libvorbis', '-q:a', '6'];
    case 'opus':
      return ['libopus', '-b:a', '160k', '-vbr', 'on'];
    case 'aiff':
      return [deep ? 'pcm_s24be' : 'pcm_s16be'];
    case 'wma':
      return ['wmav2', '-b:a', '192k'];
  }
}

async function toAudio(input: string, info: ProbeInfo, t: AudioTarget, ctx: Ctx): Promise<string> {
  const a = info.audio;
  if (!a) throw new UserError(info.video ? "This video has no sound to extract." : 'This file has no audio in it.');
  const out = ctx.out(input, t);
  return produce(out, input, ctx, async (allowCopy) => {
    const args = ['-i', input, '-map', `0:${a.index}`, '-map_metadata', '0'];
    const copy = allowCopy && AUDIO_COPY_FOR[t].includes(a.codec);
    if (copy) args.push('-c:a', 'copy');
    else {
      const enc = audioEncoderFor(t, a);
      args.push('-c:a', ...enc, ...audioLimits(enc[0], a));
    }
    // Keep album art where the format supports it.
    const cover = info.cover;
    if (allowCopy && cover && ['mp3', 'm4a', 'flac'].includes(t) && ['mjpeg', 'png'].includes(cover.codec)) {
      args.push('-map', `0:${cover.index}`, '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
    } else args.push('-vn');
    if (t === 'mp3') args.push('-id3v2_version', '3');
    if (t === 'm4a') args.push('-movflags', '+faststart');
    args.push('-sn', '-dn');
    // ffmpeg picks the muxer from the extension; .m4a → ipod (mp4), .opus → ogg/opus, .wma → asf, .aiff → aiff.
    await ffmpeg([...args, out], { ctx, duration: info.duration, range: [0.02, 1] });
  });
}

// ------------------------------------------------------------------ helpers

/**
 * Run `job` writing straight to `out` (no temp copy across drives). The first run may stream-copy;
 * if it fails (odd timestamps, unusual tags…) it runs once more with everything re-encoded.
 * A failed or cancelled run never leaves a half-written file behind.
 */
async function produce(out: string, input: string, ctx: Ctx, job: (allowCopy: boolean) => Promise<unknown>): Promise<string> {
  try {
    try {
      await job(true);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      log('first ffmpeg attempt failed, re-encoding', input, e);
      rmSync(out, { force: true });
      await job(false);
    }
    if (!existsSync(out) || statSync(out).size === 0) throw new Error('ffmpeg produced no output.');
    return out;
  } catch (e) {
    rmSync(out, { force: true });
    throw e;
  }
}
