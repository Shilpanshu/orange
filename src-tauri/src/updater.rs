//! Auto-update from GitHub Releases (tauri-plugin-updater + the NSIS installer), with 1.x's UX:
//! check 30 s after launch and every 6 h, download in the background, install when Orange quits,
//! and offer "Restart to update" in the tray once the download is ready.
//!
//! The release workflow publishes `latest.json` (and the minisign `.sig` it embeds); the public
//! key and endpoint live in tauri.conf.json under `plugins.updater`.

use crate::{hud, log};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(30);
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Tray menu id of the "Restart to update" item.
pub const RESTART_ID: &str = "restart-update";

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Idle,
    Checking,
    Downloading { version: String, percent: f64 },
    Ready { version: String },
    Error,
}

struct Inner {
    status: Status,
    /// The downloaded installer, kept until quit (or "Restart to update").
    ready: Option<(Update, Vec<u8>)>,
    tray_menu: Option<Menu<Wry>>,
    tray_item_added: bool,
}

static STATE: Mutex<Inner> = Mutex::new(Inner { status: Status::Idle, ready: None, tray_menu: None, tray_item_added: false });

fn lock() -> std::sync::MutexGuard<'static, Inner> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn status() -> Status {
    lock().status.clone()
}

fn set(s: Status) {
    lock().status = s;
}

/// Updates only make sense for an installed release build. `ORANGE_NO_UPDATE=1` turns them off.
fn enabled() -> bool {
    !cfg!(debug_assertions) && std::env::var("ORANGE_NO_UPDATE").as_deref() != Ok("1")
}

/// The tray's menu, so the "Restart to update" item can be added once an update is ready.
pub fn attach_tray_menu(menu: Menu<Wry>) {
    lock().tray_menu = Some(menu);
}

/// Starts the periodic checks. Call once from setup.
pub fn start(app: &AppHandle) {
    if !enabled() {
        return;
    }
    let app = app.clone();
    // A plain thread that sleeps between checks; each check runs on tauri's async runtime.
    let _ = std::thread::Builder::new().name("orange-updater".into()).spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            tauri::async_runtime::block_on(check(&app, false));
            std::thread::sleep(INTERVAL);
        }
    });
}

/// "Check for updates" from Settings. Never restarts by itself (that would kill running jobs).
pub fn check_from_user(app: &AppHandle) {
    if !enabled() {
        hud::notice(app, "Updates are only available in the installed app.");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { check(&app, true).await });
}

async fn check(app: &AppHandle, manual: bool) {
    match status() {
        Status::Ready { version } => {
            if manual {
                hud::notice(app, &ready_text(&version));
            }
            return;
        }
        Status::Checking | Status::Downloading { .. } => return,
        _ => {}
    }
    set(Status::Checking);
    let update = match app.updater() {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    let update = match update {
        Ok(Some(u)) => u,
        Ok(None) => {
            set(Status::Idle);
            if manual {
                hud::notice(app, &format!("Orange {} is up to date.", app.package_info().version));
            }
            return;
        }
        Err(e) => return fail(app, manual, &e.to_string()),
    };
    let version = update.version.clone();
    log::write(&format!("[update] {version} available, downloading"));
    if manual {
        hud::notice(app, &format!("Downloading Orange {version}…"));
    }
    set(Status::Downloading { version: version.clone(), percent: 0.0 });
    let mut got = 0usize;
    let v = version.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                got += chunk;
                if let Some(t) = total.filter(|t| *t > 0) {
                    set(Status::Downloading { version: v.clone(), percent: got as f64 * 100.0 / t as f64 });
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(b) => b,
        // The signature is verified inside download(); a bad signature lands here too.
        Err(e) => return fail(app, manual, &e.to_string()),
    };
    log::write(&format!("[update] {version} downloaded ({} bytes)", bytes.len()));
    {
        let mut s = lock();
        s.status = Status::Ready { version: version.clone() };
        s.ready = Some((update, bytes));
    }
    add_tray_item(app, &version);
    hud::notice(app, &ready_text(&version));
}

fn fail(app: &AppHandle, manual: bool, err: &str) {
    log::write(&format!("[update] error: {err}"));
    set(Status::Error);
    if manual {
        hud::notice(app, "Couldn't check for updates. Check your connection and try again.");
    }
}

fn ready_text(version: &str) -> String {
    format!("Orange {version} is ready. It installs when you quit, or choose Restart to update in the tray.")
}

fn add_tray_item(app: &AppHandle, version: &str) {
    let mut s = lock();
    if s.tray_item_added {
        return;
    }
    let Some(menu) = s.tray_menu.clone() else { return };
    match MenuItem::with_id(app, RESTART_ID, format!("Restart to update ({version})"), true, None::<&str>) {
        Ok(item) => {
            if menu.insert(&item, 0).is_ok() {
                s.tray_item_added = true;
            }
        }
        Err(e) => log::write(&format!("[update] tray item: {e}")),
    }
}

/// Runs the installer now and relaunches Orange afterwards (tray "Restart to update").
/// On Windows this exits the process.
pub fn restart_now() {
    install(true);
}

/// Installs a downloaded update as Orange quits, without relaunching it. No-op if none is ready.
pub fn install_on_quit() {
    install(false);
}

fn install(restart: bool) {
    let Some((update, bytes)) = lock().ready.take() else { return };
    log::write(&format!("[update] installing {} (restart: {restart})", update.version));
    let update = update.restart_after_install(restart);
    if let Err(e) = update.install(&bytes) {
        log::write(&format!("[update] install failed: {e}"));
    }
}
