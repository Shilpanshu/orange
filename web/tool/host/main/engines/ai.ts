// Local AI model manager, web edition (runs in the tool window's page). Models download once from
// huggingface.co into the browser Cache API and then load from there with no network access.
// Inference runs on onnxruntime-web: on the GPU through WebGPU when this PC has a usable adapter,
// otherwise on the CPU through WebAssembly.
//
// The API is the same as 1.x (src/main/engines/ai.ts):
//   registerModel(def)                     describe a model (repo, files, size, licence)
//   loadPipeline(task, repo, opts, ctx)    a transformers.js pipeline (downloads on first use)
//   loadModel(repo, opts, ctx)             a transformers.js AutoModel (for custom pre/post-processing)
//   loadOnnx(id, file, opts, ctx)          a raw ONNX Runtime session for a registered raw-file model
//   ensureFiles(id, ctx)                   download a registered model's raw files, return their cache URLs
//   modelStatus(ids?) / deleteModels(ids?) what is cached, and removing it
//   estimateMs / recordTiming              honest time estimates measured on this PC
//
// Device names stay the 1.x ones so the windows need no change: 'dml' now means "the graphics chip"
// (WebGPU) and 'cpu' means WebAssembly.
//
// The engine's JavaScript (transformers.js + onnxruntime-web) is bundled; its 27 MB WebAssembly
// binary is not. It downloads once on first use ("Downloading the AI engine (27 MB), first use
// only…", with a progress row and Cancel in the HUD) into the engine store and is served back to
// this page through ofs://, so every later run is offline (host/engine.ts, src-tauri/src/engines.rs).
import type * as TF from '@huggingface/transformers';
import type * as ORT from 'onnxruntime-web';
import { log } from '../log';
import { ensureEngine, engineInfo, engineUrl } from '../../engine';

/** The subset of a job Ctx the loaders need (tool ctx objects satisfy it). */
export interface AiCtx {
  progress?: (fraction: number, note?: string) => void;
  signal?: AbortSignal;
}

/** 'dml' = the graphics chip (WebGPU), 'cpu' = WebAssembly. */
export type Device = 'dml' | 'cpu';
/** 'auto' = WebGPU when this PC has a usable adapter and it hasn't failed for this model, else CPU. */
export type DevicePref = Device | 'auto';

export interface ModelDef {
  /** Stable key used by modelStatus/deleteModels and timings, e.g. "rmbg". */
  id: string;
  /** Shown to people, e.g. "Background removal". */
  label: string;
  /** Hugging Face repo, e.g. "briaai/RMBG-1.4". Raw-file models may set `urls` instead. */
  repo: string;
  /** Pinned commit for raw-file downloads (transformers models use "main"). */
  revision?: string;
  /** Files (repo-relative) that must be cached for the model to count as downloaded. */
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
  /** Bytes cached now. */
  bytes: number;
  /** Where it will run next time. */
  device: Device;
}

// ------------------------------------------------------------------ runtime modules

/** Cache API bucket for raw-file models (transformers.js uses its own "transformers-cache"). */
const RAW_CACHE = 'orange-models';
const TF_CACHE = 'transformers-cache';

let tf: typeof TF | null = null;
let ortMod: typeof ORT | null = null;
let loading: Promise<void> | null = null;
/** Signal of the download in progress (best-effort: transformers.js has no per-call signal). */
let activeSignal: AbortSignal | undefined;

/** No folder on the web: models live in the Cache API. Kept for API compatibility. */
export function modelsDir(): string {
  return `cache:${RAW_CACHE}`;
}

/** onnxruntime-web's WebGPU build bundles the asyncify glue; only the .wasm comes from outside. */
const wasmUrl = () => engineUrl('ai-runtime', 'ort-wasm-simd-threaded.asyncify.wasm');

/** Loads and configures transformers.js + onnxruntime-web once. */
function loadEngine(): Promise<void> {
  // The binary must be on disk first (ensureAiRuntime downloads it).
  if (!loading) {
    loading = (async () => {
      const [T, O] = await Promise.all([import('@huggingface/transformers'), import('onnxruntime-web/webgpu')]);
      const env = T.env;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.useBrowserCache = true;
      env.useFSCache = false;
      env.useWasmCache = false;
      env.logLevel = (T as any).LogLevel?.ERROR ?? env.logLevel;
      // Downloads stop on Cancel.
      env.fetch = ((input: any, init?: any) => fetch(input, { ...init, signal: init?.signal ?? activeSignal })) as any;
      const wasm = (O as any).env.wasm;
      wasm.wasmPaths = { wasm: wasmUrl() };
      // Threads need cross-origin isolation (SharedArrayBuffer); without it ORT runs single-threaded.
      wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 1;
      wasm.proxy = false;
      tf = T as any;
      ortMod = O as any;
      await gpuProbe;
    })();
    loading.catch((e) => {
      loading = null;
      log('ai: engine failed to load', e);
    });
  }
  return loading;
}

