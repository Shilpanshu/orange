<p align="center">
  <img src="assets/icon.png" width="96" alt="Orange logo" />
</p>

<h1 align="center">Orange</h1>

<p align="center">
  Drag a file, tap a key, drop it on a wheel. A zero-click, offline file converter for Windows.
</p>

---

Orange sits in the notification area and stays out of the way until you need it. Start dragging any file in Explorer or on the desktop, tap **Shift**, and a wheel of formats opens under the pointer. Drop the file on **PNG**, **MP4** or **PDF** and the converted copy appears next to the original. There is no window to open and no menu to dig through.

It's a Windows take on the drag-and-tap idea of the Mac app Tangerine, built from scratch.

## Install

1. Download `Orange-Setup-<version>.exe` from the [latest release](https://github.com/Shilpanshu/orange/releases/latest).
2. Run it. It installs for your user account only, with no administrator prompt.
3. Orange starts and a short guide opens once.

> If Windows SmartScreen says "Windows protected your PC", choose **More info → Run anyway**. That warning appears for installers without a code-signing certificate; see [Code signing](#code-signing).

Orange updates itself from GitHub Releases. New versions download in the background and install the next time you quit.

Requires Windows 10 or 11, 64-bit. The installer is about 250 MB and Orange takes about 740 MB on disk. AI models download separately, the first time you use each AI tool.

## What's new in 1.2.1

A reliability release: a full review of the app fixed 75 bugs, and the automated test suite grew to 171 cases. Highlights:

- **No more surprise wheels.** Ctrl+drag (copy), Shift+drag (move) and right-button drags in Explorer no longer open the wheel.
- **Nothing overwritten.** Two files with the same name in one batch (for example `IMG_1.HEIC` and `IMG_1.JPG` to WebP) now get separate outputs.
- **Fast PDF thumbnails.** Merge, Split and Organize show the first pages in about a second, even for 600-page or 200 MB files, using a fraction of the memory.
- **Tricky files work:** surround-sound films to Opus/WebM, 10-bit video to MP4, very large photos to HEIC, `%` or `'` in file and folder names, and paths longer than 260 characters.
- **Cancel cleans up.** Cancelling a video, PDF or archive job no longer leaves half-written files.
- **Clearer messages** instead of raw tool output, and a readable wheel even with 20+ tools and presets.
- **Safer:** a dropped file can no longer replace an Orange window, settings are saved atomically, and Undo for Rename and Move always targets the right files.

## What's new in 1.2

- **New tools:** OCR, Remove background, Upscale, Subtitles from speech, bulk Rename, Protect and Unlock.
- **New ways in:** Explorer's right-click menu, clipboard conversion (Ctrl + Alt + V) and watch folders.
- **A wheel that learns:** pinned slices, the last-used slice one drop away, presets as slices, and a preview of what you're dragging.
- **Undo** on every finished job, and plain-language error messages.
- **Faster video:** encoding uses the graphics card (NVIDIA, Intel or AMD) when it can, and falls back to the processor automatically.
- **Smaller:** about 740 MB installed, down from 1.1 GB, with the new AI tools included.
- **Polish:** every window passes WCAG AA contrast in light and dark, works at small sizes, and handles long or non-Latin file names.

## How to use

| Do this while dragging a file | You get |
| --- | --- |
| Tap **Shift** | **Convert**: every format the file can become |
| Tap **Ctrl** | **Tools**: compress, crop, trim, merge, redact and more |
| Tap **Alt** | **Actions**: share, float, copy, move, copy path, terminal |

Release the key and keep holding the file; the wheel stays open until you drop or press **Esc**. Tap another key to switch wheels, or use the arrow keys to pick a slice.

You can also select files in Explorer and press **Ctrl + Shift + Space** to open the wheel and click a slice, or right-click files and choose **Orange → Convert / Tools / Actions**. On Windows 11 that menu is under **Show more options**.

The keys can be changed in **Settings → Shortcuts** (click the tray icon).

### Make the wheel yours

- **Pin slices.** Open the wheel with Ctrl + Shift + Space and right-click a slice to pin it. Pinned slices come first, marked with a star, for that kind of file.
- **Repeat the last choice.** The slice you used last for a file type has a small dot and is pre-selected: drop on the centre of the wheel to use it again.
- **See what you're dragging.** Once Orange knows the exact files, the centre of the wheel shows a thumbnail and the file name.
- **Presets.** Tool windows such as Compress, Crop, Speed and Normalize have **Save as preset…**. A preset becomes its own slice on the Tools wheel, so your usual settings are one drop away.
- **Undo.** Every finished job in the corner panel has **Undo**. New files go to the Recycle Bin; a Move goes back where it came from; a Rename restores the old names.

### Convert the clipboard

Copy an image, some text or files, then press **Ctrl + Alt + V** (or choose **Convert clipboard…** in the tray menu) and pick a format. Images become PNG, JPG, WebP or PDF; text becomes TXT, Markdown, PDF or Word.

### Watch folders

**Settings → Automation** can watch a folder and convert new files automatically, for example every new HEIC photo to JPG, or every download to MP3. Orange waits until a file has finished downloading or copying, never processes its own results, and can move the original to the Recycle Bin once the result is safely written.

## What it converts

| Kind | Converts to |
| --- | --- |
| Images (JPG, PNG, WebP, HEIC, TIFF, AVIF, BMP, GIF, SVG, ICO, JXL) | JPG, PNG, WebP, HEIC, TIFF, AVIF, BMP, PDF |
| Video (MP4, MOV, MKV, WebM, AVI, WMV, TS and more) | MP4, MOV, MKV, WebM, AVI, WMV, GIF, MP3 |
| Audio (MP3, M4A, WAV, FLAC, OGG, Opus, AIFF, WMA) | MP3, M4A, WAV, FLAC, OGG, Opus, AIFF, WMA |
| PDF | DOCX, PPTX, XLSX, JPG, PNG, EPUB, TXT, Markdown |
| Documents (DOCX, DOC, ODT, Pages, RTF, Markdown, TXT, HTML) | DOCX, PDF, Markdown, TXT, EPUB, HTML, ODT, RTF |
| Slides (PPTX, PPT, ODP, Keynote) | PDF, JPG, PNG, PPTX |
| Spreadsheets (XLSX, XLS, ODS, CSV, TSV, Numbers) | XLSX, ODS, CSV, TSV, PDF |
| E-books (EPUB) | PDF, DOCX, Markdown, TXT, HTML |
| Subtitles (SRT, VTT) | SRT, VTT, TXT |
| Archives (ZIP, TAR, GZ, 7Z, RAR) | Extract, ZIP, TAR, GZIP, 7Z |
| Folders and mixed selections | ZIP |

Video that already uses a compatible codec is repackaged without re-encoding, so MOV to MP4 usually takes about a second. When a video does need re-encoding, Orange uses the graphics card's encoder (NVIDIA NVENC, Intel Quick Sync or AMD AMF) if there is one, typically 2–3× faster than the processor at the same visual quality. Turn it off in **Settings → General** if you prefer the smallest possible files.

Word, PowerPoint and Excel files use Microsoft Office when it's installed. Without Office, Orange can install LibreOffice for you from **Settings → Engines**. Apple Pages, Keynote and Numbers files need LibreOffice.

## Tools

- **Any file:** Compress (target size, percentage or quality; never overwrites the original), Edit metadata, Rename in bulk (replace, numbering, case, date taken, with a live preview and undo), Protect with a password (AES-256 PDF, or an encrypted ZIP or 7z)
- **Images:** Edit photo (light, colour, detail with a live preview), Annotate, Add a background, Crop, Redact (finds faces and text automatically, on your PC), Make a PDF, Collage, Remove background, Upscale 2× or 4× (Photo or Illustration), OCR
- **Video:** Trim, Crop, Change speed, Join, Save frames, Split, Redact, Subtitles from speech
- **Audio:** Normalize loudness, Audio visualizer video, Trim, Mono/stereo and channel volume, Bleep, Join, Subtitles from speech
- **PDF:** Merge, Organize pages (reorder, rotate, duplicate, delete), Split, OCR (makes scans searchable), Protect, Unlock
- **Archives:** Extract, Unlock

### AI tools run on your PC

OCR, Remove background, Upscale and Subtitles use AI models that run locally, on the graphics card when it helps. Each model downloads once, the first time you use the tool, and after that everything works offline.

| Tool | Model | Download |
| --- | --- | --- |
| OCR | Tesseract (English included; 18 more languages, 1–3 MB each) | none for English |
| Upscale | Real-ESRGAN (Photo) or a lightweight anime Real-ESRGAN (Illustration) | about 5 MB each |
| Remove background | BRIA RMBG-1.4 | 176 MB |
| Subtitles | Whisper: Fast, Balanced or Best | 79 MB, 252 MB or 1.09 GB |

Subtitles can be saved as SRT, VTT or plain text, burned into a copy of the video, or added as a subtitle track you can switch on and off. You can review and edit every line before saving. RMBG-1.4 is licensed for non-commercial use only.

## Actions

**Share** opens the Windows share sheet, including Nearby Share. **Float** parks files on a shelf at the screen edge so you can drag them into another app later. **Copy** puts the files on the clipboard for pasting in Explorer. **Move** sends them to another folder. **Copy Path** copies full paths as text. **Terminal** opens the folder in Windows Terminal or PowerShell.

## Privacy

Everything runs on your PC. Orange never uploads your files, collects no analytics and has no account. It only goes online to check GitHub for updates, to download an AI model or OCR language the first time you use it, and, if you ask, to download LibreOffice.

## Something went wrong?

Right-click the tray icon and choose **Report a problem…**. Orange saves a zip of its logs, crash files, settings and basic system details (none of your files) to your Desktop and opens a pre-filled [GitHub issue](https://github.com/Shilpanshu/orange/issues/new) for you to attach it to.

---

## Building from source

You need Windows 10 or 11 (x64), Node.js 22 or newer, and Git.

```powershell
git clone https://github.com/Shilpanshu/orange.git
cd orange
npm install
npm run vendor     # downloads FFmpeg, 7-Zip, ImageMagick, Pandoc and Ghostscript into vendor/bin
npm start          # builds and runs Orange
```

The bundled tools are not in Git because of their size (about 450 MB). `npm run vendor` is safe to run again; it skips anything already present.

> If you run Orange from inside VS Code's terminal and it immediately exits, the `ELECTRON_RUN_AS_NODE` variable is set. Remove it first: `Remove-Item Env:ELECTRON_RUN_AS_NODE`.

### Make the installer

```powershell
npm run dist       # writes release/Orange-Setup-<version>.exe
```

### Publish a release

Bump `version` in `package.json`, then:

```powershell
$env:GH_TOKEN = '<a GitHub token with repo scope>'
npm run release
```

This uploads the installer and `latest.yml` to a GitHub release. Installed copies pick up the update automatically within a few hours.

### Code signing

`npm run dist` and `npm run release` sign automatically when credentials are present in the environment:

- **Azure Trusted Signing** (cheapest for individuals): set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE` and `AZURE_SIGN_PUBLISHER` (the certificate subject name).
- **A .pfx certificate:** set `CSC_LINK` (file path or base64) and `CSC_KEY_PASSWORD`.

With neither set, the build is unsigned and SmartScreen warns on first install.

### Project layout

```
src/main/            Electron main process
  drag-watcher.ts    global mouse/keyboard hooks: "dragging + tapped a key"
  wheel.ts           the transparent radial menu window
  jobs.ts            routes a choice to a converter, tool or action; progress and cancel
  ops/               converters (convert-*.ts) and tools (tools-*.ts)
  engines/           wrappers for FFmpeg, Office/LibreOffice, Pandoc, HEIF
  updater.ts         auto-update from GitHub Releases
  diagnostics.ts     crash capture and "Report a problem"
src/renderer/        wheel, progress panel, settings, shelf and tool windows (no framework)
src/shared/catalog.ts  which formats, tools and actions apply to which files
src/helper/          small C# helper: Explorer selection, file clipboard, share sheet
scripts/             build, vendor download, installer and test scripts
```

## Third-party software

Orange ships these programs unmodified, each under its own licence. Their licence files are installed alongside them in `resources/bin`.

| Component | Used for | Licence |
| --- | --- | --- |
| [FFmpeg](https://ffmpeg.org) (gyan.dev essentials build) | Video and audio | GPL v3 |
| [ImageMagick](https://imagemagick.org) | HEIC, BMP and other image formats | ImageMagick License |
| [libvips](https://www.libvips.org) via [sharp](https://sharp.pixelplumbing.com) | Fast image processing | LGPL v2.1 / Apache 2.0 |
| [7-Zip](https://www.7-zip.org) | Archives | LGPL v2.1 + unRAR restriction |
| [Pandoc](https://pandoc.org) | Document conversion | GPL v2+ |
| [Ghostscript](https://www.ghostscript.com) | PDF rendering and compression | AGPL v3 |
| [pdf-lib](https://pdf-lib.js.org), [PDF.js](https://mozilla.github.io/pdf.js/) | PDF tools | MIT, Apache 2.0 |
| [Tesseract.js](https://tesseract.projectnaptha.com), [MediaPipe](https://ai.google.dev/edge/mediapipe) | Offline text and face detection, OCR | Apache 2.0 |
| [Transformers.js](https://huggingface.co/docs/transformers.js), [ONNX Runtime](https://onnxruntime.ai) | Running AI models locally (CPU or DirectML) | Apache 2.0, MIT |
| [Whisper](https://github.com/openai/whisper) models | Subtitles (downloaded on first use) | MIT |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) models | Upscale (downloaded on first use) | BSD 3-Clause, MIT |
| [BRIA RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) | Remove background (downloaded on first use) | BRIA RMBG-1.4 licence (non-commercial) |

## Licence

Orange's own source code is released under the [MIT License](LICENSE).
