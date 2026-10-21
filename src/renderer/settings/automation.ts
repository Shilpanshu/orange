// Settings → Automation: the Explorer right-click menu, watch folders and saved presets.
// Exported as a tab renderer; the settings page adds it to its tab list.
import { h } from '../shared/ui';
import { icon } from '../shared/icons';
import { TOOLS, conversionTargets, kindOfExt, toolsFor, type Kind } from '../../shared/catalog';
import type { Settings, WatchFolder, Preset } from '../../main/settings';

type Api = import('../../preload/preload').OrangeApi;

// ------------------------------------------------------------ small helpers
// Same markup as the helpers in settings/index.ts, so the page looks identical.

function toggle(checked: boolean, onChange: (v: boolean) => void, label?: string) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('span', { class: 'toggle' }, input, h('i'));
}

function opt(title: string, desc: string | null, control: Node) {
  return h('div', { class: 'opt' }, h('div', { class: 'text' }, h('strong', {}, title), desc ? h('span', {}, desc) : null), control);
}

const STYLE = `
.auto-wf{padding:14px 16px 6px}
.auto-wf + .auto-wf{border-top:1px solid var(--line)}
.auto-wf.off .auto-body{opacity:.55}
.auto-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.auto-head .auto-ico{color:var(--ink-3);display:flex;flex:none}
.auto-head .auto-name{flex:1;min-width:0}
.auto-head .auto-name strong{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.auto-head .auto-name span{display:block;color:var(--ink-3);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.auto-body{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
.auto-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.auto-field > label{color:var(--ink-2);font-size:12px}
.auto-field select,.auto-field input[type='text']{width:100%}
.auto-field .auto-hint{color:var(--ink-3);font-size:11.5px;line-height:1.35;min-height:15px}
.auto-field .auto-hint.bad{color:var(--danger)}
.auto-out{display:flex;gap:6px;align-items:center;min-width:0}
.auto-out .auto-path{flex:1;min-width:0;height:30px;line-height:28px;padding:0 9px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
.auto-out .btn{flex:none}
.auto-check{grid-column:1 / -1;display:flex;align-items:center;gap:10px;padding:4px 0 8px;color:var(--ink-2)}
.auto-empty{padding:16px;color:var(--ink-3);line-height:1.5}
.auto-add{display:flex;justify-content:flex-start;padding:10px 16px;border-top:1px solid var(--line)}
.auto-preset{display:flex;align-items:center;gap:12px;padding:10px 16px;min-height:52px}
.auto-preset + .auto-preset{border-top:1px solid var(--line)}
.auto-preset .auto-ico{color:var(--ink-3);display:flex;flex:none}
.auto-preset input[type='text']{flex:1 1 200px;min-width:150px;max-width:260px}
.auto-preset .auto-meta{flex:1;min-width:0;color:var(--ink-3);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.auto-sub{font:600 14px var(--font-display);margin:26px 0 4px}
@media (max-width:640px){.auto-body{grid-template-columns:1fr}}
`;

function injectStyle() {
  if (document.getElementById('automation-styles')) return;
  document.head.append(h('style', { id: 'automation-styles' }, STYLE));
}

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const uid = () => Math.random().toString(36).slice(2, 10);

// ------------------------------------------------------------ actions

const KIND_ORDER: Kind[] = ['image', 'video', 'audio', 'pdf', 'document', 'slides', 'spreadsheet', 'ebook', 'subtitle', 'archive'];
const KIND_LABEL: Record<string, string> = {
  image: 'images',
  video: 'videos',
  audio: 'audio',
  pdf: 'PDFs',
  document: 'documents',
  slides: 'slides',
  spreadsheet: 'spreadsheets',
  ebook: 'e-books',
  subtitle: 'subtitles',
  archive: 'archives',
  folder: 'folders',
  other: 'other files',
};
// Two sample extensions per kind: the catalog hides "convert to the same format", so a second
// sample brings that target back (e.g. JPG for images).
const SAMPLE: Record<string, [string, string]> = {
  image: ['png', 'jpg'],
  video: ['mov', 'mp4'],
  audio: ['wav', 'mp3'],
  pdf: ['pdf', 'pdf'],
  document: ['txt', 'docx'],
  slides: ['key', 'pptx'],
  spreadsheet: ['numbers', 'xlsx'],
  ebook: ['epub', 'epub'],
  subtitle: ['vtt', 'srt'],
  archive: ['rar', 'zip'],
};
const INSTANT_TOOLS = ['extractArchive'];

