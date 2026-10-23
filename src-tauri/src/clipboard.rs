//! The clipboard: low-level read/write (files as CF_HDROP, text, images), the popover a global
//! hotkey opens near the pointer to save what's on the clipboard in another format, and a full
//! snapshot/restore of the user's clipboard.

use crate::{bridge, hud, log, wheel, win};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use windows::core::HSTRING;
use windows::Win32::Foundation::*;
use windows::Win32::System::DataExchange::*;
use windows::Win32::System::Memory::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::*;

const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;

// ------------------------------------------------------------------ low level

/// The clipboard, open. Other apps hold it briefly all the time, so opening retries for ~1 s.
struct Open;

impl Open {
    fn new() -> Result<Open, String> {
        for _ in 0..50 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Ok(Open);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err("The clipboard is busy in another app".into())
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

fn format_id(name: &str) -> u32 {
    unsafe { RegisterClipboardFormatW(&HSTRING::from(name)) }
}

/// A copy of one clipboard format's bytes (only formats held in global memory).
unsafe fn get_bytes(fmt: u32) -> Option<Vec<u8>> {
    let h = GetClipboardData(fmt).ok()?;
    let g = HGLOBAL(h.0);
    let size = GlobalSize(g);
    let p = GlobalLock(g) as *const u8;
    if p.is_null() {
        return None;
    }
    let v = std::slice::from_raw_parts(p, size).to_vec();
    let _ = GlobalUnlock(g);
    Some(v)
}

unsafe fn set_bytes(fmt: u32, data: &[u8]) -> Result<(), String> {
    let g = GlobalAlloc(GMEM_MOVEABLE, data.len().max(1)).map_err(|e| e.message())?;
    let p = GlobalLock(g) as *mut u8;
    if p.is_null() {
        let _ = GlobalFree(Some(g));
        return Err("out of memory".into());
    }
    std::ptr::copy_nonoverlapping(data.as_ptr(), p, data.len());
    let _ = GlobalUnlock(g);
    if let Err(e) = SetClipboardData(fmt, Some(HANDLE(g.0))) {
        let _ = GlobalFree(Some(g));
        return Err(e.message());
    }
    Ok(())
}

fn wide_z(s: &str) -> Vec<u8> {
    s.encode_utf16().chain(std::iter::once(0)).flat_map(u16::to_le_bytes).collect()
}

/// Puts plain text on the clipboard.
pub fn put_text(text: &str) -> Result<(), String> {
    let _open = Open::new()?;
    unsafe {
        EmptyClipboard().map_err(|e| e.message())?;
        set_bytes(CF_UNICODETEXT, &wide_z(text))
    }
}

/// Puts files on the clipboard as Explorer does for Ctrl+C: CF_HDROP plus a "Preferred
/// DropEffect" of copy, so pasting duplicates them rather than moving them.
pub fn put_files(paths: &[String]) -> Result<(), String> {
    let buf = hdrop_bytes(paths);
    let _open = Open::new()?;
    unsafe {
        EmptyClipboard().map_err(|e| e.message())?;
        set_bytes(CF_HDROP, &buf)?;
        // DROPEFFECT_COPY | DROPEFFECT_LINK, as 1.x (and Explorer's Copy) set.
        set_bytes(format_id("Preferred DropEffect"), &5u32.to_le_bytes())
    }
}

/// A CF_HDROP block (DROPFILES header plus the double-NUL-terminated wide path list).
pub fn hdrop_bytes(paths: &[String]) -> Vec<u8> {
    // DROPFILES: pFiles, pt.x, pt.y, fNC, fWide; then the double-NUL-terminated wide list.
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(&20u32.to_le_bytes());
    buf.extend_from_slice(&0i32.to_le_bytes());
    buf.extend_from_slice(&0i32.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(&1u32.to_le_bytes());
    for p in paths {
        buf.extend(wide_z(p));
    }
    buf.extend_from_slice(&[0, 0]);
    buf
}

/// Puts a PNG on the clipboard (as "PNG" for modern apps and as a DIB for everything else).
pub fn put_png(png: &[u8]) -> Result<(), String> {
    let img = image::load_from_memory(png).map_err(|e| e.to_string())?.to_rgba8();
    let dib = rgba_to_dib(&img);
    let _open = Open::new()?;
    unsafe {
        EmptyClipboard().map_err(|e| e.message())?;
        set_bytes(format_id("PNG"), png)?;
        set_bytes(CF_DIB, &dib)
    }
}

/// Everything the user had on the clipboard, to put back afterwards (the self-check uses this so it
/// never loses what the user copied).
pub struct Saved(Vec<(u32, Vec<u8>)>);

impl Saved {
    pub fn take() -> Result<Saved, String> {
        let _open = Open::new()?;
        let mut out = Vec::new();
        unsafe {
            let mut f = EnumClipboardFormats(0);
            while f != 0 {
                // GDI-handle formats aren't global memory; Windows re-synthesises them from the DIB.
                const GDI: [u32; 6] = [2, 3, 9, 14, 0x82, 0x8E];
                if !GDI.contains(&f) {
                    if let Some(b) = get_bytes(f) {
                        out.push((f, b));
                    }
                }
                f = EnumClipboardFormats(f);
            }
        }
        Ok(Saved(out))
    }
    pub fn restore(&self) -> Result<(), String> {
        let _open = Open::new()?;
        unsafe {
            EmptyClipboard().map_err(|e| e.message())?;
            for (f, b) in &self.0 {
                let _ = set_bytes(*f, b);
            }
        }
        Ok(())
    }
    pub fn formats(&self) -> usize {
        self.0.len()
    }
}

// --------------------------------------------------------------------- reading

#[derive(Default)]
pub struct Snapshot {
    pub files: Vec<String>,
    pub image: Option<image::RgbaImage>,
    pub png: Option<Vec<u8>>,
    pub text: String,
    pub html: String,
}

pub fn snapshot() -> Snapshot {
    let mut s = Snapshot::default();
    let Ok(_open) = Open::new() else { return s };
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP).is_ok() {
            if let Ok(h) = GetClipboardData(CF_HDROP) {
                let hd = HDROP(h.0);
                let n = DragQueryFileW(hd, u32::MAX, None);
                for i in 0..n {
                    let len = DragQueryFileW(hd, i, None) as usize;
                    let mut buf = vec![0u16; len + 1];
                    DragQueryFileW(hd, i, Some(&mut buf));
                    let p = String::from_utf16_lossy(&buf[..len]);
                    if Path::new(&p).exists() {
                        s.files.push(p);
                    }
                }
            }
        }
        let png_fmt = format_id("PNG");
        if let Some(b) = get_bytes(png_fmt) {
            if let Ok(img) = image::load_from_memory(&b) {
                s.image = Some(img.to_rgba8());
                s.png = Some(b);
            }
        }
        if s.image.is_none() {
            for f in [CF_DIBV5, CF_DIB] {
                if let Some(b) = get_bytes(f) {
                    if let Some(img) = dib_to_rgba(&b) {
                        s.image = Some(img);
                        break;
                    }
                }
            }
        }
        if let Some(b) = get_bytes(CF_UNICODETEXT) {
            let w: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&c| c != 0).collect();
            s.text = String::from_utf16_lossy(&w);
        }
        if let Some(b) = get_bytes(format_id("HTML Format")) {
            s.html = cf_html_fragment(&String::from_utf8_lossy(&b));
        }
    }
    s
}

