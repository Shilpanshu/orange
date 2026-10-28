//! Tool windows (Tools wheel) and the native services their pages call.
//!
//! The tool pages (web/tool) run their own jobs: pure-JS work (pdf-lib, pdf.js, exceljs,
//! tesseract.js, transformers.js) runs in the webview, and native work goes through here:
//!
//! - `ofs://` (http://ofs.localhost/...): file IO. `GET /f?p=` streams a file with Range support
//!   (img/video/audio src and fetch); `POST /fs` runs one filesystem op (JSON in, JSON out) and
//!   `POST /write?p=` writes the request body. Synchronous XHR works against it, which is what lets
//!   the 1.x main-process code keep its `fs.*Sync` calls (see web/tool/host/node/fs.ts).
//! - `tools_spawn` / `tools_kill`: runs a bundled tool (ffmpeg, ffprobe, gs, 7z, magick) with
//!   line streaming and cancellation.
//! - `tools_hud`: job rows in the progress panel, with Cancel.
//! - `tools_window`, `tools_dialog`, `tools_info`: window chrome, file dialogs, paths.

use crate::{hud, log};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::http::{Request, Response, StatusCode};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// ------------------------------------------------------------------ windows

/// Preferred window sizes per tool (CSS px). Editors get more room than small option dialogs.
fn size_for(tool: &str) -> (f64, f64) {
    match tool {
        "compress" => (520.0, 560.0),
        "metadata" => (720.0, 640.0),
        "extractArchive" => (480.0, 320.0),
        "createPdf" | "mergePdf" => (760.0, 620.0),
        "splitPdf" => (720.0, 600.0),
        "audioChannels" => (720.0, 520.0),
        "normalizeAudio" => (720.0, 560.0),
        "rename" => (960.0, 680.0),
        "ocr" => (900.0, 640.0),
        "protect" => (520.0, 700.0),
        "unlock" => (480.0, 420.0),
        _ => (1080.0, 760.0),
    }
}

/// Every tool window id (web/tool/pages.ts). `extractArchive` runs without a window.
pub const TOOL_IDS: &[&str] = &[
    "editImage", "annotateImage", "frameImage", "cropImage", "redactImage", "createPdf", "createCollage",
    "trimVideo", "cropVideo", "speedVideo", "joinVideos", "videoFrames", "splitVideo", "redactVideo",
    "normalizeAudio", "audioToVideo", "trimAudio", "audioChannels", "bleepAudio", "joinAudio",
    "mergePdf", "organizePdf", "splitPdf", "compress", "metadata", "ocr", "removeBg", "upscale",
    "rename", "protect", "unlock", "subtitles", "extractArchive",
];

static SEQ: AtomicU64 = AtomicU64::new(0);

thread_local! {
    /// The label of the last window `open()` made on this thread (the test server learns which window a
    /// wheel choice opened from it; other requests open windows at the same time).
    static OPENED: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Tool windows run in their own WebView2 environment (own data folder), because they need what
/// the lean shared one turns off: the GPU (Edit's WebGL renderer, WebGPU for the AI tools) and a
/// renderer process per window (a long job in one window must not stall another). Every tool
/// window uses these same arguments, as WebView2 requires per data folder.
pub fn tool_browser_args() -> String {
    std::env::var("ORANGE_TOOL_BROWSER_ARGS").unwrap_or_else(|_| {
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Translate,OptimizationHints,AutofillServerCommunication          --disable-background-networking --no-pings"
            .into()
    })
}

fn tool_data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("orange")).join("ToolWebView")
}

