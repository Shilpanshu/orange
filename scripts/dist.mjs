// Builds the Windows installer. Routes electron-builder downloads through the npm mirror
// because GitHub release downloads are unreliable on some networks.
import { execSync } from 'node:child_process';

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};
delete env.ELECTRON_RUN_AS_NODE;
const run = (cmd) => execSync(cmd, { stdio: 'inherit', env });
run('node scripts/build-helper.mjs');
run('node scripts/build.mjs');
run('npx electron-builder --win --x64 --publish never');
