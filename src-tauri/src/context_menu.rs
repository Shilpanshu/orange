//! Explorer right-click menu: an "Orange" submenu on files and folders with Convert..., Tools...
//! and Actions.... Registered per user under HKCU\Software\Classes (no administrator rights). On
//! Windows 11 it sits under "Show more options". Port of 1.x `src/main/context-menu.ts`.
//!
//! The dev identifier registers a separate `OrangeDev` verb, and only when asked to
//! (`ORANGE_DEV_CONTEXT_MENU=1`), so testing never touches the installed 1.x `Orange` keys.
//!
//! Each entry runs `Orange.exe --wheel=<kind> "<path>"`. Explorer starts one process per selected
//! file; the single-instance plugin forwards each command line here, and launches that arrive
//! close together are gathered into one wheel.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
use windows::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ};

pub const CLASSES: &str = r"Software\Classes";
/// Files of every type, and folders.
const TARGETS: &[&str] = &["*", "Directory"];
const ENTRIES: &[(&str, &str)] = &[("convert", "Convert\u{2026}"), ("tools", "Tools\u{2026}"), ("actions", "Actions\u{2026}")];
pub const WHEEL_KINDS: &[&str] = &["convert", "tools", "actions"];

/// The verb's key name: `Orange` for the release identifier, `OrangeDev` for anything else.
pub fn verb_key(identifier: &str) -> &'static str {
    if identifier == "app.orange.converter" {
        "Orange"
    } else {
        "OrangeDev"
    }
}

pub struct Launcher {
    pub exe: String,
    pub icon: String,
}

impl Launcher {
    pub fn current() -> Option<Launcher> {
        let exe = std::env::current_exe().ok()?.to_string_lossy().into_owned();
        Some(Launcher { icon: format!("{exe},0"), exe })
    }
}

fn hkcu_create(path: &str) -> Result<HKEY, String> {
    let mut k = HKEY::default();
    let r = unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, &HSTRING::from(path), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut k, None) };
    if r.is_err() {
        return Err(format!("create {path}: {r:?}"));
    }
    Ok(k)
}

fn set_str(k: HKEY, name: Option<&str>, value: &str) -> Result<(), String> {
    let wide: Vec<u16> = value.encode_utf16().chain([0]).collect();
    let bytes = unsafe { std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2) };
    let name = name.map(HSTRING::from);
    let r = unsafe { RegSetValueExW(k, name.as_ref().map(|n| PCWSTR(n.as_ptr())).unwrap_or(PCWSTR::null()), None, REG_SZ, Some(bytes)) };
    if r.is_err() {
        return Err(format!("set value: {r:?}"));
    }
    Ok(())
}

fn write_key(path: &str, values: &[(Option<&str>, &str)]) -> Result<(), String> {
    let k = hkcu_create(path)?;
    let r = values.iter().try_for_each(|(n, v)| set_str(k, *n, v));
    unsafe {
        let _ = RegCloseKey(k);
    }
    r
}

/// Deletes an HKCU subtree; already gone is fine.
pub fn delete_tree(path: &str) -> Result<(), String> {
    let r = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(path)) };
    if r.is_ok() || r == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("delete {path}: {r:?}"))
    }
}

pub fn key_exists(path: &str) -> bool {
    let mut k = HKEY::default();
    let r = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(path), None, KEY_READ, &mut k) };
    if r.is_ok() {
        unsafe {
            let _ = RegCloseKey(k);
        }
        true
    } else {
        false
    }
}

/// Adds (launcher = Some) or removes the menu under `root` (normally `Software\Classes`).
/// Idempotent: always deletes first, so stale entries from an older build never linger.
pub fn apply(root: &str, verb: &str, launcher: Option<&Launcher>) -> Result<(), String> {
    for t in TARGETS {
        let base = format!(r"{root}\{t}\shell\{verb}");
        delete_tree(&base)?;
        let Some(l) = launcher else { continue };
        let title = if verb == "Orange" { "Orange" } else { "Orange (dev)" };
        write_key(&base, &[(Some("MUIVerb"), title), (Some("Icon"), &l.icon), (Some("SubCommands"), "")])?;
        for (i, (kind, label)) in ENTRIES.iter().enumerate() {
            // Numeric prefixes keep Explorer's alphabetical order matching ours.
            let sub = format!(r"{base}\shell\{}{kind}", i + 1);
            // Player: one launch per item and no 15-item limit (the default model hides the verb past 15).
            write_key(&sub, &[(Some("MUIVerb"), label), (Some("MultiSelectModel"), "Player")])?;
            let cmd = format!("\"{}\" --wheel={kind} \"%1\"", l.exe);
            write_key(&format!(r"{sub}\command"), &[(None, &cmd)])?;
        }
    }
    Ok(())
}