/**
 * transformers.js, configured for Orange. Before the engine has loaded this returns a stand-in that
 * forwards to the module once a loader has run, so `const T = transformers(); await loadModel(…);
 * new T.Tensor(…)` works.
 */
export function transformers(): typeof TF {
  if (tf) return tf;
  return new Proxy({} as typeof TF, {
    get: (_t, key) => {
      if (!tf) throw new Error("The AI engine isn't loaded yet.");
      return (tf as any)[key];
    },
  });
}

/** onnxruntime-web (the same copy transformers.js uses). Call after a loader has run. */
export function ort(): typeof ORT {
  if (!ortMod) throw new Error("The AI engine isn't loaded yet.");
  return ortMod;
}

// ------------------------------------------------------------------ the AI engine (bundled)

let runtimeInfo = { ready: false, mb: 27 };

/** True once the AI engine's WebAssembly binary is downloaded (see refreshAiRuntime). */
export function aiRuntimeReady(): boolean {
  return runtimeInfo.ready;
}

export function aiRuntimeStatus(): { ready: boolean; mb: number } {
  return runtimeInfo;
}

/** Re-reads whether the engine is downloaded. */
export async function refreshAiRuntime(): Promise<void> {
  const i = await engineInfo('ai-runtime');
  runtimeInfo = { ready: i.ready, mb: Math.round(i.bytes / 1048576) };
}

/**
 * Downloads the AI engine's WebAssembly binary on first use (progress goes to `ctx.progress` inside
 * `span`, a HUD row shows it too; Cancel stops it), then loads the engine.
 */
export async function ensureAiRuntime(ctx?: AiCtx, span: [number, number] = [0, 0.3]): Promise<void> {
  if (ctx?.signal?.aborted) throw cancelled();
  await ensureEngine('ai-runtime', (f, note) => ctx?.progress?.(span[0] + (span[1] - span[0]) * f, note), ctx?.signal).catch((e) => {
    if (ctx?.signal?.aborted || String(e?.message ?? e) === 'Cancelled') throw cancelled();
    throw e;
  });
  runtimeInfo = { ...runtimeInfo, ready: true };
  await loadEngine();
}

/** Waits for the WebGPU probe so `device` choices are right, without downloading anything. */
export async function settleGpu(): Promise<void> {
  await gpuProbe;
}

// ------------------------------------------------------------------ GPU

let gpuOk = false;
const gpuProbe: Promise<void> = (async () => {
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu) return;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    gpuOk = !!adapter;
  } catch {
    gpuOk = false;
  }
})();

// ------------------------------------------------------------------ localStorage helpers

function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* estimates only */
  }
}

// ------------------------------------------------------------------ registry + status

const registry = new Map<string, ModelDef>();
const READY_KEY = 'orange.ai.ready';
/** id → cached bytes, for models known to be fully cached. Verified against the Cache API in the background. */
let readyMap: Record<string, number> = lsGet(READY_KEY, {});

export function registerModel(def: ModelDef): ModelDef {
  registry.set(def.id, def);
  scheduleRefresh();
  return def;
}

export function modelDef(id: string): ModelDef {
  const d = registry.get(id);
  if (!d) throw new Error(`Unknown AI model "${id}"`);
  return d;
}

