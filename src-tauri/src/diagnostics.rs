//! Diagnostics: log rotation, panic capture, and "Report a problem". Everything stays on this PC:
//! the report is a zip on the Desktop the user can attach to a GitHub issue. Port of 1.x
//! `src/main/diagnostics.ts` and the rotation in `src/main/log.ts`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

/// Each log is capped at about this size; one previous log (`orange.old.log`) is kept.
pub const MAX_LOG: u64 = 5 * 1024 * 1024;
static LINES: AtomicU64 = AtomicU64::new(0);
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Moves `file` to `orange.old.log` when it has grown past `max`. Returns true when it rotated.
pub fn rotate(file: &Path, max: u64) -> bool {
    match std::fs::metadata(file) {
        Ok(m) if m.len() > max => std::fs::rename(file, file.with_file_name("orange.old.log")).is_ok(),
        _ => false,
    }
}

/// Called by `log::write` before each append. Checked now and then, not only at start: Orange
/// runs in the tray for weeks.
pub fn maybe_rotate(file: &Path) {
    if LINES.fetch_add(1, Ordering::Relaxed) % 500 == 0 {
        rotate(file, MAX_LOG);
    }
}

/// Logs panics (with location) before the default hook runs.
pub fn init(log_dir: PathBuf, config_dir: PathBuf) {
    let _ = LOG_DIR.set(log_dir);
    let _ = CONFIG_DIR.set(config_dir);
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_default();
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("?").to_string();
        crate::log::write(&format!("panic on {thread} at {at}: {msg}"));
        prev(info);
    }));
}

pub fn log_dir() -> Option<&'static PathBuf> {
    LOG_DIR.get()
}

fn add_dir(zip: &mut zip::ZipWriter<std::fs::File>, dir: &Path, into: &str, max_files: usize) -> std::io::Result<()> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Ok(()) };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (_, f) in files.into_iter().take(max_files) {
        let Ok(bytes) = std::fs::read(&f) else { continue };
        zip.start_file(format!("{into}/{}", f.file_name().unwrap().to_string_lossy()), opts)?;
        zip.write_all(&bytes)?;
    }
    Ok(())
}

/// Writes the report zip to `out`: system.json, the logs, crash files and settings.json.
pub fn write_report(out: &Path, info: &serde_json::Value, log_dir: Option<&Path>, settings_file: Option<&Path>) -> Result<(), String> {
    let f = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(f);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let r = (|| -> std::io::Result<()> {
        zip.start_file("system.json", opts)?;
        zip.write_all(serde_json::to_string_pretty(info).unwrap().as_bytes())?;
        if let Some(d) = log_dir {
            add_dir(&mut zip, d, "logs", 20)?;
            add_dir(&mut zip, &d.join("crashes"), "crashes", 10)?;
        }
        if let Some(s) = settings_file.filter(|s| s.is_file()) {
            zip.start_file("settings.json", opts)?;
            zip.write_all(&std::fs::read(s)?)?;
        }
        Ok(())
    })();
    r.map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn desktop() -> PathBuf {
    use windows::Win32::UI::Shell::{FOLDERID_Desktop, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    unsafe {
        if let Ok(p) = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None) {
            let s = p.to_string().unwrap_or_default();
            windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as _));
            if !s.is_empty() {
                return PathBuf::from(s);
            }
        }
    }
    std::env::var_os("USERPROFILE").map(|u| PathBuf::from(u).join("Desktop")).unwrap_or_else(std::env::temp_dir)
}

fn stamp() -> String {
    // Local time is not in std; UTC from SystemTime is fine for a file name.
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}-{:02}-{:02}", rem / 3600, rem % 3600 / 60)
}

fn system_info(app: &tauri::AppHandle) -> serde_json::Value {
    let os = {
        let v = std::process::Command::new("cmd").args(["/c", "ver"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        v.unwrap_or_else(|| "Windows".into())
    };
    serde_json::json!({
        "app": app.package_info().version.to_string(),
        "identifier": app.config().identifier,
        "tauri": tauri::VERSION,
        "webview2": tauri::webview_version().unwrap_or_default(),
        "os": os,
        "arch": std::env::consts::ARCH,
        "cores": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "installed": crate::settings::is_installed(),
    })
}

/// Builds Orange-report-<date>.zip on the Desktop, shows it in Explorer, and offers to open a
/// GitHub issue. Returns the zip's path.
pub fn report_problem(app: &tauri::AppHandle) -> Result<String, String> {
    let out = desktop().join(format!("Orange-report-{}.zip", stamp()));
    let settings_file = crate::settings::store().file().to_path_buf();
    write_report(&out, &system_info(app), LOG_DIR.get().map(PathBuf::as_path), Some(&settings_file))?;
    let out_s = out.to_string_lossy().into_owned();
    crate::log::write(&format!("problem report written {out_s}"));
    crate::win::reveal(&out_s);
    let name = out.file_name().unwrap().to_string_lossy().into_owned();
    let app2 = app.clone();
    let version = app.package_info().version.to_string();
    std::thread::spawn(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let open = app2
            .dialog()
            .message(format!("{name} contains Orange's logs, crash files, settings and basic system details. It does not include any of your files.\n\nOpen a GitHub issue and attach the zip?"))
            .title("A report was saved to your Desktop")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Open GitHub issue".into(), "Close".into()))
            .blocking_show();
        if open {
            let body = format!("**What happened?**\n\n\n**What did you expect?**\n\n\n**Steps to reproduce**\n1. \n\n---\nOrange {version}\nPlease attach {name} from your Desktop.");
            let url = format!("https://github.com/Shilpanshu/orange/issues/new?title=Problem%3A%20&body={}", encode(&body));
            crate::win::open_path(&url);
        }
    });
    Ok(out_s)
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn open_logs() {
    if let Some(d) = LOG_DIR.get() {
        crate::win::open_path(&d.to_string_lossy());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_keeps_one_old_log() {
        let d = std::env::temp_dir().join(format!("orange-diag-rot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("orange.log");
        std::fs::write(&f, vec![b'x'; 2000]).unwrap();
        assert!(!rotate(&f, 4000));
        assert!(rotate(&f, 1000));
        assert!(!f.exists() && d.join("orange.old.log").exists());
        std::fs::write(&f, vec![b'y'; 3000]).unwrap();
        assert!(rotate(&f, 1000), "replaces the previous old log");
        assert_eq!(std::fs::metadata(d.join("orange.old.log")).unwrap().len(), 3000);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn report_zip_has_logs_settings_and_system() {
        let d = std::env::temp_dir().join(format!("orange-diag-zip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("logs").join("crashes")).unwrap();
        std::fs::write(d.join("logs").join("orange.log"), "hello log").unwrap();
        std::fs::write(d.join("logs").join("crashes").join("a.dmp"), "dump").unwrap();
        std::fs::write(d.join("settings.json"), "{}").unwrap();
        let out = d.join("r.zip");
        write_report(&out, &serde_json::json!({ "app": "2.0.0" }), Some(&d.join("logs")), Some(&d.join("settings.json"))).unwrap();
        let mut z = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let mut names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
        names.sort();
        assert_eq!(names, ["crashes/a.dmp", "logs/orange.log", "settings.json", "system.json"]);
        let mut s = String::new();
        std::io::Read::read_to_string(&mut z.by_name("logs/orange.log").unwrap(), &mut s).unwrap();
        assert_eq!(s, "hello log");
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn stamp_and_encode() {
        assert_eq!(stamp().len(), 16);
        assert_eq!(encode("a b&\n"), "a%20b%26%0A");
    }
}
