// A sharp-compatible pipeline for the ported tool modules, run by the bundled ImageMagick through
// tools_spawn (Orange 2 has no libvips). Each chain is recorded and becomes one `magick` command.
// Covers the calls Orange's tools make: input file/buffer/raw/create, autoOrient/rotate/flip/flop,
// resize (fits), extract, extend, flatten, alpha, colourspace, linear, normalise, blur, trim,
// modulate, composite, channels, and png/jpeg/webp/avif/tiff/gif/raw output; metadata(); stats().
import { Buffer } from 'buffer';
import { join } from './path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from './fs';
import { spawn } from './child_process';
import { os } from './misc';
import { INFO } from '../native';

type Bg = string | { r: number; g: number; b: number; alpha?: number };
type RawSpec = { width: number; height: number; channels: number };
type Input = string | Uint8Array | ArrayBuffer | { create: { width: number; height: number; channels: number; background: Bg } } | undefined;

const color = (c: Bg | undefined, def = 'none') => {
  if (c === undefined) return def;
  if (typeof c === 'string') return c;
  return `rgba(${c.r ?? 0},${c.g ?? 0},${c.b ?? 0},${c.alpha ?? 1})`;
};

let tmpRoot = '';
let seq = 0;
function tmpFile(ext: string) {
  if (!tmpRoot) tmpRoot = mkdtempSync(join(os.tmpdir(), 'orange-sharp-'));
  return join(tmpRoot, `${Date.now().toString(36)}-${seq++}.${ext}`);
}
addEventListener('unload', () => {
  if (tmpRoot)
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* temp */
    }
});

function magickExe() {
  const local = join(INFO.binDir, 'imagemagick', 'magick.exe');
  try {
    statSync(local);
    return local;
  } catch {
    return 'magick';
  }
}

/** Runs magick; resolves stdout text. */
function magick(args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const c = spawn(magickExe(), args);
    let out = '';
    let err = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString()));
    c.stderr.on('data', (d: Buffer) => (err += d.toString()));
    c.on('error', rej);
    c.on('close', (code: number) => (code === 0 ? res(out) : rej(new Error(err.trim().split(/\r?\n/).pop() || `magick exited with ${code}`))));
  });
}