fn is_dark() -> bool {
    use windows::Win32::System::Registry::*;
    let mut v: u32 = 1;
    let mut n = 4u32;
    unsafe {
        let r = RegGetValueW(
            HKEY_CURRENT_USER,
            &windows::core::HSTRING::from(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            &windows::core::HSTRING::from("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut v as *mut u32 as *mut _),
            Some(&mut n),
        );
        r.is_ok() && v == 0
    }
}

/// Opens a tool window for `paths`. Hidden until its page has built itself (`page:ready`).
/// `extra` is merged into the page's args (presets, self-tests).
pub fn open(app: &AppHandle, tool: &str, paths: Vec<String>, extra: Option<Value>) -> Result<String, String> {
    let label = format!("tool-{}", SEQ.fetch_add(1, Ordering::SeqCst) + 1);
    let (w, h) = size_for(tool);
    let mut args = json!({ "tool": tool, "paths": paths });
    if let Some(Value::Object(m)) = extra {
        for (k, v) in m {
            args[k] = v;
        }
    }
    // The page reads its args from location.hash (web/bridge.ts); set it before any script runs.
    if test_mode() {
        args["test"] = json!(true);
        args["offscreen"] = json!(true);
    }
    let hash = urlencode(&args.to_string());
    let init = format!("history.replaceState(null,'',location.pathname+'#{hash}');");
    let off_screen = std::env::var("ORANGE_TOOL_OFFSCREEN").as_deref() == Ok("1")
        || args.get("offscreen").and_then(Value::as_bool).unwrap_or(false);
    let bg = if is_dark() { tauri::window::Color(0x1a, 0x18, 0x16, 255) } else { tauri::window::Color(0xf6, 0xf3, 0xef, 255) };
    let run_hidden = args.get("run").and_then(Value::as_bool).unwrap_or(false) || tool == "extractArchive";
    let title = args.get("title").and_then(Value::as_str).unwrap_or("Orange").to_string();
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("renderer/tool/index.html".into()))
        .title(title)
        .additional_browser_args(&tool_browser_args())
        .data_directory(tool_data_dir(app))
        .initialization_script(&init)
        .inner_size(w, h)
        .min_inner_size(w.min(460.0), h.min(320.0))
        .decorations(false)
        .shadow(true)
        .background_color(bg)
        .visible(run_hidden)
        .drag_and_drop(false);
    // A job-only window (presets, instant tools) is never seen. It still has to be "shown": a
    // hidden WebView2 page doesn't get the pushes (child process output) its job waits for. So it
    // lives off-screen, out of the taskbar and unfocused.
    if off_screen || run_hidden {
        b = b.position(-32000.0, -32000.0).skip_taskbar(true).focused(false);
    } else {
        b = b.center();
    }
    let win = b.build().map_err(|e| e.to_string())?;
    // Fit and centre on the monitor under the cursor (center() uses the primary monitor).
    if !off_screen && !run_hidden {
        center_on_cursor_monitor(&win, w, h);
    }
    log::write(&format!("tool window {label}: {tool} ({} files)", paths_len(&args)));
    OPENED.with(|o| *o.borrow_mut() = Some(label.clone()));
    Ok(label)
}

fn paths_len(args: &Value) -> usize {
    args.get("paths").and_then(Value::as_array).map_or(0, Vec::len)
}

fn center_on_cursor_monitor(win: &WebviewWindow, w: f64, h: f64) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    let (scale, wa) = crate::win::monitor_scale(p);
    let (aw, ah) = ((wa.right - wa.left) as f64, (wa.bottom - wa.top) as f64);
    let pw = (w * scale).min(aw - 40.0 * scale);
    let ph = (h * scale).min(ah - 40.0 * scale);
    let x = wa.left as f64 + (aw - pw) / 2.0;
    let y = wa.top as f64 + (ah - ph) / 2.0;
    let _ = win.set_size(tauri::PhysicalSize::new(pw.round() as u32, ph.round() as u32));
    let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/// The bridge's own `page:ready` (listeners registered). A tool page isn't built yet at that
/// point, so it is shown on `tool:ready` instead (sent after its load event, like 1.x's
/// ready-to-show).
pub fn page_ready(_app: &AppHandle, _label: &str) {}

/// The page has built itself: show it (unless it runs off-screen for a test).
fn show_ready(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let _ = w.show();
    if w.outer_position().map(|p| p.x > -30000).unwrap_or(true) {
        let _ = w.set_focus();
    }
}

/// Wheel entry point for `preset:<id>`: runs the preset's tool on `paths` with the saved options,
/// in a hidden tool window (the job runs in the page, like every tool job), if the tool fits the files.
pub fn run_preset(app: &AppHandle, id: &str, paths: Vec<String>) {
    let Some(p) = crate::presets::get_preset(id) else {
        hud::notice(app, "That preset no longer exists.");
        return;
    };
    let kinds: std::collections::HashSet<&'static str> = paths.iter().map(|x| crate::presets::kind_of_ext(&crate::presets::ext_of(x))).collect();
    if !kinds.iter().all(|k| p.kinds.iter().any(|pk| pk == k)) {
        hud::notice(app, &format!("The \"{}\" preset doesn't work with {}.", p.name, if paths.len() == 1 { "this file".to_string() } else { format!("these {} files", paths.len()) }));
        return;
    }
    if let Err(e) = open(app, &p.tool, paths, Some(json!({ "run": true, "options": p.options, "title": p.name }))) {
        log::write(&format!("preset {id}: {e}"));
        hud::notice(app, "The preset couldn't run");
    }
}

/// Wheel entry point: `tool:<id>`. Instant tools (no window) run in a hidden window.
pub fn open_from_wheel(app: &AppHandle, id: &str, paths: Vec<String>, extra: Option<Value>) {
    if !TOOL_IDS.contains(&id) {
        hud::notice(app, "This tool is not available yet.");
        return;
    }
    if let Err(e) = open(app, id, paths, extra) {
        log::write(&format!("tool window {id}: {e}"));
        hud::notice(app, "The tool window couldn't open");
    }
}

fn urlencode(s: &str) -> String {
    let mut o = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

// ------------------------------------------------------------------ bridge channels

/// `orange.send` channels from tool windows that bridge.rs doesn't handle itself.
pub fn send(app: &AppHandle, window: &WebviewWindow, channel: &str, args: &[Value]) -> bool {
    match channel {
        "window:close" => {
            let _ = window.close();
            true
        }
        "tool:ready" => {
            show_ready(app, window.label());
            true
        }
        "tool:test" => {
            test_report(window.label(), args.first().cloned().unwrap_or(Value::Null));
            true
        }
        "tool:diag" => {
            test_state().lock().unwrap().insert(format!("{}:diag", window.label()), args.first().cloned().unwrap_or(Value::Null));
            true
        }
        "tool:job" => {
            test_jobs().lock().unwrap().entry(window.label().to_string()).or_default().push(args.first().cloned().unwrap_or(Value::Null));
            true
        }
        _ => false,
    }
}

/// `orange.invoke` channels the native side answers for tool windows. Everything else is handled
/// inside the page (web/tool/host).
pub fn invoke(app: &AppHandle, window: &WebviewWindow, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let s = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default().to_string();
    Some(match channel {
        "file:reveal" => {
            crate::win::reveal(&s(0));
            Ok(Value::Null)
        }
        "tool:open" => open(app, &s(0), args.get(1).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default(), args.get(2).cloned()).map(Value::from),
        "theme:dark" => Ok(json!(is_dark())),
        _ => {
            let _ = window;
            return None;
        }
    })
}

// ------------------------------------------------------------------ commands

#[derive(Deserialize)]
pub struct WindowOp {
    op: String,
}

/// Window chrome for the undecorated tool windows (the page draws the caption buttons).
#[tauri::command]
pub fn tools_window(window: WebviewWindow, op: WindowOp) -> Result<Value, String> {
    let r = match op.op.as_str() {
        "drag" => window.start_dragging(),
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "hide" => window.hide(),
        // Window closed while its job runs: out of sight, out of the taskbar, but still "shown"
        // (a hidden WebView2 page stops getting the pushes the job is waiting for).
        "park" => {
            let _ = window.set_skip_taskbar(true);
            window.set_position(tauri::PhysicalPosition::new(-32000, -32000))
        }
        "show" => window.show(),
        "close" => window.close(),
        "destroy" => window.destroy(),
        "focus" => window.set_focus(),
        "isMaximized" => return Ok(json!(window.is_maximized().unwrap_or(false))),
        o => return Err(format!("unknown window op {o}")),
    };
    r.map(|_| Value::Null).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct HudOp {
    op: String,
    #[serde(default)]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    progress: Option<f64>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    outputs: Vec<String>,
    #[serde(default)]
    errors: Vec<String>,
}

fn jobs() -> &'static Mutex<HashMap<u64, hud::Job>> {
    static J: OnceLock<Mutex<HashMap<u64, hud::Job>>> = OnceLock::new();
    J.get_or_init(Default::default)
}

/// Progress-panel rows for jobs that run in a tool window. `poll` returns whether the user pressed
/// Cancel on the row.
#[tauri::command]
pub async fn tools_hud(app: AppHandle, op: HudOp) -> Result<Value, String> {
    let take = |id| jobs().lock().unwrap().remove(&id);
    match op.op.as_str() {
        "start" => {
            let j = hud::start(&app, &op.title);
            let id = j.id;
            jobs().lock().unwrap().insert(id, j);
            Ok(json!(id))
        }
        "progress" => {
            if let Some(j) = jobs().lock().unwrap().get(&op.id) {
                j.progress(op.progress.unwrap_or(-1.0).max(0.0), op.note.as_deref());
            }
            Ok(Value::Null)
        }
        "poll" => Ok(json!(jobs().lock().unwrap().get(&op.id).is_some_and(|j| j.cancelled.load(Ordering::SeqCst)))),
        "done" => {
            if let Some(j) = take(op.id) {
                j.done(op.outputs, op.errors);
            }
            Ok(Value::Null)
        }
        "failed" => {
            if let Some(j) = take(op.id) {
                j.failed(op.note.as_deref().unwrap_or("Failed"));
            }
            Ok(Value::Null)
        }
        "cancelled" => {
            if let Some(j) = take(op.id) {
                j.cancelled();
            }
            Ok(Value::Null)
        }
        "notice" => {
            hud::notice(&app, &op.title);
            Ok(Value::Null)
        }
        o => Err(format!("unknown hud op {o}")),
    }
}

#[derive(Deserialize)]
pub struct DialogOp {
    op: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    filters: Vec<DialogFilter>,
    #[serde(default)]
    multi: Option<bool>,
}
#[derive(Deserialize)]
pub struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

#[tauri::command]
pub async fn tools_dialog(window: WebviewWindow, op: DialogOp) -> Result<Value, String> {
    let mut d = rfd::AsyncFileDialog::new().set_parent(&window);
    if let Some(t) = &op.title {
        d = d.set_title(t);
    }
    for f in &op.filters {
        d = d.add_filter(&f.name, &f.extensions);
    }
    let p = |f: rfd::FileHandle| f.path().to_string_lossy().into_owned();
    Ok(match op.op.as_str() {
        "folder" => json!(d.pick_folder().await.map(p)),
        _ if op.multi.unwrap_or(true) => json!(d.pick_files().await.unwrap_or_default().into_iter().map(p).collect::<Vec<_>>()),
        _ => json!(d.pick_file().await.map(p).into_iter().collect::<Vec<_>>()),
    })
}

/// Paths and machine facts the page-side Node shims need (os.tmpdir(), app.getPath(), cpus()...).
#[tauri::command]
pub fn tools_info(app: AppHandle) -> Value {
    let p = app.path();
    let s = |r: tauri::Result<PathBuf>| r.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    json!({
        "binDir": bin_dir().to_string_lossy(),
        "tmp": std::env::temp_dir().to_string_lossy(),
        "home": s(p.home_dir()),
        "userData": s(p.app_data_dir()),
        "localData": s(p.app_local_data_dir()),
        "cache": s(p.app_cache_dir()),
        "logs": s(p.app_log_dir()),
        "downloads": s(p.download_dir()),
        "documents": s(p.document_dir()),
        "desktop": s(p.desktop_dir()),
        "pictures": s(p.picture_dir()),
        "cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4),
        "version": app.package_info().version.to_string(),
        "pid": std::process::id(),
    })
}

// ------------------------------------------------------------------ bundled tools

/// Folder holding the bundled command-line tools (ffmpeg, ffprobe, 7z, gs, magick, pandoc).
/// Installed: <resources>/bin. From source: the nearest vendor/bin above the executable or the
/// working directory (a git worktree finds the main checkout's). `ORANGE_BIN_DIR` overrides.
pub fn bin_dir() -> PathBuf {
    static D: OnceLock<PathBuf> = OnceLock::new();
    D.get_or_init(|| {
        if let Ok(d) = std::env::var("ORANGE_BIN_DIR") {
            return PathBuf::from(d);
        }
        let mut starts = vec![];
        if let Ok(e) = std::env::current_exe() {
            if let Some(d) = e.parent() {
                starts.push(d.join("bin"));
                starts.push(d.join("resources").join("bin"));
                starts.extend(d.ancestors().map(|a| a.join("vendor").join("bin")));
            }
        }
        if let Ok(c) = std::env::current_dir() {
            starts.extend(c.ancestors().map(|a| a.join("vendor").join("bin")));
        }
        starts.into_iter().find(|d| d.join("7z.exe").exists() || d.join("ffmpeg.exe").exists() || d.join("ffmpeg.exe.zst").exists()).unwrap_or_else(|| PathBuf::from("bin"))
    })
    .clone()
}

/// Path of a tool in the local vendor folder ("ffmpeg", "gs/bin/gswin64c"). Tools not found there
/// come from engines::ensure (see tools_spawn).
pub fn bin(name: &str) -> PathBuf {
    let n = if name.ends_with(".exe") { name.to_string() } else { format!("{name}.exe") };
    bin_dir().join(n)
}

/// Ids whose kill arrived before their process was registered (a Cancel pressed right after the
/// start). Guarded by the same lock as the process table (`procs()`), so registering and killing
/// cannot miss each other.
fn pending_kills() -> &'static Mutex<std::collections::HashSet<u64>> {
    static P: OnceLock<Mutex<std::collections::HashSet<u64>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

fn procs() -> &'static Mutex<HashMap<u64, Arc<Mutex<Child>>>> {
    static P: OnceLock<Mutex<HashMap<u64, Arc<Mutex<Child>>>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOp {
    /// A bundled tool name ("ffmpeg") or an absolute path.
    exe: String,
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    /// stdin: a file to pipe in (large input), or base64 bytes. Neither: stdin is closed.
    #[serde(default)]
    stdin_file: Option<String>,
    #[serde(default)]
    stdin_b64: Option<String>,
    /// Caller's id for tools_kill.
    id: u64,
}

/// Runs a process to completion, streaming stdout/stderr as base64 chunks `["o"|"e", b64]`
/// through `on_data` (binary-safe: PCM, JPEG frames). Resolves `{code, killed}` whatever the exit
/// code; the page decides what counts as failure, as Node's child_process does.
#[tauri::command]
pub async fn tools_spawn(op: SpawnOp, on_data: Channel<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || spawn_blocking(op, on_data)).await.map_err(|e| e.to_string())?
}

fn spawn_blocking(op: SpawnOp, on_data: Channel<Value>) -> Result<Value, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe = if Path::new(&op.exe).is_absolute() {
        PathBuf::from(&op.exe)
    } else if bin(&op.exe).is_file() {
        bin(&op.exe)
    } else {
        // Not in a source checkout's vendor/bin: the converters' engine store (downloads on first use).
        crate::engines::ensure(&op.exe).map_err(|e| format!("spawn {} ENOENT ({e})", op.exe))?
    };
    let mut cmd = Command::new(&exe);
    cmd.args(&op.args).creation_flags(CREATE_NO_WINDOW).stdout(Stdio::piped()).stderr(Stdio::piped());
    let has_stdin = op.stdin_file.is_some() || op.stdin_b64.is_some();
    cmd.stdin(if has_stdin { Stdio::piped() } else { Stdio::null() });
    if let Some(c) = op.cwd.as_ref().filter(|c| !c.is_empty()) {
        cmd.current_dir(c);
    }
    for (k, v) in &op.env {
        cmd.env(k, v);
    }
    if exe.to_string_lossy().to_lowercase().contains("imagemagick") {
        if let Some(d) = exe.parent() {
            cmd.env("MAGICK_HOME", d);
        }
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("spawn {} ENOENT", exe.display())
        } else {
            format!("spawn {}: {e}", exe.display())
        }
    })?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let child = Arc::new(Mutex::new(child));
    {
        let mut table = procs().lock().unwrap();
        table.insert(op.id, child.clone());
        // Killed before it was registered: kill it now (its table entry stays, so the result says killed).
        if pending_kills().lock().unwrap().remove(&op.id) {
            table.remove(&op.id);
            let _ = child.lock().unwrap().kill();
        }
    }

    let feeder = std::thread::spawn({
        let file = op.stdin_file.clone();
        let b64 = op.stdin_b64.clone();
        move || {
            if let Some(mut w) = stdin {
                use std::io::Write;
                if let Some(f) = file {
                    if let Ok(mut r) = std::fs::File::open(f) {
                        let _ = std::io::copy(&mut r, &mut w);
                    }
                } else if let Some(b) = b64 {
                    let _ = w.write_all(&unbase64(&b));
                }
            }
        }
    });
    let ch = on_data.clone();
    let err_thread = std::thread::spawn(move || pump(stderr, "e", &ch));
    pump(stdout, "o", &on_data);
    let _ = err_thread.join();
    let _ = feeder.join();
    let status = loop {
        if let Some(s) = child.lock().unwrap().try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    let killed = procs().lock().unwrap().remove(&op.id).is_none();
    // Channel messages are ordered among themselves but not against this command's response, so
    // the page waits for this marker (after all output) as well as the response.
    let _ = on_data.send(json!(["x", ""]));
    Ok(json!({ "code": status.code().unwrap_or(-1), "killed": killed }))
}