/** Where a model file is fetched from, which is also its Cache API key. */
export function modelFile(id: string, file: string): string {
  const d = modelDef(id);
  return d.urls?.[file] ?? `https://huggingface.co/${d.repo}/resolve/${d.revision ?? 'main'}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export function isReady(id: string): boolean {
  return readyMap[id] !== undefined;
}

function markReady(id: string, bytes: number) {
  readyMap = { ...readyMap, [id]: Math.max(0, Math.round(bytes)) };
  lsSet(READY_KEY, readyMap);
}

function markMissing(id: string) {
  if (readyMap[id] === undefined) return;
  const { [id]: _, ...rest } = readyMap;
  readyMap = rest;
  lsSet(READY_KEY, readyMap);
}

async function cachedSize(url: string): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  const r = await caches.match(url);
  if (!r) return 0;
  const len = Number(r.headers.get('content-length') ?? 0);
  return len > 0 ? len : 1;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing: Promise<void> | null = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshModelStatus();
  }, 0);
}

/** Re-checks every registered model against the Cache API (the user can clear site data). */
export function refreshModelStatus(): Promise<void> {
  if (!refreshing) {
    refreshing = (async () => {
      for (const d of registry.values()) {
        try {
          let bytes = 0;
          let all = true;
          for (const f of d.files) {
            const s = await cachedSize(modelFile(d.id, f));
            if (!s) {
              all = false;
              break;
            }
            bytes += s;
          }
          if (all) markReady(d.id, Math.max(bytes, readyMap[d.id] ?? 0));
          else markMissing(d.id);
        } catch {
          /* keep what we had */
        }
      }
    })().finally(() => (refreshing = null));
  }
  return refreshing;
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
    bytes: readyMap[d.id] ?? 0,
    device: deviceFor(d.id, 'auto'),
  }));
}

/** Deletes cached models (all registered ones when `ids` is omitted). They download again on next use. */
export async function deleteModels(ids?: string[]): Promise<void> {
  const list = ids ? ids.map(modelDef) : [...registry.values()];
  for (const d of list) {
    for (const key of [...sessions.keys()]) if (key.startsWith(`${d.id}|`) || key.startsWith(`${d.repo}|`)) await dropSession(key);
    markMissing(d.id);
    if (typeof caches === 'undefined') continue;
    const prefix = `https://huggingface.co/${d.repo}/`;
    const urls = new Set(d.files.map((f) => modelFile(d.id, f)));
    for (const name of [RAW_CACHE, TF_CACHE]) {
      try {
        const c = await caches.open(name);
        for (const req of await c.keys()) if (urls.has(req.url) || req.url.startsWith(prefix)) await c.delete(req);
      } catch {
        /* nothing cached */
      }
    }
  }
}

// ------------------------------------------------------------------ devices + timings

interface DeviceState {
  dml?: 'ok' | 'failed';
  ms?: { cpu?: number; dml?: number };
}
const STATE_KEY = 'orange.ai.devices';
let stateCache: Record<string, DeviceState> | null = null;

function states(): Record<string, DeviceState> {
  if (!stateCache) stateCache = lsGet<Record<string, DeviceState>>(STATE_KEY, {});
  return stateCache;
}

function patchState(key: string, patch: (s: DeviceState) => void) {
  const all = states();
  const s = (all[key] ??= {});
  patch(s);
  lsSet(STATE_KEY, all);
}

/** Resolves 'auto' to the device a model should use now ('dml' = WebGPU). */
export function deviceFor(key: string, pref: DevicePref = 'auto'): Device {
  if (pref === 'cpu') return 'cpu';
  if (!gpuOk) return 'cpu';
  if (pref === 'dml') return 'dml';
  return states()[key]?.dml === 'failed' ? 'cpu' : 'dml';
}

const tfDevice = (d: Device) => (d === 'dml' ? 'webgpu' : 'wasm');