/// The HTML in a CF_HTML block: the fragment if marked, else the whole document.
fn cf_html_fragment(raw: &str) -> String {
    let raw = raw.trim_end_matches('\0');
    let num = |key: &str| raw.find(key).and_then(|i| raw[i + key.len()..].split(|c: char| !c.is_ascii_digit()).next()?.parse::<usize>().ok());
    let bytes = raw.as_bytes();
    let slice = |a: usize, b: usize| (a <= b && b <= bytes.len()).then(|| String::from_utf8_lossy(&bytes[a..b]).into_owned());
    if let (Some(a), Some(b)) = (num("StartFragment:"), num("EndFragment:")) {
        if let Some(s) = slice(a, b) {
            return s;
        }
    }
    if let (Some(a), Some(b)) = (num("StartHTML:"), num("EndHTML:")) {
        if let Some(s) = slice(a, b) {
            return s;
        }
    }
    raw.find('<').map(|i| raw[i..].to_string()).unwrap_or_default()
}

/// A packed DIB (BITMAPINFOHEADER or V5, 24/32 bpp) to RGBA.
pub fn dib_to_rgba(b: &[u8]) -> Option<image::RgbaImage> {
    let rd32 = |o: usize| b.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()));
    let hsize = rd32(0)? as usize;
    let w = rd32(4)? as i32;
    let h = rd32(8)? as i32;
    let bpp = u16::from_le_bytes(b.get(14..16)?.try_into().ok()?);
    let comp = rd32(16)?;
    let used = rd32(32)? as usize;
    if w <= 0 || h == 0 || !(bpp == 24 || bpp == 32) || !(comp == 0 || comp == 3) {
        return None;
    }
    // BI_BITFIELDS with a plain 40-byte header has three masks after it.
    let masks = if comp == 3 && hsize == 40 { 12 } else { 0 };
    let palette = used * 4;
    let off = hsize + masks + palette;
    let (w, ah) = (w as usize, h.unsigned_abs() as usize);
    let stride = (w * bpp as usize / 8).div_ceil(4) * 4;
    if b.len() < off + stride * ah {
        return None;
    }
    let mut img = image::RgbaImage::new(w as u32, ah as u32);
    let mut any_alpha = false;
    for y in 0..ah {
        let src_y = if h > 0 { ah - 1 - y } else { y };
        let row = &b[off + src_y * stride..];
        for x in 0..w {
            let px = if bpp == 32 {
                let p = &row[x * 4..x * 4 + 4];
                any_alpha |= p[3] != 0;
                [p[2], p[1], p[0], p[3]]
            } else {
                let p = &row[x * 3..x * 3 + 3];
                [p[2], p[1], p[0], 255]
            };
            img.put_pixel(x as u32, y as u32, image::Rgba(px));
        }
    }
    // 32-bit DIBs from older apps leave alpha at zero: those are opaque.
    if bpp == 32 && !any_alpha {
        for p in img.pixels_mut() {
            p.0[3] = 255;
        }
    }
    Some(img)
}

