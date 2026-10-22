// Redact: layered boxes that cover, blur or pixelate parts of the photo. Faces (MediaPipe
// BlazeFace) and text (tesseract.js) can be found automatically, fully offline; every
// detection becomes an ordinary box the user can move, resize, restyle or delete.
import { api, base, h, saveBytes, section, segmented, shell, slider } from '../../shared/ui';
import { icon } from '../../shared/icons';
import {
  FitView, HANDLE_CURSOR, History, canvasBytes, clamp, colorPicker, cssVar, defaultFormat, dims, dragRect, drawHandles, flatten,
  formatSection, hitHandle, ownsKeys, loadBitmap, rafThrottle, stageCanvas, toolButton, undoKeys, xicon, type Handle, type Rect,
  capture,
} from './common';

type Style = 'solid' | 'blur' | 'pixelate';
interface Box extends Rect {
  id: number;
  style: Style;
  color: string;
  strength: number; // 0..100
  label: string;
}
interface State {
  boxes: Box[];
  next: number;
}

const COLORS = ['#000000', '#ffffff', '#1d1b18', '#ee6a1f'];
const rel = (p: string) => new URL(p, location.href).href;

/** Reads a local file:// URL (fetch() does not support the file scheme). */
function readUrl(url: string): Promise<ArrayBuffer> {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => (x.status === 0 || x.status === 200 ? res(x.response) : rej(new Error(`Could not read ${url}`)));
    x.onerror = () => rej(new Error(`Could not read ${url}`));
    x.send();
  });
}

/** Draws one redaction into `ctx`, whose current transform maps image px to the target. */
function paintBox(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, src: ImageBitmap, b: Box, pxScale: number) {
  const x = Math.round(b.x), y = Math.round(b.y), w = Math.max(1, Math.round(b.w)), hh = Math.max(1, Math.round(b.h));
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, hh);
  ctx.clip();
  if (b.style === 'solid') {
    ctx.fillStyle = b.color;
    ctx.fillRect(x, y, w, hh);
  } else {
    const s = b.strength / 100;
    const m = Math.min(w, hh);
    // Coarse mosaic first: it is the visible result for "pixelate" and a safe floor under the blur.
    const block = Math.max(2, (b.style === 'pixelate' ? 0.05 + 0.25 * s : 0.2) * m);
    const tw = Math.max(1, Math.round(w / block));
    const th = Math.max(1, Math.round(hh / block));
    const tiny = new OffscreenCanvas(tw, th);
    const tx = tiny.getContext('2d')!;
    tx.imageSmoothingQuality = 'high';
    tx.drawImage(src, x, y, w, hh, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tiny, x, y, w, hh);
    ctx.imageSmoothingEnabled = true;
    if (b.style === 'blur') {
      // Radius scales with the box's short side so a thin text line is as unreadable as a face.
      const r = (0.1 + 0.4 * s) * m;
      const pad = Math.ceil(r * 2);
      const sx = Math.max(0, x - pad), sy = Math.max(0, y - pad);
      const sw = Math.min(src.width, x + w + pad) - sx, sh = Math.min(src.height, y + hh + pad) - sy;
      ctx.filter = `blur(${Math.max(0.5, r * pxScale).toFixed(2)}px)`;
      ctx.drawImage(src, sx, sy, sw, sh, sx, sy, sw, sh);
      ctx.filter = 'none';
    }
  }
  ctx.restore();
}