/** Records how long one unit of work took, so later estimates match this PC. */
export function recordTiming(key: string, device: Device, ms: number) {
  noteActivity();
  if (!Number.isFinite(ms) || ms <= 0) return;
  patchState(key, (s) => {
    s.ms ??= {};
    const prev = s.ms[device];
    s.ms[device] = prev ? Math.round(prev * 0.6 + ms * 0.4) : Math.round(ms);
    if (device === 'dml') s.dml = 'ok';
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

let lastActivity = 0;
const noteActivity = () => (lastActivity = Date.now());
void lastActivity;

/**
 * 1.x ran a background DirectML trial before using the GPU. WebGPU is used straight away (with a CPU
 * fallback on failure), so this is a no-op kept for API compatibility.
 */
export function scheduleWarmUp(_key: string, _fn: () => Promise<void>) {}

/** Marks the GPU as unusable for a model after a runtime failure (falls back to CPU next time). */
export function markDmlFailed(key: string) {
  patchState(key, (s) => (s.dml = 'failed'));
}

// ------------------------------------------------------------------ session cache

interface Cached {
  value: Promise<any>;
  dispose: (v: any) => Promise<void> | void;
  timer?: ReturnType<typeof setTimeout>;
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
    c = { value, dispose };
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

const NET_ERR = /fetch|network|ENOTFOUND|ECONN|ETIMEDOUT|getaddrinfo|ERR_INTERNET|ERR_NAME|Load failed/i;

type DownloadOpts = { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void; sha256?: string };

/** Downloads in progress, by cache key: two jobs fetching the same file share one download. */
const inflight = new Map<string, Promise<void>>();

/** Waits for `p`, but gives up (Cancelled) when `signal` aborts first. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Fetches `url` into the Cache API under `key` (default: the URL itself). Honours `signal`. */
export async function downloadFile(url: string, key: string = url, opts: DownloadOpts = {}) {
  const running = inflight.get(key);
  if (running) {
    await untilAborted(running.catch(() => {}), opts.signal);
    if (await cachedSize(key)) return;
  }
  const job = fetchTo(url, key, opts);
  inflight.set(key, job);
  try {
    await job;
  } finally {
    if (inflight.get(key) === job) inflight.delete(key);
  }
}

async function fetchTo(url: string, key: string, opts: DownloadOpts) {
  if (opts.signal?.aborted) throw cancelled();
  let res: Response;
  try {
    res = await fetch(url, { signal: opts.signal, cache: 'no-store' });
  } catch (e: any) {
    if (opts.signal?.aborted) throw cancelled();
    throw new Error(`network: couldn't reach ${new URL(url).host} (${e?.message ?? e})`);
  }
  if (!res.ok || !res.body) throw new Error(`network: download failed with HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      opts.onProgress?.(loaded, total);
    }
  } catch (e) {
    if (opts.signal?.aborted) throw cancelled();
    throw new Error(`network: the download from ${new URL(url).host} was cut short (${(e as Error)?.message ?? e})`);
  }
  const blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
  if (opts.sha256) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== opts.sha256.toLowerCase()) throw new Error(`The downloaded file was damaged (checksum mismatch). Try again.`);
  }
  const cache = await caches.open(RAW_CACHE);
  await cache.put(key, new Response(blob, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(blob.size) } }));
}

/** The bytes of a cached file (a URL returned by ensureFiles / modelFile). */
export async function cachedBytes(url: string): Promise<Uint8Array> {
  const r = await caches.match(url);
  if (!r) throw new Error(`${url.split('/').pop()} isn't downloaded.`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Downloads a registered raw-file model if needed. Returns the cache URLs of its files. */
export async function ensureFiles(id: string, ctx?: AiCtx, span: [number, number] = [0, 0.3]): Promise<string[]> {
  const d = modelDef(id);
  const urls = d.files.map((f) => modelFile(id, f));
  const sizes = await Promise.all(urls.map(cachedSize));
  const missing = d.files.filter((_f, i) => sizes[i] <= 0);
  if (!missing.length) {
    if (!isReady(id)) markReady(id, sizes.reduce((a, b) => a + b, 0));
    return urls;
  }
  markMissing(id);
  const report = reporter(ctx, span, d.label, d.mb);
  report(0);
  const totalBytes = d.mb * 1e6;
  let doneBytes = 0;
  for (const f of missing) {
    const url = modelFile(id, f);
    let fileLoaded = 0;
    await downloadFile(url, url, {
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
  const bytes = (await Promise.all(urls.map(cachedSize))).reduce((a, b) => a + b, 0);
  markReady(id, bytes);
  log(`ai: downloaded ${id} (${(doneBytes / 1e6).toFixed(1)} MB)`);
  return urls;
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
  /** 1.x: DirectML trial input. Unused on the web (WebGPU is used directly); kept for compatibility. */
  warmUp?: (model: any) => Promise<void>;
  /** Keep the loaded model cached for reuse (default true). */
  cache?: boolean;
}

function labelFor(repo: string, o: LoadOpts) {
  const def = o.id ? registry.get(o.id) : [...registry.values()].find((d) => d.repo === repo);
  return { key: def?.id ?? o.id ?? repo, label: o.label ?? def?.label ?? repo.split('/').pop()!, mb: o.mb ?? def?.mb ?? 0, def };
}

async function tfLoad<T>(kind: 'pipeline' | 'model', repo: string, task: string | null, o: LoadOpts, ctx?: AiCtx): Promise<{ value: T; device: Device }> {
  await ensureAiRuntime(ctx);
  const { key, label, mb, def } = labelFor(repo, o);
  const ready = def ? isReady(def.id) : false;
  const span = o.span ?? [0, 0.3];
  const T = tf!;
  const device = deviceFor(key, o.device ?? 'auto');
  const report = reporter(ctx, span, label, mb);
  const files = new Map<string, [number, number]>();
  const progress_callback = (p: any) => {
    if (p?.status !== 'progress' || !p.file) return;
    files.set(p.file, [p.loaded ?? 0, p.total ?? 0]);
    let l = 0;
    let t = 0;
    for (const [a, b] of files.values()) (l += a), (t += b);
    report(l / Math.max(t, mb * 1e6, 1));
  };
  const make = async (dev: Device, localOnly: boolean): Promise<T> => {
    const opts: any = { dtype: o.dtype, device: tfDevice(dev), local_files_only: localOnly, progress_callback, ...o.extra };
    const prev = activeSignal;
    activeSignal = ctx?.signal;
    try {
      const p = (kind === 'pipeline' ? T.pipeline(task as any, repo, opts) : T.AutoModel.from_pretrained(repo, opts)) as Promise<T>;
      return await untilAborted(p, ctx?.signal);
    } finally {
      activeSignal = prev;
    }
  };
  const load = async (dev: Device): Promise<T> => {
    if (ctx?.signal?.aborted) throw cancelled();
    // Cached files come from the browser cache (transformers.js checks it before the network), so a
    // ready model loads without a download and a damaged cache just downloads again.
    try {
      const v = await make(dev, false);
      let bytes = 0;
      for (const [a] of files.values()) bytes += a;
      if (def) markReady(def.id, bytes || def.mb * 1e6);
      return v;
    } catch (e: any) {
      if (ctx?.signal?.aborted) throw cancelled();
      if (!ready && NET_ERR.test(String(e?.message ?? e))) {
        throw new Error(`network: couldn't download ${label}. Check your internet connection and try again.`);
      }
      throw e;
    }
  };
  const create = async () => {
    try {
      return await load(device);
    } catch (e) {
      if (device !== 'dml' || ctx?.signal?.aborted) throw e;
      log(`ai: WebGPU load failed for ${key}, using CPU`, e);
      markDmlFailed(key);
      return load('cpu');
    }
  };
  const cacheKey = `${repo}|${kind}|${task ?? ''}|${JSON.stringify(o.dtype ?? '')}|${device}`;
  const dispose = (v: any) => v?.dispose?.();
  const value = o.cache === false ? await create() : await cachedLoad<T>(cacheKey, create, dispose);
  report(1);
  // The load may have fallen back to the CPU.
  const used: Device = device === 'dml' && states()[key]?.dml === 'failed' ? 'cpu' : device;
  return { value, device: used };
}

/**
 * A transformers.js pipeline, downloading the model on first use and loading it from the cache after.
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
  return dev === 'dml' ? { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' } : { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
}

/** An ONNX Runtime session for one file of a registered raw-file model (downloaded on first use). */
export async function loadOnnx(id: string, file: string, opts: { device?: DevicePref; warm?: () => Record<string, ORT.Tensor>; span?: [number, number] } = {}, ctx?: AiCtx): Promise<OnnxSession> {
  await ensureAiRuntime(ctx);
  await ensureFiles(id, ctx, opts.span ?? [0, 0.3]);
  const url = modelFile(id, file);
  const O = ort();
  const pref = opts.device ?? 'auto';
  let device = deviceFor(id, pref);
  const open = (dev: Device) =>
    cachedLoad(
      `${id}|${file}|${dev}`,
      async () => O.InferenceSession.create(await cachedBytes(url), sessionOptions(dev)),
      (s) => s.release(),
    );
  let session: ORT.InferenceSession;
  try {
    session = await open(device);
  } catch (e) {
    if (device !== 'dml') throw e;
    log(`ai: WebGPU session failed for ${id}, using CPU`, e);
    markDmlFailed(id);
    device = 'cpu';
    session = await open('cpu');
  }
  log(`ai: ${id} session on ${device === 'dml' ? 'WebGPU' : 'WASM'}`);
  const key = `${id}|${file}|${device}`;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    device,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    run(feeds) {
      const next = chain.then(async () => {
        touch(key);
        return session.run(feeds) as Promise<Record<string, ORT.Tensor>>;
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
