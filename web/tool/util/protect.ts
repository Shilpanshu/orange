// Protect: a password on a PDF itself (AES-256), or an encrypted ZIP / 7z for anything else.
import { api, base, checkbox, field, h, runAndClose, section, segmented, shell } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { passwordInput, strengthMeter } from './password';

type Mode = 'pdf' | 'zip' | '7z';
interface Inspect {
  path: string;
  dir: boolean;
  pdf: boolean;
  locked: boolean;
}

const ASCII = /^[\x20-\x7e]*$/;

export async function protect(paths: string[]) {
  const s = shell({ title: 'Protect', file: paths.length === 1 ? base(paths[0]) : `${paths.length} items`, layout: 'full' });
  s.full.classList.add('ut-form');
  s.primary.textContent = 'Protect';
  s.primary.disabled = true;
  const sk = h('div', {}, h('div', { class: 'skeleton ut-sk-line' }), h('div', { class: 'skeleton ut-sk-field' }), h('div', { class: 'skeleton ut-sk-field' }));
  s.full.append(sk);

  const info = await api().invoke<Inspect[]>('protect:inspect', paths);
  const allPdf = info.every((i) => i.pdf && !i.dir);
  const lockedPdf = info.filter((i) => i.pdf && i.locked);
  let mode: Mode = allPdf && !lockedPdf.length ? 'pdf' : 'zip';
  const perms = { print: true, copy: true, edit: true };
  let owner = '';

  // ------------------------------------------------------------ what
  const what = h('div', { class: 'ut-what' });
  const whatText = () => {
    const n = paths.length;
    if (mode === 'pdf') return n === 1 ? 'A protected copy of the PDF is saved next to it. Opening it will ask for the password.' : `A protected copy of each of the ${n} PDFs is saved next to it.`;
    const kind = mode === '7z' ? '7z archive' : 'ZIP archive';
    return n === 1 ? `${base(paths[0])} is packed into an encrypted ${kind}. The original stays as it is.` : `These ${n} items are packed into one encrypted ${kind}. The originals stay as they are.`;
  };
  const renderWhat = () =>
    what.replaceChildren(
      h('span', { class: 'ut-what-icon', html: icon(mode === 'pdf' ? 'pdf' : 'lock', 20) }),
      h('p', {}, whatText()),
    );

  // ----------------------------------------------------------- format
  const modes: { value: Mode; label: string }[] = [];
  if (allPdf && !lockedPdf.length) modes.push({ value: 'pdf', label: paths.length === 1 ? 'PDF password' : 'Each PDF' });
  modes.push({ value: 'zip', label: 'ZIP' }, { value: '7z', label: '7z' });
  const modeHint = h('p', { class: 'hint' });
  const modeHintText: Record<Mode, string> = {
    pdf: 'AES-256, the strongest PDF encryption. Opens in any current PDF reader.',
    zip: 'AES-256. File names inside stay visible. Opens with 7-Zip or WinRAR; some built-in ZIP openers can’t handle encrypted ZIPs.',
    '7z': 'AES-256, and the file names are hidden too. Opens with 7-Zip or WinRAR.',
  };

  // --------------------------------------------------------- password
  const meter = strengthMeter();
  const pw = passwordInput({ autofocus: true, onInput: () => validate(), onEnter: () => confirm.input.focus() });
  const confirm = passwordInput({ onInput: () => validate(), onEnter: () => s.primary.click() });
  const pwError = h('p', { class: 'ut-error', role: 'alert' });

  // ------------------------------------------------------ permissions
  const ownerPw = passwordInput({ placeholder: 'Optional', onInput: (v) => ((owner = v), validate()) });
  ownerPw.input.autocomplete = 'off';
  const ownerField = field('Permissions password', ownerPw);
  const ownerHint = h('p', { class: 'hint' }, 'Needed to change the permissions later. Leave it empty to lock them for good.');
  const permsBox = section(
    'Permissions',
    checkbox('Allow printing', perms.print, (v) => ((perms.print = v), showOwner())),
    checkbox('Allow copying text and images', perms.copy, (v) => ((perms.copy = v), showOwner())),
    checkbox('Allow editing, comments and form filling', perms.edit, (v) => ((perms.edit = v), showOwner())),
    ownerField,
    ownerHint,
  );
  const showOwner = () => {
    const restricted = !perms.print || !perms.copy || !perms.edit;
    ownerField.hidden = ownerHint.hidden = !restricted;
    validate();
  };

  const notes: HTMLElement[] = [];
  if (lockedPdf.length) {
    notes.push(
      h(
        'p',
        { class: 'ut-note' },
        lockedPdf.length === 1 && paths.length === 1
          ? 'This PDF already has a password, so it can only go into an encrypted archive. Use Unlock first to change its password.'
          : `${lockedPdf.length === 1 ? 'One PDF already has' : `${lockedPdf.length} PDFs already have`} a password, so the selection goes into an encrypted archive.`,
      ),
    );
  }

  const formatSection = section('Format', segmented(modes, mode, (v) => ((mode = v), update())), modeHint);
  const pwSection = section(
    'Password',
    field('Password', pw),
    meter,
    field('Type it again', confirm),
    pwError,
    h('p', { class: 'hint ut-warn-hint' }, 'Orange doesn’t keep this password. If it’s lost, the file can’t be opened.'),
  );
  sk.replaceWith(what, ...notes, formatSection, pwSection, permsBox);

  function update() {
    renderWhat();
    modeHint.textContent = modeHintText[mode];
    permsBox.hidden = mode !== 'pdf';
    showOwner();
  }

  function problem(): string | null {
    const p = pw.value;
    if (!p) return null;
    if (mode === 'zip' && !ASCII.test(p)) return 'ZIP passwords can only use English letters, digits and symbols. Choose 7z for other characters.';
    if (mode === '7z' && !ASCII.test(p) && p.includes('"')) return 'A password with letters outside English can’t also contain quotation marks (").';
    if (confirm.value && confirm.value !== p) return 'The passwords don’t match.';
    if (mode === 'pdf' && owner && owner === p && (!perms.print || !perms.copy || !perms.edit)) return 'Use a different permissions password, or leave it empty.';
    return null;
  }

  function validate() {
    meter.update(pw.value);
    const err = problem();
    pwError.textContent = err ?? '';
    confirm.input.classList.toggle('invalid', !!confirm.value && confirm.value !== pw.value);
    const ready = !!pw.value && pw.value === confirm.value && !err;
    s.primary.disabled = !ready;
    s.status.textContent = !pw.value ? 'Choose a password' : confirm.value !== pw.value ? 'Type the password twice' : '';
  }

  update();

  s.primary.addEventListener('click', () => {
    if (s.primary.disabled) return;
    const restricted = !perms.print || !perms.copy || !perms.edit;
    runAndClose(
      s.primary,
      'protect',
      paths,
      { mode, password: pw.value, ownerPassword: mode === 'pdf' && restricted ? owner : '', permissions: { ...perms } },
      s.status,
    );
  });
}
