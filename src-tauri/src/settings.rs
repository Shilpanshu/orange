//! The settings store: one JSON file, the same fields and defaults as Orange 1.x
//! (`src/main/settings.ts`), written atomically. On first start it imports an existing 1.x
//! `settings.json` from the Electron profile (`%APPDATA%\Orange`), leaving that file untouched.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ModKey {
    Shift,
    Ctrl,
    Alt,
    None,
}

impl ModKey {
    pub fn label(self) -> &'static str {
        match self {
            ModKey::Shift => "Shift",
            ModKey::Ctrl => "Ctrl",
            ModKey::Alt => "Alt",
            ModKey::None => "",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct Keys {
    pub convert: ModKey,
    pub tools: ModKey,
    pub actions: ModKey,
}

impl Default for Keys {
    fn default() -> Self {
        Self { convert: ModKey::Shift, tools: ModKey::Ctrl, actions: ModKey::Alt }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct Output {
    /// "beside" or "folder".
    pub mode: String,
    pub folder: String,
}

impl Default for Output {
    fn default() -> Self {
        Self { mode: "beside".into(), folder: String::new() }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub tool: String,
    pub options: Value,
    pub kinds: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct WatchFolder {
    pub id: String,
    pub folder: String,
    pub exts: Vec<String>,
    /// A wheel item id: 'to:webp', 'tool:extractArchive' or 'preset:<id>'.
    pub action: String,
    pub out_folder: String,
    pub recycle_original: bool,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub keys: Keys,
    pub selection_hotkey: String,
    pub output: Output,
    pub reveal_when_done: bool,
    pub replace_original: bool,
    pub jpg_quality: u32,
    pub launch_at_login: bool,
    pub sounds: bool,
    pub theme: String,
    pub terminal: String,
    pub shelf_edge: String,
    pub move_folder: String,
    pub onboarded: bool,
    pub favorites: Map<String, Value>,
    pub recents: Map<String, Value>,
    pub presets: Vec<Preset>,
    pub watch_folders: Vec<WatchFolder>,
    pub context_menu: bool,
    pub clipboard_hotkey: String,
    pub gpu_encode: String,
    /// Fields this build doesn't know (written by a newer version) survive a save.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            keys: Keys::default(),
            selection_hotkey: "Control+Shift+Space".into(),
            output: Output::default(),
            reveal_when_done: false,
            replace_original: false,
            jpg_quality: 88,
            launch_at_login: true,
            sounds: true,
            theme: "system".into(),
            terminal: "auto".into(),
            shelf_edge: "right".into(),
            move_folder: String::new(),
            onboarded: false,
            favorites: Map::new(),
            recents: Map::new(),
            presets: vec![],
            watch_folders: vec![],
            context_menu: true,
            // Not Ctrl+Shift+V: that is "paste as plain text" in many apps.
            clipboard_hotkey: "Control+Alt+V".into(),
            gpu_encode: "auto".into(),
            extra: Map::new(),
        }
    }
}

impl Settings {
    /// Which wheel a drag modifier opens, if any (Settings > Shortcuts).
    pub fn wheel_for_mod(&self, m: ModKey) -> Option<&'static str> {
        if m == ModKey::None {
            return None;
        }
        let k = &self.keys;
        if k.convert == m {
            Some("convert")
        } else if k.tools == m {
            Some("tools")
        } else if k.actions == m {
            Some("actions")
        } else {
            None
        }
    }

    pub fn key_names(&self) -> Value {
        serde_json::json!({ "convert": self.keys.convert.label(), "tools": self.keys.tools.label(), "actions": self.keys.actions.label() })
    }
}

/// Parses a settings file's JSON over the defaults. Like 1.x, `keys` and `output` merge field by
/// field; a field with the wrong type falls back to its default instead of failing the whole file.
pub fn from_json(raw: &Value) -> Settings {
    let defaults = serde_json::to_value(Settings::default()).unwrap();
    let mut merged = defaults.as_object().unwrap().clone();
    if let Some(obj) = raw.as_object() {
        for (k, v) in obj {
            match (merged.get_mut(k), v) {
                (Some(Value::Object(d)), Value::Object(o)) if k == "keys" || k == "output" => {
                    for (kk, vv) in o {
                        d.insert(kk.clone(), vv.clone());
                    }
                }
                _ => {
                    merged.insert(k.clone(), v.clone());
                }
            }
        }
    }
    let merged = Value::Object(merged);
    if let Ok(s) = serde_json::from_value::<Settings>(merged.clone()) {
        return s;
    }
    // Some field is malformed: keep each field that parses on its own.
    let mut good = defaults.as_object().unwrap().clone();
    for (k, v) in merged.as_object().unwrap() {
        let mut trial = good.clone();
        trial.insert(k.clone(), v.clone());
        if serde_json::from_value::<Settings>(Value::Object(trial)).is_ok() {
            good.insert(k.clone(), v.clone());
        }
    }
    serde_json::from_value(Value::Object(good)).unwrap_or_default()
}

/// Writes a sibling file and swaps it in, so a crash or power cut mid-write never leaves a
/// truncated file (which would silently reset every setting on the next start).
pub fn write_atomic(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    if std::fs::rename(&tmp, file).is_err() {
        // Another program (antivirus, a backup tool) has the file open: write in place instead.
        let r = std::fs::write(file, bytes);
        let _ = std::fs::remove_file(&tmp);
        r?;
    }
    Ok(())
}

type Listener = Box<dyn Fn(&Settings, &Settings) + Send + Sync>;

pub struct Store {
    file: PathBuf,
    data: Mutex<Settings>,
    listeners: Mutex<Vec<Listener>>,
}

impl Store {
    /// Loads `file`; when it doesn't exist and `import_from` does (a 1.x profile), imports that.
    pub fn open(file: PathBuf, import_from: Option<PathBuf>) -> Store {
        let data = load(&file, import_from.as_deref());
        Store { file, data: Mutex::new(data), listeners: Mutex::new(vec![]) }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn get(&self) -> Settings {
        self.data.lock().unwrap().clone()
    }

    /// Shallow-merges `patch` (top-level fields, as 1.x does), saves, and tells listeners.
    pub fn set(&self, patch: &Value) -> Settings {
        let (before, after) = {
            let mut d = self.data.lock().unwrap();
            let before = d.clone();
            let mut cur = serde_json::to_value(&*d).unwrap();
            if let (Some(c), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    c.insert(k.clone(), v.clone());
                }
            }
            *d = from_json(&cur);
            self.save_locked(&d);
            (before, d.clone())
        };
        for l in self.listeners.lock().unwrap().iter() {
            l(&before, &after);
        }
        after
    }

    /// Changes the settings in place (for callers holding typed data, e.g. presets).
    pub fn update(&self, f: impl FnOnce(&mut Settings)) -> Settings {
        let mut s = self.get();
        f(&mut s);
        self.set(&serde_json::to_value(&s).unwrap())
    }

    fn save_locked(&self, s: &Settings) {
        let json = serde_json::to_vec_pretty(s).unwrap();
        if let Err(e) = write_atomic(&self.file, &json) {
            crate::log::write(&format!("settings save failed: {e}"));
        }
    }

    /// `f(before, after)` runs after every change.
    pub fn on_change(&self, f: impl Fn(&Settings, &Settings) + Send + Sync + 'static) {
        self.listeners.lock().unwrap().push(Box::new(f));
    }
}

fn load(file: &Path, import_from: Option<&Path>) -> Settings {
    match std::fs::read(file) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => from_json(&v),
            Err(e) => {
                // Keep a damaged file for the problem report; the next save would overwrite it.
                let _ = std::fs::copy(file, file.with_extension("corrupt.json"));
                crate::log::write(&format!("settings unreadable ({e}); using defaults"));
                Settings::default()
            }
        },
        Err(_) => {
            let Some(old) = import_from.filter(|p| p.is_file()) else { return Settings::default() };
            let Ok(v) = std::fs::read(old).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string())) else {
                crate::log::write("1.x settings unreadable; starting from defaults");
                return Settings::default();
            };
            let mut s = from_json(&v);
            s.extra.insert("importedFrom".into(), Value::String(old.to_string_lossy().into_owned()));
            if let Err(e) = write_atomic(file, &serde_json::to_vec_pretty(&s).unwrap()) {
                crate::log::write(&format!("settings import save failed: {e}"));
            }
            crate::log::write(&format!("imported Orange 1.x settings from {}", old.display()));
            s
        }
    }
}

