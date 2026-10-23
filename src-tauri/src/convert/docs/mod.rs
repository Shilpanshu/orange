//! Document conversions: PDF, word-processing documents, slides, spreadsheets and EPUB
//! (convert-docs.ts). Engines, best first for each job:
//!
//! - Microsoft Office (COM): Office formats in/out, Word's PDF reflow for PDF→DOCX (user's install)
//! - LibreOffice (headless): the same when Office is absent, plus Apple iWork (user's install)
//! - Pandoc (downloaded): Markdown / HTML / DOCX / ODT / RTF / EPUB / text
//! - Ghostscript (downloaded): PDF pages → images, PDF text with positions
//! - built in: CSV / TSV / XLSX / ODS, PPTX of page images
//! - Microsoft Edge (headless, part of Windows): HTML → PDF printing for text formats
//!
//! Public: `convert(input, target, ctx)`, `html_to_pdf(html, out, landscape, ctx)`, and the
//! `office`, `pdf`, `sheets` submodules.

pub mod office;
mod office_ps;
pub mod pdf;
pub mod sheets;

use super::subtitle::decode_text;
use super::{ext_of, file_name, move_file, remove_on_failure, stem_of, user, Ctx, Fail, R};
use office::{is_unavailable, need_office, untag, OfficeApp};
use pdf::escape_html;
use sheets::Sheet;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn norm(ext: &str) -> &str {
    match ext {
        "markdown" => "md",
        "htm" => "html",
        e => e,
    }
}

// ------------------------------------------------------------------ office routing

fn lo_filter(fmt: &str) -> String {
    match fmt {
        "docx" => "docx:\"MS Word 2007 XML\"",
        "doc" => "doc:\"MS Word 97\"",
        "rtf" => "rtf:\"Rich Text Format\"",
        "pptx" => "pptx:\"Impress MS PowerPoint 2007 XML\"",
        "xlsx" => "xlsx:\"Calc MS Excel 2007 XML\"",
        f => f,
    }
    .to_string()
}

struct Route {
    app: Option<OfficeApp>,
    infilter: Option<&'static str>,
    libre: bool,
    what: String,
    timeout: Option<Duration>,
}

impl Route {
    fn new(app: Option<OfficeApp>, what: impl Into<String>) -> Route {
        Route { app, infilter: None, libre: true, what: what.into(), timeout: None }
    }
}

fn office_can(r: &Route) -> bool {
    let st = office::status();
    r.app.map(|a| st.has(a)).unwrap_or(false) || (r.libre && st.libreoffice.is_some())
}

/// Microsoft Office if it can, else LibreOffice. A "needs an office suite" failure is tagged so
/// callers with a built-in route fall back to it.
fn via_office(input: &Path, output: &Path, fmt: &str, ctx: &Ctx, r: &Route, a: f64, b: f64) -> R<PathBuf> {
    let st = office::status();
    let prog = ctx.span(a, b);
    let mut office_err: Option<Fail> = None;
    if let Some(app) = r.app.filter(|&x| st.has(x)) {
        match office::office_convert(app, input, output, fmt, ctx, &prog, r.timeout) {
            Ok(()) if output.exists() => return Ok(output.to_path_buf()),
            Ok(()) => office_err = Some(Fail::Raw("Office produced no output".into())),
            Err(Fail::Cancelled) => return Err(Fail::Cancelled),
            Err(e) => {
                crate::log::write(&format!("office route failed, trying LibreOffice: {e}"));
                office_err = Some(e);
            }
        }
    }
    if r.libre && st.libreoffice.is_some() {
        prog(0.2);
        office::libre_convert(input, output, &lo_filter(fmt), r.infilter, ctx, r.timeout)?;
        prog(1.0);
        return Ok(output.to_path_buf());
    }
    // Office was tried and failed and there's no LibreOffice: report it as "unavailable" so callers
    // with a built-in route fall back to it instead of failing.
    if let Some(e) = office_err {
        if is_unavailable(&e) {
            return Err(e);
        }
        let m = match e {
            Fail::User(m) | Fail::Raw(m) => m,
            Fail::Cancelled => return Err(Fail::Cancelled),
        };
        return Err(office::unavailable(m));
    }
    Err(need_office(&r.what))
}

// ------------------------------------------------------------------ Edge print

/// Comfortable reading styles used for HTML output and for HTML→PDF printing (pandoc.ts).
pub const READING_CSS: &str = r#"
:root { color-scheme: light; }
html { font-size: 16px; }
body {
  margin: 0 auto; max-width: 46rem; padding: 2.5rem 1.5rem 4rem;
  font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; line-height: 1.6; color: #1d1d1f; background: #fff;
  overflow-wrap: break-word; hyphens: auto;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.8em 0 0.6em; font-weight: 650; }
