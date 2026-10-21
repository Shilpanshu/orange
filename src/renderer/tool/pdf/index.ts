import type { ToolPage } from '../index';
import { mergePdf } from './merge';
import { organizePdf } from './organize';
import { splitPdf } from './split';

export const pages: Record<string, ToolPage> = { mergePdf, organizePdf, splitPdf };
