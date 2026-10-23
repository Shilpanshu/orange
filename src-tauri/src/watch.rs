//! Watch folders: new files that land in a watched folder are converted (or run through an
//! instant tool or a preset) automatically. Port of 1.x `src/main/watch.ts` on the `notify` crate.
//!
//! A file is only picked up once it is finished: its size and modified time must hold still
//! across two checks and it must not be locked by the program writing it. Browser partials
//! (.crdownload, .part, .tmp, ...) are ignored; the finished file shows up under its final name.
//! Files that were already there when watching started are left alone, and everything Orange
//! itself creates is remembered so a result never triggers another run.

use crate::settings::WatchFolder;
use notify::{RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime};

/// Tools that run without a window, so they can run unattended. Mirrors INSTANT_TOOLS in 1.x.
pub const INSTANT_TOOLS: &[&str] = &["extractArchive"];

/// Written by browsers and download managers while a file is still arriving.
const PARTIAL_EXTS: &[&str] = &["crdownload", "part", "partial", "tmp", "temp", "download", "opdownload", "filepart", "crswap", "!ut", "!qb", "aria2", "dtapart", "downloading"];
const IGNORED_NAMES: &[&str] = &["desktop.ini", "thumbs.db", ".ds_store"];
/// Placeholders (Firefox) are filled in later; give up on files that stay empty this long.
const EMPTY_GIVE_UP: Duration = Duration::from_secs(10 * 60);
/// When a run's outputs are unknown, new files named after the input count as ours this long.
const LATE_WRITES: Duration = Duration::from_secs(5 * 60);

/// What the service needs from the app. Tests substitute their own.
pub trait Deps: Send + Sync + 'static {
    fn folders(&self) -> Vec<WatchFolder>;
    /// Whether `action` can run on a file with this extension.
    fn fits(&self, action: &str, ext: &str) -> bool;
    /// Runs `action` on `path`, saving into `out_dir` (or beside the file). Returns the files made,
    /// or `None` when they aren't known.
    fn run(&self, action: &str, path: &Path, out_dir: Option<&Path>) -> Option<Vec<String>>;
    fn trash(&self, path: &Path) -> Result<(), String>;
    fn log(&self, msg: &str) {
        crate::log::write(msg);
    }
}

pub fn key_of(p: &Path) -> String {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    abs.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase()
}

fn ext_of_name(n: &str) -> String {
    Path::new(n).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn stem_of(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Normalises user-typed extensions: ".JPG", "*.jpg", "jpg" -> "jpg".
pub fn normalize_exts(exts: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for e in exts {
        let e = e.trim().to_lowercase();
        let e = e.strip_prefix('*').unwrap_or(&e);
        let e = e.strip_prefix('.').unwrap_or(e).to_string();
        if !e.is_empty() && !out.contains(&e) {
            out.push(e);
        }
    }
    out
}

/// Only unattended actions are allowed: conversions, instant tools and presets.
pub fn action_allowed(action: &str) -> bool {
    let rest = |p: &str| action.strip_prefix(p).filter(|r| !r.is_empty());
    rest("to:").is_some() || rest("preset:").is_some() || rest("tool:").is_some_and(|t| INSTANT_TOOLS.contains(&t))
}

/// True while another program holds the file without write sharing (Explorer copies, most
/// downloaders, Office saves).
pub fn is_locked(p: &Path) -> bool {
    match std::fs::OpenOptions::new().read(true).write(true).open(p) {
        Ok(_) => false,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                // A read-only file refuses write access but isn't locked.
                return !std::fs::metadata(p).map(|m| m.permissions().readonly()).unwrap_or(false);
            }
            // 32 = sharing violation, 33 = lock violation.
            matches!(e.raw_os_error(), Some(32) | Some(33))
        }
    }
}

