// Builds the Windows installer, optionally code-signs it and publishes it to GitHub Releases.
//
//   node scripts/dist.mjs              build release/Orange-Setup-<version>.exe
//   node scripts/dist.mjs --publish    also upload installer + latest.yml to GitHub Releases
//                                      (needs GH_TOKEN with repo scope; the auto-updater reads latest.yml)
//
// Code signing (optional, picked automatically from the environment):
//   Azure Trusted Signing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
//                          AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE,
//                          AZURE_SIGN_PUBLISHER (must match the certificate's subject CN)
//   Classic certificate:   CSC_LINK (path/base64 of a .pfx) + CSC_KEY_PASSWORD
//   Neither set:           builds unsigned (SmartScreen will warn on install).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

const publish = process.argv.includes('--publish');
const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};
delete env.ELECTRON_RUN_AS_NODE;

const args = ['--win', '--x64', '--publish', publish ? 'always' : 'never'];

const azure = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_SIGN_PUBLISHER'];
if (azure.every((k) => env[k])) {
  console.log('Signing with Azure Trusted Signing');
  args.push(
    `-c.win.azureSignOptions.endpoint=${env.AZURE_SIGN_ENDPOINT}`,
    `-c.win.azureSignOptions.codeSigningAccountName=${env.AZURE_SIGN_ACCOUNT}`,
    `-c.win.azureSignOptions.certificateProfileName=${env.AZURE_SIGN_PROFILE}`,
    `-c.win.azureSignOptions.publisherName=${env.AZURE_SIGN_PUBLISHER}`,
  );
} else if (env.CSC_LINK) {
  console.log('Signing with the certificate in CSC_LINK');
} else {
  console.log('No signing credentials found: building unsigned');
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

if (publish && !env.GH_TOKEN) {
  console.error('Publishing needs GH_TOKEN (a GitHub token with repo scope).');
  process.exit(1);
}

// The installer ships ffmpeg/ffprobe compressed (scripts/vendor/media.mjs makes the archives).
const bin = join(root, 'vendor', 'bin');
for (const f of ['ffmpeg.exe.zst', 'ffprobe.exe.from-ffmpeg.zst', 'pandoc.exe.zst']) {
  if (!existsSync(join(bin, f))) {
    console.error(`vendor/bin/${f} is missing. Run "npm run vendor" first.`);
    process.exit(1);
  }
}

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env });
// The helper only needs rebuilding when its source changed (and a running copy would lock the exe).
const helperExe = join(bin, 'orange-helper.exe');
const helperSrc = join(root, 'src', 'helper', 'OrangeHelper.cs');
if (!existsSync(helperExe) || statSync(helperExe).mtimeMs < statSync(helperSrc).mtimeMs) run('node scripts/build-helper.mjs');
else console.log('orange-helper.exe is up to date');
run('node scripts/build.mjs');

// The AI engine (transformers.js + onnxruntime-node) is left out of the installer and downloaded on the
// first AI job (src/main/engines/ai.ts). Pin exactly what package-lock.json resolved, checksums included.
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const AI_RUNTIME = ['onnxruntime-node', 'onnxruntime-common', '@huggingface/transformers'];
const packages = AI_RUNTIME.map((name) => {
  const e = lock.packages?.[`node_modules/${name}`];
  if (!e?.version || !e.resolved || !e.integrity) throw new Error(`package-lock.json has no resolved/integrity for ${name}`);
  return { name, version: e.version, url: e.resolved, integrity: e.integrity };
});
writeFileSync(join(root, 'dist', 'ai-runtime.json'), JSON.stringify({ packages }, null, 1));
console.log(`AI engine pinned: ${packages.map((p) => `${p.name}@${p.version}`).join(', ')}`);

run(`npx electron-builder ${args.join(' ')}`);