fn rgba_to_dib(img: &image::RgbaImage) -> Vec<u8> {
    let (w, h) = img.dimensions();
    let mut b = Vec::with_capacity(40 + (w * h * 4) as usize);
    for v in [40u32, w, (-(h as i32)) as u32] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&32u16.to_le_bytes());
    b.extend_from_slice(&[0u8; 24]); // BI_RGB, sizes, resolution, palette counts
    for p in img.pixels() {
        b.extend_from_slice(&[p.0[2], p.0[1], p.0[0], p.0[3]]);
    }
    b
}

pub fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Skip script and style bodies entirely.
            for tag in ["script", "style"] {
                if lower[i + 1..].starts_with(tag) {
                    if let Some(end) = lower[i..].find(&format!("</{tag}")) {
                        i += end;
                    }
                }
            }
            match html[i..].find('>') {
                Some(j) => i += j + 1,
                None => break,
            }
            out.push(' ');
        } else {
            let next = html[i..].find('<').map(|j| i + j).unwrap_or(bytes.len());
            out.push_str(&html[i..next]);
            i = next;
        }
    }
    out.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn looks_like_markdown(t: &str) -> bool {
    t.lines().any(|l| {
        let l2 = l.trim_start();
        l.starts_with('#') && l.trim_start_matches('#').starts_with(' ')
            || ["- ", "* ", "+ ", "> ", "```"].iter().any(|p| l2.starts_with(p))
            || l2.split_once(". ").is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
    }) || t.contains("**")
        || (t.contains("](") && t.contains('['))
}

// ---------------------------------------------------------------------- popover

const LABEL: &str = "clipboard";
const W: f64 = 344.0;

#[derive(Serialize, Clone, Default)]
pub struct ClipContent {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chars: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<bool>,
    #[serde(rename = "saveTo")]
    pub save_to: String,
}

struct Pop {
    current: Mutex<Option<ClipContent>>,
    anchor: Mutex<POINT>,
    shown_at: Mutex<Option<Instant>>,
    visible: AtomicBool,
    page_ready: AtomicBool,
    save_dir: Mutex<Option<PathBuf>>,
}

