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
//! `Orange.exe --selftest-scenarios <result.json> [filter]` runs the scenario list in [`SCENARIOS`]
//! one after another in the same process (corner cancel, Ctrl switching the wheel, arrow keys plus
//! a drop on the hub, folder to ZIP, several files). Each makes its own fixtures next to the result
//! file. Scenarios whose feature isn't ported yet are reported as `"ignored"` (set
//! `ORANGE_SELFTEST_PENDING=1` to run them anyway). No real input is ever sent: modifier taps go
//! through `hooks::inject`, arrow keys through `wheel::nav` (what the event loop does with them),
//! and the drop through the wheel's own IDropTarget.
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
    if let Some(i) = args.iter().position(|a| a == "--selftest-scenarios") {
        let out = PathBuf::from(args.get(i + 1).cloned().unwrap_or_else(|| "selftest.json".into()));
        let filter = args.get(i + 2).cloned().unwrap_or_default();
        let app = app.clone();
        std::thread::spawn(move || {
            let res = run_scenarios(&app, &out, &filter, started);
            let _ = std::fs::write(&out, serde_json::to_string_pretty(&res).unwrap());
            app.exit(if res["ok"].as_bool() == Some(true) { 0 } else { 1 });
        });
        return;
    }
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

// ------------------------------------------------------------------------------------------------
// Scenario list (`--selftest-scenarios`).

/// One self-test scenario. `pending` names the area a scenario waits on; it is reported as
/// ignored until that area is ported (or `ORANGE_SELFTEST_PENDING=1`).
pub struct Scenario {
    pub name: &'static str,
    pub pending: Option<&'static str>,
    run: fn(&Ctx) -> Result<serde_json::Value, String>,
}

pub const SCENARIOS: &[Scenario] = &[
    Scenario { name: "corner-drop-cancels", pending: None, run: sc_corner_cancels },
    Scenario { name: "ctrl-switches-wheel", pending: None, run: sc_ctrl_switches },
    Scenario { name: "arrows-then-hub-drop", pending: None, run: sc_arrows_hub_drop },
    Scenario { name: "folder-to-zip", pending: Some("tools"), run: sc_folder_zip },
    Scenario { name: "several-files", pending: None, run: sc_several_files },
];

pub struct Ctx {
    app: AppHandle,
    dir: PathBuf,
    /// Every `wheel:*` event the app emitted, in order: (channel, payload).
    events: std::sync::Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>,
}

/// Where things are on the open wheel, in screen pixels.
struct Geo {
    hwnd: isize,
    slice0: (i32, i32),
    hub: (i32, i32),
    corner: (i32, i32),
}

const LSHIFT: Key = Key::Mod(Mod::Shift, 0xA0);
const LCTRL: Key = Key::Mod(Mod::Ctrl, 0xA2);

impl Ctx {
    fn st(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    fn opened_kinds(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(c, _)| c == "wheel:open")
            .filter_map(|(_, p)| p.get(0).and_then(|o| o["wheel"].as_str()).map(String::from))
            .collect()
    }

    /// Back to a closed wheel with no finished jobs and no recorded events.
    fn reset(&self) {
        wheel::close(&self.app);
        wait(Duration::from_secs(3), || !self.st().wheel.is_open());
        std::thread::sleep(Duration::from_millis(300)); // the close animation and hide
        self.st().hud.finished.lock().unwrap().clear();
        self.events.lock().unwrap().clear();
    }

    /// A synthetic drag under the current cursor with these modifier taps, through the hooks'
    /// state machine; waits until the wheel has painted.
    fn open_drag(&self, taps: &[Key]) -> Result<Geo, String> {
        let st = self.st();
        let before = st.wheel.shown_count.load(Ordering::SeqCst);
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        let mut inputs = vec![Input::Down(Button::Left, p.x, p.y), Input::Move(p.x + 6, p.y + 2), Input::Move(p.x + 12, p.y + 4)];
        for k in taps {
            inputs.push(Input::KeyDown(*k));
            inputs.push(Input::KeyUp(*k));
        }
        hooks::inject(inputs);
        if !wait(Duration::from_secs(5), || st.wheel.shown_count.load(Ordering::SeqCst) > before) {
            return Err("wheel did not open".into());
        }
        // Wait for the last switch to be emitted, then the open animation.
        wait(Duration::from_secs(2), || self.opened_kinds().len() >= taps.len());
        std::thread::sleep(Duration::from_millis(250));
        let w = self.app.get_webview_window(wheel::LABEL).ok_or("no wheel window")?;
        let hwnd = w.hwnd().map_err(|e| e.to_string())?;
        let mut r = RECT::default();
        unsafe {
            let _ = GetWindowRect(hwnd, &mut r);
        }
        let scale = w.scale_factor().unwrap_or(1.0);
        let at = |x: f64, y: f64| (r.left + (x * scale).round() as i32, r.top + (y * scale).round() as i32);
        let c = wheel::SIZE / 2.0;
        Ok(Geo { hwnd: hwnd.0 as isize, slice0: at(c, c - 136.0), hub: at(c, c), corner: at(4.0, 4.0) })
    }