h1 { font-size: 2rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.25rem; } h4 { font-size: 1.05rem; }
p, ul, ol, dl, table, pre, blockquote, figure { margin: 0 0 1em; }
a { color: #b4540a; }
img, svg, video { max-width: 100%; height: auto; }
figure { text-align: center; } figcaption { font-size: 0.9em; color: #555; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #e0ddd8; color: #444; }
code, pre { font-family: "Cascadia Mono", Consolas, monospace; font-size: 0.9em; }
pre { padding: 0.8em 1em; background: #f6f5f3; overflow-x: auto; white-space: pre-wrap; }
:not(pre) > code { background: #f6f5f3; padding: 0.1em 0.3em; }
table { border-collapse: collapse; width: auto; max-width: 100%; }
th, td { border: 1px solid #dcd9d4; padding: 0.35em 0.6em; vertical-align: top; text-align: left; }
th { background: #f6f5f3; font-weight: 600; }
hr { border: 0; border-top: 1px solid #e0ddd8; margin: 2em 0; }
header#title-block-header { margin-bottom: 2em; }
@media print {
  body { max-width: none; padding: 0; font-size: 11pt; }
  h1, h2, h3, h4 { break-after: avoid; }
  pre, blockquote, table, figure, img { break-inside: avoid; }
}
"#;

fn edge_exe() -> Option<PathBuf> {
    let mut c = vec![];
    for base in [std::env::var("ProgramFiles(x86)").ok(), std::env::var("ProgramFiles").ok(), std::env::var("LOCALAPPDATA").ok()].into_iter().flatten() {
        c.push(PathBuf::from(base).join(r"Microsoft\Edge\Application\msedge.exe"));
    }
    c.into_iter().find(|p| p.is_file())
}

fn page_size_for_locale() -> &'static str {
    static SIZE: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    SIZE.get_or_init(|| {
        let win = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let r = crate::engines::run_tool_process(&format!(r"{win}\System32\reg.exe"), &["query".into(), r"HKCU\Control Panel\International".into(), "/v".into(), "LocaleName".into()], &Default::default());
        let loc = r.map(|r| r.stdout_text()).unwrap_or_default().to_uppercase();
        if ["-US", "-CA", "-MX", "-PH", "-CL", "-CO", "-VE"].iter().any(|s| loc.contains(s)) {
            "letter"
        } else {
            "A4"
        }
    })
}

/// Prints an HTML file to PDF with Edge headless (its own throwaway profile, no network profile state).
/// `page_css` adds an @page rule (size, margins, orientation) when Orange wrote the HTML itself.
pub fn html_to_pdf(html: &Path, out: &Path, landscape: bool, ours: bool, ctx: &Ctx) -> R<()> {
    ctx.check()?;
    let Some(edge) = edge_exe() else { return user("Printing to PDF needs Microsoft Edge, which is missing from this PC.") };
    let mut src = html.to_path_buf();
    if ours {
        let page = format!("<style>@page {{ size: {}{}; margin: 0.7in 0.75in; }}</style>", page_size_for_locale(), if landscape { " landscape" } else { "" });
        let text = std::fs::read_to_string(html).unwrap_or_default();
        let text = match text.find("</head>") {
            Some(i) => format!("{}{page}{}", &text[..i], &text[i..]),
            None => format!("{page}{text}"),
        };
        src = html.with_file_name("print-page.html");
        std::fs::write(&src, text)?;
    }
    let profile = ctx.tmp();
    let url = format!("file:///{}", src.to_string_lossy().replace('\\', "/").replace('%', "%25").replace(' ', "%20").replace('#', "%23"));
    let tmp_pdf = ctx.tmp().join("print.pdf");
    let args = vec![
        "--headless".to_string(),
        "--disable-gpu".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-extensions".into(),
        format!("--user-data-dir={}", profile.display()),
        "--no-pdf-header-footer".into(),
        "--generate-pdf-document-outline".into(),
        format!("--print-to-pdf={}", tmp_pdf.display()),
        url,
    ];
    match ctx.run(&edge.to_string_lossy(), &args, crate::engines::RunOpts { timeout: Some(Duration::from_secs(300)), no_stdout: true, ..Default::default() }) {
        Ok(_) => {}
        Err(Fail::Cancelled) => return Err(Fail::Cancelled),
        // Edge prints chatter to stderr and can exit non-zero after writing the file.
        Err(e) if !tmp_pdf.exists() => return Err(e),
        Err(_) => {}
    }
    if std::fs::metadata(&tmp_pdf).map(|m| m.len() == 0).unwrap_or(true) {
        return Err(Fail::Raw("Couldn't print the document to PDF.".into()));
    }
    move_file(&tmp_pdf, out)
}

// ------------------------------------------------------------------ pandoc

fn pandoc_reader(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "md" | "markdown" | "txt" => "markdown",
        "html" | "htm" => "html",
        "docx" => "docx",
        "odt" => "odt",
        "rtf" => "rtf",
        "epub" => "epub",
        _ => return None,
    })
}

fn pandoc_writer(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "md" => "gfm",
        "txt" => "plain",
        "html" => "html5",
        "docx" => "docx",
        "odt" => "odt",
        "rtf" => "rtf",
        "epub" => "epub3",
        _ => return None,
    })
}

fn text_to_html(text: &str, title: &str) -> String {
    let t = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut paras = vec![];
    let mut cur: Vec<&str> = vec![];
    for l in t.split('\n') {
        if l.trim().is_empty() {
            if !cur.is_empty() {
                paras.push(cur.join("\n"));
                cur.clear();
            }
        } else {
            cur.push(l);
        }
    }
    if !cur.is_empty() {
        paras.push(cur.join("\n"));
    }
    let body: Vec<String> = paras.iter().map(|p| format!("<p>{}</p>", escape_html(p).replace('\n', "<br>\n"))).collect();
    format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body>\n{}\n</body></html>", escape_html(title), body.join("\n"))
}

fn free_sibling(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let n = file_name(p);
    (2..).map(|i| p.with_file_name(format!("{n} {i}"))).find(|c| !c.exists()).unwrap()
}

/// pandoc from `input` (read by `src_ext`) to `output`. Plain text is wrapped into HTML first;
/// Markdown output extracts embedded images into a sibling "<name> files" folder.
fn pandoc_to(input: &Path, src_ext: &str, output: &Path, target: &str, ctx: &Ctx, title: &str) -> R<Vec<PathBuf>> {
    let exe = ctx.engine("pandoc")?;
    let mut src = input.to_path_buf();
    let mut from = pandoc_reader(src_ext);
    if src_ext == "txt" {
        src = ctx.tmp().join("text.html");
        std::fs::write(&src, text_to_html(&decode_text(&std::fs::read(input)?), title))?;
        from = Some("html");
    }
    let (Some(from), Some(to)) = (from, pandoc_writer(target)) else {
        return user(format!("Can't convert {} to {}.", src_ext.to_uppercase(), target.to_uppercase()));
    };
    let out_dir = output.parent().unwrap_or(Path::new(".")).to_path_buf();
    let mut media = None;
    let mut extra = vec![];
    if target == "md" && ["docx", "odt", "epub", "rtf"].contains(&src_ext) {
        let m = free_sibling(&out_dir.join(format!("{} files", stem_of(output))));
        extra.push(format!("--extract-media={}", file_name(&m)));
        media = Some(m);
    }
    // pandoc runs in the output folder (so extracted media links are relative), but Windows can't
    // start a process in a folder path past ~258 characters: work in temp then and move the results.
    let work = (out_dir.as_os_str().len() >= 240).then(|| ctx.tmp());
    let written = work.as_ref().map(|w| w.join(file_name(output))).unwrap_or_else(|| output.to_path_buf());
    let tmp = ctx.tmp();
    let mut args = vec!["--from".to_string(), from.into(), "--to".into(), to.into(), "--output".into(), written.to_string_lossy().into_owned()];
    args.push(format!("--resource-path={};{}", src.parent().unwrap_or(Path::new(".")).display(), input.parent().unwrap_or(Path::new(".")).display()));
    let meta = tmp.join("orange-meta.yaml");
    let q = serde_json::to_string(title).unwrap_or_default();
    std::fs::write(&meta, format!("pagetitle: {q}\n{}", if to.starts_with("epub") { format!("title: {q}\n") } else { String::new() }))?;
    args.push(format!("--metadata-file={}", meta.display()));
    match to {
        "html5" => {
            let css = tmp.join("orange-reading.css");
            std::fs::write(&css, READING_CSS)?;
            args.extend(["--standalone".into(), "--embed-resources".into(), format!("--css={}", css.display())]);
        }
        "plain" | "gfm" | "markdown" => args.push("--wrap=none".into()),
        "epub3" => {
            let css = tmp.join("orange-epub.css");
            std::fs::write(&css, READING_CSS.replace("max-width: 46rem;", "").replace("padding: 2.5rem 1.5rem 4rem;", ""))?;
            args.extend([format!("--css={}", css.display()), "--split-level=1".into()]);
        }
        _ => args.push("--standalone".into()),
    }
    args.extend(extra);
    args.push(src.to_string_lossy().into_owned());
    let cwd = work.clone().unwrap_or(out_dir.clone());
    ctx.run(&exe.to_string_lossy(), &args, crate::engines::RunOpts { cwd: Some(&cwd), ..Default::default() })?;
    if !written.exists() {
        return Err(Fail::Raw("pandoc produced no output".into()));
    }
    if let Some(w) = &work {
        move_file(&written, output)?;
        if let Some(m) = &media {
            let made = w.join(file_name(m));
            if made.exists() && std::fs::rename(&made, m).is_err() {
                copy_dir(&made, m)?;
            }
        }
    }
    Ok(match media {
        Some(m) if m.exists() => vec![output.to_path_buf(), m],
        _ => vec![output.to_path_buf()],
    })
}

fn copy_dir(from: &Path, to: &Path) -> R<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let p = e.path();
        if p.is_dir() {
            copy_dir(&p, &to.join(e.file_name()))?;
        } else {
            std::fs::copy(&p, to.join(e.file_name()))?;
        }
    }
    Ok(())
}

