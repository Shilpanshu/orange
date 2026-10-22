// Local AI model manager. Models download once from huggingface.co into <userData>/models and then
// load from disk with no network access. Inference runs in the main process on onnxruntime-node,
// on the GPU through DirectML when it works on this PC, otherwise on the CPU.
//
// The API is small on purpose:
//   registerModel(def)                     describe a model (repo, files, size, licence)
//   loadPipeline(task, repo, opts, ctx)    a transformers.js pipeline (downloads on first use)
//   loadModel(repo, opts, ctx)             a transformers.js AutoModel (for custom pre/post-processing)
//   loadOnnx(id, file, opts, ctx)          a raw ONNX Runtime session for a registered raw-file model
//   ensureFiles(id, ctx)                   download a registered model's raw files, return their paths
//   modelStatus(ids?) / deleteModels(ids?) what is on disk, and removing it
//   estimateMs / recordTiming              honest time estimates measured on this PC
//
// Downloads report progress through ctx.progress ("Downloading … (42 MB), first use only") and stop
// when ctx.signal aborts. A model counts as downloaded only when every file in its definition exists,
// so an interrupted download is simply fetched again next time (transformers.js writes atomically).
//
// @huggingface/transformers and onnxruntime-node are loaded lazily with a runtime require so they stay
// out of the esbuild bundle and off the app's startup path.
import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join } from 'node:path';
import type * as TF from '@huggingface/transformers';
import type * as ORT from 'onnxruntime-node';
import { log } from '../log';

/** The subset of a job Ctx the loaders need (tool ctx objects satisfy it). */
export interface AiCtx {
  progress?: (fraction: number, note?: string) => void;
  signal?: AbortSignal;
}

export type Device = 'dml' | 'cpu';
/** 'auto' = DirectML once it has been proven to work for this model on this PC, else CPU. */
export type DevicePref = Device | 'auto';

export interface ModelDef {
  /** Stable key used by modelStatus/deleteModels and timings, e.g. "rmbg". */
  id: string;
  /** Shown to people, e.g. "Background removal". */
  label: string;
  /** Hugging Face repo, e.g. "briaai/RMBG-1.4". Raw-file models may set `urls` instead. */
  repo: string;
  /** Pinned commit for raw-file downloads (transformers models use the cache's "main"). */
  revision?: string;
  /** Files (repo-relative) that must exist for the model to count as downloaded. */
  files: string[];
  /** Explicit download URLs per file, for files hosted outside a HF repo. */
  urls?: Record<string, string>;
  /** Expected sha256 per file for raw downloads (verified after download). */
  sha256?: Record<string, string>;
  /** Approximate download size in MB, shown before the first run. */
  mb: number;
  licence: string;
  /** Typical milliseconds per unit of work (a tile, a page, an image) when nothing was measured yet. */
  msPerUnit?: { cpu: number; dml?: number };
}

export interface ModelState {
  id: string;
  label: string;
  mb: number;
  licence: string;
  ready: boolean;
  /** Bytes on disk now. */
  bytes: number;
  /** Where it will run next time ('dml' only after DirectML has worked for it on this PC). */
  device: Device;
}

// ------------------------------------------------------------------ runtime modules

const nodeRequire = createRequire(__filename);
let tf: typeof TF | null = null;
const als = new AsyncLocalStorage<AbortSignal | undefined>();

/** Folder holding every downloaded model: <userData>/models. */
export function modelsDir(): string {
  const d = join(app.getPath('userData'), 'models');
  mkdirSync(d, { recursive: true });
  return d;
}

/** transformers.js, configured for Orange (cache folder, quiet logs, cancellable downloads). */
export function transformers(): typeof TF {
  if (tf) return tf;
  const mod = nodeRequire('@huggingface/transformers') as typeof TF;
  const env = mod.env;
  env.cacheDir = modelsDir();
  env.useFSCache = true;
  // Local lookups (needed for local_files_only) read the same folder the cache writes, never the
  // package's own /models folder.
  env.allowLocalModels = true;
  env.localModelPath = modelsDir();
  env.logLevel = mod.LogLevel?.ERROR ?? env.logLevel;
  // Downloads go through Chromium's network stack (system proxy, certificates) and stop on Cancel.
  env.fetch = (input: string | URL, init?: any) => net.fetch(String(input), { ...init, signal: init?.signal ?? als.getStore() }) as any;
  tf = mod;
  return mod;
}

/** onnxruntime-node (the same copy transformers.js uses). */
export function ort(): typeof ORT {
  return nodeRequire('onnxruntime-node') as typeof ORT;
}

// ------------------------------------------------------------------ registry + status

