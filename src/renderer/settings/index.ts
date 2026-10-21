import { h, segmented } from '../shared/ui';
import { icon } from '../shared/icons';

declare const orange: import('../../preload/preload').OrangeApi;

type ModKey = 'shift' | 'ctrl' | 'alt' | 'none';
interface Settings {
  keys: { convert: ModKey; tools: ModKey; actions: ModKey };
  selectionHotkey: string;
  output: { mode: 'beside' | 'folder'; folder: string };
  revealWhenDone: boolean;
  jpgQuality: number;
  launchAtLogin: boolean;
  sounds: boolean;
  theme: 'system' | 'light' | 'dark';
  terminal: 'auto' | 'wt' | 'pwsh' | 'powershell' | 'cmd';
  shelfEdge: 'right' | 'left';
  onboarded: boolean;
}

const nav = document.getElementById('nav')!;
const content = document.getElementById('content')!;
let s: Settings;

const TABS: { id: string; label: string; icon: string; render: () => Node | Promise<Node> }[] = [
  { id: 'welcome', label: 'How it works', icon: 'play', render: welcome },
  { id: 'general', label: 'General', icon: 'settings', render: general },
  { id: 'keys', label: 'Shortcuts', icon: 'grip', render: keys },
  { id: 'output', label: 'Saving', icon: 'folder', render: output },
  { id: 'engines', label: 'Engines', icon: 'compress', render: engines },
  { id: 'about', label: 'About', icon: 'file', render: about },
];

async function save(patch: Partial<Settings>) {
  s = await orange.invoke<Settings>('settings:set', patch);
}

function toggle(checked: boolean, onChange: (v: boolean) => void) {
  const input = h('input', { type: 'checkbox', role: 'switch' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('span', { class: 'toggle' }, input, h('i'));
}

function opt(title: string, desc: string | null, control: Node) {
  return h('div', { class: 'opt' }, h('div', { class: 'text' }, h('strong', {}, title), desc ? h('span', {}, desc) : null), control);
}

function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void) {
  const el = h('select') as HTMLSelectElement;
  for (const [v, l] of options) el.append(h('option', { value: v }, l));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

// ------------------------------------------------------------------ pages

function welcome() {
  const demo = h('div', {
    class: 'demo',
    html: `<svg viewBox="0 0 220 220" aria-hidden="true">
      <style>
        .w{transform-origin:110px 110px;animation:wheel 4s infinite}
        .f{animation:file 4s infinite}
        .k{animation:key 4s infinite}
        @keyframes file{0%{transform:translate(-60px,60px)}30%,100%{transform:translate(0,0)}}
        @keyframes wheel{0%,34%{opacity:0;transform:scale(.9)}40%,88%{opacity:1;transform:none}96%,100%{opacity:0}}
        @keyframes key{0%,30%{opacity:0}33%,45%{opacity:1}55%,100%{opacity:0}}
        @media (prefers-reduced-motion:reduce){.w,.f,.k{animation:none}.f{transform:none}}
      </style>
      <g class="w">
        <circle cx="110" cy="110" r="96" fill="var(--surface)" stroke="var(--line-strong)"/>
        <path d="M110 14A96 96 0 0 1 178 42L136 84A36 36 0 0 0 110 74Z" fill="var(--accent)"/>
        <circle cx="110" cy="110" r="36" fill="var(--surface-2)" stroke="var(--line)"/>
        <text x="142" y="56" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">PNG</text>
        <text x="178" y="118" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="middle">WEBP</text>
        <text x="142" y="178" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="middle">PDF</text>
        <text x="78" y="178" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="middle">HEIC</text>
        <text x="42" y="118" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="middle">AVIF</text>
        <text x="78" y="56" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="middle">TIFF</text>
      </g>
      <g class="f"><rect x="128" y="40" width="30" height="38" rx="4" fill="var(--surface)" stroke="var(--ink-2)"/><path d="M134 66l6-7 5 5 4-3 5 5" fill="none" stroke="var(--accent)" stroke-width="2"/></g>
      <g class="k"><rect x="8" y="186" width="58" height="26" rx="6" fill="var(--surface)" stroke="var(--line-strong)"/><text x="37" y="203" font-size="11" font-weight="700" fill="var(--ink)" text-anchor="middle">Shift</text></g>
    </svg>`,
  });
  const k = s.keys;
  const name = (m: ModKey) => ({ shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt', none: '—' })[m];
  return h(
    'div',
    {},
    h('h2', {}, 'Drag. Tap. Drop.'),
    h('p', { class: 'lede' }, 'Orange lives in the tray and converts files without opening anything. Everything runs on this PC; nothing is uploaded.'),
    h(
      'div',
      { class: 'hero' },
      demo,
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, h('span', {}, 'Start dragging any file in Explorer or on the desktop.')),
        h('li', {}, h('span', {}, `Tap ${name(k.convert)} and let go of the key. A wheel opens under the pointer.`)),
        h('li', {}, h('span', {}, 'Keep holding the file and drop it on a slice. The result is saved next to the original.')),
      ),
    ),
    h(
      'div',
      { class: 'group' },
      h(
        'table',
        { class: 'keys-table' },
        h('tr', {}, h('td', {}, h('span', { class: 'keycap' }, name(k.convert))), h('td', {}, 'Convert to another format')),
        h('tr', {}, h('td', {}, h('span', { class: 'keycap' }, name(k.tools))), h('td', {}, 'Tools: compress, crop, trim, merge, redact and more')),
        h('tr', {}, h('td', {}, h('span', { class: 'keycap' }, name(k.actions))), h('td', {}, 'Actions: share, float, copy, move, copy path, terminal')),
        h('tr', {}, h('td', {}, h('span', { class: 'keycap' }, s.selectionHotkey.replace(/\+/g, ' + ').replace('Control', 'Ctrl'))), h('td', {}, 'Open the wheel for the files selected in Explorer')),
      ),
    ),
    h('p', { class: 'muted' }, 'While the wheel is open you can tap another key to switch wheels, use the arrow keys to pick a slice, and press Esc to cancel.'),
    s.onboarded
      ? null
      : h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              await save({ onboarded: true });
              orange.send('window:close');
            },
          },
          'Got it',
        ),
  );
}

