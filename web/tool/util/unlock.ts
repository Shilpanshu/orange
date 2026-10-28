// Unlock: type the password once, get an unprotected copy of each PDF or the extracted archive contents.
// The window stays open on a wrong password so it can be retyped.
import { api, base, field, h, section, shell } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { passwordInput } from './password';

interface Inspect {
  path: string;
  kind: 'pdf' | 'archive';
  locked: boolean | null;
}
interface Report {
  done: string[];
  wrong: string[];
  notLocked: string[];
  failed: { path: string; message: string }[];
}

export async function unlock(paths: string[]) {
  const s = shell({ title: 'Unlock', file: paths.length === 1 ? base(paths[0]) : `${paths.length} files`, layout: 'full' });
  s.full.classList.add('ut-form');
  s.primary.textContent = 'Unlock';
  s.primary.disabled = true;
  const list = h('div', { class: 'ut-files' }, ...paths.slice(0, 3).map(() => h('div', { class: 'skeleton ut-sk-row' })));
  s.full.append(list);

  const info = await api().invoke<Inspect[]>('unlock:inspect', paths);
  const rows = new Map<string, HTMLElement>();
  const plainPdfs = info.filter((i) => i.kind === 'pdf' && i.locked === false);
  list.replaceChildren(
    ...info.map((i) => {
      const state = h('span', { class: 'ut-file-state' }, i.locked === false ? 'No password' : i.kind === 'pdf' ? 'Protected' : 'Archive');
      const row = h(
        'div',
        { class: `ut-file${i.locked === false ? ' muted-row' : ''}`, title: i.path },
        h('span', { class: 'ut-file-icon', html: icon(i.kind === 'pdf' ? 'pdf' : 'extract', 16) }),
        h('span', { class: 'ut-file-name' }, base(i.path)),
        state,
      );
      rows.set(i.path, state);
      return row;
    }),
  );
  const todo = info.filter((i) => !(i.kind === 'pdf' && i.locked === false)).map((i) => i.path);

  const err = h('p', { class: 'ut-error', role: 'alert' });
  const pw = passwordInput({ autofocus: true, onInput: () => ((err.textContent = ''), pw.input.classList.remove('invalid'), refresh()), onEnter: () => s.primary.click() });
  pw.input.autocomplete = 'current-password';
  const what = h(
    'p',
    { class: 'hint' },
    info.every((i) => i.kind === 'pdf')
      ? 'An unlocked copy is saved next to each PDF. The protected original stays as it is.'
      : info.every((i) => i.kind === 'archive')
        ? 'Each archive is extracted into a folder next to it.'
        : 'PDFs get an unlocked copy next to them; archives are extracted into a folder.',
  );
  s.full.append(section('Password', field(todo.length > 1 ? 'Password (used for every file)' : 'Password', pw), err, what));

  if (!todo.length) {
    pw.input.disabled = true;
    err.textContent = plainPdfs.length === 1 ? 'This PDF has no password to remove.' : 'None of these PDFs has a password to remove.';
    err.classList.add('neutral');
    s.primary.textContent = 'Close';
    s.primary.disabled = false;
    s.primary.onclick = () => api().send('window:close');
    return;
  }

  const refresh = () => {
    s.primary.disabled = !pw.value;
    s.status.textContent = plainPdfs.length ? `${plainPdfs.length === 1 ? 'One PDF has' : `${plainPdfs.length} PDFs have`} no password and will be skipped` : '';
  };
  refresh();

  let busy = false;
  s.primary.addEventListener('click', async () => {
    if (busy || !pw.value) return;
    busy = true;
    s.primary.disabled = true;
    s.primary.textContent = 'Unlocking…';
    err.textContent = '';
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let report: Report | null = null;
    try {
      await api().invoke<string[]>('tool:run', 'unlock', todo, { password: pw.value, token });
      report = await api().invoke<Report | null>('unlock:report', token);
    } catch (e: any) {
      err.textContent = e?.message ?? String(e);
    }
    busy = false;
    s.primary.textContent = 'Unlock';
    if (!report) {
      refresh();
      return;
    }
    for (const p of todo) {
      const st = rows.get(p)!;
      if (report.wrong.includes(p)) (st.textContent = 'Wrong password'), (st.className = 'ut-file-state bad');
      else if (report.notLocked.includes(p)) (st.textContent = 'No password'), (st.className = 'ut-file-state');
      else if (report.failed.some((f) => f.path === p)) (st.textContent = 'Failed'), (st.className = 'ut-file-state bad');
      else (st.textContent = 'Unlocked'), (st.className = 'ut-file-state ok');
    }
    if (!report.wrong.length && !report.failed.length) {
      api().send('window:close');
      return;
    }
    if (report.wrong.length) {
      err.textContent =
        report.wrong.length === todo.length
          ? 'That password didn’t work. Check Caps Lock and the keyboard language, then try again.'
          : `That password didn’t work for ${report.wrong.map(base).join(', ')}. The others were unlocked.`;
      pw.input.classList.add('invalid');
      pw.input.select();
      pw.input.focus();
    } else {
      err.textContent = report.failed.map((f) => `${base(f.path)}: ${f.message}`).join('\n');
    }
    // Only retry what's left.
    todo.splice(0, todo.length, ...todo.filter((p) => report!.wrong.includes(p) || report!.failed.some((f) => f.path === p)));
    refresh();
  });
}
