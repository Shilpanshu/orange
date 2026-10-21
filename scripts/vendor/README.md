# vendor/bin media tools

`node scripts/vendor/media.mjs` downloads the media CLIs into `vendor/bin/` (skips anything already present
and working; `--force` or `--force=ffmpeg,7z,magick` re-fetches).

| Tool | Source | Size |
| --- | --- | --- |
| `ffmpeg.exe`, `ffprobe.exe` | gyan.dev "release essentials" static build | ~105 MB each |
| `7z.exe`, `7z.dll` | 7-Zip x64 installer from SourceForge, unpacked with `7zr.exe` from 7-zip.org | ~2.5 MB |
| `imagemagick/magick.exe` + config XML | ImageMagick portable Q16 x64 from SourceForge | ~32 MB |

GitHub release downloads are deliberately not used. ImageMagick's Windows build reads HEIC but can't write it,
so HEIC output goes through `src/main/engines/heif.ts` (libx265 via ffmpeg).
