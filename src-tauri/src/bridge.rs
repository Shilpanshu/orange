//! The renderer bridge: the same `send` / `invoke` / `on` shape as Orange 1.x's Electron preload,
//! so renderer code moves over almost unchanged.
//!
//! - `orange.send(channel, ...args)`   -> command `bridge_send`   (fire and forget)
//! - `orange.invoke(channel, ...args)` -> command `bridge_invoke` (returns a value)
//! - `orange.on(channel, fn)`          <- `emit(window, channel, args)`; the payload is the
//!   argument array, spread into `fn` by `web/bridge.ts`.

use crate::{hud, log, wheel, AppState};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Sends `channel` to one window. `args` are spread into the listener's parameters.
pub fn emit(app: &AppHandle, window: &str, channel: &str, args: Value) {
    let args = if args.is_array() { args } else { json!([args]) };
    if let Err(e) = app.emit_to(window, channel, args) {
        log::write(&format!("emit {window}/{channel} failed: {e}"));
    }
}

fn arg_str(args: &[Value], i: usize) -> String {
    args.get(i).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn arg_paths(args: &[Value], i: usize) -> Vec<String> {
    args.get(i)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn bridge_send(window: WebviewWindow, channel: String, args: Vec<Value>) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    if channel.starts_with("wheel:") && channel != "wheel:shown" {
        log::write(&format!("[{label}] {channel} {args:?}"));
    }
    match channel.as_str() {
        "page:ready" => {
            if label == "wheel" {
                app.state::<AppState>().wheel.mark_ready();
                wheel::WheelState::trim_soon(&app);
            } else if label == "hud" {
                hud::page_ready(&app);
            } else if label == "shelf" || label == "clipboard" {
                crate::shelf::page_ready(&app, &label); // [phase2-actions]
            } else if label.starts_with("tool-") {
                crate::tools::page_ready(&app, &label); // [phase2-tools]
            }
        }
        "wheel:choose" => {
            let item = arg_str(&args, 0);
            let paths = arg_paths(&args, 1);
            wheel::close(&app);
            if !item.is_empty() && !paths.is_empty() {
                crate::jobs::run_choice(&app, item, paths);
            }
        }
        "wheel:dismiss" => wheel::close(&app),
        "wheel:shown" => wheel::shown(&app),
        "hud:height" => hud::place(&app, args.first().and_then(Value::as_f64).unwrap_or(80.0)),
        "hud:dismiss" => hud::dismiss(&app, args.first().and_then(Value::as_u64).unwrap_or(0)),
        "hud:cancel" => hud::cancel(&app, args.first().and_then(Value::as_u64).unwrap_or(0)),
        "hud:hold" => hud::hold(&app, args.first().and_then(Value::as_u64).unwrap_or(0), args.get(1).and_then(Value::as_bool).unwrap_or(false)),
        "hud:reveal" => hud::reveal(&app, &arg_str(&args, 0)),
        "hud:open" => hud::open(&app, &arg_str(&args, 0)),
        "hud:undo" => crate::actions::undo(&app, args.first().and_then(Value::as_u64).unwrap_or(0)), // [phase2-actions]
        // [phase2-actions] shelf and clipboard popover
        other if (label == "shelf" || label == "clipboard") && crate::shelf::send(&app, &label, other, &args) => {}
        "log" => log::write(&format!("[{label}] {}", arg_str(&args, 0))),
        other if crate::settings::handle_send(&app, &label, other) => {} // [phase2-settings]
        // [phase2-tools]
        other if label.starts_with("tool-") && crate::tools::send(&app, &window, other, &args) => {}
        other => log::write(&format!("bridge: unknown send {other} from {label}")),
    }
}

#[tauri::command]
pub async fn bridge_invoke(window: WebviewWindow, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let app = window.app_handle();
    // [phase2-tools] tool windows' native channels (file:reveal, theme:dark, tool:open).
    if window.label().starts_with("tool-") {
        if let Some(r) = crate::tools::invoke(app, &window, &channel, &args) {
            return r;
        }
    }
    // [phase2-actions] shelf thumbnails
    if channel == "shelf:thumb" {
        let p = arg_str(&args, 0);
        return Ok(tauri::async_runtime::spawn_blocking(move || crate::shelf::thumb(&p)).await.unwrap_or_default().into());
    }
    // [phase2-settings] settings:*, presets:*, wheel:togglePin, dialog:folder, app:report, app:openLogs.
    // Off the async runtime: the folder picker and the report block.
    {
        let (a, c, g) = (app.clone(), channel.clone(), args.clone());
        if let Ok(Some(r)) = tauri::async_runtime::spawn_blocking(move || crate::settings::handle_invoke(&a, &c, &g)).await {
            return r;
        }
    }
    match channel.as_str() {
        "app:version" => Ok(json!(app.package_info().version.to_string())),
        other => Err(format!("unknown channel {other}")),
    }
}
