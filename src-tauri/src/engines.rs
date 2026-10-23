//! Engines: the command-line tools that do the heavy conversions. None of them ship with Orange;
//! each is downloaded the first time a job needs it, from a pinned URL, checked against a pinned
//! SHA-256, unpacked with Windows' own `tar.exe` (libarchive: zip, 7z, zstd), and kept in
//! `<app local data>/engines/<engine>/`.
//!
//! Public API (for converters, tools and settings):
//!
//! - `engines::set_app(&AppHandle)`: once at start-up. Sets the install folder (the app's local
//!   data folder, so the dev identifier never touches the release app's engines) and lets
//!   `ensure()` show its own HUD row.
//! - `engines::ensure("ffmpeg") -> Result<PathBuf, String>`: the exe's path, downloading the engine
//!   first if needed, with a "Downloading FFmpeg" HUD row (and Cancel). Blocking: call it from a
//!   worker thread. Names: "ffmpeg", "ffprobe", "7z", "pandoc", "gs" (also "gswin64c",
//!   "gs/bin/gswin64c"), "magick" (also "imagemagick/magick").
//! - `engines::ensure_with(name, &progress, &cancel)`: the same, reporting into the caller's own
//!   progress (fraction 0..1, note) instead of a HUD row. Converters use this.
//! - `engines::bin(name) -> PathBuf`: where the exe is (or will be); does not download.
//! - `engines::ready(name) -> bool`, `engines::status() -> serde_json::Value` (for Settings).
//! - `engines::run_tool_process(exe, args, &RunOpts) -> Result<RunResult, String>`: runs an exe
//!   (absolute path, or an engine name which is `ensure`d first) hidden, with cancellation, an
//!   optional timeout, stdin bytes, per-line callbacks for stdout/stderr, and readable errors (the
//!   last meaningful stderr line). Cancellation returns `Err("Cancelled")`.
//!
//! `ORANGE_ENGINES_DIR` overrides the install folder (tests, or a pre-filled offline folder).

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// SourceForge serves the file itself (not a "your download will start" page) to plain clients.
const USER_AGENT: &str = "Wget/1.21.4";

// ------------------------------------------------------------------ the manifest

struct Download {
    urls: &'static [&'static str],
    sha256: &'static str,
    size: u64,
    file: &'static str,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Engine {
    Ffmpeg,
    SevenZip,
    Pandoc,
    Ghostscript,
    Magick,
    /// onnxruntime-web's WebAssembly binary (Remove background, Upscale, Whisper subtitles).
    AiRuntime,
    /// MediaPipe's WebAssembly binary (Redact's face detection).
    MediaPipe,
    /// Tesseract's English language data (OCR, and Redact's text detection).
    TesseractEng,
}

