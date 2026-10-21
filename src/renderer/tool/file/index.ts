import type { ToolPage } from '../index';
import { compress } from './compress';
import { metadata } from './metadata';

// extractArchive runs instantly from the wheel (no window); see src/main/ops/tools-file.ts.
export const pages: Record<string, ToolPage> = { compress, metadata };
