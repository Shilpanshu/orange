//! Shared fixtures and checks for the integration tests: the Rust port of 1.x's
//! `tests/fixtures.ts` and `tests/verify.ts`.
//!
//! Fixtures are generated with the standard library and the `image` crate only, so the suite runs
//! on a clean checkout without FFmpeg, 7-Zip or Office. Cases that need an engine look for it in
//! `vendor/bin` (see [`engine`]) and are `#[ignore]`d until their area is ported.
//!
//! ## Pending areas
//!
//! Cases written against an API another agent is still porting are wrapped in [`pending!`]. Until
//! that area lands they compile to an ignored stub (`#[ignore = "pending <area>"]`), so the suite
//! never fails on missing work. To run them once the API exists:
//!
//! ```text
//! set RUSTFLAGS=--cfg orange_converters --cfg orange_tools
//! cargo test -- --include-ignored
//! ```
//!
//! Planned APIs the pending cases call (adjust here if the port lands with other names):
//! - converters: `orange_lib::convert::{convert(input, target, &Ctx) -> R<Vec<PathBuf>>, Ctx::new,
//!   Ctx::out_override, friendly}` (the phase 2 port, already in the tree; [`convert`] wraps it.
//!   `--cfg orange_converters` only un-ignores the engine-backed cases)
//! - tools: `orange_lib::tools::run_tool(id, &inputs, &opts_json, out_dir) -> Result<Vec<PathBuf>, String>`
//!   and `orange_lib::tools::undo_last() -> Result<(), String>` (rename)
//! - settings: `orange_lib::settings::{from_json, write_atomic, Settings}`
//! - updater: `orange_lib::updater::is_newer(current, latest) -> bool`
#![allow(dead_code, unexpected_cfgs)]

use std::io::Write;
use std::path::{Path, PathBuf};

pub mod pdfread;
pub mod toolapp;

/// Declares a test for an area that is still being ported. With `--cfg orange_<area>` the body
/// runs; without it the test is an ignored stub that says what it waits for.
#[macro_export]
macro_rules! pending {
    (converters, $name:ident, $body:block) => {
        #[cfg(orange_converters)]
        #[test]
        fn $name() $body
        #[cfg(not(orange_converters))]
        #[test]
        #[ignore = "pending converters"]
        fn $name() {}
    };
    // The tools are real: they run in the app's tool windows through the test server
    // (common/toolapp.rs). `--cfg orange_tools` is no longer needed.
    (tools, $name:ident, $body:block) => {
        #[test]
        fn $name() $body
    };
    (settings, $name:ident, $body:block) => {
        #[cfg(orange_settings)]
        #[test]
        fn $name() $body
        #[cfg(not(orange_settings))]
        #[test]
        #[ignore = "pending settings"]
        fn $name() {}
    };
    (updater, $name:ident, $body:block) => {
        #[cfg(orange_updater)]
        #[test]
        fn $name() $body
        #[cfg(not(orange_updater))]
        #[test]
        #[ignore = "pending updater"]
        fn $name() {}
    };
    (actions, $name:ident, $body:block) => {
        #[cfg(orange_actions)]
        #[test]
        fn $name() $body
        #[cfg(not(orange_actions))]
        #[test]
        #[ignore = "pending actions"]
        fn $name() {}
    };
}

// ------------------------------------------------------------------------------------------------
// Case folders

/// A fresh folder for one case under the system temp dir (never the repo). Removed on drop unless
/// `ORANGE_TEST_KEEP=1`.
pub struct CaseDir(pub PathBuf);

