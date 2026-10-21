// Compiles src/helper/OrangeHelper.cs with the csc.exe bundled in every Windows install.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fw = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = join(fw, 'csc.exe');
if (!existsSync(csc)) throw new Error(`csc.exe not found at ${csc}`);
const outDir = join(root, 'vendor', 'bin');
// WinRT (share sheet): the Windows metadata files plus the .NET Framework facades they need.
const winmd = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WinMetadata');
const winrtRefs = ['Windows.Foundation', 'Windows.Storage', 'Windows.ApplicationModel']
  .map((n) => join(winmd, `${n}.winmd`))
  .filter((p) => existsSync(p))
  .map((p) => `/r:${p}`);
const fwRefs = ['System.Runtime.dll', 'System.Runtime.InteropServices.WindowsRuntime.dll']
  .map((n) => join(fw, n))
  .filter((p) => existsSync(p))
  .map((p) => `/r:${p}`);
mkdirSync(outDir, { recursive: true });
execFileSync(
  csc,
  [
    '/nologo',
    '/optimize+',
    '/target:winexe',
    `/out:${join(outDir, 'orange-helper.exe')}`,
    '/r:System.Windows.Forms.dll',
    '/r:System.Web.Extensions.dll',
    '/r:Microsoft.CSharp.dll',
    '/r:System.Core.dll',
    '/r:System.Drawing.dll',
    ...fwRefs,
    ...winrtRefs,
    join(root, 'src', 'helper', 'OrangeHelper.cs'),
  ],
  { stdio: 'inherit' },
);
console.log('built orange-helper.exe');
