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

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env });
run('node scripts/build-helper.mjs');
run('node scripts/build.mjs');
run(`npx electron-builder ${args.join(' ')}`);
