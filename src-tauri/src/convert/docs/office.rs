//! Office engine (engines/office.ts): Microsoft Office (Word / PowerPoint / Excel over COM, from a
//! hidden PowerShell host) when it is installed, otherwise LibreOffice headless when that is.
//! Neither is downloaded: they are the user's own installs.

use super::super::{move_file, Ctx, Fail, R};
use super::office_ps::*;
use crate::engines::{run_tool_process, RunOpts, Stream};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OfficeApp {
    Word,
    PowerPoint,
    Excel,
}

impl OfficeApp {
    fn name(self) -> &'static str {
        match self {
            OfficeApp::Word => "Word",
            OfficeApp::PowerPoint => "PowerPoint",
            OfficeApp::Excel => "Excel",
        }
    }
    fn key(self) -> &'static str {
        match self {
            OfficeApp::Word => "word",
            OfficeApp::PowerPoint => "powerpoint",
            OfficeApp::Excel => "excel",
        }
    }
    fn prog_id(self) -> &'static str {
        match self {
            OfficeApp::Word => "Word.Application",
            OfficeApp::PowerPoint => "PowerPoint.Application",
            OfficeApp::Excel => "Excel.Application",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct OfficeStatus {
    pub word: bool,
    pub powerpoint: bool,
    pub excel: bool,
    pub libreoffice: Option<PathBuf>,
}

impl OfficeStatus {
    pub fn has(&self, a: OfficeApp) -> bool {
        match a {
            OfficeApp::Word => self.word,
            OfficeApp::PowerPoint => self.powerpoint,
            OfficeApp::Excel => self.excel,
        }
    }
}

fn sys32(exe: &str) -> String {
    let win = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{win}\System32\{exe}")
}

fn powershell() -> String {
    sys32(r"WindowsPowerShell\v1.0\powershell.exe")
}

fn reg_value(key: &str, value: Option<&str>) -> Option<String> {
    let mut a = vec!["query".to_string(), key.to_string()];
    match value {
        Some(v) => a.extend(["/v".into(), v.into()]),
        None => a.push("/ve".into()),
    }
    let r = run_tool_process(&sys32("reg.exe"), &a, &RunOpts { timeout: Some(Duration::from_secs(10)), ..Default::default() }).ok()?;
    let out = r.stdout_text();
    for line in out.lines() {
        for ty in ["REG_EXPAND_SZ", "REG_SZ"] {
            if let Some(i) = line.find(ty) {
                return Some(line[i + ty.len()..].trim().to_string());
            }
        }
    }
    None
}

/// Registered, and the server executable actually exists (uninstalls can leave stale keys).
fn has_com_server(prog_id: &str) -> bool {
    let Some(clsid) = reg_value(&format!(r"HKCR\{prog_id}\CLSID"), None) else { return false };
    let Some(server) = reg_value(&format!(r"HKCR\CLSID\{clsid}\LocalServer32"), None) else { return false };
    let s = server.trim();
    let exe = if let Some(rest) = s.strip_prefix('"') { rest.split('"').next().unwrap_or("").to_string() } else {
        let l = s.to_lowercase();
        match l.find(".exe") {
            Some(i) => s[..i + 4].to_string(),
            None => s.to_string(),
        }
    };
    Path::new(&exe).is_file()
}

fn find_soffice() -> Option<PathBuf> {
    let mut c = vec![];
    for key in [r"HKLM\SOFTWARE\LibreOffice\UNO\InstallPath", r"HKLM\SOFTWARE\WOW6432Node\LibreOffice\UNO\InstallPath", r"HKCU\SOFTWARE\LibreOffice\UNO\InstallPath"] {
        if let Some(d) = reg_value(key, None) {
            c.push(PathBuf::from(d).join("soffice.exe"));
        }
    }
    for base in [std::env::var("ProgramFiles").ok(), std::env::var("ProgramFiles(x86)").ok(), std::env::var("LOCALAPPDATA").ok().map(|l| format!(r"{l}\Programs"))].into_iter().flatten() {
        c.push(PathBuf::from(base).join("LibreOffice").join("program").join("soffice.exe"));
    }
    c.into_iter().find(|p| p.is_file())
}

static STATUS: Mutex<Option<(Instant, OfficeStatus)>> = Mutex::new(None);

/// What office suites are available. Cached for a minute.
pub fn status() -> OfficeStatus {
    if let Some((at, s)) = STATUS.lock().unwrap().as_ref() {
        if at.elapsed() < Duration::from_secs(60) {
            return s.clone();
        }
    }
    let blocked = read_blocked();
    let (w, p, e, lo) = std::thread::scope(|sc| {
        let w = sc.spawn(|| has_com_server(OfficeApp::Word.prog_id()));
        let p = sc.spawn(|| has_com_server(OfficeApp::PowerPoint.prog_id()));
        let e = sc.spawn(|| has_com_server(OfficeApp::Excel.prog_id()));
        let lo = sc.spawn(find_soffice);
        (w.join().unwrap_or(false), p.join().unwrap_or(false), e.join().unwrap_or(false), lo.join().unwrap_or(None))
    });
    let s = OfficeStatus { word: w && !blocked.contains(&"word"), powerpoint: p && !blocked.contains(&"powerpoint"), excel: e && !blocked.contains(&"excel"), libreoffice: lo };
    if std::env::var_os("ORANGE_NO_OFFICE").is_some() {
        // Tests of the no-office fallbacks.
        return OfficeStatus::default();
    }
    *STATUS.lock().unwrap() = Some((Instant::now(), s.clone()));
    s
}

pub fn reset_status() {
    *STATUS.lock().unwrap() = None;
}

/// No usable office suite for this job; callers with a built-in fallback catch this one.
pub const NEED_OFFICE_TAG: &str = "\u{1}office-unavailable\u{1}";

pub fn unavailable(msg: String) -> Fail {
    Fail::User(format!("{NEED_OFFICE_TAG}{msg}"))
}

pub fn is_unavailable(f: &Fail) -> bool {
    matches!(f, Fail::User(m) if m.starts_with(NEED_OFFICE_TAG))
}

/// Strips the internal tag before the message reaches the HUD.
pub fn untag(f: Fail) -> Fail {
    match f {
        Fail::User(m) if m.starts_with(NEED_OFFICE_TAG) => Fail::User(m[NEED_OFFICE_TAG.len()..].to_string()),
        o => o,
    }
}

pub fn need_office(what: &str) -> Fail {
    unavailable(format!("{what} needs Microsoft Office or LibreOffice. Install the free LibreOffice from libreoffice.org and try again."))
}

// An Office app that pops a modal dialog under automation (typically activation) can't be used.
// Remember that for a few days so it never flashes up again.
fn blocked_file() -> PathBuf {
    crate::engines::root().parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir).join("office-blocked.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn read_blocked() -> Vec<&'static str> {
    let Ok(t) = std::fs::read_to_string(blocked_file()) else { return vec![] };
    let v: serde_json::Value = serde_json::from_str(&t).unwrap_or_default();
    ["word", "powerpoint", "excel", "wordPdf"]
        .into_iter()
        .filter(|k| {
            let days = if *k == "wordPdf" { 1 } else { 3 };
            v[*k].as_u64().map(|at| now_ms().saturating_sub(at) < days * 86_400_000).unwrap_or(false)
        })
        .collect()
}

fn mark_blocked(which: &str) {
    let f = blocked_file();
    let mut v: serde_json::Value = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(serde_json::json!({}));
    v[which] = serde_json::json!(now_ms());
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(&f, v.to_string());
    reset_status();
}

/// Word's PDF import (PDFREFLOW) can wedge on some systems; after it stalls, skip it for a day.
pub fn word_pdf_reflow_usable() -> bool {
    !read_blocked().contains(&"wordPdf")
}

/// Office automation and a LibreOffice profile can only do one thing at a time.
static EXCLUSIVE: Mutex<()> = Mutex::new(());

fn kill_pid(pid: u32) {
    let _ = run_tool_process(&sys32("taskkill.exe"), &["/F".into(), "/PID".into(), pid.to_string()], &RunOpts::default());
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

fn office_message(which: OfficeApp, detail: &str) -> String {
    let s = detail.split(" @@ ").next().unwrap_or("").replace("_x000D__x000A_", " ");
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let l = s.to_lowercase();
    if l.contains("password") {
        return "The file is password-protected.".into();
    }
    if ["corrupt", "damaged", "cannot open", "could not open", "unreadable", "file format", "not a valid"].iter().any(|n| l.contains(n)) {
        return format!("{} couldn't open the file. It may be damaged.", which.name());
    }
    if !s.is_empty() && s.len() < 200 && !s.contains("CLIXML") && !s.contains("Exception from HRESULT") {
        return format!("{}: {}.", which.name(), s.trim_end_matches('.'));
    }
    format!("{} couldn't convert the file.", which.name())
}

/// Converts with Microsoft Office. `output` is a file, or a folder for slide images.
/// Office never shows a window and is always quit (or killed) afterwards.
pub fn office_convert(which: OfficeApp, input: &Path, output: &Path, format: &str, ctx: &Ctx, progress: &dyn Fn(f64), timeout: Option<Duration>) -> R<()> {
    let _g = EXCLUSIVE.lock().unwrap_or_else(|p| p.into_inner());
    ctx.check()?;
    let body = match which {
        OfficeApp::Word => PS_WORD,
        OfficeApp::PowerPoint => PS_POWERPOINT,
        OfficeApp::Excel => PS_EXCEL,
    };
    // Errors go to stdout as one "ERROR ..." line (PowerShell 5 would otherwise emit CLIXML on stderr).
    let script = format!("{PS_PRELUDE}\ntry {{\n{body}\n}} catch {{ Say ('ERROR ' + ($_.Exception.Message -replace '\\s+', ' ') + ' @@ ' + ($_.InvocationInfo.Line -replace '\\s+', ' ').Trim()); exit 1 }}\n");
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let pids = Mutex::new(Vec::<u32>::new());
    let state = Mutex::new((String::new(), String::new(), false)); // error line, blocked by, stalled
    let on = |line: &str, s: Stream| {
        if s != Stream::Stdout {
            return;
        }
        if let Some(p) = line.strip_prefix("PID ") {
            if let Ok(p) = p.trim().parse() {
                pids.lock().unwrap().push(p);
            }
        } else if let Some(e) = line.strip_prefix("ERROR ") {
            state.lock().unwrap().0 = e.trim().to_string();
        } else if let Some(b) = line.strip_prefix("BLOCKED ") {
            state.lock().unwrap().1 = b.trim().to_string();
        } else if line.starts_with("STALLED") {
            state.lock().unwrap().2 = true;
        } else if let Some(r) = line.strip_prefix("SLIDE ") {
            let v: Vec<f64> = r.split_whitespace().filter_map(|x| x.parse().ok()).collect();
            if v.len() == 2 && v[1] > 0.0 {
                progress(0.1 + 0.85 * v[0] / v[1]);
            }
        } else if line.starts_with("STAGE open") {
            progress(0.1);
        } else if line.starts_with("STAGE save") {
            progress(0.4);
        } else if line.starts_with("STAGE done") {
            progress(0.95);
        }
    };
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"].iter().map(|s| s.to_string()).chain([base64(&utf16)]).collect();
    let r = run_tool_process(
        &powershell(),
        &args,
        &RunOpts {
            env: vec![("ORANGE_IN".into(), input.to_string_lossy().into_owned()), ("ORANGE_OUT".into(), output.to_string_lossy().into_owned()), ("ORANGE_FMT".into(), format.into())],
            on_line: Some(&on),
            cancel: Some(&ctx.cancel),
            timeout: Some(timeout.unwrap_or(Duration::from_secs(300))),
            ..Default::default()
        },
    );
    let pids = pids.into_inner().unwrap();
    let (error_line, blocked_by, stalled) = state.into_inner().unwrap();
    let is_pdf = input.extension().map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false);
    match r {
        Ok(_) => {
            // Belt and braces: Office we started must not outlive the job. Give a clean Quit time first.
            if !pids.is_empty() {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(30));
                    pids.into_iter().for_each(kill_pid);
                });
            }
            Ok(())
        }
        Err(e) => {
            pids.iter().for_each(|&p| kill_pid(p));
            if ctx.cancel.load(Ordering::SeqCst) || e == "Cancelled" {
                return Err(Fail::Cancelled);
            }
            crate::log::write(&format!("office {} failed: {} pids={pids:?} blocked={blocked_by} {error_line} {e}", which.key(), input.display()));
            if e == "timed out" {
                if which == OfficeApp::Word && is_pdf {
                    mark_blocked("wordPdf");
                }
                return Err(Fail::User(format!("{} took too long and was stopped.", which.name())));
            }
            if stalled {
                if is_pdf {
                    mark_blocked("wordPdf");
                }
                return Err(Fail::User(format!("{} stopped responding and was closed.", which.name())));
            }
            if !blocked_by.is_empty() {
                let l = blocked_by.to_lowercase();
                if ["activat", "licen", "product key", "sign in", "subscription", "unlicensed"].iter().any(|n| l.contains(n)) {
                    mark_blocked(which.key());
                    return Err(unavailable(format!("Microsoft {} isn't activated, so Orange can't use it. Activate Office, or install the free LibreOffice.", which.name())));
                }
                let (title, text) = blocked_by.split_once(" ::").unwrap_or((&blocked_by, ""));
                let m = if text.trim().is_empty() { title } else { text.trim() };
                return Err(Fail::User(format!("{} stopped with a message: {}", which.name(), m.chars().take(160).collect::<String>())));
            }
            Err(Fail::Raw(office_message(which, if error_line.is_empty() { &e } else { &error_line })))
        }
    }
}

