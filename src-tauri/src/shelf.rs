//! The shelf: a small always-on-top window pinned to a screen edge that holds files until you drag
//! them somewhere else. Items stay until removed or the shelf is closed. Dragging out is a real
//! shell drag (SHDoDragDrop with the shell's own data object), so any number of files go at once
//! and every drop target sees exactly what Explorer would give it.
//!
//! Also routes the clipboard popover's page messages (both are phase-2 windows).

use crate::{bridge, clipboard, log, win};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, DragDropEvent, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect, IsWindowVisible, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE};

const LABEL: &str = "shelf";
const WIDTH: f64 = 252.0;
const TAB_W: f64 = 34.0;
const TAB_H: f64 = 132.0;

#[derive(Serialize, Clone, Debug)]
pub struct Item {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub dir: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

fn item_for(p: &str) -> Item {
    let name = Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string());
    match std::fs::metadata(p) {
        Ok(m) => Item { path: p.into(), name, size: if m.is_dir() { 0 } else { m.len() }, dir: m.is_dir(), missing: false },
        Err(_) => Item { path: p.into(), name, size: 0, dir: false, missing: true },
    }
}

struct Shelf {
    items: Vec<Item>,
    collapsed: bool,
    content_height: f64,
    edge_left: bool,
    thumbs: Option<HashMap<String, String>>,
}

static SHELF: Mutex<Shelf> = Mutex::new(Shelf { items: Vec::new(), collapsed: false, content_height: 220.0, edge_left: false, thumbs: None });
static READY: AtomicBool = AtomicBool::new(false);
static DRAGGING_OUT: AtomicBool = AtomicBool::new(false);

/// The screen edge the shelf sits on ("left" or "right"), from Settings.
pub fn set_edge(app: &AppHandle, edge: &str) {
    SHELF.lock().unwrap().edge_left = edge == "left";
    if app.get_webview_window(LABEL).is_some() {
        bridge::emit(app, LABEL, "shelf:edge", json!([edge]));
        place(app);
    }
}

fn edge_name() -> &'static str {
    if SHELF.lock().unwrap().edge_left {
        "left"
    } else {
        "right"
    }
}

/// Adds files (duplicates and missing paths are skipped) and shows the shelf. `add(app, vec![])`
/// just shows it.
pub fn add(app: &AppHandle, paths: Vec<String>) {
    {
        let mut s = SHELF.lock().unwrap();
        for raw in paths {
            if raw.is_empty() {
                continue;
            }
            // Windows shell APIs want backslashes.
            let p = raw.replace('/', "\\");
            if s.items.iter().any(|i| i.path.eq_ignore_ascii_case(&p)) || !Path::new(&p).exists() {
                continue;
            }
            s.items.push(item_for(&p));
        }
        s.collapsed = false;
    }
    let app2 = app.clone();
    // Windows are created on the main thread.
    let _ = app.run_on_main_thread(move || {
        ensure(&app2);
        push(&app2);
        place(&app2);
    });
}

fn ensure(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        return;
    }
    READY.store(false, Ordering::SeqCst);
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("renderer/shelf/index.html".into()))
        .title("Orange shelf")
        .additional_browser_args(&crate::browser_args())
        .inner_size(WIDTH, 240.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build();
    let w = match built {
        Ok(w) => w,
        Err(e) => return log::write(&format!("shelf window: {e}")),
    };
    let _ = w.set_decorations(true);
    let _ = w.set_decorations(false);
    let handle = app.clone();
    w.on_window_event(move |e| match e {
        // Files dropped on the shelf: the native drop target has their paths.
        WindowEvent::DragDrop(d) => {
            let out = DRAGGING_OUT.load(Ordering::SeqCst);
            match d {
                DragDropEvent::Enter { .. } => {
                    if !out {
                        bridge::emit(&handle, LABEL, "shelf:dropping", json!([true]));
                        if SHELF.lock().unwrap().collapsed {
                            set_collapsed(&handle, false);
                        }
                    }
                }
                DragDropEvent::Leave => bridge::emit(&handle, LABEL, "shelf:dropping", json!([false])),
                DragDropEvent::Drop { paths, .. } => {
                    bridge::emit(&handle, LABEL, "shelf:dropping", json!([false]));
                    if !out {
                        add(&handle, paths.iter().map(|p| p.to_string_lossy().into_owned()).collect());
                    }
                }
                _ => {}
            }
        }
        WindowEvent::Destroyed => {
            let mut s = SHELF.lock().unwrap();
            s.items.clear();
            s.collapsed = false;
            s.thumbs = None;
            READY.store(false, Ordering::SeqCst);
        }
        _ => {}
    });
}

