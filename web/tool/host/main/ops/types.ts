// Contracts every converter, tool and action implements.
import type { Kind } from '../../shared/catalog';

export interface Ctx {
  /** 0..1 overall progress for this file (the job runner aggregates across files). */
  progress(fraction: number, note?: string): void;
  /** Aborted when the user presses Cancel in the progress HUD. Pass to run()/spawn. */
  signal: AbortSignal;
  /**
   * A free output path for `input` with the new extension, honouring the user's output setting
   * (next to the source, or a fixed folder). Never overwrites: adds " 2", " 3"… when taken.
   * suffix is inserted before the extension, e.g. out(p, 'mp4', ' trimmed') → "clip trimmed.mp4".
   */
  out(input: string, ext: string, suffix?: string): string;
  /** Same idea for a folder (multi-file results like "All pages" or "Split"). Creates it. */
  outDir(input: string, name?: string): string;
  /** A fresh private temp directory, removed when the job ends. */
  tmp(): string;
  /** Options gathered by a tool window (undefined for one-shot conversions). */
  options?: any;
}

/** Converts ONE input file to `target` (an extension like "png", or "extract"). Returns created paths. */
export type ConvertFn = (input: string, target: string, ctx: Ctx) => Promise<string[]>;

/** Runs a tool on all inputs at once (tools may combine files). Returns created paths. */
export type ToolFn = (inputs: string[], ctx: Ctx) => Promise<string[]>;

export interface ConverterModule {
  kinds: Kind[];
  convert: ConvertFn;
}

export class UserError extends Error {
  // Messages meant to be shown to the user as-is in the HUD.
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
