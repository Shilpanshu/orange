// electron-builder afterPack hook (package.json build.afterPack): trims the packaged app before it is
// signed and compressed into the installer.
//
// dxcompiler.dll (26 MB): Microsoft's DXC shader compiler, which Chromium loads only for WebGPU on Direct3D 12.
// Orange's pages never use WebGPU (WebGL, canvas and WebAssembly don't need it; ANGLE compiles with
// d3dcompiler_47.dll, which stays), and Dawn falls back to that compiler when DXC is absent anyway.
const { existsSync, rmSync, statSync } = require('node:fs');
const { join } = require('node:path');

const DROP = ['dxcompiler.dll'];

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  for (const f of DROP) {
    const p = join(context.appOutDir, f);
    if (!existsSync(p)) continue;
    const mb = (statSync(p).size / 1048576).toFixed(1);
    rmSync(p, { force: true });
    console.log(`  • afterPack: removed ${f} (${mb} MB)`);
  }
};
