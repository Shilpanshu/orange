//! Global low-level mouse and keyboard hooks on a dedicated thread.
//!
//! WH_MOUSE_LL / WH_KEYBOARD_LL keep firing during Explorer's modal OLE drag loop, so Orange can
//! react while the user still holds the file. The hook procedures only translate the event and
//! feed the state machine in `drag.rs`; anything it reports goes over a channel to the app, so the
//! hooks return within microseconds and never risk Windows' LowLevelHooksTimeout.

use crate::drag::{Button, DragState, Input, Key, Mod, Nav, Output};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::OnceLock;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

pub static LISTENING_NAV: AtomicBool = AtomicBool::new(false);
static SINK: OnceLock<Sender<Output>> = OnceLock::new();

thread_local! {
    static STATE: RefCell<DragState> = RefCell::new(DragState::new());
}

fn feed(input: Input) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.listening_nav = LISTENING_NAV.load(Ordering::Relaxed);
        if let Some(out) = s.feed(input) {
            if let Some(tx) = SINK.get() {
                let _ = tx.send(out);
            }
        }
    });
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let m = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let (x, y) = (m.pt.x, m.pt.y);
        let input = match wparam.0 as u32 {
            WM_MOUSEMOVE => Some(Input::Move(x, y)),
            WM_LBUTTONDOWN => Some(Input::Down(Button::Left, x, y)),
            WM_LBUTTONUP => Some(Input::Up(Button::Left)),
            WM_RBUTTONDOWN => Some(Input::Down(Button::Right, x, y)),
            WM_RBUTTONUP => Some(Input::Up(Button::Right)),
            WM_MBUTTONDOWN => Some(Input::Down(Button::Middle, x, y)),
            WM_MBUTTONUP => Some(Input::Up(Button::Middle)),
            WM_XBUTTONDOWN => Some(Input::Down(Button::Other, x, y)),
            WM_XBUTTONUP => Some(Input::Up(Button::Other)),
            _ => None,
        };
        if let Some(i) = input {
            feed(i);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Maps a virtual-key code to what the state machine cares about.
pub fn key_of(vk: u32) -> Key {
    match vk {
        0xA0 | 0xA1 | 0x10 => Key::Mod(Mod::Shift, vk),
        0xA2 | 0xA3 | 0x11 => Key::Mod(Mod::Ctrl, vk),
        0xA4 | 0xA5 | 0x12 => Key::Mod(Mod::Alt, vk),
        0x25 => Key::Nav(Nav::Left),
        0x26 => Key::Nav(Nav::Up),
        0x27 => Key::Nav(Nav::Right),
        0x28 => Key::Nav(Nav::Down),
        0x0D => Key::Nav(Nav::Enter),
        0x1B => Key::Nav(Nav::Escape),
        0x09 => Key::Nav(Nav::Tab),
        other => Key::Other(other),
    }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let key = key_of(k.vkCode);
        match wparam.0 as u32 {
            // Alt arrives as WM_SYSKEYDOWN, and so does any key while Alt is held.
            WM_KEYDOWN | WM_SYSKEYDOWN => feed(Input::KeyDown(key)),
            WM_KEYUP | WM_SYSKEYUP => feed(Input::KeyUp(key)),
            _ => {}
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Starts the hook thread. Events the app cares about arrive on `tx`.
pub fn start(tx: Sender<Output>) {
    if SINK.set(tx).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("orange-hooks".into())
        .spawn(|| unsafe {
            // A low-level hook is serviced by this thread's message loop, so it must keep pumping.
            let _ = raise_priority();
            let hmod = GetModuleHandleW(None).ok();
            let inst = hmod.map(|h| windows::Win32::Foundation::HINSTANCE(h.0));
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), inst, 0);
            let keys = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), inst, 0);
            if mouse.is_err() || keys.is_err() {
                eprintln!("orange: could not install input hooks");
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .expect("hook thread");
}

/// Hook callbacks are time-critical: run this thread above normal so a busy machine doesn't
/// delay every mouse move system-wide.
unsafe fn raise_priority() -> windows::core::Result<()> {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL};
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL)
}

/// Feeds synthetic events through the same state machine as the hooks (self-test only; never
/// touches the OS input queue).
#[cfg(feature = "selftest")]
pub fn inject(inputs: Vec<Input>) {
    // The state lives on the hook thread; a separate machine with the same sink is equivalent
    // for the test, which starts from a clean state.
    let mut s = DragState::new();
    for i in inputs {
        if let Some(out) = s.feed(i) {
            if let Some(tx) = SINK.get() {
                let _ = tx.send(out);
            }
        }
    }
}