/// Any pandoc-readable input → styled standalone HTML (images embedded) in temp.
fn to_printable_html(input: &Path, src_ext: &str, ctx: &Ctx, title: &str) -> R<(PathBuf, bool)> {
    if src_ext == "html" && input.as_os_str().len() < 240 {
        return Ok((input.to_path_buf(), false));
    }
    let html = ctx.tmp().join("print.html");
    pandoc_to(input, src_ext, &html, "html", ctx, title)?;
    Ok((html, true))
}

fn print_via_html(input: &Path, src: &str, out: &Path, ctx: &Ctx, title: &str) -> R<Vec<PathBuf>> {
    ctx.progress(0.1);
    let (html, ours) = to_printable_html(input, src, ctx, title)?;
    ctx.progress(0.5);
    html_to_pdf(&html, out, false, ours, ctx)?;
    Ok(vec![out.to_path_buf()])
}

// ------------------------------------------------------------------ PDF

fn pdf_to_images(input: &Path, fmt: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let n = pdf::page_sizes(input, ctx)?.len();
    if n == 1 {
        let tmp = ctx.tmp();
        let imgs = pdf::render(input, &tmp, fmt, ctx, &ctx.span(0.05, 0.95), 300, "Page ", 1)?;
        let out = ctx.out(input, fmt, "");
        move_file(&imgs[0], &out)?;
        return Ok(vec![out]);
    }
    let dir = ctx.out_dir(input, None);
    remove_on_failure(&dir, || pdf::render(input, &dir, fmt, ctx, &ctx.span(0.05, 0.98), 300, "Page ", n))?;
    Ok(vec![dir])
}

