//! The client of the app's tool test server (`src/tools.rs`, `ORANGE_TOOL_TEST_DIR`).
//!
//! The tools run inside the tool windows' webviews (pdf-lib, pdf.js, ImageMagick through the
//! Rust spawner, ...), so a test cannot call them as Rust functions. Instead one `orange.exe` is
//! started per test binary, in test mode: no tray, hooks, wheel, shortcuts or updater, every
//! window off-screen and silent, input only as synthetic DOM events. A request is a JSON file in
//! the app's test folder; the answer comes back as another file. Requests run concurrently, each
//! in its own window, at most [`windows`] at a time.
//!
//! The test app always runs as the dev identifier (`app.orange.converter.dev`) with a scratch
//! profile (`ORANGE_USER_DATA`), so it never meets the installed Orange's single-instance lock,
//! profile or settings. It exits when the test process does.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// One step of a `steps` request.
pub enum Step {
    /// `tool:run` of a tool on files with the options its window sends.
    Run { tool: String, inputs: Vec<PathBuf>, options: Value, cancel_after_ms: Option<u64> },
    /// Any `orange.invoke(channel, ...args)` of the page (e.g. `rename:undo`).
    Invoke { channel: String, args: Vec<Value> },
}

pub fn run(tool: &str, inputs: &[PathBuf], options: Value) -> Step {
    Step::Run { tool: tool.into(), inputs: inputs.to_vec(), options, cancel_after_ms: None }
}

/// A run that is cancelled `ms` after it starts, as the progress panel's Cancel does.
pub fn run_cancelled(tool: &str, inputs: &[PathBuf], options: Value, ms: u64) -> Step {
    Step::Run { tool: tool.into(), inputs: inputs.to_vec(), options, cancel_after_ms: Some(ms) }
}

pub fn invoke(channel: &str, args: Vec<Value>) -> Step {
    Step::Invoke { channel: channel.into(), args }
}

/// What one step came to.
#[derive(Debug, Clone, Default)]
pub struct StepOut {
    pub outputs: Vec<PathBuf>,
    /// "done", "failed" or "cancelled" for a run step; empty for an invoke.
    pub state: String,
    /// The message the progress panel would show for a failed job.
    pub message: Option<String>,
    /// The value an invoke step returned.
    pub value: Value,
}

impl StepOut {
    pub fn into_result(self) -> Result<Vec<PathBuf>, String> {
        match self.state.as_str() {
            "done" => Ok(self.outputs),
            "cancelled" => Err("Cancelled".into()),
            _ => Err(self.message.unwrap_or_else(|| "the job failed without a message".into())),
        }
    }
}

struct Slots {
    free: Mutex<usize>,
    cv: Condvar,
}

pub struct ToolApp {
    dir: PathBuf,
    child: Mutex<Child>,
    seq: AtomicU64,
    slots: Slots,
}

static APP: OnceLock<Result<ToolApp, String>> = OnceLock::new();

/// Windows open at once (each is a webview of roughly 150 MB). `ORANGE_TEST_WINDOWS` changes it.
fn windows() -> usize {
    std::env::var("ORANGE_TEST_WINDOWS").ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(3)
}

/// Where downloaded engines live for this run: `ORANGE_ENGINES_DIR`, else the dev profile's
/// (the same folder the app uses, so engines are downloaded once).
pub fn engines_dir() -> PathBuf {
    std::env::var_os("ORANGE_ENGINES_DIR").map(PathBuf::from).unwrap_or_else(|| {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        local.join("app.orange.converter.dev").join("engines")
    })
}

