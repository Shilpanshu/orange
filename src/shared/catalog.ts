// Single source of truth for what Orange can do with which files.
// Shared by the main process (to run things) and the wheel renderer (to draw them).

export type Kind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'slides'
  | 'spreadsheet'
  | 'ebook'
  | 'subtitle'
  | 'archive'
  | 'folder'
  | 'other';

export type WheelKind = 'convert' | 'tools' | 'actions';

const EXT_KIND: Record<string, Kind> = {};
const reg = (kind: Kind, exts: string[]) => exts.forEach((e) => (EXT_KIND[e] = kind));
reg('image', ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'heic', 'heif', 'tif', 'tiff', 'avif', 'bmp', 'gif', 'svg', 'ico', 'jxl']);
reg('video', ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', '3gp']);
reg('audio', ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'wma', 'alac', 'amr']);
reg('pdf', ['pdf']);
reg('document', ['docx', 'doc', 'odt', 'pages', 'md', 'markdown', 'txt', 'rtf', 'html', 'htm']);
reg('ebook', ['epub']);
reg('slides', ['pptx', 'ppt', 'odp', 'key']);
reg('spreadsheet', ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'csv', 'tsv', 'numbers']);
reg('subtitle', ['srt', 'vtt']);
reg('archive', ['zip', 'tar', 'gz', 'tgz', 'rar', '7z']);

export function extOf(path: string): string {
  const m = /\.([^.\\/]+)$/.exec(path);
  return m ? m[1].toLowerCase() : '';
}

export function kindOfExt(ext: string): Kind {
  return EXT_KIND[ext.toLowerCase()] ?? 'other';
}

// Best-effort guess used while a drag is still in flight (the browser only exposes MIME types then).
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/tiff': 'tiff', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/webm': 'webm',
  'video/x-msvideo': 'avi', 'video/avi': 'avi', 'video/x-ms-wmv': 'wmv', 'video/mpeg': 'mpg', 'video/mp2t': 'ts',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/x-m4a': 'm4a', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg',
  'audio/opus': 'opus', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/x-ms-wma': 'wma', 'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc', 'application/vnd.oasis.opendocument.text': 'odt', 'text/markdown': 'md',
  'text/plain': 'txt', 'application/rtf': 'rtf', 'text/rtf': 'rtf', 'text/html': 'html',
  'application/epub+zip': 'epub',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsm', 'application/vnd.ms-excel.sheet.binary.macroenabled.12': 'xlsb',
  'text/csv': 'csv', 'text/tab-separated-values': 'tsv',
  'application/x-subrip': 'srt', 'text/vtt': 'vtt',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/x-tar': 'tar',
  'application/gzip': 'gz', 'application/x-gzip': 'gz', 'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar', 'application/x-7z-compressed': '7z',
};
export function extFromMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? '';
}

// ---------------------------------------------------------------- conversions

export interface Target {
  id: string; // e.g. "to:png"
  label: string; // shown on the wheel
  ext: string; // output extension
  sub?: string; // small caption, e.g. "All pages"
}

const t = (ext: string, label = ext.toUpperCase(), sub?: string): Target => ({ id: `to:${ext}`, label, ext, sub });

const IMAGE_OUT = [t('jpg'), t('png'), t('webp'), t('heic'), t('tiff'), t('avif'), t('bmp'), t('pdf', 'PDF')];
const AUDIO_OUT = [t('mp3'), t('m4a'), t('wav'), t('flac'), t('ogg'), t('opus', 'Opus'), t('aiff'), t('wma')];
const VIDEO_OUT = [t('mp4'), t('mov'), t('mkv'), t('webm', 'WebM'), t('avi'), t('wmv'), t('gif'), t('mp3', 'MP3', 'Audio')];
const PDF_OUT = [
  t('docx'), t('pptx'), t('xlsx'), t('jpg', 'JPG', 'All pages'), t('png', 'PNG', 'All pages'),
  t('epub', 'EPUB'), t('txt'), t('md', 'MD'),
];
const DOC_OUT = [t('docx'), t('pdf'), t('md', 'MD'), t('txt'), t('epub', 'EPUB'), t('html', 'HTML'), t('odt'), t('rtf')];
const SLIDES_OUT = [t('pdf'), t('jpg', 'JPG', 'Each slide'), t('png', 'PNG', 'Each slide'), t('pptx')];
const SHEET_OUT = [t('xlsx'), t('ods'), t('csv'), t('tsv'), t('pdf')];
const EBOOK_OUT = [t('pdf'), t('docx'), t('md', 'MD'), t('txt'), t('html', 'HTML')];
const SUB_OUT = [t('srt'), t('vtt'), t('txt')];
const ARCHIVE_OUT = [{ id: 'extract', label: 'Extract', ext: '' }, t('zip'), t('tar'), t('gz', 'GZIP'), t('7z')];
const ANY_OUT = [t('zip', 'ZIP')];

