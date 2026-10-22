//! The radial wheel: one transparent, always-on-top window created at startup and moved under the
//! cursor on demand, so opening it costs a SetWindowPos and a show.

use crate::{bridge, hooks, log, win, AppState};
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, DragDropEvent, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Logical size; must match --wheel-size in wheel.css.
pub const SIZE: f64 = 440.0;
pub const LABEL: &str = "wheel";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Drag,
    Click,
}

#[derive(Default)]
struct Inner {
    favorites: Map<String, Value>,
    recents: Map<String, Value>,
    opened_at: Option<Instant>,
    /// Paths reported by the drop target while a drag hovers the wheel.
    drag_paths: Vec<String>,
}

pub struct WheelState {
    inner: Mutex<Inner>,
    open: AtomicBool,
    click_mode: AtomicBool,
    ready: AtomicBool,
    /// Bumped on every open and close, so a delayed hide never hides a newer opening.
    session: AtomicU64,
    pub last_latency_us: AtomicU64,
    pub shown_count: AtomicU64,
}

impl Default for WheelState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            open: AtomicBool::new(false),
            click_mode: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            session: AtomicU64::new(0),
            last_latency_us: AtomicU64::new(0),
            shown_count: AtomicU64::new(0),
        }
    }
}

impl WheelState {
    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    fn prefs(&self) -> Value {
        let i = self.inner.lock().unwrap();
        json!({ "favorites": i.favorites, "recents": i.recents, "presets": [] })
    }

    pub fn toggle_pin(&self, key: &str, item: &str) -> Value {
        let mut i = self.inner.lock().unwrap();
        let list = i.favorites.entry(key.to_string()).or_insert_with(|| json!([]));
        let arr = list.as_array_mut().unwrap();
        let before = arr.len();
        arr.retain(|v| v.as_str() != Some(item));
        if arr.len() == before {
            arr.push(json!(item));
        }
        Value::Object(i.favorites.clone())
    }

    pub fn remember_recent(&self, ext: &str, item: &str) {
        self.inner.lock().unwrap().recents.insert(ext.to_string(), json!(item));
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("renderer/wheel/index.html".into()))
        .title("Orange wheel")
        .inner_size(SIZE, SIZE)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()?;
    // tao creates a hidden undecorated window with a standard frame (client inset 8,31 px at 100%)
    // and only drops it when a style change is applied. The wheel is shown with ShowWindow, never
    // through tao, so force that change now; otherwise page and drop coordinates are offset.
    let _ = w.set_decorations(true);
    let _ = w.set_decorations(false);
    if let Ok(h) = w.hwnd() {
        let (dx, dy, _, _) = win::frame_inset(h);
        if dx != 0 || dy != 0 {
            log::write(&format!("wheel still has a frame: inset {dx},{dy}"));
        }
    }
    let handle = app.clone();
    w.on_window_event(move |e| match e {
        WindowEvent::DragDrop(d) => on_drag(&handle, d),
        // Clicking elsewhere dismisses a click-mode wheel.
        WindowEvent::Focused(false) => {
            let st = handle.state::<AppState>();
            if st.wheel.is_open() && st.wheel.click_mode.load(Ordering::SeqCst) {
                close(&handle);
            }
        }
        _ => {}
    });
    Ok(w)
}

/// The OLE drop target (wry registers one on the webview's child windows) reports the exact
/// dragged paths on enter, then positions. Positions are physical client pixels; the page works
/// in CSS pixels.
fn on_drag(app: &AppHandle, d: &DragDropEvent) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let st = app.state::<AppState>();
    let payload = match d {
        DragDropEvent::Enter { paths, position } => {
            let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            st.wheel.inner.lock().unwrap().drag_paths = paths.clone();
            send_preview(app, paths.clone());
            json!({ "type": "enter", "paths": paths, "x": position.x / scale, "y": position.y / scale })
        }
        DragDropEvent::Over { position } => json!({ "type": "over", "x": position.x / scale, "y": position.y / scale }),
        DragDropEvent::Drop { paths, position } => {
            let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            json!({ "type": "drop", "paths": paths, "x": position.x / scale, "y": position.y / scale })
        }
        DragDropEvent::Leave => json!({ "type": "leave", "x": -1, "y": -1 }),
        _ => return,
    };
    if payload["type"] != "over" {
        log::write(&format!("wheel drag {payload}"));
    }
    bridge::emit(app, LABEL, "wheel:drag", json!([payload]));
}

