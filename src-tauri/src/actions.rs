//! The Actions wheel: share, float (shelf), copy, move, copy path, terminal. Quick things that
//! report through a HUD notice instead of opening a window. Also the HUD's Undo, with 1.x
//! semantics: by default Undo moves a job's new files to the Recycle Bin; Move's Undo moves
//! everything back where it was (never to the Recycle Bin: those are the user's originals).

use crate::{clipboard, explorer, hud, log, shelf};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

fn name_of(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

fn what(paths: &[String]) -> String {
    if paths.len() == 1 {
        name_of(&paths[0])
    } else {
        plural(paths.len(), "item")
    }
}

/// Preferences that live in Settings (set by the settings module when it loads or changes).
#[derive(Default)]
struct Prefs {
    terminal: String,
    move_folder: Option<String>,
}
static PREFS: Mutex<Prefs> = Mutex::new(Prefs { terminal: String::new(), move_folder: None });

pub fn set_terminal_pref(t: &str) {
    PREFS.lock().unwrap().terminal = t.to_string();
}
pub fn set_move_folder(f: Option<String>) {
    PREFS.lock().unwrap().move_folder = f.filter(|s| !s.is_empty());
}
/// The last folder files were moved to (for Settings to persist).
pub fn move_folder() -> Option<String> {
    PREFS.lock().unwrap().move_folder.clone()
}

/// Runs an action item from the wheel (`action:<id>`). Blocking work goes to a thread.
pub fn run(app: &AppHandle, id: &str, paths: Vec<String>) {
    let paths: Vec<String> = paths.into_iter().filter(|p| Path::new(p).exists()).collect();
    if paths.is_empty() {
        return;
    }
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        if let Err(e) = run_now(&app, &id, paths) {
            log::write(&format!("action {id} failed: {e}"));
            hud::notice(&app, &e);
        }
    });
}

fn run_now(app: &AppHandle, id: &str, paths: Vec<String>) -> Result<(), String> {
    match id {
        "share" => explorer::share(paths).map(|_| ()).map_err(|_| "Couldn't open the Windows share sheet.".into()),
        "float" => {
            shelf::add(app, paths);
            Ok(())
        }
        "copy" => copy(app, &paths),
        "move" => move_to_picked(app, paths),
        "copyPath" => {
            clipboard::put_text(&paths.join("\r\n"))?;
            hud::notice(app, &if paths.len() == 1 { "Copied the path".to_string() } else { format!("Copied {}", plural(paths.len(), "path")) });
            Ok(())
        }
        "terminal" => open_terminal(&paths[0]),
        _ => Err("That action is not available.".into()),
    }
}

// ------------------------------------------------------------------------ copy

fn copy(app: &AppHandle, paths: &[String]) -> Result<(), String> {
    if let Err(e) = clipboard::put_files(paths) {
        log::write(&format!("copy files failed: {e}"));
        // The best we can do then is the paths as text.
        let _ = clipboard::put_text(&paths.join("\r\n"));
        hud::notice(app, "Couldn't copy the files themselves, so their paths were copied instead.");
        return Ok(());
    }
    let folders = paths.iter().filter(|p| Path::new(p).is_dir()).count();
    let files = paths.len() - folders;
    let parts: Vec<String> = [(files, "file"), (folders, "folder")].iter().filter(|(n, _)| *n > 0).map(|(n, w)| plural(*n, w)).collect();
    hud::notice(app, &format!("Copied {}. Paste in any folder.", parts.join(" and ")));
    Ok(())
}

// ------------------------------------------------------------------------ move

/// photo.jpg taken in `dir`: photo 2.jpg, photo 3.jpg... Folders get no extension split.
pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let target = dir.join(name);
    if !target.exists() {
        return target;
    }
    let p = Path::new(name);
    let (stem, ext) = if target.is_dir() || p.extension().is_none() {
        (name.to_string(), String::new())
    } else {
        (p.file_stem().unwrap().to_string_lossy().into_owned(), format!(".{}", p.extension().unwrap().to_string_lossy()))
    };
    (2..).map(|i| dir.join(format!("{stem} {i}{ext}"))).find(|c| !c.exists()).unwrap()
}

fn copy_tree(src: &Path, dest: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir(dest)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_tree(&e.path(), &dest.join(e.file_name()))?;
        }
        Ok(())
    } else {
        // std::fs::copy on Windows uses CopyFileEx: timestamps and attributes come along.
        std::fs::copy(src, dest).map(|_| ())
    }
}