struct FolderWatch {
    wf: Mutex<WatchFolder>,
    /// Lower-case names already seen in the folder.
    known: Mutex<HashSet<String>>,
    settling: Mutex<HashSet<String>>,
    stopped: AtomicBool,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

struct Inflight {
    dirs: Vec<String>,
    stem: String,
    until: Option<Instant>,
}

struct Inner {
    deps: Box<dyn Deps>,
    settle: Duration,
    rescan: Duration,
    watches: Mutex<HashMap<String, Arc<FolderWatch>>>,
    own: Mutex<HashSet<String>>,
    inflight: Mutex<HashMap<u64, Inflight>>,
    seq: AtomicU64,
    queue: Mutex<Option<Sender<(Arc<FolderWatch>, PathBuf)>>>,
}

#[derive(Clone)]
pub struct WatchService(Arc<Inner>);

impl WatchService {
    pub fn new(deps: impl Deps, settle: Duration, rescan: Duration) -> Self {
        let inner = Arc::new(Inner {
            deps: Box::new(deps),
            settle,
            rescan,
            watches: Mutex::new(HashMap::new()),
            own: Mutex::new(HashSet::new()),
            inflight: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            queue: Mutex::new(None),
        });
        // One worker runs the queue, one file at a time.
        let (tx, rx) = channel::<(Arc<FolderWatch>, PathBuf)>();
        *inner.queue.lock().unwrap() = Some(tx);
        let weak = Arc::downgrade(&inner);
        std::thread::Builder::new()
            .name("orange-watch-queue".into())
            .spawn(move || {
                for (w, full) in rx {
                    let Some(inner) = weak.upgrade() else { break };
                    process(&inner, &w, &full);
                }
            })
            .expect("watch queue thread");
        Self(inner)
    }

    /// Applies the current watch-folder list, keeping watchers whose folder didn't change.
    pub fn sync(&self) {
        let inner = &self.0;
        let mut wanted: Vec<WatchFolder> = vec![];
        for wf in inner.deps.folders() {
            if !wf.enabled || wf.folder.is_empty() || !action_allowed(&wf.action) {
                continue;
            }
            if !Path::new(&wf.folder).is_dir() {
                inner.deps.log(&format!("watch: folder missing {}", wf.folder));
                continue;
            }
            wanted.push(wf);
        }
        let mut watches = inner.watches.lock().unwrap();
        watches.retain(|id, w| {
            let next = wanted.iter().find(|x| &x.id == id);
            let same = next.is_some_and(|n| key_of(Path::new(&n.folder)) == key_of(Path::new(&w.wf.lock().unwrap().folder)));
            if same {
                // Same folder: keep what it has seen, take the new settings.
                *w.wf.lock().unwrap() = next.unwrap().clone();
            } else {
                stop_watch(w);
            }
            same
        });
        for wf in wanted {
            if watches.contains_key(&wf.id) {
                continue;
            }
            let w = Arc::new(FolderWatch { wf: Mutex::new(wf.clone()), known: Mutex::new(HashSet::new()), settling: Mutex::new(HashSet::new()), stopped: AtomicBool::new(false), watcher: Mutex::new(None) });
            start_watch(inner, &w);
            watches.insert(wf.id.clone(), w);
        }
    }

    pub fn stop(&self) {
        for (_, w) in self.0.watches.lock().unwrap().drain() {
            stop_watch(&w);
        }
    }

    pub fn watching(&self) -> Vec<String> {
        self.0.watches.lock().unwrap().values().map(|w| w.wf.lock().unwrap().folder.clone()).collect()
    }

