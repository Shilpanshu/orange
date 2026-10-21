// Utility tools: Rename (bulk, atomic, undoable), Protect (AES-256 PDF, or an encrypted ZIP / 7z)
// and Unlock (remove a known password from a PDF or an archive).
//
// Passwords never reach the log: every 7-Zip / Ghostscript call passes them through run()'s
// `redact` option, and nothing here logs options.
import { ipcMain } from 'electron';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, sep } from 'node:path';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { extOf, kindOfExt } from '../../shared/catalog';
import type { Ctx, ToolFn } from './types';
import { UserError } from './types';
import { run } from '../engines/run';
import { bin, hasBin } from '../paths';
import { hud } from '../hud';
import { log } from '../log';
import { _internal as fileInternal } from './tools-file';
import type sharpType from 'sharp';

const sharpLib = (): typeof sharpType => require('sharp');
const GS = 'gs/bin/gswin64c';

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

// =================================================================== rename

export interface RenameInfo {
  path: string;
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export interface RenameDate {
  /** ms since epoch */
  ms: number;
  source: 'photo' | 'media' | 'modified';
}

export interface RenamePair {
  from: string;
  /** New base name (no folder). */
  name: string;
}

export interface RenameOptions {
  pairs: RenamePair[];
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Why `name` can't be used as a Windows file name, or null when it's fine. */
export function invalidName(name: string): string | null {
  if (!name.trim()) return 'The name is empty';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return 'Contains a character Windows does not allow ( < > : " / \\ | ? * )';
  if (/[. ]$/.test(name)) return 'Ends with a dot or a space';
  if (RESERVED.test(name)) return 'Is a name Windows reserves';
  if (name.length > 255) return 'Is longer than 255 characters';
  return null;
}

interface Step {
  from: string;
  to: string;
}

const lower = (p: string) => p.toLowerCase();

/** Validate the requested renames and turn them into from → to paths. Throws UserError. */
function planRename(pairs: RenamePair[]): Step[] {
  const steps: Step[] = [];
  for (const p of pairs) {
    if (!p || typeof p.from !== 'string' || typeof p.name !== 'string') continue;
    if (basename(p.from) === p.name) continue;
    if (!existsSync(p.from)) throw new UserError(`${basename(p.from)} no longer exists.`);
    const why = invalidName(p.name);
    if (why) throw new UserError(`"${p.name}" can't be used: ${why.charAt(0).toLowerCase()}${why.slice(1)}.`);
    steps.push({ from: p.from, to: join(dirname(p.from), p.name) });
  }
  if (!steps.length) throw new UserError('Nothing to rename: the new names are the same as the old ones.');

  const moving = new Set(steps.map((s) => lower(s.from)));
  if (moving.size !== steps.length) throw new UserError('The same item is listed twice.');
  const targets = new Set<string>();
  for (const s of steps) {
    const key = lower(s.to);
    if (targets.has(key)) throw new UserError(`Two items would both be named "${basename(s.to)}".`);
    targets.add(key);
    // A target that exists is only fine when it's one of the items being renamed away (swaps, case changes).
    if (existsSync(s.to) && !moving.has(key)) {
      throw new UserError(`"${basename(s.to)}" already exists in ${basename(dirname(s.to)) || dirname(s.to)}.`);
    }
  }
  const froms = steps.map((s) => lower(s.from));
  for (const a of froms) {
    for (const b of froms) {
      if (a !== b && b.startsWith(a.endsWith(sep) ? a : a + sep)) {
        throw new UserError('A folder and something inside it are both selected. Rename them separately.');
      }
    }
  }
  return steps;
}

/**
 * Rename every step or none. Each item first moves to a temporary name in its own folder, then to its
 * final name, so swaps (a→b, b→a) and case-only changes work. Any failure puts everything back.
 */
async function applyRenames(steps: Step[], onFrac?: (f: number) => void) {
  const tag = `.orange-rename-${process.pid}-${Date.now().toString(36)}`;
  const temps = steps.map((s, i) => join(dirname(s.from), `${tag}-${i}`));
  const parked: number[] = [];
  const placed: number[] = [];
  const total = steps.length * 2;
  let current = 0;
  try {
    for (let i = 0; i < steps.length; i++) {
      current = i;
      await fsRename(steps[i].from, temps[i]);
      parked.push(i);
      onFrac?.(parked.length / total);
    }
    for (let i = 0; i < steps.length; i++) {
      current = i;
      // fs.rename replaces an existing file on Windows; never let that happen.
      if (existsSync(steps[i].to)) throw new UserError(`"${basename(steps[i].to)}" appeared while renaming.`);
      await fsRename(temps[i], steps[i].to);
      placed.push(i);
      onFrac?.((parked.length + placed.length) / total);
    }
  } catch (e: any) {
    const failedAt = steps[current];
    const stuck: string[] = [];
    for (const i of placed.reverse()) {
      try {
        await fsRename(steps[i].to, temps[i]);
      } catch {
        stuck.push(steps[i].to);
        parked.splice(parked.indexOf(i), 1);
      }
    }
    for (const i of parked.reverse()) {
      try {
        await fsRename(temps[i], steps[i].from);
      } catch {
        stuck.push(temps[i]);
      }
    }
    log('rename failed', e?.code ?? e?.message, stuck.length ? `${stuck.length} not restored` : 'rolled back');
    if (stuck.length) {
      throw new UserError(`Renaming stopped and ${stuck.length === 1 ? 'one item' : `${stuck.length} items`} couldn't be put back: ${stuck.map((s) => basename(s)).join(', ')}`);
    }
    const why = e instanceof UserError ? e.message : fsReason(e);
    throw new UserError(`Couldn't rename ${failedAt ? basename(failedAt.from) : 'an item'}: ${why} Nothing was changed.`);
  }
}

function fsReason(e: any): string {
  const c = e?.code;
  if (c === 'EBUSY' || c === 'EPERM' || c === 'EACCES') return 'it is open in another app or read-only.';
  if (c === 'ENOENT') return 'it no longer exists.';
  if (c === 'ENAMETOOLONG') return 'the path would be too long.';
  if (c === 'EEXIST' || c === 'ENOTEMPTY') return 'the new name is taken.';
  return String(e?.message ?? e);
}

let lastRename: { steps: Step[]; at: number } | null = null;

const renameTool: ToolFn = async (_inputs, ctx) => {
  const opts = (ctx.options ?? {}) as RenameOptions;
  const steps = planRename(opts.pairs ?? []);
  await applyRenames(steps, (f) => ctx.progress(f));
  lastRename = { steps, at: Date.now() };
  return steps.map((s) => s.to);
};

/** Paths the last rename produced (empty when there is nothing to undo). */
export function lastRenamedPaths(): string[] {
  return lastRename ? lastRename.steps.map((s) => s.to) : [];
}

/** Put the names from the last Rename back. Shows the outcome in the HUD and returns it. */
export async function undoLastRename(): Promise<{ ok: boolean; message: string; paths: string[] }> {
  if (!lastRename) {
    hud.notice('Nothing to undo.');
    return { ok: false, message: 'Nothing to undo.', paths: [] };
  }
  const back = lastRename.steps.map((s) => ({ from: s.to, name: basename(s.from) }));
  try {
    const missing = back.find((b) => !existsSync(b.from));
    if (missing) throw new UserError(`${basename(missing.from)} was moved or renamed since, so the names can't be restored.`);
    const steps = planRename(back);
    await applyRenames(steps);
    lastRename = null;
    const message = steps.length === 1 ? `Renamed back to ${basename(steps[0].to)}` : `Restored ${steps.length} original names`;
    hud.notice(message);
    return { ok: true, message, paths: steps.map((s) => s.to) };
  } catch (e: any) {
    const message = e instanceof UserError ? e.message : String(e?.message ?? e);
    hud.notice(message);
    return { ok: false, message, paths: [] };
  }
}

// ---- dates for the Date step: photo EXIF, media creation time, or modified date

function exifDate(s: string): number | undefined {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m || m[1] === '0000') return undefined;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

async function photoDate(path: string): Promise<number | undefined> {
  const m = await sharpLib()(path, { failOn: 'none' }).metadata();
  if (!m.exif) return undefined;
  const block = m.exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? m.exif.subarray(6) : m.exif;
  const t = fileInternal.parseTiff(Buffer.from(block));
  if (!t) return undefined;
  const ascii = (tag: number, ifd = t.exif) => ifd?.entries.find((e) => e.tag === tag)?.bytes.toString('latin1').replace(/\0+$/, '');
  for (const v of [ascii(0x9003), ascii(0x9004), ascii(0x0132, t.ifd0)]) {
    const ms = v ? exifDate(v) : undefined;
    if (ms) return ms;
  }
  return undefined;
}

async function mediaDate(path: string): Promise<number | undefined> {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries', 'format_tags=creation_time:stream_tags=creation_time', path]);
  const j = JSON.parse(r.stdout || '{}');
  const all = [j.format?.tags?.creation_time, ...(j.streams ?? []).map((s: any) => s.tags?.creation_time)].filter(Boolean);
  for (const v of all) {
    const ms = Date.parse(v);
    // Cameras without a clock write 1904/1970; ignore those.
    if (Number.isFinite(ms) && new Date(ms).getUTCFullYear() > 1980) return ms;
  }
  return undefined;
}

async function bestDate(path: string): Promise<RenameDate> {
  const st = statSync(path);
  const kind = st.isDirectory() ? 'folder' : kindOfExt(extOf(path));
  try {
    if (kind === 'image') {
      const ms = await photoDate(path);
      if (ms) return { ms, source: 'photo' };
    } else if (kind === 'video' || kind === 'audio') {
      const ms = await mediaDate(path);
      if (ms) return { ms, source: 'media' };
    }
  } catch {
    /* fall back to the modified date */
  }
  return { ms: st.mtimeMs, source: 'modified' };
}

ipcMain.handle('rename:info', (_e, paths: string[]): RenameInfo[] =>
  paths.map((p) => {
    try {
      const st = statSync(p);
      return { path: p, name: basename(p), dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs };
    } catch {
      return { path: p, name: basename(p), dir: false, size: 0, mtime: 0 };
    }
  }),
);
ipcMain.handle('rename:dates', async (_e, paths: string[]) => {
  const out: Record<string, RenameDate> = {};
  await pool(paths, 4, async (p) => {
    try {
      out[p] = await bestDate(p);
    } catch {
      /* missing file: no date */
    }
  });
  return out;
});
/** Which of these full paths already exist on disk (the window flags clashes with files outside the selection). */
ipcMain.handle('rename:existing', (_e, targets: string[]) => targets.filter((t) => existsSync(t)));
ipcMain.handle('rename:undo', () => undoLastRename());
ipcMain.handle('rename:canUndo', () => lastRenamedPaths());

// ============================================================ PDF encryption
// Ghostscript's pdfwrite only writes RC4 (revisions 2 and 3), so Orange encrypts PDFs itself:
// standard security handler revision 6 (PDF 2.0), AES-256 for every string and stream.

const sha = (alg: string, ...parts: Buffer[]) => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return h.digest();
};

function aesNoPad(key: Buffer, iv: Buffer | null, data: Buffer, mode: 'cbc' | 'ecb' = 'cbc') {
  const c = createCipheriv(`aes-${key.length * 8}-${mode}`, key, mode === 'ecb' ? null : iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

/** ISO 32000-2 algorithm 2.B: the hardened hash used by revision 6. */
function hash2B(pw: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let k = sha('sha256', pw, salt, udata);
  for (let round = 1; ; round++) {
    const block = Buffer.concat([pw, k, udata]);
    const k1 = Buffer.concat(Array.from({ length: 64 }, () => block));
    const e = aesNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);
    let mod = 0;
    for (let j = 0; j < 16; j++) mod = (mod + e[j]) % 3; // 256 ≡ 1 (mod 3), so the byte sum decides
    k = sha(['sha256', 'sha384', 'sha512'][mod], e);
    if (round >= 64 && e[e.length - 1] <= round - 32) break;
  }
  return k.subarray(0, 32);
}

const pwBytes = (s: string) => Buffer.from(s.normalize('NFKC'), 'utf8').subarray(0, 127);

export interface PdfPermissions {
  print: boolean;
  copy: boolean;
  edit: boolean;
}

function permissionBits(p: PdfPermissions): number {
  let bits = 0xfffff0c0 | 512; // reserved bits set; accessibility extraction always allowed
  if (p.print) bits |= 4 | 2048;
  if (p.copy) bits |= 16;
  if (p.edit) bits |= 8 | 32 | 256 | 1024;
  return bits | 0;
}

/** Encrypt `bytes` (an unencrypted PDF) with AES-256. Returns the new file. */
export async function encryptPdf(bytes: Uint8Array, userPassword: string, ownerPassword: string, perms: PdfPermissions): Promise<Uint8Array> {
  const lib = await import('pdf-lib');
  const { PDFDocument, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFStream, PDFName, PDFBool } = lib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new UserError('This PDF is already password-protected. Unlock it first.');
  const ctx = doc.context;

  const fileKey = randomBytes(32);
  const enc = (data: Uint8Array) => {
    const iv = randomBytes(16);
    const c = createCipheriv('aes-256-cbc', fileKey, iv);
    return Buffer.concat([iv, c.update(data), c.final()]);
  };
  const hex = (b: Buffer) => PDFHexString.of(b.toString('hex'));

  const seen = new Set<object>();
  const walk = (o: any): any => {
    if (o instanceof PDFString || o instanceof PDFHexString) return hex(enc(o.asBytes()));
    if (!o || typeof o !== 'object' || seen.has(o)) return o;
    seen.add(o);
    if (o instanceof PDFDict) {
      // Signature values are never encrypted.
      if (o.get(PDFName.of('Type')) === PDFName.of('Sig')) return o;
      for (const [k, v] of o.entries()) {
        const nv = walk(v);
        if (nv !== v) o.set(k, nv);
      }
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i);
        const nv = walk(v);
        if (nv !== v) o.set(i, nv);
      }
    }
    return o;
  };

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      walk(obj.dict);
      ctx.assign(ref, PDFRawStream.of(obj.dict, enc(obj.contents)));
    } else if (obj instanceof PDFStream) {
      // Streams pdf-lib made itself (none after a plain load); encode them first.
      walk(obj.dict);
      const raw = obj.getContents();
      ctx.assign(ref, PDFRawStream.of(obj.dict, enc(raw)));
    } else {
      const nv = walk(obj);
      if (nv !== obj) ctx.assign(ref, nv);
    }
  }

  // Security handler values (algorithms 8, 9 and 10).
  const upw = pwBytes(userPassword);
  const opw = pwBytes(ownerPassword);
  const [uvs, uks, ovs, oks] = [randomBytes(8), randomBytes(8), randomBytes(8), randomBytes(8)];
  const zero = Buffer.alloc(16);
  const U = Buffer.concat([hash2B(upw, uvs, Buffer.alloc(0)), uvs, uks]);
  const UE = aesNoPad(hash2B(upw, uks, Buffer.alloc(0)), zero, fileKey);
  const O = Buffer.concat([hash2B(opw, ovs, U), ovs, oks]);
  const OE = aesNoPad(hash2B(opw, oks, U), zero, fileKey);
  const P = permissionBits(perms);
  const permsBlock = Buffer.alloc(16);
  permsBlock.writeInt32LE(P, 0);
  permsBlock.fill(0xff, 4, 8);
  permsBlock.write('Tadb', 8, 'latin1');
  randomBytes(4).copy(permsBlock, 12);
  const Perms = aesNoPad(fileKey, null, permsBlock, 'ecb');

  const encDict = ctx.obj({
    Filter: 'Standard',
    V: 5,
    R: 6,
    Length: 256,
    CF: { StdCF: { Type: 'CryptFilter', AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } },
    StmF: 'StdCF',
    StrF: 'StdCF',
    P,
    EncryptMetadata: PDFBool.True,
    O: hex(O),
    U: hex(U),
    OE: hex(OE),
    UE: hex(UE),
    Perms: hex(Perms),
  });
  ctx.trailerInfo.Encrypt = ctx.register(encDict);
  if (!ctx.trailerInfo.ID) {
    const id = randomBytes(16).toString('hex');
    ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
  }
  // No object streams: every object stays individually encrypted. Nothing new may be generated now.
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

