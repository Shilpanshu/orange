// Every tool window page: id → [module under src/renderer/tool, exported page function].
//
// scripts/build.mjs builds each one as its own small entry, renderer/tool/pages/<id>.js, which
// imports just that page (plus shared chunks) and starts it. The router (index.ts) adds that
// entry as a module <script>, so a window fetches and parses only its own tool's code, and the
// page is built before the window's load event, i.e. before the main process shows the window.
// A wrong module path or export name fails the build.
export const PAGES = {
  // image
  editImage: ['image/edit', 'editImage'],
  annotateImage: ['image/annotate', 'annotateImage'],
  frameImage: ['image/frame', 'frameImage'],
  cropImage: ['image/crop', 'cropImage'],
  redactImage: ['image/redact', 'redactImage'],
  createPdf: ['image/pdf', 'createPdf'],
  createCollage: ['image/collage', 'createCollage'],
  // video and audio (processing happens in the main process, ops/tools-av.ts)
  trimVideo: ['av/trim-video', 'trimVideo'],
  cropVideo: ['av/crop-video', 'cropVideo'],
  speedVideo: ['av/speed-video', 'speedVideo'],
  joinVideos: ['av/join-videos', 'joinVideos'],
  videoFrames: ['av/video-frames', 'videoFrames'],
  splitVideo: ['av/split-video', 'splitVideo'],
  redactVideo: ['av/redact-video', 'redactVideo'],
  normalizeAudio: ['av/normalize-audio', 'normalizeAudio'],
  audioToVideo: ['av/audio-to-video', 'audioToVideo'],
  trimAudio: ['av/trim-audio', 'trimAudio'],
  audioChannels: ['av/audio-channels', 'audioChannels'],
  bleepAudio: ['av/bleep-audio', 'bleepAudio'],
  joinAudio: ['av/join-audio', 'joinAudio'],
  // PDF
  mergePdf: ['pdf/merge', 'mergePdf'],
  organizePdf: ['pdf/organize', 'organizePdf'],
  splitPdf: ['pdf/split', 'splitPdf'],
  // files (extractArchive runs instantly from the wheel, no window; see main/ops/tools-file.ts)
  compress: ['file/compress', 'compress'],
  metadata: ['file/metadata', 'metadata'],
  // AI (the models run in the main process, main/ops/tools-ai.ts)
  ocr: ['ai/ocr', 'ocrPage'],
  removeBg: ['ai/remove-bg', 'removeBackground'],
  upscale: ['ai/upscale', 'upscaleImage'],
  // utilities
  rename: ['util/rename', 'rename'],
  protect: ['util/protect', 'protect'],
  unlock: ['util/unlock', 'unlock'],
  // speech (transcription runs in the main process, ops/tools-speech.ts)
  subtitles: ['speech/subtitles', 'subtitles'],
} as const satisfies Record<string, readonly [string, string]>;