function general() {
  return h(
    'div',
    {},
    h('h2', {}, 'General'),
    h('p', { class: 'lede' }, 'Orange starts quietly and waits in the notification area.'),
    h(
      'div',
      { class: 'group' },
      opt('Start with Windows', 'Keep the wheel one keystroke away.', toggle(s.launchAtLogin, (v) => save({ launchAtLogin: v }))),
      opt('Sounds', 'Play the system sound when a job finishes.', toggle(s.sounds, (v) => save({ sounds: v }))),
      opt(
        'Appearance',
        null,
        segmented(
          [
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ],
          s.theme,
          (v) => {
            save({ theme: v });
            document.documentElement.dataset.theme = v === 'system' ? '' : v;
          },
        ),
      ),
      opt(
        'Terminal',
        'Used by the Terminal action.',
        select(
          s.terminal,
          [
            ['auto', 'Automatic'],
            ['wt', 'Windows Terminal'],
            ['pwsh', 'PowerShell 7'],
            ['powershell', 'Windows PowerShell'],
            ['cmd', 'Command Prompt'],
          ],
          (v) => save({ terminal: v }),
        ),
      ),
      opt(
        'Shelf position',
        'Where the Float shelf docks.',
        segmented(
          [
            { value: 'left', label: 'Left edge' },
            { value: 'right', label: 'Right edge' },
          ],
          s.shelfEdge,
          (v) => save({ shelfEdge: v }),
        ),
      ),
    ),
  );
}

