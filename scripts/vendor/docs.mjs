// Fetches the document tool-chain into vendor/bin:
//   vendor/bin/pandoc.exe             - from the pypandoc_binary wheel on PyPI (a plain zip), with its
//                                       62 MB COFF symbol table stripped (never loaded at run time)
//   vendor/bin/pandoc.exe.zst         - the same exe, zstd-compressed (~22 MB). This is what the installer
//                                       ships; Orange unpacks it on the first document conversion
//                                       (src/main/engines/pandoc.ts). pandoc.exe itself is for `npm start`.
//   vendor/bin/gs/bin/gswin64c.exe    - Ghostscript from conda-forge (a .conda = zip of tar.zst),
//                                       plus the MSVC runtime DLLs it links against.
// GitHub release downloads are unreliable on some networks; PyPI and anaconda.org are not.
// Idempotent: anything already in place is skipped. Usage: node scripts/vendor/docs.mjs [--force]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { constants as zc, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const binDir = join(root, 'vendor', 'bin');
const force = process.argv.includes('--force');

const PANDOC = {
  url: 'https://files.pythonhosted.org/packages/c6/b9/f47b77ba75ed5d47ec85fcc2ecfbf7f78e3a73347f3a09836634d930de98/pypandoc_binary-1.17-py3-none-win_amd64.whl',
  sha256: '76fae066cd2d7e78fb97f0ec8e9e36f437b07187b689b0b415ca18216f8f898a',
};
const GHOSTSCRIPT = {
  url: 'https://conda.anaconda.org/conda-forge/win-64/ghostscript-10.08.0-hac47afa_0.conda',
  sha256: '512be9413c58b0ad3a2cd95a63eaea73cbe32d9a6b9170c848bf825694a4adb0',
};
const VCRUNTIME = {
  url: 'https://conda.anaconda.org/conda-forge/win-64/vc14_runtime-14.44.35208-h818238b_41.conda',
  sha256: 'ec706fe9368b837fbd05af4851f5ebef12bef8c471a273f4805f7af788407317',
};

async function download(spec, label) {
  const cache = join(tmpdir(), 'orange-vendor-cache');
  mkdirSync(cache, { recursive: true });
  const file = join(cache, spec.url.split('/').pop());
  if (existsSync(file) && sha256(readFileSync(file)) === spec.sha256) return readFileSync(file);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      process.stdout.write(`  downloading ${label} (attempt ${attempt})… `);
      const res = await fetch(spec.url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      if (got !== spec.sha256) throw new Error(`checksum mismatch (${got})`);
      writeFileSync(file, buf);
      console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
      return buf;
    } catch (e) {
      lastErr = e;
      console.log(`failed: ${e.message}`);
    }
  }
  throw new Error(`Could not download ${label}: ${lastErr?.message}`);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Minimal ustar/pax reader: returns [{name, data}] for regular files. */
function untar(buf) {
  const files = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const str = (a, b) => hdr.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type === '0' || type === '\0') files.push({ name, data: Buffer.from(data) });
  }
  return files;
}

/** A .conda package is a zip holding pkg-*.tar.zst; return its files. */
async function condaFiles(buf) {
  const zip = await JSZip.loadAsync(buf);
  const pkg = Object.keys(zip.files).find((n) => /^pkg-.*\.tar\.zst$/.test(n));
  if (!pkg) throw new Error('not a .conda package');
  const zst = await zip.file(pkg).async('nodebuffer');
  return untar(zstdDecompressSync(zst));
}

function writeFiles(files, destRoot, mapName) {
  let n = 0;
  for (const f of files) {
    const rel = mapName(f.name);
    if (!rel) continue;
    const dest = join(destRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.data);
    n++;
  }
  return n;
}

/**
 * Removes the COFF symbol table and the DWARF debug sections GNU ld leaves at the end of a PE image,
 * like `strip --strip-debug`: none of it is mapped into memory, so the program runs exactly the same.
 * An Authenticode signature (which can't survive any edit) is dropped with it. Returns null when there
 * is nothing to strip.
 */