fn push(app: &AppHandle) {
    if !READY.load(Ordering::SeqCst) {
        return;
    }
    let (items, collapsed) = {
        let mut s = SHELF.lock().unwrap();
        for it in s.items.iter_mut() {
            it.missing = !Path::new(&it.path).exists();
        }
        (s.items.clone(), s.collapsed)
    };
    bridge::emit(app, LABEL, "shelf:items", json!([items, collapsed]));
}

/// Sizes the shelf and pins it to the edge of the work area. Once shown it keeps its vertical
/// position; it starts centred on the cursor's monitor.
fn place(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let Ok(hwnd) = w.hwnd() else { return };
    let (collapsed, ch, left) = {
        let s = SHELF.lock().unwrap();
        (s.collapsed, s.content_height, s.edge_left)
    };
    unsafe {
        let visible = IsWindowVisible(hwnd).as_bool();
        let mut cur = RECT::default();
        let _ = GetWindowRect(hwnd, &mut cur);
        let mut anchor = POINT::default();
        if visible {
            anchor = POINT { x: (cur.left + cur.right) / 2, y: (cur.top + cur.bottom) / 2 };
        } else {
            let _ = GetCursorPos(&mut anchor);
        }
        let (scale, wa) = win::monitor_scale(anchor);
        let wa_h = (wa.bottom - wa.top) as f64 / scale;
        let (wl, hl) = if collapsed { (TAB_W, TAB_H) } else { (WIDTH, ch.clamp(180.0, wa_h * 0.8).round()) };
        let (pw, ph) = ((wl * scale).round() as i32, (hl * scale).round() as i32);
        let m = (8.0 * scale).round() as i32;
        let x = if left { wa.left + m } else { wa.right - pw - m };
        let y = if visible { cur.top.clamp(wa.top + m, (wa.bottom - ph - m).max(wa.top + m)) } else { wa.top + (wa.bottom - wa.top - ph) / 2 };
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, pw, ph, SWP_NOACTIVATE);
        if !visible {
            win::show_no_activate(hwnd, false);
        }
    }
}

fn set_collapsed(app: &AppHandle, v: bool) {
    SHELF.lock().unwrap().collapsed = v;
    bridge::emit(app, LABEL, "shelf:collapsed", json!([v]));
    place(app);
}

pub fn remove(app: &AppHandle, paths: &[String]) {
    SHELF.lock().unwrap().items.retain(|i| !paths.iter().any(|p| p.eq_ignore_ascii_case(&i.path)));
    push(app);
}

pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

/// What is on the shelf now (for the self-check and the tray).
pub fn items() -> Vec<Item> {
    SHELF.lock().unwrap().items.clone()
}

fn on_shelf(p: &str) -> bool {
    SHELF.lock().unwrap().items.iter().any(|i| i.path.eq_ignore_ascii_case(p))
}

/// A thumbnail data URL for an item ("" for folders, which the page draws itself).
pub fn thumb(p: &str) -> String {
    if !on_shelf(p) {
        return String::new();
    }
    if let Some(t) = SHELF.lock().unwrap().thumbs.as_ref().and_then(|m| m.get(p)) {
        return t.clone();
    }
    let t = if Path::new(p).is_dir() { String::new() } else { win::thumbnail_data_url(p, 96).unwrap_or_default() };
    SHELF.lock().unwrap().thumbs.get_or_insert_with(HashMap::new).insert(p.to_string(), t.clone());
    t
}

/// Starts a shell drag of `paths` out of the shelf. Must run while the button is still down,
/// so it is called straight from the page's dragstart.
fn drag_out(app: &AppHandle, paths: Vec<String>) {
    let files: Vec<String> = paths.into_iter().filter(|p| on_shelf(p) && Path::new(p).exists()).collect();
    if files.is_empty() {
        return;
    }
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let Ok(hwnd) = w.hwnd() else { return };
    let hwnd_raw = hwnd.0 as isize;
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        DRAGGING_OUT.store(true, Ordering::SeqCst);
        let r = unsafe { do_drag(HWND(hwnd_raw as *mut _), &files) };
        DRAGGING_OUT.store(false, Ordering::SeqCst);
        if let Err(e) = r {
            log::write(&format!("shelf drag failed: {e}"));
        }
        // A move-drop takes files away: show them as moved.
        push(&app2);
    });
}

