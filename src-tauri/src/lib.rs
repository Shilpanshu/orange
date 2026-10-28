//! Orange 2.0 on Tauri: tray app, global drag hooks, radial wheel, HUD.

pub mod bridge;
pub mod convert;
pub mod drag;
pub mod engines; // [phase2-convert] downloaded engines
pub mod hooks;
pub mod hud;
pub mod jobs;
pub mod log;
#[cfg(feature = "selftest")]
pub mod selftest;
pub mod updater; // [phase2-updater]
pub mod wheel;
pub mod win;
pub mod tools; // [phase2-tools]
// [phase2-actions]
pub mod actions;
pub mod clipboard;
pub mod explorer;
pub mod shelf;
// [phase2-settings]
pub mod context_menu;
pub mod diagnostics;
pub mod presets;
pub mod settings;
pub mod shortcuts;
pub mod watch;

use drag::{Mod, Output};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent};

#[derive(Default)]
pub struct AppState {
    pub wheel: wheel::WheelState,
    pub hud: hud::HudState,
}

/// WebView2 command-line switches. Every webview sharing the user-data folder must use the same
/// ones (WebView2 refuses a second environment with different arguments). The first part is
/// wry's default. `ORANGE_BROWSER_ARGS` overrides it for measurements.
pub fn browser_args() -> String {
    std::env::var("ORANGE_BROWSER_ARGS").unwrap_or_else(|_| {
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Translate,OptimizationHints,AutofillServerCommunication \
         --disable-gpu --disable-background-networking --renderer-process-limit=1 --no-pings"
            .into()
    })
}

/// Asks WebView2 to trim a hidden webview's memory (or restore it before showing).
pub fn set_low_memory(w: &tauri::WebviewWindow, low: bool) {
    if std::env::var("ORANGE_LOW_MEM").as_deref() == Ok("0") {
        return;
    }
    let _ = w.with_webview(move |wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows::core::Interface;
        if let Ok(core) = wv.controller().CoreWebView2() {
            if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
                let _ = c19.SetMemoryUsageTargetLevel(level);
            }
        }
    });
}

/// Which wheel a modifier opens: Settings > Shortcuts. [phase2-settings]
fn wheel_for(m: Mod) -> Option<&'static str> {
    use settings::ModKey;
    settings::get().wheel_for_mod(match m {
        Mod::Shift => ModKey::Shift,
        Mod::Ctrl => ModKey::Ctrl,
        Mod::Alt => ModKey::Alt,
    })
}

fn open_settings(app: &AppHandle) {
    settings::open_settings(app, None); // [phase2-settings]
}