    /// Files Orange made elsewhere (e.g. a manual conversion into a watched folder).
    pub fn mark_own(&self, paths: &[String]) {
        let mut own = self.0.own.lock().unwrap();
        for p in paths {
            own.insert(key_of(Path::new(p)));
        }
    }
}

fn stop_watch(w: &FolderWatch) {
    w.stopped.store(true, Ordering::SeqCst);
    w.watcher.lock().unwrap().take();
}

fn start_watch(inner: &Arc<Inner>, w: &Arc<FolderWatch>) {
    let folder = w.wf.lock().unwrap().folder.clone();
    match std::fs::read_dir(&folder) {
        Ok(rd) => {
            let mut known = w.known.lock().unwrap();
            for e in rd.flatten() {
                known.insert(e.file_name().to_string_lossy().to_lowercase());
            }
        }
        Err(e) => {
            inner.deps.log(&format!("watch: cannot read folder {folder}: {e}"));
            return;
        }
    }
    let (wi, ww) = (Arc::downgrade(inner), Arc::downgrade(w));
    let handler = move |res: notify::Result<notify::Event>| {
        let (Some(inner), Some(w)) = (wi.upgrade(), ww.upgrade()) else { return };
        match res {
            Ok(ev) if !ev.paths.is_empty() => {
                for p in ev.paths {
                    if let Some(n) = p.file_name() {
                        on_name(&inner, &w, &n.to_string_lossy());
                    }
                }
            }
            Ok(_) => rescan(&inner, &w),
            Err(e) => inner.deps.log(&format!("watch: watcher error: {e}")),
        }
    };
    match notify::recommended_watcher(handler).and_then(|mut wt| wt.watch(Path::new(&folder), RecursiveMode::NonRecursive).map(|_| wt)) {
        Ok(wt) => *w.watcher.lock().unwrap() = Some(wt),
        Err(e) => inner.deps.log(&format!("watch: cannot watch folder {folder}: {e}")),
    }
    // Safety-net rescan, for events the watcher misses (network drives, bursts).
    let (wi, ww) = (Arc::downgrade(inner), Arc::downgrade(w));
    let every = inner.rescan;
    std::thread::spawn(move || loop {
        std::thread::sleep(every);
        let (Some(inner), Some(w)) = (wi.upgrade(), ww.upgrade()) else { return };
        if w.stopped.load(Ordering::SeqCst) {
            return;
        }
        rescan(&inner, &w);
    });
    inner.deps.log(&format!("watch: watching {folder} {}", w.wf.lock().unwrap().action));
}

fn rescan(inner: &Arc<Inner>, w: &Arc<FolderWatch>) {
    if w.stopped.load(Ordering::SeqCst) {
        return;
    }
    let folder = w.wf.lock().unwrap().folder.clone();
    let Ok(rd) = std::fs::read_dir(&folder) else { return };
    let names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    let present: HashSet<String> = names.iter().map(|n| n.to_lowercase()).collect();
    let fresh: Vec<String> = {
        let mut known = w.known.lock().unwrap();
        known.retain(|k| present.contains(k));
        names.into_iter().filter(|n| !known.contains(&n.to_lowercase())).collect()
    };
    for n in fresh {
        on_name(inner, w, &n);
    }
}

fn on_name(inner: &Arc<Inner>, w: &Arc<FolderWatch>, name: &str) {
    if w.stopped.load(Ordering::SeqCst) || name.contains(['\\', '/']) {
        return;
    }
    let folder = w.wf.lock().unwrap().folder.clone();
    let full = Path::new(&folder).join(name);
    let key = name.to_lowercase();
    if !full.exists() {
        // Deleted or renamed away: a new file with this name later counts as new again.
        w.known.lock().unwrap().remove(&key);
        return;
    }
    if !w.known.lock().unwrap().insert(key) {
        return;
    }
    if !candidate(inner, w, name, &full) {
        return;
    }
    settle(inner, w, full);
}

fn candidate(inner: &Inner, w: &FolderWatch, name: &str, full: &Path) -> bool {
    let lower = name.to_lowercase();
    if IGNORED_NAMES.contains(&lower.as_str()) || lower.starts_with("~$") || lower.starts_with('.') {
        return false;
    }
    let ext = ext_of_name(name);
    if ext.is_empty() || PARTIAL_EXTS.contains(&ext.as_str()) {
        return false;
    }
    // Exact outputs only here; the looser name rule is applied once the file has settled, when
    // the job that may have made it has finished.
    if is_own(inner, full, false) {
        return false;
    }
    let wf = w.wf.lock().unwrap().clone();
    let exts = normalize_exts(&wf.exts);
    if !exts.is_empty() && !exts.contains(&ext) {
        return false;
    }
    inner.deps.fits(&wf.action, &ext)
}

/// Waits (on its own thread) until the file stops changing and is not locked, then queues it.
fn settle(inner: &Arc<Inner>, w: &Arc<FolderWatch>, full: PathBuf) {
    let key = key_of(&full);
    if !w.settling.lock().unwrap().insert(key.clone()) {
        return;
    }
    let (inner, w) = (inner.clone(), w.clone());
    std::thread::spawn(move || {
        let mut last: Option<(u64, SystemTime)> = None;
        let mut empty_since = Instant::now();
        let ready = loop {
            std::thread::sleep(inner.settle);
            if w.stopped.load(Ordering::SeqCst) {
                break false;
            }
            let Ok(md) = std::fs::metadata(&full) else { break false }; // gone (renamed or deleted)
            if !md.is_file() {
                break false;
            }
            if md.len() == 0 {
                if empty_since.elapsed() > EMPTY_GIVE_UP {
                    break false;
                }
                last = None;
                continue;
            }
            empty_since = Instant::now();
            let sig = (md.len(), md.modified().unwrap_or(SystemTime::UNIX_EPOCH));
            if last == Some(sig) && !is_locked(&full) {
                break true;
            }
            last = Some(sig);
        };
        w.settling.lock().unwrap().remove(&key);
        if ready {
            if let Some(tx) = inner.queue.lock().unwrap().as_ref() {
                let _ = tx.send((w.clone(), full));
            }
        }
    });
}

fn is_own(inner: &Inner, full: &Path, by_name: bool) -> bool {
    if inner.own.lock().unwrap().contains(&key_of(full)) {
        return true;
    }
    if !by_name {
        return false;
    }
    let name = full.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let dir = full.parent().map(key_of).unwrap_or_default();
    let now = Instant::now();
    let mut inflight = inner.inflight.lock().unwrap();
    inflight.retain(|_, f| f.until.map_or(true, |u| u > now));
    inflight.values().any(|f| f.dirs.contains(&dir) && name.starts_with(&f.stem))
}

fn process(inner: &Arc<Inner>, w: &Arc<FolderWatch>, full: &Path) {
    let wf = w.wf.lock().unwrap().clone();
    // The watch was removed (or moved to another folder) while this file waited in the queue.
    let current = inner.watches.lock().unwrap().get(&wf.id).is_some_and(|x| Arc::ptr_eq(x, w));
    if !current || !full.exists() || is_own(inner, full, true) {
        return;
    }
    // Settings may have changed while the file settled.
    if !wf.enabled || !action_allowed(&wf.action) {
        return;
    }
    let exts = normalize_exts(&wf.exts);
    let ext = full.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if (!exts.is_empty() && !exts.contains(&ext)) || !inner.deps.fits(&wf.action, &ext) {
        return;
    }
    let out_dir = (!wf.out_folder.is_empty()).then(|| PathBuf::from(&wf.out_folder));
    let id = inner.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let mut dirs = vec![full.parent().map(key_of).unwrap_or_default()];
    if let Some(o) = &out_dir {
        dirs.push(key_of(o));
    }
    // Until we know the exact outputs, anything new named after this file is ours.
    inner.inflight.lock().unwrap().insert(id, Inflight { dirs, stem: stem_of(full), until: None });
    inner.deps.log(&format!("watch: running {} {}", wf.action, full.display()));
    let outputs = inner.deps.run(&wf.action, full, out_dir.as_deref());
    match &outputs {
        Some(o) => {
            let mut own = inner.own.lock().unwrap();
            for p in o {
                own.insert(key_of(Path::new(p)));
            }
            drop(own);
            inner.inflight.lock().unwrap().remove(&id);
        }
        None => {
            // Outputs unknown: keep the name rule alive a little longer for late writes.
            if let Some(f) = inner.inflight.lock().unwrap().get_mut(&id) {
                f.until = Some(Instant::now() + LATE_WRITES);
            }
        }
    }
    if wf.recycle_original {
        let me = key_of(full);
        let made = outputs.unwrap_or_default().into_iter().filter(|o| key_of(Path::new(o)) != me && Path::new(o).exists()).count();
        if made == 0 {
            inner.deps.log(&format!("watch: keeping original, no confirmed output {}", full.display()));
            return;
        }
        match inner.deps.trash(full) {
            Ok(()) => inner.deps.log(&format!("watch: recycled {}", full.display())),
            Err(e) => inner.deps.log(&format!("watch: recycle failed {}: {e}", full.display())),
        }
    }
}

// ------------------------------------------------------------------ app wiring

/// Moves a file to the Recycle Bin.
pub fn recycle(p: &Path) -> Result<(), String> {
    use windows::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    let mut from: Vec<u16> = std::path::absolute(p).map_err(|e| e.to_string())?.to_string_lossy().encode_utf16().collect();
    from.extend([0, 0]);
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: windows::core::PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        ..Default::default()
    };
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 || op.fAnyOperationsAborted.as_bool() {
        return Err(format!("SHFileOperation failed ({r})"));
    }
    Ok(())
}

