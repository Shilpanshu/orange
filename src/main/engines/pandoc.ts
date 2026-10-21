// Pandoc: the universal converter for text-structured documents
// (Markdown, HTML, DOCX, ODT, RTF, EPUB, plain text). Bundled as vendor/bin/pandoc.exe.
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bin, hasBin } from '../paths';
import { run } from './run';
import { UserError } from '../ops/types';

export function hasPandoc(): boolean {
  return hasBin('pandoc');
}

/** Pandoc reader name for a file extension. */
export function pandocReader(ext: string): string | null {
  return (
    {
      md: 'markdown',
      markdown: 'markdown',
      html: 'html',
      htm: 'html',
      docx: 'docx',
      odt: 'odt',
      rtf: 'rtf',
      epub: 'epub',
      txt: 'markdown', // callers normally wrap plain text into HTML first; this is a fallback
    } as Record<string, string>
  )[ext] ?? null;
}

/** Pandoc writer name for a target extension. */
export function pandocWriter(ext: string): string | null {
  return (
    {
      md: 'gfm',
      txt: 'plain',
      html: 'html5',
      docx: 'docx',
      odt: 'odt',
      rtf: 'rtf',
      epub: 'epub3',
    } as Record<string, string>
  )[ext] ?? null;
}

/** Comfortable reading styles used for HTML output and for HTML→PDF printing. */
export const READING_CSS = `
:root { color-scheme: light; }
html { font-size: 16px; }
body {
  margin: 0 auto; max-width: 46rem; padding: 2.5rem 1.5rem 4rem;
  font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; line-height: 1.6; color: #1d1d1f; background: #fff;
  overflow-wrap: break-word; hyphens: auto;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.8em 0 0.6em; font-weight: 650; }
h1 { font-size: 2rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.25rem; } h4 { font-size: 1.05rem; }
p, ul, ol, dl, table, pre, blockquote, figure { margin: 0 0 1em; }
a { color: #b4540a; }
img, svg, video { max-width: 100%; height: auto; }
figure { text-align: center; } figcaption { font-size: 0.9em; color: #555; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #e0ddd8; color: #444; }
code, pre { font-family: "Cascadia Mono", Consolas, monospace; font-size: 0.9em; }
pre { padding: 0.8em 1em; background: #f6f5f3; overflow-x: auto; white-space: pre-wrap; }
:not(pre) > code { background: #f6f5f3; padding: 0.1em 0.3em; }
table { border-collapse: collapse; width: auto; max-width: 100%; }
th, td { border: 1px solid #dcd9d4; padding: 0.35em 0.6em; vertical-align: top; text-align: left; }
th { background: #f6f5f3; font-weight: 600; }
hr { border: 0; border-top: 1px solid #e0ddd8; margin: 2em 0; }
header#title-block-header { margin-bottom: 2em; }
@media print {
  body { max-width: none; padding: 0; font-size: 11pt; }
  h1, h2, h3, h4 { break-after: avoid; }
  pre, blockquote, table, figure, img { break-inside: avoid; }
}
`;

export interface PandocOptions {
  signal?: AbortSignal;
  /** Working directory; also where relative resources are resolved and media is extracted. */
  cwd?: string;
  /** Extra directories to look for images etc. */
  resourcePath?: string[];
  /** Used as the title when the document has none (EPUB requires one; HTML wants one). */
  fallbackTitle?: string;
  /** Additional raw pandoc arguments. */
  extra?: string[];
  /** Scratch directory for helper files (CSS, metadata). */
  tmp: string;
}

/**
 * Convert `input` (read as `from`) to `output` (written as `to`), with sensible per-format defaults:
 * standalone HTML with embedded resources and reading styles, unwrapped plain text, GitHub Markdown.
 */
export async function pandocConvert(input: string, from: string, output: string, to: string, opts: PandocOptions): Promise<void> {
  if (!hasPandoc()) throw new UserError('The document converter is missing. Reinstall Orange.');
  const args = ['--from', from, '--to', to, '--output', output];
  const res = [dirname(input), ...(opts.resourcePath ?? [])];
  args.push(`--resource-path=${res.join(';')}`);

  // Defaults that the document's own metadata overrides.
  if (opts.fallbackTitle) {
    const meta = join(opts.tmp, 'orange-meta.yaml');
    writeFileSync(meta, `pagetitle: ${JSON.stringify(opts.fallbackTitle)}\n` + (to.startsWith('epub') ? `title: ${JSON.stringify(opts.fallbackTitle)}\n` : ''));
    args.push(`--metadata-file=${meta}`);
  }

  switch (to) {
    case 'html5': {
      const css = join(opts.tmp, 'orange-reading.css');
      writeFileSync(css, READING_CSS);
      args.push('--standalone', '--embed-resources', `--css=${css}`);
      break;
    }
    case 'plain':
      args.push('--wrap=none');
      break;
    case 'gfm':
    case 'markdown':
      args.push('--wrap=none');
      break;
    case 'epub3': {
      const css = join(opts.tmp, 'orange-epub.css');
      writeFileSync(css, READING_CSS.replace(/max-width: 46rem;|padding: 2\.5rem 1\.5rem 4rem;/g, ''));
      args.push(`--css=${css}`, '--split-level=1');
      break;
    }
    case 'docx':
    case 'odt':
    case 'rtf':
      args.push('--standalone');
      break;
  }
  if (opts.extra) args.push(...opts.extra);
  args.push(input);
  await run(bin('pandoc'), args, { signal: opts.signal, cwd: opts.cwd ?? dirname(output) });
  if (!existsSync(output)) throw new Error('pandoc produced no output');
}
