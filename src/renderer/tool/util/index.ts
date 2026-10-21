import type { ToolPage } from '../index';
import { rename } from './rename';
import { protect } from './protect';
import { unlock } from './unlock';

export const pages: Record<string, ToolPage> = { rename, protect, unlock };
