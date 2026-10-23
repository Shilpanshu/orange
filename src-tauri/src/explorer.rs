//! Explorer integration, in-process (1.x ran this in a C# sidekick, OrangeHelper.cs):
//! - the selection of the Explorer window (or desktop) in front, through IShellWindows;
//! - files on the clipboard as CF_HDROP marked "copy" (see `clipboard::put_files`);
//! - the Windows share sheet, through IDataTransferManagerInterop;
//! - the Recycle Bin, through IFileOperation.
//!
//! Shell COM objects want a single-threaded apartment, and the first Shell call of a session costs
//! ~120 ms, so selection and recycling run on one long-lived STA worker thread.

use crate::log;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

type Task = Box<dyn FnOnce() + Send>;

fn worker() -> &'static Mutex<Sender<Task>> {
    static W: OnceLock<Mutex<Sender<Task>>> = OnceLock::new();
    W.get_or_init(|| {
        let (tx, rx) = channel::<Task>();
        std::thread::Builder::new()
            .name("orange-shell".into())
            .spawn(move || {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                }
                for t in rx {
                    t();
                }
            })
            .expect("shell thread");
        Mutex::new(tx)
    })
}

/// Runs `f` on the shell thread and waits up to `timeout` for its answer.
fn on_shell<T: Send + 'static>(timeout: Duration, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = channel();
    worker().lock().unwrap().send(Box::new(move || {
        let _ = tx.send(f());
    })).ok()?;
    rx.recv_timeout(timeout).ok()
}

/// Pays the first Shell COM call now, so the first wheel of the day gets exact files.
pub fn warm_up() {
    std::thread::spawn(|| {
        let _ = on_shell(Duration::from_secs(5), || unsafe { selection_now() });
    });
}

// ------------------------------------------------------------------ selection

/// The selected items of the Explorer window (or desktop) in front. Empty when it isn't Explorer.
pub fn selection() -> Vec<String> {
    on_shell(Duration::from_millis(1500), || unsafe { selection_now() }.unwrap_or_else(|e| {
        log::write(&format!("selection failed: {e}"));
        Vec::new()
    }))
    .unwrap_or_default()
}

unsafe fn class_of(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = GetClassNameW(h, &mut buf);
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

unsafe fn selection_now() -> windows::core::Result<Vec<String>> {
    selection_of(GetForegroundWindow())
}

/// The selection of one top-level window (Explorer or the desktop).
pub fn selection_for(h: isize) -> Vec<String> {
    on_shell(Duration::from_millis(1500), move || unsafe { selection_of(HWND(h as *mut _)) }.unwrap_or_else(|e| {
        log::write(&format!("selection failed: {e}"));
        Vec::new()
    }))
    .unwrap_or_default()
}

unsafe fn selection_of(fg: HWND) -> windows::core::Result<Vec<String>> {
    let cls = class_of(fg);
    let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
    if cls == "Progman" || cls == "WorkerW" {
        // The desktop is a special shell view; reach it through FindWindowSW.
        let loc = VARIANT::from(0i32); // CSIDL_DESKTOP
        let root = VARIANT::default();
        let mut hwnd = 0i32;
        let disp = windows.FindWindowSW(&loc, &root, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)?;
        return Ok(view_selection(&disp, None)?.unwrap_or_default());
    }
    if cls != "CabinetWClass" && cls != "ExploreWClass" {
        return Ok(Vec::new());
    }
    for i in 0..windows.Count()? {
        let Ok(disp) = windows.Item(&VARIANT::from(i)) else { continue };
        // Windows 11 Explorer tabs share one top-level window: only the visible tab counts.
        if let Ok(Some(paths)) = view_selection(&disp, Some(fg)) {
            return Ok(paths);
        }
    }
    Ok(Vec::new())
}

/// The selection of one shell window; `None` when it isn't the window (and tab) wanted.
unsafe fn view_selection(disp: &IDispatch, want: Option<HWND>) -> windows::core::Result<Option<Vec<String>>> {
    let sp: windows::Win32::System::Com::IServiceProvider = disp.cast()?;
    let browser: IShellBrowser = sp.QueryService(&SID_STopLevelBrowser)?;
    let view = browser.QueryActiveShellView()?;
    if let Some(fg) = want {
        // The browser's own window is the tab inside Explorer's frame: compare the frame.
        if GetAncestor(browser.GetWindow()?, GA_ROOT) != fg || !IsWindowVisible(view.GetWindow()?).as_bool() {
            return Ok(None);
        }
    }
    let fv: IFolderView2 = view.cast()?;
    let Ok(items) = fv.GetSelection(false) else { return Ok(Some(Vec::new())) };
    Ok(Some(item_paths(&items)))
}

unsafe fn item_paths(items: &IShellItemArray) -> Vec<String> {
    let mut out = Vec::new();
    for i in 0..items.GetCount().unwrap_or(0) {
        let Ok(item) = items.GetItemAt(i) else { continue };
        let Ok(p) = item.GetDisplayName(SIGDN_FILESYSPATH) else { continue };
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const _));
        if !s.is_empty() && std::path::Path::new(&s).exists() {
            out.push(s);
        }
    }
    out
}

