// Tool window router: renderer/tool/index.html#{"tool":"cropImage","paths":[...]}
// Each tool page is its own entry (see pages.ts), added here as a module script so the window
// only loads the code of the tool it shows. A script added before the document has loaded holds
// back the load event, so the window isn't shown before its page has been built.
import { args } from '../shared/ui';
import { showError } from './start';
import { PAGES } from './pages';

const { tool } = args<{ tool: string }>();
document.body.dataset.tool = tool;
const { run } = args<{ run?: boolean }>();
if (tool === '_test' || run || tool === 'extractArchive' || Object.hasOwn(PAGES, tool)) {
  const script = document.createElement('script');
  script.type = 'module';
  script.src = tool === '_test' ? 'pages/_test.js' : run || tool === 'extractArchive' ? 'pages/_run.js' : `pages/${tool}.js`;
  script.onerror = () => showError('Something went wrong', `The "${tool}" tool couldn't be loaded.`);
  document.head.append(script);
} else {
  showError('Orange', `The "${tool}" tool isn't available in this version of Orange.`);
}
