//! Saved tool settings ("presets") and the wheel preferences built from settings: pinned slices,
//! the last slice per extension, and presets. Port of 1.x `src/main/presets.ts`.
//! Bridge channels: presets:list / presets:save / presets:rename / presets:delete.

use crate::settings::{self, Preset, Settings, Store};
use serde_json::{json, Value};
use std::path::Path;

const MAX_NAME: usize = 60;

/// File kind of an extension; mirrors `kindOfExt` in src/shared/catalog.ts.
pub fn kind_of_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" | "jfif" | "png" | "webp" | "heic" | "heif" | "tif" | "tiff" | "avif" | "bmp" | "gif" | "svg" | "ico" | "jxl" => "image",
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "wmv" | "flv" | "mpg" | "mpeg" | "ts" | "mts" | "3gp" => "video",
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "oga" | "opus" | "aif" | "aiff" | "wma" | "alac" | "amr" => "audio",
        "pdf" => "pdf",
        "docx" | "doc" | "odt" | "pages" | "md" | "markdown" | "txt" | "rtf" | "html" | "htm" => "document",
        "epub" => "ebook",
        "pptx" | "ppt" | "odp" | "key" => "slides",
        "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" | "csv" | "tsv" | "numbers" => "spreadsheet",
        "srt" | "vtt" => "subtitle",
        "zip" | "tar" | "gz" | "tgz" | "rar" | "7z" => "archive",
        _ => "other",
    }
}

pub fn ext_of(p: &str) -> String {
    Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn kind_of_path(p: &str) -> &'static str {
    if Path::new(p).is_dir() {
        "folder"
    } else {
        kind_of_ext(&ext_of(p))
    }
}

fn clean_name(name: &str, fallback: &str) -> String {
    let n: String = name.split(['\r', '\n', '\t']).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    let n: String = n.trim().chars().take(MAX_NAME).collect();
    if n.is_empty() {
        fallback.to_string()
    } else {
        n
    }
}

fn new_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    format!("{:08x}", h.finish() as u32)
}

pub struct SaveInput {
    pub name: String,
    pub tool: String,
    pub options: Value,
    pub paths: Vec<String>,
    /// The tool's file kinds (from the catalog). Narrowed to the kinds of `paths`.
    pub tool_kinds: Vec<String>,
}

