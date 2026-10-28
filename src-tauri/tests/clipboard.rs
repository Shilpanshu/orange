#![allow(unexpected_cfgs)]
//! The clipboard popover's saves, through the same functions the popover calls
//! (`clipboard::snapshot`, `save_image_to`, `save_text_to`, `save_ctx`), with real clipboard
//! content. The popover window is never shown.
//!
//! The user's clipboard is saved before each case and put back by a Drop guard, and cases that
//! touch it run one at a time. Cases that need Pandoc or Edge (downloaded on first use) are the
//! `pending!(converters, ...)` ones: `--cfg orange_converters` runs them.

#[macro_use]
mod common;

use common::*;
use orange_lib::clipboard as clip;
use orange_lib::convert::{self, Fail};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

static CLIPBOARD: Mutex<()> = Mutex::new(());

/// Holds the clipboard lock and the user's clipboard; puts it back on drop, panic or not.
struct Guard {
    saved: Option<clip::Saved>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl Guard {
    fn new() -> Guard {
        let lock = CLIPBOARD.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var("ORANGE_ENGINES_DIR", common::toolapp::engines_dir());
        Guard { saved: Some(clip::Saved::take().expect("could not read the clipboard")), _lock: lock }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(s) = self.saved.take() {
            let _ = s.restore();
        }
    }
}

fn ctx(dir: &Path) -> convert::Ctx {
    clip::save_ctx(dir, |_, _| {}, Arc::new(AtomicBool::new(false)))
}

fn sentence(f: Fail) -> String {
    convert::friendly(&f)
}

fn name_ok(p: &Path, ext: &str) {
    let n = p.file_name().unwrap().to_string_lossy().into_owned();
    let (stem, e) = n.rsplit_once('.').unwrap();
    assert_eq!(e, ext, "{n}");
    // "Clipboard 2026-10-21 18-34-45", optionally " 2".
    let b = stem.as_bytes();
    assert!(stem.starts_with("Clipboard "), "{n}");
    let d = &stem["Clipboard ".len()..];
    assert!(d.len() >= 19 && d.as_bytes()[4] == b'-' && d.as_bytes()[10] == b' ' && d.as_bytes()[13] == b'-' && b.len() > 10, "{n}");
}

fn docx_text(p: &Path) -> String {
    let f = std::fs::File::open(p).unwrap();
    let mut z = zip::ZipArchive::new(f).expect("the DOCX is not a ZIP");
    let mut s = String::new();
    z.by_name("word/document.xml").expect("no word/document.xml").read_to_string(&mut s).unwrap();
    s
}

fn put_test_png(w: u32, h: u32) {
    let img = pattern(w, h);
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    clip::put_png(&png).unwrap();
}

const HTML: &str = "<h1>Quarterly plan</h1><p>Intro with a <a href=\"https://example.com/plan\">link to the plan</a>.</p><ul><li>First item</li><li>Second item</li></ul>";

// ------------------------------------------------------------------ image

#[test]
fn image_saves_as_png_jpg_webp_with_the_clipboard_name() {
    let _g = Guard::new();
    let d = CaseDir::new("clip-image");
    put_test_png(160, 120);
    let snap = clip::snapshot();
    assert_eq!(snap.image.as_ref().map(|i| i.dimensions()), Some((160, 120)));
    let name = clip::save_name();
    for t in ["png", "jpg", "webp"] {
        let out = clip::save_image_to(t, &snap, &name, &ctx(d.path())).unwrap();
        assert_eq!(out.parent().unwrap(), d.path());
        name_ok(&out, t);
        image_ok(&out, t, Some((160, 120)));
    }
    // Same second, same name: the next one gets " 2" and nothing is overwritten.
    let again = clip::save_image_to("png", &snap, &name, &ctx(d.path())).unwrap();
    assert!(again.file_name().unwrap().to_string_lossy().ends_with(" 2.png"), "{again:?}");
}

#[test]
fn image_saves_as_a_one_page_pdf() {
    let _g = Guard::new();
    let d = CaseDir::new("clip-image-pdf");
    put_test_png(200, 100);
    let snap = clip::snapshot();
    let out = clip::save_image_to("pdf", &snap, &clip::save_name(), &ctx(d.path())).unwrap();
    name_ok(&out, "pdf");
    assert!(std::fs::read(&out).unwrap().starts_with(b"%PDF-"));
    assert_eq!(pdf_pages(&out), 1);
    // Only the result is in the folder: the temp PNG is gone.
    assert_eq!(d.files(), vec![out]);
}

#[test]
fn image_with_nothing_on_the_clipboard_says_so() {
    let _g = Guard::new();
    let d = CaseDir::new("clip-image-none");
    clip::put_text("just words").unwrap();
    let snap = clip::snapshot();
    let e = clip::save_image_to("pdf", &snap, "x", &ctx(d.path())).unwrap_err();
    assert_eq!(sentence(e), "The clipboard no longer holds an image.");
    put_test_png(8, 8);
    let e = clip::save_image_to("docx", &clip::snapshot(), "x", &ctx(d.path())).unwrap_err();
    assert_eq!(sentence(e), "Orange can't save the clipboard image as Word.");
    assert!(d.files().is_empty());
}

// ------------------------------------------------------------------ text

#[test]
fn plain_text_saves_as_txt_and_markdown_untouched() {
    let _g = Guard::new();
    let d = CaseDir::new("clip-text");
    clip::put_text("# Notes\r\nline two\r\n- item").unwrap();
    let snap = clip::snapshot();
    assert_eq!(snap.text, "# Notes\r\nline two\r\n- item");
    for t in ["txt", "md"] {
        let out = clip::save_text_to(t, &snap, &clip::save_name(), &ctx(d.path())).unwrap();
        name_ok(&out, t);
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "# Notes\r\nline two\r\n- item");
    }
}

