//! Runs what the user picked on the wheel. Phase 1 handles image conversion between PNG, JPG and
//! WebP in-process; everything else reports that it isn't in this build yet.

use crate::{convert, hud, AppState};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn ext_of(p: &str) -> String {
    Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn run_choice(app: &AppHandle, item: String, paths: Vec<String>) {
    let Some(target) = item.strip_prefix("to:").map(str::to_string) else {
        hud::notice(app, "That tool arrives in a later Orange 2.0 build");
        return;
    };
    if !convert::supports(&target) || !paths.iter().all(|p| convert::supports(&ext_of(p))) {
        hud::notice(app, &format!("Converting to {} arrives in a later Orange 2.0 build", target.to_uppercase()));
        return;
    }
    // "Last used" for this file type pre-selects the slice next time.
    let exts: std::collections::HashSet<String> = paths.iter().map(|p| ext_of(p)).collect();
    if exts.len() == 1 {
        app.state::<AppState>().wheel.remember_recent(exts.iter().next().unwrap(), &item);
    }
    let title = if paths.len() == 1 {
        format!("Converting {}", Path::new(&paths[0]).file_name().unwrap_or_default().to_string_lossy())
    } else {
        format!("Converting {} files", paths.len())
    };
    let job = hud::start(app, &title);
    std::thread::spawn(move || {
        let n = paths.len();
        let (mut outputs, mut errors) = (Vec::new(), Vec::new());
        for (i, p) in paths.iter().enumerate() {
            if job.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                job.cancelled();
                return;
            }
            let base = i as f64 / n as f64;
            let step = |f: f64| job.progress(base + f / n as f64, (n > 1).then(|| format!("{} of {n}", i + 1)).as_deref());
            let out = unique_path(&Path::new(p).with_extension(&target));
            match convert::image(Path::new(p), &out, &target, &step) {
                Ok(()) => outputs.push(out.to_string_lossy().into_owned()),
                Err(e) => errors.push(format!("{}: {e}", Path::new(p).file_name().unwrap_or_default().to_string_lossy())),
            }
        }
        if outputs.is_empty() {
            job.failed(errors.first().map(String::as_str).unwrap_or("Conversion failed"));
        } else {
            job.done(outputs, errors);
        }
    });
}

/// photo.jpg exists: photo 2.jpg, photo 3.jpg, ...
pub fn unique_path(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let stem = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|i| p.with_file_name(format!("{stem} {i}{ext}")))
        .find(|c| !c.exists())
        .unwrap()
}
