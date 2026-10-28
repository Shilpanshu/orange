//! In-process image conversion through `convert::convert` and output naming (" 2", " 3"): the
//! parts of 1.x's image matrix and "edge:" cases that phase 1 already ships.

#[macro_use]
mod common;

use common::*;
use std::path::Path;

fn run(input: &Path, target: &str) -> Result<std::path::PathBuf, String> {
    convert(input, target, input.parent().unwrap()).map(one)
}

#[test]
fn fixtures_are_valid() {
    let d = CaseDir::new("fixtures");
    image_ok(&png(d.path(), "a.png", 640, 480), "png", Some((640, 480)));
    image_ok(&jpg(d.path(), "a.jpg", 640, 480), "jpg", Some((640, 480)));
    image_ok(&webp(d.path(), "a.webp", 64, 48), "webp", Some((64, 48)));
    assert_eq!(pdf_pages(&pdf(d.path(), "a.pdf", 3)), 3);
    let z = zip(d.path(), "a.zip");
    assert_eq!(zip_names(&z), ["a.txt", "sub/b.txt"]);
    let (ch, rate, secs) = wav_info(&wav(d.path(), "a.wav", 3.0, 44100, 2));
    assert_eq!((ch, rate), (2, 44100));
    assert!((secs - 3.0).abs() < 0.01);
    assert_eq!(sniff(&std::fs::read(exif_rotated_jpg(d.path(), "r.jpg")).unwrap()), "jpg");
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
}

// The image matrix (1.x: "image png → X", "image jpg → X"), for the in-process targets.
macro_rules! image_case {
    ($($name:ident: $src:literal => $target:literal),* $(,)?) => {$(
        #[test]
        fn $name() {
            let d = CaseDir::new(stringify!($name));
            let input = fixture(d.path(), $src);
            let out = run(&input, $target).unwrap();
            assert_eq!(ext_lower(&out), $target);
            image_ok(&out, $target, Some((640, 480)));
            // Only the input and the output are left: no temporary `.part` file.
            assert_eq!(d.files().len(), 2, "{:?}", d.files());
        }
    )*};
}

image_case! {
    image_png_to_jpg: "png" => "jpg",
    image_png_to_webp: "png" => "webp",
    image_jpg_to_png: "jpg" => "png",
    image_jpg_to_webp: "jpg" => "webp",
    image_webp_to_jpg: "webp" => "jpg",
    image_webp_to_png: "webp" => "png",
}

#[test]
fn jpg_keeps_the_picture() {
    let d = CaseDir::new("jpg-fidelity");
    let input = png(d.path(), "p.png", 64, 48);
    let out = run(&input, "jpg").unwrap();
    let (a, b) = (image::open(&input).unwrap().to_rgb8(), image::open(&out).unwrap().to_rgb8());
    let diff: u64 = a.pixels().zip(b.pixels()).map(|(x, y)| x.0.iter().zip(y.0).map(|(p, q)| (*p as i32 - q as i32).unsigned_abs() as u64).sum::<u64>()).sum();
    let mean = diff as f64 / (64.0 * 48.0 * 3.0);
    assert!(mean < 12.0, "mean error {mean}");
}

#[test]
fn edge_transparent_png_to_jpg_is_flattened_on_white() {
    let d = CaseDir::new("flatten");
    let out = run(&transparent_png(d.path(), "t.png"), "jpg").unwrap();
    let img = image_ok(&out, "jpg", Some((64, 64))).to_rgb8();
    assert!(img.get_pixel(60, 30).0.iter().all(|&c| c > 240), "transparent half is not white: {:?}", img.get_pixel(60, 30));
    let red = img.get_pixel(5, 30).0;
    assert!(red[0] > 170 && red[1] < 70, "opaque half lost its colour: {red:?}");
}

