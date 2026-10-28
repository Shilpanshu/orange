// Page engines that are not shipped inside the app: the onnxruntime-web and MediaPipe WebAssembly
// binaries. They download once, on first use (src-tauri/src/engines.rs: SHA-256 checked, with a
// progress row and Cancel in the HUD), into the engine store, and the page loads them from there
// through the ofs:// protocol. After that they work offline.
import { Channel, OFS, invoke, uniqueId } from './native';

export type PageEngine = 'ai-runtime' | 'mediapipe' | 'tesseract-eng';

const LABELS: Record<PageEngine, string> = { 'ai-runtime': 'the AI engine', mediapipe: 'face detection', 'tesseract-eng': 'English text recognition' };

const inflight = new Map<PageEngine, Promise<void>>();

/** Folder URL of a downloaded page engine (a tesseract.js langPath). */
export const engineBase = (name: PageEngine) => `${OFS}/engine/${name}`;

/** URL of a file of a downloaded page engine. */
export const engineUrl = (name: PageEngine, file: string) => `${OFS}/engine/${name}/${file}`;

export async function engineInfo(name: PageEngine): Promise<{ ready: boolean; bytes: number }> {
  return invoke('tools_engine_info', { name });
}

/**
 * Makes sure `name` is downloaded. `progress(fraction, note)` gets "Downloading the AI engine (27 MB),
 * first use only…" style updates; aborting `signal` cancels the download (throws "Cancelled").
 */
export function ensureEngine(name: PageEngine, progress?: (fraction: number, note: string) => void, signal?: AbortSignal): Promise<void> {
  let p = inflight.get(name);
  if (p) return p;
  p = (async () => {
    const info = await engineInfo(name);
    if (info.ready) return;
    const mb = Math.max(1, Math.round(info.bytes / 1048576));
    const label = LABELS[name];
    progress?.(0, `Downloading ${label} (${mb} MB), first use only…`);
    const id = uniqueId();
    const ch = new Channel<[number, string]>((m) => progress?.(m[0], `Downloading ${label} (${mb} MB), first use only… ${Math.round(m[0] * 100)}%`));
    const stop = () => void invoke('tools_kill', { id });
    if (signal?.aborted) throw new Error('Cancelled');
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await invoke('tools_engine', { name, id, onData: ch });
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  })();
  inflight.set(name, p);
  const clear = () => {
    if (inflight.get(name) === p) inflight.delete(name);
  };
  p.then(clear, clear);
  return p;
}
