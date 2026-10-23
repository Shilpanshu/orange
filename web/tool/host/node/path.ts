// node:path (win32 flavour): what the ported code uses.
export const sep = '\\';
export const delimiter = ';';

function splitRoot(p: string): [string, string] {
  p = p.replace(/\//g, '\\');
  const m = /^\\\\[?.]\\[A-Za-z]:\\?/.exec(p) || /^\\\\[^\\]+\\[^\\]+\\?/.exec(p) || /^[A-Za-z]:\\?/.exec(p) || /^\\/.exec(p);
  if (!m) return ['', p];
  return [m[0], p.slice(m[0].length)];
}

export function normalize(p: string): string {
  if (!p) return '.';
  const [root, rest] = splitRoot(p);
  const abs = /\\$/.test(root);
  const out: string[] = [];
  for (const part of rest.split('\\')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(part);
  }
  let r = root + out.join('\\');
  if (!r) r = '.';
  if (/[\\/]$/.test(p) && out.length) r += '\\';
  return r;
}

export function join(...parts: string[]): string {
  const f = parts.filter((x) => x !== '');
  return f.length ? normalize(f.join('\\')) : '.';
}

export function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p);
}

export function resolve(...parts: string[]): string {
  let r = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!p) continue;
    r = r ? `${p}\\${r}` : p;
    if (isAbsolute(p)) break;
  }
  const n = normalize(r || 'C:\\');
  return n.length > 3 ? n.replace(/\\$/, '') : n;
}

export function dirname(p: string): string {
  const [root, rest] = splitRoot(p);
  const t = rest.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  if (i < 0) return root ? root : '.';
  return root + t.slice(0, i);
}

export function basename(p: string, ext?: string): string {
  const t = p.replace(/[\\/]+$/, '');
  const b = t.slice(Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')) + 1).replace(/^[A-Za-z]:/, '');
  return ext && b.toLowerCase().endsWith(ext.toLowerCase()) && b !== ext ? b.slice(0, -ext.length) : b;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split('\\').filter(Boolean);
  const b = resolve(to).split('\\').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('\\');
}

export function parse(p: string) {
  const [root] = splitRoot(p);
  const base = basename(p);
  const ext = extname(p);
  return { root, dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format(o: { dir?: string; root?: string; base?: string; name?: string; ext?: string }) {
  const base = o.base ?? `${o.name ?? ''}${o.ext ?? ''}`;
  const dir = o.dir ?? o.root ?? '';
  return dir ? (/[\\/]$/.test(dir) ? dir + base : `${dir}\\${base}`) : base;
}

export function toNamespacedPath(p: string) {
  return p;
}

const path = { sep, delimiter, normalize, join, isAbsolute, resolve, dirname, basename, extname, relative, parse, format, toNamespacedPath };
export const win32 = path;
export const posix = path;
export default path;
