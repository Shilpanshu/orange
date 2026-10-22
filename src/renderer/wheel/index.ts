import { wheelItems, extFromMime, extOf, pinKey, type WheelItem, type WheelKind, type WheelPrefs } from '../../shared/catalog';
import { icon } from '../shared/icons';

declare const orange: import('../../preload/preload').OrangeApi;

const C = 220; // centre of the 440px stage
const R_OUT = 200;
const R_IN = 72;
const TITLES: Record<WheelKind, string> = { convert: 'Convert', tools: 'Tools', actions: 'Actions' };

const stage = document.getElementById('stage')!;
const ring = document.getElementById('ring')!;
const wedges = document.getElementById('wedges')!;
const ringTop = document.getElementById('ringTop')!;
const labels = document.getElementById('labels')!;
const hubTitle = document.getElementById('hubTitle')!;
const hubSub = document.getElementById('hubSub')!;
const hubKeys = document.getElementById('hubKeys')!;
const hub = document.getElementById('hub')!;
const hubThumb = document.getElementById('hubThumb')!;
const hubName = document.getElementById('hubName')!;
let prefs: WheelPrefs | undefined;
let recentIdx = -1; // slice chosen last time for this file type; pre-selected

let wheel: WheelKind = 'convert';
let mode: 'drag' | 'click' = 'drag';
let items: WheelItem[] = [];
let exts: string[] = [];
let hasFolder = false;
let knownPaths: string[] | undefined;
let hover = -1; // segment under the pointer
let picked = -1; // segment chosen with the keyboard
let shown = -1; // segment currently highlighted
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let keyNames: Record<WheelKind, string> = { convert: 'Shift', tools: 'Ctrl', actions: 'Alt' };

orange.invoke<Record<WheelKind, string>>('settings:keyNames').then((k) => k && (keyNames = k));

function polar(r: number, a: number) {
  return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) };
}

function segPath(i: number, n: number) {
  const gap = n > 1 ? 0.0 : 0;
  const a0 = (i / n) * Math.PI * 2 - Math.PI / n + gap;
  const a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / n - gap;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const o0 = polar(R_OUT, a0), o1 = polar(R_OUT, a1), i0 = polar(R_IN, a1), i1 = polar(R_IN, a0);
  if (n === 1) {
    return `M${C - R_OUT},${C}a${R_OUT},${R_OUT} 0 1,0 ${R_OUT * 2},0a${R_OUT},${R_OUT} 0 1,0 -${R_OUT * 2},0Z`;
  }
  return `M${o0.x},${o0.y}A${R_OUT},${R_OUT} 0 ${large} 1 ${o1.x},${o1.y}L${i0.x},${i0.y}A${R_IN},${R_IN} 0 ${large} 0 ${i1.x},${i1.y}Z`;
}

/** Pixel box around slice i of n (whole pixels, a pixel of slack for anti-aliasing). */
function segBox(i: number, n: number) {
  if (n === 1) return { x: C - R_OUT - 1, y: C - R_OUT - 1, w: R_OUT * 2 + 2, h: R_OUT * 2 + 2 };
  const a0 = (i / n) * Math.PI * 2 - Math.PI / n;
  const a1 = a0 + (Math.PI * 2) / n;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (p: { x: number; y: number }) => {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  };
  for (let k = 0; k <= 24; k++) {
    const a = a0 + ((a1 - a0) * k) / 24;
    take(polar(R_OUT, a));
    take(polar(R_IN, a));
  }
  // The outer arc bulges past its sampled points at the compass points it crosses.
  for (let q = -4; q <= 8; q++) {
    const a = (q * Math.PI) / 2;
    if (a > a0 && a < a1) take(polar(R_OUT, a));
  }
  const x = Math.floor(x0) - 1, y = Math.floor(y0) - 1;
  return { x, y, w: Math.ceil(x1) + 1 - x, h: Math.ceil(y1) + 1 - y };
}