/// How the app runs an unattended action. The convert / tools / presets owners register it in
/// lib.rs with `set_runner` (the converter API is still moving); until then nothing fits and
/// watch folders stay idle. Automatic runs must not touch "last used" slices.
pub trait Runner: Send + Sync + 'static {
    fn fits(&self, action: &str, ext: &str) -> bool;
    fn run(&self, action: &str, path: &Path, out_dir: Option<&Path>) -> Option<Vec<String>>;
}

static RUNNER: std::sync::OnceLock<Box<dyn Runner>> = std::sync::OnceLock::new();

pub fn set_runner(r: impl Runner) {
    let _ = RUNNER.set(Box::new(r));
}

struct AppDeps;

impl Deps for AppDeps {
    fn folders(&self) -> Vec<WatchFolder> {
        crate::settings::get().watch_folders
    }
    fn fits(&self, action: &str, ext: &str) -> bool {
        RUNNER.get().is_some_and(|r| r.fits(action, ext))
    }
    fn run(&self, action: &str, path: &Path, out_dir: Option<&Path>) -> Option<Vec<String>> {
        RUNNER.get()?.run(action, path, out_dir)
    }
    fn trash(&self, path: &Path) -> Result<(), String> {
        recycle(path)
    }
}

static SERVICE: std::sync::OnceLock<WatchService> = std::sync::OnceLock::new();