const normalize = (ext: string) =>
  ({ jpeg: 'jpg', jfif: 'jpg', tif: 'tiff', heif: 'heic', aif: 'aiff', markdown: 'md', htm: 'html', oga: 'ogg', tgz: 'gz' })[ext] ?? ext;

export function conversionTargets(exts: string[]): Target[] {
  if (exts.length === 0) return [];
  const kinds = new Set(exts.map(kindOfExt));
  if (kinds.size !== 1) return ANY_OUT; // mixed selection: only zipping makes sense
  const kind = [...kinds][0];
  const list: Target[] =
    {
      image: IMAGE_OUT, audio: AUDIO_OUT, video: VIDEO_OUT, pdf: PDF_OUT, document: DOC_OUT,
      slides: SLIDES_OUT, spreadsheet: SHEET_OUT, ebook: EBOOK_OUT, subtitle: SUB_OUT, archive: ARCHIVE_OUT,
      folder: ANY_OUT, other: ANY_OUT,
    }[kind] ?? ANY_OUT;
  const same = new Set(exts.map((e) => normalize(e)));
  // Hide "convert to the same format" unless it is the only thing on offer.
  const filtered = list.filter((x) => !(same.size === 1 && same.has(x.ext) && kind !== 'archive'));
  // Several images can be merged into one PDF; that is a tool, so keep the per-file PDF target too.
  return filtered.length ? filtered : list;
}

// ---------------------------------------------------------------------- tools

