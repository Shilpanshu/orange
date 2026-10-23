// Archives with the bundled 7-Zip: extract anything 7-Zip reads (zip, rar, 7z, tar, gz, tgz…),
// repack between formats, and compress files/folders (jobs.ts passes several paths joined by "\n").
import { existsSync, readdirSync, renameSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { run } from '../engines/run';
import type { ConverterModule, Ctx } from './types';
import { UserError } from './types';

type PackTarget = 'zip' | 'tar' | 'gz' | '7z';

const NO_PASSWORD = '-p__orange_no_password__'; // never let 7z sit waiting for a password prompt

/** Run 7z with progress from -bsp1 ("  42% 13 - file") mapped onto [lo, hi]; errors become readable. */
async function sevenZip(args: string[], ctx: Ctx, lo = 0, hi = 1, cwd?: string) {
  const errLines: string[] = [];
  try {
    return await run('7z', [...args, '-bsp1', '-bso0', '-y'], {
      signal: ctx.signal,
      cwd,
      okCodes: [1], // 1 = warnings (e.g. a file was locked); the archive is still fine
      onLine(line, stream) {
        if (stream === 'stderr') {
          if (line.trim()) errLines.push(line.trim());
          return;
        }
        const m = /^\s*(\d{1,3})%/.exec(line);
        if (m) ctx.progress(lo + ((hi - lo) * Number(m[1])) / 100);
      },
    });
  } catch (e: any) {
    if (ctx.signal.aborted) throw e;
    const all = [...errLines, String(e?.message ?? e)].join(' ');
    if (/wrong password|encrypted archive/i.test(all)) throw new UserError('This archive is password-protected.');
    if (/not enough space|disk full|there is not enough space/i.test(all)) throw new UserError('Not enough disk space.');
    if (/is not archive|can ?not open the file as|unexpected end|headers error|data error|crc failed|unsupported method/i.test(all)) {
      throw new UserError('This archive is damaged or not a supported format.');
    }
    throw e;
  }
}

/** "photos.tar.gz" → "photos", "data.tgz" → "data", "x.zip" → "x". */
function archiveStem(p: string): string {
  return basename(p).replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz|zip|rar|7z|tar|gz|bz2|xz)$/i, '') || basename(p);
}

function isTar(file: string): boolean {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(8);
    readSync(fd, buf, 0, 8, 257);
    closeSync(fd);
    return buf.toString('latin1').startsWith('ustar');
  } catch {
    return false;
  }
}

/** Extract `archive` into `dir`; a compressed tarball (.tar.gz, .tgz…) is unpacked all the way. */
async function extractInto(archive: string, dir: string, ctx: Ctx, lo: number, hi: number) {
  // -snl-: skip symbolic links (common in Linux tarballs). Creating one needs admin rights or Developer Mode
  // on Windows, and 7-Zip fails the whole extraction when it can't (or when a link points outside).
  await sevenZip(['x', NO_PASSWORD, '-snl-', `-o${dir}`, archive], ctx, lo, (lo + hi) / 2);
  const items = readdirSync(dir);
  if (items.length === 1 && /\.(gz|tgz|bz2|tbz2?|xz|txz|zst)$/i.test(archive)) {
    const inner = join(dir, items[0]);
    if (statSync(inner).isFile() && (/\.tar$/i.test(inner) || isTar(inner))) {
      await sevenZip(['x', '-snl-', `-o${dir}`, inner], ctx, (lo + hi) / 2, hi);
      rmSync(inner, { force: true });
    }
  }
  ctx.progress(hi);
}

function uniqueBeside(dir: string, name: string): string {
  let p = join(dir, name);
  if (!existsSync(p)) return p;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) {
    p = join(dir, `${stem} ${i}${ext}`);
    if (!existsSync(p)) return p;
  }
}

