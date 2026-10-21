// Edit: photo adjustments rendered by one WebGL2 fragment shader. The preview draws at screen
// size from a mipmapped full-resolution texture; Save renders the same shader into a
// full-size framebuffer, so what you see is what you get.
import { api, base, h, saveBytes, section, shell, slider } from '../../shared/ui';
import { icon } from '../../shared/icons';
import { History, canvasBytes, defaultFormat, dims, flatten, formatSection, loadBitmap, rafThrottle, toolButton, undoKeys, xicon } from './common';

interface Param {
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  fmt?: (v: number) => string;
}

const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

const GROUPS: { title: string; params: Param[] }[] = [
  {
    title: 'Light',
    params: [
      { key: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.05, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV` },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
      { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
      { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
      { key: 'whites', label: 'Whites', min: -100, max: 100 },
      { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
    ],
  },
  {
    title: 'Colour',
    params: [
      { key: 'temp', label: 'Temperature', min: -100, max: 100 },
      { key: 'tint', label: 'Tint', min: -100, max: 100 },
      { key: 'vibrance', label: 'Vibrance', min: -100, max: 100 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
    ],
  },
  {
    title: 'Detail',
    params: [
      { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
      { key: 'dehaze', label: 'Dehaze', min: -100, max: 100 },
      { key: 'sharp', label: 'Sharpness', min: 0, max: 100 },
      { key: 'nr', label: 'Noise reduction', min: 0, max: 100 },
    ],
  },
  {
    title: 'Effects',
    params: [
      { key: 'vignette', label: 'Vignette', min: -100, max: 100 },
      { key: 'grain', label: 'Grain', min: 0, max: 100 },
    ],
  },
];
const ALL = GROUPS.flatMap((g) => g.params);
type Values = Record<string, number>;
const zero = (): Values => Object.fromEntries(ALL.map((p) => [p.key, 0]));

const VS = `#version 300 es
in vec2 a_pos;
uniform float u_flip;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5 * u_flip);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_img;
uniform sampler2D u_blur;
uniform vec2 u_px;
uniform vec2 u_src;
uniform float u_aspect;
uniform int u_bypass;
uniform float u_exposure, u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_temp, u_tint, u_vibrance, u_saturation;
uniform float u_clarity, u_dehaze, u_sharp, u_nr, u_vignette, u_grain;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 src = texture(u_img, v_uv);
  if (u_bypass == 1) { o = src; return; }
  vec3 c = src.rgb;

  // Detail: one 3x3 neighbourhood feeds both noise reduction (edge-aware) and sharpening.
  if (u_nr > 0.0 || u_sharp > 0.0) {
    vec3 sum = vec3(0.0); float wsum = 0.0;
    vec3 box = vec3(0.0);
    float L0 = lum(c);
    float sigma = 0.03 + 0.17 * u_nr;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 s = texture(u_img, v_uv + vec2(float(x), float(y)) * u_px * 1.5).rgb;
        box += s;
        float d = lum(s) - L0;
        float w = exp(-(d * d) / (2.0 * sigma * sigma));
        sum += s * w; wsum += w;
      }
    }
    box /= 9.0;
    if (u_nr > 0.0) c = mix(c, sum / wsum, min(1.0, u_nr * 1.2));
    if (u_sharp > 0.0) c += (c - box) * u_sharp * 2.0;
  }

  vec3 bl = texture(u_blur, v_uv).rgb;
  if (u_clarity != 0.0) {
    float L = lum(c);
    float mid = 1.0 - pow(abs(L * 2.0 - 1.0), 2.0);
    c += vec3((L - lum(bl)) * u_clarity * 0.9 * mid);
  }
  if (u_dehaze > 0.0) {
    float dark = min(min(bl.r, bl.g), bl.b);
    float t = max(1.0 - u_dehaze * 0.9 * dark, 0.2);
    float A = 0.95;
    c = (c - A * (1.0 - t)) / t;
  } else if (u_dehaze < 0.0) {
    c = mix(c, vec3(0.82, 0.83, 0.85), -u_dehaze * 0.45);
  }

  // Exposure and white balance in linear light.
  vec3 lin = toLin(clamp(c, 0.0, 1.0)) * exp2(u_exposure);
  vec3 wb = vec3(1.0 + 0.28 * u_temp, 1.0 - 0.22 * u_tint, 1.0 - 0.28 * u_temp);
  wb.g *= 1.0 + 0.05 * abs(u_temp);
  wb.rb *= 1.0 + 0.08 * u_tint;
  wb /= lum(wb);
  lin *= wb;
  c = toSrgb(lin);

  // Tone: a luminance curve applied as a ratio so colours keep their hue.
  float L = lum(c);
  float x = clamp(L, 0.0, 1.0);
  x += u_blacks * 0.35 * pow(1.0 - x, 3.0);
  x += u_whites * 0.35 * pow(x, 3.0);
  x += u_shadows * 1.6 * x * (1.0 - x) * (1.0 - x);
  x += u_highlights * 1.6 * x * x * (1.0 - x);
  x = clamp(x, 0.0, 1.0);
  float k = exp(u_contrast * 1.1);
  x = x < 0.5 ? 0.5 * pow(2.0 * x, k) : 1.0 - 0.5 * pow(2.0 - 2.0 * x, k);
  if (L > 0.002) c *= x / L; else c += vec3(x - L);

  // Colour intensity.
  float g = lum(c);
  c = vec3(g) + (c - vec3(g)) * (1.0 + u_saturation);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  g = lum(c);
  c = vec3(g) + (c - vec3(g)) * (1.0 + u_vibrance * (1.0 - clamp(sat, 0.0, 1.0)) * 1.2);

  // Effects.
  if (u_vignette != 0.0) {
    vec2 q = (v_uv - 0.5) * 2.0;
    q.x *= mix(1.0, u_aspect, 0.35);
    float d = length(q) / 1.4142;
    float m = smoothstep(0.3, 1.05, d);
    if (u_vignette < 0.0) c *= 1.0 + u_vignette * 0.85 * m;
    else c = mix(c, vec3(1.0), u_vignette * 0.75 * m);
  }
  if (u_grain > 0.0) {
    float cell = max(1.0, u_src.x / 1800.0);
    float n = hash(floor(v_uv * u_src / cell)) - 0.5;
    float tone = 1.0 - abs(lum(c) * 2.0 - 1.0) * 0.6;
    c += vec3(n * u_grain * 0.22 * tone);
  }
  o = vec4(clamp(c, 0.0, 1.0), src.a);
}`;

// Slider units → shader units.
function uniformsOf(v: Values): Record<string, number> {
  return {
    u_exposure: v.exposure,
    u_contrast: v.contrast / 100,
    u_highlights: v.highlights / 100,
    u_shadows: v.shadows / 100,
    u_whites: v.whites / 100,
    u_blacks: v.blacks / 100,
    u_temp: v.temp / 100,
    u_tint: v.tint / 100,
    u_vibrance: v.vibrance / 100,
    u_saturation: v.saturation / 100,
    u_clarity: v.clarity / 100,
    u_dehaze: v.dehaze / 100,
    u_sharp: v.sharp / 100,
    u_nr: v.nr / 100,
    u_vignette: v.vignette / 100,
    u_grain: v.grain / 100,
  };
}

class Renderer {
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  img: WebGLTexture;
  blur: WebGLTexture;
  loc = new Map<string, WebGLUniformLocation | null>();
  constructor(
    public canvas: HTMLCanvasElement,
    public bmp: ImageBitmap,
    blurSrc: OffscreenCanvas,
  ) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('This computer’s graphics driver does not support WebGL2, which Edit needs.');
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    this.prog = p;
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.img = this.texture(bmp, true);
    this.blur = this.texture(blurSrc, false);
    gl.uniform1i(this.u('u_img'), 0);
    gl.uniform1i(this.u('u_blur'), 1);
  }
  private texture(src: TexImageSource, mips: boolean) {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  private u(name: string) {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.loc.get(name)!;
  }
  private draw(values: Values, w: number, hh: number, bypass: boolean, flip: number) {
    const gl = this.gl;
    gl.viewport(0, 0, w, hh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.img);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blur);
    for (const [k, v] of Object.entries(uniformsOf(values))) gl.uniform1f(this.u(k), v);
    gl.uniform1i(this.u('u_bypass'), bypass ? 1 : 0);
    gl.uniform1f(this.u('u_flip'), flip);
    gl.uniform2f(this.u('u_px'), 1 / w, 1 / hh);
    gl.uniform2f(this.u('u_src'), this.bmp.width, this.bmp.height);
    gl.uniform1f(this.u('u_aspect'), this.bmp.width / this.bmp.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  preview(values: Values, bypass: boolean) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.draw(values, this.canvas.width, this.canvas.height, bypass, 1);
  }
  /** Full-resolution render → straight-alpha RGBA rows, top row first. */
  exportPixels(values: Values): ImageData {
    const gl = this.gl;
    const w = this.bmp.width;
    const hh = this.bmp.height;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, hh);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The image is too large for the graphics card.');
    // Flip so row 0 of readPixels is the top of the image.
    this.draw(values, w, hh, false, -1);
    const data = new Uint8ClampedArray(w * hh * 4);
    gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    return new ImageData(data, w, hh);
  }
}

export async function editImage(paths: string[]) {
  const path = paths[0];
  const s = shell({ title: 'Edit', file: base(path), wide: true });
  s.primary.textContent = 'Save';
  s.primary.disabled = true;
  s.stage.classList.add('ix-stage');
  const skeleton = h('div', { class: 'ix-skel skeleton' });
  s.stage.append(skeleton);

  // Probe the GPU limit before decoding so huge images are scaled once, not twice.
  const probe = document.createElement('canvas').getContext('webgl2');
  const maxTex = probe ? (probe.getParameter(probe.MAX_TEXTURE_SIZE) as number) : 4096;
  probe?.getExtension('WEBGL_lose_context')?.loseContext();
  const bmp = await loadBitmap(path, maxTex);
  skeleton.remove();

  // Low-res blurred copy feeds clarity and dehaze (local contrast / haze estimate).
  const bk = 320 / Math.max(bmp.width, bmp.height);
  const bw = Math.max(1, Math.round(bmp.width * Math.min(1, bk)));
  const bh = Math.max(1, Math.round(bmp.height * Math.min(1, bk)));
  const blurSrc = new OffscreenCanvas(bw, bh);
  const bx = blurSrc.getContext('2d')!;
  bx.filter = `blur(${Math.max(2, Math.round(Math.max(bw, bh) / 40))}px)`;
  bx.drawImage(bmp, 0, 0, bw, bh);

  const canvas = h('canvas', { class: 'ix-gl' });
  s.stage.append(canvas);
  let r: Renderer;
  try {
    r = new Renderer(canvas, bmp, blurSrc);
  } catch (e: any) {
    s.stage.append(h('p', { class: 'empty-state' }, e.message));
    return;
  }

  let values = zero();
  let before = false;
  const draw = rafThrottle(() => r.preview(values, before));

  const fit = () => {
    const rect = s.stage.getBoundingClientRect();
    const pad = 24;
    const top = 56; // room for the floating toolbar
    const k = Math.min((rect.width - pad * 2) / bmp.width, (rect.height - top - pad) / bmp.height, 2);
    const cw = Math.max(1, Math.floor(bmp.width * k));
    const ch = Math.max(1, Math.floor(bmp.height * k));
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.min(bmp.width, Math.round(cw * dpr));
    canvas.height = Math.min(bmp.height, Math.round(ch * dpr));
    r.preview(values, before);
  };
  new ResizeObserver(fit).observe(s.stage);

  // ------------------------------------------------------------ controls
  const sliders = new Map<string, ReturnType<typeof slider>>();
  const hist = new History<Values>(values, () => syncButtons());
  const commit = () => hist.push(values);
  const setAll = (v: Values) => {
    values = { ...zero(), ...v };
    for (const [k, sl] of sliders) sl.set(values[k]);
    markChanged();
    draw();
  };
  const markChanged = () => {
    for (const p of ALL) sliders.get(p.key)!.classList.toggle('ix-changed', values[p.key] !== 0);
    s.status.textContent = `${dims(bmp.width, bmp.height)}${ALL.some((p) => values[p.key] !== 0) ? '' : ' · No changes yet'}`;
  };

  for (const g of GROUPS) {
    const sec = section(g.title);
    for (const p of g.params) {
      const sl = slider({
        label: p.label,
        min: p.min,
        max: p.max,
        step: p.step ?? 1,
        value: 0,
        format: p.fmt ?? signed,
        onInput: (v) => {
          values = { ...values, [p.key]: v };
          markChanged();
          draw();
        },
      });
      sl.input.addEventListener('change', commit);
      sl.input.addEventListener('dblclick', commit);
      sl.title = 'Double-click to reset';
      sliders.set(p.key, sl);
      sec.append(sl);
    }
    s.panel.append(sec);
  }
  const fmt = formatSection(defaultFormat(path));
  s.panel.append(fmt.el);

  // Floating stage controls: compare (hold), undo, redo, reset.
  const undo = () => {
    const v = hist.undo();
    if (v) setAll(v);
  };
  const redo = () => {
    const v = hist.redo();
    if (v) setAll(v);
  };
  const compareBtn = toolButton(xicon('compare'), 'Hold to compare with the original ( \\ )', () => {});
  const setBefore = (b: boolean) => {
    if (before === b) return;
    before = b;
    compareBtn.classList.toggle('on', b);
    badge.hidden = !b;
    draw();
  };
  compareBtn.addEventListener('pointerdown', () => setBefore(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) compareBtn.addEventListener(ev, () => setBefore(false));
  const undoBtn = toolButton(icon('undo', 18), 'Undo (Ctrl+Z)', undo);
  const redoBtn = toolButton(icon('redo', 18), 'Redo (Ctrl+Shift+Z)', redo);
  const resetBtn = h('button', { class: 'btn small ghost', onclick: () => (setAll(zero()), commit()) }, 'Reset all');
  const badge = h('div', { class: 'ix-badge', hidden: true }, 'Original');
  s.stage.append(h('div', { class: 'ix-float' }, compareBtn, undoBtn, redoBtn, h('span', { class: 'sep' }), resetBtn), badge);
  function syncButtons() {
    undoBtn.disabled = !hist.canUndo;
    redoBtn.disabled = !hist.canRedo;
  }
  syncButtons();
  undoKeys(undo, redo);
  window.addEventListener('keydown', (e) => {
    if (e.key === '\\' && !e.repeat) setBefore(true);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === '\\') setBefore(false);
  });
  window.addEventListener('blur', () => setBefore(false));

  markChanged();
  s.primary.disabled = false;
  s.primary.onclick = async () => {
    s.primary.disabled = true;
    s.primary.textContent = 'Saving…';
    try {
      // Give the button state a frame to paint before the heavy readback.
      await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
      const px = r.exportPixels(values);
      let out: OffscreenCanvas = new OffscreenCanvas(px.width, px.height);
      out.getContext('2d')!.putImageData(px, 0, 0);
      const { fmt: f, quality } = fmt.get();
      if (f === 'jpg') out = flatten(out);
      const bytes = await canvasBytes(out, f, quality);
      await saveBytes(path, f, ' edited', bytes);
      api().send('window:close');
    } catch (e: any) {
      s.status.textContent = e?.message ?? String(e);
      s.primary.disabled = false;
      s.primary.textContent = 'Save';
    }
  };
}
