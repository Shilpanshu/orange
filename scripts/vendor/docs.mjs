// Fetches the document tool-chain into vendor/bin:
//   vendor/bin/pandoc.exe             - from the pypandoc_binary wheel on PyPI (a plain zip)
//   vendor/bin/gs/bin/gswin64c.exe    - Ghostscript from conda-forge (a .conda = zip of tar.zst),
//                                       plus the MSVC runtime DLLs it links against.
// GitHub release downloads are unreliable on some networks; PyPI and anaconda.org are not.
// Idempotent: anything already in place is skipped. Usage: node scripts/vendor/docs.mjs [--force]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
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

async function pandoc() {
  const exe = join(binDir, 'pandoc.exe');
  if (existsSync(exe) && !force) return console.log('pandoc: present');
  console.log('pandoc:');
  const zip = await JSZip.loadAsync(await download(PANDOC, 'pypandoc_binary wheel'));
  const entry = Object.keys(zip.files).find((n) => /(^|\/)pandoc\.exe$/i.test(n));
  if (!entry) throw new Error('pandoc.exe not found in the wheel');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(exe + '.part', await zip.file(entry).async('nodebuffer'));
  renameSync(exe + '.part', exe);
  console.log('  ' + execFileSync(exe, ['--version']).toString().split(/\r?\n/)[0]);
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
  if (!existsSync(pandocNotice) || force) {
    writeFileSync(
      pandocNotice,
      [
        'Pandoc (pandoc.exe) is distributed unmodified with Orange.',
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
    console.log('pandoc licence notice: written');
  }
}

await pandoc();
await ghostscript();
await licences();
console.log('docs vendor: done');