/** Cheap check for an /Encrypt entry in a trailer or cross-reference stream, without parsing the document. */
async function pdfIsEncrypted(path: string): Promise<boolean> {
  const buf = await readFile(path);
  return /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(buf.toString('latin1'));
}

// =================================================================== protect

export interface ProtectOptions {
  /** pdf: encrypt each PDF itself. zip: AES-256 ZIP. 7z: 7z with encrypted file names. */
  mode: 'pdf' | 'zip' | '7z';
  password: string;
  /** PDF only: a separate password for changing permissions ('' = a random one). */
  ownerPassword?: string;
  permissions?: PdfPermissions;
}

function checkPassword(pw: unknown): string {
  if (typeof pw !== 'string' || !pw.length) throw new UserError('Enter a password.');
  return pw;
}

/** "photos.tar.gz" → "photos". */
function archiveStem(p: string): string {
  return basename(p).replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz|zip|rar|7z|tar|gz|bz2|xz)$/i, '') || basename(p);
}

function packName(paths: string[]): string {
  if (paths.length === 1) return isDir(paths[0]) ? basename(paths[0]) : basename(paths[0], extname(paths[0]));
  const parent = basename(dirname(paths[0]));
  return parent ? `Archive (${parent})` : 'Archive';
}

/**
 * How to hand 7-Zip the password. Printable ASCII goes through stdin (never on a command line, and
 * quotation marks work). 7-Zip decodes piped non-ASCII text differently from what its GUI uses, so other
 * characters go on the command line instead, where its parser can't represent a quotation mark.
 */