// ---------------------------------------------------------------- recycle bin

/// Moves paths to the Recycle Bin (never deletes outright). Errors if any could not be recycled.
pub fn recycle(paths: Vec<String>) -> Result<(), String> {
    on_shell(Duration::from_secs(120), move || unsafe { recycle_now(&paths) })
        .unwrap_or_else(|| Err("The Recycle Bin did not answer".into()))
}

unsafe fn recycle_now(paths: &[String]) -> Result<(), String> {
    let e = |e: windows::core::Error| e.message();
    let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(e)?;
    let flags = FOF_ALLOWUNDO.0 as u32 | FOF_NOCONFIRMATION.0 as u32 | FOF_SILENT.0 as u32 | FOF_NOERRORUI.0 as u32 | FOFX_RECYCLEONDELETE.0 as u32 | FOFX_EARLYFAILURE.0 as u32;
    op.SetOperationFlags(FILEOPERATION_FLAGS(flags)).map_err(e)?;
    let mut any = false;
    for p in paths {
        if !std::path::Path::new(p).exists() {
            continue;
        }
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(p.as_str()), None).map_err(e)?;
        op.DeleteItem(&item, None).map_err(e)?;
        any = true;
    }
    if !any {
        return Ok(());
    }
    op.PerformOperations().map_err(e)?;
    if op.GetAnyOperationsAborted().map_err(e)?.as_bool() {
        return Err("Some items were not moved to the Recycle Bin".into());
    }
    Ok(())
}

// ------------------------------------------------------------- owner window

/// A tiny invisible tool window at the cursor, brought to the foreground so the UI Orange opens
/// for it (the share sheet, the folder picker) appears in front of the app the user is in.
pub struct Owner(pub HWND);

impl Owner {
    pub unsafe fn new(title: &str) -> windows::core::Result<Owner> {
        static CLASS: OnceLock<()> = OnceLock::new();
        let hinst = windows::Win32::System::LibraryLoader::GetModuleHandleW(None)?;
        let name = windows::core::w!("OrangeOwner");
        CLASS.get_or_init(|| {
            let wc = WNDCLASSW { lpfnWndProc: Some(owner_proc), hInstance: hinst.into(), lpszClassName: name, ..Default::default() };
            RegisterClassW(&wc);
        });
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_LAYERED,
            name,
            &HSTRING::from(title),
            WS_POPUP,
            p.x,
            p.y,
            1,
            1,
            None,
            None,
            Some(hinst.into()),
            None,
        )?;
        // Fully transparent but "shown", so it can own and anchor the system UI.
        let _ = windows::Win32::UI::WindowsAndMessaging::SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        let attach = fg_thread != 0 && fg_thread != me;
        if attach {
            let _ = AttachThreadInput(me, fg_thread, true);
        }
        let _ = SetForegroundWindow(hwnd);
        if attach {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        Ok(Owner(hwnd))
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}

unsafe extern "system" fn owner_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    DefWindowProcW(h, m, w, l)
}

/// Pumps messages until `done` says stop or `limit` passes.
unsafe fn pump(limit: Duration, mut done: impl FnMut() -> bool) {
    let until = std::time::Instant::now() + limit;
    let mut msg = MSG::default();
    while std::time::Instant::now() < until && !done() {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = MsgWaitForMultipleObjects(None, false, 50, QS_ALLINPUT);
    }
}

// ----------------------------------------------------------------- folder pick

