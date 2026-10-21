import type { ConverterModule } from './types';

export const converter: ConverterModule = {
  kinds: [],
  async convert() {
    throw new Error('not implemented');
  },
};