async function extract(input: string, ctx: Ctx): Promise<string[]> {
  const dir = ctx.outDir(input, archiveStem(input));
  try {
    await extractInto(input, dir, ctx, 0, 0.97);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const items = readdirSync(dir);
  if (items.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new UserError('This archive is empty.');
  }
  if (items.length === 1) {
    // A single file (notes.txt.gz) or a single top-level folder (photos.zip → photos/): put that item next to
    // the archive under its own name instead of wrapping it in another folder.
    const parent = dirname(dir);
    const parked = join(parent, `.orange-${process.pid}-${Date.now()}`);
    renameSync(join(dir, items[0]), parked);
    rmSync(dir, { recursive: true, force: true });
    const dest = uniqueBeside(parent, items[0]);
    renameSync(parked, dest);
    ctx.progress(1);
    return [dest];
  }
  ctx.progress(1);
  return [dir];
}

/**
 * Compress `items` (absolute paths) into a new archive. Each item is stored under its own name.
 * `base` is the output name without extension; the archive goes into the folder ctx.out() picks for `near`.
 */
async function pack(items: string[], target: PackTarget, base: string, near: string, ctx: Ctx, lo = 0): Promise<string> {
  const fake = join(dirname(near), `${base}.x`); // ctx.out() names the result after this path's stem
  const common = ['-mmt=on', '-ssw']; // all cores; also read files other apps have open
  if (target === 'gz') {
    const single = items.length === 1 && statSync(items[0]).isFile();
    if (single) {
      const out = ctx.out(join(dirname(near), basename(items[0]) + '.x'), 'gz');
      await guard(out, () => sevenZip(['a', '-tgzip', '-mx=6', ...common, out, items[0]], ctx, lo, 1));
      return out;
    }
    // Several files or a folder: a .tar.gz, built as tar in temp then gzipped.
    const tar = join(ctx.tmp(), `${base}.tar`);
    await sevenZip(['a', '-ttar', ...common, tar, ...items], ctx, lo, lo + (1 - lo) * 0.4);
    const out = ctx.out(join(dirname(near), `${base}.tar.x`), 'gz');
    await guard(out, () => sevenZip(['a', '-tgzip', '-mx=6', ...common, out, tar], ctx, lo + (1 - lo) * 0.4, 1));
    return out;
  }
  const out = ctx.out(fake, target);
  const type = { zip: ['-tzip', '-mx=5', '-mcu=on'], tar: ['-ttar'], '7z': ['-t7z', '-mx=5'] }[target];
  await guard(out, () => sevenZip(['a', ...type, ...common, out, ...items], ctx, lo, 1));
  return out;
}

/** Remove a half-written archive if anything goes wrong (including cancel). */
async function guard(out: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    rmSync(out, { force: true });
    throw e;
  }
}

async function repack(input: string, target: PackTarget, ctx: Ctx): Promise<string[]> {
  const work = ctx.tmp();
  await extractInto(input, work, ctx, 0, 0.5);
  const items = readdirSync(work).map((n) => join(work, n));
  if (!items.length) throw new UserError('This archive is empty.');
  return [await pack(items, target, archiveStem(input), input, ctx, 0.5)];
}

function listName(paths: string[]): string {
  if (paths.length === 1) {
    const p = paths[0];
    const b = basename(p);
    if (statSync(p).isDirectory()) return b;
    const dot = b.lastIndexOf('.');
    return dot > 0 ? b.slice(0, dot) : b;
  }
  const parent = basename(dirname(paths[0]));
  return parent ? `Archive (${parent})` : 'Archive';
}

export const converter: ConverterModule = {
  kinds: ['archive'],
  async convert(input, target, ctx) {
    const paths = input.split('\n').map((s) => s.trim()).filter(Boolean);
    const missing = paths.filter((p) => !existsSync(p));
    if (missing.length) throw new UserError(`${basename(missing[0])} no longer exists.`);
    if (!['extract', 'zip', 'tar', 'gz', '7z'].includes(target)) throw new UserError(`Can't make a ${target.toUpperCase()} archive.`);

    // Several items, a folder, or a non-archive file: compress them into one archive.
    const single = paths.length === 1 ? paths[0] : undefined;
    const isArchive = !!single && statSync(single).isFile() && /\.(zip|tar|gz|tgz|rar|7z|bz2|xz|tbz2?|txz)$/i.test(single);
    if (target === 'extract') {
      if (!isArchive) throw new UserError('That is not an archive.');
      return extract(single!, ctx);
    }
    if (isArchive) return repack(single!, target as PackTarget, ctx);
    return [await pack(paths, target as PackTarget, listName(paths), paths[0], ctx)];
  },
};