/** Conversion targets offered for watch folders, with the file kinds each accepts. */
function conversionChoices(): { id: string; label: string; kinds: Kind[] }[] {
  const map = new Map<string, { id: string; label: string; kinds: Kind[] }>();
  for (const k of KIND_ORDER) {
    const [a, b] = SAMPLE[k];
    for (const t of [...conversionTargets([a]), ...conversionTargets([b])]) {
      const id = t.id === 'extract' ? 'to:extract' : `to:${t.ext}`;
      const e = map.get(id) ?? { id, label: t.id === 'extract' ? 'Extract' : t.ext.toUpperCase(), kinds: [] };
      if (!e.kinds.includes(k)) e.kinds.push(k);
      map.set(id, e);
    }
  }
  return [...map.values()];
}

function kindsForAction(action: string, presets: Preset[]): Kind[] {
  if (action.startsWith('to:')) return conversionChoices().find((c) => c.id === action)?.kinds ?? [];
  if (action.startsWith('tool:')) return TOOLS.find((t) => t.id === action.slice(5))?.kinds ?? [];
  if (action.startsWith('preset:')) return (presets.find((p) => p.id === action.slice(7))?.kinds as Kind[]) ?? [];
  return [];
}

function actionLabel(action: string, presets: Preset[]): string {
  if (action.startsWith('to:')) return action === 'to:extract' ? 'Extract' : `Convert to ${action.slice(3).toUpperCase()}`;
  if (action.startsWith('tool:')) return TOOLS.find((t) => t.id === action.slice(5))?.label ?? action;
  const p = presets.find((x) => x.id === action.slice(7));
  return p ? p.name : 'Missing preset';
}

function normalizeExts(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean))];
}

/** Plain-language summary of which files a watch folder will pick up. */
function scopeHint(wf: WatchFolder, presets: Preset[]): { text: string; bad?: boolean } {
  const kinds = kindsForAction(wf.action, presets);
  if (!kinds.length) return { text: 'Choose what to do with new files.', bad: true };
  if (wf.exts.length) {
    const action = wf.action;
    const fits = (ext: string) => {
      if (action.startsWith('to:')) {
        const id = action.slice(3);
        return conversionTargets([ext]).some((t) => (t.id === 'extract' ? id === 'extract' : t.ext === id));
      }
      if (action.startsWith('tool:')) return toolsFor([ext]).some((t) => t.id === action.slice(5));
      const p = presets.find((x) => x.id === action.slice(7));
      return !!p && toolsFor([ext]).some((t) => t.id === p.tool) && p.kinds.includes(kindOfExt(ext));
    };
    const bad = wf.exts.filter((e) => !fits(e));
    if (bad.length === wf.exts.length) return { text: `${actionLabel(action, presets)} can't take ${bad.map((e) => e.toUpperCase()).join(', ')} files.`, bad: true };
    if (bad.length) return { text: `${bad.map((e) => e.toUpperCase()).join(', ')} will be skipped.`, bad: true };
    return { text: `Only ${wf.exts.map((e) => e.toUpperCase()).join(', ')} files.` };
  }
  const names = kinds.map((k) => KIND_LABEL[k] ?? k);
  return { text: `Any ${names.length > 1 ? names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1] : names[0]} it can take.` };
}

