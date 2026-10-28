//! Orange's own OLE drop target for the wheel.
//!
//! wry registers a drop target on the webview's host window when the wheel is created, but on some
//! machines WebView2 later registers its own on the same window, replacing wry's: drags from
//! Explorer then reach WebView2, and the wheel never learns which files are dragged (log line
//! "no DragEnter 700 ms after the wheel opened"). So every time the wheel opens, this target is
//! (re)registered on the wheel's windows in this process, last, and therefore wins.

use crate::{log, wheel};
use std::cell::RefCell;
use tauri::AppHandle;
use windows::core::{implement, Ref, Result, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
    DROPEFFECT_LINK, DROPEFFECT_MOVE, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetWindowThreadProcessId};

#[implement(IDropTarget)]
struct Target {
    app: AppHandle,
    wheel: isize,
    paths: RefCell<Vec<String>>,
}

/// Paths in a data object's CF_HDROP (what Explorer always offers for files).
fn hdrop_paths(data: &IDataObject) -> Vec<String> {
    let fmt = FORMATETC { cfFormat: CF_HDROP.0, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0, lindex: -1, tymed: TYMED_HGLOBAL.0 as u32 };
    unsafe {
        let Ok(mut med) = data.GetData(&fmt) else { return Vec::new() };
        let drop = HDROP(med.u.hGlobal.0);
        let n = DragQueryFileW(drop, u32::MAX, None);
        let mut out = Vec::with_capacity(n as usize);
        for i in 0..n {
            let len = DragQueryFileW(drop, i, None) as usize;
            let mut buf = vec![0u16; len + 1];
            DragQueryFileW(drop, i, Some(&mut buf));
            out.push(String::from_utf16_lossy(&buf[..len]));
        }
        ReleaseStgMedium(&mut med);
        out
    }
}

/// Copy if the source allows it (the wheel never moves the original), else whatever it allows.
fn effect_for(allowed: DROPEFFECT) -> DROPEFFECT {
    for e in [DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE] {
        if allowed.0 & e.0 != 0 {
            return e;
        }
    }
    DROPEFFECT_NONE
}

impl Target {
    /// Screen pixels to the wheel window's client pixels, which is what the page's coordinates use.
    fn client(&self, pt: &POINTL) -> (f64, f64) {
        let mut p = POINT { x: pt.x, y: pt.y };
        unsafe {
            let _ = ScreenToClient(HWND(self.wheel as *mut _), &mut p);
        }
        (p.x as f64, p.y as f64)
    }
}

impl IDropTarget_Impl for Target_Impl {
    fn DragEnter(&self, data: Ref<IDataObject>, _keys: MODIFIERKEYS_FLAGS, pt: &POINTL, effect: *mut DROPEFFECT) -> Result<()> {
        let paths = data.as_ref().map(hdrop_paths).unwrap_or_default();
        *self.paths.borrow_mut() = paths.clone();
        let (x, y) = self.client(pt);
        wheel::on_drop_event(&self.app, wheel::DropEv::Enter(paths, x, y));
        unsafe { *effect = effect_for(*effect) };
        Ok(())
    }

    fn DragOver(&self, _keys: MODIFIERKEYS_FLAGS, pt: &POINTL, effect: *mut DROPEFFECT) -> Result<()> {
        let (x, y) = self.client(pt);
        wheel::on_drop_event(&self.app, wheel::DropEv::Over(x, y));
        unsafe { *effect = effect_for(*effect) };
        Ok(())
    }

    fn DragLeave(&self) -> Result<()> {
        wheel::on_drop_event(&self.app, wheel::DropEv::Leave);
        Ok(())
    }

    fn Drop(&self, data: Ref<IDataObject>, _keys: MODIFIERKEYS_FLAGS, pt: &POINTL, effect: *mut DROPEFFECT) -> Result<()> {
        let mut paths = data.as_ref().map(hdrop_paths).unwrap_or_default();
        if paths.is_empty() {
            paths = self.paths.borrow().clone();
        }
        let (x, y) = self.client(pt);
        wheel::on_drop_event(&self.app, wheel::DropEv::Drop(paths, x, y));
        unsafe { *effect = effect_for(*effect) };
        Ok(())
    }
}

thread_local! {
    static TARGET: RefCell<Option<IDropTarget>> = const { RefCell::new(None) };
}

unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
    let v = &mut *(l.0 as *mut Vec<HWND>);
    v.push(h);
    BOOL(1)
}

/// (Re)registers Orange's drop target on the wheel window and its children owned by this process.
/// Must run on the thread that owns the wheel window (the main thread), where OLE is initialised.
pub fn register(app: &AppHandle, wheel: HWND) {
    TARGET.with(|t| {
        let mut t = t.borrow_mut();
        let target = t
            .get_or_insert_with(|| Target { app: app.clone(), wheel: wheel.0 as isize, paths: RefCell::new(Vec::new()) }.into())
            .clone();
        let mut windows = vec![wheel];
        unsafe {
            let _ = EnumChildWindows(Some(wheel), Some(collect), LPARAM(&mut windows as *mut _ as isize));
        }
        let me = std::process::id();
        let mut failed = Vec::new();
        for h in windows {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
            if pid != me {
                continue; // WebView2's own processes: their windows can't take our target.
            }
            unsafe {
                let _ = RevokeDragDrop(h);
                if let Err(e) = RegisterDragDrop(h, &target) {
                    failed.push(e.to_string());
                }
            }
        }
        if !failed.is_empty() {
            log::write(&format!("drop target: could not register on {} window(s): {failed:?}", failed.len()));
        }
    });
}