/// The 1.x Electron profile's settings file (`%APPDATA%\Orange\settings.json`).
/// `ORANGE_V1_SETTINGS` overrides it (tests); set it to an empty string to skip the import.
pub fn v1_settings_file() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ORANGE_V1_SETTINGS") {
        return (!p.is_empty()).then(|| PathBuf::from(p));
    }
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Orange").join("settings.json"))
}

static STORE: OnceLock<Store> = OnceLock::new();

/// Opens the store in `dir` (the app's config folder, or `ORANGE_USER_DATA` for test profiles).
pub fn init(dir: PathBuf) -> &'static Store {
    let dir = std::env::var_os("ORANGE_USER_DATA").map(PathBuf::from).unwrap_or(dir);
    // A test profile never imports the real 1.x settings.
    let import = if std::env::var_os("ORANGE_USER_DATA").is_some() && std::env::var_os("ORANGE_V1_SETTINGS").is_none() { None } else { v1_settings_file() };
    STORE.get_or_init(|| Store::open(dir.join("settings.json"), import))
}

/// The process-wide store. Before `init` (unit tests, early start-up) it is an in-memory default.
pub fn store() -> &'static Store {
    STORE.get_or_init(|| Store::open(std::env::temp_dir().join(format!("orange-settings-{}.json", std::process::id())), None))
}

