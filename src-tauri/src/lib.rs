//! Orange 2.0 on Tauri: tray app, global drag hooks, radial wheel, HUD.

pub mod bridge;
pub mod convert;
pub mod drag;
pub mod hooks;
pub mod hud;
pub mod jobs;
pub mod log;
#[cfg(feature = "selftest")]
pub mod selftest;
pub mod wheel;
pub mod win;

use drag::{Mod, Output};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct AppState {
    pub wheel: wheel::WheelState,
    pub hud: hud::HudState,
}

/// Which wheel a modifier opens (Settings will make this configurable, as in 1.x).
fn wheel_for(m: Mod) -> &'static str {
    match m {
        Mod::Shift => "convert",
        Mod::Ctrl => "tools",
        Mod::Alt => "actions",
    }
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("renderer/settings/index.html".into()))
        .title("Orange Settings")
        .inner_size(520.0, 360.0)
        .drag_and_drop(false)
        .build();
}

/// Reacts to what the hooks saw. Runs on its own thread so the hook thread never waits.
fn spawn_event_loop(app: AppHandle, rx: std::sync::mpsc::Receiver<Output>) {
    std::thread::Builder::new()
        .name("orange-events".into())
        .spawn(move || {
            for out in rx {
                match out {
                    Output::DragStart => {}
                    Output::Modifier(m) => wheel::open(&app, wheel_for(m), wheel::Mode::Drag, None),
                    Output::Release => wheel::release_soon(&app),
                    Output::Nav(n) => wheel::nav(&app, n.name()),
                }
            }
        })
        .expect("event thread");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Orange", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Orange: drag a file, tap Shift")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "settings" => open_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                open_settings(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    let started = std::time::Instant::now();
    let app = tauri::Builder::default()
        // A second launch opens Settings in the running instance instead of starting another.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_settings(app)))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![bridge::bridge_send, bridge::bridge_invoke])
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Ok(dir) = handle.path().app_log_dir() {
                log::init(dir);
            }
            build_tray(&handle)?;
            wheel::create(&handle)?;
            let (tx, rx) = std::sync::mpsc::channel();
            hooks::start(tx);
            spawn_event_loop(handle.clone(), rx);
            log::write(&format!("started in {:.1} ms", started.elapsed().as_secs_f64() * 1000.0));
            #[cfg(feature = "selftest")]
            selftest::maybe_start(&handle, started);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Orange");
    app.run(|_app, e| {
        // Orange lives in the tray: closing its last window must not quit it.
        if let RunEvent::ExitRequested { code: None, api, .. } = e {
            api.prevent_exit();
        }
    });
}