/// Forwards a pipe in chunks until it closes.
fn pump(mut r: impl Read, tag: &str, ch: &Channel<Value>) {
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let _ = ch.send(json!([tag, crate::win::base64(&buf[..n])]));
            }
        }
    }
}

fn unbase64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter_map(val) {
        acc = (acc << 6) | c;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn engine_cancels() -> &'static Mutex<HashMap<u64, Arc<std::sync::atomic::AtomicBool>>> {
    static P: OnceLock<Mutex<HashMap<u64, Arc<std::sync::atomic::AtomicBool>>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// Downloadable runtime files the tool pages load from the engine store ("first use only").
const PAGE_ENGINES: &[&str] = &["ai-runtime", "mediapipe", "tesseract-eng"];

/// Whether a page engine is downloaded, and how big its download is.
#[tauri::command]
pub fn tools_engine_info(name: String) -> Result<Value, String> {
    if !PAGE_ENGINES.contains(&name.as_str()) {
        return Err(format!("unknown engine {name}"));
    }
    Ok(json!({ "ready": crate::engines::ready(&name), "bytes": crate::engines::download_bytes(&name) }))
}

/// Downloads a page engine if it isn't there (HUD row with Cancel, plus `[fraction, note]` on
/// `on_data` for the tool window). `id` lets the page cancel through `tools_kill`.
#[tauri::command]
pub async fn tools_engine(app: AppHandle, name: String, id: u64, on_data: Channel<Value>) -> Result<Value, String> {
    if !PAGE_ENGINES.contains(&name.as_str()) {
        return Err(format!("unknown engine {name}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if crate::engines::ready(&name) {
            return Ok(json!({ "downloaded": false }));
        }
        let title = format!("Downloading {} (first use)", crate::engines::label_of(&name));
        let job = hud::start(&app, &title);
        engine_cancels().lock().unwrap().insert(id, job.cancelled.clone());
        let r = crate::engines::ensure_with(
            &name,
            &|f, note| {
                job.progress(f, Some(note));
                let _ = on_data.send(json!([f, note]));
            },
            &job.cancelled,
        );
        engine_cancels().lock().unwrap().remove(&id);
        match r {
            Ok(_) => {
                job.done(vec![], vec![]);
                Ok(json!({ "downloaded": true }))
            }
            Err(m) if m == "Cancelled" => {
                job.cancelled();
                Err(m)
            }
            Err(m) => {
                job.failed(&m);
                Err(m)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn tools_kill(id: u64) {
    if let Some(c) = engine_cancels().lock().unwrap().remove(&id) {
        c.store(true, Ordering::SeqCst);
    }
    let mut table = procs().lock().unwrap();
    match table.remove(&id) {
        Some(c) => {
            let _ = c.lock().unwrap().kill();
        }
        // Not registered (yet): the spawner kills it as soon as it is.
        None => {
            pending_kills().lock().unwrap().insert(id);
        }
    }
}

// ------------------------------------------------------------------ ofs:// file protocol

fn cors(b: tauri::http::response::Builder) -> tauri::http::response::Builder {
    b.header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "*")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
}

fn query(uri: &tauri::http::Uri, key: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| urldecode(v))
    })
}

fn urldecode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_of(p: &str) -> &'static str {
    match Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg" | "jfif") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg" | "oga" | "opus") => "audio/ogg",
        Some("m4a" | "aac") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("txt" | "srt" | "vtt") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("js" | "mjs") => "text/javascript",
        _ => "application/octet-stream",
    }
}