function passwordVia(password: string, cmd: 'a' | 'x' | 't'): { args: string[]; input?: string } {
  if (/^[\x20-\x7e]+$/.test(password)) return cmd === 'a' ? { args: ['-p'], input: `${password}\n${password}\n` } : { args: [], input: `${password}\n` };
  if (password.includes('"')) throw new UserError(`Archive passwords with letters outside English can't also contain quotation marks (").`);
  return { args: [`-p${password}`] };
}

/** Why `password` can't protect an archive of this type, or null. Mirrors 7-Zip's limits. */
export function archivePasswordProblem(password: string, type: 'zip' | '7z'): string | null {
  if (!password) return 'Enter a password.';
  const ascii = /^[\x20-\x7e]+$/.test(password);
  if (!ascii && type === 'zip') return 'ZIP passwords can only use English letters, digits and symbols. Choose 7z to use other characters.';
  if (!ascii && password.includes('"')) return `A password with letters outside English can't also contain quotation marks (").`;
  return null;
}

/** 7-Zip with progress; maps password failures to a clear message. */
async function sevenZip(cmd: 'a' | 'x' | 't', rest: string[], password: string, ctx: Ctx, onFrac: (f: number) => void) {
  const errs: string[] = [];
  const pw = passwordVia(password, cmd);
  try {
    // Switches go before "--"; anything after it is a file name.
    await run('7z', [cmd, '-bsp1', '-bso0', '-y', ...pw.args, ...rest], {
      signal: ctx.signal,
      okCodes: [1],
      redact: [password],
      input: pw.input,
      onLine(line, stream) {
        if (stream === 'stderr') {
          if (line.trim()) errs.push(line.trim());
          return;
        }
        const m = /^\s*(\d{1,3})%/.exec(line);
        if (m) onFrac(Number(m[1]) / 100);
      },
    });
  } catch (e: any) {
    if (ctx.signal.aborted) throw e;
    const all = [...errs, String(e?.message ?? e)].join(' ').split(password).join('***');
    if (/wrong password|can ?not open encrypted archive/i.test(all)) throw new WrongPassword();
    if (/not enough space|disk full/i.test(all)) throw new UserError('Not enough disk space.');
    if (/is not archive|can ?not open the file as|unexpected end|headers error|unsupported method/i.test(all)) throw new UserError('The archive is damaged or not a supported format.');
    if (/data error|crc failed/i.test(all)) {
      // ZipCrypto archives report a wrong password as a CRC error.
      throw /encrypted/i.test(all) ? new WrongPassword() : new UserError('The archive is damaged.');
    }
    throw new UserError(all.length > 200 ? all.slice(0, 200) + '…' : all);
  }
}