impl Engine {
    fn all() -> [Engine; 8] {
        [Engine::Ffmpeg, Engine::SevenZip, Engine::Pandoc, Engine::Ghostscript, Engine::Magick, Engine::AiRuntime, Engine::MediaPipe, Engine::TesseractEng]
    }
    fn id(self) -> &'static str {
        match self {
            Engine::Ffmpeg => "ffmpeg",
            Engine::SevenZip => "7zip",
            Engine::Pandoc => "pandoc",
            Engine::Ghostscript => "gs",
            Engine::Magick => "imagemagick",
            Engine::AiRuntime => "ai-runtime",
            Engine::MediaPipe => "mediapipe",
            Engine::TesseractEng => "tesseract-eng",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Engine::Ffmpeg => "FFmpeg",
            Engine::SevenZip => "7-Zip",
            Engine::Pandoc => "Pandoc",
            Engine::Ghostscript => "Ghostscript",
            Engine::Magick => "ImageMagick",
            Engine::AiRuntime => "the AI engine",
            Engine::MediaPipe => "face detection",
            Engine::TesseractEng => "English text recognition",
        }
    }
    /// Bumped whenever a pin changes, so an older install is replaced.
    fn version(self) -> &'static str {
        match self {
            Engine::Ffmpeg => "9.0.2-essentials",
            Engine::SevenZip => "26.05",
            Engine::Pandoc => "pypandoc_binary-1.17",
            Engine::Ghostscript => "10.08.0-conda",
            Engine::Magick => "7.1.2-34-portable-Q16-x64",
            Engine::AiRuntime => "ort-1.31.0-dev.20260914-8d85527a0",
            Engine::MediaPipe => "tasks-vision-1.1.1",
            Engine::TesseractEng => "tessdata-best-int-4.0.0",
        }
    }
    fn downloads(self) -> &'static [Download] {
        match self {
            Engine::Ffmpeg => &[Download {
                urls: &["https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.7z"],
                sha256: "4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077",
                size: 35_430_500,
                file: "ffmpeg.7z",
            }],
            // The official installer is a 7z self-extractor, which tar.exe reads directly.
            Engine::SevenZip => &[Download {
                urls: &[
                    "https://downloads.sourceforge.net/project/sevenzip/7-Zip/26.05/7z2605-x64.exe",
                    "https://www.7-zip.org/a/7z2605-x64.exe",
                ],
                sha256: "fd99e86f57d8f429ef5ed045bf98315af962e2309b0f1ba87a147a44c71647d0",
                size: 1_663_506,
                file: "7z-x64.exe",
            }],
            Engine::Pandoc => &[Download {
                urls: &["https://files.pythonhosted.org/packages/c6/b9/f47b77ba75ed5d47ec85fcc2ecfbf7f78e3a73347f3a09836634d930de98/pypandoc_binary-1.17-py3-none-win_amd64.whl"],
                sha256: "76fae066cd2d7e78fb97f0ec8e9e36f437b07187b689b0b415ca18216f8f898a",
                size: 40_891_661,
                file: "pandoc.whl",
            }],
            Engine::Ghostscript => &[
                Download {
                    urls: &["https://conda.anaconda.org/conda-forge/win-64/ghostscript-10.08.0-hac47afa_0.conda"],
                    sha256: "512be9413c58b0ad3a2cd95a63eaea73cbe32d9a6b9170c848bf825694a4adb0",
                    size: 19_295_904,
                    file: "gs.conda",
                },
                // The MSVC runtime gsdll64.dll links against (most PCs have it; not all).
                Download {
                    urls: &["https://conda.anaconda.org/conda-forge/win-64/vc14_runtime-14.44.35208-h818238b_41.conda"],
                    sha256: "ec706fe9368b837fbd05af4851f5ebef12bef8c471a273f4805f7af788407317",
                    size: 682_908,
                    file: "vc.conda",
                },
            ],
            Engine::Magick => &[Download {
                urls: &[
                    "https://downloads.sourceforge.net/project/imagemagick/7.1.2-34/ImageMagick-7.1.2-34-portable-Q16-x64.7z",
                    "https://imagemagick.org/archive/binaries/ImageMagick-7.1.2-34-portable-Q16-x64.7z",
                ],
                sha256: "52cc6a441c7884f5ff4274b410c9b90c4b7d54245dcdf4d32988bb4e4df4e5d1",
                size: 12_022_003,
                file: "imagemagick.7z",
            }],
            // The raw .wasm files from the npm packages the pages were built against (jsDelivr
            // serves the npm registry; the SHA-256 is of the exact published file).
            Engine::AiRuntime => &[Download {
                urls: &[
                    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm",
                    "https://unpkg.com/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm",
                ],
                sha256: "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082",
                size: 26_861_777,
                file: "ort-wasm-simd-threaded.asyncify.wasm",
            }],
            Engine::MediaPipe => &[Download {
                urls: &[
                    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm/vision_wasm_internal.wasm",
                    "https://unpkg.com/@mediapipe/tasks-vision@1.1.1/wasm/vision_wasm_internal.wasm",
                ],
                sha256: "0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd",
                size: 13_519_922,
                file: "vision_wasm_internal.wasm",
            }],
            Engine::TesseractEng => &[Download {
                urls: &[
                    "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz",
                    "https://unpkg.com/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz",
                ],
                sha256: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
                size: 2_952_873,
                file: "eng.traineddata.gz",
            }],
        }
    }
    fn download_size(self) -> u64 {
        self.downloads().iter().map(|d| d.size).sum()
    }
}