/// Registers or removes the menu for this copy of Orange, if it is allowed to own one: installed
/// builds, or a dev run with `ORANGE_DEV_CONTEXT_MENU=1` (which writes the separate dev verb).
pub fn sync(identifier: &str, enabled: bool) {
    let dev_opt_in = std::env::var("ORANGE_DEV_CONTEXT_MENU").as_deref() == Ok("1");
    if !crate::settings::is_installed() && !dev_opt_in {
        return;
    }
    let verb = verb_key(identifier);
    if verb == "Orange" && !crate::settings::is_installed() {
        return; // never repoint the installed app's menu from a dev run
    }
    let l = if enabled { Launcher::current() } else { None };
    match apply(CLASSES, verb, l.as_ref()) {
        Ok(()) => crate::log::write(&format!("context menu {verb}: {}", if enabled { "registered" } else { "removed" })),
        Err(e) => crate::log::write(&format!("context menu update failed: {e}")),
    }
}

// ------------------------------------------------------------ launches

/// Quiet time that ends a burst of launches from one multi-selection.
pub const GATHER: Duration = Duration::from_millis(150);
/// Upper bound so a huge selection still opens promptly.
pub const GATHER_MAX: Duration = Duration::from_millis(1500);

/// Extracts `--wheel=<kind>` and the file paths from a command line (argv[0] is the executable).
/// None when it isn't a menu launch.
pub fn parse_argv(argv: &[String]) -> Option<(String, Vec<String>)> {
    let mut wheel = None;
    let mut paths = vec![];
    for a in argv.iter().skip(1) {
        if let Some(k) = a.strip_prefix("--wheel=").or_else(|| a.strip_prefix("--WHEEL=")) {
            let k = k.to_lowercase();
            if WHEEL_KINDS.contains(&k.as_str()) {
                wheel = Some(k);
            }
            continue;
        }
        if a.starts_with('-') {
            continue;
        }
        // Absolute paths only.
        let b = a.as_bytes();
        let abs = (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || a.starts_with(r"\\");
        if abs {
            paths.push(a.clone());
        }
    }
    wheel.map(|w| (w, paths))
}

type OpenFn = Arc<dyn Fn(String, Vec<String>) + Send + Sync>;

struct Pending {
    wheel: String,
    paths: Vec<String>,
    seen: HashSet<String>,
    first: Instant,
    generation: u64,
}

/// Gathers the launches of one multi-selection into a single wheel.
pub struct Coalescer {
    pending: Arc<Mutex<Option<Pending>>>,
    generation: Mutex<u64>,
    open: OpenFn,
    exists: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    gather: Duration,
    gather_max: Duration,
}

impl Coalescer {
    pub fn new(open: impl Fn(String, Vec<String>) + Send + Sync + 'static) -> Self {
        Self::with(open, |p| Path::new(p).exists(), GATHER, GATHER_MAX)
    }

    pub fn with(open: impl Fn(String, Vec<String>) + Send + Sync + 'static, exists: impl Fn(&str) -> bool + Send + Sync + 'static, gather: Duration, gather_max: Duration) -> Self {
        Self { pending: Arc::new(Mutex::new(None)), generation: Mutex::new(0), open: Arc::new(open), exists: Arc::new(exists), gather, gather_max }
    }

    /// Handles a command line from first launch or a second instance. Returns true when it was a
    /// right-click launch (the caller should then not open Settings).
    pub fn handle(&self, argv: &[String]) -> bool {
        let Some((wheel, paths)) = parse_argv(argv) else { return false };
        let generation = {
            let mut g = self.generation.lock().unwrap();
            *g += 1;
            *g
        };
        let now = Instant::now();
        let wait = {
            let mut guard = self.pending.lock().unwrap();
            let p = guard.get_or_insert_with(|| Pending { wheel: wheel.clone(), paths: vec![], seen: HashSet::new(), first: now, generation });
            // The last kind wins if they differ (they come from one click, so they normally don't).
            p.wheel = wheel;
            p.generation = generation;
            for path in paths {
                let k = path.to_lowercase();
                if p.seen.contains(&k) || !(self.exists)(&path) {
                    continue;
                }
                p.seen.insert(k);
                p.paths.push(path);
            }
            let left = (p.first + self.gather_max).saturating_duration_since(now);
            self.gather.min(left)
        };
        let (pending, open) = (self.pending.clone(), self.open.clone());
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            let done = {
                let mut g = pending.lock().unwrap();
                if g.as_ref().is_some_and(|p| p.generation == generation) {
                    g.take()
                } else {
                    None
                }
            };
            if let Some(d) = done.filter(|d| !d.paths.is_empty()) {
                open(d.wheel, d.paths);
            }
        });
        true
    }
}

static COALESCER: std::sync::OnceLock<Coalescer> = std::sync::OnceLock::new();