fn pdf_via_html(input: &Path, out: &Path, target: &str, ctx: &Ctx, title: &str) -> R<Vec<PathBuf>> {
    let mut doc = pdf::read_text(input, ctx, &ctx.span(0.05, 0.6))?;
    let paras = pdf::lines_to_paras(&mut doc);
    if paras.is_empty() {
        return Err(pdf::no_text());
    }
    let html = ctx.tmp().join("pdf.html");
    std::fs::write(&html, pdf::paras_to_html(&paras, title))?;
    ctx.progress(0.7);
    pandoc_to(&html, "html", out, target, ctx, title)
}

fn reflow_timeout(input: &Path, ctx: &Ctx) -> Duration {
    let pages = pdf::page_sizes(input, ctx).map(|s| s.len()).unwrap_or(50) as u64;
    Duration::from_millis((15 * 60_000u64).min(60_000 + pages * 6_000))
}

fn pdf_to_xlsx(input: &Path, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let doc = pdf::read_text(input, ctx, &ctx.span(0.05, 0.6))?;
    if !doc.pages.iter().any(|p| p.items.iter().any(|i| !i.s.trim().is_empty())) {
        return Err(pdf::no_text());
    }
    let single = doc.pages.len() == 1;
    let mut data = vec![];
    for (i, page) in doc.pages.iter().enumerate() {
        let rows = pdf::page_to_rows(page);
        if rows.is_empty() {
            continue;
        }
        let mut widths: Vec<f64> = vec![];
        let vals: Vec<Vec<sheets::Val>> = rows
            .iter()
            .map(|r| {
                r.iter()
                    .enumerate()
                    .map(|(ci, text)| {
                        if text.is_empty() {
                            return sheets::Val::Empty;
                        }
                        if widths.len() <= ci {
                            widths.resize(ci + 1, 8.0);
                        }
                        widths[ci] = widths[ci].max(((text.chars().count() + 2) as f64).min(60.0));
                        match pdf::parse_numberish(text) {
                            Some((v, f)) => sheets::Val::Num(v, f),
                            None => sheets::Val::Str(text.clone()),
                        }
                    })
                    .collect()
            })
            .collect();
        data.push((if single { "Sheet1".to_string() } else { format!("Page {}", i + 1) }, vals, widths));
    }
    if data.is_empty() {
        return Err(pdf::no_text());
    }
    ctx.progress(0.8);
    let out = ctx.out(input, "xlsx", "");
    remove_on_failure(&out, || sheets::write_xlsx(&data, &out))?;
    Ok(vec![out])
}