/// Engine and exe (relative to the engine's folder) for a tool name.
fn resolve(name: &str) -> Option<(Engine, &'static str)> {
    let n = name.trim_end_matches(".exe").replace('\\', "/").to_ascii_lowercase();
    Some(match n.as_str() {
        "ffmpeg" => (Engine::Ffmpeg, "ffmpeg.exe"),
        "ffprobe" => (Engine::Ffmpeg, "ffprobe.exe"),
        "7z" | "7zip" | "7-zip" => (Engine::SevenZip, "7z.exe"),
        "pandoc" => (Engine::Pandoc, "pandoc.exe"),
        "gs" | "gswin64c" | "gs/bin/gswin64c" | "ghostscript" => (Engine::Ghostscript, "bin/gswin64c.exe"),
        "magick" | "imagemagick/magick" | "imagemagick" => (Engine::Magick, "magick.exe"),
        "ai-runtime" => (Engine::AiRuntime, "ort-wasm-simd-threaded.asyncify.wasm"),
        "mediapipe" => (Engine::MediaPipe, "vision_wasm_internal.wasm"),
        "tesseract-eng" => (Engine::TesseractEng, "eng.traineddata.gz"),
        _ => return None,
    })
}

// ------------------------------------------------------------------ paths

static APP: OnceLock<AppHandle> = OnceLock::new();
static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Call once at start-up (lib.rs setup).
pub fn set_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// `<app local data>/engines`, or `ORANGE_ENGINES_DIR`.
pub fn root() -> PathBuf {
    if let Some(r) = ROOT.get() {
        return r.clone();
    }
    let dir = std::env::var_os("ORANGE_ENGINES_DIR").map(PathBuf::from).or_else(|| {
        APP.get().and_then(|a| a.path().app_local_data_dir().ok()).map(|d| d.join("engines"))
    });
    match dir {
        // Only cache a real answer; before set_app() a later call may still learn the app folder.
        Some(d) => ROOT.get_or_init(|| d).clone(),
        None => std::env::temp_dir().join("orange-engines"),
    }
}

fn engine_dir(e: Engine) -> PathBuf {
    root().join(e.id())
}

fn marker(e: Engine) -> PathBuf {
    engine_dir(e).join(".installed")
}

fn installed(e: Engine) -> bool {
    std::fs::read_to_string(marker(e)).map(|s| s.trim() == e.version()).unwrap_or(false)
}

/// Where a tool's exe is (or will be once downloaded). Unknown names are returned as given.
pub fn bin(name: &str) -> PathBuf {
    match resolve(name) {
        Some((e, exe)) => engine_dir(e).join(exe),
        None => PathBuf::from(name),
    }
}

/// True when the tool is downloaded and ready.
pub fn ready(name: &str) -> bool {
    resolve(name).map(|(e, exe)| installed(e) && engine_dir(e).join(exe).is_file()).unwrap_or(false)
}

/// Size in bytes of an engine's download (0 for an unknown name), for "(N MB), first use only".
pub fn download_bytes(name: &str) -> u64 {
    resolve(name).map(|(e, _)| e.download_size()).unwrap_or(0)
}

/// Display name of an engine ("the AI engine"), or the name itself when unknown.
pub fn label_of(name: &str) -> String {
    resolve(name).map(|(e, _)| e.label().to_string()).unwrap_or_else(|| name.to_string())
}

/// Folder an engine is installed in (served to tool windows as `ofs://.../engine/<id>/<file>`).
pub fn dir_of(name: &str) -> Option<PathBuf> {
    resolve(name).map(|(e, _)| engine_dir(e))
}

/// Every engine with its download size and whether it is installed, for Settings.
pub fn status() -> Value {
    Value::Array(
        Engine::all()
            .iter()
            .map(|&e| json!({ "id": e.id(), "label": e.label(), "version": e.version(), "installed": installed(e), "downloadBytes": e.download_size() }))
            .collect(),
    )
}

/// Deletes a downloaded engine (Settings "free up space"); the next job downloads it again.
pub fn remove(name: &str) -> Result<(), String> {
    let (e, _) = resolve(name).ok_or_else(|| format!("unknown engine {name}"))?;
    let _guard = lock(e);
    let _ = std::fs::remove_file(marker(e));
    std::fs::remove_dir_all(engine_dir(e)).or_else(|err| if err.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(err.to_string()) })
}