function render(swap = false) {
  items = wheelItems(wheel, exts, hasFolder, prefs);
  const n = items.length;
  recentIdx = items.findIndex((it) => it.recent);
  // Pre-select last time's choice: dropping on the centre repeats it.
  if (picked < 0 && recentIdx >= 0) picked = recentIdx;
  // The ring is three stacked pieces so that hovering never repaints the shadowed base disc:
  // the base (with its drop shadow), one small layer per slice highlight (faded with opacity
  // alone, on the compositor), and the dividers and hole on top.
  ring.innerHTML = `<circle class="base" cx="${C}" cy="${C}" r="${R_OUT}"/>`;
  wedges.innerHTML = items
    .map((_, i) => {
      const b = segBox(i, n);
      return `<svg class="seg" data-i="${i}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"><path d="${segPath(i, n)}"/></svg>`;
    })
    .join('');
  let svg = '';
  if (n > 1) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / n;
      const p0 = polar(R_IN, a), p1 = polar(R_OUT, a);
      svg += `<line class="divider" x1="${p0.x}" y1="${p0.y}" x2="${p1.x}" y2="${p1.y}"/>`;
    }
  }
  svg += `<circle class="hole" cx="${C}" cy="${C}" r="${R_IN}"/>`;
  ringTop.innerHTML = svg;

  const dense = n > 8;
  // Past 12 slices one ring of labels no longer fits side by side (the image Tools wheel plus
  // presets easily reaches 15–20), so neighbouring labels alternate between an outer and an
  // inner ring and use a compact style.
  const crowded = n > 12;
  labels.innerHTML = items
    .map((it, i) => {
      const a = (i / n) * Math.PI * 2;
      const r = crowded ? (i % 2 ? R_IN + 36 : R_OUT - 34) : (R_OUT + R_IN) / 2 + 2;
      const p = polar(r, a);
      const body = it.icon
        ? `<span class="ic">${icon(it.icon, 20)}</span><span class="txt">${esc(it.label)}</span>`
        : `<span class="fmt">${esc(it.label)}</span>${it.sub ? `<span class="cap">${esc(it.sub)}</span>` : ''}`;
      const marks = `${it.pinned ? `<span class="pin" title="Pinned">${icon('star', 10, 2)}</span>` : ''}${it.recent ? '<span class="recent" title="Last used"></span>' : ''}`;
      return `<div class="label${dense ? ' dense' : ''}${crowded ? ' crowded' : ''}${it.pinned ? ' pinned' : ''}" data-i="${i}" style="left:${p.x}px;top:${p.y}px">${marks}${body}</div>`;
    })
    .join('');

  hubKeys.innerHTML = (['convert', 'tools', 'actions'] as WheelKind[])
    .map((w) => `<span class="${w === wheel ? 'on' : ''}">${keyNames[w]}</span>`)
    .join('');
  stage.classList.toggle('empty', n === 0);
  shown = -1;
  setActive(-1);
  // Switching wheels while open: the new labels fade up (opacity only, so it stays on the
  // compositor; no forced reflow to restart a CSS animation). Skipped with reduced motion, which
  // the stylesheet's rule can't reach for script-driven animations.
  if (swap && !reducedMotion.matches) {
    for (const el of [labels, hubTitle]) el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function setActive(i: number) {
  hover = i;
  const on = i >= 0 ? i : picked;
  if (on !== shown) {
    wedges.children[shown]?.classList.remove('on');
    labels.children[shown]?.classList.remove('on');
    wedges.children[on]?.classList.add('on');
    labels.children[on]?.classList.add('on');
    shown = on;
  }
  const it = items[on];
  hubTitle.textContent = it ? (it.icon ? it.label : `To ${it.label}`) : TITLES[wheel];
  if (it && i < 0 && on === recentIdx) hubSub.textContent = mode === 'click' ? 'Last used · Enter to repeat' : 'Last used · drop here to repeat';
  else hubSub.textContent = it ? (it.icon ? it.sub ?? '' : it.sub ?? describe()) : items.length ? describe() : emptyText();
}

/** Flash the chosen slice so the drop visibly "lands" before the wheel fades. */
function flash(i: number) {
  wedges.children[i]?.classList.add('chosen');
  labels.querySelector(`.label[data-i="${i}"]`)?.classList.add('chosen');
  stage.classList.add('landed');
}

function choose(i: number, paths: string[]) {
  flash(i);
  orange.send('wheel:choose', items[i].id, paths);
}

function setPreview(p: { thumb: string; name: string; count: number } | null) {
  hub.classList.toggle('has-preview', !!p);
  if (!p) return;
  hubThumb.replaceChildren();
  if (p.thumb) {
    const img = new Image();
    img.className = 'hub-thumb';
    img.alt = '';
    img.src = p.thumb;
    hubThumb.append(img);
  }
  hubName.textContent = p.count > 1 ? `${p.name} +${p.count - 1}` : p.name;
}

function describe() {
  const n = knownPaths?.length ?? Math.max(exts.length, hasFolder ? 1 : 0);
  if (!n) return 'Drop on a slice';
  return n === 1 ? (mode === 'click' ? 'Pick a slice' : 'Drop on a slice') : `${n} items`;
}
function emptyText() {
  return wheel === 'tools' ? 'No tools for this file' : 'Nothing to convert';
}

function segmentAt(x: number, y: number): number {
  const dx = x - C, dy = y - C;
  const r = Math.hypot(dx, dy);
  if (r < R_IN || r > R_OUT + 24 || items.length === 0) return -1;
  let a = Math.atan2(dx, -dy); // 0 at 12 o'clock, clockwise
  const n = items.length;
  a = (a + Math.PI / n + Math.PI * 4) % (Math.PI * 2);
  return Math.floor((a / (Math.PI * 2)) * n) % n;
}

function show(open: boolean) {
  stage.classList.toggle('open', open);
}

// ------------------------------------------------------------------ IPC in

orange.on(
  'wheel:open',
  (o: { wheel: WheelKind; mode: 'drag' | 'click'; paths?: string[]; prefs?: WheelPrefs; cursor: { x: number; y: number } }) => {
    const wasOpen = stage.classList.contains('open');
    const swap = wasOpen && o.wheel !== wheel;
    wheel = o.wheel;
    mode = o.mode;
    picked = -1;
    if (o.prefs) prefs = o.prefs;
    if (!wasOpen) {
      stage.classList.remove('landed');
      setPreview(null);
    }
    if (o.paths) {
      knownPaths = o.paths;
      exts = o.paths.map(extOf).filter(Boolean);
      hasFolder = o.paths.some((p) => !extOf(p));
    } else if (!wasOpen) {
      knownPaths = undefined;
    }
    // Set on the stage itself rather than through inherited custom properties, which would
    // restyle every slice and label.
    stage.style.transformOrigin = `${o.cursor.x}px ${o.cursor.y}px`;
    render(swap);
    show(true);
    // Tells the host the wheel is painted (Orange 2 measures open latency from this).
    requestAnimationFrame(() => orange.send('wheel:shown'));
  },
);

orange.on('wheel:close', () => {
  show(false);
  hover = picked = -1;
  selPaths = null;
  dragCount = -1;
});

orange.on('wheel:preview', (p: { thumb: string; name: string; count: number }) => setPreview(p));

function nav(key: string) {
  const n = items.length;
  if (key === 'escape') return orange.send('wheel:dismiss');
  if (!n) return;
  const cur = picked >= 0 ? picked : hover;
  if (key === 'enter') {
    if (mode === 'click' && cur >= 0 && knownPaths) choose(cur, knownPaths);
    return;
  }
  if (key === 'right' || key === 'down' || key === 'tab') picked = (cur + 1 + n) % n;
  else picked = cur < 0 ? n - 1 : (cur - 1 + n) % n;
  setActive(-1);
}

// Arrow keys during a drag come from the global keyboard hook in the main process.
orange.on('wheel:nav', nav);

// ------------------------------------------------------------- drag & drop

// Exact paths from the Explorer selection (drag mode). Trusted only while the number of
// dragged items matches, so a stale selection never overrides a drag from another app.
let selPaths: string[] | null = null;
let dragCount = -1;

function applySelection() {
  if (!selPaths || knownPaths) return false;
  if (dragCount >= 0 && dragCount !== selPaths.length) {
    setPreview(null); // the selection isn't what's being dragged
    return false;
  }
  const next = selPaths.map(extOf).filter(Boolean);
  const folder = selPaths.some((p) => !extOf(p));
  if (next.join() !== exts.join() || folder !== hasFolder) {
    exts = next;
    hasFolder = folder;
    render();
  }
  return true;
}

orange.on('wheel:paths', (paths: string[]) => {
  selPaths = paths;
  applySelection();
});

function sniff(dt: DataTransfer | null) {
  if (!dt || knownPaths) return;
  dragCount = Array.from(dt.items).filter((i) => i.kind === 'file').length;
  if (applySelection()) return;
  const next: string[] = [];
  let folder = false;
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const ext = extFromMime(item.type);
    if (ext) next.push(ext);
    else folder = true; // folders and unknown types both arrive without a MIME type
  }
  const changed = next.join() !== exts.join() || folder !== hasFolder;
  exts = next;
  hasFolder = folder;
  if (changed) render();
}

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  sniff(e.dataTransfer);
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  const i = segmentAt(e.clientX, e.clientY);
  if (i !== hover) setActive(i);
});
window.addEventListener('dragleave', () => {
  if (hover !== -1) setActive(-1);
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  dropAt(e.clientX, e.clientY, files.map((f) => orange.pathForFile(f)).filter(Boolean));
});

