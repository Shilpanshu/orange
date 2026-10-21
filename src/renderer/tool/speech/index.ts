// Speech tool windows. Transcription runs in the main process (ops/tools-speech.ts).
import type { ToolPage } from '../index';
import { subtitles } from './subtitles';

export const pages: Record<string, ToolPage> = { subtitles };