const registry = new Map<string, ModelDef>();

export function registerModel(def: ModelDef): ModelDef {
  registry.set(def.id, def);
  return def;
}

export function modelDef(id: string): ModelDef {
  const d = registry.get(id);
  if (!d) throw new Error(`Unknown AI model "${id}"`);
  return d;
}

/** Where a model file lives on disk (same layout transformers.js uses: <models>/<repo>/<file>). */
export function modelFile(id: string, file: string): string {
  return join(modelsDir(), ...modelDef(id).repo.split('/'), ...file.split('/'));
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export function isReady(id: string): boolean {
  const d = modelDef(id);
  return d.files.every((f) => fileSize(modelFile(id, f)) > 0);
}

/** Download state of registered models (all of them when `ids` is omitted). */
export function modelStatus(ids?: string[]): ModelState[] {
  const list = ids ? ids.map(modelDef) : [...registry.values()];
  return list.map((d) => ({
    id: d.id,
    label: d.label,
    mb: d.mb,
    licence: d.licence,
    ready: isReady(d.id),
    bytes: d.files.reduce((a, f) => a + fileSize(modelFile(d.id, f)), 0),
    device: deviceFor(d.id, 'auto'),
  }));
}

/** Deletes downloaded models (all registered ones when `ids` is omitted). They download again on next use. */
export async function deleteModels(ids?: string[]): Promise<void> {
  const list = ids ? ids.map(modelDef) : [...registry.values()];
  for (const d of list) {
    for (const key of [...sessions.keys()]) if (key.startsWith(`${d.id}|`) || key.startsWith(`${d.repo}|`)) await dropSession(key);
    rmSync(join(modelsDir(), ...d.repo.split('/')), { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ devices + timings

interface DeviceState {
  dml?: 'ok' | 'failed';
  ms?: { cpu?: number; dml?: number };
}
const stateFile = () => join(modelsDir(), 'devices.json');
let stateCache: Record<string, DeviceState> | null = null;

function states(): Record<string, DeviceState> {
  if (stateCache) return stateCache;
  try {
    stateCache = JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    stateCache = {};
  }
  return stateCache!;
}

function saveStates() {
  try {
    writeFileSync(stateFile(), JSON.stringify(states(), null, 1));
  } catch {
    /* estimates only */
  }
}

function patchState(key: string, patch: (s: DeviceState) => void) {
  const all = states();
  const s = (all[key] ??= {});
  patch(s);
  saveStates();
}

/** Resolves 'auto' to the device a model should use now. */
export function deviceFor(key: string, pref: DevicePref = 'auto'): Device {
  if (pref !== 'auto') return pref;
  if (process.platform !== 'win32') return 'cpu';
  return states()[key]?.dml === 'ok' ? 'dml' : 'cpu';
}

/** Records how long one unit of work took, so later estimates match this PC. */
export function recordTiming(key: string, device: Device, ms: number) {
  noteActivity();
  if (!Number.isFinite(ms) || ms <= 0) return;
  patchState(key, (s) => {
    s.ms ??= {};
    const prev = s.ms[device];
    s.ms[device] = prev ? Math.round(prev * 0.6 + ms * 0.4) : Math.round(ms);
  });
}

/** Expected milliseconds for `units` of work on the device the model will use next. */
export function estimateMs(id: string, units: number, pref: DevicePref = 'auto'): number {
  const dev = deviceFor(id, pref);
  const measured = states()[id]?.ms?.[dev];
  const def = registry.get(id)?.msPerUnit;
  const per = measured ?? (dev === 'dml' ? def?.dml ?? def?.cpu : def?.cpu) ?? 1000;
  return per * Math.max(0, units);
}

// DirectML's first run of a model compiles GPU shaders, which can take a minute on integrated GPUs
// (later runs, even after a restart, reuse the driver's cache). So a model runs on the CPU until a
// background warm-up has proven DirectML works for it, then switches to the GPU for good.
const warmQueue: { key: string; fn: () => Promise<void> }[] = [];
let warming = false;
/** Last time any model was loaded or run; warm-ups wait for a quiet moment so they never slow a job. */
let lastActivity = 0;
const QUIET_MS = 8000;
const noteActivity = () => (lastActivity = Date.now());

/** Queue a one-time DirectML trial for `key`; `fn` must create a DML session and run it once. */
export function scheduleWarmUp(key: string, fn: () => Promise<void>) {
  if (process.platform !== 'win32') return;
  if (states()[key]?.dml || warmQueue.some((w) => w.key === key)) return;
  warmQueue.push({ key, fn });
  setTimeout(pumpWarm, QUIET_MS).unref?.();
}

async function pumpWarm() {
  if (warming || !warmQueue.length) return;
  const idle = Date.now() - lastActivity;
  if (idle < QUIET_MS) {
    setTimeout(pumpWarm, QUIET_MS - idle + 250).unref?.();
    return;
  }
  const next = warmQueue.shift();
  if (!next) return;
  warming = true;
  const t0 = Date.now();
  try {
    await next.fn();
    patchState(next.key, (s) => (s.dml = 'ok'));
    log(`ai: DirectML ready for ${next.key} (${Date.now() - t0} ms warm-up)`);
  } catch (e: any) {
    patchState(next.key, (s) => (s.dml = 'failed'));
    log(`ai: DirectML unavailable for ${next.key}, staying on CPU`, String(e?.message ?? e).slice(0, 300));
  } finally {
    warming = false;
    if (warmQueue.length) setTimeout(pumpWarm, 1000).unref?.();
  }
}

/** Marks DirectML as unusable for a model after a runtime failure (falls back to CPU next time). */
export function markDmlFailed(key: string) {
  patchState(key, (s) => (s.dml = 'failed'));
}

// ------------------------------------------------------------------ session cache

interface Cached {
  value: Promise<any>;
  dispose: (v: any) => Promise<void> | void;
  timer?: NodeJS.Timeout;
  busy: number;
}
const sessions = new Map<string, Cached>();
const IDLE_MS = 3 * 60_000;

async function dropSession(key: string) {
  const c = sessions.get(key);
  if (!c) return;
  sessions.delete(key);
  if (c.timer) clearTimeout(c.timer);
  try {
    await c.dispose(await c.value);
  } catch {
    /* already gone */
  }
}

function cachedLoad<T>(key: string, create: () => Promise<T>, dispose: (v: T) => Promise<void> | void): Promise<T> {
  let c = sessions.get(key);
  if (!c) {
    const value = create();
    c = { value, dispose, busy: 0 };
    sessions.set(key, c);
    value.catch(() => sessions.delete(key));
  }
  touch(key);
  return c.value;
}

/** Keeps a loaded model in memory for a few minutes after its last use, then frees it. */
function touch(key: string) {
  noteActivity();
  const c = sessions.get(key);
  if (!c) return;
  if (c.timer) clearTimeout(c.timer);
  c.timer = setTimeout(() => void dropSession(key), IDLE_MS);
  c.timer.unref?.();
}

// ------------------------------------------------------------------ downloads

function cancelled() {
  return Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

function downloadNote(label: string, mb: number, f?: number) {
  const pct = f !== undefined && f > 0 ? ` ${Math.round(f * 100)}%` : '';
  return `Downloading ${label} (${Math.max(1, Math.round(mb))} MB), first use only…${pct}`;
}

/** Maps a 0..1 download fraction into the caller's progress span. */
function reporter(ctx: AiCtx | undefined, span: [number, number], label: string, mb: number) {
  let last = -1;
  return (f: number) => {
    const p = Math.round(f * 100);
    if (p === last) return;
    last = p;
    ctx?.progress?.(span[0] + (span[1] - span[0]) * Math.min(1, f), downloadNote(label, mb, f));
  };
}

type DownloadOpts = { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void; sha256?: string };

/** Downloads in progress, by destination: two jobs fetching the same model must not share one .part file. */
const inflight = new Map<string, Promise<void>>();

/** Waits for `p`, but gives up (Cancelled) when `signal` aborts first. */
function untilAborted(p: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Streams a URL to `dest` (atomically, via a .part file). Follows redirects; honours `signal`. */
export async function downloadFile(url: string, dest: string, opts: DownloadOpts = {}) {
  const running = inflight.get(dest);
  if (running) {
    // Another job is already fetching this file: wait for it rather than write the same .part twice.
    await untilAborted(running.catch(() => {}), opts.signal);
    if (fileSize(dest) > 0) return;
  }
  const job = fetchTo(url, dest, opts);
  inflight.set(dest, job);
  try {
    await job;
  } finally {
    if (inflight.get(dest) === job) inflight.delete(dest);
  }
}

async function fetchTo(url: string, dest: string, opts: DownloadOpts) {
  if (opts.signal?.aborted) throw cancelled();
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let res: Response;
  try {
    res = await net.fetch(url, { signal: opts.signal, cache: 'no-store' } as any);
  } catch (e: any) {
    if (opts.signal?.aborted) throw cancelled();
    throw new Error(`network: couldn't reach ${new URL(url).host} (${e?.message ?? e})`);
  }
  if (!res.ok || !res.body) throw new Error(`network: download failed with HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let loaded = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      loaded += value.length;
      opts.onProgress?.(loaded, total);
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    if (opts.signal?.aborted) throw cancelled();
    throw e;
  }
  const digest = hash.digest('hex');
  if (opts.sha256 && digest !== opts.sha256.toLowerCase()) {
    rmSync(part, { force: true });
    throw new Error(`The downloaded file was damaged (checksum mismatch). Try again.`);
  }
  renameSync(part, dest);
}

/** Downloads a registered raw-file model if needed. Returns the absolute paths of its files. */
export async function ensureFiles(id: string, ctx?: AiCtx, span: [number, number] = [0, 0.3]): Promise<string[]> {
  const d = modelDef(id);
  const paths = d.files.map((f) => modelFile(id, f));
  const missing = d.files.filter((f, i) => fileSize(paths[i]) <= 0);
  if (!missing.length) return paths;
  const report = reporter(ctx, span, d.label, d.mb);
  report(0);
  const totalBytes = d.mb * 1e6;
  let doneBytes = 0;
  for (const f of missing) {
    const url = d.urls?.[f] ?? `https://huggingface.co/${d.repo}/resolve/${d.revision ?? 'main'}/${f.split('/').map(encodeURIComponent).join('/')}`;
    let fileLoaded = 0;
    await downloadFile(url, modelFile(id, f), {
      signal: ctx?.signal,
      sha256: d.sha256?.[f],
      onProgress: (l) => {
        fileLoaded = l;
        report(Math.min(0.99, (doneBytes + l) / totalBytes));
      },
    });
    doneBytes += fileLoaded;
  }
  report(1);
  log(`ai: downloaded ${id} (${(doneBytes / 1e6).toFixed(1)} MB)`);
  return paths;
}

// ------------------------------------------------------------------ transformers.js loaders

export interface LoadOpts {
  /** Registered model id for status/timings; defaults to the repo name. */
  id?: string;
  dtype?: TF.DataType | Record<string, TF.DataType>;
  device?: DevicePref;
  /** Label + size for the download note when the model isn't registered. */
  label?: string;
  mb?: number;
  /** Progress span the download maps into (default 0..0.3 of the caller's progress). */
  span?: [number, number];
  /** Extra options passed to transformers.js (session_options, revision…). */
  extra?: Record<string, any>;
  /**
   * For device 'auto': a function that runs one representative inference on a freshly loaded
   * model. When given, a DirectML trial runs in the background after the first CPU use.
   */
  warmUp?: (model: any) => Promise<void>;
  /** Keep the loaded model cached for reuse (default true). */
  cache?: boolean;
}

function labelFor(repo: string, o: LoadOpts) {
  const def = o.id ? registry.get(o.id) : [...registry.values()].find((d) => d.repo === repo);
  return { key: def?.id ?? o.id ?? repo, label: o.label ?? def?.label ?? repo.split('/').pop()!, mb: o.mb ?? def?.mb ?? 0, def };
}

async function tfLoad<T>(kind: 'pipeline' | 'model', repo: string, task: string | null, o: LoadOpts, ctx?: AiCtx): Promise<{ value: T; device: Device }> {
  const T = transformers();
  const { key, label, mb, def } = labelFor(repo, o);
  const device = deviceFor(key, o.device ?? 'auto');
  const ready = def ? isReady(def.id) : false;
  const report = reporter(ctx, o.span ?? [0, 0.3], label, mb);
  const files = new Map<string, [number, number]>();
  const progress_callback = (p: any) => {
    if (p?.status !== 'progress' || !p.file) return;
    files.set(p.file, [p.loaded ?? 0, p.total ?? 0]);
    let l = 0;
    let t = 0;
    for (const [a, b] of files.values()) (l += a), (t += b);
    report(l / Math.max(t, mb * 1e6, 1));
  };
  const make = (dev: Device, localOnly: boolean) => {
    const opts: any = { dtype: o.dtype, device: dev, local_files_only: localOnly, progress_callback, ...o.extra };
    if (dev === 'dml') opts.session_options = { ...(opts.session_options ?? {}), enableMemPattern: false, executionMode: 'sequential' };
    return als.run(ctx?.signal, () => (kind === 'pipeline' ? T.pipeline(task as any, repo, opts) : T.AutoModel.from_pretrained(repo, opts))) as Promise<T>;
  };
  const load = async (dev: Device): Promise<T> => {
    if (ctx?.signal?.aborted) throw cancelled();
    if (ready) {
      // Cached: never touch the network. A damaged cache falls through to a fresh download.
      try {
        return await make(dev, true);
      } catch (e: any) {
        log(`ai: local load of ${repo} failed, re-downloading`, String(e?.message ?? e).slice(0, 300));
      }
    }
    try {
      return await make(dev, false);
    } catch (e: any) {
      if (ctx?.signal?.aborted) throw cancelled();
      if (!ready && /fetch|network|ENOTFOUND|ECONN|ETIMEDOUT|getaddrinfo|ERR_INTERNET|ERR_NAME/i.test(String(e?.message ?? e))) {
        throw new Error(`network: couldn't download ${label}. Check your internet connection and try again.`);
      }
      throw e;
    }
  };
  const cacheKey = `${repo}|${kind}|${task ?? ''}|${JSON.stringify(o.dtype ?? '')}|${device}`;
  const create = async () => {
    try {
      return await load(device);
    } catch (e) {
      if (device !== 'dml' || ctx?.signal?.aborted) throw e;
      log(`ai: DirectML load failed for ${key}, using CPU`, e);
      markDmlFailed(key);
      return load('cpu');
    }
  };
  const dispose = (v: any) => v?.dispose?.();
  const value = o.cache === false ? await create() : await cachedLoad<T>(cacheKey, create, dispose);
  report(1);
  if (device === 'cpu' && (o.device ?? 'auto') === 'auto' && o.warmUp && !states()[key]?.dml) {
    const warm = o.warmUp;
    scheduleWarmUp(key, async () => {
      const m: any = await make('dml', true);
      try {
        await warm(m);
      } finally {
        await m?.dispose?.();
      }
    });
  }
  return { value, device };
}

/**
 * A transformers.js pipeline, downloading the model on first use and loading it from disk after.
 * `model` is a HF repo id (register it with registerModel to get status and size reporting).
 */
export async function loadPipeline(task: string, model: string, opts: LoadOpts = {}, ctx?: AiCtx): Promise<any> {
  return (await tfLoad<any>('pipeline', model, task, opts, ctx)).value;
}

/** A transformers.js AutoModel plus the device it ended up on. Call it with named input tensors. */
export async function loadModel(model: string, opts: LoadOpts = {}, ctx?: AiCtx): Promise<{ model: any; device: Device }> {
  const r = await tfLoad<any>('model', model, null, opts, ctx);
  return { model: r.value, device: r.device };
}

// ------------------------------------------------------------------ raw ONNX sessions

export interface OnnxSession {
  device: Device;
  inputNames: readonly string[];
  outputNames: readonly string[];
  /** Runs inference (serialised per session). */
  run(feeds: Record<string, ORT.Tensor>): Promise<Record<string, ORT.Tensor>>;
}

function sessionOptions(dev: Device): ORT.InferenceSession.SessionOptions {
  return dev === 'dml'
    ? { executionProviders: ['dml'], enableMemPattern: false, executionMode: 'sequential', graphOptimizationLevel: 'all' }
    : { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
}

/**
 * An ONNX Runtime session for one file of a registered raw-file model (downloaded on first use).
 * `warm` builds a representative input for the background DirectML trial (device 'auto').
 */
export async function loadOnnx(id: string, file: string, opts: { device?: DevicePref; warm?: () => Record<string, ORT.Tensor>; span?: [number, number] } = {}, ctx?: AiCtx): Promise<OnnxSession> {
  await ensureFiles(id, ctx, opts.span);
  const path = modelFile(id, file);
  const O = ort();
  const pref = opts.device ?? 'auto';
  let device = deviceFor(id, pref);
  const open = (dev: Device) =>
    cachedLoad(`${id}|${file}|${dev}`, () => O.InferenceSession.create(path, sessionOptions(dev)), (s) => s.release());
  let session: ORT.InferenceSession;
  try {
    session = await open(device);
  } catch (e) {
    if (device !== 'dml') throw e;
    log(`ai: DirectML session failed for ${id}, using CPU`, e);
    markDmlFailed(id);
    device = 'cpu';
    session = await open('cpu');
  }
  if (device === 'cpu' && pref === 'auto' && opts.warm && !states()[id]?.dml) {
    const warm = opts.warm;
    scheduleWarmUp(id, async () => {
      const s = await O.InferenceSession.create(path, sessionOptions('dml'));
      try {
        await s.run(warm());
      } finally {
        await s.release();
      }
    });
  }
  const key = `${id}|${file}|${device}`;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    device,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    run(feeds) {
      const next = chain.then(async () => {
        touch(key);
        return session.run(feeds);
      });
      chain = next.catch(() => {});
      return next;
    },
  };
}

/** Builds an ORT float32 tensor. */
export function floatTensor(data: Float32Array, dims: number[]): ORT.Tensor {
  return new (ort().Tensor)('float32', data, dims);
}