impl CaseDir {
    pub fn new(name: &str) -> Self {
        let d = std::env::temp_dir().join("orange2-tests").join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        CaseDir(d)
    }
    pub fn join(&self, p: &str) -> PathBuf {
        self.0.join(p)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
    /// Every file in the folder (recursively), sorted.
    pub fn files(&self) -> Vec<PathBuf> {
        files_under(&self.0)
    }
}

impl Drop for CaseDir {
    fn drop(&mut self) {
        if std::env::var("ORANGE_TEST_KEEP").as_deref() != Ok("1") {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

pub fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// An engine binary (`ffmpeg`, `ffprobe`, `7z`, `gs/bin/gswin64c`, `imagemagick/magick`...): the
/// vendored copy (`ORANGE_BIN_DIR`, or `vendor/bin` in this checkout or one above it), else the
/// engine the app downloads on first use (into the engines folder; downloaded here too when
/// missing). `None` when it cannot be had (offline): the case then skips with a reason.
pub fn engine(name: &str) -> Option<PathBuf> {
    static DOWNLOADING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let file = format!("{name}.exe");
    let mut dirs: Vec<PathBuf> = std::env::var_os("ORANGE_BIN_DIR").map(PathBuf::from).into_iter().collect();
    dirs.extend(Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().map(|a| a.join("vendor").join("bin")));
    if let Some(p) = dirs.iter().map(|d| d.join(&file)).find(|p| p.is_file()) {
        return Some(p);
    }
    std::env::set_var("ORANGE_ENGINES_DIR", toolapp::engines_dir());
    let _g = DOWNLOADING.lock().unwrap_or_else(|p| p.into_inner());
    orange_lib::engines::ensure(name).ok().filter(|p| p.is_file())
}

/// Records why a case did nothing. libtest has no runtime skip, so the case returns (it shows as
/// passed); the reason is printed (`-- --nocapture`) and appended to `<temp>/orange2-tests/skips.txt`.
pub fn skip(reason: &str) {
    let name = std::thread::current().name().unwrap_or("?").to_string();
    eprintln!("SKIP {name}: {reason}");
    let dir = std::env::temp_dir().join("orange2-tests");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("skips.txt")) {
        let _ = writeln!(f, "{name}: {reason}");
    }
}

/// `need_engines!("ffmpeg", "7z")`: the case returns early (skipped, with the reason) when one is missing.
#[macro_export]
macro_rules! need_engines {
    ($($e:expr),+) => {
        $(if $crate::common::engine($e).is_none() {
            $crate::common::skip(&format!("{} is not available (offline and not downloaded)", $e));
            return;
        })+
    };
}

/// AI tools download models (hundreds of MB): only with `ORANGE_TEST_AI=1`.
#[macro_export]
macro_rules! need_ai {
    () => {
        if std::env::var("ORANGE_TEST_AI").as_deref() != Ok("1") {
            $crate::common::skip("downloads models; set ORANGE_TEST_AI=1 to run");
            return;
        }
    };
}

// ------------------------------------------------------------------------------------------------
// Fixtures (port of fixtures.ts, engine-free)

/// The text every document fixture carries, so conversions can be checked for it.
pub const TEXT_MARK: &str = "Orange regression";

/// A 640x480 colour test pattern (like FFmpeg's testsrc2).
pub fn png(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
    let p = dir.join(name);
    pattern(w, h).save(&p).unwrap();
    p
}

pub fn pattern(w: u32, h: u32) -> image::RgbaImage {
    image::RgbaImage::from_fn(w, h, |x, y| {
        let band = (x * 8 / w.max(1)) as u8;
        image::Rgba([band.wrapping_mul(36), (y * 255 / h.max(1)) as u8, ((x ^ y) & 0xff) as u8, 255])
    })
}

/// A PNG whose right half is fully transparent.
pub fn transparent_png(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    let img = image::RgbaImage::from_fn(64, 64, |x, _| if x < 32 { image::Rgba([200, 30, 30, 255]) } else { image::Rgba([0, 0, 0, 0]) });
    img.save(&p).unwrap();
    p
}

pub fn jpg(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
    let p = dir.join(name);
    image::DynamicImage::ImageRgba8(pattern(w, h)).to_rgb8().save(&p).unwrap();
    p
}

pub fn webp(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
    let p = dir.join(name);
    pattern(w, h).save(&p).unwrap();
    p
}

/// A 64x32 (landscape) JPEG with EXIF Orientation = 6 (rotate 90 CW to display): upright it is
/// 32x64.
pub fn exif_rotated_jpg(dir: &Path, name: &str) -> PathBuf {
    let mut plain = Vec::new();
    image::DynamicImage::ImageRgba8(pattern(64, 32)).to_rgb8().write_to(&mut std::io::Cursor::new(&mut plain), image::ImageFormat::Jpeg).unwrap();
    // APP1 "Exif\0\0" + little-endian TIFF with one IFD0 entry: Orientation (0x0112) SHORT 1 = 6.
    let mut tiff = vec![b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0];
    tiff.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0]);
    tiff.extend_from_slice(&[0, 0, 0, 0]);
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let len = (app1.len() + 2) as u16;
    let mut out = plain[..2].to_vec(); // SOI
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&plain[2..]);
    let p = dir.join(name);
    std::fs::write(&p, out).unwrap();
    p
}