static POP: Pop = Pop {
    current: Mutex::new(None),
    anchor: Mutex::new(POINT { x: 0, y: 0 }),
    shown_at: Mutex::new(None),
    visible: AtomicBool::new(false),
    page_ready: AtomicBool::new(false),
    save_dir: Mutex::new(None),
};

/// Where saved files go: the output folder from Settings when set, else Downloads.
pub fn set_save_dir(dir: Option<PathBuf>) {
    *POP.save_dir.lock().unwrap() = dir.filter(|d| !d.as_os_str().is_empty());
}

fn save_dir(app: &AppHandle) -> PathBuf {
    POP.save_dir.lock().unwrap().clone().or_else(|| app.path().download_dir().ok()).unwrap_or_else(std::env::temp_dir)
}

pub fn read_content(app: &AppHandle) -> ClipContent {
    let save_to = save_dir(app).to_string_lossy().into_owned();
    let s = snapshot();
    if !s.files.is_empty() {
        return ClipContent { kind: "files", files: Some(s.files), save_to, ..Default::default() };
    }
    if let Some(img) = s.image {
        let (w, h) = img.dimensions();
        let scale = (624.0 / w as f64).min(320.0 / h as f64).min(1.0);
        let small = if scale < 1.0 {
            image::imageops::thumbnail(&img, ((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1))
        } else {
            img
        };
        let mut png = Vec::new();
        let _ = small.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png);
        let thumb = format!("data:image/png;base64,{}", win::base64(&png));
        return ClipContent { kind: "image", thumb: Some(thumb), width: Some(w), height: Some(h), save_to, ..Default::default() };
    }
    let html_text = if s.html.is_empty() { String::new() } else { html_to_text(&s.html) };
    if !s.text.trim().is_empty() || !html_text.is_empty() {
        let t = if s.text.trim().is_empty() { html_text.clone() } else { s.text.clone() };
        return ClipContent {
            kind: "text",
            text: Some(t.chars().take(600).collect()),
            chars: Some(t.chars().count()),
            lines: Some(t.lines().count().max(1)),
            html: Some(!html_text.is_empty()),
            save_to,
            ..Default::default()
        };
    }
    ClipContent { kind: "empty", save_to, ..Default::default() }
}

fn ensure_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    POP.page_ready.store(false, Ordering::SeqCst);
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("renderer/clipboard/index.html".into()))
        .title("Orange clipboard")
        .additional_browser_args(&crate::browser_args())
        .inner_size(W, 260.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        // The page refuses drops itself (no-drop cursor).
        .drag_and_drop(false)
        .build()
        .map_err(|e| log::write(&format!("clipboard window: {e}")))
        .ok()?;
    let _ = w.set_decorations(true);
    let _ = w.set_decorations(false);
    let app2 = app.clone();
    w.on_window_event(move |e| match e {
        WindowEvent::Focused(false) => hide(&app2, false),
        WindowEvent::Destroyed => {
            POP.visible.store(false, Ordering::SeqCst);
            POP.page_ready.store(false, Ordering::SeqCst);
        }
        _ => {}
    });
    Some(w)
}

/// Shows the popover (or hides it when it is already open). Also for a tray item.
pub fn toggle(app: &AppHandle) {
    if POP.visible.load(Ordering::SeqCst) {
        hide(app, true);
        return;
    }
    let Some(_w) = ensure_window(app) else { return };
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    *POP.anchor.lock().unwrap() = p;
    let c = read_content(app);
    *POP.current.lock().unwrap() = Some(c.clone());
    if POP.page_ready.load(Ordering::SeqCst) {
        bridge::emit(app, LABEL, "clip:content", json!([c]));
    }
}

pub fn page_ready(app: &AppHandle) {
    POP.page_ready.store(true, Ordering::SeqCst);
    if let Some(c) = POP.current.lock().unwrap().clone() {
        bridge::emit(app, LABEL, "clip:content", json!([c]));
    }
}