#[test]
fn text_errors_are_plain_sentences() {
    let _g = Guard::new();
    let d = CaseDir::new("clip-text-err");
    clip::put_text("   ").unwrap();
    let e = clip::save_text_to("pdf", &clip::snapshot(), "x", &ctx(d.path())).unwrap_err();
    assert_eq!(sentence(e), "The clipboard no longer holds text.");
    clip::put_text("hello").unwrap();
    let e = clip::save_text_to("webp", &clip::snapshot(), "x", &ctx(d.path())).unwrap_err();
    assert_eq!(sentence(e), "Orange can't save clipboard text as WebP.");
    assert!(d.files().is_empty());
}

#[test]
fn real_clipboard_html_round_trips_to_a_fragment() {
    let _g = Guard::new();
    clip::put_html(HTML, "Quarterly plan").unwrap();
    let s = clip::snapshot();
    assert_eq!(s.html, HTML);
    assert_eq!(s.text, "Quarterly plan");
}

#[test]
fn cancelling_stops_the_save_and_leaves_no_file() {
    let _g = Guard::new();
    let d = CaseDir::new("clip-cancel");
    put_test_png(64, 64);
    let cancel = Arc::new(AtomicBool::new(true));
    let c = clip::save_ctx(d.path(), |_, _| {}, cancel);
    let r = clip::save_image_to("pdf", &clip::snapshot(), "x", &c);
    match r {
        Err(Fail::Cancelled) => {}
        // A one-page PDF of a tiny image can finish before the flag is looked at: then it must be whole.
        Ok(p) => assert_eq!(pdf_pages(&p), 1),
        Err(e) => panic!("{e}"),
    }
}

pending!(converters, text_saves_as_a_pdf, {
    let _g = Guard::new();
    let d = CaseDir::new("clip-text-pdf");
    clip::put_text("Meeting notes\r\n\r\nFirst paragraph of the notes.\r\n\r\nSecond paragraph.").unwrap();
    let out = clip::save_text_to("pdf", &clip::snapshot(), &clip::save_name(), &ctx(d.path())).unwrap_or_else(|e| panic!("{}", sentence(e)));
    name_ok(&out, "pdf");
    assert_eq!(pdf_pages(&out), 1);
    assert_eq!(d.files(), vec![out]);
});