function stripPe(buf) {
  if (buf.toString('latin1', 0, 2) !== 'MZ') throw new Error('not a PE file');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('bad PE signature');
  const coff = pe + 4;
  const nsec = buf.readUInt16LE(coff + 2);
  const symPtr = buf.readUInt32LE(coff + 8);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  if (buf.readUInt16LE(opt) !== 0x20b) throw new Error('not a PE32+ image');
  if (!symPtr) return null;
  const secAlign = buf.readUInt32LE(opt + 32);
  const dirs = opt + 112;
  const nDirs = buf.readUInt32LE(opt + 108);
  const certOff = nDirs > 4 ? buf.readUInt32LE(dirs + 32) : 0;
  const certSize = nDirs > 4 ? buf.readUInt32LE(dirs + 36) : 0;
  const secs = [];
  for (let i = 0, h = opt + optSize; i < nsec; i++, h += 40) {
    secs.push({
      h,
      name: buf.toString('latin1', h, h + 8).replace(/\0.*$/s, ''),
      vsize: buf.readUInt32LE(h + 8),
      va: buf.readUInt32LE(h + 12),
      rawSize: buf.readUInt32LE(h + 16),
      rawPtr: buf.readUInt32LE(h + 20),
      flags: buf.readUInt32LE(h + 36),
    });
  }
  // Debug sections have string-table names ("/4", "/18"...), are discardable and come last.
  let keep = secs.length;
  while (keep > 0 && secs[keep - 1].name.startsWith('/') && secs[keep - 1].flags & 0x02000000) keep--;
  const kept = secs.slice(0, keep);
  const dropped = secs.slice(keep);
  const dataEnd = Math.max(...kept.map((s) => s.rawPtr + s.rawSize));
  if (dropped.some((s) => s.rawSize && s.rawPtr < dataEnd)) throw new Error('debug sections are not at the end');
  if (symPtr < dataEnd) throw new Error('symbol table is not at the end');
  if (certSize && (certOff < symPtr || certOff + certSize !== buf.length)) throw new Error('unexpected signature layout');
  const end = Math.min(symPtr, ...dropped.filter((s) => s.rawSize).map((s) => s.rawPtr));
  const out = Buffer.from(buf.subarray(0, end));
  for (const s of dropped) out.fill(0, s.h, s.h + 40);
  out.writeUInt16LE(keep, coff + 2);
  out.writeUInt32LE(0, coff + 8); // PointerToSymbolTable
  out.writeUInt32LE(0, coff + 12); // NumberOfSymbols
  if (certSize) out.fill(0, dirs + 32, dirs + 40);
  const last = kept[kept.length - 1];
  out.writeUInt32LE(Math.ceil((last.va + Math.max(last.vsize, last.rawSize)) / secAlign) * secAlign, opt + 56); // SizeOfImage
  // Keep the header checksum valid (Windows only checks it for drivers, but tools look at it).
  out.writeUInt32LE(0, opt + 64);
  let sum = 0;
  for (let i = 0; i + 1 < out.length; i += 2) {
    sum += out.readUInt16LE(i);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (out.length & 1) sum += out[out.length - 1];
  sum = (sum & 0xffff) + (sum >>> 16);
  out.writeUInt32LE((sum + out.length) >>> 0, opt + 64);
  return { buf: out, unsigned: certSize > 0 };
}

/** zstd at its strongest setting with a 128 MB window (pandoc.exe: 169 MB -> ~22 MB, unpacks in ~0.5 s). */
function zstdPack(buf) {
  return zstdCompressSync(buf, {
    params: {
      [zc.ZSTD_c_compressionLevel]: 19,
      [zc.ZSTD_c_windowLog]: 27,
      [zc.ZSTD_c_enableLongDistanceMatching]: 1,
      [zc.ZSTD_c_checksumFlag]: 1,
    },
  });
}

async function pandoc() {
  const exe = join(binDir, 'pandoc.exe');
  const packed = exe + '.zst';
  if (!existsSync(exe) || force) {
    console.log('pandoc:');
    const zip = await JSZip.loadAsync(await download(PANDOC, 'pypandoc_binary wheel'));
    const entry = Object.keys(zip.files).find((n) => /(^|\/)pandoc\.exe$/i.test(n));
    if (!entry) throw new Error('pandoc.exe not found in the wheel');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(exe + '.part', await zip.file(entry).async('nodebuffer'));
    renameSync(exe + '.part', exe);
  } else console.log('pandoc: present');

  const raw = readFileSync(exe);
  const stripped = stripPe(raw);
  if (stripped) {
    writeFileSync(exe + '.part', stripped.buf);
    renameSync(exe + '.part', exe);
    const mb = (n) => (n / 1e6).toFixed(1);
    console.log(`  stripped debug symbols: ${mb(raw.length)} MB -> ${mb(stripped.buf.length)} MB` + (stripped.unsigned ? ' (signature removed)' : ''));
  }
  console.log('  ' + execFileSync(exe, ['--version']).toString().split(/\r?\n/)[0]);

  if (!existsSync(packed) || force || statSync(packed).mtimeMs < statSync(exe).mtimeMs) {
    process.stdout.write('  compressing for the installer (zstd -19, takes a minute or two)... ');
    const body = readFileSync(exe);
    const z = zstdPack(body);
    const back = zstdDecompressSync(z, { params: { [zc.ZSTD_d_windowLogMax]: 27 } });
    if (!back.equals(body)) throw new Error('pandoc.exe.zst does not round-trip');
    writeFileSync(packed + '.part', z);
    renameSync(packed + '.part', packed);
    console.log(`${(z.length / 1e6).toFixed(1)} MB`);
  }
}

async function ghostscript() {
  const gsRoot = join(binDir, 'gs');
  const exe = join(gsRoot, 'bin', 'gswin64c.exe');
  if (existsSync(exe) && !force) return console.log('ghostscript: present');
  console.log('ghostscript:');
  const staging = gsRoot + '.part';
  rmSync(staging, { recursive: true, force: true });
  // conda layout: Library/bin/*.exe|dll, Library/share/ghostscript/** (fonts/resources, if any)
  const gsFiles = await condaFiles(await download(GHOSTSCRIPT, 'ghostscript (conda-forge)'));
  const n = writeFiles(gsFiles, staging, (name) => {
    const m = /^Library\/(bin|lib|share)\/(.*)$/.exec(name);
    if (!m) return null;
    if (m[1] === 'bin' && !/\.(exe|dll)$/i.test(m[2])) return null;
    if (m[1] === 'lib' && !/\.dll$/i.test(m[2])) return null;
    return `${m[1]}/${m[2]}`;
  });
  // gswin64c links against the VC++ runtime; ship it alongside so it runs on clean machines.
  const vcFiles = await condaFiles(await download(VCRUNTIME, 'MSVC runtime (conda-forge)'));
  writeFiles(vcFiles, join(staging, 'bin'), (name) => {
    const m = /^(?:Library\/bin\/)?([^/]+\.dll)$/i.exec(name);
    return m && /^(vcruntime140(_1)?|msvcp140(_1|_2|_atomic_wait|_codecvt_ids)?|concrt140)\.dll$/i.test(m[1]) ? m[1] : null;
  });
  rmSync(gsRoot, { recursive: true, force: true });
  renameSync(staging, gsRoot);
  console.log(`  ${n} files; ` + execFileSync(exe, ['--version']).toString().trim());
}

/** Ship licence notices next to the binaries (GPL/AGPL require it). */
async function licences() {
  // Ghostscript: the conda package carries its licence under info/licenses in info-*.tar.zst.
  const gsLicence = join(binDir, 'gs', 'LICENSE.txt');
  if (!existsSync(gsLicence) || force) {
    const zip = await JSZip.loadAsync(await download(GHOSTSCRIPT, 'ghostscript (conda-forge)'));
    const info = Object.keys(zip.files).find((n) => /^info-.*\.tar\.zst$/.test(n));
    const files = info ? untar(zstdDecompressSync(await zip.file(info).async('nodebuffer'))) : [];
    const lic = files.filter((f) => /^info\/licenses\//.test(f.name) && f.data.length);
    if (lic.length) {
      writeFileSync(gsLicence, Buffer.concat(lic.flatMap((f) => [Buffer.from(`==== ${f.name.replace(/^info\/licenses\//, '')} ====\n`), f.data, Buffer.from('\n\n')])));
      console.log(`ghostscript licence: ${lic.length} file(s)`);
    } else console.warn('ghostscript licence: not found in package');
  }
  // Pandoc: the PyPI wheel has no licence file, so point to the canonical text and source.
  const pandocNotice = join(binDir, 'pandoc-LICENSE.txt');
  {
    writeFileSync(
      pandocNotice,
      [
        'Pandoc (pandoc.exe) is distributed with Orange. Its code is unmodified: only the debugging symbol',
        'table was removed to save space, and it is stored zstd-compressed until first use.',
        'Copyright (C) John MacFarlane and contributors.',
        '',
        'Licence: GNU General Public License, version 2 or (at your option) any later version.',
        'Full licence text: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt',
        'Pandoc licence and copyright notes: https://github.com/jgm/pandoc/blob/main/COPYRIGHT',
        'Source code for this exact version: https://github.com/jgm/pandoc/releases',
        '',
        'Obtained from the pypandoc_binary wheel on PyPI: https://pypi.org/project/pypandoc-binary/',
        '',
      ].join('\n'),
    );
    console.log('pandoc licence notice: up to date');
  }
}

await pandoc();
await ghostscript();
await licences();
console.log('docs vendor: done');
