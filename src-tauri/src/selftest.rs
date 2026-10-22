//! End-to-end self-test of the drag-and-drop path, built only with `--features selftest`.
//!
//! `Orange.exe --selftest <file.png> <result.json>`:
//! 1. feeds synthetic input (press, move, Shift tap) through the same drag state machine the hooks
//!    use, so the real wheel opens under the current cursor (the cursor is never moved);
//! 2. finds the IDropTarget that wry registered on the wheel's windows (the `OleDropTargetInterface`
//!    window property set by `RegisterDragDrop`) and calls DragEnter / DragOver / Drop on it with
//!    the shell's own data object for the file (what Explorer hands to DoDragDrop), at the screen
//!    point of the JPG slice;
//! 3. waits for the conversion to finish, writes measurements and exits.
//!
//! OLE keeps the raw interface pointer in that property only for the owning process, so this must
//! run in-process; a separate harness process cannot call it.

use crate::drag::{Button, Input, Key, Mod};
use crate::{hooks, wheel, AppState};
use serde_json::json;
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use windows::core::{w, Interface, HSTRING};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL, RECT};
use windows::Win32::System::Com::IDataObject;
use windows::Win32::System::Ole::{IDropTarget, DROPEFFECT, DROPEFFECT_COPY};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Shell::{BHID_DataObject, IShellItem, SHCreateItemFromParsingName};
use windows::Win32::UI::WindowsAndMessaging::*;

thread_local! {
    static DROP: RefCell<Option<(IDropTarget, IDataObject)>> = const { RefCell::new(None) };
}

fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .expect("main thread");
    rx.recv().expect("main thread result")
}