// ------------------------------------------------------------------ ensure

static LOCKS: [Mutex<()>; 8] = [Mutex::new(()), Mutex::new(()), Mutex::new(()), Mutex::new(()), Mutex::new(()), Mutex::new(()), Mutex::new(()), Mutex::new(())];

/// One install at a time per engine; a second job asking for it waits, then finds it ready.
fn lock(e: Engine) -> std::sync::MutexGuard<'static, ()> {
    let i = Engine::all().iter().position(|&x| x == e).unwrap();
    LOCKS[i].lock().unwrap_or_else(|p| p.into_inner())
}

/// The exe for `name`, downloading its engine first if needed, with its own HUD row.
pub fn ensure(name: &str) -> Result<PathBuf, String> {
    let (e, _) = resolve(name).ok_or_else(|| format!("unknown engine {name}"))?;
    if ready(name) {
        return Ok(bin(name));
    }
    let Some(app) = APP.get() else {
        return ensure_with(name, &|_, _| {}, &AtomicBool::new(false));
    };
    let job = crate::hud::start(app, &format!("Downloading {} (first use)", e.label()));
    let cancel = job.cancelled.clone();
    let r = ensure_with(name, &|f, note| job.progress(f, Some(note)), &cancel);
    match &r {
        Ok(_) => job.done(vec![], vec![]),
        Err(m) if m == "Cancelled" => job.cancelled(),
        Err(m) => job.failed(m),
    }
    r
}

/// The exe for `name`, downloading its engine first if needed. `progress(fraction, note)` gets
/// download progress ("Downloading FFmpeg, 12 of 35 MB"); `cancel` stops the download.
pub fn ensure_with(name: &str, progress: &dyn Fn(f64, &str), cancel: &AtomicBool) -> Result<PathBuf, String> {
    let (e, exe) = resolve(name).ok_or_else(|| format!("unknown engine {name}"))?;
    if ready(name) {
        return Ok(bin(name));
    }
    let _guard = lock(e);
    // Another job may have installed it while this one waited.
    if ready(name) {
        return Ok(bin(name));
    }
    let started = Instant::now();
    install(e, progress, cancel)?;
    let path = engine_dir(e).join(exe);
    if !path.is_file() {
        return Err(format!("{} was downloaded but {exe} is missing from it.", e.label()));
    }
    crate::log::write(&format!("engine {} {} installed in {:.1} s", e.id(), e.version(), started.elapsed().as_secs_f64()));
    Ok(path)
}

fn mb(b: u64) -> String {
    format!("{:.0}", (b as f64 / 1_048_576.0).max(1.0))
}