export async function redactImage(paths: string[]) {
  const path = paths[0];
  const s = shell({ title: 'Redact', file: base(path), wide: true });
  s.primary.disabled = true;
  s.stage.classList.add('ix-stage');
  const skel = h('div', { class: 'ix-skel skeleton' });
  s.stage.append(skel);
  const bmp = await loadBitmap(path);
  skel.remove();
  const W = bmp.width;
  const H = bmp.height;
  // Preview source: blur/pixelate on a screen-size copy keeps dragging smooth on huge photos.
  const small = Math.max(W, H) > 2400 ? await createImageBitmap(bmp, { resizeWidth: Math.round((W * 2400) / Math.max(W, H)), resizeQuality: 'high' }) : bmp;
  const smallK = small.width / W;

  let state: State = { boxes: [], next: 1 };
  let nudgeT = 0;
  let selected: number | null = null;
  const defaults = { style: 'blur' as Style, color: '#000000', strength: 60 };

  const view = new FitView(W, H, 28);
  const sc = stageCanvas(s.stage, (w, hh) => (view.fit(w, hh), draw()));
  const canvas = sc.canvas;

  const draw = rafThrottle(() => {
    sc.begin();
    const ctx = sc.ctx;
    const dpr = window.devicePixelRatio || 1;
    const k = view.scale / smallK;
    ctx.save();
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.ox, dpr * view.oy);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0);
    for (const b of state.boxes) {
      paintBox(ctx, small, { ...b, x: b.x * smallK, y: b.y * smallK, w: b.w * smallK, h: b.h * smallK }, dpr * k);
    }
    ctx.restore();
    ctx.strokeStyle = cssVar('--line');
    ctx.strokeRect(Math.round(view.ox) - 0.5, Math.round(view.oy) - 0.5, Math.round(W * view.scale) + 1, Math.round(H * view.scale) + 1);
    const accent = cssVar('--accent');
    for (const b of state.boxes) {
      const p = view.toView(b.x, b.y);
      const r = { x: p.x, y: p.y, w: b.w * view.scale, h: b.h * view.scale };
      ctx.save();
      ctx.lineWidth = b.id === selected ? 1.5 : 1;
      ctx.strokeStyle = b.id === selected ? accent : 'rgba(255,255,255,0.7)';
      ctx.setLineDash(b.id === selected ? [] : [4, 3]);
      ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
      ctx.restore();
      if (b.id === selected) drawHandles(ctx, r, accent);
    }
  });

  // ------------------------------------------------------------ history
  const hist = new History<State>(state);
  const commit = () => {
    hist.push(state);
    syncAll();
  };
  const restore = (st: State | null) => {
    if (!st) return;
    state = st;
    if (!state.boxes.some((b) => b.id === selected)) selected = null;
    syncAll();
  };
  // A pending arrow-key nudge is committed first, so Undo takes back the nudge rather than the
  // step before it.
  const flushNudge = () => {
    if (!nudgeT) return;
    clearTimeout(nudgeT);
    nudgeT = 0;
    commit();
  };
  const undo = () => (flushNudge(), restore(hist.undo()));
  const redo = () => (flushNudge(), restore(hist.redo()));
  undoKeys(undo, redo);

  const sel = () => state.boxes.find((b) => b.id === selected) ?? null;
  function addBoxes(rects: (Rect & { label: string })[]) {
    const boxes = rects.map((r, i) => ({ ...r, id: state.next + i, style: defaults.style, color: defaults.color, strength: defaults.strength }));
    state = { boxes: [...state.boxes, ...boxes], next: state.next + boxes.length };
    return boxes;
  }
  function remove(id: number | null) {
    if (id === null) return;
    state = { ...state, boxes: state.boxes.filter((b) => b.id !== id) };
    if (selected === id) selected = null;
    commit();
  }

  // ------------------------------------------------------------ pointer
  const boxAt = (vx: number, vy: number): { b: Box; hd: Handle } | null => {
    // Selected first so its handles win, then top-most.
    const order = [...state.boxes].reverse().sort((a, b) => (a.id === selected ? -1 : b.id === selected ? 1 : 0));
    for (const b of order) {
      const p = view.toView(b.x, b.y);
      const hd = hitHandle({ x: p.x, y: p.y, w: b.w * view.scale, h: b.h * view.scale }, vx, vy, 7, b.id === selected, b.id === selected);
      if (hd) return { b, hd };
    }
    return null;
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const vx = e.clientX - rect.left, vy = e.clientY - rect.top;
    const start = view.toImg(vx, vy);
    const hit = boxAt(vx, vy);
    const bounds = { x: 0, y: 0, w: W, h: H };
    let box: Box;
    let hd: Handle;
    let fresh = false;
    if (hit) {
      box = hit.b;
      hd = hit.hd;
      selected = box.id;
    } else {
      if (start.x < 0 || start.y < 0 || start.x > W || start.y > H) {
        selected = null;
        syncAll();
        return;
      }
      [box] = addBoxes([{ x: start.x, y: start.y, w: 0, h: 0, label: '' }]);
      box.label = `Box ${box.id}`;
      hd = 'se';
      fresh = true;
      selected = box.id;
    }
    const startRect = { x: box.x, y: box.y, w: box.w, h: box.h };
    capture(canvas, e.pointerId);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const rr = canvas.getBoundingClientRect();
      const q = view.toImg(ev.clientX - rr.left, ev.clientY - rr.top);
      const dx = q.x - start.x, dy = q.y - start.y;
      moved = true;
      let nr: Rect;
      if (fresh) {
        const hdl = `${dy < 0 ? 'n' : 's'}${dx < 0 ? 'w' : 'e'}` as Handle;
        nr = dragRect({ x: start.x, y: start.y, w: 0.001, h: 0.001 }, hdl, dx, dy, ev.shiftKey ? 1 : null, bounds, 1);
      } else nr = dragRect(startRect, hd, dx, dy, ev.shiftKey && hd !== 'move' ? startRect.w / startRect.h : null, bounds, 4 / view.scale);
      Object.assign(box, nr);
      draw();
    };
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      if (fresh && box.w * view.scale < 6 && box.h * view.scale < 6) {
        // A click on empty space deselects instead of leaving a speck.
        state = { ...state, boxes: state.boxes.filter((b) => b.id !== box.id) };
        selected = null;
        syncAll();
        return;
      }
      if (moved || fresh) commit();
      else syncAll();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    syncAll();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const rect = canvas.getBoundingClientRect();
    const hit = boxAt(e.clientX - rect.left, e.clientY - rect.top);
    canvas.style.cursor = hit ? HANDLE_CURSOR[hit.hd] : 'crosshair';
  });
  window.addEventListener('keydown', (e) => {
    if (ownsKeys(e) || e.ctrlKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(selected);
    }
    const b = sel();
    if (b && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const st = (e.shiftKey ? 10 : 1) / view.scale;
      b.x = clamp(b.x + (e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0), 0, W - b.w);
      b.y = clamp(b.y + (e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0), 0, H - b.h);
      draw();
      clearTimeout(nudgeT);
      nudgeT = window.setTimeout(flushNudge, 400);
    }
  });

  // ------------------------------------------------------------ detection
  const progress = h('div', { class: 'ix-progress', hidden: true }, h('div'));
  const note = h('p', { class: 'hint' }, 'Drag on the picture to cover any area. Found regions become boxes you can adjust.');
  const setProgress = (f: number | null, text?: string) => {
    progress.hidden = f === null;
    (progress.firstElementChild as HTMLElement).style.width = `${Math.round((f ?? 0) * 100)}%`;
    if (text !== undefined) note.textContent = text;
  };

  /** A copy of the photo no larger than `max` px, plus its scale back to full size. */
  function scaled(max: number) {
    const k = Math.min(1, max / Math.max(W, H));
    const c = new OffscreenCanvas(Math.round(W * k), Math.round(H * k));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return { c, k };
  }

  async function detectFaces(): Promise<Rect[]> {
    const { FilesetResolver, FaceDetector } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(rel('../../vendor/mediapipe'));
    const model = new Uint8Array(await readUrl(rel('../../assets/models/blaze_face_short_range.tflite')));
    const det = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
    });
    try {
      const { c, k } = scaled(2048);
      const found: (Rect & { score: number })[] = [];
      const run = (x0: number, y0: number, size: number) => {
        const tile = new OffscreenCanvas(Math.round(Math.min(size, c.width - x0)), Math.round(Math.min(size, c.height - y0)));
        tile.getContext('2d')!.drawImage(c, x0, y0, tile.width, tile.height, 0, 0, tile.width, tile.height);
        for (const d of det.detect(tile as unknown as HTMLCanvasElement).detections) {
          const bb = d.boundingBox;
          if (!bb) continue;
          found.push({ x: (x0 + bb.originX) / k, y: (y0 + bb.originY) / k, w: bb.width / k, h: bb.height / k, score: d.categories?.[0]?.score ?? 0.5 });
        }
      };
      // The short-range model sees a 128 px square, so small faces in big photos need tiles.
      const short = Math.min(c.width, c.height);
      const passes = [Math.max(c.width, c.height), short / 1.5, short / 3].filter((sz, i) => i === 0 || sz >= 160);
      let done = 0;
      const total = passes.reduce((n, sz, i) => n + (i === 0 ? 1 : Math.ceil(c.width / (sz / 2)) * Math.ceil(c.height / (sz / 2))), 0);
      for (const [i, size] of passes.entries()) {
        if (i === 0) {
          run(0, 0, size);
          setProgress(++done / total);
          continue;
        }
        const step = size / 2;
        const seen = new Set<string>();
        for (let y = 0; y < c.height - step * 0.5; y += step) {
          for (let x = 0; x < c.width - step * 0.5; x += step) {
            const tx = Math.round(Math.min(x, Math.max(0, c.width - size)));
            const ty = Math.round(Math.min(y, Math.max(0, c.height - size)));
            if (!seen.has(`${tx},${ty}`)) {
              seen.add(`${tx},${ty}`);
              run(tx, ty, size);
            }
            setProgress(++done / total);
          }
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      return merge(found).map((r) => pad(r, 0.12));
    } finally {
      det.close();
    }
  }

  async function detectText(): Promise<(Rect & { label: string })[]> {
    const Tesseract = await import('tesseract.js');
    const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
      workerPath: rel('../../vendor/tesseract/worker.min.js'),
      langPath: rel('../../vendor/tesseract/lang'),
      corePath: rel('../../vendor/tesseract/'),
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: (m: any) => {
        if (m.status === 'recognizing text') setProgress(0.3 + 0.7 * (m.progress ?? 0));
        else setProgress(0.1 + 0.2 * (m.progress ?? 0));
      },
    } as any);
    try {
      const { c, k } = scaled(3000);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const { data } = await worker.recognize(blob, {}, { blocks: true });
      const out: (Rect & { label: string })[] = [];
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            const text = line.text.trim();
            if (!text || line.confidence < 45 || !/[A-Za-z0-9]{2,}/.test(text)) continue;
            const b = line.bbox;
            out.push({ ...pad({ x: b.x0 / k, y: b.y0 / k, w: (b.x1 - b.x0) / k, h: (b.y1 - b.y0) / k }, 0.08), label: `Text “${text.length > 24 ? text.slice(0, 24) + '…' : text}”` });
          }
        }
      }
      return out;
    } finally {
      await worker.terminate();
    }
  }

  function pad(r: Rect, f: number): Rect {
    const px = r.w * f, py = r.h * f;
    const x = Math.max(0, r.x - px), y = Math.max(0, r.y - py);
    return { x, y, w: Math.min(W, r.x + r.w + px) - x, h: Math.min(H, r.y + r.h + py) - y };
  }

  /**
   * Clusters overlapping detections from the whole image and the tiles. A real face is seen by
   * several overlapping crops; texture false positives usually by one, and with lower scores.
   */
  function merge(list: (Rect & { score: number })[]): Rect[] {
    const sorted = [...list].sort((a, b) => b.score - a.score);
    const clusters: { box: Rect & { score: number }; votes: number }[] = [];
    const inter = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    for (const r of sorted) {
      const hit = clusters.find(({ box: k }) => {
        const i = inter(r, k);
        return i / (r.w * r.h + k.w * k.h - i) > 0.3 || i / Math.min(r.w * r.h, k.w * k.h) > 0.6;
      });
      if (hit) hit.votes++;
      else clusters.push({ box: r, votes: 1 });
    }
    return clusters.filter((c) => c.box.score >= 0.85 || (c.box.score >= 0.65 && c.votes >= 2)).map((c) => c.box);
  }

  const faceBtn = h('button', { class: 'btn', html: `${xicon('faceScan', 16)}<span>Faces</span>` });
  const textBtn = h('button', { class: 'btn', html: `${xicon('textScan', 16)}<span>Text</span>` });
  async function runDetect(kind: 'faces' | 'text') {
    faceBtn.disabled = textBtn.disabled = true;
    setProgress(0.02, kind === 'faces' ? 'Looking for faces…' : 'Reading text… this can take a few seconds.');
    try {
      if (kind === 'faces') {
        const rects = await detectFaces();
        const n0 = state.boxes.filter((b) => b.label.startsWith('Face')).length;
        const added = addBoxes(rects.map((r, i) => ({ ...r, label: `Face ${n0 + i + 1}` })));
        setProgress(null, added.length ? `Found ${added.length} face${added.length === 1 ? '' : 's'}.` : 'No faces found. Drag on the picture to cover one by hand.');
      } else {
        const added = addBoxes(await detectText());
        setProgress(null, added.length ? `Found ${added.length} line${added.length === 1 ? '' : 's'} of text.` : 'No readable text found.');
      }
      commit();
    } catch (e: any) {
      console.error(e);
      setProgress(null, `Detection failed: ${e?.message ?? e}`);
    } finally {
      faceBtn.disabled = textBtn.disabled = false;
    }
  }
  faceBtn.onclick = () => runDetect('faces');
  textBtn.onclick = () => runDetect('text');

  // ------------------------------------------------------------ panel
  const styleSeg = segmented(
    [
      { value: 'blur', label: 'Blur' },
      { value: 'pixelate', label: 'Pixelate' },
      { value: 'solid', label: 'Solid' },
    ],
    defaults.style,
    (v) => setStyle({ style: v as Style }),
  );
  const colors = colorPicker(COLORS, defaults.color, (c) => setStyle({ color: c }));
  const colorField = h('div', { class: 'field' }, colors);
  const strength = slider({ label: 'Strength', min: 0, max: 100, value: 60, onInput: (v) => setStyle({ strength: v }, false) });
  strength.input.addEventListener('change', () => commit());
  function setStyle(p: Partial<Pick<Box, 'style' | 'color' | 'strength'>>, push = true) {
    Object.assign(defaults, p);
    const b = sel();
    if (b) Object.assign(b, p);
    if (push && b) commit();
    else syncAll();
  }
  const applyAll = h(
    'button',
    {
      class: 'btn small',
      onclick: () => {
        state = { ...state, boxes: state.boxes.map((b) => ({ ...b, style: defaults.style, color: defaults.color, strength: defaults.strength })) };
        commit();
      },
    },
    'Apply to all boxes',
  );
  const styleTitle = h('h2', {}, 'New boxes');
  const styleSec = h('div', { class: 'section' }, styleTitle, h('div', { class: 'field' }, styleSeg), colorField, strength, h('div', { class: 'field' }, applyAll));

  const layers = h('div', { class: 'ix-layers' });
  const layersTitle = h('h2', {}, 'Boxes');
  const undoBtn = toolButton(icon('undo', 16), 'Undo (Ctrl+Z)', undo);
  const redoBtn = toolButton(icon('redo', 16), 'Redo (Ctrl+Shift+Z)', redo);
  const clearBtn = h('button', { class: 'btn small ghost', onclick: () => ((state = { ...state, boxes: [] }), (selected = null), commit()) }, 'Remove all');
  const fmt = formatSection(defaultFormat(path));
  s.panel.append(
    section('Find automatically', h('div', { class: 'row' }, faceBtn, textBtn), progress, note),
    styleSec,
    h('div', { class: 'section' }, h('div', { class: 'ix-layers-head' }, layersTitle, undoBtn, redoBtn, clearBtn), layers),
    fmt.el,
  );

  function syncAll() {
    const b = sel();
    styleTitle.textContent = b ? 'Selected box' : 'New boxes';
    const cur = b ?? defaults;
    styleSeg.set(cur.style);
    colors.set(cur.color);
    strength.set(cur.strength);
    colorField.style.display = cur.style === 'solid' ? '' : 'none';
    strength.style.display = cur.style === 'solid' ? 'none' : '';
    applyAll.style.display = state.boxes.length > 1 ? '' : 'none';
    undoBtn.disabled = !hist.canUndo;
    redoBtn.disabled = !hist.canRedo;
    clearBtn.disabled = !state.boxes.length;
    layersTitle.textContent = `Boxes (${state.boxes.length})`;
    layers.replaceChildren(
      ...(state.boxes.length
        ? [...state.boxes].reverse().map((x) =>
            h(
              'div',
              {
                class: `ix-layer${x.id === selected ? ' on' : ''}`,
                onclick: () => ((selected = x.id), syncAll()),
              },
              x.style === 'solid'
                ? h('span', { class: 'chip', style: { background: x.color } })
                : h('span', { class: 'chip-icon', html: xicon(x.style === 'blur' ? 'blur' : 'pixel', 14) }),
              h('span', { class: 'name' }, x.label),
              h('span', { class: 'muted' }, x.style === 'solid' ? 'Solid' : x.style === 'blur' ? 'Blur' : 'Pixelate'),
              toolButton(xicon('x', 14), `Remove ${x.label}`, () => remove(x.id)),
            ),
          )
        : [h('p', { class: 'muted' }, 'No boxes yet.')]),
    );
    s.status.textContent = `${dims(W, H)} · ${state.boxes.length} box${state.boxes.length === 1 ? '' : 'es'}`;
    s.primary.disabled = false;
    draw();
  }
  syncAll();

  s.primary.onclick = async () => {
    s.primary.disabled = true;
    s.primary.textContent = 'Saving…';
    try {
      const out = new OffscreenCanvas(W, H);
      const ctx = out.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      for (const b of state.boxes) paintBox(ctx, bmp, b, 1);
      const { fmt: f, quality } = fmt.get();
      const bytes = await canvasBytes(f === 'jpg' ? flatten(out) : out, f, quality);
      await saveBytes(path, f, ' redacted', bytes);
      api().send('window:close');
    } catch (e: any) {
      s.status.textContent = e?.message ?? String(e);
      s.primary.disabled = false;
      s.primary.textContent = 'Save';
    }
  };
  (window as any).__redact = { get state() { return state; }, runDetect };
}