export interface ToolDef {
  id: string;
  label: string;
  icon: string; // key into the icon set
  kinds: Kind[]; // file kinds it applies to (any of)
  multi?: 'required' | 'optional'; // needs 2+ files, or works on a selection too
  single?: boolean; // only works on exactly one file
  blurb: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'compress', label: 'Compress', icon: 'compress', kinds: ['image', 'video', 'audio', 'pdf', 'document', 'slides', 'spreadsheet', 'other', 'folder'], multi: 'optional', blurb: 'Make it smaller, keep the original' },
  { id: 'metadata', label: 'Metadata', icon: 'metadata', kinds: ['image', 'video', 'audio', 'pdf'], multi: 'optional', blurb: 'Inspect, edit or strip embedded info' },
  { id: 'editImage', label: 'Edit', icon: 'edit', kinds: ['image'], single: true, blurb: 'Light, color and detail with live preview' },
  { id: 'annotateImage', label: 'Annotate', icon: 'annotate', kinds: ['image'], single: true, blurb: 'Arrows, shapes, text and callouts' },
  { id: 'frameImage', label: 'Add BG', icon: 'frame', kinds: ['image'], single: true, blurb: 'Put the image on a backdrop' },
  { id: 'cropImage', label: 'Crop', icon: 'crop', kinds: ['image'], multi: 'optional', blurb: 'Exact area or aspect ratio' },
  { id: 'redactImage', label: 'Redact', icon: 'redact', kinds: ['image'], single: true, blurb: 'Hide faces, text or any area' },
  { id: 'createPdf', label: 'Make PDF', icon: 'pdf', kinds: ['image'], multi: 'required', blurb: 'One page per image' },
  { id: 'createCollage', label: 'Collage', icon: 'collage', kinds: ['image'], multi: 'required', blurb: 'Grid, row, column or featured' },
  { id: 'trimVideo', label: 'Trim', icon: 'trim', kinds: ['video'], single: true, blurb: 'Keep one exact section' },
  { id: 'cropVideo', label: 'Crop', icon: 'crop', kinds: ['video'], single: true, blurb: 'Reframe, keep the audio' },
  { id: 'speedVideo', label: 'Speed', icon: 'speed', kinds: ['video'], single: true, blurb: 'Faster or slower copy' },
  { id: 'joinVideos', label: 'Join', icon: 'join', kinds: ['video'], multi: 'required', blurb: 'Combine clips into one MP4' },
  { id: 'videoFrames', label: 'Frames', icon: 'frames', kinds: ['video'], single: true, blurb: 'Save exact frames as PNG' },
  { id: 'splitVideo', label: 'Split', icon: 'split', kinds: ['video'], single: true, blurb: 'Cut into separate clips' },
  { id: 'redactVideo', label: 'Redact', icon: 'redact', kinds: ['video'], single: true, blurb: 'Blur or cover areas over time' },
  { id: 'normalizeAudio', label: 'Normalize', icon: 'normalize', kinds: ['audio', 'video'], multi: 'optional', blurb: 'Even, consistent loudness' },
  { id: 'audioToVideo', label: 'Visualize', icon: 'wave', kinds: ['audio'], single: true, blurb: 'Waveform or still image to MP4' },
  { id: 'trimAudio', label: 'Trim', icon: 'trim', kinds: ['audio'], single: true, blurb: 'Keep one section' },
  { id: 'audioChannels', label: 'Channels', icon: 'channels', kinds: ['audio'], single: true, blurb: 'Mono or stereo, per-channel volume' },
  { id: 'bleepAudio', label: 'Bleep', icon: 'bleep', kinds: ['audio'], single: true, blurb: 'Bleep out sensitive parts' },
  { id: 'joinAudio', label: 'Join', icon: 'join', kinds: ['audio'], multi: 'required', blurb: 'Combine recordings into one' },
  { id: 'mergePdf', label: 'Merge', icon: 'join', kinds: ['pdf'], multi: 'required', blurb: 'Combine PDFs in any order' },
  { id: 'organizePdf', label: 'Organize', icon: 'organize', kinds: ['pdf'], single: true, blurb: 'Reorder, rotate, duplicate, remove' },
  { id: 'splitPdf', label: 'Split', icon: 'split', kinds: ['pdf'], single: true, blurb: 'One file per page or range' },
  { id: 'extractArchive', label: 'Extract', icon: 'extract', kinds: ['archive'], multi: 'optional', blurb: 'Unpack next to the archive' },
  { id: 'unlock', label: 'Unlock', icon: 'unlock', kinds: ['pdf', 'archive'], multi: 'optional', blurb: 'Remove a password you know' },
  { id: 'ocr', label: 'OCR', icon: 'ocr', kinds: ['image', 'pdf'], multi: 'optional', blurb: 'Make scans searchable, or get the text' },
  { id: 'removeBg', label: 'Remove BG', icon: 'cutout', kinds: ['image'], multi: 'optional', blurb: 'Cut out the subject' },
  { id: 'upscale', label: 'Upscale', icon: 'upscale', kinds: ['image'], multi: 'optional', blurb: '2× or 4× sharper and larger' },
  { id: 'subtitles', label: 'Subtitles', icon: 'captions', kinds: ['video', 'audio'], multi: 'optional', blurb: 'Speech to SRT, offline' },
  { id: 'protect', label: 'Protect', icon: 'lock', kinds: ['pdf', 'image', 'video', 'audio', 'document', 'slides', 'spreadsheet', 'ebook', 'subtitle', 'archive', 'other', 'folder'], multi: 'optional', blurb: 'Password-protect a PDF or ZIP' },
  { id: 'rename', label: 'Rename', icon: 'rename', kinds: ['image', 'video', 'audio', 'pdf', 'document', 'slides', 'spreadsheet', 'ebook', 'subtitle', 'archive', 'other', 'folder'], multi: 'optional', blurb: 'Patterns, numbers and dates' },
];