function dropAt(x: number, y: number, paths: string[]) {
  let i = segmentAt(x, y);
  // Dropped on the centre: arrow-key choice or last time's choice. A drop outside the ring (the
  // window's transparent corners) is a cancel, as in click mode.
  if (i < 0 && Math.hypot(x - C, y - C) < R_IN) i = picked;
  if (i < 0 || !paths.length) return orange.send('wheel:dismiss');
  // The real file names may disagree with the MIME guess; the main process re-validates.
  choose(i, paths);
}

// Orange 2 (Tauri): the window's own OLE drop target reports the exact dragged paths on enter,
// so no MIME guessing is needed. Coordinates are CSS pixels in the window.
orange.on('wheel:drag', (d: { type: 'enter' | 'over' | 'drop' | 'leave'; paths?: string[]; x: number; y: number }) => {
  if (d.type === 'leave') {
    if (hover !== -1) setActive(-1);
    return;
  }
  if (d.type === 'drop') return dropAt(d.x, d.y, d.paths ?? []);
  if (d.type === 'enter' && d.paths && !knownPaths) {
    selPaths = d.paths;
    dragCount = d.paths.length;
    applySelection();
  }
  const i = segmentAt(d.x, d.y);
  if (i !== hover) setActive(i);
});

// ------------------------------------------- click mode (Explorer selection hotkey)