/// The system folder picker, in front of the user's app. `None` when cancelled.
pub fn pick_folder(title: &str, ok_label: &str, start: Option<&str>) -> Option<String> {
    let (title, ok_label, start) = (title.to_string(), ok_label.to_string(), start.map(str::to_string));
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let owner = Owner::new(&title).ok();
        let r = (|| -> windows::core::Result<Option<String>> {
            let d: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_ALL)?;
            d.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_DONTADDTORECENT | FOS_PATHMUSTEXIST)?;
            d.SetTitle(&HSTRING::from(title.as_str()))?;
            d.SetOkButtonLabel(&HSTRING::from(ok_label.as_str()))?;
            if let Some(s) = start.as_deref() {
                if let Ok(f) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(s), None) {
                    let _ = d.SetFolder(&f);
                }
            }
            if d.Show(owner.as_ref().map(|o| o.0)).is_err() {
                return Ok(None); // cancelled
            }
            let item = d.GetResult()?;
            let p = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            Ok(Some(s))
        })();
        drop(owner);
        CoUninitialize();
        r.unwrap_or_else(|e| {
            log::write(&format!("folder picker failed: {e}"));
            None
        })
    })
    .join()
    .ok()
    .flatten()
}

// ---------------------------------------------------------------------- share

/// For the self-check: the owner window of the share sheet that is open now, if any.
pub static SHARE_OWNER: Mutex<isize> = Mutex::new(0);

/// Opens the Windows share sheet for `paths` (Nearby Share, Mail, apps). Returns once the sheet is
/// up; a background thread keeps its owner window alive until the sheet is done with the data.
pub fn share(paths: Vec<String>) -> Result<&'static str, String> {
    let existing: Vec<String> = paths.into_iter().filter(|p| std::path::Path::new(p).exists()).collect();
    if existing.is_empty() {
        return Err("Nothing to share".into());
    }
    let (tx, rx) = channel::<Result<(), String>>();
    let files = existing.clone();
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        share_thread(files, tx);
        CoUninitialize();
    });
    match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(())) => Ok("sheet"),
        other => {
            let why = match other {
                Ok(Err(e)) => e,
                _ => "the share sheet did not open".into(),
            };
            log::write(&format!("share sheet failed: {why}"));
            // Last resort: Explorer's own share verb on the first file.
            if share_verb(&existing[0]) {
                Ok("verb")
            } else {
                Err(why)
            }
        }
    }
}

unsafe fn share_thread(files: Vec<String>, tx: Sender<Result<(), String>>) {
    use windows::ApplicationModel::DataTransfer::*;
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::{IStorageItem, StorageFile, StorageFolder};

    let setup = || -> windows::core::Result<(Owner, DataTransferManager, std::sync::Arc<std::sync::atomic::AtomicU8>)> {
        // Resolve the files first (the sheet asks for them synchronously).
        let mut items: Vec<Option<IStorageItem>> = Vec::new();
        for p in &files {
            let h = HSTRING::from(p.as_str());
            let item: IStorageItem = if std::path::Path::new(p).is_dir() {
                StorageFolder::GetFolderFromPathAsync(&h)?.join()?.cast()?
            } else {
                StorageFile::GetFileFromPathAsync(&h)?.join()?.cast()?
            };
            items.push(Some(item));
        }
        let owner = Owner::new("Orange share")?;
        let interop = windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>()?;
        let dtm: DataTransferManager = interop.GetForWindow(owner.0)?;
        let title = if files.len() == 1 {
            std::path::Path::new(&files[0]).file_name().unwrap_or_default().to_string_lossy().into_owned()
        } else {
            format!("{} files", files.len())
        };
        let desc = if files.len() == 1 {
            files[0].clone()
        } else {
            std::path::Path::new(&files[0]).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
        };
        // 0 = open, 1 = an app was chosen, 2 = done
        let state = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(0));
        let list: windows_collections::IIterable<IStorageItem> = items.into();
        let list = windows::core::AgileReference::new(&list)?;
        dtm.DataRequested(&TypedEventHandler::new(move |_, args: windows::core::Ref<DataRequestedEventArgs>| {
            if let Some(args) = args.as_ref() {
                let data = args.Request()?.Data()?;
                let props = data.Properties()?;
                props.SetTitle(&HSTRING::from(title.as_str()))?;
                props.SetDescription(&HSTRING::from(desc.as_str()))?;
                data.SetStorageItems(&list.resolve()?, true)?;
            }
            Ok(())
        }))?;
        let s2 = state.clone();
        dtm.TargetApplicationChosen(&TypedEventHandler::new(move |_, _| {
            s2.store(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }))?;
        interop.ShowShareUIForWindow(owner.0)?;
        Ok((owner, dtm, state))
    };
    match setup() {
        Ok((owner, _dtm, state)) => {
            *SHARE_OWNER.lock().unwrap() = owner.0 .0 as isize;
            let _ = tx.send(Ok(()));
            // Keep the owner alive while the sheet is open; once an app is chosen it owns the data,
            // so give it a moment and go. Three minutes at most either way.
            let start = std::time::Instant::now();
            let mut chosen_at: Option<std::time::Instant> = None;
            pump(Duration::from_secs(180), || {
                if !IsWindow(Some(owner.0)).as_bool() {
                    return true;
                }
                if chosen_at.is_none() && state.load(std::sync::atomic::Ordering::SeqCst) == 1 {
                    chosen_at = Some(std::time::Instant::now());
                }
                chosen_at.is_some_and(|t| t.elapsed() > Duration::from_secs(20)) || start.elapsed() > Duration::from_secs(180)
            });
            *SHARE_OWNER.lock().unwrap() = 0;
            drop(owner);
        }
        Err(e) => {
            let _ = tx.send(Err(e.message()));
        }
    }
}