/// Renames, or across drives copies and then removes the original once the copy is complete.
pub fn move_one(src: &Path, dest: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(17) => {
            // ERROR_NOT_SAME_DEVICE
            if let Err(e) = copy_tree(src, dest) {
                let _ = if dest.is_dir() { std::fs::remove_dir_all(dest) } else { std::fs::remove_file(dest) };
                return Err(e);
            }
            if src.is_dir() {
                std::fs::remove_dir_all(src)
            } else {
                std::fs::remove_file(src)
            }
        }
        Err(e) => Err(e),
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| p.to_string_lossy().trim_end_matches('\\').to_lowercase();
    n(a) == n(b)
}

fn move_to_picked(app: &AppHandle, paths: Vec<String>) -> Result<(), String> {
    let start = move_folder().filter(|f| Path::new(f).is_dir()).or_else(|| Path::new(&paths[0]).parent().map(|p| p.to_string_lossy().into_owned()));
    let Some(dest) = explorer::pick_folder(&format!("Move {} to…", what(&paths)), "Move here", start.as_deref()) else { return Ok(()) };
    set_move_folder(Some(dest.clone()));
    move_paths(app, paths, Path::new(&dest));
    Ok(())
}

/// Moves `paths` into `dest` with a HUD row whose Undo moves them back.
pub fn move_paths(app: &AppHandle, paths: Vec<String>, dest: &Path) -> Option<u64> {
    let job = hud::start(app, &format!("Moving {}", what(&paths)));
    let (mut moved, mut back, mut errors) = (Vec::new(), Vec::new(), Vec::new());
    let n = paths.len();
    for (i, src) in paths.iter().enumerate() {
        let sp = Path::new(src);
        if sp.parent().is_some_and(|p| same_dir(p, dest)) {
            continue; // already there
        }
        let inside = format!("{}\\", dest.to_string_lossy().trim_end_matches('\\').to_lowercase())
            .starts_with(&format!("{}\\", src.trim_end_matches('\\').to_lowercase()));
        if inside {
            errors.push(format!("{}: can't move a folder into itself", name_of(src)));
            continue;
        }
        job.progress(i as f64 / n as f64, Some(&name_of(src)));
        let target = free_name(dest, &name_of(src));
        match move_one(sp, &target) {
            Ok(()) => {
                let t = target.to_string_lossy().into_owned();
                moved.push(t.clone());
                back.push((t, src.clone()));
            }
            Err(e) => {
                log::write(&format!("move failed {src}: {e}"));
                let why = if e.raw_os_error() == Some(32) { "in use by another app".to_string() } else { e.to_string() };
                errors.push(format!("{}: {why}", name_of(src)));
            }
        }
    }
    if moved.is_empty() && !errors.is_empty() {
        job.failed(&errors.join("\n"));
        return None;
    }
    if moved.is_empty() {
        job.done_with_undo(vec![], vec![], None);
        hud::notice(app, &format!("Already in {}", dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dest.to_string_lossy().into_owned())));
        return None;
    }
    let id = job.id;
    job.done_with_undo(moved, errors, Some(Undo::MoveBack(back)));
    Some(id)
}

// ------------------------------------------------------------------------ undo

pub enum Undo {
    /// Move a job's new files to the Recycle Bin.
    Trash(Vec<String>),
    /// (where it is now, where it was): move each back.
    MoveBack(Vec<(String, String)>),
}

static UNDOS: Mutex<Option<HashMap<u64, Undo>>> = Mutex::new(None);

pub fn register_undo(id: u64, u: Undo) {
    UNDOS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, u);
}

pub fn forget_undo(id: u64) {
    if let Some(m) = UNDOS.lock().unwrap().as_mut() {
        m.remove(&id);
    }
}

/// The HUD's Undo button. Runs at most once per row.
pub fn undo(app: &AppHandle, id: u64) {
    let Some(u) = UNDOS.lock().unwrap().as_mut().and_then(|m| m.remove(&id)) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let r = match &u {
            Undo::Trash(paths) => explorer::recycle(paths.clone()).map(|_| {
                let n = paths.len();
                if n == 1 {
                    "Undone: the new file was moved to the Recycle Bin".to_string()
                } else {
                    format!("Undone: {n} new files were moved to the Recycle Bin")
                }
            }),
            Undo::MoveBack(pairs) => (|| {
                for (now, original) in pairs {
                    let now = Path::new(now);
                    if !now.exists() {
                        continue;
                    }
                    let orig = Path::new(original);
                    let back = if orig.exists() {
                        free_name(orig.parent().unwrap_or(Path::new("")), &name_of(original))
                    } else {
                        orig.to_path_buf()
                    };
                    move_one(now, &back).map_err(|e| e.to_string())?;
                }
                Ok("Undone".to_string())
            })(),
        };
        hud::undone(&app, id, r);
    });
}

// -------------------------------------------------------------------- terminal