fn install(e: Engine, progress: &dyn Fn(f64, &str), cancel: &AtomicBool) -> Result<(), String> {
    let root = root();
    std::fs::create_dir_all(&root).map_err(|err| format!("Can't create {}: {err}", root.display()))?;
    let work = root.join(format!(".work-{}-{}", e.id(), std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|err| err.to_string())?;
    let result = (|| {
        let total = e.download_size().max(1);
        let mut before = 0u64;
        let mut files = Vec::new();
        for d in e.downloads() {
            let dest = work.join(d.file);
            let label = e.label();
            let report = |got: u64| {
                let all = before + got.min(d.size);
                progress(0.92 * all as f64 / total as f64, &format!("Downloading {label} (first use), {} of {} MB", mb(all), mb(total)));
            };
            download(d, &dest, &report, cancel)?;
            before += d.size;
            files.push(dest);
        }
        progress(0.93, &format!("Unpacking {}", e.label()));
        let stage = work.join("stage");
        std::fs::create_dir_all(&stage).map_err(|err| err.to_string())?;
        unpack(e, &files, &work, &stage, cancel)?;
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".to_string());
        }
        std::fs::write(stage.join(".installed"), e.version()).map_err(|err| err.to_string())?;
        // Swap in the new folder. A running exe from an older copy can't be deleted; park it.
        let dir = engine_dir(e);
        if dir.exists() && std::fs::remove_dir_all(&dir).is_err() {
            let parked = root.join(format!(".old-{}-{}", e.id(), std::process::id()));
            std::fs::rename(&dir, &parked).map_err(|err| format!("Can't replace {}: {err}", dir.display()))?;
        }
        std::fs::rename(&stage, &dir).map_err(|err| format!("Can't install {}: {err}", e.label()))?;
        progress(1.0, &format!("{} ready", e.label()));
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&work);
    // Leftovers of earlier interrupted installs.
    if let Ok(rd) = std::fs::read_dir(&root) {
        for ent in rd.flatten() {
            let n = ent.file_name().to_string_lossy().into_owned();
            if n.starts_with(".old-") {
                let _ = std::fs::remove_dir_all(ent.path());
            }
        }
    }
    result
}

fn system32(exe: &str) -> PathBuf {
    let win = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    win.join("System32").join(exe)
}

fn sha256_file(p: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Downloads with Windows' curl.exe (system proxy and certificate store, retries), reporting the
/// growing file's size, then checks the SHA-256. A cached file that already matches is reused.
fn download(d: &Download, dest: &Path, report: &dyn Fn(u64), cancel: &AtomicBool) -> Result<(), String> {
    // A partial download from a cancelled run is kept in the cache folder and resumed.
    let cache = root().join(".downloads");
    let _ = std::fs::create_dir_all(&cache);
    let cached = cache.join(d.file);
    if cached.is_file() && std::fs::metadata(&cached).map(|m| m.len()).unwrap_or(0) == d.size && sha256_file(&cached)? == d.sha256 {
        report(d.size);
        return std::fs::rename(&cached, dest).map_err(|e| e.to_string());
    }
    let curl = system32("curl.exe");
    let mut errors = Vec::new();
    for url in d.urls {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled".into());
        }
        let resume = cached.is_file() && std::fs::metadata(&cached).map(|m| m.len() < d.size).unwrap_or(false);
        let mut cmd = Command::new(&curl);
        cmd.args(["-fsSL", "-A", USER_AGENT, "--connect-timeout", "30", "--retry", "3", "--retry-all-errors", "--speed-limit", "1024", "--speed-time", "60"]);
        if resume {
            cmd.args(["-C", "-"]);
        }
        cmd.arg("-o").arg(&cached).arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Err(format!("Can't start curl.exe ({e}). Orange needs Windows 10 1803 or later to download its engines.")),
        };
        let mut stderr = child.stderr.take();
        let err_reader = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(e) = stderr.as_mut() {
                let _ = e.read_to_string(&mut s);
            }
            s
        });
        let status = loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Cancelled".into());
            }
            report(std::fs::metadata(&cached).map(|m| m.len()).unwrap_or(0));
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                Err(e) => return Err(e.to_string()),
            }
        };
        let err = err_reader.join().unwrap_or_default();
        if !status.success() {
            errors.push(format!("{url}: {}", err.trim().lines().last().unwrap_or("download failed")));
            // A server that refuses to resume (HTTP 416, or a mirror without ranges) starts over.
            let _ = std::fs::remove_file(&cached);
            continue;
        }
        let got = sha256_file(&cached)?;
        if got != d.sha256 {
            let _ = std::fs::remove_file(&cached);
            errors.push(format!("{url}: checksum mismatch (got {got})"));
            continue;
        }
        report(d.size);
        return std::fs::rename(&cached, dest).map_err(|e| e.to_string());
    }
    crate::log::write(&format!("engine download failed: {}", errors.join(" | ")));
    let net = errors.iter().any(|e| {
        let l = e.to_lowercase();
        l.contains("resolve") || l.contains("connect") || l.contains("timed out") || l.contains("network")
    });
    if net {
        Err("network: Orange couldn't download a component it needs. Check your connection and try again.".into())
    } else {
        Err(format!("Couldn't download {} ({})", d.file, errors.last().cloned().unwrap_or_default()))
    }
}