/// The page laid itself out: size, place near the pointer and show with focus (for the keys).
pub fn place(app: &AppHandle, height: f64) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let Ok(hwnd) = w.hwnd() else { return };
    let a = *POP.anchor.lock().unwrap();
    let (scale, wa) = win::monitor_scale(a);
    let pw = (W * scale).round() as i32;
    let ph = ((height.max(120.0)) * scale).round().min((wa.bottom - wa.top - 16) as f64) as i32;
    let m = (8.0 * scale) as i32;
    let mut x = a.x - (28.0 * scale) as i32;
    let mut y = a.y + (16.0 * scale) as i32;
    if y + ph > wa.bottom - m {
        y = a.y - ph - (12.0 * scale) as i32; // flip above the pointer near the bottom edge
    }
    x = x.clamp(wa.left + m, (wa.right - pw - m).max(wa.left + m));
    y = y.clamp(wa.top + m, (wa.bottom - ph - m).max(wa.top + m));
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, pw, ph, SWP_NOACTIVATE);
    }
    if !POP.visible.swap(true, Ordering::SeqCst) {
        *POP.shown_at.lock().unwrap() = Some(Instant::now());
        crate::set_low_memory(&w, false);
        win::show_no_activate(hwnd, true);
        let _ = w.set_focus();
    }
}

pub fn hide(app: &AppHandle, force: bool) {
    if !POP.visible.load(Ordering::SeqCst) {
        return;
    }
    // A blur right after showing comes from the hotkey's own focus juggling; ignore it.
    if !force && POP.shown_at.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(150)) {
        return;
    }
    POP.visible.store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(LABEL) {
        if let Ok(h) = w.hwnd() {
            win::hide(h);
        }
        crate::set_low_memory(&w, true);
    }
}

pub fn action(app: &AppHandle, target: &str) {
    let current = POP.current.lock().unwrap().clone();
    hide(app, true);
    let Some(c) = current else { return };
    match c.kind {
        "files" => {
            if let Some(files) = c.files.filter(|f| !f.is_empty()) {
                wheel::open(app, "convert", wheel::Mode::Click, Some(files));
            }
        }
        "image" | "text" => {
            let (app, target, kind) = (app.clone(), target.to_string(), c.kind);
            std::thread::spawn(move || {
                let r = if kind == "image" { save_image(&app, &target) } else { save_text(&app, &target) };
                if let Err(e) = r {
                    log::write(&format!("clipboard save failed: {e}"));
                    hud::notice(&app, &e);
                }
            });
        }
        _ => {}
    }
}

fn stamp() -> String {
    // Local time via the system clock, formatted like 1.x: 2026-10-22 15-04-05.
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{}-{:02}-{:02} {:02}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

fn label(t: &str) -> String {
    match t {
        "png" => "PNG".into(),
        "jpg" => "JPG".into(),
        "webp" => "WebP".into(),
        "pdf" => "PDF".into(),
        "txt" => "TXT".into(),
        "md" => "Markdown".into(),
        "docx" => "Word".into(),
        o => o.to_uppercase(),
    }
}

pub fn save_image(app: &AppHandle, target: &str) -> Result<Option<PathBuf>, String> {
    let s = snapshot();
    let Some(img) = s.image else { return Err("The clipboard no longer holds an image.".into()) };
    if target == "copy-png" {
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).map_err(|e| e.to_string())?;
        put_png(&png)?;
        hud::notice(app, "Copied to the clipboard as PNG");
        return Ok(None);
    }
    let fmt = match target {
        "png" => image::ImageFormat::Png,
        "jpg" => image::ImageFormat::Jpeg,
        "webp" => image::ImageFormat::WebP,
        other => return Err(format!("Saving the clipboard as {} arrives in a later Orange 2.0 build", label(other))),
    };
    let dir = save_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = crate::jobs::unique_path(&dir.join(format!("Clipboard {}.{target}", stamp())));
    let job = hud::start(app, &format!("Clipboard image to {}", label(target)));
    let r = (|| -> Result<(), String> {
        let f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        let mut wr = std::io::BufWriter::new(f);
        if fmt == image::ImageFormat::Jpeg {
            // JPG has no alpha: flatten onto white.
            let rgb = image::RgbImage::from_fn(img.width(), img.height(), |x, y| {
                let p = img.get_pixel(x, y).0;
                let a = p[3] as u32;
                let c = |v: u8| ((v as u32 * a + 255 * (255 - a)) / 255) as u8;
                image::Rgb([c(p[0]), c(p[1]), c(p[2])])
            });
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut wr, 90).encode_image(&rgb).map_err(|e| e.to_string())
        } else if fmt == image::ImageFormat::Png && s.png.is_some() {
            use std::io::Write;
            wr.write_all(s.png.as_ref().unwrap()).map_err(|e| e.to_string())
        } else {
            img.write_to(&mut wr, fmt).map_err(|e| e.to_string())
        }
    })();
    match r {
        Ok(()) => {
            job.done(vec![out.to_string_lossy().into_owned()], vec![]);
            Ok(Some(out))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&out);
            job.failed(&e);
            Err(e)
        }
    }
}