fn wait(timeout: Duration, mut ok: impl FnMut() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < timeout {
        if ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

unsafe fn children(hwnd: HWND) -> Vec<HWND> {
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> windows::core::BOOL {
        (*(l.0 as *mut Vec<HWND>)).push(h);
        true.into()
    }
    let mut v = vec![hwnd];
    let _ = EnumChildWindows(Some(hwnd), Some(cb), LPARAM(&mut v as *mut _ as isize));
    v
}

fn class_of(h: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// Does a screen point hit this window (or one of its children)? This is what OLE uses to pick
/// the drop target, so it tells whether transparent pixels still accept drops.
fn hits(root: HWND, x: i32, y: i32) -> (bool, String) {
    unsafe {
        let h = WindowFromPoint(POINT { x, y });
        let top = GetAncestor(h, GA_ROOT);
        (top == root, class_of(h))
    }
}

pub fn maybe_start(app: &AppHandle, started: Instant) {
    let args: Vec<String> = std::env::args().collect();
    let Some(i) = args.iter().position(|a| a == "--selftest") else { return };
    let file = PathBuf::from(&args[i + 1]);
    let out = PathBuf::from(&args[i + 2]);
    let app = app.clone();
    std::thread::spawn(move || {
        let dir = out.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let res = run(&app, &file, &dir, started);
        let _ = std::fs::write(&out, serde_json::to_string_pretty(&res).unwrap());
        app.exit(if res["ok"].as_bool() == Some(true) { 0 } else { 1 });
    });
}

fn capture(r: RECT, path: &std::path::Path) -> bool {
    use windows::Win32::Graphics::Gdi::*;
    unsafe {
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let _ = BitBlt(mem, 0, 0, w, h, Some(screen), r.left, r.top, SRCCOPY);
        SelectObject(mem, old);
        let px = crate::win::bitmap_rgba(bmp);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        let Some((w, h, mut px)) = px else { return false };
        for p in px.chunks_exact_mut(4) {
            p[3] = 255;
        }
        image::RgbaImage::from_raw(w, h, px).is_some_and(|img| img.save(path).is_ok())
    }
}

fn run(app: &AppHandle, file: &PathBuf, out_dir: &std::path::Path, started: Instant) -> serde_json::Value {
    let st = app.state::<AppState>();
    let ready = wait(Duration::from_secs(15), || st.wheel.is_ready());
    let ready_ms = started.elapsed().as_secs_f64() * 1000.0;
    if !ready {
        return json!({ "ok": false, "error": "wheel page never loaded" });
    }
    std::thread::sleep(Duration::from_millis(5000)); // settle, and let the hidden wheel be trimmed, as before a real drag

    // 1. Synthetic drag + Shift tap, through the hooks' state machine.
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    let shown_before = st.wheel.shown_count.load(Ordering::SeqCst);
    hooks::inject(vec![
        Input::Down(Button::Left, p.x, p.y),
        Input::Move(p.x + 6, p.y + 2),
        Input::Move(p.x + 12, p.y + 4),
        Input::KeyDown(Key::Mod(Mod::Shift, 0xA0)),
    ]);
    if !wait(Duration::from_secs(5), || st.wheel.shown_count.load(Ordering::SeqCst) > shown_before) {
        return json!({ "ok": false, "error": "wheel did not open" });
    }
    let latency_ms = st.wheel.last_latency_us.load(Ordering::SeqCst) as f64 / 1000.0;
    std::thread::sleep(Duration::from_millis(250)); // the open animation

    // 2. Geometry: where the JPG slice is on screen (slice 0, at 12 o'clock for a PNG).
    let w = app.get_webview_window(wheel::LABEL).unwrap();
    let hwnd = w.hwnd().unwrap();
    let hwnd_raw = hwnd.0 as isize;
    let mut r = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd, &mut r);
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let at = |x: f64, y: f64| (r.left + (x * scale).round() as i32, r.top + (y * scale).round() as i32);
    let slice = at(220.0, 220.0 - 136.0);
    let corner = at(4.0, 4.0);
    let visible = unsafe { IsWindowVisible(hwnd).as_bool() };
    let fg_is_wheel = unsafe { GetForegroundWindow() } == hwnd;
    let (hit_slice, slice_class) = hits(hwnd, slice.0, slice.1);
    let (hit_corner, corner_class) = hits(hwnd, corner.0, corner.1);
    // A screen capture of the open wheel (shows that it renders and its corners are see-through).
    let shot = out_dir.join("wheel-capture.png");
    let captured = capture(r, &shot);

    // 3. Find the registered drop targets and the shell data object, then drive the drop.
    let path = file.to_string_lossy().into_owned();
    let (sx, sy) = slice;
    let found: Result<(Vec<(String, bool)>, String), String> = on_main(app, move || unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        let mut found = Vec::new();
        for h in children(hwnd) {
            let mut r = RECT::default();
            let _ = GetWindowRect(h, &mut r);
            let mut o = POINT::default();
            let _ = windows::Win32::Graphics::Gdi::ClientToScreen(h, &mut o);
            let desc = format!("{} win=({},{})-({},{}) client@({},{})", class_of(h), r.left, r.top, r.right, r.bottom, o.x, o.y);
            found.push((desc, !GetPropW(h, w!("OleDropTargetInterface")).0.is_null()));
        }
        // Pick the target the way DoDragDrop does: the window under the point, then up its
        // parents until one has a registered drop target.
        let mut h = WindowFromPoint(POINT { x: sx, y: sy });
        let mut chosen: Option<(IDropTarget, String)> = None;
        while !h.0.is_null() {
            let raw = GetPropW(h, w!("OleDropTargetInterface"));
            if !raw.0.is_null() {
                chosen = IDropTarget::from_raw_borrowed(&raw.0).cloned().map(|t| (t, class_of(h)));
                break;
            }
            h = GetParent(h).unwrap_or_default();
        }
        let Some((target, class)) = chosen else { return Err(format!("no drop target under the slice: {found:?}")) };
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(path.as_str()), None).map_err(|e| e.to_string())?;
        let data: IDataObject = item.BindToHandler(None, &BHID_DataObject).map_err(|e| e.to_string())?;
        DROP.with(|d| *d.borrow_mut() = Some((target, data)));
        Ok((found, class))
    });
    let (found, target_class) = match found {
        Ok(f) => f,
        Err(e) => return json!({ "ok": false, "error": e }),
    };

    let call = |step: &'static str, x: i32, y: i32| -> Result<u32, String> {
        on_main(app, move || unsafe {
            DROP.with(|d| {
                let d = d.borrow();
                let (t, data) = d.as_ref().unwrap();
                let pt = POINTL { x, y };
                let mut effect: DROPEFFECT = DROPEFFECT_COPY;
                let keys = MODIFIERKEYS_FLAGS(MK_LBUTTON.0);
                let r = match step {
                    "enter" => t.DragEnter(data, keys, pt, &mut effect),
                    "over" => t.DragOver(keys, pt, &mut effect),
                    "drop" => t.Drop(data, MODIFIERKEYS_FLAGS(0), pt, &mut effect),
                    _ => t.DragLeave(),
                };
                r.map(|_| effect.0).map_err(|e| e.to_string())
            })
        })
    };
    let t_drop = Instant::now();
    let enter = call("enter", slice.0, slice.1 + 30);
    std::thread::sleep(Duration::from_millis(60));
    let mut over = Vec::new();
    for k in 0..4 {
        over.push(call("over", slice.0, slice.1 + 30 - k * 10));
        std::thread::sleep(Duration::from_millis(30));
    }
    let dropped = call("drop", slice.0, slice.1);
    on_main(app, || DROP.with(|d| d.borrow_mut().take()).map(|_| ()));
    hooks::inject(vec![Input::Up(Button::Left)]);

    // 4. The conversion: the HUD reports the finished job.
    let done = wait(Duration::from_secs(20), || !st.hud.finished.lock().unwrap().is_empty());
    let convert_ms = t_drop.elapsed().as_secs_f64() * 1000.0;
    let finished = st.hud.finished.lock().unwrap().clone();
    let outputs: Vec<String> = finished.iter().flat_map(|r| r.outputs.clone().unwrap_or_default()).collect();
    let output_ok = outputs.iter().any(|o| o.to_lowercase().ends_with(".jpg") && std::path::Path::new(o).exists());
    let jpeg_valid = outputs.first().and_then(|o| image::open(o).ok()).is_some();
    std::thread::sleep(Duration::from_millis(600)); // the HUD shows "done"
    let hud_visible = app.get_webview_window("hud").and_then(|h| h.is_visible().ok()).unwrap_or(false);
    let wheel_hidden = !st.wheel.is_open();

    json!({
        "ok": done && output_ok && jpeg_valid && enter.is_ok() && dropped.is_ok(),
        "wheel_page_ready_ms": ready_ms,
        "wheel_open_latency_ms": latency_ms,
        "wheel_visible": visible,
        "wheel_took_focus": fg_is_wheel,
        "scale": scale,
        "wheel_rect": [r.left, r.top, r.right, r.bottom],
        "hit_test_slice": { "hits_wheel": hit_slice, "class": slice_class },
        "hit_test_transparent_corner": { "hits_wheel": hit_corner, "class": corner_class },
        "windows_with_drop_target": found,
        "drop_target_used": target_class,
        "screen_capture": if captured { shot.to_string_lossy().into_owned() } else { String::new() },
        "drag_enter_effect": format!("{enter:?}"),
        "drag_over_effects": format!("{over:?}"),
        "drop_effect": format!("{dropped:?}"),
        "drop_to_done_ms": convert_ms,
        "finished_rows": finished.iter().map(|r| json!({ "title": r.title, "state": format!("{:?}", r.state), "outputs": r.outputs, "errors": r.errors })).collect::<Vec<_>>(),
        "output_exists": output_ok,
        "output_decodes": jpeg_valid,
        "hud_visible_after_done": hud_visible,
        "wheel_closed_after_drop": wheel_hidden,
    })
}
