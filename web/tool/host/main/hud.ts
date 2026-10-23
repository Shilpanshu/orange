// Orange 1.x's progress panel API (main/hud.ts) over tools_hud: one row per job, with Cancel.
import { hudNative } from '../native';
import { basename } from 'node:path';

export interface HudJob {
  progress(fraction?: number, note?: string): void;
  done(outputs: string[], errors?: string[], undo?: unknown): Promise<unknown>;
  failed(message: string): Promise<unknown>;
  cancelled(): Promise<unknown>;
}

export const hud = {
  /** Starts a row. `onCancel` runs when the user presses Cancel on it. */
  start(title: string, _count = 1, onCancel?: () => void): HudJob {
    const id = hudNative.start(title);
    let finished = false;
    const poll = setInterval(async () => {
      if (finished) return;
      if (await hudNative.poll(await id).catch(() => false)) {
        clearInterval(poll);
        onCancel?.();
      }
    }, 200);
    const end = () => {
      finished = true;
      clearInterval(poll);
    };
    return {
      progress: (f, note) => void id.then((i) => hudNative.progress(i, f, note)),
      done: (outputs, errors = []) => {
        end();
        return id.then((i) => hudNative.done(i, outputs, errors));
      },
      failed: (m) => {
        end();
        return id.then((i) => hudNative.failed(i, m));
      },
      cancelled: () => {
        end();
        return id.then((i) => hudNative.cancelled(i));
      },
    };
  },
  notice: (msg: string) => void hudNative.notice(msg),
};
export const fileLabel = (p: string) => basename(p);