/// Serves `http://ofs.localhost/...` (see the module comment).
pub fn protocol(req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = req.uri().clone();
    let err = |code: StatusCode, msg: String| cors(Response::builder()).status(code).header("Content-Type", "text/plain").body(msg.into_bytes()).unwrap();
    if req.method() == tauri::http::Method::OPTIONS {
        return cors(Response::builder()).status(204).body(vec![]).unwrap();
    }
    match uri.path() {
        "/f" => {
            let Some(p) = query(&uri, "p") else { return err(StatusCode::BAD_REQUEST, "no path".into()) };
            serve_file(&p, req.headers().get("range").and_then(|v| v.to_str().ok()))
                .unwrap_or_else(|e| err(if e.kind() == std::io::ErrorKind::NotFound { StatusCode::NOT_FOUND } else { StatusCode::INTERNAL_SERVER_ERROR }, e.to_string()))
        }
        p if p.starts_with("/engine/") => {
            // /engine/<id>/<file>: a downloaded page engine (ai-runtime, mediapipe), by name only.
            let mut it = p["/engine/".len()..].splitn(2, '/');
            let (id, file) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
            let ok = PAGE_ENGINES.contains(&id) && !file.is_empty() && !file.contains(['/', '\\', ':']) && file != "..";
            let dir = if ok && crate::engines::ready(id) { crate::engines::dir_of(id) } else { None };
            let Some(path) = dir.map(|d| d.join(file)) else { return err(StatusCode::NOT_FOUND, format!("{id} is not downloaded")) };
            serve_file(&path.to_string_lossy(), req.headers().get("range").and_then(|v| v.to_str().ok()))
                .unwrap_or_else(|e| err(if e.kind() == std::io::ErrorKind::NotFound { StatusCode::NOT_FOUND } else { StatusCode::INTERNAL_SERVER_ERROR }, e.to_string()))
        }
        "/write" => {
            let Some(p) = query(&uri, "p") else { return err(StatusCode::BAD_REQUEST, "no path".into()) };
            let append = query(&uri, "append").as_deref() == Some("1");
            let r = if append {
                use std::io::Write;
                std::fs::OpenOptions::new().create(true).append(true).open(&p).and_then(|mut f| f.write_all(req.body()))
            } else {
                std::fs::write(&p, req.body())
            };
            match r {
                Ok(()) => cors(Response::builder()).header("Content-Type", "application/json").body(b"{\"ok\":true}".to_vec()).unwrap(),
                Err(e) => fs_err_response(&e, &p),
            }
        }
        "/fs" => {
            let v: Value = serde_json::from_slice(req.body()).unwrap_or(Value::Null);
            let body = match fs_op(&v) {
                Ok(r) => json!({ "ok": true, "value": r }),
                Err(e) => json!({ "ok": false, "code": io_code(&e), "message": e.to_string() }),
            };
            cors(Response::builder()).header("Content-Type", "application/json").body(body.to_string().into_bytes()).unwrap()
        }
        other => err(StatusCode::NOT_FOUND, format!("no route {other}")),
    }
}