#[test]
fn edge_webp_keeps_alpha() {
    let d = CaseDir::new("webp-alpha");
    let out = run(&transparent_png(d.path(), "t.png"), "webp").unwrap();
    let img = image::open(&out).unwrap().to_rgba8();
    assert_eq!(img.get_pixel(60, 30).0[3], 0);
    assert_eq!(img.get_pixel(5, 30).0[3], 255);
}

#[test]
fn edge_converting_twice_never_overwrites() {
    let d = CaseDir::new("twice");
    let input = png(d.path(), "photo.png", 32, 32);
    let a = run(&input, "jpg").unwrap();
    let b = run(&input, "jpg").unwrap();
    let c = run(&input, "jpg").unwrap();
    let names: Vec<_> = [&a, &b, &c].iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["photo.jpg", "photo 2.jpg", "photo 3.jpg"]);
    for p in [a, b, c] {
        image_ok(&p, "jpg", Some((32, 32)));
    }
}

#[test]
fn damaged_input_fails_clearly_and_leaves_nothing() {
    let d = CaseDir::new("damaged");
    let bad = d.join("broken.png");
    let mut b = std::fs::read(png(d.path(), "ok.png", 64, 64)).unwrap();
    b.truncate(60);
    std::fs::write(&bad, b).unwrap();
    let err = run(&bad, "jpg").unwrap_err();
    assert!(!err.trim().is_empty());
    assert!(!d.join("broken.jpg").exists());
    assert_eq!(d.files().len(), 2, "{:?}", d.files());
}

#[test]
fn not_an_image_fails_clearly() {
    let d = CaseDir::new("not-image");
    let p = d.join("notes.png");
    std::fs::write(&p, "hello").unwrap();
    assert!(run(&p, "jpg").is_err());
    assert_eq!(d.files().len(), 1);
}

#[test]
fn missing_input_is_an_error() {
    let d = CaseDir::new("missing");
    assert!(convert(&d.join("nope.png"), "jpg", d.path()).is_err());
    assert!(d.files().is_empty());
}

#[test]
fn unknown_target_is_refused_without_leftovers() {
    let d = CaseDir::new("unknown-target");
    let input = png(d.path(), "a.png", 16, 16);
    assert!(convert(&input, "xyz", d.path()).is_err());
    assert_eq!(d.files(), [input]);
}

#[test]
fn progress_rises_to_one() {
    let d = CaseDir::new("progress");
    let input = png(d.path(), "a.png", 64, 64);
    let (r, seen) = convert_watch(&input, "jpg", d.path(), None);
    r.unwrap();
    assert!(seen.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
    assert_eq!(seen.last(), Some(&1.0));
}

#[test]
fn unicode_and_long_paths() {
    let d = CaseDir::new("paths");
    let deep = (0..6).fold(d.path().to_path_buf(), |p, i| p.join(format!("a rather long folder name, number {i}, for path tests")));
    std::fs::create_dir_all(&deep).unwrap();
    for name in ["Ünïcödé 写真 'quote'.png", "with space & ampersand.png"] {
        let input = deep.join(name);
        pattern(32, 32).save(&input).unwrap();
        let out = run(&input, "jpg").unwrap();
        assert!(out.to_string_lossy().len() > 260 || name.contains("space"));
        image_ok(&out, "jpg", Some((32, 32)));
    }
}

#[test]
fn large_image() {
    let d = CaseDir::new("large");
    let input = png(d.path(), "big.png", 4000, 3000);
    image_ok(&run(&input, "jpg").unwrap(), "jpg", Some((4000, 3000)));
}

#[test]
fn edge_exif_rotated_jpg_to_png_is_upright() {
    // 1.x: "edge: EXIF-rotated jpg → png is upright". 2.0 must apply the orientation tag.
    let d = CaseDir::new("exif");
    let out = run(&exif_rotated_jpg(d.path(), "r.jpg"), "png").unwrap();
    image_ok(&out, "png", Some((32, 64)));
}