fn from_pdf(input: &Path, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let title = stem_of(input);
    match target {
        "png" | "jpg" => pdf_to_images(input, target, ctx),
        "docx" => {
            let out = ctx.out(input, "docx", "");
            let route = Route { app: office::word_pdf_reflow_usable().then_some(OfficeApp::Word), infilter: Some("writer_pdf_import"), libre: true, what: "PDF to Word".into(), timeout: Some(reflow_timeout(input, ctx)) };
            if office_can(&route) {
                match via_office(input, &out, "docx", ctx, &route, 0.05, 0.95) {
                    Ok(_) => return Ok(vec![out]),
                    Err(Fail::Cancelled) => return Err(Fail::Cancelled),
                    // A clean text-structured DOCX beats no DOCX.
                    Err(e) => crate::log::write(&format!("PDF→DOCX via office failed, rebuilding from text: {e}")),
                }
            }
            pdf_via_html(input, &out, "docx", ctx, &title)
        }
        "pptx" => {
            let out = ctx.out(input, "pptx", "");
            if office::status().libreoffice.is_some() {
                match office::libre_convert(input, &out, &lo_filter("pptx"), Some("impress_pdf_import"), ctx, None) {
                    Ok(()) => return Ok(vec![out]),
                    Err(Fail::Cancelled) => return Err(Fail::Cancelled),
                    Err(e) => crate::log::write(&format!("LibreOffice PDF→PPTX failed, using page images: {e}")),
                }
            }
            remove_on_failure(&out, || pdf_to_pptx_images(input, ctx, &out))?;
            Ok(vec![out])
        }
        "xlsx" => pdf_to_xlsx(input, ctx),
        "epub" => {
            let out = ctx.out(input, "epub", "");
            if office::status().word && office::word_pdf_reflow_usable() {
                // Word's reflow keeps headings, lists and images; pandoc packages them as an e-book.
                let docx = ctx.tmp().join("reflow.docx");
                let r = office::office_convert(OfficeApp::Word, input, &docx, "docx", ctx, &ctx.span(0.05, 0.75), Some(reflow_timeout(input, ctx))).and_then(|_| pandoc_to(&docx, "docx", &out, "epub", ctx, &title));
                match r {
                    Ok(v) => return Ok(v),
                    Err(Fail::Cancelled) => return Err(Fail::Cancelled),
                    Err(e) => crate::log::write(&format!("Word PDF reflow failed, using text extraction: {e}")),
                }
            }
            pdf_via_html(input, &out, "epub", ctx, &title)
        }
        "txt" => {
            let mut doc = pdf::read_text(input, ctx, &ctx.span(0.05, 0.85))?;
            let paras = pdf::lines_to_paras(&mut doc);
            if paras.is_empty() {
                return Err(pdf::no_text());
            }
            let out = ctx.out(input, "txt", "");
            std::fs::write(&out, pdf::paras_to_text(&paras))?;
            Ok(vec![out])
        }
        "md" => {
            let out = ctx.out(input, "md", "");
            pdf_via_html(input, &out, "md", ctx, &title)
        }
        _ => user(format!("Can't convert PDF to {}.", target.to_uppercase())),
    }
}

// ------------------------------------------------------------------ PPTX of page images

const EMU_PER_PT: f64 = 12700.0;

fn pdf_to_pptx_images(input: &Path, ctx: &Ctx, out: &Path) -> R<()> {
    let sizes = pdf::page_sizes(input, ctx)?;
    let tmp = ctx.tmp();
    let files = pdf::render(input, &tmp, "jpg", ctx, &ctx.span(0.1, 0.85), 200, "Page ", sizes.len())?;
    let imgs: Vec<(PathBuf, f64, f64)> = files.into_iter().enumerate().map(|(i, f)| (f, sizes.get(i).map(|s| s.0).unwrap_or(612.0), sizes.get(i).map(|s| s.1).unwrap_or(792.0))).collect();
    images_to_pptx(&imgs, out)
}

const THEME_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Orange"><a:themeElements><a:clrScheme name="Orange"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B2A29"/></a:dk2><a:lt2><a:srgbClr val="EEECE8"/></a:lt2><a:accent1><a:srgbClr val="E8711A"/></a:accent1><a:accent2><a:srgbClr val="3E6E8E"/></a:accent2><a:accent3><a:srgbClr val="7A9A3A"/></a:accent3><a:accent4><a:srgbClr val="B8484F"/></a:accent4><a:accent5><a:srgbClr val="6B5B95"/></a:accent5><a:accent6><a:srgbClr val="C9A227"/></a:accent6><a:hlink><a:srgbClr val="1F5F99"/></a:hlink><a:folHlink><a:srgbClr val="7F4F99"/></a:folHlink></a:clrScheme><a:fontScheme name="Orange"><a:majorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Orange"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"#;