    /// Drives DragEnter, a few DragOvers approaching `to`, then Drop (or DragLeave when `leave`)
    /// on the wheel's registered drop target, with the shell's data object for `paths`.
    fn drop_on(&self, geo: &Geo, paths: &[PathBuf], to: (i32, i32), leave: bool) -> Result<serde_json::Value, String> {
        let hwnd_raw = geo.hwnd;
        let paths: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let probe = geo.slice0;
        on_main(&self.app, move || unsafe {
            let root = HWND(hwnd_raw as *mut _);
            // The target DoDragDrop would use for a point on the wheel: the window under the
            // slice, then up its parents to one with a registered drop target.
            let mut h = WindowFromPoint(POINT { x: probe.0, y: probe.1 });
            if GetAncestor(h, GA_ROOT) != root {
                h = root;
            }
            let mut target = None;
            while !h.0.is_null() {
                let raw = GetPropW(h, w!("OleDropTargetInterface"));
                if !raw.0.is_null() {
                    target = IDropTarget::from_raw_borrowed(&raw.0).cloned();
                    break;
                }
                h = GetParent(h).unwrap_or_default();
            }
            if target.is_none() {
                for c in children(root) {
                    let raw = GetPropW(c, w!("OleDropTargetInterface"));
                    if !raw.0.is_null() {
                        target = IDropTarget::from_raw_borrowed(&raw.0).cloned();
                        break;
                    }
                }
            }
            let target = target.ok_or("no drop target on the wheel")?;
            let data = data_object(&paths)?;
            DROP.with(|d| *d.borrow_mut() = Some((target, data)));
            Ok::<(), String>(())
        })?;
        let call = |step: &'static str, x: i32, y: i32| -> Result<u32, String> {
            on_main(&self.app, move || unsafe {
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
        let enter = call("enter", to.0, to.1 + 30);
        std::thread::sleep(Duration::from_millis(60));
        for k in 0..4 {
            let _ = call("over", to.0, to.1 + 30 - k * 10);
            std::thread::sleep(Duration::from_millis(30));
        }
        let last = if leave { call("leave", to.0, to.1) } else { call("drop", to.0, to.1) };
        on_main(&self.app, || DROP.with(|d| d.borrow_mut().take()).map(|_| ()));
        // The button went up: what the event loop does with the hooks' Release.
        wheel::release_soon(&self.app);
        Ok(json!({ "enter": format!("{enter:?}"), "last": format!("{last:?}") }))
    }

    /// Waits for `n` finished jobs and returns every output path.
    fn outputs(&self, n: usize, timeout: Duration) -> (bool, Vec<String>, serde_json::Value) {
        let st = self.st();
        let done = wait(timeout, || st.hud.finished.lock().unwrap().len() >= n);
        let rows = st.hud.finished.lock().unwrap().clone();
        let outs = rows.iter().flat_map(|r| r.outputs.clone().unwrap_or_default()).collect();
        let rows = rows.iter().map(|r| json!({ "title": r.title, "state": format!("{:?}", r.state), "outputs": r.outputs, "errors": r.errors })).collect();
        (done, outs, serde_json::Value::Array(rows))
    }
}

/// The shell data object for one or more paths (what Explorer hands to DoDragDrop).
unsafe fn data_object(paths: &[String]) -> Result<IDataObject, String> {
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{SHCreateShellItemArrayFromIDLists, SHParseDisplayName};
    if paths.len() == 1 {
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(paths[0].as_str()), None).map_err(|e| e.to_string())?;
        return item.BindToHandler(None, &BHID_DataObject).map_err(|e| e.to_string());
    }
    let mut pidls: Vec<*mut ITEMIDLIST> = Vec::new();
    let mut res = || -> Result<IDataObject, String> {
        for p in paths {
            let mut pidl = std::ptr::null_mut();
            SHParseDisplayName(&HSTRING::from(p.as_str()), None, &mut pidl, 0, None).map_err(|e| format!("{p}: {e}"))?;
            pidls.push(pidl);
        }
        let list: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| *p as *const _).collect();
        let arr = SHCreateShellItemArrayFromIDLists(&list).map_err(|e| e.to_string())?;
        let data: IDataObject = arr.BindToHandler(None, &BHID_DataObject).map_err(|e| e.to_string())?;
        Ok(data)
    };
    let res = res();
    for p in pidls {
        windows::Win32::System::Com::CoTaskMemFree(Some(p as *const _));
    }
    res
}

