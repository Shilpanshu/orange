// Password input with a show/hide toggle and an optional strength meter. Used by Protect and Unlock.
import { h } from '../../shared/ui';
import { icon } from '../../shared/icons';

export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
}

const COMMON = /^(password|passw0rd|qwerty|letmein|welcome|admin|iloveyou|monkey|dragon|abc123|111111|123123|000000)/i;

/** A rough, offline estimate: length and variety, minus obvious patterns. */
export function strength(pw: string): Strength {
  if (!pw) return { score: 0, label: '', hint: '' };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  let bits = pw.length * Math.log2(Math.max(pool, 2));
  if (/^(.)\1+$/.test(pw)) bits = Math.min(bits, 8);
  if (/^(0123|1234|2345|abcd|qwer|asdf)/i.test(pw)) bits -= 20;
  if (COMMON.test(pw)) bits = Math.min(bits, 12);
  if (pw.length < 6) return { score: 1, label: 'Too short', hint: 'Use at least 8 characters.' };
  if (bits < 40) return { score: 1, label: 'Weak', hint: 'Easy to guess. Add length, or mix words, numbers and symbols.' };
  if (bits < 60) return { score: 2, label: 'Fair', hint: 'A few more characters would make it much harder to crack.' };
  if (bits < 80) return { score: 3, label: 'Strong', hint: 'Good. A little longer is even better.' };
  return { score: 4, label: 'Very strong', hint: 'Hard to guess.' };
}

export function passwordInput(opts: { placeholder?: string; autofocus?: boolean; onInput?: (v: string) => void; onEnter?: () => void }) {
  const input = h('input', {
    type: 'password',
    class: 'ut-pw-input',
    placeholder: opts.placeholder ?? '',
    autocomplete: 'new-password',
    spellcheck: false,
  }) as HTMLInputElement;
  const toggle = h('button', { class: 'ut-pw-eye', type: 'button', title: 'Show password', 'aria-label': 'Show password', 'aria-pressed': 'false', html: icon('eye', 16) }) as HTMLButtonElement;
  const wrap = h('div', { class: 'ut-pw' }, input, toggle);
  let shown = false;
  const setShown = (v: boolean) => {
    shown = v;
    input.type = v ? 'text' : 'password';
    toggle.classList.toggle('on', v);
    toggle.setAttribute('aria-pressed', String(v));
    toggle.title = v ? 'Hide password' : 'Show password';
    toggle.setAttribute('aria-label', toggle.title);
  };
  toggle.addEventListener('click', () => {
    setShown(!shown);
    input.focus();
  });
  input.addEventListener('input', () => opts.onInput?.(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      opts.onEnter?.();
    }
  });
  if (opts.autofocus) requestAnimationFrame(() => input.focus());
  // A real getter: Object.assign would copy the value once instead.
  const el = Object.assign(wrap, { input, setShown }) as HTMLDivElement & { input: HTMLInputElement; setShown: (v: boolean) => void; readonly value: string };
  Object.defineProperty(el, 'value', { get: () => input.value });
  return el;
}

export function strengthMeter() {
  const bars = [0, 1, 2, 3].map(() => h('i', {}));
  const label = h('span', { class: 'ut-meter-label' });
  const hint = h('p', { class: 'hint ut-meter-hint' });
  const el = h('div', { class: 'ut-meter-wrap' }, h('div', { class: 'ut-meter', 'aria-hidden': 'true' }, ...bars), label);
  const box = h('div', { class: 'ut-strength' }, el, hint);
  return Object.assign(box, {
    update(pw: string) {
      const s = strength(pw);
      box.dataset.score = String(s.score);
      bars.forEach((b, i) => b.classList.toggle('on', i < s.score));
      label.textContent = s.label;
      hint.textContent = s.hint;
    },
  });
}