/// A minimal, valid PowerPoint file with one full-bleed picture per slide.
fn images_to_pptx(images: &[(PathBuf, f64, f64)], out: &Path) -> R<()> {
    let (fw, fh) = (images[0].1, images[0].2);
    let (mut cx, mut cy) = (fw * EMU_PER_PT, fh * EMU_PER_PT);
    let k = (51_206_400.0 / cx.max(cy)).min(1.0);
    cx = (cx * k).round().max(914_400.0);
    cy = (cy * k).round().max(914_400.0);
    let (cx, cy) = (cx as i64, cy as i64);
    const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;
    const XML: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
    const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    let rels = |items: &[(String, &str, String)]| format!("{XML}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{}</Relationships>", items.iter().map(|(id, ty, t)| format!("<Relationship Id=\"{id}\" Type=\"{REL}/{ty}\" Target=\"{t}\"/>")).collect::<String>());
    let empty_tree = r#"<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>"#;
    let n = images.len();
    let mut files: Vec<(String, Vec<u8>)> = vec![];
    files.push(("[Content_Types].xml".into(), format!("{XML}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/><Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>{}</Types>", (1..=n).map(|i| format!("<Override PartName=\"/ppt/slides/slide{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>")).collect::<String>()).into_bytes()));
    files.push(("_rels/.rels".into(), format!("{XML}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{REL}/officeDocument\" Target=\"ppt/presentation.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"{REL}/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>").into_bytes()));
    files.push(("docProps/core.xml".into(), format!("{XML}<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:creator>Orange</dc:creator></cp:coreProperties>").into_bytes()));
    files.push(("docProps/app.xml".into(), format!("{XML}<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\"><Application>Orange</Application><Slides>{n}</Slides></Properties>").into_bytes()));
    files.push(("ppt/presentation.xml".into(), format!("{XML}<p:presentation {NS} saveSubsetFonts=\"1\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst>{}</p:sldIdLst><p:sldSz cx=\"{cx}\" cy=\"{cy}\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>", (0..n).map(|i| format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 256 + i, i + 3)).collect::<String>()).into_bytes()));
    let mut prel = vec![("rId1".to_string(), "slideMaster", "slideMasters/slideMaster1.xml".to_string()), ("rId2".into(), "theme", "theme/theme1.xml".into())];
    prel.extend((0..n).map(|i| (format!("rId{}", i + 3), "slide", format!("slides/slide{}.xml", i + 1))));
    files.push(("ppt/_rels/presentation.xml.rels".into(), rels(&prel).into_bytes()));
    files.push(("ppt/slideMasters/slideMaster1.xml".into(), format!("{XML}<p:sldMaster {NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>{empty_tree}</p:spTree></p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst></p:sldMaster>").into_bytes()));
    files.push(("ppt/slideMasters/_rels/slideMaster1.xml.rels".into(), rels(&[("rId1".into(), "slideLayout", "../slideLayouts/slideLayout1.xml".into()), ("rId2".into(), "theme", "../theme/theme1.xml".into())]).into_bytes()));
    files.push(("ppt/slideLayouts/slideLayout1.xml".into(), format!("{XML}<p:sldLayout {NS} type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:spTree>{empty_tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>").into_bytes()));
    files.push(("ppt/slideLayouts/_rels/slideLayout1.xml.rels".into(), rels(&[("rId1".into(), "slideMaster", "../slideMasters/slideMaster1.xml".into())]).into_bytes()));
    files.push(("ppt/theme/theme1.xml".into(), THEME_XML.as_bytes().to_vec()));
    for (i, (file, wpt, hpt)) in images.iter().enumerate() {
        // Fit each page inside the slide, centred (pages of a PDF can differ in size).
        let s = (cx as f64 / (wpt * EMU_PER_PT)).min(cy as f64 / (hpt * EMU_PER_PT));
        let w = (wpt * EMU_PER_PT * s).round() as i64;
        let h = (hpt * EMU_PER_PT * s).round() as i64;
        let (x, y) = ((cx - w) / 2, (cy - h) / 2);
        let ext = if ext_of(file) == "png" { "png" } else { "jpeg" };
        files.push((format!("ppt/media/image{}.{ext}", i + 1), std::fs::read(file)?));
        files.push((format!("ppt/slides/slide{}.xml", i + 1), format!("{XML}<p:sld {NS}><p:cSld><p:spTree>{empty_tree}<p:pic><p:nvPicPr><p:cNvPr id=\"2\" name=\"Page {}\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed=\"rId2\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{w}\" cy=\"{h}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>", i + 1).into_bytes()));
        files.push((format!("ppt/slides/_rels/slide{}.xml.rels", i + 1), rels(&[("rId1".into(), "slideLayout", "../slideLayouts/slideLayout1.xml".into()), ("rId2".into(), "image", format!("../media/image{}.{ext}", i + 1))]).into_bytes()));
    }
    let refs: Vec<(&str, Vec<u8>)> = files.iter().map(|(a, b)| (a.as_str(), b.clone())).collect();
    sheets::zip_write(out, &refs)
}

// ------------------------------------------------------------------ documents, e-books, slides

const RICH_DOC: &[&str] = &["docx", "doc", "odt", "rtf", "pages"];
const PANDOC_DOC: &[&str] = &["docx", "odt", "rtf", "md", "html", "txt", "epub"];

fn from_document(input: &Path, src: &str, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let title = stem_of(input);
    let out = ctx.out(input, target, "");
    let word = Route::new((src != "pages").then_some(OfficeApp::Word), format!("Converting {} files", src.to_uppercase()));
    // Rich source → rich target (or PDF): the office suite preserves layout, fonts and everything else.
    if RICH_DOC.contains(&src) && ["pdf", "docx", "odt", "rtf"].contains(&target) {
        if office_can(&word) {
            match via_office(input, &out, target, ctx, &word, 0.05, 0.95) {
                Ok(_) => return Ok(vec![out]),
                Err(e) if !is_unavailable(&e) || !PANDOC_DOC.contains(&src) => return Err(e),
                Err(_) => {}
            }
        }
        if !PANDOC_DOC.contains(&src) {
            return Err(need_office(&word.what));
        }
        // No office suite: pandoc for formats it understands.
        if target == "pdf" {
            return print_via_html(input, src, &out, ctx, &title);
        }
        ctx.progress(0.2);
        return pandoc_to(input, src, &out, target, ctx, &title);
    }
    // Text-like source → PDF: styled HTML printed by Edge.
    if target == "pdf" {
        return print_via_html(input, src, &out, ctx, &title);
    }
    // Everything else is pandoc's home turf; legacy/foreign formats go through DOCX first.
    let (mut source, mut from) = (input.to_path_buf(), src.to_string());
    if !PANDOC_DOC.contains(&src) {
        let docx = ctx.tmp().join(format!("{title}.docx"));
        via_office(input, &docx, "docx", ctx, &word, 0.05, 0.6)?;
        source = docx;
        from = "docx".into();
    }
    ctx.progress(0.65);
    pandoc_to(&source, &from, &out, target, ctx, &title)
}

fn from_ebook(input: &Path, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let title = stem_of(input);
    let out = ctx.out(input, target, "");
    if target == "pdf" {
        return print_via_html(input, "epub", &out, ctx, &title);
    }
    ctx.progress(0.15);
    pandoc_to(input, "epub", &out, target, ctx, &title)
}

fn from_slides(input: &Path, src: &str, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let route = Route::new((src != "key").then_some(OfficeApp::PowerPoint), "Converting presentations");
    if target == "pdf" || target == "pptx" {
        let out = ctx.out(input, target, "");
        via_office(input, &out, target, ctx, &route, 0.05, 0.95)?;
        return Ok(vec![out]);
    }
    if target != "png" && target != "jpg" {
        return user(format!("Can't convert {} to {}.", src.to_uppercase(), target.to_uppercase()));
    }
    let st = office::status();
    if route.app.is_some() && st.powerpoint {
        let tmp = ctx.tmp().join("slides");
        std::fs::create_dir_all(&tmp)?;
        let r = (|| -> R<Vec<PathBuf>> {
            office::office_convert(OfficeApp::PowerPoint, input, &tmp, target, ctx, &ctx.span(0.05, 0.95), None)?;
            let mut files: Vec<PathBuf> = std::fs::read_dir(&tmp)?.flatten().map(|e| e.path()).filter(|p| ext_of(p) == target).collect();
            files.sort();
            if files.len() == 1 {
                let out = ctx.out(input, target, "");
                move_file(&files[0], &out)?;
                return Ok(vec![out]);
            }
            if files.len() > 1 {
                let dir = ctx.out_dir(input, None);
                for f in &files {
                    move_file(f, &dir.join(file_name(f)))?;
                }
                return Ok(vec![dir]);
            }
            Err(Fail::Raw("PowerPoint exported no slides".into()))
        })();
        match r {
            Ok(v) => return Ok(v),
            Err(e) if ctx.cancelled() || st.libreoffice.is_none() => return Err(e),
            Err(e) => crate::log::write(&format!("PowerPoint export failed, trying LibreOffice: {e}")),
        }
    }
    // LibreOffice: slides → PDF → Ghostscript images.
    let pdf_path = ctx.tmp().join("slides.pdf");
    via_office(input, &pdf_path, "pdf", ctx, &Route { app: None, ..route }, 0.05, 0.5)?;
    let n = pdf::page_sizes(&pdf_path, ctx)?.len();
    if n == 1 {
        let imgs = pdf::render(&pdf_path, &ctx.tmp(), target, ctx, &ctx.span(0.5, 0.95), 216, "Slide ", 1)?;
        let out = ctx.out(input, target, "");
        move_file(&imgs[0], &out)?;
        return Ok(vec![out]);
    }
    let dir = ctx.out_dir(input, None);
    remove_on_failure(&dir, || pdf::render(&pdf_path, &dir, target, ctx, &ctx.span(0.5, 0.98), 216, "Slide ", n))?;
    Ok(vec![dir])
}

// ------------------------------------------------------------------ spreadsheets

fn read_sheets(input: &Path, src: &str, ctx: &Ctx) -> R<Vec<Sheet>> {
    if src == "csv" || src == "tsv" {
        return Ok(vec![Sheet { name: stem_of(input), rows: sheets::read_delimited_file(input)? }]);
    }
    let mut xlsx = input.to_path_buf();
    if src != "xlsx" && src != "xlsm" {
        xlsx = ctx.tmp().join("book.xlsx");
        via_office(input, &xlsx, "xlsx", ctx, &Route::new((src != "numbers").then_some(OfficeApp::Excel), format!("Reading {} files", src.to_uppercase())), 0.05, 0.6)?;
    }
    sheets::read_xlsx(&xlsx)
}

fn write_sheets_as_text(input: &Path, list: Vec<Sheet>, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let d = if target == "csv" { ',' } else { '\t' };
    let non_empty: Vec<&Sheet> = list.iter().filter(|s| !s.rows.is_empty()).collect();
    let list: Vec<&Sheet> = if non_empty.is_empty() { list.iter().take(1).collect() } else { non_empty };
    if list.len() <= 1 {
        let out = ctx.out(input, target, "");
        let empty = vec![];
        std::fs::write(&out, sheets::write_delimited(list.first().map(|s| &s.rows).unwrap_or(&empty), d))?;
        return Ok(vec![out]);
    }
    let dir = ctx.out_dir(input, None);
    remove_on_failure(&dir, || {
        let mut used: Vec<String> = vec![];
        for s in &list {
            // Sheet names may hold characters file names can't; the " 2" suffix goes on the cleaned name.
            let base: String = s.name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '_' } else { c }).collect();
            let base = base.trim_end_matches(['.', ' ']).to_string();
            let base = if base.is_empty() { "Sheet".to_string() } else { base };
            let mut name = base.clone();
            let mut i = 2;
            while used.contains(&name.to_lowercase()) {
                name = format!("{base} {i}");
                i += 1;
            }
            used.push(name.to_lowercase());
            std::fs::write(dir.join(format!("{name}.{target}")), sheets::write_delimited(&s.rows, d))?;
        }
        Ok(())
    })?;
    Ok(vec![dir])
}