fn fs_err_response(e: &std::io::Error, p: &str) -> Response<Vec<u8>> {
    let body = json!({ "ok": false, "code": io_code(e), "message": format!("{e} '{p}'") });
    cors(Response::builder()).header("Content-Type", "application/json").body(body.to_string().into_bytes()).unwrap()
}

fn io_code(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => "ENOENT",
        PermissionDenied => "EPERM",
        AlreadyExists => "EEXIST",
        DirectoryNotEmpty => "ENOTEMPTY",
        IsADirectory => "EISDIR",
        NotADirectory => "ENOTDIR",
        StorageFull => "ENOSPC",
        ResourceBusy => "EBUSY",
        InvalidFilename => "ENAMETOOLONG",
        _ => match e.raw_os_error() {
            Some(32 | 33) => "EBUSY",
            Some(5) => "EPERM",
            Some(112) => "ENOSPC",
            Some(206) => "ENAMETOOLONG",
            _ => "EIO",
        },
    }
}

fn serve_file(p: &str, range: Option<&str>) -> std::io::Result<Response<Vec<u8>>> {
    let mut f = std::fs::File::open(p)?;
    let len = f.metadata()?.len();
    let b = cors(Response::builder()).header("Content-Type", mime_of(p)).header("Accept-Ranges", "bytes").header("Cache-Control", "no-store");
    if let Some(r) = range.and_then(|r| r.strip_prefix("bytes=")) {
        let (a, z) = r.split_once('-').unwrap_or((r, ""));
        let start: u64 = a.parse().unwrap_or(0);
        // Cap one answer at 4 MB so seeking in a large video doesn't read the whole file.
        let end: u64 = z.parse().unwrap_or(u64::MAX).min(len.saturating_sub(1)).min(start + 4 * 1024 * 1024 - 1);
        if start >= len {
            return Ok(b.status(416).header("Content-Range", format!("bytes */{len}")).body(vec![]).unwrap());
        }
        f.seek(SeekFrom::Start(start))?;
        let mut buf = vec![0u8; (end - start + 1) as usize];
        f.read_exact(&mut buf)?;
        return Ok(b.status(206).header("Content-Range", format!("bytes {start}-{end}/{len}")).body(buf).unwrap());
    }
    let mut buf = Vec::with_capacity(len as usize);
    f.read_to_end(&mut buf)?;
    Ok(b.status(200).body(buf).unwrap())
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> f64 {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn stat_json(m: &std::fs::Metadata) -> Value {
    use std::os::windows::fs::MetadataExt;
    json!({
        "size": m.len(),
        "isFile": m.is_file(),
        "isDirectory": m.is_dir(),
        "isSymbolicLink": m.file_type().is_symlink(),
        "mtimeMs": ms(m.modified()),
        "atimeMs": ms(m.accessed()),
        "birthtimeMs": ms(m.created()),
        "readonly": m.permissions().readonly(),
        "attributes": m.file_attributes(),
    })
}

fn tmp_name(prefix: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    PathBuf::from(format!("{prefix}{:x}{:x}{n}", std::process::id(), t % 0xffffff))
}

/// One filesystem op for the page's `fs` shim.
fn fs_op(v: &Value) -> std::io::Result<Value> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    let p = s("p");
    Ok(match s("op").as_str() {
        "stat" => stat_json(&std::fs::metadata(&p)?),
        "lstat" => stat_json(&std::fs::symlink_metadata(&p)?),
        "exists" => json!(Path::new(&p).exists()),
        "readdir" => {
            let mut out = vec![];
            for e in std::fs::read_dir(&p)? {
                let e = e?;
                let ft = e.file_type()?;
                out.push(json!({ "name": e.file_name().to_string_lossy(), "dir": ft.is_dir(), "file": ft.is_file(), "link": ft.is_symlink() }));
            }
            json!(out)
        }
        "mkdir" => {
            if flag("recursive") {
                std::fs::create_dir_all(&p)?;
            } else {
                std::fs::create_dir(&p)?;
            }
            Value::Null
        }
        "rm" => {
            let path = Path::new(&p);
            let r = match std::fs::symlink_metadata(path) {
                Ok(m) if m.is_dir() => {
                    if flag("recursive") {
                        std::fs::remove_dir_all(path)
                    } else {
                        std::fs::remove_dir(path)
                    }
                }
                Ok(_) => std::fs::remove_file(path),
                Err(e) => Err(e),
            };
            match r {
                Err(e) if flag("force") && e.kind() == std::io::ErrorKind::NotFound => {}
                r => r?,
            }
            Value::Null
        }
        "rename" => {
            std::fs::rename(&p, s("to"))?;
            Value::Null
        }
        "copy" => {
            std::fs::copy(&p, s("to"))?;
            Value::Null
        }
        "mkdtemp" => {
            let d = tmp_name(&p);
            std::fs::create_dir_all(&d)?;
            json!(d.to_string_lossy())
        }
        "realpath" => json!(dunce_canon(&std::fs::canonicalize(&p)?)),
        "readText" => json!(String::from_utf8_lossy(&std::fs::read(&p)?)),
        "writeText" => {
            if flag("append") {
                use std::io::Write;
                std::fs::OpenOptions::new().create(true).append(true).open(&p)?.write_all(s("data").as_bytes())?;
            } else {
                std::fs::write(&p, s("data"))?;
            }
            Value::Null
        }
        "utimes" => {
            let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs_f64(v.get("mtime").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0);
            let f = std::fs::File::options().write(true).open(&p)?;
            f.set_modified(t)?;
            Value::Null
        }
        "truncate" => {
            std::fs::File::options().write(true).open(&p)?.set_len(v.get("len").and_then(Value::as_u64).unwrap_or(0))?;
            Value::Null
        }
        "readSlice" => {
            // Bytes [start, start+len) as base64 (small reads: headers, PDF ranges).
            let mut f = std::fs::File::open(&p)?;
            let start = v.get("start").and_then(Value::as_u64).unwrap_or(0);
            let len = v.get("len").and_then(Value::as_u64).unwrap_or(0) as usize;
            f.seek(SeekFrom::Start(start))?;
            let mut buf = vec![0u8; len];
            let mut got = 0;
            while got < len {
                let n = f.read(&mut buf[got..])?;
                if n == 0 {
                    break;
                }
                got += n;
            }
            buf.truncate(got);
            json!(crate::win::base64(&buf))
        }
        "recycle" => {
            recycle(&p)?;
            Value::Null
        }
        o => return Err(std::io::Error::other(format!("unknown fs op {o}"))),
    })
}

fn dunce_canon(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Moves a file to the Recycle Bin.
fn recycle(p: &str) -> std::io::Result<()> {
    use windows::Win32::UI::Shell::*;
    let mut from: Vec<u16> = p.encode_utf16().collect();
    from.extend([0, 0]);
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: windows::core::PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        ..Default::default()
    };
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 {
        return Err(std::io::Error::other(format!("recycle failed ({r})")));
    }
    Ok(())
}

// ------------------------------------------------------------------ off-screen test runs

/// `ORANGE_TOOL_TEST=<cases.json>`: opens each case's tool window off-screen, runs its script in the
/// page (synthetic events only: clicks, input and key events dispatched to the DOM), waits for the
/// job's HUD row to finish, and writes results to `ORANGE_TOOL_TEST_OUT` (or <cases>.out.json).
/// A case: `{ "tool": "cropImage", "paths": [...], "script": "<js>", "timeout": 60, "expectJob": true }`.
/// The script is an async function body; it can `return` a value (recorded) and use `$(sel)`,
/// `click(sel)`, `setValue(sel, v)`, `key(k, opts)`, `wait(ms)`, `until(fn, ms)`.
pub fn maybe_test(app: &AppHandle) {
    let Ok(file) = std::env::var("ORANGE_TOOL_TEST") else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let out = std::env::var("ORANGE_TOOL_TEST_OUT").unwrap_or_else(|_| format!("{file}.out.json"));
        let cases: Vec<Value> = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let mut results = vec![];
        for case in cases {
            let r = run_case(&app, &case);
            log::write(&format!("tool test {}: ok={}", case["tool"], r["ok"]));
            results.push(r);
            let _ = std::fs::write(&out, serde_json::to_string_pretty(&results).unwrap_or_default());
        }
        let _ = std::fs::write(&out, serde_json::to_string_pretty(&results).unwrap_or_default());
        if std::env::var("ORANGE_TOOL_TEST_EXIT").as_deref() == Ok("1") {
            app.exit(0);
        }
    });
}

