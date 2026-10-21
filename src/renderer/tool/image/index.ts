// Image tool windows. Each page is its own module; shared helpers live in common.ts.
import type { ToolPage } from '../index';
import { editImage } from './edit';
import { annotateImage } from './annotate';
import { frameImage } from './frame';
import { cropImage } from './crop';
import { redactImage } from './redact';
import { createPdf } from './pdf';
import { createCollage } from './collage';

export const pages: Record<string, ToolPage> = {
  editImage,
  annotateImage,
  frameImage,
  cropImage,
  redactImage,
  createPdf,
  createCollage,
};
