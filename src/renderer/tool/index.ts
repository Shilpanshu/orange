// Tool window router: renderer/tool/index.html#{"tool":"cropImage","paths":[...]}
import { args, h, shell } from '../shared/ui';
import { pages as imagePages } from './image';
import { pages as avPages } from './av';
import { pages as pdfPages } from './pdf';
import { pages as filePages } from './file';
import { pages as aiPages } from './ai';
import { pages as utilPages } from './util';
import { pages as speechPages } from './speech';

export type ToolPage = (paths: string[]) => void | Promise<void>;

const PAGES: Record<string, ToolPage> = { ...imagePages, ...avPages, ...pdfPages, ...filePages, ...aiPages, ...utilPages, ...speechPages };

const { tool, paths } = args<{ tool: string; paths: string[] }>();
document.body.dataset.tool = tool;
const pageFn = PAGES[tool];
if (!pageFn) {
  const s = shell({ title: 'Orange', layout: 'full' });
  s.full.append(h('p', { class: 'empty-state' }, `The "${tool}" tool isn't available in this version of Orange.`));
  s.primary.remove();
  s.cancel.textContent = 'Close';
} else {
  Promise.resolve(pageFn(paths)).catch((e) => {
    console.error(e);
    const s = shell({ title: 'Something went wrong', layout: 'full' });
    s.full.append(h('p', { class: 'empty-state' }, String(e?.message ?? e)));
    s.primary.remove();
    s.cancel.textContent = 'Close';
  });
}
