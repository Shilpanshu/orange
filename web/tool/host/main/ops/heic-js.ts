// The pure-JS HEIC decoders 1.x fell back on aren't bundled in Orange 2: the bundled ImageMagick
// reads HEIC, so these only explain what happened if it is missing.
export const heicDecode = async (_o: unknown): Promise<{ data: Uint8Array; width: number; height: number }> => {
  throw new Error("Can't read HEIC images (ImageMagick is missing). Reinstall Orange.");
};
export const heicConvert = async (_o: unknown): Promise<Uint8Array> => {
  throw new Error("Can't read HEIC images (ImageMagick is missing). Reinstall Orange.");
};
