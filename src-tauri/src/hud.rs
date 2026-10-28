//! Bottom-right progress panel: one window, many job rows. The window exists only while there are
//! rows; between jobs it is closed so its renderer process is freed.

use crate::{bridge, win, AppState};
use serde::Serialize;
use serde_json::json;
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE};

const LABEL: &str = "hud";
const W: f64 = 360.0;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RowState {
    Running,
    Done,
    Failed,
    Cancelled,
    Notice,
}

#[derive(Serialize, Clone, Debug)]
pub struct Row {
    pub id: u64,
    pub title: String,
    pub state: RowState,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outputs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<String>>,
    pub undoable: bool,
}

#[derive(Default)]
pub struct HudState {
    rows: Mutex<BTreeMap<u64, Row>>,
    seq: Mutex<u64>,
    held: Mutex<HashSet<u64>>,
    cancels: Mutex<BTreeMap<u64, Arc<AtomicBool>>>,
    last_send: Mutex<Option<Instant>>,
    pending: AtomicBool,
    page_ready: AtomicBool,
    /// Every finished job, for the self-test.
    pub finished: Mutex<Vec<Row>>,
    /// Bumped each time a row is finished again (after Undo), so an older linger timer doesn't
    /// dismiss the newer state early. [phase2-actions]
    finish_gen: Mutex<BTreeMap<u64, u64>>,
}

fn st(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn ensure_window(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    st(app).hud.page_ready.store(false, Ordering::SeqCst);
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("renderer/hud/index.html".into()))
        .title("Orange progress")
        .additional_browser_args(&crate::browser_args())
        .inner_size(W, 80.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .focused(false)
        .visible(false)
        .drag_and_drop(false)
        .build();
    match built {
        // Drop tao's leftover frame on a hidden undecorated window (see wheel::create).
        Ok(w) => {
            let _ = w.set_decorations(true);
            let _ = w.set_decorations(false);
        }
        Err(e) => crate::log::write(&format!("hud window: {e}")),
    }
}

pub fn page_ready(app: &AppHandle) {
    st(app).hud.page_ready.store(true, Ordering::SeqCst);
    flush(app, true);
}

/// Sizes and places the panel bottom-right of the cursor's monitor's work area.
pub fn place(app: &AppHandle, height: f64) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let Ok(hwnd) = w.hwnd() else { return };
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    let (scale, wa) = win::monitor_scale(p);
    let h = height.clamp(40.0, 520.0);
    let (pw, ph) = ((W * scale).round() as i32, (h * scale).round() as i32);
    let margin = (12.0 * scale).round() as i32;
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), wa.right - pw - margin, wa.bottom - ph - margin, pw, ph, SWP_NOACTIVATE);
    }
    win::show_no_activate(hwnd, false);
}

/// Sends the rows to the panel, at most ~30 times a second.
pub fn flush(app: &AppHandle, force: bool) {
    let hud = &st(app).hud;
    {
        let mut last = hud.last_send.lock().unwrap();
        if !force && last.is_some_and(|t| t.elapsed() < Duration::from_millis(33)) {
            if !hud.pending.swap(true, Ordering::SeqCst) {
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(33));
                    st(&app).hud.pending.store(false, Ordering::SeqCst);
                    flush(&app, true);
                });
            }
            return;
        }
        *last = Some(Instant::now());
    }
    let rows: Vec<Row> = hud.rows.lock().unwrap().values().cloned().collect();
    if rows.is_empty() {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.close();
        }
        return;
    }
    ensure_window(app);
    if hud.page_ready.load(Ordering::SeqCst) {
        bridge::emit(app, LABEL, "hud:rows", json!([rows]));
    }
}

pub struct Job {
    app: AppHandle,
    pub id: u64,
    pub cancelled: Arc<AtomicBool>,
}

pub fn start(app: &AppHandle, title: &str) -> Job {
    let hud = &st(app).hud;
    let id = {
        let mut s = hud.seq.lock().unwrap();
        *s += 1;
        *s
    };
    hud.rows.lock().unwrap().insert(
        id,
        Row { id, title: title.into(), state: RowState::Running, progress: 0.0, note: None, outputs: None, errors: None, undoable: false },
    );
    let cancelled = Arc::new(AtomicBool::new(false));
    hud.cancels.lock().unwrap().insert(id, cancelled.clone());
    flush(app, true);
    Job { app: app.clone(), id, cancelled }
}

