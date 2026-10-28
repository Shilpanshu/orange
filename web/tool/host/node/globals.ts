// Node globals for the ported main-process code (injected by scripts/build-web.mjs).
import { Buffer } from 'buffer';
import { process_ } from './misc';
export { Buffer, process_ as process };
export const __filename = 'orange-tool.js';
export const __dirname = '';
export const setImmediate = (f: (...a: any[]) => void, ...a: any[]) => setTimeout(f, 0, ...a);
export const global = globalThis;