export function toolsFor(exts: string[], hasFolder = false): ToolDef[] {
  if (exts.length === 0 && !hasFolder) return [];
  const kinds = new Set<Kind>(exts.map(kindOfExt));
  if (hasFolder) kinds.add('folder');
  const n = exts.length + (hasFolder ? 1 : 0);
  return TOOLS.filter((tool) => {
    if (![...kinds].every((k) => tool.kinds.includes(k))) return false;
    if (tool.single && n !== 1) return false;
    if (tool.multi === 'required' && n < 2) return false;
    return true;
  });
}

// -------------------------------------------------------------------- actions

export interface ActionDef {
  id: string;
  label: string;
  icon: string;
  blurb: string;
}

export const ACTIONS: ActionDef[] = [
  { id: 'share', label: 'Share', icon: 'share', blurb: 'Nearby Share, mail and apps' },
  { id: 'float', label: 'Float', icon: 'float', blurb: 'Park files on a floating shelf' },
  { id: 'copy', label: 'Copy', icon: 'copy', blurb: 'Copy, ready to paste in Explorer' },
  { id: 'move', label: 'Move', icon: 'move', blurb: 'Move to another folder' },
  { id: 'copyPath', label: 'Copy Path', icon: 'path', blurb: 'Full paths as text' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', blurb: 'Open the folder in a terminal' },
];

export interface WheelItem {
  id: string; // "to:png" | "tool:<id>" | "action:<id>" | "preset:<id>"
  label: string;
  sub?: string;
  icon?: string;
  pinned?: boolean;
  recent?: boolean;
}

/** User preferences that shape the wheel (sent by the main process each time it opens). */
export interface WheelPrefs {
  favorites: Record<string, string[]>; // per "wheel:kind" key, e.g. "convert:image"
  recents: Record<string, string>; // per extension, e.g. heic → "to:jpg"
  presets: { id: string; name: string; tool: string; kinds: string[] }[];
}

/** Key under which pins are stored: one list per wheel and file kind. */
export function pinKey(wheel: WheelKind, exts: string[], hasFolder = false): string {
  const kinds = new Set(exts.map(kindOfExt));
  if (hasFolder) kinds.add('folder');
  return `${wheel}:${kinds.size === 1 ? [...kinds][0] : 'mixed'}`;
}

export function wheelItems(wheel: WheelKind, exts: string[], hasFolder = false, prefs?: WheelPrefs): WheelItem[] {
  let items: WheelItem[];
  if (wheel === 'actions') items = ACTIONS.map((a) => ({ id: `action:${a.id}`, label: a.label, icon: a.icon, sub: a.blurb }));
  else if (wheel === 'tools') {
    items = toolsFor(exts, hasFolder).map((x) => ({ id: `tool:${x.id}`, label: x.label, icon: x.icon, sub: x.blurb }));
    // Saved presets whose tool applies to these files become their own slices.
    const toolIds = new Set(items.map((i) => i.id.slice(5)));
    for (const p of prefs?.presets ?? []) {
      if (toolIds.has(p.tool)) items.push({ id: `preset:${p.id}`, label: p.name, icon: 'star', sub: `Preset · ${TOOLS.find((t) => t.id === p.tool)?.label ?? p.tool}` });
    }
  } else if (hasFolder) items = [{ id: 'to:zip', label: 'ZIP', sub: 'Compress folder' }];
  else items = conversionTargets(exts).map((x) => ({ id: x.id, label: x.label, sub: x.sub }));
  if (!prefs) return items;

  // Pinned slices first, in the order they were pinned; everything else keeps its natural order.
  const pins = prefs.favorites[pinKey(wheel, exts, hasFolder)] ?? [];
  const rank = (it: WheelItem) => {
    const i = pins.indexOf(it.id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  items = items.map((it, n) => ({ it, n })).sort((a, b) => rank(a.it) - rank(b.it) || a.n - b.n).map(({ it }) => it);
  const recent = exts.length && new Set(exts).size === 1 ? prefs.recents[exts[0]] : undefined;
  return items.map((it) => ({ ...it, pinned: pins.includes(it.id), recent: it.id === recent }));
}
