// Annotate: vector marks over the photo (arrows, shapes, pen, highlighter, text, numbered
// callouts, magnifier loupes, placed images). Everything is kept in image pixels so the export
// is a sharp full-resolution flatten; the preview just draws the same objects scaled.
import { api, base, checkbox, h, saveBytes, section, shell, slider } from '../../shared/ui';
import { icon } from '../../shared/icons';
import {
  FitView, HANDLE_CURSOR, History, canvasBytes, clamp, colorPicker, cssVar, defaultFormat, dims, dragRect, drawHandles, flatten,
  formatSection, hitHandle, ownsKeys, loadBitmap, normRect, rafThrottle, stageCanvas, toolButton, undoKeys, xicon,
  type Handle, type Rect,
  capture,
} from './common';

type Kind = 'select' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'pen' | 'highlight' | 'text' | 'number' | 'magnify' | 'image';

interface Obj {
  id: number;
  kind: Exclude<Kind, 'select'>;
  color: string;
  width: number; // stroke width in image px
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  pts?: number[];
  text?: string;
  size?: number; // font size / callout radius in image px
  n?: number;
  fill?: boolean;
  bg?: boolean;
  zoom?: number;
  img?: string;
}

interface State {
  objs: Obj[];
  nextId: number;
}

const TOOLS: { kind: Kind; title: string; key: string; svg: () => string }[] = [
  { kind: 'select', title: 'Select and move', key: 'v', svg: () => xicon('cursor') },
  { kind: 'arrow', title: 'Arrow', key: 'a', svg: () => icon('arrow', 18) },
  { kind: 'line', title: 'Line', key: 'l', svg: () => xicon('line') },
  { kind: 'rect', title: 'Rectangle', key: 'r', svg: () => icon('rect', 18) },
  { kind: 'ellipse', title: 'Ellipse', key: 'e', svg: () => icon('ellipse', 18) },
  { kind: 'pen', title: 'Pen', key: 'p', svg: () => icon('pen', 18) },
  { kind: 'highlight', title: 'Highlighter', key: 'h', svg: () => icon('highlight', 18) },
  { kind: 'text', title: 'Text', key: 't', svg: () => icon('text', 18) },
  { kind: 'number', title: 'Numbered callout', key: 'n', svg: () => icon('number', 18) },
  { kind: 'magnify', title: 'Magnifier', key: 'm', svg: () => icon('magnify', 18) },
  { kind: 'image', title: 'Place an image', key: 'i', svg: () => icon('image', 18) },
];

const COLORS = ['#e5372b', '#f07c1b', '#f6c90e', '#2e9e5b', '#2b7de1', '#1d1b18', '#ffffff'];
const FONT = `'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif`;