impl SaveInput {
    /// From the bridge: `{ name, tool, options, paths?, kinds? }`.
    pub fn from_value(v: &Value) -> Result<Self, String> {
        let tool = v["tool"].as_str().unwrap_or_default().to_string();
        if tool.is_empty() {
            return Err("Unknown tool \"\".".into());
        }
        let strs = |k: &str| v[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        Ok(Self { name: v["name"].as_str().unwrap_or_default().into(), tool, options: v.get("options").cloned().unwrap_or(json!({})), paths: strs("paths"), tool_kinds: strs("kinds") })
    }
}

/// Kinds the preset applies to: the tool's kinds, narrowed to the files it was saved from.
fn kinds_for(tool_kinds: &[String], paths: &[String]) -> Vec<String> {
    let from: Vec<&str> = paths.iter().map(|p| kind_of_path(p)).collect();
    if tool_kinds.is_empty() {
        let mut k: Vec<String> = from.iter().map(|s| s.to_string()).collect();
        k.dedup();
        return k;
    }
    let narrowed: Vec<String> = tool_kinds.iter().filter(|k| from.contains(&k.as_str())).cloned().collect();
    if narrowed.is_empty() {
        tool_kinds.to_vec()
    } else {
        narrowed
    }
}

pub fn list(st: &Store) -> Vec<Preset> {
    st.get().presets
}

pub fn save(st: &Store, input: SaveInput) -> Preset {
    let p = Preset {
        id: new_id(),
        name: clean_name(&input.name, &input.tool),
        tool: input.tool.clone(),
        // Only plain data is stored.
        options: if input.options.is_null() { json!({}) } else { input.options },
        kinds: kinds_for(&input.tool_kinds, &input.paths),
    };
    let out = p.clone();
    st.update(|s| s.presets.push(p));
    crate::log::write(&format!("preset saved {} {}", out.id, out.tool));
    out
}

pub fn rename(st: &Store, id: &str, name: &str) -> Vec<Preset> {
    st.update(|s| {
        for p in s.presets.iter_mut().filter(|p| p.id == id) {
            p.name = clean_name(name, &p.name);
        }
    })
    .presets
}

pub fn delete(st: &Store, id: &str) -> Vec<Preset> {
    st.update(|s| s.presets.retain(|p| p.id != id)).presets
}

pub fn get_preset(id: &str) -> Option<Preset> {
    settings::get().presets.into_iter().find(|p| p.id == id)
}

/// What the wheel needs to order and decorate slices: pins, last choices, saved presets.
pub fn wheel_prefs(s: &Settings) -> Value {
    let presets: Vec<Value> = s.presets.iter().map(|p| json!({ "id": p.id, "name": p.name, "tool": p.tool, "kinds": p.kinds })).collect();
    json!({ "favorites": s.favorites, "recents": s.recents, "presets": presets })
}

/// Pins or unpins a slice for a file kind. Returns all favorites.
pub fn toggle_pin(st: &Store, key: &str, item: &str) -> Value {
    let s = st.update(|s| {
        let list = s.favorites.entry(key.to_string()).or_insert_with(|| json!([]));
        if !list.is_array() {
            *list = json!([]);
        }
        let arr = list.as_array_mut().unwrap();
        let before = arr.len();
        arr.retain(|v| v.as_str() != Some(item));
        if arr.len() == before {
            arr.push(json!(item));
        }
    });
    Value::Object(s.favorites)
}

/// Remembers the slice last chosen for an extension (skipped for automatic runs).
pub fn remember_recent(st: &Store, ext: &str, item: &str) {
    if ext.is_empty() || st.get().recents.get(ext).and_then(Value::as_str) == Some(item) {
        return;
    }
    st.update(|s| {
        s.recents.insert(ext.to_string(), json!(item));
    });
}

/// Bridge channels owned here. `None` = not a presets channel.
pub fn handle_invoke(channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let st = settings::store();
    let s = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default().to_string();
    Some(match channel {
        "presets:list" => Ok(json!(list(st))),
        "presets:save" => SaveInput::from_value(args.first().unwrap_or(&Value::Null)).map(|i| json!(save(st, i))),
        "presets:rename" => Ok(json!(rename(st, &s(0), &s(1)))),
        "presets:delete" => Ok(json!(delete(st, &s(0)))),
        "wheel:prefs" => Ok(wheel_prefs(&st.get())),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (Store, std::path::PathBuf) {
        let d = std::env::temp_dir().join(format!("orange-presets-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        (Store::open(d.join("settings.json"), None), d)
    }

    #[test]
    fn save_rename_delete() {
        let (st, d) = store("crud");
        let p = save(&st, SaveInput { name: "  Small\nweb  ".into(), tool: "compress".into(), options: json!({ "q": 60 }), paths: vec!["C:\\a.png".into()], tool_kinds: vec!["image".into(), "video".into(), "pdf".into()] });
        assert_eq!(p.name, "Small web");
        assert_eq!(p.kinds, vec!["image"]);
        assert_eq!(p.id.len(), 8);
        let long = "x".repeat(80);
        let after = rename(&st, &p.id, &long);
        assert_eq!(after[0].name.len(), 60);
        assert_eq!(rename(&st, &p.id, "   ")[0].name.len(), 60, "blank keeps the old name");
        let prefs = wheel_prefs(&st.get());
        assert_eq!(prefs["presets"][0]["tool"], "compress");
        assert!(delete(&st, &p.id).is_empty());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn pins_and_recents_persist() {
        let (st, d) = store("pins");
        assert_eq!(toggle_pin(&st, "image", "to:jpg"), json!({ "image": ["to:jpg"] }));
        toggle_pin(&st, "image", "tool:compress");
        assert_eq!(toggle_pin(&st, "image", "to:jpg"), json!({ "image": ["tool:compress"] }));
        remember_recent(&st, "heic", "to:jpg");
        let again = Store::open(st.file().to_path_buf(), None).get();
        assert_eq!(wheel_prefs(&again), json!({ "favorites": { "image": ["tool:compress"] }, "recents": { "heic": "to:jpg" }, "presets": [] }));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn kinds() {
        assert_eq!(kind_of_ext("HEIC"), "image");
        assert_eq!(kind_of_ext("numbers"), "spreadsheet");
        assert_eq!(kind_of_ext("xyz"), "other");
    }
}
