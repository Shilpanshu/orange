//! Conversions: every "to:<ext>" target on the Convert wheel, ported from Orange 1.x
//! (src/main/ops/convert-*.ts). Pure-Rust where that is small (subtitles, CSV/XLSX/ODS, BMP, PDF
//! of an image, PPTX of page images, PNG/JPG/GIF/WebP/BMP/ICO decoding); everything heavy goes
//! through an engine downloaded on first use (see `engines.rs`):
//!
//! | kind                        | module      | engines                                         |
//! | --------------------------- | ----------- | ----------------------------------------------- |
//! | image                       | `image`     | in-process; ImageMagick (HEIC/AVIF/TIFF/SVG/JXL in, WebP/TIFF/AVIF out); FFmpeg (HEIC out) |
//! | video, audio                | `av`        | FFmpeg / FFprobe                                |
//! | pdf, document, slides, sheet, ebook | `docs` | Ghostscript, Pandoc, Microsoft Office (COM) or LibreOffice, Edge (HTML to PDF) |
//! | archive (and zipping anything) | `archive` | 7-Zip                                         |
//! | subtitle                    | `subtitle`  | none                                            |
//!
//! Public API (used by `jobs.rs`; tools may reuse the helpers):
//!
//! - `convert(input, target, &ctx) -> R<Vec<PathBuf>>`: one file to one target ("png", "extract").
//! - `pack(paths, target, &ctx)`: several files / folders into one archive (zip, tar, gz, 7z).
//! - `valid_targets(exts, has_folder)`: what the wheel may offer (catalog.ts `conversionTargets`).
//! - `Ctx`: progress, cancel, output paths (never overwriting, honouring the output-folder
//!   setting), temp folders (removed on drop), and `ctx.engine("ffmpeg")` (downloads with progress).
//! - `Fail` / `R<T>`: `Fail::User` messages are shown as-is; `friendly()` turns raw tool errors
//!   into advice, as jobs.ts did.
//! - `set_prefs_source(fn() -> Prefs)`: Settings hands over JPEG quality, the output folder, GPU
//!   encoding and "reveal when done". Until it is called the 1.x defaults apply.

pub mod archive;
pub mod av;
pub mod catalog;
pub mod docs;
pub mod heif;
pub mod image;
pub mod subtitle;

pub use catalog::{kind_of_ext, valid_targets, Kind};
/// Phase-1 API (in-process PNG/JPG/WebP into an exact path), kept for watch folders and tests.
pub use self::image::{image, supports};

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// ------------------------------------------------------------------ errors

#[derive(Debug, Clone, PartialEq)]
pub enum Fail {
    /// Meant for the user as-is.
    User(String),
    Cancelled,
    /// A raw message from a tool or the OS; `friendly()` rewrites it.
    Raw(String),
}

pub type R<T> = Result<T, Fail>;

pub fn user<T>(msg: impl Into<String>) -> R<T> {
    Err(Fail::User(msg.into()))
}

impl From<String> for Fail {
    fn from(s: String) -> Self {
        if s == "Cancelled" {
            Fail::Cancelled
        } else if let Some(m) = s.strip_prefix("network: ") {
            Fail::User(m.to_string())
        } else {
            Fail::Raw(s)
        }
    }
}
impl From<&str> for Fail {
    fn from(s: &str) -> Self {
        Fail::from(s.to_string())
    }
}
impl From<std::io::Error> for Fail {
    fn from(e: std::io::Error) -> Self {
        Fail::Raw(io_message(&e))
    }
}

fn io_message(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.raw_os_error() {
        Some(32) | Some(33) => return "being used by another process".into(),
        Some(112) => return "There is not enough space on the disk".into(),
        Some(206) => return "path too long".into(),
        _ => {}
    }
    match e.kind() {
        PermissionDenied => "Access is denied".into(),
        _ => e.to_string(),
    }
}

impl std::fmt::Display for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Fail::User(m) | Fail::Raw(m) => f.write_str(m),
            Fail::Cancelled => f.write_str("Cancelled"),
        }
    }
}

