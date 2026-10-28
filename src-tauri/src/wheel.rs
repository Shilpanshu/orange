//! The radial wheel: one transparent, always-on-top window created at startup and moved under the
//! cursor on demand, so opening it costs a SetWindowPos and a show.

use crate::{bridge, hooks, log, win, AppState};
use serde_json::{json, Value};
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
    /// Trim the hidden wheel's memory once its page has loaded and warmed up.
    pub fn trim_soon(app: &AppHandle) {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            if !app.state::<AppState>().wheel.is_open() {
                if let Some(w) = app.get_webview_window(LABEL) {
                    crate::set_low_memory(&w, true);
                }
            }
        });
    }
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    // [phase2-settings] Pins, recents and presets live in settings (persisted), not in memory.
    fn prefs(&self) -> Value {
        crate::presets::wheel_prefs(&crate::settings::get())
    }

    pub fn toggle_pin(&self, key: &str, item: &str) -> Value {
        crate::presets::toggle_pin(crate::settings::store(), key, item)
    }

    pub fn remember_recent(&self, ext: &str, item: &str) {
        crate::presets::remember_recent(crate::settings::store(), ext, item)
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("renderer/wheel/index.html".into()))
        .title("Orange wheel")
        .additional_browser_args(&crate::browser_args())
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

/// A drag over the wheel, in physical client pixels.
pub enum DropEv {
    Enter(Vec<String>, f64, f64),
    Over(f64, f64),
    Drop(Vec<String>, f64, f64),
    Leave,
}

/// wry's drop target (registered when the window is created).
fn on_drag(app: &AppHandle, d: &DragDropEvent) {
    let p = |paths: &Vec<std::path::PathBuf>| paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>();
    let ev = match d {
        DragDropEvent::Enter { paths, position } => DropEv::Enter(p(paths), position.x, position.y),
        DragDropEvent::Over { position } => DropEv::Over(position.x, position.y),
        DragDropEvent::Drop { paths, position } => DropEv::Drop(p(paths), position.x, position.y),
        DragDropEvent::Leave => DropEv::Leave,
        _ => return,
    };
    on_drop_event(app, ev);
}

/// The OLE drop target (Orange's own from `droptarget.rs`, or wry's) reports the exact dragged
/// paths on enter, then positions. Positions are physical client pixels; the page works in CSS
/// pixels.
pub fn on_drop_event(app: &AppHandle, d: DropEv) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let st = app.state::<AppState>();
    let payload = match d {
        DropEv::Enter(paths, x, y) => {
            st.wheel.inner.lock().unwrap().drag_paths = paths.clone();
            send_preview(app, paths.clone(), false);
            json!({ "type": "enter", "paths": paths, "x": x / scale, "y": y / scale })
        }
        DropEv::Over(x, y) => json!({ "type": "over", "x": x / scale, "y": y / scale }),
        DropEv::Drop(paths, x, y) => json!({ "type": "drop", "paths": paths, "x": x / scale, "y": y / scale }),
        DropEv::Leave => json!({ "type": "leave", "x": -1, "y": -1 }),
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
        // Re-register Orange's drop target each time: WebView2 can replace it after creation.
        let (app3, raw) = (app.clone(), hwnd.0 as isize);
        let _ = app.run_on_main_thread(move || crate::droptarget::register(&app3, windows::Win32::Foundation::HWND(raw as *mut _)));
        crate::set_low_memory(&w, false);
        win::show_no_activate(hwnd, mode == Mode::Click);
    }
    if let Some(p) = paths {
        send_preview(app, p, false);
    }
    // Diagnostic: once the drag is over the wheel Windows reports the exact dragged files within a few
    // milliseconds. If they have not arrived after 700 ms, the wheel is working from a guess; say which
    // window the drag is actually over, so a report from a real machine shows why.
    if !was_open && mode == Mode::Drag {
        let app2 = app.clone();
        let wheel_hwnd = hwnd.0 as isize;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            let st = app2.state::<AppState>();
            if st.wheel.is_open() && st.wheel.session.load(Ordering::SeqCst) == session && !hooks::primary_button_down() {
                // No button held and nothing dropped: nobody can use this wheel, so don't leave it on screen.
                log::write("wheel closed: no button held 700 ms after it opened");
                close(&app2);
                return;
            }
            if st.wheel.is_open() && st.wheel.session.load(Ordering::SeqCst) == session && !drag_paths_known(&app2) {
                log::write(&format!("no DragEnter 700 ms after the wheel opened; under the pointer: {}", win::describe_window_under_cursor(wheel_hwnd)));
            }
        });
    }
}

/// True once the window's drop target has reported the exact dragged files for this opening. From then
/// on the Explorer selection (a guess made before the drag reached the wheel) must not be used.
pub fn drag_paths_known(app: &AppHandle) -> bool {
    !app.state::<AppState>().wheel.inner.lock().unwrap().drag_paths.is_empty()
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
                crate::set_low_memory(&w, true);
            }
        }
    });
}

/// An Explorer-style thumbnail for the hub, made off the UI thread.
/// Sends the hub's file name and thumbnail. `guess` marks a preview made from the Explorer selection
/// (a guess): it is dropped if the exact dragged files were reported while its thumbnail was built.
pub(crate) fn send_preview(app: &AppHandle, paths: Vec<String>, guess: bool) {
    let Some(first) = paths.first().cloned() else { return };
    let st = app.state::<AppState>();
    let session = st.wheel.session.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let thumb = win::thumbnail_data_url(&first, 96).unwrap_or_default();
        let name = std::path::Path::new(&first).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let st = app.state::<AppState>();
        if st.wheel.is_open() && st.wheel.session.load(Ordering::SeqCst) == session && !(guess && drag_paths_known(&app)) {
            bridge::emit(&app, LABEL, "wheel:preview", json!([{ "thumb": thumb, "name": name, "count": paths.len() }]));
        }
    });
}
