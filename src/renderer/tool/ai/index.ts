// AI tool windows: OCR, Remove BG and Upscale. The models run in the main process (main/ops/tools-ai.ts).
import type { ToolPage } from '../index';
import { ocrPage } from './ocr';
import { removeBackground } from './remove-bg';
import { upscaleImage } from './upscale';

export const pages: Record<string, ToolPage> = {
  ocr: ocrPage,
  removeBg: removeBackground,
  upscale: upscaleImage,
};
