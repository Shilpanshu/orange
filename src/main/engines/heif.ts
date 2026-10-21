// HEIC writer: libx265 (through the bundled ffmpeg) encodes the picture as 512×512 HEVC tiles, and this
// file wraps them in a HEIF container the way phones do (a 'grid' image of hidden 'hvc1' tiles, nclx colour,
// optional Exif). Needed because ImageMagick's Windows builds and sharp's prebuilt libvips only read HEIC.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg } from './ffmpeg';

const TILE = 512;

export interface HeicOptions {
  /** 1..100, like JPEG quality. */
  quality: number;
  /** Raw Exif as sharp's metadata().exif returns it ("Exif\0\0" + TIFF). Orientation is reset to 1. */
  exif?: Buffer;
  signal?: AbortSignal;
  /** Scratch directory for the intermediate MP4. */
  tmpDir: string;
}

/** Encode packed 8-bit RGB pixels (width*height*3 bytes, sRGB) to a HEIC file's bytes. */
export async function encodeHeic(rgb: Buffer, width: number, height: number, opts: HeicOptions): Promise<Buffer> {
  const cols = Math.ceil(width / TILE);
  const rows = Math.ceil(height / TILE);
  const pw = cols * TILE;
  const ph = rows * TILE;
  const crf = Math.round(Math.min(40, Math.max(8, 51 - opts.quality * 0.33)));
  const mp4 = join(opts.tmpDir, 'tiles.mp4');
  const vf = ['scale=out_color_matrix=bt601:out_range=full:flags=accurate_rnd+full_chroma_int', 'format=yuv420p', `untile=${cols}x${rows}`].join(',');
  const padded = padRgb(rgb, width, height, pw, ph);
  await ffmpeg(
    [
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${pw}x${ph}`, '-i', 'pipe:0',
      '-vf', vf,
      '-c:v', 'libx265', '-preset', 'fast', '-crf', String(crf),
      '-x265-params', 'keyint=1:min-keyint=1:bframes=0:info=0:log-level=error:range=full:colorprim=bt709:transfer=iec61966-2-1:colormatrix=smpte170m',
      '-color_range', 'pc', '-colorspace', 'smpte170m', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1',
      '-tag:v', 'hvc1', '-an', '-f', 'mp4', mp4,
    ],
    { signal: opts.signal, input: padded },
  );
  const { hvcC, samples } = readHevcTrack(readFileSync(mp4));
  if (samples.length !== cols * rows) throw new Error(`HEIC encode produced ${samples.length} tiles, expected ${cols * rows}.`);
  return buildHeif({ hvcC, tiles: samples, cols, rows, width, height, exif: opts.exif ? exifPayload(opts.exif) : undefined });
}

/** Grow the picture to whole tiles by repeating the last column/row, so tile edges compress cleanly. */
function padRgb(rgb: Buffer, w: number, h: number, pw: number, ph: number): Buffer {
  if (pw === w && ph === h) return rgb;
  const out = Buffer.allocUnsafe(pw * ph * 3);
  const row = w * 3;
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(y, h - 1);
    const d = y * pw * 3;
    rgb.copy(out, d, sy * row, sy * row + row);
    const r = rgb[sy * row + row - 3], g = rgb[sy * row + row - 2], b = rgb[sy * row + row - 1];
    for (let x = w; x < pw; x++) {
      out[d + x * 3] = r;
      out[d + x * 3 + 1] = g;
      out[d + x * 3 + 2] = b;
    }
  }
  return out;
}

// ------------------------------------------------------------------ MP4 reading

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function children(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

function find(buf: Buffer, parent: Box | null, path: string[]): Box | undefined {
  let cur: Box | undefined = parent ?? { type: 'root', start: 0, end: buf.length };
  for (const t of path) {
    cur = children(buf, cur.start, cur.end).find((b) => b.type === t);
    if (!cur) return undefined;
  }
  return cur;
}

/** Pull the hvcC record and every sample (length-prefixed NAL units) out of a one-track MP4. */
function readHevcTrack(buf: Buffer): { hvcC: Buffer; samples: Buffer[] } {
  const stbl = find(buf, null, ['moov', 'trak', 'mdia', 'minf', 'stbl']);
  if (!stbl) throw new Error('HEIC encode: no sample table.');
  const stsd = find(buf, stbl, ['stsd'])!;
  const entry = children(buf, stsd.start + 8, stsd.end)[0];
  if (!entry || !['hvc1', 'hev1'].includes(entry.type)) throw new Error('HEIC encode: no HEVC track.');
  const hvcCBox = children(buf, entry.start + 78, entry.end).find((b) => b.type === 'hvcC');
  if (!hvcCBox) throw new Error('HEIC encode: no hvcC.');
  const hvcC = buf.subarray(hvcCBox.start, hvcCBox.end);

  const stsz = find(buf, stbl, ['stsz'])!;
  const fixed = buf.readUInt32BE(stsz.start + 4);
  const count = buf.readUInt32BE(stsz.start + 8);
  const sizes = Array.from({ length: count }, (_, i) => (fixed ? fixed : buf.readUInt32BE(stsz.start + 12 + i * 4)));

  const stco = find(buf, stbl, ['stco']);
  const co64 = find(buf, stbl, ['co64']);
  const chunkOffsets: number[] = [];
  if (stco) {
    const n = buf.readUInt32BE(stco.start + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(buf.readUInt32BE(stco.start + 8 + i * 4));
  } else if (co64) {
    const n = buf.readUInt32BE(co64.start + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(Number(buf.readBigUInt64BE(co64.start + 8 + i * 8)));
  } else throw new Error('HEIC encode: no chunk offsets.');

  const stsc = find(buf, stbl, ['stsc'])!;
  const runs: { first: number; per: number }[] = [];
  const nRuns = buf.readUInt32BE(stsc.start + 4);
  for (let i = 0; i < nRuns; i++) runs.push({ first: buf.readUInt32BE(stsc.start + 8 + i * 12), per: buf.readUInt32BE(stsc.start + 12 + i * 12) });

  const samples: Buffer[] = [];
  let s = 0;
  for (let c = 0; c < chunkOffsets.length && s < count; c++) {
    const run = [...runs].reverse().find((r) => r.first <= c + 1)!;
    let off = chunkOffsets[c];
    for (let k = 0; k < run.per && s < count; k++, s++) {
      samples.push(buf.subarray(off, off + sizes[s]));
      off += sizes[s];
    }
  }
  return { hvcC, samples };
}

// ------------------------------------------------------------------ Exif

/** HEIF Exif item payload: 4-byte offset to the TIFF header, then the TIFF data, with Orientation forced to 1. */
function exifPayload(exif: Buffer): Buffer | undefined {
  let tiff = exif;
  const i = exif.indexOf('Exif\0\0', 0, 'latin1');
  if (i >= 0 && i < 16) tiff = exif.subarray(i + 6);
  if (tiff.length < 8) return undefined;
  const le = tiff.toString('latin1', 0, 2) === 'II';
  if (!le && tiff.toString('latin1', 0, 2) !== 'MM') return undefined;
  tiff = Buffer.from(tiff);
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  try {
    const ifd = u32(4);
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) {
        if (le) tiff.writeUInt16LE(1, e + 8);
        else tiff.writeUInt16BE(1, e + 8);
      }
    }
  } catch {
    return undefined; // malformed Exif: leave it out rather than write junk
  }
  const head = Buffer.alloc(4); // offset 0: TIFF header follows immediately
  return Buffer.concat([head, tiff]);
}

// ------------------------------------------------------------------ HEIF writing

const u8 = (v: number) => Buffer.from([v & 0xff]);
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
};
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
};
const str = (s: string) => Buffer.from(s, 'latin1');

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), str(type), body]);
}
function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  return box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...parts);
}

interface HeifParts {
  hvcC: Buffer;
  tiles: Buffer[];
  cols: number;
  rows: number;
  width: number;
  height: number;
  exif?: Buffer;
}

function buildHeif(p: HeifParts): Buffer {
  const GRID = 1;
  const firstTile = 2;
  const tileIds = p.tiles.map((_, i) => firstTile + i);
  const EXIF = p.exif ? firstTile + p.tiles.length : 0;
  const big = p.width > 0xffff || p.height > 0xffff;
  const gridData = Buffer.concat([u8(0), u8(big ? 1 : 0), u8(p.rows - 1), u8(p.cols - 1), ...(big ? [u32(p.width), u32(p.height)] : [u16(p.width), u16(p.height)])]);

  // Item payloads in mdat order.
  const payloads: { id: number; data: Buffer }[] = [{ id: GRID, data: gridData }];
  if (EXIF) payloads.push({ id: EXIF, data: p.exif! });
  p.tiles.forEach((t, i) => payloads.push({ id: tileIds[i], data: t }));

  const ftyp = box('ftyp', str('heic'), u32(0), str('mif1'), str('heic'), str('miaf'));

  const makeMeta = (mdatDataStart: number) => {
    const hdlr = fullBox('hdlr', 0, 0, u32(0), str('pict'), u32(0), u32(0), u32(0), u8(0));
    const pitm = fullBox('pitm', 0, 0, u16(GRID));
    const infe = (id: number, type: string, hidden: boolean) => fullBox('infe', 2, hidden ? 1 : 0, u16(id), u16(0), str(type), u8(0));
    const infes = [infe(GRID, 'grid', false), ...tileIds.map((id) => infe(id, 'hvc1', true))];
    if (EXIF) infes.push(infe(EXIF, 'Exif', false));
    const iinf = fullBox('iinf', 0, 0, u16(infes.length), ...infes);

    const refs = [box('dimg', u16(GRID), u16(tileIds.length), ...tileIds.map(u16))];
    if (EXIF) refs.push(box('cdsc', u16(EXIF), u16(1), u16(GRID)));
    const iref = fullBox('iref', 0, 0, ...refs);

    // Properties (1-based indices in ipma).
    const props = [
      box('hvcC', p.hvcC), // 1
      fullBox('ispe', 0, 0, u32(TILE), u32(TILE)), // 2
      fullBox('ispe', 0, 0, u32(p.width), u32(p.height)), // 3
      box('colr', str('nclx'), u16(1), u16(13), u16(6), u8(0x80)), // 4: BT.709 primaries, sRGB transfer, BT.601 matrix, full range
      fullBox('pixi', 0, 0, u8(3), u8(8), u8(8), u8(8)), // 5
    ];
    const ipco = box('ipco', ...props);
    const assoc = (id: number, list: [number, boolean][]) => Buffer.concat([u16(id), u8(list.length), ...list.map(([i, ess]) => u8((ess ? 0x80 : 0) | i))]);
    const entries = [assoc(GRID, [[3, false], [4, true], [5, false]]), ...tileIds.map((id) => assoc(id, [[1, true], [2, false], [4, true], [5, false]]))];
    const ipma = fullBox('ipma', 0, 0, u32(entries.length), ...entries);
    const iprp = box('iprp', ipco, ipma);

    // iloc v0: offset_size 4, length_size 4, base_offset_size 0.
    let off = mdatDataStart;
    const locs = payloads.map(({ id, data }) => {
      const b = Buffer.concat([u16(id), u16(0), u16(1), u32(off), u32(data.length)]);
      off += data.length;
      return b;
    });
    const iloc = fullBox('iloc', 0, 0, u8(0x44), u8(0x00), u16(payloads.length), ...locs);
    return fullBox('meta', 0, 0, hdlr, pitm, iinf, iref, iprp, iloc);
  };

  const dataLen = payloads.reduce((a, x) => a + x.data.length, 0);
  const metaLen = makeMeta(0).length; // size does not depend on the offsets
  const mdatHeader = dataLen + 8 > 0xffffffff ? 16 : 8;
  const meta = makeMeta(ftyp.length + metaLen + mdatHeader);
  const mdatHead = mdatHeader === 8 ? Buffer.concat([u32(dataLen + 8), str('mdat')]) : (() => {
    const b = Buffer.alloc(16);
    b.writeUInt32BE(1, 0);
    b.write('mdat', 4, 'latin1');
    b.writeBigUInt64BE(BigInt(dataLen + 16), 8);
    return b;
  })();
  return Buffer.concat([ftyp, meta, mdatHead, ...payloads.map((x) => x.data)]);
}