/// The app's coalescer: opens the wheel in click mode once the wheel page is ready.
pub fn handle_argv(app: &tauri::AppHandle, argv: &[String]) -> bool {
    let c = COALESCER.get_or_init(|| {
        let app = app.clone();
        Coalescer::new(move |wheel, paths| {
            use tauri::Manager;
            // A launch can arrive before the wheel page has loaded; an event sent then is lost.
            let t = Instant::now();
            while !app.state::<crate::AppState>().wheel.is_ready() && t.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(30));
            }
            crate::log::write(&format!("context menu launch: {wheel} with {} file(s)", paths.len()));
            crate::wheel::open(&app, &wheel, crate::wheel::Mode::Click, Some(paths));
        })
    });
    c.handle(argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_menu_launches() {
        assert_eq!(parse_argv(&argv(&["Orange.exe", "--wheel=Tools", r"C:\a b\x.png"])), Some(("tools".into(), vec![r"C:\a b\x.png".into()])));
        assert_eq!(parse_argv(&argv(&["Orange.exe", "--wheel=convert", "relative.png", "--flag", r"\\srv\share\y.pdf"])), Some(("convert".into(), vec![r"\\srv\share\y.pdf".into()])));
        assert_eq!(parse_argv(&argv(&["Orange.exe", r"C:\x.png"])), None);
        assert_eq!(parse_argv(&argv(&["Orange.exe", "--wheel=bogus", r"C:\x.png"])), None);
    }

    #[test]
    fn coalesces_a_burst_into_one_wheel() {
        let got: Arc<Mutex<Vec<(String, Vec<String>)>>> = Arc::default();
        let g = got.clone();
        let c = Coalescer::with(move |w, p| g.lock().unwrap().push((w, p)), |p| !p.contains("missing"), Duration::from_millis(150), Duration::from_millis(1500));
        assert!(!c.handle(&argv(&["Orange.exe"])), "a plain launch opens Settings");
        // Explorer: one process per selected file, a few ms apart, with a duplicate and a gone file.
        for f in [r"C:\a.png", r"C:\b.png", r"C:\A.PNG", r"C:\missing.png", r"C:\c.png"] {
            assert!(c.handle(&argv(&["Orange.exe", "--wheel=convert", f])));
            std::thread::sleep(Duration::from_millis(30));
        }
        std::thread::sleep(Duration::from_millis(400));
        let v = got.lock().unwrap().clone();
        assert_eq!(v, vec![("convert".to_string(), vec![r"C:\a.png".to_string(), r"C:\b.png".into(), r"C:\c.png".into()])]);
        // A later, separate click opens its own wheel.
        c.handle(&argv(&["Orange.exe", "--wheel=actions", r"C:\d.png"]));
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(got.lock().unwrap().len(), 2);
        assert_eq!(got.lock().unwrap()[1].0, "actions");
    }

    #[test]
    fn a_long_burst_still_opens_by_the_cap() {
        let got: Arc<Mutex<Vec<usize>>> = Arc::default();
        let g = got.clone();
        let c = Coalescer::with(move |_, p| g.lock().unwrap().push(p.len()), |_| true, Duration::from_millis(100), Duration::from_millis(400));
        let t = Instant::now();
        let mut i = 0;
        while t.elapsed() < Duration::from_millis(700) {
            c.handle(&argv(&["Orange.exe", "--wheel=convert", &format!(r"C:\f{i}.png")]));
            i += 1;
            std::thread::sleep(Duration::from_millis(40));
        }
        std::thread::sleep(Duration::from_millis(300));
        let v = got.lock().unwrap().clone();
        assert!(v.len() >= 2, "the cap split the burst: {v:?}");
        assert_eq!(v.iter().sum::<usize>(), i);
    }

    #[test]
    fn registers_and_removes_under_a_test_root_only() {
        let root = format!(r"Software\OrangeTest-{}\Classes", std::process::id());
        let l = Launcher { exe: r"C:\Program Files\Orange Dev\Orange.exe".into(), icon: r"C:\Program Files\Orange Dev\Orange.exe,0".into() };
        apply(&root, "OrangeDev", Some(&l)).unwrap();
        assert!(key_exists(&format!(r"{root}\*\shell\OrangeDev\shell\1convert\command")));
        assert!(key_exists(&format!(r"{root}\Directory\shell\OrangeDev\shell\3actions")));
        apply(&root, "OrangeDev", Some(&l)).unwrap(); // idempotent
        apply(&root, "OrangeDev", None).unwrap();
        assert!(!key_exists(&format!(r"{root}\*\shell\OrangeDev")));
        delete_tree(&format!(r"Software\OrangeTest-{}", std::process::id())).unwrap();
        assert!(!key_exists(&format!(r"Software\OrangeTest-{}", std::process::id())));
        assert_eq!(verb_key("app.orange.converter.dev"), "OrangeDev");
    }
}
