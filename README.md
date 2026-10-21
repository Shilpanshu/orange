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

Requires Windows 10 or 11, 64-bit.

## How to use

| Do this while dragging a file | You get |
| --- | --- |
| Tap **Shift** | **Convert**: every format the file can become |
| Tap **Ctrl** | **Tools**: compress, crop, trim, merge, redact and more |
| Tap **Alt** | **Actions**: share, float, copy, move, copy path, terminal |

Release the key and keep holding the file; the wheel stays open until you drop or press **Esc**. Tap another key to switch wheels, or use the arrow keys to pick a slice.

You can also select files in Explorer and press **Ctrl + Shift + Space** to open the wheel and click a slice.

The keys can be changed in **Settings → Shortcuts** (click the tray icon).

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

Video that already uses a compatible codec is repackaged without re-encoding, so MOV to MP4 usually takes about a second.

Word, PowerPoint and Excel files use Microsoft Office when it's installed. Without Office, Orange can install LibreOffice for you from **Settings → Engines**. Apple Pages, Keynote and Numbers files need LibreOffice.

## Tools

- **Any file:** Compress (target size, percentage or quality; never overwrites the original), Edit metadata
- **Images:** Edit photo (light, colour, detail with a live preview), Annotate, Add a background, Crop, Redact (finds faces and text automatically, on your PC), Make a PDF, Collage
- **Video:** Trim, Crop, Change speed, Join, Save frames, Split, Redact
- **Audio:** Normalize loudness, Audio visualizer video, Trim, Mono/stereo and channel volume, Bleep, Join
- **PDF:** Merge, Organize pages (reorder, rotate, duplicate, delete), Split
- **Archives:** Extract

## Actions

**Share** opens the Windows share sheet, including Nearby Share. **Float** parks files on a shelf at the screen edge so you can drag them into another app later. **Copy** puts the files on the clipboard for pasting in Explorer. **Move** sends them to another folder. **Copy Path** copies full paths as text. **Terminal** opens the folder in Windows Terminal or PowerShell.

## Privacy

Everything runs on your PC. Orange never uploads your files, collects no analytics and has no account. It only goes online to check GitHub for updates and, if you ask, to download LibreOffice.

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
| [Tesseract.js](https://tesseract.projectnaptha.com), [MediaPipe](https://ai.google.dev/edge/mediapipe) | Offline text and face detection | Apache 2.0 |

## Licence

Orange's own source code is released under the [MIT License](LICENSE).