class WrongPassword extends UserError {
  constructor() {
    super('The password is wrong.');
  }
}

const protect: ToolFn = async (inputs, ctx) => {
  const o = (ctx.options ?? {}) as ProtectOptions;
  const password = checkPassword(o.password);
  const mode = o.mode ?? 'zip';
  const outputs: string[] = [];

  if (mode === 'pdf') {
    const pdfs = inputs.filter((p) => !isDir(p) && extOf(p) === 'pdf');
    if (pdfs.length !== inputs.length) throw new UserError('Only PDFs can be protected on their own. Choose ZIP or 7z for other files.');
    const perms = o.permissions ?? { print: true, copy: true, edit: true };
    const restricted = !perms.print || !perms.copy || !perms.edit;
    // Without a separate owner password, use a random one: restrictions then can't be lifted with the open password.
    const owner = o.ownerPassword || (restricted ? randomBytes(24).toString('base64') : password);
    if (o.ownerPassword && o.ownerPassword === password && restricted) {
      throw new UserError('Use a different password for permissions, or leave it empty.');
    }
    for (let i = 0; i < pdfs.length; i++) {
      if (ctx.signal.aborted) throw new Error('Cancelled');
      const src = pdfs[i];
      ctx.progress(i / pdfs.length, basename(src));
      const bytes = await readFile(src);
      let out: Uint8Array;
      try {
        out = await encryptPdf(bytes, password, owner, perms);
      } catch (e: any) {
        if (e instanceof UserError) throw new UserError(`${basename(src)}: ${e.message}`);
        log('pdf encrypt failed', e?.message);
        throw new UserError(`${basename(src)} couldn't be read as a PDF.`);
      }
      const dest = ctx.out(src, 'pdf', ' protected');
      await writeFile(dest, out);
      outputs.push(dest);
    }
    ctx.progress(1);
    return outputs;
  }

  if (!hasBin('7z')) throw new UserError('The archive engine is missing. Reinstall Orange.');
  const missing = inputs.find((p) => !existsSync(p));
  if (missing) throw new UserError(`${basename(missing)} no longer exists.`);
  const ext = mode === '7z' ? '7z' : 'zip';
  const problem = archivePasswordProblem(password, ext);
  if (problem) throw new UserError(problem);
  const out = ctx.out(join(dirname(inputs[0]), `${packName(inputs)}.x`), ext);
  const type = mode === '7z' ? ['-t7z', '-mx=5', '-mhe=on'] : ['-tzip', '-mx=5', '-mem=AES256', '-mcu=on'];
  try {
    await sevenZip('a', [...type, '-mmt=on', '-ssw', '--', out, ...inputs], password, ctx, (f) => ctx.progress(f));
  } catch (e) {
    await rm(out, { force: true });
    throw e;
  }
  return [out];
};