/// Raw messages from FFmpeg, ImageMagick, 7-Zip, Ghostscript and Windows, translated into what to do
/// next. First match wins; the most specific patterns come first (jobs.ts ERROR_HINTS).
const HINTS: &[(&[&str], &str)] = &[
    (&["spawn ", "is not recognized as an internal"], "A part of Orange is missing. Reinstall Orange to restore it."),
    (&["enospc", "no space left", "there is not enough space"], "The disk is full. Free up some space and try again."),
    (&["ebusy", "being used by another process", "resource busy"], "The file is open in another app. Close it and try again."),
    (&["eperm", "eacces", "access is denied", "permission denied", "read-only"], "Orange can't write there. Choose another output folder in Settings → Saving, or check the folder's permissions."),
    (&["enametoolong", "path too long"], "The file path is too long for Windows. Move the file to a shorter folder path."),
    (&["wrong password", "can not open encrypted archive", "password is incorrect", "invalid password"], "The password is wrong."),
    (&["encrypted", "password-protected", "requires a password"], "The file is password-protected. Use Unlock on the Tools wheel first."),
    (&["invalid data found when processing input", "moov atom not found", "could not find codec parameters", "end of file"], "This media file looks damaged or incomplete, so it can't be read. If it's still downloading or copying, wait for it to finish."),
    (&["does not contain any stream", "matches no streams"], "There's nothing to convert in this file: it has no usable audio or video track."),
    (&["unknown encoder", "encoder not found", "not compiled with"], "This format isn't supported by the video engine. Pick another format."),
    (&["height not divisible by 2", "width not divisible by 2"], "The video's width or height is an odd number, which this format can't store. Crop or resize it by a pixel first."),
    (&["unsupported image format", "input file is missing", "no decode delegate", "improper image header", "insufficient image data"], "This image format or file can't be read. It may be damaged, or not really an image."),
    (&["pixel limit", "too large", "width or height exceeds limit"], "The image is too large to process. Resize it with Compress first."),
    (&["can not open the file as archive", "unexpected end of archive", "headers error", "data error"], "The archive is damaged or incomplete."),
    (&["unrecoverable error", "ghostscript", "gswin64c"], "The PDF couldn't be processed. It may be damaged. Try Organize to resave it first."),
    (&["etimedout", "enotfound", "econnreset", "could not resolve host", "network"], "Orange couldn't reach the internet to download a component. Check your connection and try again."),
    (&["out of memory", "bad_alloc", "cannot allocate memory", "enomem", "memory allocation failed"], "Your PC ran out of memory for this file. Close other apps, or process fewer files at once."),
];

/// The message the HUD shows for a failure.
pub fn friendly(f: &Fail) -> String {
    match f {
        Fail::User(m) => m.clone(),
        Fail::Cancelled => "Cancelled".into(),
        Fail::Raw(m) => {
            let l = m.to_lowercase();
            for (needles, hint) in HINTS {
                if needles.iter().any(|n| l.contains(n)) {
                    return hint.to_string();
                }
            }
            if m.chars().count() > 220 {
                format!("{}…", m.chars().take(220).collect::<String>())
            } else {
                m.clone()
            }
        }
    }
}

// ------------------------------------------------------------------ preferences

/// The settings conversions read. Settings registers a source with `set_prefs_source`.
#[derive(Clone, Debug)]
pub struct Prefs {
    /// 1..100, for JPEG, WebP, AVIF and HEIC (default 88).
    pub jpg_quality: u32,
    /// Settings → Saving → "a folder": every result goes there instead of beside its source.
    pub output_folder: Option<PathBuf>,
    /// Settings → GPU encoding ("off" disables hardware H.264/HEVC encoders).
    pub gpu_encode: bool,
    pub reveal_when_done: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { jpg_quality: 88, output_folder: None, gpu_encode: true, reveal_when_done: false }
    }
}

static PREFS: OnceLock<fn() -> Prefs> = OnceLock::new();

pub fn set_prefs_source(f: fn() -> Prefs) {
    let _ = PREFS.set(f);
}

pub fn prefs() -> Prefs {
    PREFS.get().map(|f| f()).unwrap_or_default()
}

// ------------------------------------------------------------------ the job context

/// Names handed out but perhaps not written yet. Files of one job convert in parallel, so photo.jpg
/// and photo.png going to WebP would otherwise both get "photo.webp".
fn claimed() -> &'static Mutex<HashSet<String>> {
    static C: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

type Report = dyn Fn(f64, Option<&str>) + Send + Sync;

/// What a converter gets for one file: progress, cancel, output paths and temp space.
pub struct Ctx {
    report: Box<Report>,
    pub cancel: Arc<AtomicBool>,
    temps: Mutex<Vec<PathBuf>>,
    claims: Mutex<Vec<String>>,
    /// Watch folders: results go here instead of the output setting.
    pub out_override: Option<PathBuf>,
    prefs: Prefs,
}