pub fn get() -> Settings {
    store().get()
}

/// True in an installed release build: NSIS puts `uninstall.exe` next to the app. Dev and test
/// runs must never touch the installed app's autostart entry or Explorer menu.
pub fn is_installed() -> bool {
    if cfg!(debug_assertions) || std::env::var_os("ORANGE_USER_DATA").is_some() {
        return false;
    }
    std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("uninstall.exe").is_file())).unwrap_or(false)
}

// ------------------------------------------------------------------ app wiring

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Launch at login, only in installed builds: a dev run must never touch the installed app's entry.
fn apply_autostart(app: &AppHandle, on: bool) {
    if !is_installed() {
        return;
    }
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    let now = al.is_enabled().unwrap_or(!on);
    let r = match (on, now) {
        (true, false) => al.enable(),
        (false, true) => al.disable(),
        _ => Ok(()),
    };
    if let Err(e) = r {
        crate::log::write(&format!("autostart: {e}"));
    }
}

fn apply_theme(app: &AppHandle, theme: &str) {
    let t = match theme {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.set_theme(t);
    }
}

/// After `init`: applies settings that live outside the app (shortcuts, autostart, Explorer menu,
/// watch folders) and keeps them in step with later changes.
pub fn start(app: &AppHandle) {
    let s = get();
    crate::shortcuts::apply(app);
    apply_autostart(app, s.launch_at_login);
    let id = app.config().identifier.clone();
    crate::context_menu::sync(&id, s.context_menu);
    crate::watch::start();
    let h = app.clone();
    store().on_change(move |before, after| {
        if before.selection_hotkey != after.selection_hotkey || before.clipboard_hotkey != after.clipboard_hotkey {
            crate::shortcuts::apply(&h);
        }
        if before.launch_at_login != after.launch_at_login {
            apply_autostart(&h, after.launch_at_login);
        }
        if before.context_menu != after.context_menu {
            crate::context_menu::sync(&h.config().identifier, after.context_menu);
        }
        if before.theme != after.theme {
            apply_theme(&h, &after.theme);
        }
    });
    if !s.onboarded {
        open_settings(app, Some("welcome"));
    }
}