impl Job {
    pub fn progress(&self, f: f64, note: Option<&str>) {
        if let Some(r) = st(&self.app).hud.rows.lock().unwrap().get_mut(&self.id) {
            r.progress = f;
            if let Some(n) = note {
                r.note = Some(n.into());
            }
        }
        flush(&self.app, false);
    }
    /// Finished. As in 1.x, Undo then moves the new files to the Recycle Bin. [phase2-actions]
    pub fn done(&self, outputs: Vec<String>, errors: Vec<String>) {
        let undo = (!outputs.is_empty()).then(|| crate::actions::Undo::Trash(outputs.clone()));
        self.done_with_undo(outputs, errors, undo);
    }
    /// Finished, with a custom Undo (Move puts files back), or `None` for no Undo button.
    pub fn done_with_undo(&self, outputs: Vec<String>, errors: Vec<String>, undo: Option<crate::actions::Undo>) {
        let undoable = undo.is_some();
        if let Some(u) = undo {
            crate::actions::register_undo(self.id, u);
        }
        let linger = if errors.is_empty() { 8000 } else { 12000 };
        finish(&self.app, self.id, linger, |r| {
            r.state = RowState::Done;
            r.progress = 1.0;
            r.note = None;
            r.outputs = Some(outputs);
            r.errors = Some(errors);
            r.undoable = undoable;
        });
    }
    pub fn failed(&self, msg: &str) {
        finish(&self.app, self.id, 12000, |r| {
            r.state = RowState::Failed;
            r.note = Some(msg.into());
        });
    }
    pub fn cancelled(&self) {
        finish(&self.app, self.id, 1800, |r| {
            r.state = RowState::Cancelled;
            r.note = Some("Cancelled".into());
        });
    }
}

pub fn notice(app: &AppHandle, msg: &str) {
    let job = start(app, msg);
    finish(app, job.id, 4000, |r| r.state = RowState::Notice);
}

fn finish(app: &AppHandle, id: u64, linger_ms: u64, patch: impl FnOnce(&mut Row)) {
    let hud = &st(app).hud;
    if let Some(r) = hud.rows.lock().unwrap().get_mut(&id) {
        patch(r);
        hud.finished.lock().unwrap().push(r.clone());
    }
    hud.cancels.lock().unwrap().remove(&id);
    let gen = {
        let mut g = hud.finish_gen.lock().unwrap();
        let e = g.entry(id).or_insert(0);
        *e += 1;
        *e
    };
    flush(app, true);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(linger_ms));
        if st(&app).hud.finish_gen.lock().unwrap().get(&id).is_some_and(|g| *g != gen) {
            return; // finished again since (Undo): that timer owns the row now
        }
        // A row under the pointer stays until the pointer leaves it.
        while st(&app).hud.held.lock().unwrap().contains(&id) {
            std::thread::sleep(Duration::from_millis(250));
        }
        dismiss(&app, id);
    });
}

/// Undo finished (`Ok(title)`) or failed: the row says so briefly. [phase2-actions]
pub fn undone(app: &AppHandle, id: u64, r: Result<String, String>) {
    match r {
        Ok(title) => finish(app, id, 3500, |row| {
            row.state = RowState::Notice;
            row.title = title;
            row.undoable = false;
        }),
        Err(e) => finish(app, id, 8000, |row| {
            row.state = RowState::Failed;
            row.note = Some(format!("Couldn't undo: {e}"));
            row.undoable = false;
        }),
    }
}

pub fn dismiss(app: &AppHandle, id: u64) {
    crate::actions::forget_undo(id); // [phase2-actions]
    let hud = &st(app).hud;
    hud.finish_gen.lock().unwrap().remove(&id);
    hud.rows.lock().unwrap().remove(&id);
    hud.held.lock().unwrap().remove(&id);
    flush(app, true);
}

pub fn cancel(app: &AppHandle, id: u64) {
    if let Some(c) = st(app).hud.cancels.lock().unwrap().get(&id) {
        c.store(true, Ordering::SeqCst);
    }
}

pub fn hold(app: &AppHandle, id: u64, on: bool) {
    let state = st(app);
    let mut held = state.hud.held.lock().unwrap();
    if on {
        held.insert(id);
    } else {
        held.remove(&id);
    }
}

/// Only files a job made can be revealed or opened, so the panel can't be used to launch anything.
fn is_output(app: &AppHandle, p: &str) -> bool {
    st(app).hud.rows.lock().unwrap().values().any(|r| r.outputs.as_ref().is_some_and(|o| o.iter().any(|x| x == p)))
}

pub fn reveal(app: &AppHandle, p: &str) {
    if is_output(app, p) {
        win::reveal(p);
    }
}

pub fn open(app: &AppHandle, p: &str) {
    if is_output(app, p) {
        win::open_path(p);
    }
}