/// 16-bit PCM WAV with a 440 Hz tone.
pub fn wav(dir: &Path, name: &str, secs: f64, rate: u32, channels: u16) -> PathBuf {
    let n = (secs * rate as f64) as usize;
    let mut data = Vec::with_capacity(n * channels as usize * 2);
    for i in 0..n {
        let s = ((i as f64 * 440.0 * std::f64::consts::TAU / rate as f64).sin() * 12000.0) as i16;
        for _ in 0..channels {
            data.extend_from_slice(&s.to_le_bytes());
        }
    }
    let mut f = Vec::new();
    f.extend_from_slice(b"RIFF");
    f.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    f.extend_from_slice(b"WAVEfmt ");
    f.extend_from_slice(&16u32.to_le_bytes());
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&channels.to_le_bytes());
    f.extend_from_slice(&rate.to_le_bytes());
    f.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    f.extend_from_slice(&(channels * 2).to_le_bytes());
    f.extend_from_slice(&16u16.to_le_bytes());
    f.extend_from_slice(b"data");
    f.extend_from_slice(&(data.len() as u32).to_le_bytes());
    f.extend_from_slice(&data);
    let p = dir.join(name);
    std::fs::write(&p, f).unwrap();
    p
}

/// A minimal valid PDF with `pages` pages, each saying "Page N" and the text mark.
pub fn pdf(dir: &Path, name: &str, pages: usize) -> PathBuf {
    let mut objs: Vec<String> = Vec::new();
    let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
    objs.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    objs.push(format!("<< /Type /Pages /Kids [{}] /Count {pages} >>", kids.join(" ")));
    objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into());
    for i in 0..pages {
        objs.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>",
            5 + i * 2
        ));
        let s = format!("BT /F1 24 Tf 72 760 Td (Page {}) Tj 0 -40 Td ({TEXT_MARK}) Tj ET", i + 1);
        objs.push(format!("<< /Length {} >>\nstream\n{s}\nendstream", s.len()));
    }
    // The document information is an indirect object, as the PDF spec (and every reader) wants.
    objs.push("<< /Title (Orange fixture) /Author (Orange Test) /Subject (Regression fixture) >>".into());
    let info = objs.len();
    let mut out = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objs.iter().enumerate() {
        offsets.push(out.len());
        write!(out, "{} 0 obj\n{o}\nendobj\n", i + 1).unwrap();
    }
    let xref = out.len();
    write!(out, "xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).unwrap();
    for off in offsets {
        write!(out, "{off:010} 00000 n \n").unwrap();
    }
    write!(out, "trailer\n<< /Size {} /Root 1 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n", objs.len() + 1).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, out).unwrap();
    p
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut c = !0u32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
    }
    !c
}

/// A stored (uncompressed) ZIP of `entries` (name, contents).
pub fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let off = out.len() as u32;
        let crc = crc32(data);
        let hdr = |sig: u32, central: bool| {
            let mut h = Vec::new();
            h.extend_from_slice(&sig.to_le_bytes());
            if central {
                h.extend_from_slice(&20u16.to_le_bytes());
            }
            h.extend_from_slice(&20u16.to_le_bytes()); // version needed
            h.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
            h.extend_from_slice(&0u16.to_le_bytes()); // stored
            h.extend_from_slice(&[0, 0, 0x21, 0]); // time, date
            h.extend_from_slice(&crc.to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(name.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes());
            if central {
                h.extend_from_slice(&[0; 6]); // comment len, disk, internal attrs
                h.extend_from_slice(&0u32.to_le_bytes());
                h.extend_from_slice(&off.to_le_bytes());
            }
            h.extend_from_slice(name.as_bytes());
            h
        };
        out.extend_from_slice(&hdr(0x0403_4b50, false));
        out.extend_from_slice(data);
        central.extend_from_slice(&hdr(0x0201_4b50, true));
    }
    let cd_off = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// The archive fixture of 1.x: a.txt and sub/b.txt.
pub fn zip(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, zip_bytes(&[("a.txt", b"Orange archive file A"), ("sub/b.txt", b"Orange archive file B")])).unwrap();
    p
}

/// A folder with a.txt, sub/b.txt and an image.
pub fn folder(dir: &Path, name: &str) -> PathBuf {
    let f = dir.join(name);
    std::fs::create_dir_all(f.join("sub")).unwrap();
    std::fs::write(f.join("a.txt"), "Orange archive file A").unwrap();
    std::fs::write(f.join("sub").join("b.txt"), "Orange archive file B").unwrap();
    png(&f, "pic.png", 32, 32);
    f
}

pub fn text_file(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    let body = match name.rsplit('.').next().unwrap_or("") {
        "md" => format!("---\ntitle: Orange fixture\n---\n\n# {TEXT_MARK}\n\nSome *Markdown* with a [link](https://example.com).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"),
        "html" => format!("<!doctype html><html><head><title>Orange</title></head><body><h1>{TEXT_MARK}</h1><p>Body text.</p></body></html>"),
        "csv" => "Fruit,Count,Price\nOrange,12,3.5\n\"Lime, Persian\",4,1.25\n".into(),
        "srt" => "1\n00:00:00,500 --> 00:00:02,000\nHello from Orange\n\n2\n00:00:02,500 --> 00:00:04,000\n<i>Second</i> line\n".into(),
        "vtt" => "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHello from Orange\n\n00:00:02.500 --> 00:00:04.000\nSecond line\n".into(),
        _ => format!("{TEXT_MARK}\nPlain text fixture.\n"),
    };
    std::fs::write(&p, body).unwrap();
    p
}