const FORMAT_NAMES: Record<string, string> = { jpeg: 'jpeg', jpg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', tiff: 'tiff', tif: 'tiff', avif: 'heif', heic: 'heif', heif: 'heif', svg: 'svg', bmp: 'bmp', ico: 'ico', pdf: 'pdf' };

interface Meta {
  width: number;
  height: number;
  format: string;
  channels: number;
  hasAlpha: boolean;
  orientation?: number;
  pages: number;
  density?: number;
  space: string;
  size?: number;
}

const metaCache = new Map<string, Promise<Meta>>();
function identify(file: string): Promise<Meta> {
  let key = file;
  try {
    const s = statSync(file);
    key = `${file}|${s.size}|${s.mtimeMs}`;
  } catch {
    /* buffer temp */
  }
  let p = metaCache.get(key);
  if (!p) {
    p = magick(['identify', '-ping', '-format', '%w|%h|%m|%[channels]|%[orientation]|%x|%[colorspace]|%n\\n', file]).then((out) => {
      const lines = out.trim().split(/\r?\n/);
      const [w, h, fmt, ch, orient, dens, space, n] = lines[0].split('|');
      if (ch === undefined) throw new Error(`Can't read this image (ImageMagick said: ${out.trim().slice(0, 120) || 'nothing'} for ${file}).`);
      const chs = ch.toLowerCase();
      const hasAlpha = /a$/.test(chs) || /alpha|rgba|graya|cmyka/.test(chs);
      const base = /gray/.test(chs) ? 1 : /cmyk/.test(chs) ? 4 : 3;
      const o = { TopLeft: 1, TopRight: 2, BottomRight: 3, BottomLeft: 4, LeftTop: 5, RightTop: 6, RightBottom: 7, LeftBottom: 8 } as Record<string, number>;
      const fmtL = fmt.toLowerCase();
      return {
        width: +w,
        height: +h,
        format: fmtL === 'jpeg' ? 'jpeg' : fmtL === 'heic' ? 'heif' : fmtL,
        channels: base + (hasAlpha ? 1 : 0),
        hasAlpha,
        orientation: o[orient],
        pages: Math.max(+n || 1, lines.length),
        density: parseFloat(dens) || undefined,
        space: /gray/.test(chs) ? 'b-w' : /cmyk/.test(chs) ? 'cmyk' : 'srgb',
      };
    });
    metaCache.set(key, p);
    p.catch(() => metaCache.delete(key));
  }
  return p;
}

interface Out {
  fmt: string;
  opts: Record<string, any>;
}

class Sharp {
  private input: Input;
  private opts: any;
  private ops: (string[] | (() => Promise<string[]>))[] = [];
  private out: Out | null = null;
  private alpha: 'keep' | 'add' | 'remove' = 'keep';
  private grey = false;
  private inFile: Promise<string> | null = null;

  constructor(input?: Input, opts: any = {}) {
    this.input = input;
    this.opts = opts;
  }

  clone() {
    const c = new Sharp(this.input, this.opts);
    c.ops = [...this.ops];
    c.out = this.out;
    c.alpha = this.alpha;
    c.grey = this.grey;
    c.inFile = this.inFile;
    return c;
  }

  /** The input as a file magick can read, with its read prefix/suffix. */
  private source(): Promise<string> {
    this.inFile ??= (async () => {
      const i = this.input;
      const raw: RawSpec | undefined = this.opts?.raw;
      if (i && typeof i === 'object' && 'create' in i) {
        const c = i.create;
        return `-size ${c.width}x${c.height} xc:${color(c.background, 'black')}`;
      }
      if (typeof i === 'string' && !raw) return i;
      const bytes = typeof i === 'string' ? readFileSync(i) : i instanceof ArrayBuffer ? new Uint8Array(i) : (i as Uint8Array);
      const f = tmpFile(raw ? 'raw' : sniffExt(bytes));
      writeFileSync(f, bytes);
      return f;
    })();
    return this.inFile;
  }

  private async readArgs(): Promise<string[]> {
    const src = await this.source();
    const raw: RawSpec | undefined = this.opts?.raw;
    if (src.startsWith('-size ')) {
      const [, size, xc] = src.split(' ');
      return ['-size', size, xc];
    }
    const density = this.opts?.density ? ['-density', String(this.opts.density)] : [];
    if (raw) return ['-size', `${raw.width}x${raw.height}`, '-depth', '8', `${['GRAY', 'GRAYA', 'RGB', 'RGBA'][raw.channels - 1]}:${src}`];
    const all = this.opts?.animated || this.opts?.pages === -1;
    const page = this.opts?.page !== undefined ? `[${this.opts.page}]` : all ? '' : '[0]';
    return [...density, src + page];
  }

  // ---------------------------------------------------------------- operations
  autoOrient() {
    this.ops.push(['-auto-orient']);
    return this;
  }
  rotate(angle?: number, o?: { background?: Bg }) {
    if (angle === undefined) return this.autoOrient();
    this.ops.push(['-background', color(o?.background, 'black'), '-rotate', String(angle), '+repage']);
    return this;
  }
  flip(on = true) {
    if (on) this.ops.push(['-flip']);
    return this;
  }
  flop(on = true) {
    if (on) this.ops.push(['-flop']);
    return this;
  }
  resize(w?: number | null | Record<string, any>, h?: number | null, o: Record<string, any> = {}) {
    if (w && typeof w === 'object') {
      o = w;
      w = o.width;
      h = o.height;
    }
    const W = w ? Math.round(w as number) : 0;
    const H = h ? Math.round(h as number) : 0;
    if (!W && !H) return this;
    const fit = o.fit ?? 'cover';
    const shrink = o.withoutEnlargement ? '>' : o.withoutReduction ? '<' : '';
    const filter = o.kernel === 'nearest' ? ['-filter', 'Point'] : o.kernel === 'cubic' ? ['-filter', 'Catrom'] : o.kernel === 'mitchell' ? ['-filter', 'Mitchell'] : ['-filter', 'Lanczos'];
    const geo = `${W || ''}x${H || ''}`;
    const grav = ['-gravity', gravity(o.position)];
    if (!W || !H || fit === 'inside') this.ops.push([...filter, '-resize', geo + shrink]);
    else if (fit === 'fill') this.ops.push([...filter, '-resize', `${geo}!${shrink}`]);
    else if (fit === 'outside') this.ops.push([...filter, '-resize', `${geo}^${shrink}`]);
    else if (fit === 'contain') this.ops.push([...filter, '-resize', geo + shrink, '-background', color(o.background, 'black'), ...grav, '-extent', geo, '+gravity']);
    else this.ops.push([...filter, '-resize', `${geo}^${shrink}`, ...grav, '-extent', geo, '+gravity']);
    return this;
  }
  extract(r: { left: number; top: number; width: number; height: number }) {
    this.ops.push(['-crop', `${Math.round(r.width)}x${Math.round(r.height)}+${Math.round(r.left)}+${Math.round(r.top)}`, '+repage']);
    return this;
  }
  extend(e: number | { top?: number; bottom?: number; left?: number; right?: number; background?: Bg }) {
    const o = typeof e === 'number' ? { top: e, bottom: e, left: e, right: e } : e;
    const bg = color((o as any).background, 'black');
    this.ops.push(['-background', bg, '-gravity', 'northwest', '-splice', `${o.left ?? 0}x${o.top ?? 0}`, '-gravity', 'southeast', '-splice', `${o.right ?? 0}x${o.bottom ?? 0}`, '+gravity']);
    return this;
  }
  flatten(o?: { background?: Bg }) {
    this.ops.push(['-background', color(o?.background, 'black'), '-alpha', 'remove', '-alpha', 'off']);
    this.alpha = 'remove';
    return this;
  }
  ensureAlpha(a?: number) {
    this.ops.push(a !== undefined && a < 1 ? ['-alpha', 'set', '-channel', 'A', '-evaluate', 'set', `${a * 100}%`, '+channel'] : ['-alpha', 'set']);
    this.alpha = 'add';
    return this;
  }
  removeAlpha() {
    this.ops.push(['-alpha', 'off']);
    this.alpha = 'remove';
    return this;
  }
  unflatten() {
    return this;
  }
  toColourspace(cs?: string) {
    const c = (cs ?? 'srgb').toLowerCase();
    if (c === 'b-w' || c === 'grey16' || c === 'gray') {
      this.ops.push(['-colorspace', 'Gray']);
      this.grey = true;
    } else if (c === 'cmyk') this.ops.push(['-colorspace', 'CMYK']);
    else {
      this.ops.push(['-colorspace', 'sRGB', '-type', 'TrueColor']);
      this.grey = false;
    }
    return this;
  }
  toColorspace(cs?: string) {
    return this.toColourspace(cs);
  }
  pipelineColourspace() {
    return this;
  }
  greyscale(on = true) {
    if (on) return this.toColourspace('b-w');
    return this;
  }
  grayscale(on = true) {
    return this.greyscale(on);
  }
  normalise(on = true) {
    if (on) this.ops.push(['-normalize']);
    return this;
  }
  normalize(on = true) {
    return this.normalise(on);
  }
  linear(a: number | number[] = 1, b: number | number[] = 0) {
    const A = Array.isArray(a) ? a[0] : a;
    const B = Array.isArray(b) ? b[0] : b;
    this.ops.push(['-function', 'Polynomial', `${A},${B / 255}`]);
    return this;
  }
  gamma(g = 2.2) {
    this.ops.push(['-gamma', String(1 / g)]);
    return this;
  }
  negate() {
    this.ops.push(['-negate']);
    return this;
  }
  blur(sigma?: number) {
    this.ops.push(['-blur', `0x${sigma ?? 1}`]);
    return this;
  }
  sharpen(o?: number | { sigma?: number }) {
    const s = typeof o === 'number' ? o : (o?.sigma ?? 1);
    this.ops.push(['-unsharp', `0x${s}`]);
    return this;
  }
  median(n = 3) {
    this.ops.push(['-statistic', 'Median', `${n}x${n}`]);
    return this;
  }
  threshold(t = 128) {
    this.ops.push(['-threshold', `${(t / 255) * 100}%`]);
    return this;
  }
  trim(o?: number | { threshold?: number; background?: Bg }) {
    const t = typeof o === 'number' ? o : (o?.threshold ?? 10);
    const bg = typeof o === 'object' && o?.background ? ['-bordercolor', color(o.background)] : [];
    this.ops.push([...bg, '-fuzz', `${(t / 255) * 100}%`, '-trim', '+repage']);
    return this;
  }
  modulate(o: { brightness?: number; saturation?: number; hue?: number; lightness?: number }) {
    this.ops.push(['-modulate', `${(o.brightness ?? 1) * 100},${(o.saturation ?? 1) * 100},${100 + (o.hue ?? 0) / 1.8}`]);
    return this;
  }
  tint(c: Bg) {
    this.ops.push(['-fill', color(c), '-tint', '100']);
    return this;
  }
  extractChannel(ch: number | string) {
    const name = ({ 0: 'R', 1: 'G', 2: 'B', 3: 'A', red: 'R', green: 'G', blue: 'B', alpha: 'A' } as Record<string, string>)[String(ch)] ?? 'R';
    this.ops.push(name === 'A' ? ['-alpha', 'extract'] : ['-channel', name, '-separate', '+channel']);
    this.grey = true;
    this.alpha = 'remove';
    return this;
  }
  joinChannel(img: Input | Input[], o?: { raw?: RawSpec }) {
    const one = Array.isArray(img) ? img[0] : img;
    this.ops.push(async () => {
      const s = new Sharp(one, o ?? {});
      return ['(', ...(await s.readArgs()), '-colorspace', 'Gray', ')', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite'];
    });
    this.alpha = 'add';
    return this;
  }
  composite(layers: { input: Input; left?: number; top?: number; blend?: string; gravity?: string; raw?: RawSpec; tile?: boolean }[]) {
    for (const l of layers) {
      this.ops.push(async () => {
        const s = new Sharp(l.input, l.raw ? { raw: l.raw } : {});
        const geo = l.left !== undefined || l.top !== undefined ? ['-gravity', 'northwest', '-geometry', `+${Math.round(l.left ?? 0)}+${Math.round(l.top ?? 0)}`] : ['-gravity', gravity(l.gravity)];
        const blend = { over: 'Over', 'dest-in': 'DstIn', 'dest-out': 'DstOut', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', 'dest-over': 'DstOver', atop: 'Atop', in: 'In', out: 'Out', source: 'Src' }[l.blend ?? 'over'] ?? 'Over';
        return ['(', ...(await s.readArgs()), ')', ...geo, '-compose', blend, '-composite', '+gravity', '-compose', 'Over'];
      });
    }
    return this;
  }
  // Metadata handling: sharp drops all metadata unless asked to keep some of it; ImageMagick keeps
  // everything unless told otherwise. Keep exactly the profiles asked for (ICC, EXIF, XMP), or all.
  private keep = { all: false, icc: false, exif: false, xmp: false };
  keepIccProfile() {
    this.keep.icc = true;
    return this;
  }
  withIccProfile() {
    return this.keepIccProfile();
  }
  keepExif() {
    this.keep.exif = true;
    return this;
  }
  withExif() {
    return this.keepExif();
  }
  keepXmp() {
    this.keep.xmp = true;
    return this;
  }
  withXmp() {
    return this.keepXmp();
  }
  keepMetadata() {
    this.keep.all = true;
    return this;
  }
  withMetadata() {
    return this.keepMetadata();
  }
  timeout() {
    return this;
  }

  // ---------------------------------------------------------------- output
  private fmt(fmt: string, opts: Record<string, any> = {}) {
    this.out = { fmt, opts };
    return this;
  }
  png(o?: any) {
    return this.fmt('png', o);
  }
  jpeg(o?: any) {
    return this.fmt('jpeg', o);
  }
  jpg(o?: any) {
    return this.fmt('jpeg', o);
  }
  webp(o?: any) {
    return this.fmt('webp', o);
  }
  avif(o?: any) {
    return this.fmt('avif', o);
  }
  heif(o?: any) {
    return this.fmt(o?.compression === 'av1' ? 'avif' : 'heic', o);
  }
  tiff(o?: any) {
    return this.fmt('tiff', o);
  }
  gif(o?: any) {
    return this.fmt('gif', o);
  }
  raw(o?: any) {
    return this.fmt('raw', o);
  }
  toFormat(f: string, o?: any) {
    return this.fmt(FORMAT_NAMES[f] === 'heif' && f === 'avif' ? 'avif' : (FORMAT_NAMES[f] ?? f), o);
  }

  private async channelsOut(): Promise<number> {
    if (this.grey) return this.alpha === 'add' ? 2 : 1;
    if (this.alpha === 'add') return 4;
    if (this.alpha === 'remove') return 3;
    const raw: RawSpec | undefined = this.opts?.raw;
    if (raw) return raw.channels;
    const i = this.input;
    if (i && typeof i === 'object' && 'create' in i) return i.create.channels;
    const m = await identify(await this.source());
    return m.hasAlpha ? (m.channels === 2 ? 2 : 4) : m.channels === 1 ? 1 : 3;
  }

  private async outArgs(file: string, fmt: string): Promise<[string[], number]> {
    const o = this.out?.opts ?? {};
    const q = o.quality !== undefined ? ['-quality', String(Math.round(o.quality))] : [];
    switch (fmt) {
      case 'raw': {
        const ch = await this.channelsOut();
        return [['-depth', '8', `${['GRAY', 'GRAYA', 'RGB', 'RGBA'][ch - 1]}:${file}`], ch];
      }
      case 'jpeg':
        return [[...q, ...(o.progressive ? ['-interlace', 'JPEG'] : []), '-sampling-factor', o.chromaSubsampling === '4:4:4' ? '1x1' : '2x2', `JPEG:${file}`], 3];
      case 'png': {
        const lvl = o.compressionLevel ?? 6;
        const pal = o.palette || o.colors ? ['-colors', String(o.colors ?? 256)] : [];
        return [[...pal, '-define', `png:compression-level=${lvl}`, `PNG:${file}`], 0];
      }
      case 'webp':
        return [[...q, ...(o.lossless ? ['-define', 'webp:lossless=true'] : []), '-define', `webp:method=${Math.min(6, o.effort ?? 4)}`, `WEBP:${file}`], 0];
      case 'avif':
        return [[...q, `AVIF:${file}`], 0];
      case 'heic':
        return [[...q, `HEIC:${file}`], 0];
      case 'tiff':
        return [[...(o.compression ? ['-compress', o.compression === 'jpeg' ? 'JPEG' : o.compression === 'deflate' ? 'Zip' : 'LZW'] : ['-compress', 'LZW']), ...q, `TIFF:${file}`], 0];
      case 'gif':
        return [[`GIF:${file}`], 0];
      default:
        return [[`${fmt.toUpperCase()}:${file}`], 0];
    }
  }

  private async run(file: string): Promise<{ width: number; height: number; channels: number; format: string; size: number }> {
    const fmt = this.out?.fmt ?? (await this.defaultFormat());
    const ops: string[] = [];
    for (const op of this.ops) ops.push(...(typeof op === 'function' ? await op() : op));
    const [outArgs] = await this.outArgs(file, fmt);
    const kept = (['icc', 'exif', 'xmp'] as const).filter((k) => this.keep[k]);
    const strip = this.keep.all ? [] : kept.length ? ['+profile', `${kept.map((k) => `!${k}`).join(',')},*`] : ['-strip'];
    const args = [...(await this.readArgs()), ...ops, ...strip, '-write', outArgs[outArgs.length - 1], ...[], '-format', '%w %h %[channels]\\n', 'info:'];
    // Output options go before -write.
    args.splice(args.indexOf('-write'), 0, ...outArgs.slice(0, -1));
    const info = (await magick(args)).trim().split(/\r?\n/)[0].split(' ');
    const chs = (info[2] ?? '').toLowerCase();
    const channels = fmt === 'raw' ? (await this.channelsOut()) : (/gray/.test(chs) ? 1 : 3) + (/a$/.test(chs) ? 1 : 0);
    return { width: +info[0], height: +info[1], channels, format: fmt, size: statSync(file).size };
  }

  private async defaultFormat() {
    const i = this.input;
    if (typeof i === 'string' && !this.opts?.raw) {
      const f = (await identify(i)).format;
      return ['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif'].includes(f) ? f : 'png';
    }
    return 'png';
  }

  async toFile(file: string) {
    if (!this.out) {
      const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? 'png';
      this.out = { fmt: ext === 'jpg' ? 'jpeg' : ext === 'avif' ? 'avif' : (FORMAT_NAMES[ext] ?? ext), opts: {} };
    }
    return this.run(file);
  }

  async toBuffer(o?: { resolveWithObject?: boolean }): Promise<any> {
    const fmt = this.out?.fmt ?? (await this.defaultFormat());
    const f = tmpFile(fmt === 'jpeg' ? 'jpg' : fmt);
    this.out ??= { fmt, opts: {} };
    try {
      const info = await this.run(f);
      const data = readFileSync(f) as Buffer;
      return o?.resolveWithObject ? { data, info: { ...info, size: data.length } } : data;
    } finally {
      try {
        rmSync(f, { force: true });
      } catch {
        /* temp */
      }
    }
  }

  async metadata(): Promise<Meta> {
    const i = this.input;
    const raw: RawSpec | undefined = this.opts?.raw;
    if (raw) return { width: raw.width, height: raw.height, channels: raw.channels, hasAlpha: raw.channels % 2 === 0, format: 'raw', pages: 1, space: 'srgb' };
    if (i && typeof i === 'object' && 'create' in i) return { width: i.create.width, height: i.create.height, channels: i.create.channels, hasAlpha: i.create.channels === 4, format: 'raw', pages: 1, space: 'srgb' };
    const src = await this.source();
    const m = await identify(src);
    return { ...m, size: typeof i === 'string' ? statSync(i).size : (i as Uint8Array)?.byteLength };
  }

  async stats() {
    const out = await magick([...(await this.readArgs()), '-format', '%[fx:mean.r*255] %[fx:mean.g*255] %[fx:mean.b*255] %[opaque]', 'info:']);
    const [r, g, b, opaque] = out.trim().split(' ');
    return { channels: [r, g, b].map((m) => ({ mean: +m })), isOpaque: opaque === 'True' || opaque === 'true', entropy: 0, dominant: { r: +r, g: +g, b: +b } };
  }
}

function gravity(g?: string | number) {
  const map: Record<string, string> = {
    centre: 'center', center: 'center', north: 'north', south: 'south', east: 'east', west: 'west', northeast: 'northeast', northwest: 'northwest',
    southeast: 'southeast', southwest: 'southwest', top: 'north', bottom: 'south', left: 'west', right: 'east', 'left top': 'northwest',
    'right top': 'northeast', 'left bottom': 'southwest', 'right bottom': 'southeast', entropy: 'center', attention: 'center',
  };
  return map[String(g ?? 'center')] ?? 'center';
}

function sniffExt(b: Uint8Array) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'webp';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if (b[0] === 0x3c) return 'svg';
  if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) return 'tif';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return String.fromCharCode(b[8], b[9], b[10], b[11]).startsWith('avi') ? 'avif' : 'heic';
  if (b[0] === 0x25 && b[1] === 0x50) return 'pdf';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return 'bin';
}

function sharp(input?: Input, opts?: any) {
  return new Sharp(input, opts);
}
sharp.cache = () => sharp;
sharp.concurrency = () => 1;
sharp.simd = () => true;
sharp.format = { heif: { input: { fileSuffix: ['.heic', '.heif', '.avif'] } }, jxl: { input: { fileSuffix: [] } } };
sharp.versions = { vips: 'imagemagick' };

export type { Sharp };
export default sharp;