impl Ctx {
    pub fn new(report: impl Fn(f64, Option<&str>) + Send + Sync + 'static, cancel: Arc<AtomicBool>) -> Ctx {
        Ctx { report: Box::new(report), cancel, temps: Mutex::new(vec![]), claims: Mutex::new(vec![]), out_override: None, prefs: prefs() }
    }

    pub fn prefs(&self) -> &Prefs {
        &self.prefs
    }

    /// 0..1 for this file.
    pub fn progress(&self, f: f64) {
        (self.report)(f.clamp(0.0, 1.0), None);
    }

    pub fn progress_note(&self, f: f64, note: &str) {
        (self.report)(f.clamp(0.0, 1.0), Some(note));
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> R<()> {
        if self.cancelled() {
            Err(Fail::Cancelled)
        } else {
            Ok(())
        }
    }

    /// A sub-range of this file's bar: `span(a, b)(f)` reports a + (b - a) * f.
    pub fn span(&self, a: f64, b: f64) -> impl Fn(f64) + '_ {
        move |f| self.progress(a + (b - a) * f.clamp(0.0, 1.0))
    }

    fn target_dir(&self, input: &Path) -> PathBuf {
        let dir = self.out_override.clone().or_else(|| self.prefs.output_folder.clone()).unwrap_or_else(|| input.parent().map(Path::to_path_buf).unwrap_or_default());
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn claim(&self, p: PathBuf) -> PathBuf {
        let mut c = claimed().lock().unwrap();
        let free = |x: &Path, c: &HashSet<String>| !x.exists() && !c.contains(&x.to_string_lossy().to_lowercase());
        let mut out = p.clone();
        if !free(&out, &c) {
            let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let (stem, ext) = match p.extension() {
                Some(e) if !p.is_dir() || p.extension().is_some() => (name[..name.len() - e.len() - 1].to_string(), format!(".{}", e.to_string_lossy())),
                _ => (name.clone(), String::new()),
            };
            let mut i = 2;
            loop {
                out = p.with_file_name(format!("{stem} {i}{ext}"));
                if free(&out, &c) {
                    break;
                }
                i += 1;
            }
        }
        let key = out.to_string_lossy().to_lowercase();
        c.insert(key.clone());
        self.claims.lock().unwrap().push(key);
        out
    }

    /// A free output path for `input` with extension `ext` (and an optional suffix before it),
    /// next to the source or in the output folder. Never overwrites: adds " 2", " 3"...
    pub fn out(&self, input: &Path, ext: &str, suffix: &str) -> PathBuf {
        let name = format!("{}{suffix}{}", stem_of(input), if ext.is_empty() { String::new() } else { format!(".{ext}") });
        self.claim(self.target_dir(input).join(name))
    }

    /// Same idea for a folder of results ("All pages"); creates it.
    pub fn out_dir(&self, input: &Path, name: Option<&str>) -> PathBuf {
        let n = name.map(str::to_string).unwrap_or_else(|| stem_of(input));
        let p = self.target_dir(input).join(&n);
        // A folder name may contain dots ("v1.2 pages"); never treat them as an extension.
        let mut c = claimed().lock().unwrap();
        let mut out = p.clone();
        let mut i = 2;
        while out.exists() || c.contains(&out.to_string_lossy().to_lowercase()) {
            out = p.with_file_name(format!("{n} {i}"));
            i += 1;
        }
        let key = out.to_string_lossy().to_lowercase();
        c.insert(key.clone());
        self.claims.lock().unwrap().push(key);
        drop(c);
        let _ = std::fs::create_dir_all(&out);
        out
    }

    /// A fresh private temp folder, removed when the job ends.
    pub fn tmp(&self) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("orange-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::create_dir_all(&d);
        self.temps.lock().unwrap().push(d.clone());
        d
    }

    /// An engine's exe, downloading it (with progress in this job's row) on first use.
    pub fn engine(&self, name: &str) -> R<PathBuf> {
        if crate::engines::ready(name) {
            return Ok(crate::engines::bin(name));
        }
        let r = crate::engines::ensure_with(name, &|f, note| self.progress_note(f, note), &self.cancel);
        (self.report)(0.02, Some(""));
        r.map_err(Fail::from)
    }

    /// Runs an engine (or an absolute exe) with this job's cancel flag.
    pub fn run<'a>(&'a self, exe: &str, args: &[String], mut o: crate::engines::RunOpts<'a>) -> R<crate::engines::RunResult> {
        let path = if Path::new(exe).is_absolute() { PathBuf::from(exe) } else { self.engine(exe)? };
        o.cancel = Some(&self.cancel);
        crate::engines::run_tool_process(&path.to_string_lossy(), args, &o).map_err(|e| if self.cancelled() { Fail::Cancelled } else { Fail::from(e) })
    }
}

