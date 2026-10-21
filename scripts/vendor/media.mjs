// Fetches the media command-line tools Orange ships into vendor/bin:
//   ffmpeg.exe + ffprobe.exe      gyan.dev "release essentials" static build (x264, x265, vpx, aom, lame, opus, vorbis, webp)
//   7z.exe + 7z.dll               full 7-Zip (RAR extraction included), unpacked from the official x64 installer
//   imagemagick/magick.exe        ImageMagick portable Q16 x64 (HEIC/JXL/SVG/ICO read, BMP/ICO write)
//
// Usage: node scripts/vendor/media.mjs [--force] [--force=ffmpeg,7z,magick]
// Idempotent: a tool that is already present and passes its self-check is skipped.
// Mirrors: github.com release assets are not used (they time out on some networks); SourceForge and the
// vendors' own sites are.
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const binDir = join(root, 'vendor', 'bin');
const magickDir = join(binDir, 'imagemagick');

const forceArg = process.argv.find((a) => a.startsWith('--force'));
const forced = (name) => forceArg === '--force' || (forceArg?.split('=')[1] ?? '').split(',').includes(name);

const UA = 'Wget/1.21.4'; // SourceForge serves the file (not a "your download will start" page) to plain clients.
const work = mkdtempSync(join(tmpdir(), 'orange-vendor-'));
const done = [];

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// curl.exe ships with Windows 10+. It copes with SourceForge's slow-to-connect mirrors better than fetch()
// (undici gives up after a 10 s connect timeout), so prefer it.
const curl = [join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'curl.exe'), 'curl'].find((c) => {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

function checkMagic(dest, magic) {
  const head = readFileSync(dest).subarray(0, 8);
  if (magic && !magic.some((m) => head.subarray(0, m.length).equals(m))) {
    throw new Error(`unexpected content (got "${head.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}", probably an HTML page)`);
  }
}

async function download(urls, dest, magic) {
  const errors = [];
  for (const url of [urls].flat()) {
    if (curl) {
      try {
        process.stdout.write(`  ↓ ${url}\n`);
        execFileSync(
          curl,
          ['-fL', '-A', UA, '--connect-timeout', '60', '--retry', '4', '--retry-all-errors', '--max-time', '1800', '-o', dest, url],
          { stdio: ['ignore', 'ignore', process.stdout.isTTY ? 'inherit' : 'ignore'], windowsHide: true },
        );
        checkMagic(dest, magic);
        console.log(`    ${mb(statSync(dest).size)} ok`);
        return dest;
      } catch (e) {
        errors.push(`${url}: ${e.message.split('\n')[0]}`);
        console.log(`    failed: ${e.message.split('\n')[0]}`);
        continue;
      }
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        process.stdout.write(`  ↓ ${url}\n`);
        const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        let got = 0;
        let last = 0;
        const body = Readable.fromWeb(res.body);
        body.on('data', (c) => {
          got += c.length;
          if (process.stdout.isTTY && Date.now() - last > 500) {
            last = Date.now();
            process.stdout.write(`\r    ${mb(got)}${total ? ` / ${mb(total)}` : ''}   `);
          }
        });
        await pipeline(body, createWriteStream(dest));
        if (process.stdout.isTTY) process.stdout.write('\r');
        checkMagic(dest, magic);
        console.log(`    ${mb(statSync(dest).size)} ok`);
        return dest;
      } catch (e) {
        errors.push(`${url} (try ${attempt}): ${e.message}`);
        console.log(`    failed: ${e.message}`);
      }
    }
  }
  throw new Error(`Could not download ${basename(dest)}:\n  ${errors.join('\n  ')}`);
}

const MAGIC = {
  pe: [Buffer.from('MZ')],
  zip: [Buffer.from('PK\x03\x04', 'latin1')],
  sevenZ: [Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
};

async function text(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

function cmpVersion(a, b) {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Newest version folder listed on a SourceForge files page, e.g. "26.04" or "7.1.2-34". */
async function sourceforgeLatest(project, sub, re) {
  const html = await text(`https://sourceforge.net/projects/${project}/files/${sub}`);
  const versions = [...new Set([...html.matchAll(re)].map((m) => m[1]))].sort(cmpVersion);
  return versions.at(-1);
}

function sh(exe, args) {
  return execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    } else if (e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}

// ----------------------------------------------------------------------------- 7-Zip

const sevenZ = join(binDir, '7z.exe');

function sevenZipOk() {
  if (!existsSync(sevenZ) || !existsSync(join(binDir, '7z.dll'))) return false;
  try {
    return /\bRar5?\b/.test(sh(sevenZ, ['i']));
  } catch {
    return false;
  }
}

async function ensure7z() {
  if (sevenZipOk() && !forced('7z')) return console.log(`✓ 7-Zip already in vendor/bin`);
  console.log('• 7-Zip');
  // 7zr.exe (standalone, 7z-format only) is served directly by 7-zip.org and can unpack the installer.
  const sevenZr = await download(['https://www.7-zip.org/a/7zr.exe'], join(work, '7zr.exe'), MAGIC.pe);
  const ver = (await sourceforgeLatest('sevenzip', '7-Zip/', /files\/7-Zip\/(\d+\.\d+)\//g)) ?? '26.00';
  const tag = ver.replace('.', '');
  const installer = await download(
    [
      `https://downloads.sourceforge.net/project/sevenzip/7-Zip/${ver}/7z${tag}-x64.exe`,
      `https://www.7-zip.org/a/7z${tag}-x64.exe`,
    ],
    join(work, `7z${tag}-x64.exe`),
    MAGIC.pe,
  );
  const out = join(work, '7z');
  sh(sevenZr, ['x', '-y', `-o${out}`, installer]);
  mkdirSync(binDir, { recursive: true });
  for (const f of ['7z.exe', '7z.dll']) copyFileSync(join(out, f), join(binDir, f));
  copyFileSync(join(out, 'License.txt'), join(binDir, '7z-License.txt'));
  if (!sevenZipOk()) throw new Error('7-Zip was unpacked but `7z i` does not list RAR support.');
  done.push(`7-Zip ${ver} → vendor/bin/7z.exe + 7z.dll`);
}

// ----------------------------------------------------------------------------- ffmpeg

// The hardware H.264/HEVC encoders are used for GPU encoding (src/main/engines/ffmpeg.ts → gpuEncoder()).
//
// Why the static "essentials" build and not a shared one: ffmpeg.exe + ffprobe.exe each carry the
// libraries (~100 MB apiece), but gyan.dev only publishes a shared build of its *full* configuration,
// whose DLLs alone are ~240 MB (avfilter 107 MB, avcodec 98 MB; measured with 9.0.2), more than the
// two essentials exes together. Revisit if an essentials-shared build appears.
const NEEDED_ENCODERS = [
  'libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'libmp3lame', 'libopus', 'libvorbis', 'wmav2', 'wmv2', 'libwebp', 'aac', 'flac', 'gif',
  'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf',
];

function ffmpegOk() {
  const ff = join(binDir, 'ffmpeg.exe');
  if (!existsSync(ff) || !existsSync(join(binDir, 'ffprobe.exe'))) return false;
  try {
    const enc = sh(ff, ['-hide_banner', '-encoders']);
    const missing = NEEDED_ENCODERS.filter((e) => !new RegExp(`\\s${e.replace(/[-]/g, '\\-')}\\s`).test(enc));
    if (missing.length) console.log(`  existing ffmpeg lacks: ${missing.join(', ')}`);
    return missing.length === 0;
  } catch {
    return false;
  }
}

async function ensureFfmpeg() {
  if (ffmpegOk() && !forced('ffmpeg')) return console.log('✓ ffmpeg/ffprobe already in vendor/bin');
  console.log('• ffmpeg (gyan.dev release essentials)');
  const ver = (await text('https://www.gyan.dev/ffmpeg/builds/release-version')).trim();
  const urls = [
    ...(/^\d+(\.\d+)+$/.test(ver) ? [`https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${ver}-essentials_build.zip`] : []),
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  ];
  const zip = await download(urls, join(work, 'ffmpeg.zip'), MAGIC.zip);
  const out = join(work, 'ffmpeg');
  // Windows' bsdtar reads zip; the 7z we just placed works too.
  if (existsSync(sevenZ)) sh(sevenZ, ['x', '-y', `-o${out}`, zip]);
  else {
    mkdirSync(out, { recursive: true });
    sh('tar', ['-xf', zip, '-C', out]);
  }
  for (const f of ['ffmpeg.exe', 'ffprobe.exe']) {
    const src = findFile(out, f);
    if (!src) throw new Error(`${f} not found inside ${basename(zip)}`);
    copyFileSync(src, join(binDir, f));
  }
  const lic = findFile(out, 'LICENSE');
  if (lic) copyFileSync(lic, join(binDir, 'ffmpeg-LICENSE.txt'));
  if (!ffmpegOk()) throw new Error('ffmpeg was installed but is missing required encoders (see above).');
  done.push(`ffmpeg ${ver || '(release)'} essentials → vendor/bin/ffmpeg.exe + ffprobe.exe`);
}

// ----------------------------------------------------------------------------- ImageMagick

const magick = join(magickDir, 'magick.exe');

function magickOk() {
  if (!existsSync(magick)) return false;
  try {
    const formats = sh(magick, ['-list', 'format']);
    return /^\s*HEIC\*?\s+r/m.test(formats) && /^\s*BMP\*?\s+rw/m.test(formats);
  } catch {
    return false;
  }
}

async function ensureMagick() {
  if (magickOk() && !forced('magick')) return console.log('✓ ImageMagick already in vendor/bin/imagemagick');
  console.log('• ImageMagick portable Q16 x64');
  const ver =
    (await sourceforgeLatest('imagemagick', '', /files\/(7\.\d+\.\d+-\d+)\//g)) ??
    (() => {
      throw new Error('Could not find the latest ImageMagick version on sourceforge.net/projects/imagemagick/files/.');
    })();
  const name = `ImageMagick-${ver}-portable-Q16-x64.7z`;
  const archive = await download(
    [
      `https://downloads.sourceforge.net/project/imagemagick/${ver}/${name}`,
      `https://imagemagick.org/archive/binaries/${name}`,
    ],
    join(work, name),
    MAGIC.sevenZ,
  );
  if (!existsSync(sevenZ)) throw new Error('7z.exe is needed to unpack ImageMagick; run the 7-Zip step first.');
  const out = join(work, 'im');
  sh(sevenZ, ['x', '-y', `-o${out}`, archive]);
  rmSync(magickDir, { recursive: true, force: true });
  mkdirSync(magickDir, { recursive: true });
  // The portable build is one static exe per tool; `magick` covers them all. Keep its config files.
  for (const f of readdirSync(out)) {
    if (f.toLowerCase() === 'magick.exe' || /\.(xml|icc)$/i.test(f) || /^(LICENSE|NOTICE)/i.test(f)) {
      copyFileSync(join(out, f), join(magickDir, f));
    }
  }
  if (!magickOk()) throw new Error('ImageMagick was unpacked but `magick -list format` lacks HEIC read or BMP write.');
  done.push(`ImageMagick ${ver} → vendor/bin/imagemagick/magick.exe`);
}

// ----------------------------------------------------------------------------- main

try {
  mkdirSync(binDir, { recursive: true });
  await ensure7z();
  await ensureFfmpeg();
  await ensureMagick();
  console.log(done.length ? `\nInstalled:\n  ${done.join('\n  ')}` : '\nAll media tools present.');
} catch (e) {
  console.error(`\n✗ ${e.message}\n\nCheck your connection (gyan.dev, 7-zip.org and sourceforge.net must be reachable), then run again.`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