export async function annotateImage(paths: string[]) {
  const path = paths[0];
  const s = shell({ title: 'Annotate', file: base(path) });
  s.primary.disabled = true;
  s.stage.classList.add('ix-stage');
  const skel = h('div', { class: 'ix-skel skeleton' });
  s.stage.append(skel);
  const bmp = await loadBitmap(path);
  skel.remove();
  const W = bmp.width;
  const H = bmp.height;
  const unit = Math.max(1, Math.max(W, H) / 1000); // "1" on the width slider, in image px

  const images = new Map<string, ImageBitmap>();
  let state: State = { objs: [], nextId: 1 };
  let tool: Kind = 'arrow';
  let selected: number | null = null;
  let editing: number | null = null;
  const style = { color: COLORS[0], width: 4, size: 28, fill: false, bg: false, zoom: 2 };

  const view = new FitView(W, H, 28);
  const sc = stageCanvas(s.stage, (w, hh) => {
    view.fit(w, hh);
    positionEditor();
    draw();
  });
  const canvas = sc.canvas;

  // ------------------------------------------------------------ drawing
  function drawObj(ctx: CanvasRenderingContext2D, o: Obj) {
    ctx.save();
    ctx.strokeStyle = o.color;
    ctx.fillStyle = o.color;
    ctx.lineWidth = o.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (o.kind) {
      case 'line':
        ctx.beginPath();
        ctx.moveTo(o.x1, o.y1);
        ctx.lineTo(o.x2, o.y2);
        ctx.stroke();
        break;
      case 'arrow': {
        const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
        const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
        const head = Math.min(len * 0.6, Math.max(o.width * 4.2, 12));
        const spread = 0.5;
        const bx = o.x2 - Math.cos(ang) * head * 0.8;
        const by = o.y2 - Math.sin(ang) * head * 0.8;
        ctx.beginPath();
        ctx.moveTo(o.x1, o.y1);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(o.x2, o.y2);
        ctx.lineTo(o.x2 - Math.cos(ang - spread) * head, o.y2 - Math.sin(ang - spread) * head);
        ctx.lineTo(o.x2 - Math.cos(ang + spread) * head, o.y2 - Math.sin(ang + spread) * head);
        ctx.closePath();
        ctx.lineWidth = Math.max(1, o.width * 0.6);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'rect': {
        const r = normRect({ x: o.x1, y: o.y1, w: o.x2 - o.x1, h: o.y2 - o.y1 });
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(o.width * 1.2, r.w / 2, r.h / 2));
        if (o.fill) ctx.fill();
        else ctx.stroke();
        break;
      }
      case 'ellipse': {
        const r = normRect({ x: o.x1, y: o.y1, w: o.x2 - o.x1, h: o.y2 - o.y1 });
        ctx.beginPath();
        ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        if (o.fill) ctx.fill();
        else ctx.stroke();
        break;
      }
      case 'pen':
      case 'highlight': {
        const p = o.pts ?? [];
        if (o.kind === 'highlight') {
          ctx.globalAlpha = 0.4;
          ctx.globalCompositeOperation = 'multiply';
          ctx.lineCap = 'butt';
          ctx.lineWidth = o.width;
        }
        ctx.translate(o.x1, o.y1);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        if (p.length <= 2) ctx.lineTo(p[0] + 0.01, p[1]);
        for (let i = 2; i < p.length - 2; i += 2) {
          const mx = (p[i] + p[i + 2]) / 2;
          const my = (p[i + 1] + p[i + 3]) / 2;
          ctx.quadraticCurveTo(p[i], p[i + 1], mx, my);
        }
        if (p.length > 2) ctx.lineTo(p[p.length - 2], p[p.length - 1]);
        ctx.stroke();
        break;
      }
      case 'text': {
        if (editing === o.id) break;
        const size = o.size ?? 28;
        ctx.font = `600 ${size}px ${FONT}`;
        ctx.textBaseline = 'top';
        const lines = (o.text ?? '').split('\n');
        const lh = size * 1.2;
        if (o.bg) {
          const b = textBox(o);
          ctx.fillStyle = contrastOf(o.color);
          ctx.beginPath();
          ctx.roundRect(b.x - size * 0.3, b.y - size * 0.2, b.w + size * 0.6, b.h + size * 0.4, size * 0.25);
          ctx.fill();
          ctx.fillStyle = o.color;
        }
        lines.forEach((ln, i) => ctx.fillText(ln, o.x1, o.y1 + i * lh + size * 0.08));
        break;
      }
      case 'number': {
        const r = o.size ?? 20;
        ctx.beginPath();
        ctx.arc(o.x1, o.y1, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = Math.max(1, r * 0.12);
        ctx.strokeStyle = contrastOf(o.color);
        ctx.stroke();
        ctx.fillStyle = contrastOf(o.color);
        ctx.font = `700 ${r * 1.1}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(o.n ?? 1), o.x1, o.y1 + r * 0.06);
        break;
      }
      case 'magnify': {
        const r = normRect({ x: o.x1, y: o.y1, w: o.x2 - o.x1, h: o.y2 - o.y1 });
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const rad = Math.min(r.w, r.h) / 2;
        const z = o.zoom ?? 2;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.clip();
        const sr = rad / z;
        ctx.drawImage(bmp, cx - sr, cy - sr, sr * 2, sr * 2, cx - rad, cy - rad, rad * 2, rad * 2);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(2, o.width);
        ctx.stroke();
        break;
      }
      case 'image': {
        const im = o.img ? images.get(o.img) : undefined;
        const r = normRect({ x: o.x1, y: o.y1, w: o.x2 - o.x1, h: o.y2 - o.y1 });
        if (im) ctx.drawImage(im, r.x, r.y, r.w, r.h);
        break;
      }
    }
    ctx.restore();
  }

  // A DOM canvas: it resolves system fonts exactly like the stage canvas does.
  const measureCtx = document.createElement('canvas').getContext('2d')!;
  function textBox(o: Obj): Rect {
    const size = o.size ?? 28;
    measureCtx.font = `600 ${size}px ${FONT}`;
    const lines = (o.text || ' ').split('\n');
    const w = Math.max(...lines.map((l) => measureCtx.measureText(l || ' ').width));
    return { x: o.x1, y: o.y1, w, h: lines.length * size * 1.2 };
  }

  function bbox(o: Obj): Rect {
    switch (o.kind) {
      case 'text':
        return textBox(o);
      case 'number': {
        const r = o.size ?? 20;
        return { x: o.x1 - r, y: o.y1 - r, w: r * 2, h: r * 2 };
      }
      case 'pen':
      case 'highlight': {
        const p = o.pts ?? [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < p.length; i += 2) {
          minX = Math.min(minX, p[i]);
          maxX = Math.max(maxX, p[i]);
          minY = Math.min(minY, p[i + 1]);
          maxY = Math.max(maxY, p[i + 1]);
        }
        const pad = o.width / 2;
        return { x: o.x1 + minX - pad, y: o.y1 + minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
      }
      default:
        return normRect({ x: o.x1, y: o.y1, w: o.x2 - o.x1, h: o.y2 - o.y1 });
    }
  }

  const draw = rafThrottle(() => {
    sc.begin();
    const ctx = sc.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0);
    for (const o of state.objs) drawObj(ctx, o);
    ctx.restore();
    // frame
    ctx.strokeStyle = cssVar('--line');
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(view.ox) - 0.5, Math.round(view.oy) - 0.5, Math.round(W * view.scale) + 1, Math.round(H * view.scale) + 1);
    const sel = selObj();
    if (sel && editing !== sel.id) {
      const accent = cssVar('--accent');
      if (sel.kind === 'line' || sel.kind === 'arrow') {
        const a = view.toView(sel.x1, sel.y1);
        const b = view.toView(sel.x2, sel.y2);
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.fillStyle = '#fff';
        ctx.lineWidth = 1.5;
        for (const p of [a, b]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      } else {
        const b = bbox(sel);
        const p = view.toView(b.x, b.y);
        const r = { x: p.x, y: p.y, w: b.w * view.scale, h: b.h * view.scale };
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
        ctx.restore();
        if (resizable(sel)) drawHandles(ctx, r, accent, false);
      }
    }
  });

  const calloutR = (w: number) => Math.max(14, w * 4.5) * unit;
  const resizable = (o: Obj) => ['rect', 'ellipse', 'magnify', 'image', 'text', 'number'].includes(o.kind);
  const selObj = () => state.objs.find((o) => o.id === selected) ?? null;

  // ------------------------------------------------------------ hit testing (image px)
  function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function hit(o: Obj, x: number, y: number, tol: number): boolean {
    const t = tol + o.width / 2;
    switch (o.kind) {
      case 'line':
      case 'arrow':
        return distSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= t;
      case 'pen':
      case 'highlight': {
        const p = o.pts ?? [];
        for (let i = 0; i < p.length - 2; i += 2) if (distSeg(x, y, o.x1 + p[i], o.y1 + p[i + 1], o.x1 + p[i + 2], o.y1 + p[i + 3]) <= t) return true;
        return p.length === 2 && Math.hypot(x - o.x1 - p[0], y - o.y1 - p[1]) <= t;
      }
      case 'rect': {
        const r = bbox(o);
        const inside = x >= r.x - t && x <= r.x + r.w + t && y >= r.y - t && y <= r.y + r.h + t;
        if (!inside) return false;
        if (o.fill) return true;
        return x <= r.x + t || x >= r.x + r.w - t || y <= r.y + t || y >= r.y + r.h - t;
      }
      case 'ellipse': {
        const r = bbox(o);
        const rx = r.w / 2, ry = r.h / 2;
        const nx = (x - r.x - rx) / Math.max(1, rx), ny = (y - r.y - ry) / Math.max(1, ry);
        const d = Math.hypot(nx, ny);
        if (o.fill) return d <= 1 + t / Math.max(1, Math.min(rx, ry));
        return Math.abs(d - 1) * Math.min(rx, ry) <= t;
      }
      default: {
        const r = bbox(o);
        return x >= r.x - tol && x <= r.x + r.w + tol && y >= r.y - tol && y <= r.y + r.h + tol;
      }
    }
  }
  const topHit = (x: number, y: number) => {
    const tol = 5 / view.scale;
    for (let i = state.objs.length - 1; i >= 0; i--) if (hit(state.objs[i], x, y, tol)) return state.objs[i];
    return null;
  };

  // ------------------------------------------------------------ history
  const hist = new History<State>(state);
  const commit = () => {
    hist.push(state);
    syncBar();
  };
  let commitTimer = 0;
  function flushNudge() {
    if (!commitTimer) return;
    clearTimeout(commitTimer);
    commitTimer = 0;
    commit();
  }
  const restore = (st: State | null) => {
    if (!st) return;
    state = st;
    if (!state.objs.some((o) => o.id === selected)) selected = null;
    syncBar();
    syncPanel();
    draw();
  };
  // A pending arrow-key nudge is committed first, so Undo takes back the nudge rather than the
  // step before it.
  const undo = () => (flushNudge(), restore(hist.undo()));
  const redo = () => (flushNudge(), restore(hist.redo()));
  undoKeys(undo, redo);

  // ------------------------------------------------------------ pointer
  type Drag = { move?: (x: number, y: number, e: PointerEvent) => void; up?: () => void };
  let drag: Drag | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || editing !== null) return;
    const rect = canvas.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const p = view.toImg(vx, vy);
    drag = startDrag(p.x, p.y, vx, vy, e);
    if (!drag) return;
    capture(canvas, e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    if (drag) {
      const p = view.toImg(vx, vy);
      drag.move?.(p.x, p.y, e);
      draw();
    } else updateCursor(vx, vy);
  });
  const endDrag = () => {
    if (!drag) return;
    drag.up?.();
    drag = null;
    draw();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function selectedHandle(vx: number, vy: number): Handle | 'p1' | 'p2' | null {
    const o = selObj();
    if (!o) return null;
    if (o.kind === 'line' || o.kind === 'arrow') {
      const a = view.toView(o.x1, o.y1);
      const b = view.toView(o.x2, o.y2);
      if (Math.hypot(vx - a.x, vy - a.y) <= 8) return 'p1';
      if (Math.hypot(vx - b.x, vy - b.y) <= 8) return 'p2';
      return null;
    }
    if (!resizable(o)) return null;
    const b = bbox(o);
    const p = view.toView(b.x, b.y);
    const hd = hitHandle({ x: p.x, y: p.y, w: b.w * view.scale, h: b.h * view.scale }, vx, vy, 7, true, false);
    return hd && hd !== 'move' ? hd : null;
  }

  function updateCursor(vx: number, vy: number) {
    const hd = selectedHandle(vx, vy);
    if (hd === 'p1' || hd === 'p2') canvas.style.cursor = 'grab';
    else if (hd) canvas.style.cursor = HANDLE_CURSOR[hd];
    else if (tool === 'select') {
      const p = view.toImg(vx, vy);
      canvas.style.cursor = topHit(p.x, p.y) ? 'move' : 'default';
    } else if (tool === 'text') canvas.style.cursor = 'text';
    else canvas.style.cursor = 'crosshair';
  }

  function startDrag(x: number, y: number, vx: number, vy: number, e: PointerEvent): Drag | null {
    // 1. Handles of the current selection win in every mode.
    const hd = selectedHandle(vx, vy);
    const sel = selObj();
    if (sel && hd) return resizeDrag(sel, hd, x, y);
    // 2. Select tool: pick / move.
    if (tool === 'select' || tool === 'image') {
      const o = topHit(x, y);
      selected = o?.id ?? null;
      syncPanel();
      if (!o) return null;
      if (e.detail === 2 && o.kind === 'text') {
        openEditor(o);
        return null;
      }
      return moveDrag(o, x, y);
    }
    if (tool === 'text') {
      const o = topHit(x, y);
      if (o && o.kind === 'text') {
        selected = o.id;
        openEditor(o);
        return null;
      }
      const t = add({ kind: 'text', x1: x, y1: y - style.size * unit * 0.6, x2: x, y2: y, text: '', size: style.size * unit, bg: style.bg });
      openEditor(t);
      return null;
    }
    if (tool === 'number') {
      const n = Math.max(0, ...state.objs.filter((o) => o.kind === 'number').map((o) => o.n ?? 0)) + 1;
      const o = add({ kind: 'number', x1: x, y1: y, x2: x, y2: y, n, size: calloutR(style.width) });
      return moveDrag(o, x, y);
    }
    if (tool === 'pen' || tool === 'highlight') {
      const width = (tool === 'highlight' ? style.width * 4 : style.width) * unit;
      const o = add({ kind: tool, x1: x, y1: y, x2: x, y2: y, pts: [0, 0], width });
      let lastX = x, lastY = y;
      return {
        move: (mx, my, ev) => {
          if (Math.hypot(mx - lastX, my - lastY) < 1.5 / view.scale) return;
          if (tool === 'highlight' && ev.shiftKey) {
            // Straight highlighter stroke.
            o.pts = [0, 0, mx - o.x1, my - o.y1];
          } else o.pts!.push(mx - o.x1, my - o.y1);
          lastX = mx;
          lastY = my;
        },
        up: () => commit(),
      };
    }
    // Box/segment tools.
    const kind = tool as Obj['kind'];
    const o = add({ kind, x1: x, y1: y, x2: x, y2: y, fill: style.fill, zoom: style.zoom });
    let moved = false;
    return {
      move: (mx, my, ev) => {
        moved = true;
        let nx = mx, ny = my;
        if (ev.shiftKey && (kind === 'line' || kind === 'arrow')) {
          const ang = Math.round(Math.atan2(my - y, mx - x) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(mx - x, my - y);
          nx = x + Math.cos(ang) * len;
          ny = y + Math.sin(ang) * len;
        } else if ((ev.shiftKey && kind !== 'line' && kind !== 'arrow') || kind === 'magnify') {
          const d = Math.max(Math.abs(mx - x), Math.abs(my - y));
          nx = x + Math.sign(mx - x || 1) * d;
          ny = y + Math.sign(my - y || 1) * d;
        }
        o.x2 = nx;
        o.y2 = ny;
      },
      up: () => {
        const tiny = Math.hypot(o.x2 - o.x1, o.y2 - o.y1) * view.scale < 6;
        if (!moved || tiny) {
          // A click without a drag: drop a sensible default size instead of nothing.
          const d = (kind === 'magnify' ? 160 : kind === 'arrow' || kind === 'line' ? 120 : 100) / view.scale;
          if (kind === 'arrow' || kind === 'line') {
            o.x1 = x - d;
            o.y1 = y + d * 0.6;
            o.x2 = x;
            o.y2 = y;
          } else {
            o.x1 = x - d / 2;
            o.y1 = y - d / 2;
            o.x2 = x + d / 2;
            o.y2 = y + d / 2;
          }
        }
        if (kind !== 'line' && kind !== 'arrow') normalize(o);
        commit();
      },
    };
  }

  function normalize(o: Obj) {
    const r = normRect({ x: o.x1, y: o.y1, w: o.x2 - o.x1, h: o.y2 - o.y1 });
    o.x1 = r.x;
    o.y1 = r.y;
    o.x2 = r.x + r.w;
    o.y2 = r.y + r.h;
  }

  function moveDrag(o: Obj, x: number, y: number): Drag {
    const start = { ...o };
    let moved = false;
    return {
      move: (mx, my) => {
        moved = true;
        const dx = mx - x, dy = my - y;
        o.x1 = start.x1 + dx;
        o.y1 = start.y1 + dy;
        o.x2 = start.x2 + dx;
        o.y2 = start.y2 + dy;
      },
      up: () => {
        if (moved || o.kind === 'number') commit();
      },
    };
  }

  function resizeDrag(o: Obj, hd: Handle | 'p1' | 'p2', x: number, y: number): Drag {
    const start = { ...o };
    const box = bbox(o);
    return {
      move: (mx, my, ev) => {
        if (hd === 'p1' || hd === 'p2') {
          let nx = mx, ny = my;
          if (ev.shiftKey) {
            const ox = hd === 'p1' ? o.x2 : o.x1, oy = hd === 'p1' ? o.y2 : o.y1;
            const ang = Math.round(Math.atan2(my - oy, mx - ox) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(mx - ox, my - oy);
            nx = ox + Math.cos(ang) * len;
            ny = oy + Math.sin(ang) * len;
          }
          if (hd === 'p1') (o.x1 = nx), (o.y1 = ny);
          else (o.x2 = nx), (o.y2 = ny);
          return;
        }
        const keep = o.kind === 'image' || o.kind === 'magnify' || o.kind === 'text' || o.kind === 'number' || ev.shiftKey;
        const r = dragRect(box, hd, mx - x, my - y, keep ? box.w / box.h : null, undefined, 4 / view.scale);
        if (o.kind === 'text') {
          const k = r.h / box.h;
          o.size = Math.max(4, (start.size ?? 28) * k);
          o.x1 = r.x;
          o.y1 = r.y;
        } else if (o.kind === 'number') {
          o.size = Math.max(4, r.w / 2);
          o.x1 = r.x + r.w / 2;
          o.y1 = r.y + r.h / 2;
        } else {
          o.x1 = r.x;
          o.y1 = r.y;
          o.x2 = r.x + r.w;
          o.y2 = r.y + r.h;
        }
      },
      up: () => commit(),
    };
  }

  function add(partial: Partial<Obj> & { kind: Obj['kind'] }): Obj {
    const o: Obj = {
      id: state.nextId,
      color: style.color,
      width: style.width * unit,
      x1: 0, y1: 0, x2: 0, y2: 0,
      ...partial,
    };
    state = { objs: [...state.objs, o], nextId: state.nextId + 1 };
    selected = o.id;
    syncPanel();
    return o;
  }

  function removeSelected() {
    if (selected === null) return;
    state = { ...state, objs: state.objs.filter((o) => o.id !== selected) };
    selected = null;
    commit();
    syncPanel();
    draw();
  }

  // ------------------------------------------------------------ text editor
  let editor: HTMLTextAreaElement | null = null;
  function openEditor(o: Obj) {
    closeEditor();
    editing = o.id;
    selected = o.id;
    const ta = h('textarea', { class: 'ix-text-edit', spellcheck: false }) as HTMLTextAreaElement;
    ta.value = o.text ?? '';
    editor = ta;
    s.stage.append(ta);
    const fit = () => {
      ta.style.height = 'auto';
      ta.style.width = 'auto';
      ta.style.width = `${Math.max(40, ta.scrollWidth + 8)}px`;
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener('input', () => {
      o.text = ta.value;
      fit();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
        e.preventDefault();
        closeEditor();
      }
    });
    ta.addEventListener('blur', () => closeEditor());
    positionEditor();
    fit();
    draw();
    requestAnimationFrame(() => ta.focus());
  }
  function positionEditor() {
    if (!editor || editing === null) return;
    const o = state.objs.find((x) => x.id === editing);
    if (!o) return;
    const p = view.toView(o.x1, o.y1);
    const size = (o.size ?? 28) * view.scale;
    Object.assign(editor.style, {
      left: `${p.x}px`,
      top: `${p.y}px`,
      font: `600 ${size}px ${FONT}`,
      lineHeight: '1.2',
      color: o.color,
      background: o.bg ? contrastOf(o.color) : 'transparent',
    });
  }
  function closeEditor() {
    if (!editor) return;
    const ta = editor;
    editor = null;
    const id = editing;
    editing = null;
    ta.remove();
    const o = state.objs.find((x) => x.id === id);
    if (o && !(o.text ?? '').trim()) {
      state = { ...state, objs: state.objs.filter((x) => x.id !== id) };
      selected = null;
    }
    commit();
    syncPanel();
    draw();
  }

  // ------------------------------------------------------------ toolbar
  const bar = h('div', { class: 'ix-bar' });
  const toolBtns = new Map<Kind, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = toolButton(t.svg(), `${t.title} (${t.key.toUpperCase()})`, () => setTool(t.kind));
    toolBtns.set(t.kind, b);
    bar.append(b);
    if (t.kind === 'select' || t.kind === 'highlight') bar.append(h('span', { class: 'sep' }));
  }
  const undoBtn = toolButton(icon('undo', 18), 'Undo (Ctrl+Z)', undo);
  const redoBtn = toolButton(icon('redo', 18), 'Redo (Ctrl+Shift+Z)', redo);
  const delBtn = toolButton(icon('trash', 18), 'Delete selected (Del)', removeSelected);
  bar.append(h('span', { class: 'spacer' }), undoBtn, redoBtn, delBtn);
  s.main.before(bar);
  function syncBar() {
    undoBtn.disabled = !hist.canUndo;
    redoBtn.disabled = !hist.canRedo;
    delBtn.disabled = selected === null;
    s.status.textContent = `${dims(W, H)} · ${state.objs.length} mark${state.objs.length === 1 ? '' : 's'}`;
  }

  const filePick = h('input', { type: 'file', accept: 'image/*,.heic,.heif,.tif,.tiff', hidden: true }) as HTMLInputElement;
  document.body.append(filePick);
  filePick.addEventListener('change', async () => {
    const f = filePick.files?.[0];
    filePick.value = '';
    if (f) await placeImage(f);
  });
  s.stage.addEventListener('dragover', (e) => e.preventDefault());
  s.stage.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) await placeImage(f);
  });
  async function placeImage(f: File) {
    let im: ImageBitmap;
    try {
      im = await createImageBitmap(f, { imageOrientation: 'from-image' });
    } catch {
      const p = api().pathForFile(f);
      im = await loadBitmap(p);
    }
    const key = `img${images.size + 1}`;
    images.set(key, im);
    const w = Math.min(W * 0.4, im.width);
    const hh = (w * im.height) / im.width;
    add({ kind: 'image', img: key, x1: (W - w) / 2, y1: (H - hh) / 2, x2: (W + w) / 2, y2: (H + hh) / 2 });
    setTool('select');
    commit();
    draw();
  }

  function setTool(k: Kind) {
    closeEditor();
    if (k === 'image') {
      filePick.click();
      return;
    }
    tool = k;
    toolBtns.forEach((b, kk) => b.classList.toggle('on', kk === k));
    syncPanel();
  }

  window.addEventListener('keydown', (e) => {
    if (ownsKeys(e) || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeSelected();
      return;
    }
    const sel = selObj();
    if (sel && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / view.scale;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      sel.x1 += dx;
      sel.x2 += dx;
      sel.y1 += dy;
      sel.y2 += dy;
      draw();
      commitSoon();
      return;
    }
    const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
    if (t) setTool(t.kind);
  });
  const commitSoon = () => {
    clearTimeout(commitTimer);
    commitTimer = window.setTimeout(flushNudge, 400);
  };

  // ------------------------------------------------------------ panel
  const colors = colorPicker(COLORS, style.color, (c) => {
    style.color = c;
    applyToSel((o) => (o.color = c));
  });
  const widthSl = slider({
    label: 'Stroke',
    min: 1,
    max: 30,
    value: 4,
    onInput: (v) => {
      style.width = v;
      applyToSel((o) => {
        if (o.kind === 'number') o.size = calloutR(v);
        else if (o.kind !== 'text' && o.kind !== 'image') o.width = (o.kind === 'highlight' ? v * 4 : v) * unit;
      }, false);
    },
  });
  widthSl.input.addEventListener('change', commit);
  const sizeSl = slider({
    label: 'Text size',
    min: 8,
    max: 160,
    value: 28,
    onInput: (v) => {
      style.size = v;
      applyToSel((o) => o.kind === 'text' && (o.size = v * unit), false);
      positionEditor();
    },
  });
  sizeSl.input.addEventListener('change', commit);
  const zoomSl = slider({
    label: 'Magnification',
    min: 1.25,
    max: 6,
    step: 0.25,
    value: 2,
    format: (v) => `${v}×`,
    onInput: (v) => {
      style.zoom = v;
      applyToSel((o) => o.kind === 'magnify' && (o.zoom = v), false);
    },
  });
  zoomSl.input.addEventListener('change', commit);
  const fillCb = checkbox('Filled shape', false, (v) => {
    style.fill = v;
    applyToSel((o) => (o.kind === 'rect' || o.kind === 'ellipse') && (o.fill = v));
  });
  const bgCb = checkbox('Text background', false, (v) => {
    style.bg = v;
    applyToSel((o) => o.kind === 'text' && (o.bg = v));
    positionEditor();
  });
  function applyToSel(fn: (o: Obj) => void, push = true) {
    const o = selObj();
    if (o) {
      fn(o);
      if (push) commit();
    }
    draw();
  }
  const fmt = formatSection(defaultFormat(path, 'png'));
  s.panel.append(
    section('Colour', colors),
    section('Style', widthSl, sizeSl, zoomSl, fillCb, bgCb),
    fmt.el,
    section(
      'Tips',
      h(
        'p',
        { class: 'hint' },
        'Hold Shift for straight lines and even shapes. Double-click text to edit it. Drag an image file onto the picture to place it. Arrow keys nudge the selection.',
      ),
    ),
  );

  function syncPanel() {
    const o = selObj();
    const k: Kind = o?.kind ?? tool;
    sizeSl.style.display = k === 'text' ? '' : 'none';
    bgCb.style.display = k === 'text' ? '' : 'none';
    zoomSl.style.display = k === 'magnify' ? '' : 'none';
    fillCb.style.display = k === 'rect' || k === 'ellipse' ? '' : 'none';
    widthSl.style.display = k === 'text' || k === 'image' ? 'none' : '';
    if (o) {
      colors.set(o.color);
      style.color = o.color;
      if (o.kind === 'text') sizeSl.set(Math.round((o.size ?? 28) / unit));
      if (o.kind === 'magnify') zoomSl.set(o.zoom ?? 2);
      if (o.kind === 'rect' || o.kind === 'ellipse') (fillCb.querySelector('input') as HTMLInputElement).checked = !!o.fill;
      if (o.kind === 'text') (bgCb.querySelector('input') as HTMLInputElement).checked = !!o.bg;
      if (o.kind !== 'text' && o.kind !== 'image' && o.kind !== 'number') widthSl.set(Math.round(o.width / unit / (o.kind === 'highlight' ? 4 : 1)));
    }
    syncBar();
  }

  setTool('arrow');
  syncBar();
  draw();

  // ------------------------------------------------------------ export
  s.primary.disabled = false;
  s.primary.onclick = async () => {
    closeEditor();
    s.primary.disabled = true;
    s.primary.textContent = 'Saving…';
    try {
      const out = new OffscreenCanvas(W, H);
      const ctx = out.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0);
      for (const o of state.objs) drawObj(ctx as unknown as CanvasRenderingContext2D, o);
      const { fmt: f, quality } = fmt.get();
      const bytes = await canvasBytes(f === 'jpg' ? flatten(out) : out, f, quality);
      await saveBytes(path, f, ' annotated', bytes);
      api().send('window:close');
    } catch (e: any) {
      s.status.textContent = e?.message ?? String(e);
      s.primary.disabled = false;
      s.primary.textContent = 'Save';
    }
  };

  // Test hook for automated checks.
  (window as any).__annotate = { get state() { return state; }, setTool, select: (id: number | null) => ((selected = id), syncPanel(), draw()) };
}

/** Readable ink on top of a colour (for callout numbers and text backgrounds). */
function contrastOf(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? '#1d1b18' : '#ffffff';
}