window.addEventListener('mousemove', (e) => {
  if (mode !== 'click') return;
  const i = segmentAt(e.clientX, e.clientY);
  if (i !== hover) setActive(i);
});
window.addEventListener('mousedown', (e) => {
  if (mode !== 'click' || e.button !== 0) return;
  const i = segmentAt(e.clientX, e.clientY);
  if (i >= 0 && knownPaths) choose(i, knownPaths);
  else if (Math.hypot(e.clientX - C, e.clientY - C) < R_IN && picked >= 0 && knownPaths) choose(picked, knownPaths);
  else orange.send('wheel:dismiss');
});
// Right-click a slice to pin it: pinned slices come first for this kind of file.
window.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  if (mode !== 'click') return;
  const i = segmentAt(e.clientX, e.clientY);
  if (i < 0 || !prefs) return;
  prefs = { ...prefs, favorites: await orange.invoke<WheelPrefs['favorites']>('wheel:togglePin', pinKey(wheel, exts, hasFolder), items[i].id) };
  picked = -1;
  render();
});
window.addEventListener('keydown', (e) => {
  if (mode !== 'click') return;
  const map: Record<string, string> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter', Escape: 'escape', Tab: 'tab' };
  if (map[e.key]) {
    e.preventDefault();
    nav(map[e.key]);
  }
});

render();

// Lay each wheel out once while hidden, so the first real opening doesn't pay for loading fonts
// and first-time layout (about 25 ms for a 20-slice Tools wheel, a dropped frame on open).
function warmUp() {
  if (stage.classList.contains('open')) return;
  const saved = { wheel, exts, hasFolder, picked };
  const kinds: [WheelKind, string[]][] = [['tools', ['jpg']], ['actions', ['jpg']], ['convert', ['mp4']]];
  for (const [w, e] of kinds) {
    wheel = w;
    exts = e;
    hasFolder = false;
    picked = -1;
    render();
    void labels.offsetHeight; // style and layout now, while nobody is watching
  }
  ({ wheel, exts, hasFolder, picked } = saved);
  render();
}
requestIdleCallback(warmUp, { timeout: 1500 });
