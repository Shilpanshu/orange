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

1. Download `Orange_<version>_x64-setup.exe` from the [latest release](https://github.com/Shilpanshu/orange/releases/latest).
2. Run it. It installs for your user account only, with no administrator prompt, in a few seconds.
3. Orange starts in the notification area. Open **Settings → How it works** (tray icon) for a short guide.

> If Windows SmartScreen says "Windows protected your PC", choose **More info → Run anyway**. The installer is not Authenticode-signed yet, which is what triggers that warning. Updates are separately signed, so Orange only ever installs genuine ones.

Orange updates itself from GitHub Releases (through a copy on GitHub Pages, shilpanshu.github.io, which it tries first). New versions download in the background and install the next time you quit.

**Upgrading from Orange 1.x:** just install 2.0. It removes 1.x (including its right-click menu and start-with-Windows entry) and carries over your settings.

Requires Windows 10 or 11, 64-bit, with the Microsoft Edge WebView2 runtime. That is already part of current Windows; the installer fetches it if it is missing.

The installer is about 6 MB and Orange takes about 10 MB on disk. It uses roughly 120 MB of memory while it sits in the tray, most of it the WebView2 browser engine.

### Downloaded the first time you need it

To stay small, Orange does not ship the heavy engines. Each one downloads the first time a feature needs it, with a progress row and a Cancel button in the corner panel, is checked against a known fingerprint, and then works offline.

| What | Size | Needed for |
| --- | --- | --- |
| FFmpeg | 35 MB | Video and audio |
| Pandoc | 41 MB | Documents, EPUB, Markdown |
| Ghostscript | 20 MB | PDF to images and text, and PDF compress |
| ImageMagick | 12 MB | HEIC, AVIF, TIFF and WebP output |
| 7-Zip | 2 MB | Archives, including RAR |
| AI engine | 27 MB | Remove background, Upscale, Subtitles (the model downloads too, see [AI tools](#ai-tools-run-on-your-pc)) |
| Face detection | 14 MB | Redact: Find faces |
| English text data | 3 MB | OCR and Redact: Find text |

Some things need nothing at all: reading PNG, JPEG, GIF, BMP, ICO and TIFF; writing JPG, PNG, BMP and PDF; subtitles; CSV, XLSX and ODS; and turning web pages into PDF (it uses the Edge that comes with Windows).

## 2.0.0-beta.10

Fixes switching wheels during a drag (tapping Ctrl, Alt or Shift again): after a switch the wheel stopped reacting. Orange's drop window now follows the wheel each time it opens, and if a drag ever slips past it, Orange's own mouse tracking finishes the drop.

## 2.0.0-beta.9

The invisible drop window from beta.8 now always stays above the wheel; in beta.8 the wheel could cover it, so the "no entry" cursor remained.

## 2.0.0-beta.8

Removes the "no entry" cursor over the wheel. During a drag Orange now lays its own invisible window over the wheel to receive the drop, instead of relying on the browser engine inside the wheel, which refused drags on some PCs. The beta.7 mouse fallback stays as a safety net.

## 2.0.0-beta.7

Fixes the wheel ignoring drops on PCs where Windows never passes the drag to it (the slices looked disabled). Orange now follows the pointer itself: slices light up as you move, and letting go over a slice acts on the files you were dragging from Explorer.

## 2.0.0-beta.6

Fixes dropping on the wheel doing nothing (for example Copy path copying nothing). On some PCs the drop goes to the wheel's web page, which is told the file names but not where the files are. The wheel now takes the paths from the files selected in Explorer, and only when their names are exactly the dropped ones.

## 2.0.0-beta.5

Fixes the wheel not reacting to a drop: on some PCs WebView2 took over the wheel's drop handling, so Orange never learned which files were dragged and the wheel just stayed open. Orange now registers its own drop handler each time the wheel opens.

## 2.0.0-beta.4

Updates now arrive on networks that block GitHub's file server (release-assets.githubusercontent.com). Each release is also published on GitHub Pages, which Orange tries first, and a failed update check is retried after 20 minutes instead of 6 hours.

## 2.0.0-beta.3

Fixes a wheel that could stay on screen with nothing to drop on it, so you could not click anything. It happened when Orange missed a mouse button going up, and the next Alt, Shift or Ctrl tap then opened the wheel. Orange now checks with Windows that the button is really held, and closes a wheel that has no button held after a moment.

## 2.0.0-beta.2

No new features. This build exists to prove that Orange updates itself from one 2.0 release to the next.

## What's new in 2.0

Orange is rebuilt on [Tauri](https://tauri.app) instead of Electron. The tools, the wheel and the settings are the same; what changed is how heavy it is.

| | 1.2.2 | 2.0 |
| --- | --- | --- |
| Installer | 210 MB | **6 MB** |
| On disk | 490 MB | **10 MB** |
| Memory in the tray | about 190 MB | **about 120 MB** |

- **The wheel knows exactly what you are dragging.** Windows reports the dragged files to the wheel itself, so the slices, the file name and the thumbnail always match the file. A guess from Explorer is only used until then, and never overrides it.
- **Engines download on first use** instead of shipping in the installer (table above). The first video, document or AI job needs an internet connection once.
- **Smaller differences from 1.x:** a PDF made from a web page or document has no "page n of N" footer; an image converted to PDF is sized at 72 dpi; converting to WebP, TIFF or AVIF downloads ImageMagick the first time.

## What's new in 1.2.2

Faster, smoother and lighter, with nothing removed:

- **Starts in under 0.2 s** (was about 0.5 s) and uses about 40% less memory sitting in the tray. Converters load only when a job needs them, and the corner panel frees its memory after a minute.
- **About a third smaller:** 490 MB installed (was 745 MB). The video engine ships compressed and unpacks on first use; the AI engine downloads only if you use an AI tool.
- **Smoother wheel:** the Tools wheel opens with no dropped frame, and moving across slices repaints far less.
- **Faster tool windows:** each window loads only its own code (about 60 KB instead of 690 KB).
- **Smooth PDF grids** at 60 fps in Organize and Split.
- **Fixed:** OCR failed in the installed 1.2.1 with "Cannot find module tesseract-core-relaxedsimd".
- **A complete How it works page** in Settings, covering every way to use Orange.

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

Everything runs on your PC. Orange never uploads your files, collects no analytics and has no account. It only goes online to:

- check GitHub (github.com and shilpanshu.github.io) for updates;
- download an engine, an AI model or an OCR language the first time you use it (from gyan.dev, SourceForge, PyPI, conda-forge, jsDelivr or Hugging Face, depending on what it is);
- download LibreOffice, if you ask for it in **Settings → Engines**.

## Something went wrong?

Right-click the tray icon and choose **Report a problem…**. Orange saves a zip of its logs, crash files, settings and basic system details (none of your files) to your Desktop and opens a pre-filled [GitHub issue](https://github.com/Shilpanshu/orange/issues/new) for you to attach it to.

---

## Building from source

You need Windows 10 or 11 (x64) and:

- [Rust](https://rustup.rs) (stable) and the Visual Studio C++ Build Tools,
- Node.js 22 or newer (it bundles the web pages with esbuild),
- Git.

```powershell
git clone https://github.com/Shilpanshu/orange.git
cd orange
npm ci
npm run build:web          # bundles the pages into web-dist/ (the app embeds them at build time)
cargo install tauri-cli --version "^2" --locked
cd src-tauri
cargo tauri dev            # builds and runs Orange
```

Nothing heavy is bundled, so there is nothing else to download: engines fetch themselves the first time you use a feature, into `%LOCALAPPDATA%\app.orange.converter\engines`. After changing anything under `web/`, `src/renderer/` or `src/shared/`, run `npm run build:web` again. `npm run typecheck` checks the TypeScript.

> `cargo tauri dev` uses the same identifier as an installed Orange. Quit the installed copy first, or set `ORANGE_USER_DATA` to a scratch folder to keep your real settings out of it.

### Run the tests

```powershell
npm run build:web
npm test                                 # cargo test in src-tauri, with the feature cfgs set for you
node tests/run.mjs --selftest            # also drives the wheel through its real drop target
```

The tests that need FFmpeg, 7-Zip, Ghostscript, Pandoc or ImageMagick download them with Orange's own downloader (about 110 MB) into `ORANGE_ENGINES_DIR` (default `%LOCALAPPDATA%\app.orange.converter.dev\engines`) and reuse them on later runs. The tool cases open off-screen tool windows and need WebView2. The AI tools download models, so they only run with `ORANGE_TEST_AI=1`.

The self-test never moves your mouse or presses keys: it feeds events to the same state machine the global hooks use and calls the wheel's own OLE drop target in-process.

### Make the installer

```powershell
cd src-tauri
cargo tauri build --bundles nsis         # writes target/release/bundle/nsis/
```

### Publish a release

Releases are built by GitHub, not on your PC. Bump `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and its `Cargo.lock` entry) and `package.json`, then push a tag:

```powershell
git tag v2.0.1
git push origin v2.0.1
```

The `Release v2` workflow tests, builds, signs and publishes the installer together with `latest.json`, which the in-app updater reads. It needs two repository secrets, `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the update signing key; keep a copy somewhere safe, because installed copies can only update from releases signed with it). See [docs/MIGRATION.md](docs/MIGRATION.md).

### Project layout

```
src-tauri/src/        the app, in Rust
  hooks.rs, drag.rs   global mouse/keyboard hooks and the "dragging + tapped a key" state machine
  wheel.rs            the transparent radial menu window and its OLE drop target
  hud.rs, jobs.rs     the corner progress panel; routes a choice to a converter, tool or action
  convert/            converters: image, AV, documents (PDF, Office, sheets), archives, subtitles
  engines.rs          downloads and verifies FFmpeg, Pandoc, Ghostscript, ImageMagick, 7-Zip
  tools.rs            native side of the tool windows
  actions.rs, shelf.rs, clipboard.rs, explorer.rs   share, float shelf, clipboard, Explorer selection
  settings.rs, presets.rs, watch.rs, context_menu.rs, shortcuts.rs   settings and automation
  updater.rs, diagnostics.rs   signed auto-update; logs and "Report a problem"
src-tauri/tests/      integration tests
web/                  tool windows, shelf and clipboard pages, and the bridge to the Rust side (no framework)
src/renderer/         the wheel, the corner panel and the settings page; shared styles and icons
src/shared/           catalog.ts (which formats, tools and actions apply to which files) and shared types
scripts/              build-web.mjs (bundles the pages), icons.mjs (renders the logo into icon files)
tests/run.mjs         `npm test`
```

## Third-party software

Orange downloads these programs unmodified on first use, each under its own licence, and does not redistribute them in its installer.

| Component | Used for | Licence |
| --- | --- | --- |
| [Tauri](https://tauri.app), [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) | The app shell and its windows (WebView2 is part of Windows) | MIT / Apache 2.0, Microsoft redistributable |
| [FFmpeg](https://ffmpeg.org) (gyan.dev essentials build) | Video and audio | GPL v3 |
| [ImageMagick](https://imagemagick.org) | HEIC, AVIF, TIFF and WebP | ImageMagick License |
| [7-Zip](https://www.7-zip.org) | Archives | LGPL v2.1 + unRAR restriction |
| [Pandoc](https://pandoc.org) | Document conversion | GPL v2+ |
| [Ghostscript](https://www.ghostscript.com) | PDF rendering and compression | AGPL v3 |
| [pdf-lib](https://pdf-lib.js.org), [PDF.js](https://mozilla.github.io/pdf.js/) | PDF tools | MIT, Apache 2.0 |
| [Tesseract.js](https://tesseract.projectnaptha.com), [MediaPipe](https://ai.google.dev/edge/mediapipe) | OCR, text and face detection | Apache 2.0 |
| [Transformers.js](https://huggingface.co/docs/transformers.js), [ONNX Runtime Web](https://onnxruntime.ai) | Running AI models locally (WebGPU or CPU) | Apache 2.0, MIT |
| [Whisper](https://github.com/openai/whisper) models | Subtitles | MIT |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) models | Upscale | BSD 3-Clause, MIT |
| [BRIA RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) | Remove background | BRIA RMBG-1.4 licence (non-commercial) |

## Licence

Orange's own source code is released under the [MIT License](LICENSE).