/// The fixture for a source key used by the conversion matrix.
pub fn fixture(dir: &Path, key: &str) -> PathBuf {
    match key {
        "png" => png(dir, "sample.png", 640, 480),
        "jpg" => jpg(dir, "photo.jpg", 640, 480),
        "webp" => webp(dir, "sample.webp", 640, 480),
        "bmp" | "tiff" | "gif" | "ico" => {
            let p = dir.join(format!("sample.{key}"));
            let img = image::DynamicImage::ImageRgba8(pattern(64, 48));
            // These codecs may not be compiled in; fall back to a PNG renamed (the converter must sniff).
            if img.save(&p).is_err() {
                img.save_with_format(&p, image::ImageFormat::Png).unwrap();
            }
            p
        }
        "wav" => wav(dir, "tone.wav", 3.0, 44100, 2),
        "pdf" => pdf(dir, "doc.pdf", 3),
        "zip" => zip(dir, "files.zip"),
        "folder" => folder(dir, "Folder"),
        k @ ("md" | "txt" | "html" | "csv" | "srt" | "vtt") => text_file(dir, &format!("sample.{k}")),
        k @ ("mp4" | "mov" | "mp3") => media_fixture(dir, k),
        other => panic!("no fixture for {other}"),
    }
}

// ------------------------------------------------------------------------------------------------
// Checks (port of verify.ts)

pub fn ext_lower(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn non_empty(p: &Path) -> Vec<u8> {
    let b = std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    assert!(!b.is_empty(), "{} is empty", p.display());
    b
}

/// What the bytes are, by their magic number.
pub fn sniff(b: &[u8]) -> &'static str {
    let at = |o: usize, m: &[u8]| b.len() >= o + m.len() && &b[o..o + m.len()] == m;
    if at(0, b"\x89PNG") {
        "png"
    } else if at(0, b"\xFF\xD8\xFF") {
        "jpg"
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        "webp"
    } else if at(0, b"RIFF") && at(8, b"WAVE") {
        "wav"
    } else if at(0, b"RIFF") && at(8, b"AVI ") {
        "avi"
    } else if at(0, b"BM") {
        "bmp"
    } else if at(0, b"GIF8") {
        "gif"
    } else if at(0, b"II*\0") || at(0, b"MM\0*") {
        "tiff"
    } else if at(0, b"%PDF") {
        "pdf"
    } else if at(0, b"PK\x03\x04") || at(0, b"PK\x05\x06") {
        "zip"
    } else if at(0, b"7z\xBC\xAF\x27\x1C") {
        "7z"
    } else if at(0, b"\x1F\x8B") {
        "gz"
    } else if at(257, b"ustar") {
        "tar"
    } else if at(0, b"fLaC") {
        "flac"
    } else if at(0, b"OggS") {
        "ogg"
    } else if at(0, b"FORM") && at(8, b"AIFF") {
        "aiff"
    } else if at(0, b"ID3") || (b.len() > 1 && b[0] == 0xFF && b[1] & 0xE0 == 0xE0) {
        "mp3"
    } else if at(0, b"\x1A\x45\xDF\xA3") {
        "mkv"
    } else if at(0, b"\x30\x26\xB2\x75") {
        "asf"
    } else if at(4, b"ftypheic") || at(4, b"ftypheix") || at(4, b"ftypmif1") {
        "heic"
    } else if at(4, b"ftypavif") {
        "avif"
    } else if at(4, b"ftypqt") {
        "mov"
    } else if at(4, b"ftyp") {
        "mp4"
    } else if at(0, b"{\\rtf") {
        "rtf"
    } else {
        "unknown"
    }
}

/// The container a target extension must sniff as.
pub fn expected_magic(target: &str) -> &'static str {
    match target {
        "jpg" | "jpeg" => "jpg",
        "tif" | "tiff" => "tiff",
        "docx" | "pptx" | "xlsx" | "odt" | "ods" | "epub" => "zip",
        "m4a" | "mp4" => "mp4",
        "wma" | "wmv" => "asf",
        "webm" | "mkv" => "mkv",
        "opus" | "ogg" => "ogg",
        "png" => "png",
        "webp" => "webp",
        "bmp" => "bmp",
        "gif" => "gif",
        "heic" => "heic",
        "avif" => "avif",
        "pdf" => "pdf",
        "zip" => "zip",
        "7z" => "7z",
        "gz" => "gz",
        "tar" => "tar",
        "wav" => "wav",
        "flac" => "flac",
        "aiff" => "aiff",
        "mp3" => "mp3",
        "mov" => "mov",
        "avi" => "avi",
        "rtf" => "rtf",
        _ => "text",
    }
}

