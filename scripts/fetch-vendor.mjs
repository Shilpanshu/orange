// Fetches every bundled command-line tool into vendor/bin by running scripts/vendor/*.mjs.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dir = join(root, 'scripts', 'vendor');
for (const f of readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
  console.log(`\n== ${f}`);
  await import(pathToFileURL(join(dir, f)).href);
}