function actionSelect(value: string, presets: Preset[], onChange: (v: string) => void) {
  const el = h('select', { 'aria-label': 'Action' }) as HTMLSelectElement;
  const conv = h('optgroup', { label: 'Convert' });
  for (const c of conversionChoices()) conv.append(h('option', { value: c.id }, c.id === 'to:extract' ? 'Extract archive' : `Convert to ${c.label}`));
  el.append(conv);
  const tools = h('optgroup', { label: 'Tools' });
  for (const id of INSTANT_TOOLS) {
    const t = TOOLS.find((x) => x.id === id);
    if (t) tools.append(h('option', { value: `tool:${id}` }, `${t.label} (${t.blurb.toLowerCase()})`));
  }
  el.append(tools);
  if (presets.length) {
    const g = h('optgroup', { label: 'Presets' });
    for (const p of presets) g.append(h('option', { value: `preset:${p.id}` }, `${p.name} · ${TOOLS.find((t) => t.id === p.tool)?.label ?? p.tool}`));
    el.append(g);
  }
  if (value.startsWith('preset:') && !presets.some((p) => `preset:${p.id}` === value)) {
    el.prepend(h('option', { value, disabled: true }, 'Missing preset'));
  }
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

// ------------------------------------------------------------ the tab

export function renderAutomation(api: Api): Node {
  injectStyle();
  const root = h('div', {});
  let s: Settings;

  const save = async (patch: Partial<Settings>) => {
    s = await api.invoke<Settings>('settings:set', patch);
  };
  const saveFolders = (list: WatchFolder[]) => save({ watchFolders: list });

  function render() {
    const presets = s.presets ?? [];
    const folders = s.watchFolders ?? [];

    // Explorer menu
    const menu = h(
      'div',
      { class: 'group' },
      opt(
        'Explorer right-click menu',
        'Adds Orange with Convert, Tools and Actions to the menu for files and folders. On Windows 11 it is under "Show more options".',
        toggle(s.contextMenu, (v) => save({ contextMenu: v }), 'Explorer right-click menu'),
      ),
    );

    // Watch folders
    const list = h('div', { class: 'group' });
    if (!folders.length) {
      list.append(h('div', { class: 'auto-empty' }, 'No watch folders yet. Add your Downloads folder, for example, to turn every new HEIC photo into a JPG as soon as it arrives.'));
    }
    for (const wf of folders) list.append(watchRow(wf, presets, folders));
    const add = h(
      'button',
      {
        class: 'btn small',
        html: `${icon('plus', 14)}<span>Add folder…</span>`,
        onclick: async () => {
          const f = await api.invoke<string | null>('dialog:folder', 'Watch this folder');
          if (!f) return;
          const wf: WatchFolder = { id: uid(), folder: f, exts: ['heic'], action: 'to:jpg', outFolder: '', recycleOriginal: false, enabled: true };
          await saveFolders([...folders, wf]);
          render();
        },
      },
    );
    list.append(h('div', { class: 'auto-add' }, add));

    // Presets
    const pgroup = h('div', { class: 'group' });
    if (!presets.length) {
      pgroup.append(h('div', { class: 'auto-empty' }, 'No presets yet. In a tool such as Crop, Speed or Normalize, choose "Save as preset…" at the bottom of the window. The preset then appears on the Tools wheel.'));
    }
    for (const p of presets) pgroup.append(presetRow(p, folders));

    root.replaceChildren(
      h('h2', {}, 'Automation'),
      h('p', { class: 'lede' }, 'Reach Orange from the right-click menu, convert new files in a folder automatically, and keep tool settings you use often.'),
      menu,
      h('h3', { class: 'auto-sub' }, 'Watch folders'),
      h('p', { class: 'muted', style: { margin: '0 0 10px' } }, 'New files in these folders are processed once they finish downloading or copying. Files already there are left alone.'),
      list,
      h('h3', { class: 'auto-sub' }, 'Presets'),
      pgroup,
    );
  }

  function watchRow(wf: WatchFolder, presets: Preset[], folders: WatchFolder[]) {
    const update = async (patch: Partial<WatchFolder>, rerender = false) => {
      Object.assign(wf, patch);
      await saveFolders(folders.map((x) => (x.id === wf.id ? { ...wf } : x)));
      const sh = scopeHint(wf, presets);
      hint.textContent = sh.text;
      hint.classList.toggle('bad', !!sh.bad);
      if (rerender) render();
    };

    const sh = scopeHint(wf, presets);
    const hint = h('div', { class: `auto-hint${sh.bad ? ' bad' : ''}` }, sh.text);

    const types = h('input', { type: 'text', placeholder: 'Any it can take', spellcheck: false, 'aria-label': 'File types' }) as HTMLInputElement;
    types.value = wf.exts.join(', ');
    types.addEventListener('change', () => {
      const exts = normalizeExts(types.value);
      types.value = exts.join(', ');
      void update({ exts });
    });

    const outPath = h('span', { class: 'auto-path', title: wf.outFolder || '' }, wf.outFolder ? wf.outFolder : 'Next to the new file');
    const outControls = h('div', { class: 'auto-out' }, outPath);
    outControls.append(
      h(
        'button',
        {
          class: 'btn small',
          onclick: async () => {
            const f = await api.invoke<string | null>('dialog:folder', 'Save results to');
            if (f) void update({ outFolder: f }, true);
          },
        },
        'Choose…',
      ),
    );
    if (wf.outFolder) outControls.append(h('button', { class: 'btn small ghost', title: 'Save next to the new file', onclick: () => void update({ outFolder: '' }, true) }, 'Reset'));

    const missing = wf.action.startsWith('preset:') && !presets.some((p) => `preset:${p.id}` === wf.action);

    return h(
      'div',
      { class: `auto-wf${wf.enabled ? '' : ' off'}` },
      h(
        'div',
        { class: 'auto-head' },
        h('span', { class: 'auto-ico', html: icon('folder', 18) }),
        h('div', { class: 'auto-name', title: wf.folder }, h('strong', {}, base(wf.folder)), h('span', {}, wf.folder)),
        toggle(wf.enabled, (v) => void update({ enabled: v }, true), `Watch ${base(wf.folder)}`),
        h('button', {
          class: 'btn icon ghost',
          title: 'Stop watching and remove',
          'aria-label': `Remove ${base(wf.folder)}`,
          html: icon('trash', 16),
          onclick: async () => {
            await saveFolders(folders.filter((x) => x.id !== wf.id));
            render();
          },
        }),
      ),
      h(
        'div',
        { class: 'auto-body' },
        h(
          'div',
          { class: 'auto-field' },
          h('label', {}, 'Do this'),
          actionSelect(wf.action, presets, (v) => void update({ action: v })),
          missing ? h('div', { class: 'auto-hint bad' }, 'Its preset was deleted. Choose another action.') : hint,
        ),
        h('div', { class: 'auto-field' }, h('label', {}, 'File types'), types, h('div', { class: 'auto-hint' }, 'Such as heic, png. Empty for all.')),
        h('div', { class: 'auto-field', style: { gridColumn: '1 / -1' } }, h('label', {}, 'Save results'), outControls),
        h(
          'label',
          { class: 'auto-check' },
          toggle(wf.recycleOriginal, (v) => void update({ recycleOriginal: v }), 'Move the original to the Recycle Bin'),
          h('span', {}, 'Move the original to the Recycle Bin after it is converted'),
        ),
      ),
    );
  }

  function presetRow(p: Preset, folders: WatchFolder[]) {
    const tool = TOOLS.find((t) => t.id === p.tool);
    const name = h('input', { type: 'text', maxlength: 60, 'aria-label': 'Preset name' }) as HTMLInputElement;
    name.value = p.name;
    name.addEventListener('change', async () => {
      const v = name.value.trim();
      if (!v) {
        name.value = p.name;
        return;
      }
      await api.invoke('presets:rename', p.id, v);
      s = await api.invoke<Settings>('settings:get');
      render();
    });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') {
        name.value = p.name;
        name.blur();
      }
    });
    const used = folders.filter((f) => f.action === `preset:${p.id}`).length;
    const kinds = (p.kinds ?? []).map((k) => KIND_LABEL[k] ?? k).join(', ');
    return h(
      'div',
      { class: 'auto-preset' },
      h('span', { class: 'auto-ico', html: icon(tool?.icon ?? 'star', 18) }),
      name,
      h('span', { class: 'auto-meta', title: `${tool?.label ?? p.tool} · ${kinds}` }, `${tool?.label ?? p.tool} · ${kinds}${used ? ` · used by ${used} watch folder${used === 1 ? '' : 's'}` : ''}`),
      h('button', {
        class: 'btn icon ghost',
        title: 'Delete preset',
        'aria-label': `Delete ${p.name}`,
        html: icon('trash', 16),
        onclick: async () => {
          await api.invoke('presets:delete', p.id);
          s = await api.invoke<Settings>('settings:get');
          render();
        },
      }),
    );
  }

  // Skeleton until settings arrive.
  root.append(h('h2', {}, 'Automation'), h('div', { class: 'group' }, h('div', { class: 'opt' }, h('div', { class: 'skeleton', style: { height: '18px', width: '60%' } }))));
  void api.invoke<Settings>('settings:get').then((v) => {
    s = v;
    render();
  });
  return root;
}