/// The file decodes as an image of this format (and size, when given).
pub fn image_ok(p: &Path, fmt: &str, size: Option<(u32, u32)>) -> image::DynamicImage {
    let b = non_empty(p);
    assert_eq!(sniff(&b), expected_magic(fmt), "{} is not {fmt}", p.display());
    let img = image::load_from_memory(&b).unwrap_or_else(|e| panic!("{} does not decode: {e}", p.display()));
    if let Some((w, h)) = size {
        assert_eq!((img.width(), img.height()), (w, h), "{} has the wrong size", p.display());
    }
    img
}

/// Page count of a PDF (largest `/Count` in a `/Pages` node, or counted `/Type /Page` objects).
pub fn pdf_pages(p: &Path) -> usize {
    let b = non_empty(p);
    assert_eq!(sniff(&b), "pdf", "{} is not a PDF", p.display());
    // The page tree, also from compressed object streams (pdf-lib's default).
    let tree = pdfread::PdfDoc::parse(&b).pages().len();
    if tree > 0 {
        return tree;
    }
    let s = String::from_utf8_lossy(&b);
    let count = s
        .match_indices("/Count")
        .filter_map(|(i, _)| s[i + 6..].trim_start().split(|c: char| !c.is_ascii_digit()).next()?.parse::<usize>().ok())
        .max();
    count.unwrap_or_else(|| s.matches("/Type /Page").count() - s.matches("/Type /Pages").count())
}

/// Entry names in a ZIP's central directory.
pub fn zip_names(p: &Path) -> Vec<String> {
    let b = non_empty(p);
    let eocd = (0..b.len().saturating_sub(21)).rev().find(|&i| b[i..i + 4] == [0x50, 0x4b, 5, 6]).expect("no ZIP end record");
    let u16_at = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]) as usize;
    let u32_at = |o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as usize;
    let (n, mut off) = (u16_at(eocd + 10), u32_at(eocd + 16));
    let mut names = Vec::new();
    for _ in 0..n {
        assert_eq!(&b[off..off + 4], &[0x50, 0x4b, 1, 2], "bad ZIP central directory");
        let (nl, xl, cl) = (u16_at(off + 28), u16_at(off + 30), u16_at(off + 32));
        names.push(String::from_utf8_lossy(&b[off + 46..off + 46 + nl]).replace('\\', "/"));
        off += 46 + nl + xl + cl;
    }
    names
}

/// (channels, sample rate, seconds) of a PCM WAV.
pub fn wav_info(p: &Path) -> (u16, u32, f64) {
    let b = non_empty(p);
    assert_eq!(sniff(&b), "wav");
    let ch = u16::from_le_bytes([b[22], b[23]]);
    let rate = u32::from_le_bytes([b[24], b[25], b[26], b[27]]);
    let bpa = u16::from_le_bytes([b[32], b[33]]) as f64;
    let data = b.windows(4).position(|w| w == b"data").expect("no data chunk");
    let len = u32::from_le_bytes([b[data + 4], b[data + 5], b[data + 6], b[data + 7]]) as f64;
    (ch, rate, len / bpa / rate as f64)
}

/// The text file contains every needle.
pub fn text_has(p: &Path, needles: &[&str]) -> String {
    let s = String::from_utf8_lossy(&non_empty(p)).into_owned();
    for n in needles {
        assert!(s.contains(n), "{} lacks {n:?}", p.display());
    }
    s
}