fn png_fixture(dir: &std::path::Path, name: &str, seed: u8) -> PathBuf {
    let p = dir.join(name);
    let img = image::RgbaImage::from_fn(64, 48, |x, y| image::Rgba([(x * 4) as u8 ^ seed, (y * 5) as u8, seed, 255]));
    let _ = img.save(&p);
    p
}

fn fresh_dir(ctx: &Ctx, name: &str) -> PathBuf {
    let d = ctx.dir.join(name);
    let _ = std::fs::remove_dir_all(&d);
    let _ = std::fs::create_dir_all(&d);
    d
}

fn check(cond: bool, msg: &str) -> Result<(), String> {
    if cond {
        Ok(())
    } else {
        Err(msg.to_string())
    }
}

/// Dropping on a transparent corner converts nothing and the wheel closes.
fn sc_corner_cancels(ctx: &Ctx) -> Result<serde_json::Value, String> {
    let dir = fresh_dir(ctx, "corner");
    let file = png_fixture(&dir, "corner.png", 1);
    let geo = ctx.open_drag(&[LSHIFT])?;
    let (hit, class) = hits(HWND(geo.hwnd as *mut _), geo.corner.0, geo.corner.1);
    // If the corner doesn't hit the wheel, OLE never asks it: the drag just leaves.
    let drop = ctx.drop_on(&geo, &[file], geo.corner, !hit)?;
    let closed = wait(Duration::from_secs(3), || !ctx.st().wheel.is_open());
    std::thread::sleep(Duration::from_millis(800)); // give a (wrong) conversion time to show up
    let (_, outs, rows) = ctx.outputs(1, Duration::from_millis(1));
    let left = std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0);
    check(closed, "wheel stayed open after a corner drop")?;
    check(outs.is_empty() && left == 1, "a corner drop produced output")?;
    Ok(json!({ "corner_hits_wheel": hit, "corner_class": class, "drop": drop, "rows": rows }))
}

/// Shift opens Convert; Ctrl in the same drag switches to Tools without closing.
fn sc_ctrl_switches(ctx: &Ctx) -> Result<serde_json::Value, String> {
    ctx.open_drag(&[LSHIFT, LCTRL])?;
    let kinds = ctx.opened_kinds();
    let open = ctx.st().wheel.is_open();
    let closes = ctx.events.lock().unwrap().iter().filter(|(c, _)| c == "wheel:close").count();
    check(kinds == ["convert", "tools"], &format!("wheels opened: {kinds:?}"))?;
    check(open && closes == 0, "the wheel closed while switching")?;
    Ok(json!({ "opened": kinds }))
}

/// Arrow keys move the selection; a drop on the hub runs the selected slice.
fn sc_arrows_hub_drop(ctx: &Ctx) -> Result<serde_json::Value, String> {
    let dir = fresh_dir(ctx, "arrows");
    let file = png_fixture(&dir, "arrows.png", 2);
    let geo = ctx.open_drag(&[LSHIFT])?;
    for k in ["right", "left", "up"] {
        wheel::nav(&ctx.app, k);
        std::thread::sleep(Duration::from_millis(60));
    }
    let navs: Vec<String> = ctx
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(c, _)| c == "wheel:nav")
        .filter_map(|(_, p)| p.get(0).and_then(|v| v.as_str()).map(String::from))
        .collect();
    let drop = ctx.drop_on(&geo, &[file], geo.hub, false)?;
    let (done, outs, rows) = ctx.outputs(1, Duration::from_secs(20));
    check(navs == ["right", "left", "up"], &format!("nav events: {navs:?}"))?;
    check(done, "no job finished after the hub drop")?;
    check(outs.iter().any(|o| std::path::Path::new(o).exists()), "the hub drop wrote nothing")?;
    Ok(json!({ "navs": navs, "drop": drop, "rows": rows }))
}