impl ToolApp {
    fn start() -> Result<ToolApp, String> {
        let exe = env!("CARGO_BIN_EXE_orange");
        let dir = std::env::temp_dir().join("orange2-tests").join(format!("toolapp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("userdata")).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(dir.join("app.log")).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(exe);
        cmd.env("ORANGE_TOOL_TEST_DIR", &dir)
            .env("ORANGE_TOOL_TEST_PARENT", std::process::id().to_string())
            .env("ORANGE_USER_DATA", dir.join("userdata"))
            .env("ORANGE_TEST_IDENTIFIER", "app.orange.converter.dev")
            .env("ORANGE_ENGINES_DIR", engines_dir())
            .env("ORANGE_NO_UPDATE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
        let mut child = cmd.spawn().map_err(|e| format!("can't start {exe}: {e}"))?;
        let t = Instant::now();
        while !dir.join("ready").exists() {
            if let Ok(Some(st)) = child.try_wait() {
                return Err(format!("the test app exited at start-up ({st}); see {}", dir.join("app.log").display()));
            }
            if t.elapsed() > Duration::from_secs(90) {
                let _ = child.kill();
                return Err("the test app did not become ready in 90 s".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(ToolApp { dir, child: Mutex::new(child), seq: AtomicU64::new(0), slots: Slots { free: Mutex::new(windows()), cv: Condvar::new() } })
    }

    fn acquire(&self) {
        let mut n = self.slots.free.lock().unwrap();
        while *n == 0 {
            n = self.slots.cv.wait(n).unwrap();
        }
        *n -= 1;
    }

    fn release(&self) {
        *self.slots.free.lock().unwrap() += 1;
        self.slots.cv.notify_one();
    }

    /// Sends one request and waits for its answer.
    pub fn request(&self, mut req: Value, timeout: Duration) -> Result<Value, String> {
        let id = format!("r{}", self.seq.fetch_add(1, Ordering::SeqCst));
        req["timeout"] = json!(timeout.as_secs());
        self.acquire();
        let r = (|| {
            let tmp = self.dir.join(format!("{id}.tmp"));
            std::fs::write(&tmp, req.to_string()).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, self.dir.join(format!("{id}.req.json"))).map_err(|e| e.to_string())?;
            let res = self.dir.join(format!("{id}.res.json"));
            let t = Instant::now();
            loop {
                if let Ok(s) = std::fs::read_to_string(&res) {
                    let _ = std::fs::remove_file(&res);
                    return serde_json::from_str::<Value>(&s).map_err(|e| format!("bad answer: {e}"));
                }
                if let Ok(Some(st)) = self.child.lock().unwrap().try_wait() {
                    return Err(format!("the test app died ({st}); see {}", self.dir.join("app.log").display()));
                }
                if t.elapsed() > timeout + Duration::from_secs(45) {
                    return Err(format!("no answer within {} s", timeout.as_secs() + 45));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        })();
        self.release();
        r
    }
}

/// The shared test app (started on first use).
pub fn app() -> Result<&'static ToolApp, String> {
    APP.get_or_init(ToolApp::start).as_ref().map_err(|e| e.clone())
}

fn paths(p: &[PathBuf]) -> Vec<String> {
    p.iter().map(|x| x.to_string_lossy().into_owned()).collect()
}

fn path_list(v: &Value) -> Vec<PathBuf> {
    v.as_array().into_iter().flatten().filter_map(|x| x.as_str().map(PathBuf::from)).collect()
}

/// Runs steps in one blank tool window (so state such as rename's undo history carries over).
pub fn steps(list: Vec<Step>) -> Result<Vec<StepOut>, String> {
    steps_timeout(list, Duration::from_secs(240))
}

pub fn steps_timeout(list: Vec<Step>, timeout: Duration) -> Result<Vec<StepOut>, String> {
    let mut tools: Vec<String> = vec![];
    let json_steps: Vec<Value> = list
        .iter()
        .map(|s| match s {
            Step::Run { tool, inputs, options, cancel_after_ms } => {
                if !tools.contains(tool) {
                    tools.push(tool.clone());
                }
                json!({ "run": { "tool": tool, "paths": paths(inputs), "options": options, "cancelAfterMs": cancel_after_ms } })
            }
            Step::Invoke { channel, args } => {
                // The module that registers the channel's handler is loaded with a tool that needs it.
                if let Some(t) = channel_tool(channel) {
                    if !tools.iter().any(|x| x == t) {
                        tools.push(t.to_string());
                    }
                }
                let mut a = vec![json!(channel)];
                a.extend(args.iter().cloned());
                json!({ "invoke": a })
            }
        })
        .collect();
    let res = app()?.request(json!({ "kind": "steps", "tools": tools, "steps": json_steps }), timeout)?;
    if res["ok"] != json!(true) {
        return Err(format!("{}{}", res["error"].as_str().unwrap_or("request failed"), page_errors(&res)));
    }
    let results = res["result"].as_array().cloned().unwrap_or_default();
    let jobs = res["jobs"].as_array().cloned().unwrap_or_default();
    let mut job_i = 0;
    let mut out = vec![];
    for (s, r) in list.iter().zip(results) {
        match s {
            Step::Run { .. } => {
                let j = jobs.get(job_i).cloned().unwrap_or(Value::Null);
                job_i += 1;
                out.push(StepOut {
                    outputs: path_list(&j["outputs"]),
                    state: j["state"].as_str().unwrap_or("").to_string(),
                    message: j["message"].as_str().map(String::from),
                    value: Value::Null,
                });
            }
            Step::Invoke { .. } => out.push(StepOut { value: r["value"].clone(), message: r["error"].as_str().map(String::from), ..Default::default() }),
        }
    }
    Ok(out)
}

/// A tool whose module registers the handlers of `channel` (a window loads modules per tool).
fn channel_tool(channel: &str) -> Option<&'static str> {
    Some(match channel.split(':').next()? {
        "meta" | "compress" => "metadata",
        "pdf" => "mergePdf",
        "rename" | "unlock" | "protect" => "rename",
        "av" => "trimVideo",
        "ai" => "ocr",
        "speech" => "subtitles",
        _ => return None,
    })
}

fn page_errors(res: &Value) -> String {
    match res["pageErrors"].as_array() {
        Some(a) if !a.is_empty() => format!(" (page errors: {})", a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" | ")),
        _ => String::new(),
    }
}

/// One tool run: the created files, or the message the progress panel would show.
pub fn tool(id: &str, inputs: &[PathBuf], options: Value) -> Result<Vec<PathBuf>, String> {
    match steps(vec![run(id, inputs, options)]) {
        Ok(mut v) => v.remove(0).into_result(),
        Err(e) => Err(format!("test harness: {e}")),
    }
}

/// What a page or wheel request came to.
#[derive(Debug, Clone)]
pub struct PageRun {
    /// Every job the window ran: (state, outputs, message).
    pub jobs: Vec<StepOut>,
    /// The script's return value.
    pub result: Value,
    /// The window closed itself after its job.
    pub closed: bool,
    pub page_errors: Vec<String>,
}

fn page_run(req: Value, timeout: Duration) -> Result<PageRun, String> {
    let res = app()?.request(req, timeout)?;
    if res["ok"] != json!(true) {
        return Err(format!("{}{}", res["error"].as_str().unwrap_or("request failed"), page_errors(&res)));
    }
    Ok(PageRun {
        jobs: res["jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|j| StepOut {
                outputs: path_list(&j["outputs"]),
                state: j["state"].as_str().unwrap_or("").to_string(),
                message: j["message"].as_str().map(String::from),
                value: Value::Null,
            })
            .collect(),
        result: res["result"].clone(),
        closed: res["closed"] == json!(true),
        page_errors: res["pageErrors"].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect(),
    })
}

/// Opens the real tool page (as the Tools wheel does for `tool:<id>`), runs `script` in it, and
/// waits for `jobs` jobs to finish. `script` is an async function body; it has `$`, `$$`, `click`,
/// `setValue`, `key`, `wait`, `until` and `byText` (see `TEST_PRELUDE` in tools.rs).
pub fn page(tool: &str, inputs: &[PathBuf], script: &str, jobs: usize, timeout: Duration) -> Result<PageRun, String> {
    page_run(json!({ "kind": "page", "tool": tool, "paths": paths(inputs), "script": script, "jobs": jobs }), timeout)
}

/// Like [`page`], but the window is opened by choosing `item` (`tool:compress`, `preset:<id>`) the way
/// the wheel does (`jobs::run_choice`).
pub fn wheel(item: &str, inputs: &[PathBuf], script: &str, jobs: usize, timeout: Duration) -> Result<PageRun, String> {
    page_run(json!({ "kind": "wheel", "item": item, "paths": paths(inputs), "script": script, "jobs": jobs }), timeout)
}

/// The page script that presses the primary button once it is enabled.
pub const CLICK_PRIMARY: &str = "const b = await until(() => $('.footer .btn.primary')); await wait(500); await until(() => !b.disabled, 30000); click(b);";