impl Drop for Ctx {
    fn drop(&mut self) {
        for d in self.temps.lock().unwrap().drain(..) {
            let _ = std::fs::remove_dir_all(d);
        }
        let mut c = claimed().lock().unwrap();
        for k in self.claims.lock().unwrap().drain(..) {
            c.remove(&k);
        }
    }
}

// ------------------------------------------------------------------ helpers

/// "photo" for photo.jpg; a folder's whole name ("photos.2024").
pub fn stem_of(p: &Path) -> String {
    let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
    if p.is_dir() {
        return name;
    }
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name,
    }
}

pub fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn file_name(p: &Path) -> String {
    p.file_name().unwrap_or_default().to_string_lossy().into_owned()
}

/// rename(), falling back to copy + delete across drives.
pub fn move_file(from: &Path, to: &Path) -> R<()> {
    if let Some(d) = to.parent() {
        std::fs::create_dir_all(d)?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

/// Removes `path` (file or folder) when `f` fails or is cancelled.
pub fn remove_on_failure<T>(path: &Path, f: impl FnOnce() -> R<T>) -> R<T> {
    let r = f();
    if r.is_err() {
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(path);
        } else {
            let _ = std::fs::remove_file(path);
        }
    }
    r
}

/// `\\?\` prefix for tools that can't open paths past MAX_PATH.
pub fn long_safe(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if s.len() >= 240 && !s.starts_with(r"\\?\") {
        if let Some(rest) = s.strip_prefix(r"\\") {
            return format!(r"\\?\UNC\{rest}");
        }
        return format!(r"\\?\{s}");
    }
    s
}

pub fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

// ------------------------------------------------------------------ dispatch

/// Converts one file. `target` is an extension ("png") or "extract".
pub fn convert(input: &Path, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    if !input.exists() {
        return user(format!("{} no longer exists.", file_name(input)));
    }
    let kind = if input.is_dir() { Kind::Folder } else { kind_of_ext(&ext_of(input)) };
    if matches!(target, "zip" | "tar" | "gz" | "7z") && kind != Kind::Archive {
        return archive::convert(&[input.to_path_buf()], target, ctx);
    }
    match kind {
        Kind::Image => image::convert(input, target, ctx),
        Kind::Video | Kind::Audio => av::convert(input, target, ctx),
        Kind::Pdf | Kind::Document | Kind::Slides | Kind::Spreadsheet | Kind::Ebook => docs::convert(input, target, ctx),
        Kind::Archive => archive::convert(&[input.to_path_buf()], target, ctx),
        Kind::Subtitle => subtitle::convert(input, target, ctx),
        Kind::Folder | Kind::Other => user(format!("Can't convert {}.", file_name(input))),
    }
}

/// Several files and folders into one archive.
pub fn pack(paths: &[PathBuf], target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    archive::convert(paths, target, ctx)
}

/// How many files of this kind convert at once (jobs.ts: media is heavy, office is serial).
pub fn concurrency(kind: Kind) -> usize {
    let cpu = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    match kind {
        Kind::Video | Kind::Audio => (cpu / 4).max(1),
        Kind::Document | Kind::Slides | Kind::Spreadsheet | Kind::Ebook | Kind::Pdf => 1,
        _ => (cpu.saturating_sub(1)).max(2),
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;

    /// A context for tests: no HUD, outputs beside the inputs.
    pub fn ctx() -> Ctx {
        let mut c = Ctx::new(|_, _| {}, Arc::new(AtomicBool::new(false)));
        c.prefs = Prefs::default();
        c
    }

    pub fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orange-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_paths_never_collide() {
        let d = testutil::dir("out");
        std::fs::write(d.join("a.jpg"), b"x").unwrap();
        let c = testutil::ctx();
        let a = c.out(&d.join("a.png"), "jpg", "");
        let b = c.out(&d.join("a.webp"), "jpg", "");
        assert_eq!(file_name(&a), "a 2.jpg");
        assert_eq!(file_name(&b), "a 3.jpg");
        drop(c);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn friendly_messages() {
        assert_eq!(friendly(&Fail::Raw("moov atom not found".into())), "This media file looks damaged or incomplete, so it can't be read. If it's still downloading or copying, wait for it to finish.");
        assert_eq!(friendly(&Fail::User("password here".into())), "password here");
        assert_eq!(Fail::from("Cancelled".to_string()), Fail::Cancelled);
    }
}
