//! Settings, presets and updater checks, against the planned `settings` / `updater` APIs.
#![allow(unexpected_cfgs, unused_imports)]

#[macro_use]
mod common;

use common::*;
use serde_json::json;

pending!(settings, settings_defaults_from_empty_json, {
    let s = orange_lib::settings::from_json(&json!({}));
    let back = serde_json::to_value(&s).unwrap();
    assert!(back.is_object());
    // An empty file gives the same settings as defaults.
    assert_eq!(back, serde_json::to_value(orange_lib::settings::from_json(&json!(null))).unwrap());
});

pending!(settings, settings_round_trip, {
    let s = orange_lib::settings::from_json(&json!({}));
    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(serde_json::to_value(orange_lib::settings::from_json(&v)).unwrap(), v);
});

pending!(settings, settings_ignore_unknown_and_wrong_typed_fields, {
    let s = orange_lib::settings::from_json(&json!({ "nonsense": 1, "keys": "not an object" }));
    let d = serde_json::to_value(orange_lib::settings::from_json(&json!({}))).unwrap();
    assert_eq!(serde_json::to_value(&s).unwrap()["keys"], d["keys"]);
});

pending!(settings, write_atomic_replaces_whole_file, {
    let d = CaseDir::new("atomic");
    let f = d.join("settings.json");
    std::fs::write(&f, "old contents that are longer").unwrap();
    orange_lib::settings::write_atomic(&f, b"{}").unwrap();
    assert_eq!(std::fs::read(&f).unwrap(), b"{}");
    assert_eq!(d.files(), [f], "temporary file left behind");
});

// Version ordering is done by tauri-plugin-updater (semver), so Orange has no comparison function of its
// own to test. What Orange owns is the update schedule and the tray item; those need a running app.