function keys() {
  const mods: [ModKey, string][] = [
    ['shift', 'Shift'],
    ['ctrl', 'Ctrl'],
    ['alt', 'Alt'],
    ['none', 'Off'],
  ];
  const setKey = (which: keyof Settings['keys'], v: ModKey) => {
    const next = { ...s.keys, [which]: v };
    // A key can only open one wheel: swap with whichever wheel had it.
    for (const other of Object.keys(next) as (keyof Settings['keys'])[]) {
      if (other !== which && next[other] === v && v !== 'none') next[other] = s.keys[which];
    }
    save({ keys: next }).then(() => show('keys'));
  };
  const hk = h('input', { type: 'text', class: 'hotkey-input', readonly: true, value: s.selectionHotkey.replace('Control', 'Ctrl') }) as HTMLInputElement;
  hk.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape') return hk.blur();
    if (e.key === 'Backspace') {
      hk.value = '';
      save({ selectionHotkey: '' });
      return;
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const parts = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[];
    if (!parts.length) return;
    const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const accel = [...parts, key].join('+');
    hk.value = accel.replace('Control', 'Ctrl');
    save({ selectionHotkey: accel });
  });
  hk.addEventListener('focus', () => (hk.value = 'Press a shortcut…'));
  hk.addEventListener('blur', () => (hk.value = s.selectionHotkey.replace('Control', 'Ctrl')));
  return h(
    'div',
    {},
    h('h2', {}, 'Shortcuts'),
    h('p', { class: 'lede' }, 'Choose which key opens each wheel while you drag a file.'),
    h(
      'div',
      { class: 'group' },
      opt('Convert wheel', 'Formats for the dragged file.', select(s.keys.convert, mods, (v) => setKey('convert', v))),
      opt('Tools wheel', 'Compress, crop, trim, merge and more.', select(s.keys.tools, mods, (v) => setKey('tools', v))),
      opt('Actions wheel', 'Share, float, copy, move, path, terminal.', select(s.keys.actions, mods, (v) => setKey('actions', v))),
    ),
    h(
      'div',
      { class: 'group' },
      opt('Wheel for Explorer selection', 'Select files in Explorer, press this, click a slice. Backspace clears it.', hk),
    ),
  );
}

function output() {
  const folderLabel = h('span', {}, s.output.folder || 'No folder chosen');
  const pick = h(
    'button',
    {
      class: 'btn small',
      onclick: async () => {
        const f = await orange.invoke<string | null>('dialog:folder', 'Save converted files to');
        if (f) {
          await save({ output: { mode: 'folder', folder: f } });
          show('output');
        }
      },
    },
    'Choose…',
  );
  return h(
    'div',
    {},
    h('h2', {}, 'Saving'),
    h('p', { class: 'lede' }, 'Originals are never changed. New files get a fresh name if one already exists.'),
    h(
      'div',
      { class: 'group' },
      opt(
        'Save results',
        null,
        segmented(
          [
            { value: 'beside', label: 'Next to original' },
            { value: 'folder', label: 'In a folder' },
          ],
          s.output.mode,
          async (v) => {
            await save({ output: { ...s.output, mode: v } });
            show('output');
          },
        ),
      ),
      s.output.mode === 'folder' ? opt('Folder', null, h('div', { class: 'row' }, folderLabel, pick)) : null,
      opt('Show in Explorer when done', 'Open the folder and select the new file.', toggle(s.revealWhenDone, (v) => save({ revealWhenDone: v }))),
    ),
    h(
      'div',
      { class: 'group' },
      opt('JPEG quality', `${s.jpgQuality}. Higher keeps more detail; 85–92 is a good balance.`, (() => {
        const r = h('input', { type: 'range', min: 50, max: 100, step: 1, style: { width: '180px' } }) as HTMLInputElement;
        r.value = String(s.jpgQuality);
        r.addEventListener('change', async () => {
          await save({ jpgQuality: Number(r.value) });
          show('output');
        });
        return r;
      })()),
    ),
  );
}