/// Reacts to what the hooks saw. Runs on its own thread so the hook thread never waits.
fn spawn_event_loop(app: AppHandle, rx: std::sync::mpsc::Receiver<Output>) {
    std::thread::Builder::new()
        .name("orange-events".into())
        .spawn(move || {
            for out in rx {
                match out {
                    Output::DragStart => explorer::drag_started(), // [phase2-actions]
                    Output::Modifier(m) => {
                        let Some(kind) = wheel_for(m) else { continue }; // [phase2-settings] key set to Off
                        wheel::open(&app, kind, wheel::Mode::Drag, None);
                        explorer::send_drag_selection(&app); // [phase2-actions]
                    }
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
    // [phase2-actions]
    let shelf_item = MenuItem::with_id(app, "shelf", "Show shelf", true, None::<&str>)?;
    let clip_item = MenuItem::with_id(app, "clipboard", "Convert clipboard…", true, None::<&str>)?;
    // [phase2-settings]
    let howto = MenuItem::with_id(app, "howto", "How to use", true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report", "Report a problem…", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &howto, &shelf_item, &clip_item, &report, &quit])?;
    updater::attach_tray_menu(menu.clone()); // [phase2-updater] "Restart to update" is inserted when ready
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Orange: drag a file, tap Shift")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "settings" => open_settings(app),
            "quit" => app.exit(0),
            "howto" => settings::open_settings(app, Some("welcome")), // [phase2-settings]
            "report" => {
                let a = app.clone();
                std::thread::spawn(move || {
                    if let Err(e) = diagnostics::report_problem(&a) {
                        log::write(&format!("report failed: {e}"));
                    }
                });
            }
            "shelf" => shelf::add(app, vec![]),             // [phase2-actions]
            "clipboard" => clipboard::toggle(app),          // [phase2-actions]
            updater::RESTART_ID => updater::restart_now(), // [phase2-updater]
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
        // [phase2-settings] ...unless it is an Explorer right-click launch: those gather into one wheel.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if tools::test_mode() {
                return;
            }
            if !context_menu::handle_argv(app, &args) {
                open_settings(app);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build()) // [phase2-settings]
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None)) // [phase2-settings]
        .plugin(tauri_plugin_dialog::init()) // [phase2-settings]
        .plugin(tauri_plugin_updater::Builder::new().build()) // [phase2-updater]
        .manage(AppState::default())
        // [phase2-tools] file IO for tool windows (http://ofs.localhost/...)
        .register_asynchronous_uri_scheme_protocol("ofs", |_ctx, req, responder| {
            std::thread::spawn(move || responder.respond(tools::protocol(req)));
        })
        .invoke_handler(tauri::generate_handler![
            bridge::bridge_send,
            bridge::bridge_invoke,
            tools::tools_window, // [phase2-tools]
            tools::tools_hud,
            tools::tools_dialog,
            tools::tools_info,
            tools::tools_spawn,
            tools::tools_engine,
            tools::tools_engine_info,
            tools::tools_kill
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Ok(dir) = handle.path().app_log_dir() {
                log::init(dir);
            }
            // [phase2-settings] panic capture; the settings store (imports 1.x on first start)
            diagnostics::init(handle.path().app_log_dir().unwrap_or_default(), handle.path().app_config_dir().unwrap_or_default());
            settings::init(handle.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir()));
            engines::set_app(&handle); // [phase2-convert]
            // [phase2-tools] ORANGE_TOOL_TEST_DIR: a test app serves tool requests, nothing else.
            if tools::test_mode() {
                tools::start_test_server(&handle);
                log::write("test server ready");
                return Ok(());
            }
            watch::set_runner(jobs::WatchRunner); // [phase2-convert]
            build_tray(&handle)?;
            let (tx, rx) = std::sync::mpsc::channel();
            hooks::start(tx);
            // [phase2-actions] warm the Shell COM path; clipboard hotkey (Settings may change it)
            explorer::warm_up();
            // [phase2-settings] Both global shortcuts (Explorer selection, clipboard) are registered
            // by shortcuts.rs from settings via tauri-plugin-global-shortcut, so clipboard.rs's own
            // RegisterHotKey thread is not started (the two would fight over Control+Alt+V).
            shortcuts::set_selection_provider(explorer::selection);
            shortcuts::set_clipboard_action(clipboard::toggle);
            spawn_event_loop(handle.clone(), rx);
            updater::start(&handle); // [phase2-updater]
            tools::maybe_test(&handle); // [phase2-tools] ORANGE_TOOL_TEST: off-screen tool window runs
            settings::start(&handle); // [phase2-settings] shortcuts, autostart, Explorer menu, watch folders
            context_menu::handle_argv(&handle, &std::env::args().collect::<Vec<_>>()); // [phase2-settings]
            log::write(&format!("tray and hooks up in {:.1} ms", started.elapsed().as_secs_f64() * 1000.0));
            // The wheel's webview takes a few hundred ms to create; do it after the tray is up so
            // start-up isn't held for it. It is ready long before anyone can start a drag.
            let h = handle.clone();
            std::thread::spawn(move || {
                if let Err(e) = wheel::create(&h) {
                    log::write(&format!("wheel window: {e}"));
                }
                log::write(&format!("wheel window created at {:.1} ms", started.elapsed().as_secs_f64() * 1000.0));
            });
            #[cfg(feature = "selftest")]
            selftest::maybe_start(&handle, started);
            Ok(())
        })
        .build({
            let mut context = tauri::generate_context!();
            tools::test_identity(context.config_mut()); // [phase2-tools] test apps never use the installed identity
            context
        })
        .expect("error while building Orange");
    app.run(|_app, e| {
        // [phase2-updater] A downloaded update installs as Orange quits (1.x behaviour).
        if matches!(e, RunEvent::Exit) {
            watch::stop(); // [phase2-settings]
            shortcuts::unregister_all(_app);
            updater::install_on_quit();
        }
        // Orange lives in the tray: closing its last window must not quit it.
        if let RunEvent::ExitRequested { code: None, api, .. } = e {
            api.prevent_exit();
        }
    });
}
