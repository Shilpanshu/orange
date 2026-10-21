import type { ConverterModule } from './types';

export const converter: ConverterModule = {
  kinds: [],
  async convert() {
    throw new Error('not implemented');
  },
};

/** Decode any supported image (HEIC, TIFF, …) to a PNG at `out` so a browser can show it. */
export async function toBrowserImage(_input: string, _out: string): Promise<void> {
  throw new Error('not implemented');
}