/// The generic check every conversion gets: one or more outputs, the right extension and
/// container, and per-kind content checks where they need no engine.
pub fn verify_conversion(src_key: &str, target: &str, outs: &[PathBuf]) {
    assert!(!outs.is_empty(), "{src_key} -> {target}: no outputs");
    let files: Vec<PathBuf> = outs.iter().flat_map(|o| if o.is_dir() { files_under(o) } else { vec![o.clone()] }).collect();
    if target == "extract" {
        let names: Vec<String> = files.iter().map(|f| f.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&"a.txt".to_string()) && names.contains(&"b.txt".to_string()), "extracted: {names:?}");
        return;
    }
    let main: Vec<&PathBuf> = files.iter().filter(|f| ext_lower(f) == target).collect();
    assert!(!main.is_empty(), "{src_key} -> {target}: no .{target} among {files:?}");
    for f in &main {
        let b = non_empty(f);
        let want = expected_magic(target);
        if want != "text" {
            assert_eq!(sniff(&b), want, "{} does not look like .{target}", f.display());
        }
    }
    match target {
        "jpg" | "png" | "webp" | "bmp" | "tiff" | "gif" if src_key != "pdf" => {
            image_ok(main[0], target, None);
        }
        "jpg" | "png" if src_key == "pdf" => assert_eq!(main.len(), 3, "one image per page"),
        "pdf" if src_key == "pdf" => assert_eq!(pdf_pages(main[0]), 3),
        "pdf" => assert!(pdf_pages(main[0]) >= 1),
        "zip" if src_key == "folder" => {
            let names = zip_names(main[0]);
            assert!(names.iter().any(|n| n.ends_with("a.txt")) && names.iter().any(|n| n.ends_with("sub/b.txt")), "{names:?}");
        }
        "docx" => assert!(zip_names(main[0]).iter().any(|n| n == "word/document.xml")),
        "xlsx" => assert!(zip_names(main[0]).iter().any(|n| n == "xl/workbook.xml")),
        "pptx" => assert!(zip_names(main[0]).iter().any(|n| n == "ppt/presentation.xml")),
        "epub" => assert!(zip_names(main[0]).iter().any(|n| n == "META-INF/container.xml")),
        "html" => {
            text_has(main[0], &["<html"]);
        }
        "csv" => {
            text_has(main[0], &["Orange,12,3.5", "\"Lime, Persian\""]);
        }
        "tsv" => {
            text_has(main[0], &["Orange\t12\t3.5"]);
        }
        "srt" | "vtt" => {
            text_has(main[0], &["Hello from Orange", "-->"]);
        }
        "txt" if matches!(src_key, "srt" | "vtt") => {
            let s = text_has(main[0], &["Hello from Orange"]);
            assert!(!s.contains("-->") && !s.contains("<i>"), "TXT still has timings or tags");
        }
        "wav" => assert!(wav_info(main[0]).2 > 2.5),
        _ => {}
    }
}

/// Converts `input` to `target`, results in `out_dir`. `Err` is the message the HUD would show.
pub fn convert(input: &Path, target: &str, out_dir: &Path) -> Result<Vec<PathBuf>, String> {
    convert_watch(input, target, out_dir, None).0
}

/// [`convert`] that also records progress, and sets the cancel flag once progress passes
/// `cancel_after`.
pub fn convert_watch(input: &Path, target: &str, out_dir: &Path, cancel_after: Option<f64>) -> (Result<Vec<PathBuf>, String>, Vec<f64>) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    let seen = Arc::new(Mutex::new(Vec::new()));
    let cancel = Arc::new(AtomicBool::new(false));
    let (s, c) = (seen.clone(), cancel.clone());
    let report = move |f: f64| {
        s.lock().unwrap().push(f);
        if cancel_after.is_some_and(|a| f > a) {
            c.store(true, Ordering::SeqCst);
        }
    };
    let r = {
        // Phase 2 converters: convert::convert(input, target, &Ctx).
        use orange_lib::convert as cv;
        let mut ctx = cv::Ctx::new(move |f, _| report(f), cancel.clone());
        ctx.out_override = Some(out_dir.to_path_buf());
        cv::convert(input, target, &ctx).map_err(|f| cv::friendly(&f))
    };
    let seen = seen.lock().unwrap().clone();
    (r, seen)
}

/// Builds the fixture, converts it and verifies the result.
#[cfg(orange_converters)]
pub fn check_conversion(src_key: &str, target: &str) {
    let d = CaseDir::new(&format!("conv-{src_key}-{target}"));
    let input = fixture(d.path(), src_key);
    let outs = convert(&input, target, d.path()).unwrap_or_else(|e| panic!("{src_key} -> {target}: {e}"));
    verify_conversion(src_key, target, &outs);
}

// ------------------------------------------------------------------------------------------------
// Media (engine-backed: FFmpeg / ffprobe from vendor/bin)

/// Runs vendored FFmpeg (`-y -loglevel error` prepended). Panics when it is missing.
pub fn ffmpeg(args: &[&str]) {
    let exe = engine("ffmpeg").expect("ffmpeg is missing");
    let st = std::process::Command::new(exe).args(["-hide_banner", "-loglevel", "error", "-y"]).args(args).status().unwrap();
    assert!(st.success(), "ffmpeg {args:?} failed");
}