// ==================================================================== unlock

export interface UnlockOptions {
  password: string;
  /** Lets the window ask which files failed (see unlock:report). */
  token?: string;
}

export interface UnlockReport {
  done: string[];
  wrong: string[];
  notLocked: string[];
  failed: { path: string; message: string }[];
}

const reports = new Map<string, UnlockReport>();

async function unlockPdf(src: string, password: string, ctx: Ctx, onFrac: (f: number) => void): Promise<string | 'wrong' | 'plain'> {
  if (!(await pdfIsEncrypted(src))) return 'plain';
  if (!hasBin(GS)) throw new UserError('The PDF engine is missing. Reinstall Orange.');
  const dest = ctx.out(src, 'pdf', ' unlocked');
  const lines: string[] = [];
  try {
    const r = await run(
      bin(GS),
      ['-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dAutoRotatePages=/None', '-dPreserveAnnots=true', `-sPDFPassword=${password}`, `-sOutputFile=${dest}`, src],
      {
        signal: ctx.signal,
        redact: [password],
        onLine(line) {
          lines.push(line);
          const m = /^Page (\d+)/.exec(line);
          if (m) onFrac(Math.min(0.95, Number(m[1]) / 200));
        },
      },
    );
    const all = [...lines, r.stdout, r.stderr].join('\n');
    // Ghostscript exits 0 even when the password is refused; it just writes an empty file.
    if (/Password did not work|requires a password|Cannot decrypt/i.test(all)) {
      await rm(dest, { force: true });
      return 'wrong';
    }
    if (/No pages will be processed|Couldn't initialise file/i.test(all)) {
      await rm(dest, { force: true });
      throw new UserError("The PDF couldn't be read.");
    }
    return dest;
  } catch (e) {
    await rm(dest, { force: true });
    throw e;
  }
}

