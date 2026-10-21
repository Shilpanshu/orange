// Video and audio tool windows. Processing happens in the main process (ops/tools-av.ts).
import type { ToolPage } from '../index';
import { trimVideo } from './trim-video';
import { cropVideo } from './crop-video';
import { speedVideo } from './speed-video';
import { joinVideos } from './join-videos';
import { videoFrames } from './video-frames';
import { splitVideo } from './split-video';
import { redactVideo } from './redact-video';
import { normalizeAudio } from './normalize-audio';
import { audioToVideo } from './audio-to-video';
import { trimAudio } from './trim-audio';
import { audioChannels } from './audio-channels';
import { bleepAudio } from './bleep-audio';
import { joinAudio } from './join-audio';

export const pages: Record<string, ToolPage> = {
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