fn from_spreadsheet(input: &Path, src: &str, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let title = stem_of(input);
    let excel = Route::new((src != "numbers").then_some(OfficeApp::Excel), format!("Converting {} files", src.to_uppercase()));
    let native = src == "csv" || src == "tsv";
    match target {
        "csv" | "tsv" => {
            let s = read_sheets(input, src, ctx)?;
            ctx.progress(0.8);
            write_sheets_as_text(input, s, target, ctx)
        }
        "xlsx" => {
            let out = ctx.out(input, "xlsx", "");
            if native {
                let rows = sheets::read_delimited_file(input)?;
                ctx.progress(0.6);
                remove_on_failure(&out, || sheets::rows_to_xlsx(&[Sheet { name: title.clone(), rows }], &out))?;
                return Ok(vec![out]);
            }
            via_office(input, &out, "xlsx", ctx, &excel, 0.05, 0.95)?;
            Ok(vec![out])
        }
        "ods" | "pdf" => {
            let out = ctx.out(input, target, "");
            // CSV goes through a native XLSX first so delimiters and encodings are read correctly.
            let mut source = input.to_path_buf();
            if native {
                source = ctx.tmp().join(format!("{title}.xlsx"));
                sheets::rows_to_xlsx(&[Sheet { name: title.clone(), rows: sheets::read_delimited_file(input)? }], &source)?;
            }
            let route = if native { Route::new(Some(OfficeApp::Excel), excel.what.clone()) } else { excel };
            // CSV/TSV/XLSX can be handled without an office suite (values only), others can't.
            let own = native || src == "xlsx" || src == "xlsm";
            if !own || office_can(&route) {
                match via_office(&source, &out, target, ctx, &route, 0.1, 0.95) {
                    Ok(_) => return Ok(vec![out]),
                    Err(e) if !own || !is_unavailable(&e) => return Err(e),
                    Err(_) => {}
                }
            }
            let s = sheets::read_xlsx(&source)?;
            if target == "ods" {
                remove_on_failure(&out, || sheets::write_ods(&s, &out))?;
                return Ok(vec![out]);
            }
            // PDF without an office suite: print the sheets as tables.
            let html = ctx.tmp().join("sheet.html");
            std::fs::write(&html, sheets::sheets_to_html(&title, &s, READING_CSS))?;
            ctx.progress(0.5);
            let wide = s.iter().map(|x| x.rows.first().map(|r| r.len()).unwrap_or(0)).max().unwrap_or(0) > 8;
            html_to_pdf(&html, &out, wide, true, ctx)?;
            Ok(vec![out])
        }
        _ => user(format!("Can't convert {} to {}.", src.to_uppercase(), target.to_uppercase())),
    }
}

// ------------------------------------------------------------------ module

pub fn convert(input: &Path, target: &str, ctx: &Ctx) -> R<Vec<PathBuf>> {
    let src = norm(&ext_of(input)).to_string();
    ctx.progress(0.02);
    let r = match super::kind_of_ext(&src) {
        super::Kind::Pdf => from_pdf(input, target, ctx),
        super::Kind::Document => from_document(input, &src, target, ctx),
        super::Kind::Ebook => from_ebook(input, target, ctx),
        super::Kind::Slides => from_slides(input, &src, target, ctx),
        super::Kind::Spreadsheet => from_spreadsheet(input, &src, target, ctx),
        _ => user(format!("Can't convert {}.", file_name(input))),
    };
    let out = r.map_err(untag)?;
    ctx.progress(1.0);
    Ok(out)
}