/// Windows' bsdtar unpacks zip, 7z (including the 7-Zip installer) and tar.zst.
fn tar(args: &[&str], archive: &Path, into: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let mut a: Vec<String> = vec!["-xf".into(), archive.to_string_lossy().into_owned(), "-C".into(), into.to_string_lossy().into_owned()];
    a.extend(args.iter().map(|s| s.to_string()));
    let tar = system32("tar.exe");
    run_tool_process(&tar.to_string_lossy(), &a, &RunOpts { cancel: Some(cancel), ..Default::default() })
        .map(|_| ())
        .map_err(|e| if e == "Cancelled" { e } else { format!("Couldn't unpack {}: {e}", archive.file_name().unwrap_or_default().to_string_lossy()) })
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for ent in std::fs::read_dir(dir).ok()?.flatten() {
        let p = ent.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name) {
                return Some(f);
            }
        } else if ent.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
            return Some(p);
        }
    }
    None
}

fn move_into(src: &Path, dir: &Path) -> Result<(), String> {
    let dest = dir.join(src.file_name().unwrap_or_default());
    std::fs::rename(src, &dest).or_else(|_| std::fs::copy(src, &dest).map(|_| ())).map_err(|e| e.to_string())
}

fn unpack(e: Engine, files: &[PathBuf], work: &Path, stage: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let x = work.join("x");
    std::fs::create_dir_all(&x).map_err(|e| e.to_string())?;
    match e {
        Engine::AiRuntime | Engine::MediaPipe | Engine::TesseractEng => {
            // Plain files, no archive: keep them under their own names.
            for f in files {
                move_into(f, stage)?;
            }
        }
        Engine::Ffmpeg => {
            tar(&["*/bin/ffmpeg.exe", "*/bin/ffprobe.exe", "*/LICENSE"], &files[0], &x, cancel)?;
            for f in ["ffmpeg.exe", "ffprobe.exe"] {
                move_into(&find_file(&x, f).ok_or(format!("{f} is missing from the FFmpeg download"))?, stage)?;
            }
            if let Some(l) = find_file(&x, "LICENSE") {
                let _ = std::fs::rename(l, stage.join("LICENSE.txt"));
            }
        }
        Engine::SevenZip => {
            tar(&["7z.exe", "7z.dll", "License.txt"], &files[0], &x, cancel)?;
            for f in ["7z.exe", "7z.dll", "License.txt"] {
                move_into(&find_file(&x, f).ok_or(format!("{f} is missing from the 7-Zip download"))?, stage)?;
            }
        }
        Engine::Pandoc => {
            tar(&["pypandoc/files/pandoc.exe"], &files[0], &x, cancel)?;
            move_into(&find_file(&x, "pandoc.exe").ok_or("pandoc.exe is missing from the Pandoc download")?, stage)?;
        }
        Engine::Ghostscript => {
            // A .conda package is a zip holding pkg-*.tar.zst; Library/ is a normal Windows layout
            // (bin/, lib/, Resource folders) that gswin64c.exe finds relative to itself.
            for (i, f) in files.iter().enumerate() {
                let outer = x.join(format!("o{i}"));
                let inner = x.join(format!("i{i}"));
                std::fs::create_dir_all(&outer).map_err(|e| e.to_string())?;
                std::fs::create_dir_all(&inner).map_err(|e| e.to_string())?;
                tar(&[], f, &outer, cancel)?;
                let pkg = std::fs::read_dir(&outer)
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .map(|d| d.path())
                    .find(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("pkg-")).unwrap_or(false))
                    .ok_or("The Ghostscript download has no package inside")?;
                tar(&[], &pkg, &inner, cancel)?;
            }
            let lib = x.join("i0").join("Library");
            for ent in std::fs::read_dir(&lib).map_err(|e| e.to_string())?.flatten() {
                std::fs::rename(ent.path(), stage.join(ent.file_name())).map_err(|e| e.to_string())?;
            }
            let bin = stage.join("bin");
            if let Some(rd) = std::fs::read_dir(x.join("i1").join("Library").join("bin")).ok() {
                for ent in rd.flatten() {
                    if ent.file_name().to_string_lossy().to_lowercase().ends_with(".dll") {
                        let _ = std::fs::rename(ent.path(), bin.join(ent.file_name()));
                    }
                }
            }
            // Import libraries and the GUI build aren't needed.
            if let Ok(rd) = std::fs::read_dir(&bin) {
                for ent in rd.flatten() {
                    let n = ent.file_name().to_string_lossy().to_lowercase();
                    if n.ends_with(".lib") || n.ends_with(".exp") || n == "gswin64.exe" || n == "gs.exe" {
                        let _ = std::fs::remove_file(ent.path());
                    }
                }
            }
            let _ = std::fs::remove_dir_all(stage.join("lib"));
        }
        Engine::Magick => {
            tar(&[], &files[0], &x, cancel)?;
            let exe = find_file(&x, "magick.exe").ok_or("magick.exe is missing from the ImageMagick download")?;
            let dir = exe.parent().unwrap().to_path_buf();
            // The portable build is one static exe per tool; `magick` covers them all. Keep its config files.
            for ent in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                let n = ent.file_name().to_string_lossy().to_lowercase();
                if n == "magick.exe" || n.ends_with(".xml") || n.ends_with(".icc") || n.starts_with("license") || n.starts_with("notice") {
                    move_into(&ent.path(), stage)?;
                }
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ running tools

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Default)]
pub struct RunOpts<'a> {
    pub cwd: Option<&'a Path>,
    pub env: Vec<(String, String)>,
    /// Bytes written to stdin (then closed). None: stdin is closed at once.
    pub stdin: Option<&'a [u8]>,
    /// Exit codes that also count as success (7-Zip returns 1 for warnings).
    pub ok_codes: &'a [i32],
    /// Each line of stdout/stderr as it arrives (progress parsing). Runs on the calling thread.
    pub on_line: Option<&'a dyn Fn(&str, Stream)>,
    /// Set to stop the process; the call then returns Err("Cancelled").
    pub cancel: Option<&'a AtomicBool>,
    /// Kill the process after this long.
    pub timeout: Option<Duration>,
    /// Secrets (passwords) masked in logs and errors.
    pub redact: Vec<String>,
    /// Collect stdout (default true). Off for chatty tools whose stdout is only progress.
    pub no_stdout: bool,
}