// ------------------------------------------------------------------ LibreOffice

/// Converts with LibreOffice headless. `filter` is a --convert-to spec such as 'docx:"MS Word 2007 XML"'.
pub fn libre_convert(input: &Path, output: &Path, filter: &str, infilter: Option<&str>, ctx: &Ctx, timeout: Option<Duration>) -> R<()> {
    let Some(soffice) = status().libreoffice else { return Err(need_office("This conversion")) };
    let _g = EXCLUSIVE.lock().unwrap_or_else(|p| p.into_inner());
    let work = ctx.tmp();
    let ext = input.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    // A plain ASCII name: LibreOffice chokes on some exotic paths.
    let staged = work.join(format!("input{ext}"));
    std::fs::copy(input, &staged)?;
    let out_dir = work.join("out");
    std::fs::create_dir_all(&out_dir)?;
    let profile = crate::engines::root().parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir).join("libreoffice-profile");
    let _ = std::fs::create_dir_all(&profile);
    let url = format!("file:///{}", profile.to_string_lossy().replace('\\', "/").replace(' ', "%20"));
    let mut a = vec![format!("-env:UserInstallation={url}"), "--headless".into(), "--invisible".into(), "--nologo".into(), "--nodefault".into(), "--norestore".into(), "--nolockcheck".into(), "--nofirststartwizard".into()];
    if let Some(f) = infilter {
        a.push(format!("--infilter={f}"));
    }
    a.extend(["--convert-to".into(), filter.into(), "--outdir".into(), out_dir.to_string_lossy().into_owned(), staged.to_string_lossy().into_owned()]);
    match run_tool_process(&soffice.to_string_lossy(), &a, &RunOpts { cwd: Some(&work), cancel: Some(&ctx.cancel), timeout: Some(timeout.unwrap_or(Duration::from_secs(600))), ..Default::default() }) {
        Ok(_) => {}
        Err(e) if e == "Cancelled" => return Err(Fail::Cancelled),
        Err(e) if e == "timed out" => return Err(Fail::User("LibreOffice took too long and was stopped.".into())),
        Err(e) => return Err(Fail::Raw(e)),
    }
    let produced = std::fs::read_dir(&out_dir)?.flatten().map(|e| e.path()).find(|p| p.is_file()).ok_or_else(|| Fail::User("LibreOffice couldn't convert this file.".into()))?;
    move_file(&produced, output)
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches() {
        assert_eq!(super::base64(b"Man"), "TWFu");
        assert_eq!(super::base64(b"Ma"), "TWE=");
        assert_eq!(super::base64(b"M"), "TQ==");
    }
}