/// Opens (or switches) the wheel under the cursor. Safe from any thread.
pub fn open(app: &AppHandle, kind: &str, mode: Mode, paths: Option<Vec<String>>) {
    let st = app.state::<AppState>();
    let wheel = &st.wheel;
    let was_open = wheel.open.swap(true, Ordering::SeqCst);
    wheel.click_mode.store(mode == Mode::Click, Ordering::SeqCst);
    let session = wheel.session.fetch_add(1, Ordering::SeqCst) + 1;
    if !was_open {
        wheel.inner.lock().unwrap().opened_at = Some(Instant::now());
        wheel.inner.lock().unwrap().drag_paths.clear();
    }
    hooks::LISTENING_NAV.store(true, Ordering::Relaxed);
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let Ok(hwnd) = w.hwnd() else { return };
    let placed = win::place_under_cursor(hwnd, SIZE);    let payload = json!({
        "wheel": kind,
        "mode": if mode == Mode::Click { "click" } else { "drag" },
        "paths": paths,
        "prefs": wheel.prefs(),
        "cursor": { "x": placed.cursor_x, "y": placed.cursor_y },
    });
    bridge::emit(app, LABEL, "wheel:open", json!([payload]));
    if !was_open {
        win::show_no_activate(hwnd, mode == Mode::Click);
    }
    if let Some(p) = paths {
        send_preview(app, p);
    }
    let _ = session;
}

/// The page painted the opened wheel: record the open latency.
pub fn shown(app: &AppHandle) {
    let st = app.state::<AppState>();
    let opened = st.wheel.inner.lock().unwrap().opened_at.take();
    if let Some(t) = opened {
        let us = t.elapsed().as_micros() as u64;
        st.wheel.last_latency_us.store(us, Ordering::SeqCst);
        st.wheel.shown_count.fetch_add(1, Ordering::SeqCst);
        log::write(&format!("wheel open latency {:.1} ms", us as f64 / 1000.0));
    }
}

pub fn nav(app: &AppHandle, key: &str) {
    if app.state::<AppState>().wheel.is_open() {
        bridge::emit(app, LABEL, "wheel:nav", json!([key]));
    }
}

/// The mouse button went up; if no drop landed on the wheel shortly after, close it.
pub fn release_soon(app: &AppHandle) {
    let st = app.state::<AppState>();
    if !st.wheel.is_open() || st.wheel.click_mode.load(Ordering::SeqCst) {
        return;
    }
    let session = st.wheel.session.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        if app.state::<AppState>().wheel.session.load(Ordering::SeqCst) == session {
            close(&app);
        }
    });
}

pub fn close(app: &AppHandle) {
    let st = app.state::<AppState>();
    if !st.wheel.open.swap(false, Ordering::SeqCst) {
        return;
    }
    hooks::LISTENING_NAV.store(false, Ordering::Relaxed);
    let session = st.wheel.session.fetch_add(1, Ordering::SeqCst) + 1;
    bridge::emit(app, LABEL, "wheel:close", json!([]));
    // Let the close animation play, then hide.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(140));
        let st = app.state::<AppState>();
        if st.wheel.session.load(Ordering::SeqCst) == session && !st.wheel.is_open() {
            if let Some(w) = app.get_webview_window(LABEL) {
                if let Ok(h) = w.hwnd() {
                    win::hide(h);
                }
            }
        }
    });
}

/// An Explorer-style thumbnail for the hub, made off the UI thread.
fn send_preview(app: &AppHandle, paths: Vec<String>) {
    let Some(first) = paths.first().cloned() else { return };
    let st = app.state::<AppState>();
    let session = st.wheel.session.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let thumb = win::thumbnail_data_url(&first, 96).unwrap_or_default();
        let name = std::path::Path::new(&first).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let st = app.state::<AppState>();
        if st.wheel.is_open() && st.wheel.session.load(Ordering::SeqCst) == session {
            bridge::emit(&app, LABEL, "wheel:preview", json!([{ "thumb": thumb, "name": name, "count": paths.len() }]));
        }
    });
}