/// Explorer's "Share" verb on one file, for when the sheet can't be reached directly.
fn share_verb(path: &str) -> bool {
    unsafe {
        let verb = HSTRING::from("Windows.ModernShare");
        let file = HSTRING::from(path);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_FLAG_NO_UI,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        ShellExecuteExW(&mut info).is_ok()
    }
}

/// Closes an open share sheet (the self-check only; users close it themselves).
pub fn close_share_sheet() {
    let h = *SHARE_OWNER.lock().unwrap();
    if h != 0 {
        unsafe {
            let _ = PostMessageW(Some(HWND(h as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

#[allow(dead_code)]
fn _unused(_: PWSTR) {}

#[cfg(test)]
mod tests {
    /// Real-files check of the Recycle Bin path (run with `cargo test -- --ignored`).
    #[test]
    #[ignore]
    fn recycle_moves_a_file_to_the_bin() {
        let dir = std::env::temp_dir().join(format!("orange-recycle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("orange recycle test.txt");
        std::fs::write(&f, "x").unwrap();
        super::recycle(vec![f.to_string_lossy().into_owned()]).unwrap();
        assert!(!f.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn visible_windows() -> Vec<(isize, String, String)> {
        use windows::Win32::Foundation::*;
        use windows::Win32::UI::WindowsAndMessaging::*;
        unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> windows::core::BOOL {
            let v = &mut *(l.0 as *mut Vec<(isize, String, String)>);
            if IsWindowVisible(h).as_bool() {
                let mut t = [0u16; 256];
                let n = GetWindowTextW(h, &mut t);
                v.push((h.0 as isize, String::from_utf16_lossy(&t[..n as usize]), super::class_of(h)));
            }
            true.into()
        }
        let mut v = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut v as *mut _ as isize));
        }
        v
    }

    /// Opens the real share sheet once, checks it appeared, then closes it.
    #[test]
    #[ignore]
    fn share_sheet_opens_and_closes() {
        let f = std::env::temp_dir().join("orange share test.txt");
        std::fs::write(&f, "share me").unwrap();
        let before = visible_windows();
        let r = super::share(vec![f.to_string_lossy().into_owned()]);
        std::thread::sleep(std::time::Duration::from_secs(4));
        let new: Vec<_> = visible_windows().into_iter().filter(|w| !before.iter().any(|b| b.0 == w.0)).collect();
        eprintln!("share result {r:?}; new windows {new:?}");
        super::close_share_sheet();
        // Closing the owner leaves the sheet up: close the frame windows that appeared with it.
        for (h, _, c) in &new {
            if c == "ApplicationFrameWindow" || c == "ProxyModalWindow" {
                unsafe {
                    let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(Some(windows::Win32::Foundation::HWND(*h as *mut _)), windows::Win32::UI::WindowsAndMessaging::WM_CLOSE, Default::default(), Default::default());
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
        let still: Vec<_> = visible_windows().into_iter().filter(|w| new.iter().any(|n| n.0 == w.0)).collect();
        eprintln!("still open after close: {still:?}");
        assert_eq!(r, Ok("sheet"));
        let _ = std::fs::remove_file(&f);
    }

    /// Opens Explorer on a temp folder with two files selected and reads the selection back.
    #[test]
    #[ignore]
    fn selection_reads_explorer_in_front() {
        let d = std::env::temp_dir().join(format!("orange-sel-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let a = d.join("one.txt");
        std::fs::write(&a, "1").unwrap();
        let _ = std::process::Command::new("explorer.exe").arg(format!("/select,{}", a.display())).spawn();
        let mut got = Vec::new();
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let fg = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
            got = super::selection();
            if got.is_empty() {
                // A test process may not be allowed to bring Explorer to the front: ask its window.
                let mine = visible_windows().into_iter().find(|(_, t, c)| c == "CabinetWClass" && t.contains("orange-sel-"));
                eprintln!("front is {:?}; explorer window {mine:?}", unsafe { super::class_of(fg) });
                if let Some((h, _, _)) = mine {
                    got = super::selection_for(h);
                }
            }
            if !got.is_empty() {
                break;
            }
        }
        eprintln!("selection {got:?}");
        // Close that Explorer window again.
        for (h, t, c) in visible_windows() {
            if c == "CabinetWClass" && t.contains(&format!("orange-sel-{}", std::process::id())) {
                unsafe {
                    let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(Some(windows::Win32::Foundation::HWND(h as *mut _)), windows::Win32::UI::WindowsAndMessaging::WM_CLOSE, Default::default(), Default::default());
                }
            }
        }
        assert_eq!(got.len(), 1);
        assert_eq!(std::fs::canonicalize(&got[0]).unwrap(), std::fs::canonicalize(&a).unwrap());
        std::thread::sleep(std::time::Duration::from_secs(1));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    #[ignore]
    fn selection_does_not_fail_without_explorer_in_front() {
        let _ = super::selection();
    }
}

// ------------------------------------------------------- selection during a drag

/// (drag number, its selection once read)
static DRAG_SEL: Mutex<(u64, Option<Vec<String>>)> = Mutex::new((0, None));
static DRAG_READY: std::sync::Condvar = std::sync::Condvar::new();

/// A drag just started: read the Explorer selection now, while the source window is still in
/// front, so the wheel can show options for the exact files instead of guessing from MIME types.
pub fn drag_started() {
    let seq = {
        let mut s = DRAG_SEL.lock().unwrap();
        s.0 += 1;
        s.1 = None;
        s.0
    };
    std::thread::spawn(move || {
        let paths = selection();
        let mut s = DRAG_SEL.lock().unwrap();
        if s.0 == seq {
            s.1 = Some(paths);
            DRAG_READY.notify_all();
        }
    });
}

/// The wheel opened for the current drag: hand it the selection as soon as it is known. A slow
/// answer for an earlier drag never lands on this one; the page itself also checks the count.
pub fn send_drag_selection(app: &tauri::AppHandle) {
    let seq = DRAG_SEL.lock().unwrap().0;
    let app = app.clone();
    std::thread::spawn(move || {
        let mut s = DRAG_SEL.lock().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_millis(1500);
        while s.0 == seq && s.1.is_none() {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return;
            }
            s = DRAG_READY.wait_timeout(s, left).unwrap().0;
        }
        if s.0 != seq {
            return;
        }
        let paths = s.1.clone().unwrap_or_default();
        drop(s);
        use tauri::Manager;
        if paths.is_empty() || !app.state::<crate::AppState>().wheel.is_open() {
            return;
        }
        // The exact files (from the drop target) win over this guess, which can be slow or come from
        // another Explorer tab.
        if crate::wheel::drag_paths_known(&app) {
            crate::log::write(&format!("explorer selection ignored, exact drag paths known: {paths:?}"));
            return;
        }
        crate::log::write(&format!("explorer selection hint: {paths:?}"));
        crate::bridge::emit(&app, crate::wheel::LABEL, "wheel:paths", serde_json::json!([paths]));
    });
}