fn test_state() -> &'static Mutex<HashMap<String, Value>> {
    static S: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// `tool:test` from a page under test: its script's result.
pub fn test_report(label: &str, v: Value) {
    test_state().lock().unwrap().insert(label.to_string(), v);
}

const TEST_PRELUDE: &str = r#"
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await wait(50); } throw new Error('timeout waiting for ' + f); };
  const click = (s) => { const el = typeof s === 'string' ? $(s) : s; if (!el) throw new Error('no element ' + s); for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, { bubbles: true, button: 0 })); el.click(); return el; };
  const setValue = (s, v) => { const el = typeof s === 'string' ? $(s) : s; if (!el) throw new Error('no element ' + s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el; };
  const key = (k, o = {}) => { const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o })); t.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, ...o })); };
  const byText = (sel, text) => $$(sel).find((e) => e.textContent.trim() === text);
"#;

fn run_case(app: &AppHandle, case: &Value) -> Value {
    use std::time::{Duration, Instant};
    let tool = case["tool"].as_str().unwrap_or_default().to_string();
    let paths: Vec<String> = serde_json::from_value(case["paths"].clone()).unwrap_or_default();
    let timeout = Duration::from_secs(case["timeout"].as_u64().unwrap_or(90));
    let expect_job = case["expectJob"].as_bool().unwrap_or(true);
    let finished_before = { let st = app.state::<crate::AppState>(); let n = st.hud.finished.lock().unwrap().len(); n };
    let started = Instant::now();
    let label = match open(app, &tool, paths, Some({ let mut x = case["extra"].clone(); if !x.is_object() { x = json!({}); } x["offscreen"] = json!(true); x })) {
        Ok(l) => l,
        Err(e) => return json!({ "tool": tool, "ok": false, "error": format!("open: {e}") }),
    };
    let mut shown = false;
    let instant = tool == "extractArchive" || case["extra"]["run"].as_bool().unwrap_or(false);
    while !instant && started.elapsed() < Duration::from_secs(30) {
        match app.get_webview_window(&label) {
            Some(w) if w.is_visible().unwrap_or(false) => {
                shown = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let open_ms = started.elapsed().as_millis();
    let script = case["script"].as_str().unwrap_or("").to_string();
    let wrapped = format!(
        "(async () => {{ {TEST_PRELUDE}\n let result, error = null;\n try {{ result = await (async () => {{ {script}\n }})(); }} catch (e) {{ error = String(e && e.stack || e); }}\n window.__TAURI__.core.invoke('bridge_send', {{ channel: 'tool:test', args: [{{ result: result === undefined ? null : result, error, errors: window.__testErrors || [], title: document.title, body: document.body.innerText.slice(0, 300) }}] }});\n}})();"
    );
    let mut page = Value::Null;
    if !instant {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.eval("window.__testErrors=window.__testErrors||[];addEventListener('error',e=>__testErrors.push(String((e.error&&e.error.stack)||e.message).slice(0,600)));addEventListener('unhandledrejection',e=>__testErrors.push(String(e.reason&&e.reason.message||e.reason)));");
            let _ = w.eval(&wrapped);
            while started.elapsed() < timeout {
                if let Some(v) = test_state().lock().unwrap().remove(&label) {
                    page = v;
                    break;
                }
                if app.get_webview_window(&label).is_none() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let mut job = Value::Null;
    if expect_job {
        while started.elapsed() < timeout {
            {
                let state = app.state::<crate::AppState>();
                let fin = state.hud.finished.lock().unwrap();
                if let Some(r) = fin.iter().skip(finished_before).find(|r| !r.title.starts_with("Downloading")) {
                    job = serde_json::to_value(r).unwrap_or_default();
                }
            }
            if !job.is_null() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let t = Instant::now();
    while app.get_webview_window(&label).is_some() && t.elapsed() < Duration::from_secs(if expect_job { 5 } else { 0 }) {
        std::thread::sleep(Duration::from_millis(50));
    }
    let closed = app.get_webview_window(&label).is_none();
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
    }
    let outputs_ok = job["outputs"].as_array().is_some_and(|o| !o.is_empty() && o.iter().all(|p| p.as_str().is_some_and(|p| Path::new(p).exists())));
    let ok = (shown || instant) && page["error"].is_null() && (!expect_job || (job["state"] == "done" && outputs_ok));
    json!({ "tool": tool, "ok": ok, "shown": shown, "openMs": open_ms, "ms": started.elapsed().as_millis(), "page": page, "job": job, "closed": closed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_coding_round_trips() {
        let s = r"C:\Users\a b\é&=+%.png";
        assert_eq!(urldecode(&urlencode(s)), s);
        assert_eq!(urldecode("a%20b+c"), "a b c");
    }

    #[test]
    fn base64_round_trips() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foobar", &[0u8, 255, 128, 7, 9]] {
            assert_eq!(unbase64(&crate::win::base64(data)), data);
        }
    }

    #[test]
    fn fs_ops_work_like_node() {
        let dir = std::env::temp_dir().join(format!("orange-tools-test-{}", std::process::id()));
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        fs_op(&json!({ "op": "mkdir", "p": dir.to_string_lossy(), "recursive": true })).unwrap();
        fs_op(&json!({ "op": "writeText", "p": p("a.txt"), "data": "héllo" })).unwrap();
        assert_eq!(fs_op(&json!({ "op": "readText", "p": p("a.txt") })).unwrap(), json!("héllo"));
        assert_eq!(fs_op(&json!({ "op": "stat", "p": p("a.txt") })).unwrap()["size"], json!(6));
        fs_op(&json!({ "op": "rename", "p": p("a.txt"), "to": p("b.txt") })).unwrap();
        assert_eq!(fs_op(&json!({ "op": "exists", "p": p("a.txt") })).unwrap(), json!(false));
        let list = fs_op(&json!({ "op": "readdir", "p": dir.to_string_lossy() })).unwrap();
        assert_eq!(list[0]["name"], json!("b.txt"));
        let e = fs_op(&json!({ "op": "stat", "p": p("missing") })).unwrap_err();
        assert_eq!(io_code(&e), "ENOENT");
        fs_op(&json!({ "op": "rm", "p": dir.to_string_lossy(), "recursive": true, "force": true })).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn protocol_serves_ranges() {
        let f = std::env::temp_dir().join(format!("orange-range-{}.bin", std::process::id()));
        std::fs::write(&f, (0u8..=255).collect::<Vec<_>>()).unwrap();
        let r = serve_file(&f.to_string_lossy(), Some("bytes=10-19")).unwrap();
        assert_eq!(r.status(), 206);
        assert_eq!(r.body().as_slice(), &(10u8..=19).collect::<Vec<_>>()[..]);
        let all = serve_file(&f.to_string_lossy(), None).unwrap();
        assert_eq!(all.body().len(), 256);
        let _ = std::fs::remove_file(f);
    }
}


// ------------------------------------------------------------------ test server

/// `ORANGE_TOOL_TEST_DIR=<dir>`: the app serves test requests instead of running as a tray app
/// (src-tauri/tests/common/toolapp.rs is the client). No tray, hooks, wheel, shortcuts or updater;
/// every window is off-screen and shows no progress panel; synthetic DOM events only.
pub fn test_mode() -> bool {
    std::env::var_os("ORANGE_TOOL_TEST_DIR").is_some()
}

/// A test app never uses the installed app's identity: its single-instance lock, profile and
/// settings. The identifier is replaced before the app is built (`ORANGE_TEST_IDENTIFIER`, default
/// the dev identifier), and the production one is refused.
pub fn test_identity(cfg: &mut tauri::Config) {
    if !test_mode() && std::env::var_os("ORANGE_TOOL_TEST").is_none() {
        return;
    }
    let id = std::env::var("ORANGE_TEST_IDENTIFIER").unwrap_or_else(|_| "app.orange.converter.dev".into());
    if id == "app.orange.converter" {
        eprintln!("orange: refusing to run a test app with the installed app's identifier");
        std::process::exit(3);
    }
    cfg.identifier = id;
}

fn pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code).is_ok();
        let _ = CloseHandle(h);
        ok && code == 259 // STILL_ACTIVE
    }
}

fn test_jobs() -> &'static Mutex<HashMap<String, Vec<Value>>> {
    static S: OnceLock<Mutex<HashMap<String, Vec<Value>>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Serves `<dir>/<id>.req.json` -> `<dir>/<id>.res.json` until `<dir>/quit` appears or the parent
/// process (`ORANGE_TOOL_TEST_PARENT`, a pid) is gone. Requests run concurrently, each in its own window:
///
/// - `{"kind":"steps","tools":[ids],"steps":[{"run":{"tool","paths","options"}} | {"invoke":[channel,...args]}]}`
///   runs jobs through the page's own `tool:run` in a blank window (what every tool page calls);
/// - `{"kind":"page","tool":id,"paths":[...],"script":js,"jobs":n}` opens the real tool page and runs
///   `script` in it (clicks, typing) until `n` jobs have finished;
/// - `{"kind":"wheel","item":"tool:compress","paths":[...],"script":js,"jobs":n}` does the same
///   after choosing the item like the Tools wheel does (`jobs::run_choice`).
///
/// A response is `{ok, error, result, jobs:[{tool,state,outputs,message}], closed, ms, pageErrors}`.
pub fn start_test_server(app: &AppHandle) {
    let Some(dir) = std::env::var_os("ORANGE_TOOL_TEST_DIR").map(PathBuf::from) else { return };
    let parent: Option<u32> = std::env::var("ORANGE_TOOL_TEST_PARENT").ok().and_then(|p| p.parse().ok());
    let app = app.clone();
    std::thread::Builder::new()
        .name("orange-test-server".into())
        .spawn(move || {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("ready"), std::process::id().to_string());
            loop {
                if dir.join("quit").exists() || parent.is_some_and(|p| !pid_alive(p)) {
                    app.exit(0);
                    return;
                }
                for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let Some(id) = name.strip_suffix(".req.json") else { continue };
                    let claimed = dir.join(format!("{id}.run.json"));
                    if std::fs::rename(e.path(), &claimed).is_err() {
                        continue;
                    }
                    let req: Value = std::fs::read_to_string(&claimed).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
                    let (app, dir, id) = (app.clone(), dir.clone(), id.to_string());
                    std::thread::spawn(move || {
                        let res = run_request(&app, &req);
                        let tmp = dir.join(format!("{id}.res.tmp"));
                        let _ = std::fs::write(&tmp, res.to_string());
                        let _ = std::fs::rename(&tmp, dir.join(format!("{id}.res.json")));
                        let _ = std::fs::remove_file(dir.join(format!("{id}.run.json")));
                    });
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
        })
        .expect("test server thread");
}

fn run_request(app: &AppHandle, req: &Value) -> Value {
    use std::time::{Duration, Instant};
    let started = Instant::now();
    let timeout = Duration::from_secs(req["timeout"].as_u64().unwrap_or(120));
    let fail = |msg: String| json!({ "ok": false, "error": msg, "ms": started.elapsed().as_millis() as u64 });
    let kind = req["kind"].as_str().unwrap_or("steps");
    let paths: Vec<String> = serde_json::from_value(req["paths"].clone()).unwrap_or_default();
    let steps = req["steps"].as_array().cloned().unwrap_or_default();
    let want_jobs = req["jobs"].as_u64().map(|n| n as usize).unwrap_or(if kind == "steps" { steps.iter().filter(|s| s.get("run").is_some()).count() } else { 1 });

    let label = match kind {
        "steps" => open(app, "_test", vec![], Some(json!({ "tools": req["tools"] }))),
        "page" => open(app, req["tool"].as_str().unwrap_or_default(), paths, None),
        "wheel" => {
            // The wheel choice opens its window on this thread, synchronously.
            OPENED.with(|o| o.borrow_mut().take());
            crate::jobs::run_choice(app, req["item"].as_str().unwrap_or_default().to_string(), paths);
            OPENED.with(|o| o.borrow_mut().take()).ok_or_else(|| "the wheel choice opened no window".to_string())
        }
        k => Err(format!("unknown request kind {k}")),
    };
    let label = match label {
        Ok(l) => l,
        Err(e) => return fail(e),
    };

    // Wait for the page to build itself (it shows itself on tool:ready).
    let mut shown = false;
    while started.elapsed() < Duration::from_secs(60) {
        match app.get_webview_window(&label) {
            Some(w) if w.is_visible().unwrap_or(false) => {
                shown = true;
                break;
            }
            Some(_) => {}
            None => break,
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !shown {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
        return fail(format!("{label} never showed its page"));
    }

    let script = if kind == "steps" {
        format!(
            r#"const STEPS = {steps};
const results = [];
for (const s of STEPS) {{
  if (s.run) {{
    const running = window.orange.invoke('tool:run', s.run.tool, s.run.paths, s.run.options);
    if (s.run.cancelAfterMs) {{ await wait(s.run.cancelAfterMs); window.__cancelJobs && window.__cancelJobs(); }}
    results.push({{ outputs: await running }});
  }} else {{
    try {{ results.push({{ value: await window.orange.invoke(...s.invoke) }}); }} catch (e) {{ results.push({{ error: String(e && e.message || e) }}); }}
  }}
}}
return results;"#,
            steps = Value::Array(steps)
        )
    } else {
        req["script"].as_str().unwrap_or("").to_string()
    };
    let wrapped = format!(
        "(async () => {{ {TEST_PRELUDE}\n let result, error = null;\n try {{ result = await (async () => {{ {script}\n }})(); }} catch (e) {{ error = String(e && e.stack || e); }}\n window.__TAURI__.core.invoke('bridge_send', {{ channel: 'tool:test', args: [{{ result: result === undefined ? null : result, error, errors: window.__testErrors || [] }}] }});\n}})();"
    );
    test_state().lock().unwrap().remove(&label);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.eval("window.__testErrors=window.__testErrors||[];addEventListener('error',e=>__testErrors.push(String((e.error&&e.error.stack)||e.message).slice(0,600)));addEventListener('unhandledrejection',e=>__testErrors.push(String(e.reason&&e.reason.stack||e.reason).slice(0,600)));");
        let _ = w.eval(&wrapped);
    }

    // The script's report, then the jobs it started (a page job outlives the click that started it).
    let mut page = Value::Null;
    let mut jobs: Vec<Value> = vec![];
    while started.elapsed() < timeout {
        if page.is_null() {
            if let Some(v) = test_state().lock().unwrap().remove(&label) {
                page = v;
            }
        }
        jobs = test_jobs().lock().unwrap().get(&label).cloned().unwrap_or_default();
        let script_failed = !page.is_null() && !page["error"].is_null();
        if script_failed || (!page.is_null() && jobs.len() >= want_jobs) {
            break;
        }
        // A page that closed itself (after its job) may have lost the report.
        if app.get_webview_window(&label).is_none() && jobs.len() >= want_jobs {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let timed_out = (page.is_null() && kind == "steps") || jobs.len() < want_jobs;
    // A window that ran its job closes itself (page and wheel kinds); give it a moment.
    let mut closed = app.get_webview_window(&label).is_none();
    if kind != "steps" && !closed {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(if timed_out { 0 } else { 10 }) {
            if app.get_webview_window(&label).is_none() {
                closed = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
    }
    test_jobs().lock().unwrap().remove(&label);
    let error = if timed_out {
        // Is the page alive, and what was it doing? (A blocked page cannot answer.)
        let mut diag = Value::String("no answer: the page is blocked or gone".into());
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.eval("window.__TAURI__.core.invoke('bridge_send',{channel:'tool:diag',args:[{active:(window.__activeJobs||(()=>-1))(),jobs:window.__orangeJobs||[],errors:window.__testErrors||[]}]})");
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs(5) {
                if let Some(v) = test_state().lock().unwrap().remove(&format!("{label}:diag")) {
                    diag = v;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let procs: Vec<u64> = procs().lock().unwrap().keys().cloned().collect();
        Value::String(format!("timed out after {} s (page: {}, jobs: {}/{want_jobs}, diag: {diag}, registered processes: {procs:?})", timeout.as_secs(), page, jobs.len()))
    } else {
        page["error"].clone()
    };
    json!({
        "ok": error.is_null(),
        "error": error,
        "result": page["result"],
        "pageErrors": page["errors"],
        "jobs": jobs,
        "closed": closed,
        "label": label,
        "ms": started.elapsed().as_millis() as u64,
    })
}