#[derive(Debug, Default)]
pub struct RunResult {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl RunResult {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

enum Msg {
    Line(Stream, String),
    Chunk(Vec<u8>),
}

/// Runs `exe` (an absolute path, or an engine name that is `ensure`d first) without a window.
/// Ok when it exits 0 (or with one of `ok_codes`); otherwise Err with the last meaningful stderr
/// line. Err("Cancelled") when `cancel` was set, Err("timed out") after `timeout`.
pub fn run_tool_process(exe: &str, args: &[String], o: &RunOpts) -> Result<RunResult, String> {
    let path = if exe.contains('\\') || exe.contains('/') && Path::new(exe).is_absolute() { PathBuf::from(exe) } else if resolve(exe).is_some() { ensure(exe)? } else { PathBuf::from(exe) };
    if o.cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
        return Err("Cancelled".into());
    }
    let mut cmd = Command::new(&path);
    cmd.args(args).stdin(if o.stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW);
    if let Some(c) = o.cwd {
        cmd.current_dir(c);
    }
    for (k, v) in &o.env {
        cmd.env(k, v);
    }
    let name = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let mask = |t: &str| o.redact.iter().filter(|s| !s.is_empty()).fold(t.to_string(), |acc, s| acc.replace(s.as_str(), "***"));
    let mut child = cmd.spawn().map_err(|e| {
        if let Some(c) = o.cwd {
            if c.as_os_str().len() >= 248 {
                return format!("The folder path is too long for Windows (path too long): {}", c.display());
            }
        }
        format!("spawn {name} failed: {e}")
    })?;
    let (tx, rx) = std::sync::mpsc::channel::<Msg>();
    let mut readers = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let tx = tx.clone();
        let lines = o.on_line.is_some();
        let keep = !o.no_stdout;
        readers.push(std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                let n = match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                if keep {
                    let _ = tx.send(Msg::Chunk(buf[..n].to_vec()));
                }
                if lines {
                    pending.extend_from_slice(&buf[..n]);
                    while let Some(i) = pending.iter().position(|&b| b == b'\n' || b == b'\r' || b == 8) {
                        let line: Vec<u8> = pending.drain(..=i).collect();
                        let s = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
                        if !s.is_empty() {
                            let _ = tx.send(Msg::Line(Stream::Stdout, s));
                        }
                    }
                }
            }
            if lines && !pending.is_empty() {
                let _ = tx.send(Msg::Line(Stream::Stdout, String::from_utf8_lossy(&pending).into_owned()));
            }
        }));
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            let mut r = BufReader::new(err);
            let mut line = Vec::new();
            loop {
                line.clear();
                match r.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        // ffmpeg and 7-Zip redraw with \r; split those too.
                        for part in String::from_utf8_lossy(&line).split(['\r', '\n']) {
                            if !part.trim().is_empty() {
                                let _ = tx.send(Msg::Line(Stream::Stderr, part.to_string()));
                            }
                        }
                    }
                }
            }
        }));
    }
    drop(tx);
    if let (Some(bytes), Some(mut sin)) = (o.stdin, child.stdin.take()) {
        let bytes = bytes.to_vec();
        // On its own thread: a tool that writes a lot before reading all of stdin must not deadlock.
        std::thread::spawn(move || {
            let _ = sin.write_all(&bytes);
        });
    }
    let started = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = String::new();
    let mut killed: Option<&str> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Msg::Chunk(c)) => stdout.extend_from_slice(&c),
            Ok(Msg::Line(s, l)) => {
                if s == Stream::Stderr {
                    stderr.push_str(&l);
                    stderr.push('\n');
                    if stderr.len() > 64_000 {
                        stderr.drain(..stderr.len() - 48_000);
                        while !stderr.is_char_boundary(0) {
                            stderr.remove(0);
                        }
                    }
                }
                if let Some(f) = o.on_line {
                    f(&l, s);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if killed.is_none() {
            if o.cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                killed = Some("Cancelled");
                let _ = child.kill();
            } else if o.timeout.map(|t| started.elapsed() > t).unwrap_or(false) {
                killed = Some("timed out");
                let _ = child.kill();
            }
        }
    }
    for r in readers {
        let _ = r.join();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if let Some(k) = killed {
        return Err(k.into());
    }
    let code = status.code().unwrap_or(-1);
    if code == 0 || o.ok_codes.contains(&code) {
        return Ok(RunResult { code, stdout, stderr });
    }
    let tail: String = stderr.chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
    crate::log::write(&format!("{name} failed ({code}) {} :: {}", mask(&args.join(" ")), mask(&tail)));
    let last = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("").to_string();
    Err(if last.is_empty() { format!("{name} exited with code {code}") } else { mask(&last) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_resolve() {
        assert_eq!(resolve("ffprobe").unwrap().0, Engine::Ffmpeg);
        assert_eq!(resolve("gs/bin/gswin64c").unwrap().1, "bin/gswin64c.exe");
        assert_eq!(resolve("imagemagick/magick.exe").unwrap().0, Engine::Magick);
        assert!(resolve("notepad").is_none());
    }

    #[test]
    fn runs_a_process_and_reports_errors() {
        let cmd = system32("cmd.exe").to_string_lossy().into_owned();
        let lines = Mutex::new(Vec::new());
        let on = |l: &str, _s: Stream| lines.lock().unwrap().push(l.to_string());
        let r = run_tool_process(&cmd, &["/c".into(), "echo hello".into()], &RunOpts { on_line: Some(&on), ..Default::default() }).unwrap();
        assert!(r.stdout_text().contains("hello"));
        assert_eq!(lines.lock().unwrap()[0].trim(), "hello");
        let e = run_tool_process(&cmd, &["/c".into(), "echo boom 1>&2 & exit 3".into()], &RunOpts::default()).unwrap_err();
        assert_eq!(e.trim(), "boom");
        let r = run_tool_process(&cmd, &["/c".into(), "exit 1".into()], &RunOpts { ok_codes: &[1], ..Default::default() }).unwrap();
        assert_eq!(r.code, 1);
        let cancel = AtomicBool::new(true);
        assert_eq!(run_tool_process(&cmd, &["/c".into(), "ping -n 5 127.0.0.1".into()], &RunOpts { cancel: Some(&cancel), ..Default::default() }).unwrap_err(), "Cancelled");
    }
}
