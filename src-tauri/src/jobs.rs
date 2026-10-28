//! Runs what the user picked on the wheel. Conversions ("to:<ext>") are checked against the real
//! files (the wheel guessed from MIME types), then run per file with limited parallelism (media is
//! heavy, office suites one at a time), with aggregated progress, Cancel, friendly errors and
//! Undo (new files go to the Recycle Bin) in the HUD, as jobs.ts did.
//!
//! Public: `run_choice(app, item, paths)`; `run_conversion(app, target, paths, out_dir, auto, item)`
//! and `run_conversion_then(..., on_done)` for watch folders (results into `out_dir`; `auto` skips
//! "last used" and revealing in Explorer); `unique_path`.

use crate::{convert, hud, AppState};
use convert::{Ctx, Fail, Kind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

fn ext_of(p: &str) -> String {
    Path::new(p).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Settings → the converters' preferences (read when each file starts).
pub fn prefs_from_settings() -> convert::Prefs {
    let s = crate::settings::get();
    convert::Prefs {
        jpg_quality: s.jpg_quality.clamp(1, 100),
        output_folder: (s.output.mode == "folder" && !s.output.folder.trim().is_empty()).then(|| PathBuf::from(s.output.folder.trim())),
        gpu_encode: s.gpu_encode != "off",
        reveal_when_done: s.reveal_when_done,
    }
}

pub fn run_choice(app: &AppHandle, item: String, paths: Vec<String>) {
    // [phase2-actions] Actions wheel: share, float, copy, move, copy path, terminal.
    if let Some(id) = item.strip_prefix("action:") {
        crate::actions::run(app, id, paths);
        return;
    }
    // [phase2-tools] Tools wheel: open the tool's window (it runs its own job).
    if let Some(id) = item.strip_prefix("tool:") {
        crate::tools::open_from_wheel(app, id, paths, None);
        return;
    }
    // [phase2-tools] A saved preset runs its tool with the saved options, without a window.
    if let Some(id) = item.strip_prefix("preset:") {
        crate::tools::run_preset(app, id, paths);
        return;
    }
    let Some(target) = item.strip_prefix("to:").map(str::to_string) else {
        hud::notice(app, "That isn't something Orange can run.");
        return;
    };
    run_conversion(app, &target, paths, None, false, Some(&item));
}

fn label(paths: &[PathBuf]) -> String {
    if paths.len() == 1 {
        convert::file_name(&paths[0])
    } else {
        format!("{} files", paths.len())
    }
}

fn describe(paths: &[PathBuf]) -> String {
    if paths.len() == 1 {
        convert::file_name(&paths[0])
    } else {
        format!("these {} files", paths.len())
    }
}

/// Converts `paths` to `target` ("png", "zip", "extract") as one HUD job, on worker threads.
pub fn run_conversion(app: &AppHandle, target: &str, paths: Vec<String>, out_dir: Option<PathBuf>, auto: bool, item: Option<&str>) {
    run_conversion_then(app, target, paths, out_dir, auto, item, |_| {});
}

/// `run_conversion`, then `on_done(outputs)` once the job has finished (also after a cancel).
pub fn run_conversion_then(app: &AppHandle, target: &str, paths: Vec<String>, out_dir: Option<PathBuf>, auto: bool, item: Option<&str>, on_done: impl FnOnce(Vec<String>) + Send + 'static) {
    convert::set_prefs_source(prefs_from_settings);
    crate::engines::set_app(app);
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.exists()).collect();
    if paths.is_empty() {
        return;
    }
    let has_folder = paths.iter().any(|p| p.is_dir());
    let exts: Vec<String> = paths.iter().filter(|p| !p.is_dir()).map(|p| ext_of(&p.to_string_lossy())).collect();
    let target = target.to_string();
    if !convert::valid_targets(&exts, has_folder).contains(&target.as_str()) {
        hud::notice(app, &format!("Can't convert {} to {}.", describe(&paths), target.to_uppercase()));
        return;
    }
    // "Last used" for this file type pre-selects the slice next time.
    let uniq: std::collections::HashSet<&String> = exts.iter().collect();
    if let (false, Some(item), 1) = (auto, item, uniq.len()) {
        if !exts[0].is_empty() {
            app.state::<AppState>().wheel.remember_recent(&exts[0], item);
        }
    }
    let kinds: std::collections::HashSet<Kind> = exts.iter().map(|e| convert::kind_of_ext(e)).collect();
    let combined = (has_folder || kinds.len() > 1) && ["zip", "tar", "gz", "7z"].contains(&target.as_str());
    let title = if combined {
        format!("Compressing {}", if paths.len() == 1 { convert::file_name(&paths[0]) } else { format!("{} items", paths.len()) })
    } else if target == "extract" {
        format!("Extracting {}", label(&paths))
    } else {
        format!("Converting {} to {}", label(&paths), target.to_uppercase())
    };
    let job = Arc::new(hud::start(app, &title));
    let kind = kinds.iter().next().copied().unwrap_or(Kind::Other);
    let app = app.clone();
    std::thread::spawn(move || {
        let outputs = Mutex::new(Vec::<String>::new());
        let errors = Mutex::new(Vec::<String>::new());
        let mut fatal: Option<Fail> = None;
        let n = paths.len();
        let frac = Arc::new(Mutex::new(vec![0.0f64; if combined { 1 } else { n }]));
        let push = {
            let job = job.clone();
            let frac = frac.clone();
            move |note: Option<&str>| {
                let total = {
                    let f = frac.lock().unwrap();
                    f.iter().sum::<f64>() / f.len().max(1) as f64
                };
                job.progress(total, note);
            }
        };
        let make_ctx = |i: usize| {
            let frac = frac.clone();
            let push = push.clone();
            let mut c = Ctx::new(
                move |f, note| {
                    frac.lock().unwrap()[i] = f.clamp(0.0, 1.0);
                    push(note);
                },
                job.cancelled.clone(),
            );
            c.out_override = out_dir.clone();
            c
        };
        if combined {
            let ctx = make_ctx(0);
            match convert::pack(&paths, &target, &ctx) {
                Ok(o) => outputs.lock().unwrap().extend(o.into_iter().map(|p| p.to_string_lossy().into_owned())),
                Err(e) => fatal = Some(e),
            }
        } else {
            let next = AtomicUsize::new(0);
            let workers = convert::concurrency(kind).min(n).max(1);
            std::thread::scope(|s| {
                for _ in 0..workers {
                    s.spawn(|| loop {
                        if job.cancelled.load(Ordering::SeqCst) {
                            break;
                        }
                        let i = next.fetch_add(1, Ordering::SeqCst);
                        if i >= n {
                            break;
                        }
                        let input = &paths[i];
                        let ctx = make_ctx(i);
                        let r = convert::convert(input, &target, &ctx);
                        drop(ctx);
                        match r {
                            Ok(o) => outputs.lock().unwrap().extend(o.into_iter().map(|p| p.to_string_lossy().into_owned())),
                            Err(Fail::Cancelled) => {}
                            Err(e) => {
                                crate::log::write(&format!("file failed {}: {e:?}", input.display()));
                                errors.lock().unwrap().push(format!("{}: {}", convert::file_name(input), convert::friendly(&e)));
                            }
                        }
                        frac.lock().unwrap()[i] = 1.0;
                        push(None);
                    });
                }
            });
        }
        let outputs = outputs.into_inner().unwrap();
        let errors = errors.into_inner().unwrap();
        if job.cancelled.load(Ordering::SeqCst) {
            job.cancelled();
        } else if let Some(e) = fatal {
            crate::log::write(&format!("job failed {title}: {e:?}"));
            job.failed(&convert::friendly(&e));
        } else if outputs.is_empty() {
            job.failed(&errors.join("\n"));
        } else {
            if !auto && convert::prefs().reveal_when_done {
                hud::reveal(&app, &outputs[0]);
            }
            job.done(outputs.clone(), errors);
        }
        on_done(outputs);
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

/// Watch folders' converter (registered in lib.rs): "to:<ext>" (or "<ext>") on one file, run
/// synchronously on the watcher's thread without a HUD row. Never touches "last used".
pub struct WatchRunner;

impl crate::watch::Runner for WatchRunner {
    fn fits(&self, action: &str, ext: &str) -> bool {
        let t = action.strip_prefix("to:").unwrap_or(action);
        convert::valid_targets(&[ext.to_lowercase()], false).contains(&t)
    }
    fn run(&self, action: &str, path: &Path, out_dir: Option<&Path>) -> Option<Vec<String>> {
        convert::set_prefs_source(prefs_from_settings);
        let t = action.strip_prefix("to:").unwrap_or(action);
        let mut ctx = Ctx::new(|_, _| {}, Arc::new(std::sync::atomic::AtomicBool::new(false)));
        ctx.out_override = out_dir.map(Path::to_path_buf);
        match convert::convert(path, t, &ctx) {
            Ok(o) => Some(o.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()),
            Err(e) => {
                crate::log::write(&format!("watch convert failed {}: {e:?}", path.display()));
                None
            }
        }
    }
}