fn which(exe: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(exe)).find(|c| c.is_file()))
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Term {
    Wt,
    Pwsh,
    PowerShell,
    Cmd,
}

pub fn find_terminal(pref: &str) -> (Term, PathBuf) {
    let local = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default());
    let sys = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())).join("System32");
    let find = |k: &str| -> Option<(Term, PathBuf)> {
        match k {
            "wt" => which("wt.exe").or_else(|| Some(local.join(r"Microsoft\WindowsApps\wt.exe")).filter(|p| p.exists())).map(|p| (Term::Wt, p)),
            "pwsh" => which("pwsh.exe")
                .or_else(|| {
                    [PathBuf::from(std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into())).join(r"PowerShell\7\pwsh.exe"), local.join(r"Microsoft\WindowsApps\pwsh.exe")]
                        .into_iter()
                        .find(|p| p.exists())
                })
                .map(|p| (Term::Pwsh, p)),
            "powershell" => Some(sys.join(r"WindowsPowerShell\v1.0\powershell.exe")).filter(|p| p.exists()).or_else(|| which("powershell.exe")).map(|p| (Term::PowerShell, p)),
            "cmd" => Some((Term::Cmd, std::env::var("ComSpec").map(PathBuf::from).unwrap_or_else(|_| sys.join("cmd.exe")))),
            _ => None,
        }
    };
    let mut order = vec!["wt", "pwsh", "powershell", "cmd"];
    if !pref.is_empty() && pref != "auto" {
        order.insert(0, pref);
    }
    order.into_iter().find_map(find).unwrap_or((Term::Cmd, PathBuf::from("cmd.exe")))
}

/// The command that opens `exe` in `folder`, as (program, raw arguments).
pub fn terminal_command(kind: Term, exe: &Path, folder: &Path) -> (PathBuf, String) {
    let f = folder.to_string_lossy();
    if kind == Term::Wt {
        return (exe.to_path_buf(), format!("-d \"{f}\""));
    }
    // Console shells need a console of their own: `start` gives them one, in the folder.
    let shell_args = if kind == Term::Cmd { "/K" } else { "-NoExit -NoLogo" };
    let comspec = std::env::var("ComSpec").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("cmd.exe"));
    (comspec, format!("/d /s /c \"start \"\" /D \"{f}\" \"{}\" {shell_args}\"", exe.to_string_lossy()))
}

fn open_terminal(p: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let path = Path::new(p);
    let folder = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    let pref = PREFS.lock().unwrap().terminal.clone();
    let (kind, exe) = find_terminal(&pref);
    let (prog, args) = terminal_command(kind, &exe, folder);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = std::process::Command::new(prog);
    c.raw_arg(args).current_dir(folder);
    if kind != Term::Wt {
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.spawn().map(|_| ()).map_err(|e| {
        log::write(&format!("terminal {kind:?} failed: {e}"));
        "Couldn't open a terminal.".to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("orange-actions-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn free_name_counts_up() {
        let d = tmp("free");
        std::fs::write(d.join("a.txt"), "").unwrap();
        std::fs::write(d.join("a 2.txt"), "").unwrap();
        std::fs::create_dir(d.join("folder.v1")).unwrap();
        assert_eq!(free_name(&d, "a.txt"), d.join("a 3.txt"));
        assert_eq!(free_name(&d, "b.txt"), d.join("b.txt"));
        assert_eq!(free_name(&d, "folder.v1"), d.join("folder.v1 2"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn move_one_and_back() {
        let d = tmp("move");
        std::fs::create_dir(d.join("src")).unwrap();
        std::fs::create_dir(d.join("dst")).unwrap();
        std::fs::write(d.join("src").join("f.txt"), "hello").unwrap();
        move_one(&d.join("src").join("f.txt"), &d.join("dst").join("f.txt")).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("dst").join("f.txt")).unwrap(), "hello");
        assert!(!d.join("src").join("f.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn copy_tree_copies_folders() {
        let d = tmp("tree");
        std::fs::create_dir_all(d.join("a").join("b")).unwrap();
        std::fs::write(d.join("a").join("b").join("x"), "1").unwrap();
        copy_tree(&d.join("a"), &d.join("c")).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("c").join("b").join("x")).unwrap(), "1");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn terminals_resolve() {
        let (k, exe) = find_terminal("cmd");
        assert_eq!(k, Term::Cmd);
        assert!(exe.to_string_lossy().to_lowercase().ends_with("cmd.exe"));
        let (_, args) = terminal_command(Term::PowerShell, Path::new(r"C:\x\powershell.exe"), Path::new(r"D:\my dir"));
        assert!(args.contains(r#"/D "D:\my dir" "C:\x\powershell.exe" -NoExit -NoLogo"#));
    }
}
