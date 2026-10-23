//! A tiny append-only log in the app's data folder (and stderr in debug builds).

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static PATH: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = PATH.set(dir.join("orange.log"));
}

pub fn write(msg: &str) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let line = format!("{secs:.3} {msg}\n");
    #[cfg(debug_assertions)]
    eprint!("{line}");
    let Some(p) = PATH.get() else { return };
    let _g = LOCK.lock();
    crate::diagnostics::maybe_rotate(p); // [phase2-settings] ~5 MB cap, one orange.old.log
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = f.write_all(line.as_bytes());
    }
}