/// The shell's data object for `paths` (CF_HDROP, shell ID lists, file contents and all).
pub unsafe fn data_object(paths: &[String]) -> windows::core::Result<windows::Win32::System::Com::IDataObject> {
    use windows::Win32::UI::Shell::*;
    let mut pidls = Vec::new();
    for p in paths {
        let pidl = ILCreateFromPathW(&windows::core::HSTRING::from(p.as_str()));
        if !pidl.is_null() {
            pidls.push(pidl as *const _);
        }
    }
    let r: windows::core::Result<windows::Win32::System::Com::IDataObject> = SHCreateDataObject(None, Some(&pidls), None);
    for p in pidls {
        ILFree(Some(p));
    }
    let obj = r?;
    // With absolute ID lists from several folders the shell object offers no CF_HDROP of its own;
    // most drop targets want it, so add it.
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Memory::*;
    let bytes = crate::clipboard::hdrop_bytes(paths);
    let g = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
    let dst = GlobalLock(g) as *mut u8;
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
    let _ = GlobalUnlock(g);
    let fmt = FORMATETC { cfFormat: 15, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 };
    let med = STGMEDIUM { tymed: TYMED_HGLOBAL.0 as u32, u: STGMEDIUM_0 { hGlobal: g }, pUnkForRelease: std::mem::ManuallyDrop::new(None) };
    obj.SetData(&fmt, &med, true)?;
    Ok(obj)
}

unsafe fn do_drag(hwnd: HWND, paths: &[String]) -> windows::core::Result<()> {
    use windows::Win32::System::Ole::*;
    use windows::Win32::UI::Shell::SHDoDragDrop;
    let data = data_object(paths)?;
    SHDoDragDrop(Some(hwnd), &data, None, DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK)?;
    Ok(())
}

pub fn page_ready(app: &AppHandle, label: &str) {
    if label == LABEL {
        READY.store(true, Ordering::SeqCst);
        bridge::emit(app, LABEL, "shelf:edge", json!([edge_name()]));
        push(app);
    } else if label == "clipboard" {
        clipboard::page_ready(app);
    }
}

fn arg_str(args: &[Value], i: usize) -> String {
    args.get(i).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn arg_paths(args: &[Value], i: usize) -> Vec<String> {
    args.get(i).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Page messages from the shelf and the clipboard popover. `false` if the channel isn't ours.
pub fn send(app: &AppHandle, label: &str, channel: &str, args: &[Value]) -> bool {
    match (label, channel) {
        ("shelf", "shelf:add") => add(app, arg_paths(args, 0)),
        ("shelf", "shelf:remove") => remove(app, &arg_paths(args, 0)),
        ("shelf", "shelf:clear") => close(app),
        ("shelf", "shelf:collapse") => set_collapsed(app, args.first().and_then(Value::as_bool).unwrap_or(false)),
        ("shelf", "shelf:height") => {
            if let Some(h) = args.first().and_then(Value::as_f64).filter(|h| h.is_finite()) {
                let collapsed = {
                    let mut s = SHELF.lock().unwrap();
                    s.content_height = h.round();
                    s.collapsed
                };
                if !collapsed {
                    place(app);
                }
            }
        }
        // Only what is on the shelf: opening is launching, so the page can't run anything else.
        ("shelf", "shelf:open") => {
            let p = arg_str(args, 0);
            if on_shelf(&p) {
                win::open_path(&p);
            }
        }
        ("shelf", "shelf:reveal") => {
            let p = arg_str(args, 0);
            if on_shelf(&p) {
                win::reveal(&p);
            }
        }
        ("shelf", "shelf:drag") => drag_out(app, arg_paths(args, 0)),
        ("clipboard", "clip:height") => {
            let h = args.first().and_then(Value::as_f64).unwrap_or(260.0);
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || clipboard::place(&app2, h));
        }
        ("clipboard", "clip:close") => clipboard::hide(app, true),
        ("clipboard", "clip:action") => clipboard::action(app, &arg_str(args, 0)),
        _ => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    /// The drag-out data object carries every file as CF_HDROP (run with `-- --ignored`).
    #[test]
    #[ignore]
    fn data_object_has_all_files_as_hdrop() {
        use windows::Win32::System::Com::*;
        use windows::Win32::System::Ole::*;
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
        unsafe {
            let _ = OleInitialize(None);
            let d = std::env::temp_dir().join(format!("orange-shelf-{}", std::process::id()));
            std::fs::create_dir_all(d.join("sub")).unwrap();
            let a = d.join("a.txt");
            std::fs::write(&a, "a").unwrap();
            let b = d.join("sub").join("b.txt");
            std::fs::write(&b, "b").unwrap();
            let paths = vec![a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()];
            let obj = super::data_object(&paths).unwrap();
            let fmt = FORMATETC { cfFormat: 15, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 };
            let mut med = obj.GetData(&fmt).unwrap();
            let hd = HDROP(med.u.hGlobal.0);
            let n = DragQueryFileW(hd, u32::MAX, None);
            let mut got = Vec::new();
            for i in 0..n {
                let mut buf = vec![0u16; 1024];
                let l = DragQueryFileW(hd, i, Some(&mut buf)) as usize;
                got.push(String::from_utf16_lossy(&buf[..l]));
            }
            ReleaseStgMedium(&mut med);
            let _ = std::fs::remove_dir_all(&d);
            assert_eq!(got, paths);
        }
    }
}