/// A folder dropped on the Tools wheel's hub (Compress is its default) becomes a ZIP.
fn sc_folder_zip(ctx: &Ctx) -> Result<serde_json::Value, String> {
    let dir = fresh_dir(ctx, "folder");
    let folder = dir.join("Holiday photos");
    let _ = std::fs::create_dir_all(folder.join("sub"));
    png_fixture(&folder, "a.png", 3);
    png_fixture(&folder.join("sub"), "b.png", 4);
    let geo = ctx.open_drag(&[LCTRL])?;
    let drop = ctx.drop_on(&geo, &[folder], geo.hub, false)?;
    let (done, outs, rows) = ctx.outputs(1, Duration::from_secs(30));
    let zip = outs.iter().find(|o| o.to_lowercase().ends_with(".zip")).cloned();
    let magic = zip.as_ref().and_then(|z| std::fs::read(z).ok()).is_some_and(|b| b.starts_with(b"PK\x03\x04"));
    check(done && magic, "no valid ZIP from the folder drop")?;
    Ok(json!({ "zip": zip, "drop": drop, "rows": rows }))
}

/// Three files dropped on the JPG slice give three JPGs in one job.
fn sc_several_files(ctx: &Ctx) -> Result<serde_json::Value, String> {
    let dir = fresh_dir(ctx, "several");
    let files: Vec<PathBuf> = (0..3).map(|i| png_fixture(&dir, &format!("f{i}.png"), 10 + i)).collect();
    let geo = ctx.open_drag(&[LSHIFT])?;
    let drop = ctx.drop_on(&geo, &files, geo.slice0, false)?;
    let (done, outs, rows) = ctx.outputs(1, Duration::from_secs(30));
    let jpgs = outs.iter().filter(|o| o.to_lowercase().ends_with(".jpg") && image::open(o).is_ok()).count();
    check(done && jpgs == 3, &format!("{jpgs} of 3 JPGs written"))?;
    Ok(json!({ "jpgs": jpgs, "drop": drop, "rows": rows }))
}

fn run_scenarios(app: &AppHandle, out: &std::path::Path, filter: &str, started: Instant) -> serde_json::Value {
    use tauri::Listener;
    let st = app.state::<AppState>();
    if !wait(Duration::from_secs(15), || st.wheel.is_ready()) {
        return json!({ "ok": false, "error": "wheel page never loaded" });
    }
    let ready_ms = started.elapsed().as_secs_f64() * 1000.0;
    std::thread::sleep(Duration::from_millis(3000)); // settle, as before a real drag
    let dir = out.parent().map(|p| p.join("selftest-fixtures")).unwrap_or_else(|| PathBuf::from("selftest-fixtures"));
    let _ = std::fs::create_dir_all(&dir);
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    for ch in ["wheel:open", "wheel:close", "wheel:nav"] {
        let ev = events.clone();
        app.listen_any(ch, move |e| {
            let payload = serde_json::from_str(e.payload()).unwrap_or(serde_json::Value::Null);
            ev.lock().unwrap().push((ch.to_string(), payload));
        });
    }
    let ctx = Ctx { app: app.clone(), dir, events };
    let run_pending = std::env::var("ORANGE_SELFTEST_PENDING").as_deref() == Ok("1");
    let (mut passed, mut failed, mut ignored) = (0, 0, 0);
    let mut results = Vec::new();
    for s in SCENARIOS.iter().filter(|s| filter.is_empty() || s.name.contains(filter)) {
        if let (Some(area), false) = (s.pending, run_pending) {
            ignored += 1;
            results.push(json!({ "name": s.name, "status": "ignored", "reason": format!("pending {area}") }));
            continue;
        }
        ctx.reset();
        let t = Instant::now();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (s.run)(&ctx))).unwrap_or_else(|_| Err("panicked".into()));
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        match r {
            Ok(detail) => {
                passed += 1;
                results.push(json!({ "name": s.name, "status": "passed", "ms": ms, "detail": detail }));
            }
            Err(e) => {
                failed += 1;
                results.push(json!({ "name": s.name, "status": "failed", "ms": ms, "error": e }));
            }
        }
    }
    ctx.reset();
    json!({
        "ok": failed == 0 && passed > 0,
        "wheel_page_ready_ms": ready_ms,
        "passed": passed, "failed": failed, "ignored": ignored,
        "scenarios": results,
    })
}
