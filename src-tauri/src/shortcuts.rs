//! Global shortcuts (tauri-plugin-global-shortcut): the Explorer-selection hotkey, which opens the
//! Convert wheel for the files selected in Explorer, and the clipboard hotkey. Both are stored in
//! settings as Electron accelerators ("Control+Shift+Space") and re-registered when they change.

use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

type Action = Box<dyn Fn(&AppHandle) + Send + Sync>;

/// Reads the Explorer selection (wired to `explorer::selection` in lib.rs).
static SELECTION: OnceLock<Box<dyn Fn() -> Vec<String> + Send + Sync>> = OnceLock::new();
/// What the clipboard hotkey does (wired to the clipboard popover in lib.rs).
static CLIPBOARD: OnceLock<Action> = OnceLock::new();
/// The accelerators currently registered, per field.
static REGISTERED: Mutex<(String, String)> = Mutex::new((String::new(), String::new()));

pub fn set_selection_provider(f: impl Fn() -> Vec<String> + Send + Sync + 'static) {
    let _ = SELECTION.set(Box::new(f));
}

pub fn set_clipboard_action(f: impl Fn(&AppHandle) + Send + Sync + 'static) {
    let _ = CLIPBOARD.set(Box::new(f));
}

/// Converts a settings accelerator (Electron names) into the plugin's syntax and checks it parses.
/// The recorder writes Control/Alt/Shift/Super, Up/Down/Left/Right, Space, Plus and key names.
pub fn to_shortcut(accel: &str) -> Option<Shortcut> {
    if accel.trim().is_empty() {
        return None;
    }
    let parts: Vec<String> = accel
        .split('+')
        .map(|p| match p.trim() {
            "Plus" => "Equal".to_string(),
            "Meta" | "Win" => "Super".to_string(),
            "CmdOrCtrl" | "CommandOrControl" => "Control".to_string(),
            "Esc" => "Escape".to_string(),
            "Return" => "Enter".to_string(),
            other => other.to_string(),
        })
        .collect();
    let s: Shortcut = parts.join("+").parse().ok()?;
    // A shortcut without Ctrl, Alt or Win would swallow ordinary typing everywhere.
    use tauri_plugin_global_shortcut::Modifiers as M;
    if !s.mods.intersects(M::CONTROL | M::ALT | M::SUPER) {
        return None;
    }
    Some(s)
}

fn on_selection_hotkey(app: &AppHandle) {
    let app = app.clone();
    // COM work and the wheel open happen off the shortcut callback.
    std::thread::spawn(move || {
        let paths = SELECTION.get().map(|f| f()).unwrap_or_default();
        if paths.is_empty() {
            crate::log::write("selection hotkey: nothing selected in Explorer");
            return;
        }
        crate::wheel::open(&app, "convert", crate::wheel::Mode::Click, Some(paths));
    });
}

fn on_clipboard_hotkey(app: &AppHandle) {
    match CLIPBOARD.get() {
        Some(f) => f(app),
        None => crate::log::write("clipboard hotkey: no clipboard action wired"),
    }
}

fn rebind(app: &AppHandle, old: &str, new: &str, what: &str, action: fn(&AppHandle)) -> String {
    let gs = app.global_shortcut();
    if old == new && (new.is_empty() || to_shortcut(new).is_some_and(|s| gs.is_registered(s))) {
        return new.to_string();
    }
    if let Some(s) = to_shortcut(old) {
        let _ = gs.unregister(s);
    }
    if new.is_empty() {
        return String::new();
    }
    let Some(s) = to_shortcut(new) else {
        crate::log::write(&format!("{what} shortcut {new:?} is not a valid shortcut"));
        return String::new();
    };
    match gs.on_shortcut(s, move |app, _s, ev| {
        if ev.state == ShortcutState::Pressed {
            action(app);
        }
    }) {
        Ok(()) => {
            crate::log::write(&format!("{what} shortcut {new} registered"));
            new.to_string()
        }
        Err(e) => {
            crate::log::write(&format!("{what} shortcut {new} is taken by another app: {e}"));
            String::new()
        }
    }
}

/// Registers both shortcuts from the current settings; call at start and after every change.
pub fn apply(app: &AppHandle) {
    let s = crate::settings::get();
    let mut reg = REGISTERED.lock().unwrap();
    let (old_sel, old_clip) = reg.clone();
    // When the two are swapped or equal, free both first so neither steals the other's slot.
    if s.selection_hotkey == old_clip || s.clipboard_hotkey == old_sel {
        for o in [&old_sel, &old_clip] {
            if let Some(sc) = to_shortcut(o) {
                let _ = app.global_shortcut().unregister(sc);
            }
        }
        *reg = (String::new(), String::new());
    }
    let (old_sel, old_clip) = reg.clone();
    reg.0 = rebind(app, &old_sel, &s.selection_hotkey, "selection", on_selection_hotkey);
    reg.1 = if s.clipboard_hotkey == s.selection_hotkey { String::new() } else { rebind(app, &old_clip, &s.clipboard_hotkey, "clipboard", on_clipboard_hotkey) };
}

pub fn unregister_all(app: &AppHandle) {
    let _ = app.global_shortcut().unregister_all();
    *REGISTERED.lock().unwrap() = (String::new(), String::new());
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    #[test]
    fn recorder_accelerators_parse() {
        let s = to_shortcut("Control+Shift+Space").unwrap();
        assert_eq!((s.mods, s.key), (Modifiers::CONTROL | Modifiers::SHIFT, Code::Space));
        assert_eq!(to_shortcut("Control+Alt+V").unwrap().key, Code::KeyV);
        assert_eq!(to_shortcut("Alt+Shift+1").unwrap().key, Code::Digit1);
        assert_eq!(to_shortcut("Control+Up").unwrap().key, Code::ArrowUp);
        assert_eq!(to_shortcut("Control+Plus").unwrap().key, Code::Equal);
        assert_eq!(to_shortcut("Super+F9").unwrap().mods, Modifiers::SUPER);
        assert!(to_shortcut("").is_none());
        assert!(to_shortcut("Shift+A").is_none(), "Shift alone would swallow capitals");
        assert!(to_shortcut("Control+Nonsense").is_none());
    }
}