/// Media fixtures (1.x made them with FFmpeg's lavfi sources).
pub fn media_fixture(dir: &Path, key: &str) -> PathBuf {
    let (name, args): (&str, Vec<&str>) = match key {
        "mp4" | "mp4b" | "mov" => (
            match key { "mp4" => "clip.mp4", "mp4b" => "clip b.mp4", _ => "clip.mov" },
            vec!["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
                 "-t", if key == "mp4b" { "2" } else { "3" }, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"],
        ),
        "mp3" | "mp3b" => (
            if key == "mp3" { "tone.mp3" } else { "tone b.mp3" },
            vec!["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100", "-t", if key == "mp3" { "3" } else { "2" }, "-c:a", "libmp3lame"],
        ),
        "silence" => ("silence.wav", vec!["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "2"]),
        other => panic!("no media fixture {other}"),
    };
    let p = dir.join(name);
    let mut a = args;
    let ps = p.to_string_lossy().into_owned();
    a.push(&ps);
    ffmpeg(&a);
    p
}

#[derive(Debug, Default)]
pub struct Probe {
    pub duration: f64,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub width: u64,
    pub height: u64,
    pub channels: u64,
    pub sample_rate: u64,
    /// The container's `title` tag.
    pub title: Option<String>,
    pub subtitle_tracks: usize,
}

/// ffprobe's view of a media file.
pub fn probe(p: &Path) -> Probe {
    let exe = engine("ffprobe").expect("ffprobe is missing");
    let out = std::process::Command::new(exe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(p)
        .output()
        .unwrap();
    assert!(out.status.success(), "ffprobe failed on {}", p.display());
    let j: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let mut r = Probe {
        duration: j["format"]["duration"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0),
        title: j["format"]["tags"].as_object().and_then(|t| t.iter().find(|(k, _)| k.eq_ignore_ascii_case("title")).and_then(|(_, v)| v.as_str().map(String::from))),
        ..Default::default()
    };
    for s in j["streams"].as_array().into_iter().flatten() {
        let codec = s["codec_name"].as_str().map(String::from);
        match s["codec_type"].as_str() {
            Some("video") if r.vcodec.is_none() => {
                r.vcodec = codec;
                r.width = s["width"].as_u64().unwrap_or(0);
                r.height = s["height"].as_u64().unwrap_or(0);
            }
            Some("subtitle") => r.subtitle_tracks += 1,
            Some("audio") if r.acodec.is_none() => {
                r.acodec = codec;
                r.channels = s["channels"].as_u64().unwrap_or(0);
                r.sample_rate = s["sample_rate"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0);
            }
            _ => {}
        }
    }
    r
}

/// Port of verify.media: codecs, duration (with tolerance) and size.
pub fn media(p: &Path, v: Option<&str>, a: Option<&str>, duration: Option<f64>, size: Option<(u64, u64)>) -> Probe {
    let r = probe(p);
    if let Some(v) = v {
        assert_eq!(r.vcodec.as_deref(), Some(v), "{}: video codec", p.display());
    }
    if let Some(a) = a {
        assert_eq!(r.acodec.as_deref(), Some(a), "{}: audio codec", p.display());
    }
    if let Some(d) = duration {
        assert!((r.duration - d).abs() <= 0.3_f64.max(d * 0.1), "{}: {} s, expected {d} s", p.display(), r.duration);
    }
    if let Some((w, h)) = size {
        assert_eq!((r.width, r.height), (w, h), "{}: frame size", p.display());
    }
    r
}

pub fn one(outs: Vec<PathBuf>) -> PathBuf {
    assert_eq!(outs.len(), 1, "expected one output, got {outs:?}");
    outs.into_iter().next().unwrap()
}

pub fn size_of(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}


// ------------------------------------------------------------------------------------------------
// Tool-test fixtures and checks

/// A JPEG at quality 95 with EXIF (Orientation 1, Artist), so Compress and Strip have something to drop.
pub fn jpg_exif(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
    let rgb = image::DynamicImage::ImageRgba8(pattern(w, h)).to_rgb8();
    let mut plain = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut plain, 95).encode(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8).unwrap();
    // TIFF (little endian): IFD0 with Orientation (SHORT 1) and Artist (ASCII, at offset 38).
    let mut tiff = vec![b'I', b'I', 42, 0, 8, 0, 0, 0, 2, 0];
    tiff.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    tiff.extend_from_slice(&[0x3B, 0x01, 2, 0, 12, 0, 0, 0, 38, 0, 0, 0]);
    tiff.extend_from_slice(&[0, 0, 0, 0]);
    tiff.extend_from_slice(b"Orange Test\0");
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let mut out = plain[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&plain[2..]);
    let p = dir.join(name);
    std::fs::write(&p, out).unwrap();
    p
}

/// A PNG with a little noise, so it does not compress to nothing (like a photo).
pub fn photo_png(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
    let mut s = 0x1234_5678u32;
    let base = pattern(w, h);
    let img = image::RgbaImage::from_fn(w, h, |x, y| {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let n = ((s >> 24) % 25) as i32 - 12;
        let p = base.get_pixel(x, y);
        image::Rgba([(p[0] as i32 + n).clamp(0, 255) as u8, (p[1] as i32 + n).clamp(0, 255) as u8, (p[2] as i32 - n).clamp(0, 255) as u8, 255])
    });
    let p = dir.join(name);
    img.save(&p).unwrap();
    p
}

/// A one-page PDF around a large noisy JPEG on a small page: Compress (Ghostscript "ebook",
/// 150 dpi) has something to shrink.
pub fn pdf_photo(dir: &Path, name: &str) -> PathBuf {
    let (w, h) = (1600u32, 1200u32);
    let mut s = 0x9e37_79b9u32;
    let base = pattern(w, h);
    let rgb = image::RgbImage::from_fn(w, h, |x, y| {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let n = ((s >> 24) % 41) as i32 - 20;
        let p = base.get_pixel(x, y);
        image::Rgb([(p[0] as i32 + n).clamp(0, 255) as u8, (p[1] as i32 + n).clamp(0, 255) as u8, (p[2] as i32 - n).clamp(0, 255) as u8])
    });
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 92).encode(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8).unwrap();
    let content = "q 400 0 0 300 72 400 cm /Im0 Do Q";
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![];
    let mut obj = |out: &mut Vec<u8>, n: usize, body: &[u8]| {
        offsets.push(out.len());
        write!(out, "{n} 0 obj\n").unwrap();
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };
    obj(&mut out, 1, b"<< /Type /Catalog /Pages 2 0 R >>");
    obj(&mut out, 2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(&mut out, 3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>");
    obj(&mut out, 4, format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()).as_bytes());
    let mut img = format!("<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n", jpeg.len()).into_bytes();
    img.extend_from_slice(&jpeg);
    img.extend_from_slice(b"\nendstream");
    obj(&mut out, 5, &img);
    let xref = out.len();
    write!(out, "xref\n0 6\n0000000000 65535 f \n").unwrap();
    for off in offsets {
        write!(out, "{off:010} 00000 n \n").unwrap();
    }
    write!(out, "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").unwrap();
    let p = dir.join(name);
    std::fs::write(&p, out).unwrap();
    p
}

/// A scan-like image of text for OCR, drawn by ImageMagick; `None` when it can't be had.
pub fn text_scan(dir: &Path, name: &str) -> Option<PathBuf> {
    let magick = engine("imagemagick/magick")?;
    let p = dir.join(name);
    for font in [Some("Arial"), None] {
        let mut c = std::process::Command::new(&magick);
        c.env("MAGICK_HOME", magick.parent()?).args(["-size", "1400x360", "xc:white"]);
        if let Some(f) = font {
            c.args(["-font", f]);
        }
        c.args(["-pointsize", "96", "-fill", "black", "-annotate", "+60+150", "ORANGE TEST", "-annotate", "+60+290", "Hello World 2026"]).arg(&p);
        if c.status().map(|s| s.success()).unwrap_or(false) && p.exists() {
            return Some(p);
        }
    }
    None
}

/// Speech from Windows' own synthesiser (a WAV), for the speech-to-text case; `None` when unavailable.
pub fn speech_wav(dir: &Path, name: &str, text: &str) -> Option<PathBuf> {
    let p = dir.join(name);
    let script = format!(
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('{}'); $s.Speak('{}'); $s.Dispose()",
        p.display(),
        text.replace('\'', "''")
    );
    let ok = std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).stdin(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    (ok && p.exists()).then_some(p)
}

/// `7z t` on an archive, with a password or none (a prompt is refused, so an encrypted archive fails).
pub fn seven_zip_test(p: &Path, password: Option<&str>) -> bool {
    let Some(sz) = engine("7z") else { panic!("7z is missing") };
    std::process::Command::new(sz)
        .args(["t", "-bd"])
        .arg(format!("-p{}", password.unwrap_or("")))
        .arg(p)
        .stdin(std::process::Stdio::null())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The archive passes `7z t` (with the password, if any).
pub fn archive_ok(p: &Path, password: Option<&str>) {
    assert!(seven_zip_test(p, password), "{} fails `7z t`", p.display());
}

/// `/Rotate` of each page, in order (0 when unset).
pub fn pdf_rotations(p: &Path) -> Vec<i64> {
    pdfread::PdfDoc::parse(&non_empty(p)).pages().into_iter().map(|(_, r)| r).collect()
}