/// Opens (or focuses) Settings, on `tab` if given.
pub fn open_settings(app: &AppHandle, tab: Option<&str>) {
    if let Some(w) = app.get_webview_window("settings") {
        if let Some(t) = tab {
            crate::bridge::emit(app, "settings", "settings:tab", serde_json::json!([t]));
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let args = serde_json::json!({ "tab": tab.unwrap_or("general") }).to_string();
    let hash: String = args.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let url = WebviewUrl::App(format!("renderer/settings/index.html#{hash}").into());
    let theme = get().theme;
    let w = WebviewWindowBuilder::new(app, "settings", url)
        .title("Orange")
        .inner_size(760.0, 620.0)
        .min_inner_size(620.0, 480.0)
        .additional_browser_args(&crate::browser_args())
        .drag_and_drop(false)
        .build();
    if w.is_ok() {
        apply_theme(app, &theme);
    }
}

fn pick_folder(app: &AppHandle, title: &str) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut d = app.dialog().file().set_title(title);
    if let Some(w) = app.get_webview_window("settings") {
        d = d.set_parent(&w);
    }
    d.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

/// Bridge channels for Settings, presets and wheel preferences. `None` = not ours.
pub fn handle_invoke(app: &AppHandle, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if let Some(r) = crate::presets::handle_invoke(channel, args) {
        return Some(r);
    }
    let arg = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default().to_string();
    Some(match channel {
        "settings:get" => Ok(serde_json::to_value(get()).unwrap()),
        "settings:set" => Ok(serde_json::to_value(store().set(args.first().unwrap_or(&Value::Null))).unwrap()),
        "settings:keyNames" => Ok(get().key_names()),
        "wheel:togglePin" => Ok(crate::presets::toggle_pin(store(), &arg(0), &arg(1))),
        "dialog:folder" => Ok(pick_folder(app, &arg(0)).map(Value::String).unwrap_or(Value::Null)),
        "app:report" => crate::diagnostics::report_problem(app).map(Value::String),
        "app:openLogs" => {
            crate::diagnostics::open_logs();
            Ok(Value::Null)
        }
        _ => return None,
    })
}

/// Fire-and-forget channels from the Settings window. Returns true when handled.
pub fn handle_send(app: &AppHandle, label: &str, channel: &str) -> bool {
    match (label, channel) {
        ("settings", "window:close") => {
            if let Some(w) = app.get_webview_window("settings") {
                let _ = w.close();
            }
            true
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orange-settings-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn defaults_match_1x() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["keys"], json!({ "convert": "shift", "tools": "ctrl", "actions": "alt" }));
        assert_eq!(v["selectionHotkey"], "Control+Shift+Space");
        assert_eq!(v["clipboardHotkey"], "Control+Alt+V");
        assert_eq!(v["output"], json!({ "mode": "beside", "folder": "" }));
        assert_eq!(v["jpgQuality"], 88);
        assert_eq!(v["launchAtLogin"], true);
        assert_eq!(v["contextMenu"], true);
        assert_eq!(v["gpuEncode"], "auto");
        assert_eq!(v["watchFolders"], json!([]));
        assert_eq!(v["moveFolder"], "");
    }

    #[test]
    fn round_trip_and_atomic_write() {
        let d = tmp("rt");
        let f = d.join("settings.json");
        let st = Store::open(f.clone(), None);
        let after = st.set(&json!({ "jpgQuality": 70, "keys": { "convert": "alt", "tools": "ctrl", "actions": "shift" }, "theme": "dark" }));
        assert_eq!(after.jpg_quality, 70);
        assert!(!d.join("settings.json.tmp").exists());
        st.update(|s| {
            s.watch_folders.push(WatchFolder { id: "w1".into(), folder: "C:\\x".into(), exts: vec!["heic".into()], action: "to:jpg".into(), enabled: true, ..Default::default() });
        });
        let again = Store::open(f.clone(), None).get();
        assert_eq!(again, st.get());
        assert_eq!(again.keys.convert, ModKey::Alt);
        assert_eq!(again.wheel_for_mod(ModKey::Alt), Some("convert"));
        assert_eq!(again.wheel_for_mod(ModKey::Shift), Some("actions"));
        assert_eq!(again.watch_folders[0].action, "to:jpg");
        // The file is camelCase JSON, readable by 1.x.
        let raw: Value = serde_json::from_slice(&std::fs::read(&f).unwrap()).unwrap();
        assert_eq!(raw["watchFolders"][0]["recycleOriginal"], false);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn partial_and_unknown_fields() {
        let s = from_json(&json!({ "keys": { "tools": "none" }, "output": { "folder": "D:\\out" }, "futureThing": 5, "jpgQuality": "bad" }));
        assert_eq!(s.keys.convert, ModKey::Shift);
        assert_eq!(s.keys.tools, ModKey::None);
        assert_eq!(s.output.mode, "beside");
        assert_eq!(s.output.folder, "D:\\out");
        assert_eq!(s.jpg_quality, 88);
        assert_eq!(s.extra["futureThing"], 5);
        assert_eq!(s.wheel_for_mod(ModKey::Ctrl), None);
        assert_eq!(serde_json::to_value(&s).unwrap()["futureThing"], 5);
    }

    #[test]
    fn corrupt_file_is_kept_aside() {
        let d = tmp("corrupt");
        let f = d.join("settings.json");
        std::fs::write(&f, b"{\"jpgQuality\": 7").unwrap();
        let st = Store::open(f.clone(), None);
        assert_eq!(st.get(), Settings::default());
        assert!(d.join("settings.corrupt.json").exists());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn imports_1x_profile_once() {
        let d = tmp("import");
        let old = d.join("v1").join("settings.json");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        let v1 = json!({
            "keys": { "convert": "ctrl", "tools": "shift", "actions": "alt" },
            "selectionHotkey": "Control+Alt+Space", "output": { "mode": "folder", "folder": "D:\\Converted" },
            "revealWhenDone": true, "jpgQuality": 92, "launchAtLogin": false, "sounds": false, "theme": "dark",
            "terminal": "wt", "shelfEdge": "left", "onboarded": true,
            "favorites": { "image": ["to:jpg", "tool:compress"] }, "recents": { "heic": "to:jpg" },
            "presets": [{ "id": "ab12cd34", "name": "Small", "tool": "compress", "options": { "q": 60 }, "kinds": ["image"] }],
            "watchFolders": [{ "id": "w", "folder": "C:\\Users\\me\\Downloads", "exts": ["heic"], "action": "to:jpg", "outFolder": "", "recycleOriginal": true, "enabled": true }],
            "contextMenu": false, "clipboardHotkey": "", "gpuEncode": "off"
        });
        let text = serde_json::to_string_pretty(&v1).unwrap();
        std::fs::write(&old, &text).unwrap();
        let f = d.join("v2").join("settings.json");
        let s = Store::open(f.clone(), Some(old.clone())).get();
        assert_eq!(s.keys.convert, ModKey::Ctrl);
        assert_eq!(s.output.folder, "D:\\Converted");
        assert_eq!(s.presets[0].options, json!({ "q": 60 }));
        assert!(s.watch_folders[0].recycle_original);
        assert_eq!(s.clipboard_hotkey, "");
        assert!(!s.context_menu);
        assert_eq!(s.favorites["image"], json!(["to:jpg", "tool:compress"]));
        assert!(f.exists(), "imported settings are saved in the 2.x profile");
        assert_eq!(std::fs::read_to_string(&old).unwrap(), text, "the 1.x file is left untouched");
        // Every 1.x field came across with the same value.
        let back = serde_json::to_value(&s).unwrap();
        for (k, v) in v1.as_object().unwrap() {
            assert_eq!(&back[k], v, "field {k}");
        }
        // Later starts read the 2.x file, not the 1.x one.
        std::fs::write(&old, b"{\"jpgQuality\": 50}").unwrap();
        assert_eq!(Store::open(f, Some(old)).get().jpg_quality, 92);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn listeners_see_changes() {
        let d = tmp("listen");
        let st = Store::open(d.join("settings.json"), None);
        let seen = std::sync::Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        st.on_change(move |b, a| s2.lock().unwrap().push((b.sounds, a.sounds)));
        st.set(&json!({ "sounds": false }));
        assert_eq!(*seen.lock().unwrap(), vec![(true, false)]);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