/// Starts watching and follows edits to the watch-folder list.
pub fn start() {
    let svc = SERVICE.get_or_init(|| {
        let svc = WatchService::new(AppDeps, Duration::from_secs(1), Duration::from_secs(15));
        let weak: Weak<Inner> = Arc::downgrade(&svc.0);
        crate::settings::store().on_change(move |before, after| {
            if before.watch_folders != after.watch_folders {
                if let Some(i) = weak.upgrade() {
                    WatchService(i).sync();
                }
            }
        });
        svc
    });
    svc.sync();
}

pub fn stop() {
    if let Some(s) = SERVICE.get() {
        s.stop();
    }
}

pub fn service() -> Option<&'static WatchService> {
    SERVICE.get()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[derive(Clone, Default)]
    struct Fake {
        folders: Arc<Mutex<Vec<WatchFolder>>>,
        runs: Arc<Mutex<Vec<String>>>,
        trashed: Arc<Mutex<Vec<String>>>,
        /// Report outputs (true) or leave them unknown (false).
        known_outputs: Arc<AtomicBool>,
        /// Write an output at all.
        produce: Arc<AtomicBool>,
    }

    impl Deps for Fake {
        fn folders(&self) -> Vec<WatchFolder> {
            self.folders.lock().unwrap().clone()
        }
        fn fits(&self, action: &str, ext: &str) -> bool {
            action == "to:jpg" && ext != "jpg"
        }
        fn run(&self, _action: &str, path: &Path, out_dir: Option<&Path>) -> Option<Vec<String>> {
            self.runs.lock().unwrap().push(path.file_name().unwrap().to_string_lossy().into_owned());
            if !self.produce.load(Ordering::SeqCst) {
                return Some(vec![]);
            }
            let dir = out_dir.map(Path::to_path_buf).unwrap_or_else(|| path.parent().unwrap().to_path_buf());
            // Named after the input but with a fitting extension: only the loop rule stops a rerun.
            let out = dir.join(format!("{} converted.png", path.file_stem().unwrap().to_string_lossy()));
            std::fs::write(&out, b"result").unwrap();
            self.known_outputs.load(Ordering::SeqCst).then(|| vec![out.to_string_lossy().into_owned()])
        }
        fn trash(&self, path: &Path) -> Result<(), String> {
            self.trashed.lock().unwrap().push(path.file_name().unwrap().to_string_lossy().into_owned());
            std::fs::remove_file(path).map_err(|e| e.to_string())
        }
        fn log(&self, _msg: &str) {}
    }

    fn setup(name: &str, wf: impl FnOnce(&mut WatchFolder)) -> (PathBuf, Fake, WatchService) {
        let dir = std::env::temp_dir().join(format!("orange-watch-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.png"), b"already here").unwrap();
        let mut f = WatchFolder { id: "w1".into(), folder: dir.to_string_lossy().into(), exts: vec![], action: "to:jpg".into(), out_folder: String::new(), recycle_original: false, enabled: true };
        wf(&mut f);
        let fake = Fake::default();
        fake.known_outputs.store(true, Ordering::SeqCst);
        fake.produce.store(true, Ordering::SeqCst);
        *fake.folders.lock().unwrap() = vec![f];
        let svc = WatchService::new(fake.clone(), Duration::from_millis(150), Duration::from_millis(400));
        svc.sync();
        (dir, fake, svc)
    }

    fn wait_for(cond: impl Fn() -> bool, ms: u64) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_millis(ms) {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        cond()
    }

    fn runs(f: &Fake) -> Vec<String> {
        f.runs.lock().unwrap().clone()
    }

    #[test]
    fn new_files_run_once_and_existing_and_own_files_are_left_alone() {
        let (dir, fake, svc) = setup("basic", |_| {});
        std::fs::write(dir.join("new.png"), b"fresh image").unwrap();
        std::fs::write(dir.join("skip.jpg"), b"jpg can't go to jpg").unwrap();
        std::fs::write(dir.join("desktop.ini"), b"x").unwrap();
        std::fs::write(dir.join("~$lock.png"), b"x").unwrap();
        assert!(wait_for(|| runs(&fake) == ["new.png"], 3000), "{:?}", runs(&fake));
        // Its output ("new converted.png") is ours and must not loop; old.png was there before.
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(runs(&fake), ["new.png"]);
        assert!(dir.join("new converted.png").exists());
        svc.stop();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unknown_outputs_are_still_recognised_by_name() {
        let (dir, fake, svc) = setup("byname", |_| {});
        fake.known_outputs.store(false, Ordering::SeqCst);
        std::fs::write(dir.join("photo.png"), b"img").unwrap();
        assert!(wait_for(|| runs(&fake).len() == 1, 3000));
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(runs(&fake), ["photo.png"], "the result named after photo must not run again");
        svc.stop();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn partial_downloads_wait_for_the_final_name() {
        let (dir, fake, svc) = setup("partial", |_| {});
        let part = dir.join("clip.png.crdownload");
        std::fs::write(&part, b"half").unwrap();
        std::fs::write(dir.join("x.png.part"), b"half").unwrap();
        std::thread::sleep(Duration::from_millis(700));
        assert!(runs(&fake).is_empty());
        std::fs::rename(&part, dir.join("clip.png")).unwrap();
        assert!(wait_for(|| runs(&fake) == ["clip.png"], 3000), "{:?}", runs(&fake));
        svc.stop();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn growing_locked_and_empty_files_wait_until_finished() {
        let (dir, fake, svc) = setup("stable", |_| {});
        // Held open without write sharing, as a downloader does, and still growing.
        use std::os::windows::fs::OpenOptionsExt;
        let p = dir.join("big.png");
        let mut f = std::fs::OpenOptions::new().write(true).create(true).share_mode(1 /* FILE_SHARE_READ */).open(&p).unwrap();
        for _ in 0..6 {
            f.write_all(&[7u8; 4096]).unwrap();
            f.flush().unwrap();
            std::thread::sleep(Duration::from_millis(120));
        }
        // Stops growing but stays locked.
        std::thread::sleep(Duration::from_millis(600));
        assert!(runs(&fake).is_empty(), "a locked file must not run");
        drop(f);
        assert!(wait_for(|| runs(&fake) == ["big.png"], 3000));
        // An empty placeholder waits until it has content.
        let e = dir.join("empty.png");
        std::fs::write(&e, b"").unwrap();
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(runs(&fake).len(), 1);
        std::fs::write(&e, b"filled").unwrap();
        assert!(wait_for(|| runs(&fake).len() == 2, 3000));
        svc.stop();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn extension_filter_out_folder_and_recycle() {
        let out = std::env::temp_dir().join(format!("orange-watch-test-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).unwrap();
        let o = out.to_string_lossy().into_owned();
        let (dir, fake, svc) = setup("filter", |w| {
            w.exts = vec![".PNG".into()];
            w.out_folder = o.clone();
            w.recycle_original = true;
        });
        std::fs::write(dir.join("a.webp"), b"not in the filter").unwrap();
        std::fs::write(dir.join("b.png"), b"in").unwrap();
        assert!(wait_for(|| fake.trashed.lock().unwrap().len() == 1, 3000));
        assert_eq!(runs(&fake), ["b.png"]);
        assert!(out.join("b converted.png").exists());
        assert!(!dir.join("b.png").exists(), "recycled after a confirmed output");
        // No output: the original stays.
        fake.produce.store(false, Ordering::SeqCst);
        std::fs::write(dir.join("c.png"), b"in").unwrap();
        assert!(wait_for(|| runs(&fake).len() == 2, 3000));
        std::thread::sleep(Duration::from_millis(200));
        assert!(dir.join("c.png").exists());
        assert_eq!(fake.trashed.lock().unwrap().len(), 1);
        svc.stop();
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&out).unwrap();
    }

    #[test]
    fn sync_follows_settings() {
        let (dir, fake, svc) = setup("sync", |w| w.enabled = false);
        assert!(svc.watching().is_empty());
        fake.folders.lock().unwrap()[0].enabled = true;
        svc.sync();
        assert_eq!(svc.watching().len(), 1);
        // A deleted then re-created name counts as new.
        std::fs::write(dir.join("n.png"), b"1").unwrap();
        assert!(wait_for(|| runs(&fake).len() == 1, 3000));
        fake.folders.lock().unwrap()[0].action = "tool:compress".into(); // not unattended
        svc.sync();
        assert!(svc.watching().is_empty());
        svc.stop();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn helpers() {
        assert_eq!(normalize_exts(&[".JPG".into(), "*.jpg".into(), " heic ".into(), "".into()]), ["jpg", "heic"]);
        assert!(action_allowed("to:jpg") && action_allowed("preset:ab") && action_allowed("tool:extractArchive"));
        assert!(!action_allowed("tool:crop") && !action_allowed("to:") && !action_allowed("share"));
    }
}