async function engines() {
  const wrap = h('div', {}, h('h2', {}, 'Engines'), h('p', { class: 'lede' }, 'Orange uses proven open-source engines that ship with it. Office documents use Microsoft Office when it is installed, or LibreOffice.'));
  const group = h('div', { class: 'group' }, h('div', { class: 'opt' }, h('div', { class: 'skeleton', style: { height: '18px', width: '60%' } })));
  wrap.append(group);
  try {
    const st = await orange.invoke<{ word: boolean; powerpoint: boolean; excel: boolean; libreoffice: string | null; bundled: Record<string, boolean> }>('engines:status');
    group.innerHTML = '';
    const dot = (ok: boolean) => h('span', { class: `status-dot ${ok ? 'ok' : 'warn'}` });
    for (const [name, ok] of Object.entries(st.bundled ?? {})) group.append(opt(name, ok ? 'Included' : 'Missing, reinstall Orange', dot(ok)));
    const office = st.word || st.powerpoint || st.excel;
    group.append(opt('Microsoft Office', office ? `Found: ${[st.word && 'Word', st.powerpoint && 'PowerPoint', st.excel && 'Excel'].filter(Boolean).join(', ')}` : 'Not installed', dot(office)));
    const lo = h('div', { class: 'row fixed' }, dot(!!st.libreoffice));
    if (!st.libreoffice) {
      const b = h('button', { class: 'btn small' }, 'Install') as HTMLButtonElement;
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = 'Installing…';
        try {
          await orange.invoke('engines:installLibreOffice');
          show('engines');
        } catch (e: any) {
          b.disabled = false;
          b.textContent = 'Retry';
          alert(e?.message ?? String(e));
        }
      };
      lo.append(b);
    }
    group.append(opt('LibreOffice', st.libreoffice ? 'Found' : 'Needed for Office files, Pages and slides when Microsoft Office is not installed (about 350 MB).', lo));
  } catch {
    group.innerHTML = '';
    group.append(opt('Status unavailable', 'Could not check engines.', h('span')));
  }
  return wrap;
}

async function about() {
  const v = await orange.invoke<string>('app:version').catch(() => '');
  return h(
    'div',
    {},
    h('div', { class: 'about' }, h('img', { src: '../../assets/icon.png', alt: '' }), h('div', {}, h('h2', {}, 'Orange'), h('div', { class: 'muted' }, `Version ${v}`))),
    h(
      'div',
      { class: 'policy' },
      h('h3', {}, 'Privacy'),
      h('p', {}, 'Orange processes files only on this computer. It does not upload files, collect analytics, or contact any server, except when you ask it to install LibreOffice.'),
      h('h3', {}, 'Terms'),
      h('p', {}, 'Orange is provided as-is, without warranty. Results are saved as new files and originals are left untouched, but keep backups of anything important.'),
      h('h3', {}, 'Open-source components'),
      h('p', {}, 'FFmpeg, ImageMagick, libvips (sharp), 7-Zip, Pandoc, Ghostscript, pdf-lib, PDF.js, Tesseract and MediaPipe, each under its own licence.'),
    ),
    h(
      'div',
      { class: 'row', style: { gap: '8px', margin: '18px 0 10px', justifyContent: 'flex-start' } },
      h('button', { class: 'btn fixed', onclick: () => orange.invoke('app:checkUpdates') }, 'Check for updates'),
      h('button', { class: 'btn fixed', onclick: () => orange.invoke('app:report') }, 'Report a problem…'),
    ),
    h('p', { class: 'muted' }, 'Updates download in the background and install when you quit Orange.'),
    h('p', { class: 'links' }, h('a', { onclick: () => orange.invoke('app:openLogs') }, 'Open log folder')),
  );
}

// ---------------------------------------------------------------- shell

async function show(id: string) {
  nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
  const tab = TABS.find((t) => t.id === id) ?? TABS[1];
  const node = await tab.render();
  content.replaceChildren(node);
}

(async () => {
  s = await orange.invoke<Settings>('settings:get');
  if (s.theme !== 'system') document.documentElement.dataset.theme = s.theme;
  for (const t of TABS) nav.append(h('button', { 'data-id': t.id, onclick: () => show(t.id), html: `${icon(t.icon, 16)}<span>${t.label}</span>` }));
  show(orange.args.tab ?? 'general');
  orange.on('settings:tab', (t: string) => show(t));
})();