pub fn save_text(app: &AppHandle, target: &str) -> Result<Option<PathBuf>, String> {
    let s = snapshot();
    let html_text = if s.html.is_empty() { String::new() } else { html_to_text(&s.html) };
    if s.text.trim().is_empty() && html_text.is_empty() {
        return Err("The clipboard no longer holds text.".into());
    }
    if !(target == "txt" || (target == "md" && html_text.is_empty())) {
        // Formatted output (Markdown from HTML, PDF, Word) needs the document engine.
        return Err(format!("Saving clipboard text as {} arrives in a later Orange 2.0 build", label(target)));
    }
    let dir = save_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = crate::jobs::unique_path(&dir.join(format!("Clipboard {}.{target}", stamp())));
    let body = if s.text.trim().is_empty() { html_text } else { s.text };
    std::fs::write(&out, body).map_err(|e| e.to_string())?;
    let job = hud::start(app, &format!("Clipboard text to {}", label(target)));
    job.done(vec![out.to_string_lossy().into_owned()], vec![]);
    Ok(Some(out))
}

// ------------------------------------------------------------------------ hotkey

static HOTKEY_THREAD: AtomicU32 = AtomicU32::new(0);
const WM_APP_REBIND: u32 = WM_APP + 1;
static WANTED: Mutex<String> = Mutex::new(String::new());

/// Parses an Electron-style accelerator ("Control+Alt+V", "CmdOrCtrl+Shift+F9").
pub fn parse_accelerator(s: &str) -> Option<(HOT_KEY_MODIFIERS, u32)> {
    let mut mods = HOT_KEY_MODIFIERS(0);
    let mut key = None;
    for part in s.split('+').map(|p| p.trim().to_ascii_lowercase()) {
        match part.as_str() {
            "control" | "ctrl" | "cmdorctrl" | "commandorcontrol" => mods |= MOD_CONTROL,
            "alt" | "option" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "super" | "win" | "meta" | "cmd" | "command" => mods |= MOD_WIN,
            k => {
                let vk = match k {
                    _ if k.len() == 1 && k.as_bytes()[0].is_ascii_alphanumeric() => k.to_ascii_uppercase().as_bytes()[0] as u32,
                    _ if k.starts_with('f') && k[1..].parse::<u32>().is_ok_and(|n| (1..=24).contains(&n)) => 0x70 + k[1..].parse::<u32>().unwrap() - 1,
                    "space" => 0x20,
                    "insert" => 0x2D,
                    "home" => 0x24,
                    "end" => 0x23,
                    "pageup" => 0x21,
                    "pagedown" => 0x22,
                    _ => return None,
                };
                key = Some(vk);
            }
        }
    }
    key.map(|k| (mods | MOD_NOREPEAT, k))
}

/// Registers (or changes, or with "" removes) the popover's global hotkey. Default Control+Alt+V.
pub fn set_hotkey(accel: &str) {
    *WANTED.lock().unwrap() = accel.to_string();
    let t = HOTKEY_THREAD.load(Ordering::SeqCst);
    if t != 0 {
        unsafe {
            let _ = PostThreadMessageW(t, WM_APP_REBIND, WPARAM(0), LPARAM(0));
        }
    }
}