async function unlockArchive(src: string, password: string, ctx: Ctx, onFrac: (f: number) => void): Promise<string | 'wrong'> {
  if (!hasBin('7z')) throw new UserError('The archive engine is missing. Reinstall Orange.');
  const dir = ctx.outDir(src, archiveStem(src));
  try {
    await sevenZip('x', [`-o${dir}`, '--', src], password, ctx, onFrac);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    if (e instanceof WrongPassword) return 'wrong';
    throw e;
  }
  if (!readdirSync(dir).length) {
    await rm(dir, { recursive: true, force: true });
    throw new UserError('The archive is empty.');
  }
  return dir;
}

const unlock: ToolFn = async (inputs, ctx) => {
  const o = (ctx.options ?? {}) as UnlockOptions;
  const password = checkPassword(o.password);
  const rep: UnlockReport = { done: [], wrong: [], notLocked: [], failed: [] };
  if (o.token) reports.set(o.token, rep);
  for (let i = 0; i < inputs.length; i++) {
    if (ctx.signal.aborted) throw new Error('Cancelled');
    const src = inputs[i];
    const frac = (f: number) => ctx.progress((i + f) / inputs.length);
    ctx.progress(i / inputs.length, basename(src));
    try {
      const r = extOf(src) === 'pdf' ? await unlockPdf(src, password, ctx, frac) : await unlockArchive(src, password, ctx, frac);
      if (r === 'wrong') rep.wrong.push(src);
      else if (r === 'plain') rep.notLocked.push(src);
      else rep.done.push(r);
    } catch (e: any) {
      if (ctx.signal.aborted) throw e;
      rep.failed.push({ path: src, message: e instanceof UserError ? e.message : String(e?.message ?? e) });
    }
  }
  ctx.progress(1);
  if (!rep.done.length) {
    if (rep.wrong.length) throw new UserError(rep.wrong.length === inputs.length ? 'The password is wrong.' : `The password is wrong for ${basename(rep.wrong[0])}.`);
    if (rep.notLocked.length === inputs.length) throw new UserError(inputs.length === 1 ? "This PDF isn't password-protected." : "These PDFs aren't password-protected.");
    if (rep.failed.length) throw new UserError(`${basename(rep.failed[0].path)}: ${rep.failed[0].message}`);
  }
  return rep.done;
};

/** What the Unlock window should know before asking for a password. */
ipcMain.handle('unlock:inspect', async (_e, paths: string[]) =>
  Promise.all(
    paths.map(async (p) => {
      if (extOf(p) !== 'pdf') return { path: p, kind: 'archive' as const, locked: null };
      return { path: p, kind: 'pdf' as const, locked: await pdfIsEncrypted(p).catch(() => null) };
    }),
  ),
);
ipcMain.handle('unlock:report', (_e, token: string) => {
  const r = reports.get(token) ?? null;
  reports.delete(token);
  return r;
});
/** Protect window: is this PDF already encrypted? */
ipcMain.handle('protect:inspect', async (_e, paths: string[]) =>
  Promise.all(paths.map(async (p) => ({ path: p, dir: isDir(p), pdf: extOf(p) === 'pdf', locked: extOf(p) === 'pdf' ? await pdfIsEncrypted(p).catch(() => false) : false }))),
);

export const tools: Record<string, ToolFn> = { rename: renameTool, protect, unlock };

// Exposed for tests.
export const _internal = { planRename, applyRenames, encryptPdf, hash2B, permissionBits, pdfIsEncrypted, invalidName, bestDate };