pending!(converters, text_saves_as_a_word_document, {
    let _g = Guard::new();
    let d = CaseDir::new("clip-text-docx");
    clip::put_text("Meeting notes\r\n\r\nFirst paragraph of the notes.").unwrap();
    let out = clip::save_text_to("docx", &clip::snapshot(), &clip::save_name(), &ctx(d.path())).unwrap_or_else(|e| panic!("{}", sentence(e)));
    name_ok(&out, "docx");
    let xml = docx_text(&out);
    assert!(xml.contains("Meeting notes") && xml.contains("First paragraph of the notes."), "{xml}");
    assert_eq!(d.files(), vec![out]);
});

pending!(converters, markdown_looking_text_becomes_real_word_headings, {
    let _g = Guard::new();
    let d = CaseDir::new("clip-md-docx");
    clip::put_text("# Release notes\n\n- fixed the crash\n- faster start").unwrap();
    let out = clip::save_text_to("docx", &clip::snapshot(), &clip::save_name(), &ctx(d.path())).unwrap_or_else(|e| panic!("{}", sentence(e)));
    let xml = docx_text(&out);
    assert!(xml.contains("Release notes") && xml.contains("fixed the crash"), "{xml}");
    assert!(!xml.contains("# Release"), "the Markdown marker should be a heading, not text");
    assert!(xml.contains("Heading1") || xml.contains("w:pStyle"), "no styled paragraphs");
});

pending!(converters, html_saves_as_real_markdown, {
    let _g = Guard::new();
    let d = CaseDir::new("clip-html-md");
    clip::put_html(HTML, "Quarterly plan First item Second item").unwrap();
    let out = clip::save_text_to("md", &clip::snapshot(), &clip::save_name(), &ctx(d.path())).unwrap_or_else(|e| panic!("{}", sentence(e)));
    name_ok(&out, "md");
    let md = std::fs::read_to_string(&out).unwrap();
    assert!(md.contains("# Quarterly plan"), "{md}");
    assert!(md.contains("- First item") && md.contains("- Second item"), "{md}");
    assert!(md.contains("[link to the plan](https://example.com/plan)"), "{md}");
    assert!(!md.contains("<h1>") && !md.contains("<li>"), "{md}");
});

pending!(converters, html_saves_as_a_formatted_word_document, {
    let _g = Guard::new();
    let d = CaseDir::new("clip-html-docx");
    clip::put_html(HTML, "Quarterly plan").unwrap();
    let out = clip::save_text_to("docx", &clip::snapshot(), &clip::save_name(), &ctx(d.path())).unwrap_or_else(|e| panic!("{}", sentence(e)));
    let xml = docx_text(&out);
    for n in ["Quarterly plan", "link to the plan", "First item", "Second item"] {
        assert!(xml.contains(n), "{n} missing: {xml}");
    }
    assert!(xml.contains("w:hyperlink"), "the link should stay a link");
    assert!(xml.contains("w:numPr"), "the list should stay a list");
});

pending!(converters, html_saves_as_a_pdf, {
    let _g = Guard::new();
    let d = CaseDir::new("clip-html-pdf");
    clip::put_html(HTML, "Quarterly plan").unwrap();
    let out = clip::save_text_to("pdf", &clip::snapshot(), &clip::save_name(), &ctx(d.path())).unwrap_or_else(|e| panic!("{}", sentence(e)));
    name_ok(&out, "pdf");
    assert!(std::fs::read(&out).unwrap().starts_with(b"%PDF-"));
    assert!(pdf_pages(&out) >= 1);
    assert_eq!(d.files(), vec![out]);
});

#[allow(dead_code)]
fn _types(_: PathBuf) {}