/// Starts the hotkey thread (RegisterHotKey needs a thread with a message loop).
pub fn start_hotkey(app: &AppHandle, accel: &str) {
    *WANTED.lock().unwrap() = accel.to_string();
    if HOTKEY_THREAD.load(Ordering::SeqCst) != 0 {
        return set_hotkey(accel);
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("orange-clip-hotkey".into())
        .spawn(move || unsafe {
            let mut msg = MSG::default();
            // Make sure the thread has a queue before anyone posts to it.
            let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
            HOTKEY_THREAD.store(windows::Win32::System::Threading::GetCurrentThreadId(), Ordering::SeqCst);
            const ID: i32 = 0x0C1B;
            let mut registered = false;
            let bind = |registered: &mut bool| {
                if *registered {
                    let _ = UnregisterHotKey(None, ID);
                    *registered = false;
                }
                let want = WANTED.lock().unwrap().clone();
                if want.is_empty() {
                    return;
                }
                match parse_accelerator(&want) {
                    Some((m, vk)) => match RegisterHotKey(None, ID, m, vk) {
                        Ok(()) => *registered = true,
                        Err(e) => log::write(&format!("clipboard hotkey {want} is taken by another app: {e}")),
                    },
                    None => log::write(&format!("clipboard hotkey {want} is not a valid shortcut")),
                }
            };
            bind(&mut registered);
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                match msg.message {
                    WM_HOTKEY => {
                        let app = app.clone();
                        let _ = app.clone().run_on_main_thread(move || toggle(&app));
                    }
                    WM_APP_REBIND => bind(&mut registered),
                    _ => {}
                }
            }
        })
        .expect("hotkey thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_parse() {
        let (m, vk) = parse_accelerator("Control+Alt+V").unwrap();
        assert_eq!(vk, 'V' as u32);
        assert_eq!(m, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT);
        assert_eq!(parse_accelerator("Shift+F9").unwrap().1, 0x78);
        assert!(parse_accelerator("Control+Alt").is_none());
    }

    #[test]
    fn cf_html_takes_the_fragment() {
        let body = "<html><body><!--StartFragment--><b>hi</b><!--EndFragment--></body></html>";
        let head = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:FFFFFFFFFF\r\nEndFragment:EEEEEEEEEE\r\n";
        let a = head.len() + body.find("<b>").unwrap();
        let b = head.len() + body.find("<!--EndF").unwrap();
        let raw = head.replace("FFFFFFFFFF", &format!("{a:010}")).replace("EEEEEEEEEE", &format!("{b:010}")) + body;
        assert_eq!(cf_html_fragment(&raw), "<b>hi</b>");
        assert_eq!(html_to_text("<p>a&nbsp;b</p><script>x()</script><i>c</i>"), "a b c");
    }

    #[test]
    fn dib_round_trip() {
        let mut img = image::RgbaImage::new(3, 2);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        img.put_pixel(2, 1, image::Rgba([0, 0, 255, 128]));
        let back = dib_to_rgba(&rgba_to_dib(&img)).unwrap();
        assert_eq!(back, img);
    }

    #[test]
    fn markdown_sniffing() {
        assert!(looks_like_markdown("# Title\ntext"));
        assert!(looks_like_markdown("1. one\n2. two"));
        assert!(!looks_like_markdown("Just a sentence."));
    }

    /// Real clipboard round trip: files, text and an image, then the user's clipboard put back.
    /// Run with `cargo test -- --ignored --test-threads=1`.
    #[test]
    #[ignore]
    fn real_clipboard_round_trip_restores_user_clipboard() {
        let saved = Saved::take().unwrap();
        let dir = std::env::temp_dir().join(format!("orange-clip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a file.txt");
        std::fs::write(&f, "x").unwrap();
        let fp = f.to_string_lossy().into_owned();
        let r = std::panic::catch_unwind(|| {
            put_files(&[fp.clone()]).unwrap();
            assert_eq!(snapshot().files, vec![fp.clone()]);
            put_text("hello\r\nworld").unwrap();
            assert_eq!(snapshot().text, "hello\r\nworld");
            let mut img = image::RgbaImage::new(4, 4);
            img.put_pixel(1, 1, image::Rgba([10, 20, 30, 255]));
            let mut png = Vec::new();
            img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
            put_png(&png).unwrap();
            assert_eq!(snapshot().image.unwrap().get_pixel(1, 1).0, [10, 20, 30, 255]);
        });
        saved.restore().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        r.unwrap();
    }
}
