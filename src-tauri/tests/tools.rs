//! The tool cases of 1.x (`tool` and `instant` groups in tests/cases.ts, the regressions in
//! tests/cases-tools.ts), run for real: each one is a job in an off-screen tool window of the app
//! (see `common/toolapp.rs`), with the option shapes the tool pages send. The checks are the
//! `verify_*` helpers of `common` (ffprobe, image decode, PDF page count, ZIP listing, `7z t`).
//!
//! Cases that need FFmpeg / 7-Zip / Ghostscript / ImageMagick use the vendored engines or the ones
//! the app downloads on first use; when one can't be had (offline) the case skips with a reason
//! (`SKIP` lines with `-- --nocapture`, and `<temp>/orange2-tests/skips.txt`). The AI tools
//! (remove background, upscale, speech) download models and only run with `ORANGE_TEST_AI=1`.
//!
//! ```text
//! node scripts/build-web.mjs                       (the pages are embedded in the app at build time)
//! cargo test --test tools -- --nocapture
//! ```
#![allow(unexpected_cfgs, unused_imports, dead_code)]

#[macro_use]
mod common;

use common::toolapp::{self, invoke, run, steps, PageRun, CLICK_PRIMARY};
use common::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A tool run that must succeed.
fn t(id: &str, inputs: &[PathBuf], opts: Value) -> Vec<PathBuf> {
    toolapp::tool(id, inputs, opts).unwrap_or_else(|e| panic!("{id}: {e}"))
}

/// A tool run that must fail with a message containing `needle` (case-insensitive).
fn fails(id: &str, inputs: &[PathBuf], opts: Value, needle: &str) -> String {
    match toolapp::tool(id, inputs, opts) {
        Ok(outs) => panic!("{id}: expected an error mentioning {needle:?}, got outputs {outs:?}"),
        Err(e) => {
            assert!(e.to_lowercase().contains(&needle.to_lowercase()), "{id}: error {e:?} lacks {needle:?}");
            e
        }
    }
}

fn name(p: &Path) -> String {
    p.file_name().unwrap().to_string_lossy().into_owned()
}

fn sub(d: &CaseDir, parts: &[&str]) -> PathBuf {
    let p = parts.iter().fold(d.join("in"), |a, x| a.join(x));
    std::fs::create_dir_all(&p).unwrap();
    p
}

/// Files a tool made, with result folders (splits, frames, extractions) expanded.
fn files_of(outs: &[PathBuf]) -> Vec<PathBuf> {
    outs.iter().flat_map(|o| if o.is_dir() { files_under(o) } else { vec![o.clone()] }).collect()
}

/// Three distinct outputs that all exist (the same-name-from-different-folders regressions).
fn unique3(outs: &[PathBuf]) {
    let mut set: Vec<&PathBuf> = outs.iter().collect();
    set.sort();
    set.dedup();
    assert!(outs.len() == 3 && set.len() == 3 && outs.iter().all(|o| o.exists()), "outputs {outs:?}");
}

fn exists_named(d: &CaseDir, re: &str) -> Vec<String> {
    d.files().iter().map(|f| name(f)).filter(|n| n.contains(re)).collect()
}

const PW: &str = "orange-Test 123";

// ---------------------------------------------------------------- instant

pending!(tools, extract_archive_zip, {
    need_engines!("7z");
    let d = CaseDir::new("extract-zip");
    let outs = t("extractArchive", &[zip(d.path(), "files.zip")], json!({}));
    verify_conversion("zip", "extract", &outs);
});

pending!(tools, extract_archive_7z_and_targz_together, {
    need_engines!("7z");
    let d = CaseDir::new("extract-two");
    let src = folder(d.path(), "src");
    let sz = engine("7z").unwrap();
    let a = d.join("files.7z");
    let b = d.join("files.tar.gz");
    assert!(std::process::Command::new(&sz).args(["a", "-bd"]).arg(&a).arg(src.join("*")).status().unwrap().success());
    let tar = d.join("files.tar");
    assert!(std::process::Command::new(&sz).args(["a", "-bd", "-ttar"]).arg(&tar).arg(src.join("*")).status().unwrap().success());
    assert!(std::process::Command::new(&sz).args(["a", "-bd", "-tgzip"]).arg(&b).arg(&tar).status().unwrap().success());
    let outs = t("extractArchive", &[a, b], json!({}));
    assert_eq!(outs.len(), 2);
    for o in outs {
        verify_conversion("7z", "extract", &[o]);
    }
});

// ---------------------------------------------------------------- compress

pending!(tools, compress_image_jpg_quality_60, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("compress-jpg");
    let src = jpg_exif(d.path(), "photo.jpg", 640, 480);
    assert!(std::fs::read(&src).unwrap().windows(4).any(|w| w == b"Exif"), "fixture has no EXIF to strip");
    let out = one(t("compress", &[src.clone()], json!({ "image": { "mode": "quality", "quality": 60, "strip": true } })));
    assert_eq!(name(&out), "photo compressed.jpg");
    assert!(size_of(&out) < size_of(&src), "{} >= {}", size_of(&out), size_of(&src));
    image_ok(&out, "jpg", Some((640, 480)));
    assert!(!std::fs::read(&out).unwrap().windows(4).any(|w| w == b"Exif"), "metadata not stripped");
});

pending!(tools, compress_image_target_size, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("compress-size");
    let out = one(t("compress", &[photo_png(d.path(), "sample.png", 640, 480)], json!({ "image": { "mode": "size", "targetBytes": 60000 } })));
    assert!(size_of(&out) as f64 <= 60000.0 * 1.05, "{} bytes", size_of(&out));
    image_ok(&out, "png", None);
});

pending!(tools, compress_video_preset_small, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("compress-video");
    let src = media_fixture(d.path(), "mp4");
    let out = one(t("compress", &[src.clone()], json!({ "video": { "mode": "preset", "preset": "small" } })));
    assert!(size_of(&out) < size_of(&src), "{} >= {}", size_of(&out), size_of(&src));
    media(&out, Some("h264"), Some("aac"), Some(3.0), Some((320, 240)));
});

pending!(tools, compress_audio_wav_to_m4a_128k, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("compress-audio");
    let src = wav(d.path(), "tone.wav", 3.0, 44100, 2);
    let out = one(t("compress", &[src.clone()], json!({ "audio": { "kbps": 128 } })));
    assert!(size_of(&out) < size_of(&src));
    media(&out, None, Some("aac"), Some(3.0), None);
});

pending!(tools, compress_pdf_ebook, {
    need_engines!("gs/bin/gswin64c");
    let d = CaseDir::new("compress-pdf");
    let src = pdf_photo(d.path(), "photo.pdf");
    let out = one(t("compress", &[src.clone()], json!({ "pdf": { "level": "ebook" } })));
    assert!(size_of(&out) < size_of(&src) / 2, "only {}% of the original: Ghostscript's downsampling did not run", 100 * size_of(&out) / size_of(&src));
    assert_eq!(pdf_pages(&out), 1);
});

pending!(tools, compress_folder_to_zip, {
    need_engines!("7z");
    let d = CaseDir::new("compress-folder");
    let out = one(t("compress", &[folder(d.path(), "Folder")], json!({})));
    verify_conversion("folder", "zip", &[out.clone()]);
    archive_ok(&out, None);
});

// ---------------------------------------------------------------- video

pending!(tools, trim_video_precise, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("trim-precise");
    let out = one(t("trimVideo", &[media_fixture(d.path(), "mp4")], json!({ "start": 0.5, "end": 2.0, "mode": "precise" })));
    assert!(name(&out).ends_with(" trimmed.mp4"), "{}", name(&out));
    media(&out, Some("h264"), Some("aac"), Some(1.5), Some((320, 240)));
});

pending!(tools, trim_video_fast_stream_copy, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("trim-fast");
    let out = one(t("trimVideo", &[media_fixture(d.path(), "mp4")], json!({ "start": 0, "end": 2.0, "mode": "fast" })));
    media(&out, Some("h264"), Some("aac"), Some(2.0), None);
});

pending!(tools, join_videos_fast_path, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("join-fast");
    let out = one(t("joinVideos", &[media_fixture(d.path(), "mp4"), media_fixture(d.path(), "mp4b")], json!({})));
    media(&out, Some("h264"), Some("aac"), Some(5.0), Some((320, 240)));
});

pending!(tools, join_videos_mp4_and_mov_reencode, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("join-reencode");
    let out = one(t("joinVideos", &[media_fixture(d.path(), "mp4b"), media_fixture(d.path(), "mov")], json!({ "reencode": true })));
    media(&out, Some("h264"), Some("aac"), Some(5.0), Some((320, 240)));
});

pending!(tools, crop_video_160x120, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("crop-video");
    let out = one(t("cropVideo", &[media_fixture(d.path(), "mp4")], json!({ "x": 80, "y": 60, "w": 160, "h": 120 })));
    media(&out, Some("h264"), None, Some(3.0), Some((160, 120)));
});

pending!(tools, speed_video_2x, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("speed-video");
    let out = one(t("speedVideo", &[media_fixture(d.path(), "mp4")], json!({ "speed": 2 })));
    media(&out, Some("h264"), Some("aac"), Some(1.5), None);
});

pending!(tools, video_frames_two, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("frames");
    let outs = t("videoFrames", &[media_fixture(d.path(), "mp4")], json!({ "times": [0.5, 1.5] }));
    let files = files_of(&outs);
    assert_eq!(files.len(), 2, "{files:?}");
    for f in files {
        image_ok(&f, "png", Some((320, 240)));
    }
});

pending!(tools, split_video_three_parts, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("split-video");
    let outs = t("splitVideo", &[media_fixture(d.path(), "mp4")], json!({ "parts": 3 }));
    let parts: Vec<PathBuf> = files_of(&outs).into_iter().filter(|f| matches!(ext_lower(f).as_str(), "mp4" | "mkv" | "mov")).collect();
    assert_eq!(parts.len(), 3, "{parts:?}");
    let total: f64 = parts.iter().map(|p| media(p, Some("h264"), None, None, None).duration).sum();
    assert!((total - 3.0).abs() < 0.4, "parts add up to {total} s");
});

pending!(tools, redact_video_one_box, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("redact-video");
    let out = one(t("redactVideo", &[media_fixture(d.path(), "mp4")], json!({ "boxes": [{ "x": 10, "y": 10, "w": 100, "h": 80, "start": 0, "end": 3, "style": "blur" }] })));
    media(&out, Some("h264"), None, Some(3.0), Some((320, 240)));
});

// ---------------------------------------------------------------- audio

pending!(tools, normalize_audio_minus_16_lufs, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("normalize");
    let out = one(t("normalizeAudio", &[wav(d.path(), "tone.wav", 3.0, 44100, 2)], json!({ "I": -16, "TP": -1.5, "LRA": 11 })));
    media(&out, None, None, Some(3.0), None);
});

pending!(tools, trim_audio, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("trim-audio");
    let out = one(t("trimAudio", &[media_fixture(d.path(), "mp3")], json!({ "start": 0.5, "end": 2.5 })));
    media(&out, None, Some("mp3"), Some(2.0), None);
});

pending!(tools, audio_channels_to_mono, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("mono");
    let out = one(t("audioChannels", &[wav(d.path(), "tone.wav", 3.0, 44100, 2)], json!({ "output": "mono" })));
    assert_eq!(media(&out, None, None, Some(3.0), None).channels, 1);
});

pending!(tools, bleep_audio, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("bleep");
    let out = one(t("bleepAudio", &[media_fixture(d.path(), "mp3")], json!({ "ranges": [{ "start": 1.0, "end": 1.5 }] })));
    media(&out, None, None, Some(3.0), None);
});

pending!(tools, join_audio_two_mp3, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("join-audio");
    let out = one(t("joinAudio", &[media_fixture(d.path(), "mp3"), media_fixture(d.path(), "mp3b")], json!({})));
    media(&out, None, Some("mp3"), Some(5.0), None);
});

pending!(tools, audio_to_video_waveform, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("visualize");
    let out = one(t("audioToVideo", &[wav(d.path(), "tone.wav", 3.0, 44100, 2)], json!({ "style": "wave", "size": "square" })));
    media(&out, Some("h264"), Some("aac"), Some(3.0), Some((1080, 1080)));
});

fn cues() -> Value {
    json!([{ "start": 0.5, "end": 1.5, "text": "Hello from Orange" }, { "start": 1.8, "end": 2.8, "text": "Second cue" }])
}

pending!(tools, subtitles_from_cues_to_srt, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("subs-srt");
    let out = one(t("subtitles", &[media_fixture(d.path(), "mp4")], json!({ "cues": cues(), "output": "srt" })));
    text_has(&out, &["Hello from Orange", "00:00:00,500 --> 00:00:01,500"]);
});

pending!(tools, subtitles_from_cues_to_track, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("subs-track");
    let out = one(t("subtitles", &[media_fixture(d.path(), "mp4")], json!({ "cues": cues(), "output": "track", "cueLanguage": "en" })));
    assert_eq!(probe(&out).subtitle_tracks, 1, "subtitle tracks");
    media(&out, Some("h264"), None, Some(3.0), None);
});

pending!(tools, subtitles_from_cues_burned_in, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("subs-burn");
    let out = one(t("subtitles", &[media_fixture(d.path(), "mp4")], json!({ "cues": cues(), "output": "burn" })));
    media(&out, Some("h264"), None, Some(3.0), Some((320, 240)));
});

// ---------------------------------------------------------------- images and PDF

/// The crop window the cropImage page sends: a fraction of the image around a centre.
fn crop_spec(nw: f64, nh: f64) -> Value {
    json!({ "aspect": null, "cx": 0.5, "cy": 0.5, "nw": nw, "nh": nh, "f": 1 })
}

pending!(tools, crop_image_centre_half, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("crop-image");
    let out = one(t("cropImage", &[jpg(d.path(), "photo.jpg", 640, 480)], json!({ "rotate": 0, "flipH": false, "flipV": false, "spec": crop_spec(0.5, 0.5), "out": null })));
    image_ok(&out, "jpg", Some((320, 240)));
});

pending!(tools, crop_image_rotate_90_and_flip, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("crop-rotate");
    let out = one(t("cropImage", &[png(d.path(), "sample.png", 640, 480)], json!({ "rotate": 90, "flipH": true, "flipV": false, "spec": crop_spec(1.0, 1.0), "out": null })));
    image_ok(&out, "png", Some((480, 640)));
});

pending!(tools, create_pdf_two_images_a4, {
    let d = CaseDir::new("create-pdf");
    let out = one(t("createPdf", &[jpg(d.path(), "photo.jpg", 640, 480), png(d.path(), "sample.png", 640, 480)], json!({ "page": "a4", "orientation": "auto", "margin": 10 })));
    assert_eq!(pdf_pages(&out), 2);
});

pending!(tools, merge_pdf_custom_order, {
    let d = CaseDir::new("merge-pdf");
    let a = pdf(d.path(), "a.pdf", 3);
    let b = pdf(d.path(), "b.pdf", 2);
    let out = one(t("mergePdf", &[a.clone(), b.clone()], json!({ "order": [b, a] })));
    assert_eq!(name(&out), "Merged.pdf");
    assert_eq!(pdf_pages(&out), 5);
});

pending!(tools, split_pdf_ranges, {
    let d = CaseDir::new("split-ranges");
    let outs = t("splitPdf", &[pdf(d.path(), "doc.pdf", 3)], json!({ "groups": [[0], [1, 2]], "mode": "ranges" }));
    assert_eq!(outs.len(), 2);
    assert_eq!((pdf_pages(&outs[0]), pdf_pages(&outs[1])), (1, 2));
});

pending!(tools, split_pdf_extract_page_2, {
    let d = CaseDir::new("split-extract");
    let out = one(t("splitPdf", &[pdf(d.path(), "doc.pdf", 3)], json!({ "groups": [[1]], "mode": "extract" })));
    assert!(name(&out).ends_with(" p2.pdf"), "{}", name(&out));
    assert_eq!(pdf_pages(&out), 1);
});

pending!(tools, organize_pdf_reorder_and_rotate, {
    let d = CaseDir::new("organize");
    let src = pdf(d.path(), "doc.pdf", 3);
    let out = one(t("organizePdf", &[src.clone()], json!({ "pages": [{ "src": src, "index": 2, "rotate": 90 }, { "src": src, "index": 0 }] })));
    assert_eq!(pdf_pages(&out), 2);
    assert_eq!(pdf_rotations(&out), vec![90, 0], "page rotations");
});

pending!(tools, organize_pdf_no_valid_pages_is_an_error, {
    let d = CaseDir::new("organize-empty");
    let src = pdf(d.path(), "doc.pdf", 2);
    fails("organizePdf", &[src.clone()], json!({ "pages": [{ "src": src, "index": 9 }] }), "pages");
    assert_eq!(exists_named(&d, "organized"), Vec::<String>::new(), "a blank page was written");
});

pending!(tools, create_pdf_tiny_jpeg_embeds, {
    let d = CaseDir::new("tiny-jpeg");
    // Small files used to be read as a slice of a shared buffer, which pdf-lib's JPEG reader got wrong.
    let a = jpg(d.path(), "small.jpg", 40, 30);
    let b = jpg(d.path(), "small2.jpg", 30, 40);
    assert!(size_of(&a) < 4096 && size_of(&b) < 4096);
    let out = one(t("createPdf", &[a, b], json!({ "page": "fit", "orientation": "auto", "margin": 0 })));
    assert_eq!(pdf_pages(&out), 2);
});

// ---------------------------------------------------------------- rename

pending!(tools, rename_swap_and_rename_then_undo, {
    let d = CaseDir::new("rename");
    let (a, b, c) = (d.join("a.txt"), d.join("b.txt"), d.join("c.txt"));
    for (p, s) in [(&a, "A"), (&b, "B"), (&c, "C")] {
        std::fs::write(p, s).unwrap();
    }
    // The undo history lives in the window that renamed, so both steps run in one window.
    let r = steps(vec![
        run("rename", &[a.clone(), b.clone(), c.clone()], json!({ "pairs": [{ "from": a, "name": "b.txt" }, { "from": b, "name": "a.txt" }, { "from": c, "name": "c renamed.txt" }] })),
        invoke("rename:undo", vec![]),
    ])
    .unwrap();
    assert_eq!(r[0].state, "done", "{:?}", r[0].message);
    assert_eq!(r[0].outputs.len(), 3);
    assert!(r[1].message.is_none() && r[1].value["ok"] == json!(true), "undo failed: {:?}", r[1]);
    // After the undo everything is back; checked once, below.
    assert_eq!((std::fs::read_to_string(&a).unwrap(), std::fs::read_to_string(&b).unwrap(), std::fs::read_to_string(&c).unwrap()), ("A".into(), "B".into(), "C".into()));
    assert!(!d.join("c renamed.txt").exists());
    assert!(!d.files().iter().any(|f| name(f).starts_with(".orange-rename")), "temporary files left");
});

pending!(tools, rename_swap_keeps_the_swapped_names_until_undone, {
    let d = CaseDir::new("rename-swap");
    let (a, b, c) = (d.join("a.txt"), d.join("b.txt"), d.join("c.txt"));
    for (p, s) in [(&a, "A"), (&b, "B"), (&c, "C")] {
        std::fs::write(p, s).unwrap();
    }
    let outs = t("rename", &[a.clone(), b.clone(), c.clone()], json!({ "pairs": [{ "from": a, "name": "b.txt" }, { "from": b, "name": "a.txt" }, { "from": c, "name": "c renamed.txt" }] }));
    assert_eq!(outs.len(), 3);
    assert_eq!((std::fs::read_to_string(&a).unwrap(), std::fs::read_to_string(&b).unwrap()), ("B".into(), "A".into()), "a.txt and b.txt were not swapped");
    assert!(!c.exists() && std::fs::read_to_string(d.join("c renamed.txt")).unwrap() == "C", "c.txt was not renamed");
    assert!(!d.files().iter().any(|f| name(f).starts_with(".orange-rename")), "temporary files left");
});

pending!(tools, rename_rejects_invalid_and_clashing_names, {
    let d = CaseDir::new("rename-bad");
    let (a, b) = (d.join("a.txt"), d.join("b.txt"));
    std::fs::write(&a, "A").unwrap();
    std::fs::write(&b, "B").unwrap();
    fails("rename", &[a.clone()], json!({ "pairs": [{ "from": a, "name": "bad:name.txt" }] }), "can't be used");
    fails("rename", &[a.clone()], json!({ "pairs": [{ "from": a, "name": "b.txt" }] }), "already exists");
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "A");
    assert_eq!(std::fs::read_to_string(&b).unwrap(), "B");
});

// ---------------------------------------------------------------- protect / unlock

pending!(tools, protect_pdf_aes256_then_unlock, {
    let d = CaseDir::new("protect-pdf");
    let locked = one(t("protect", &[pdf(d.path(), "doc.pdf", 3)], json!({ "mode": "pdf", "password": PW, "permissions": { "print": true, "copy": true, "edit": true } })));
    let raw = String::from_utf8_lossy(&std::fs::read(&locked).unwrap()).into_owned();
    assert!(raw.contains("/Encrypt"), "not encrypted");
    assert!(raw.contains("/R 6"), "not AES-256 (no /R 6 in the encryption dictionary)");
    fails("unlock", &[locked.clone()], json!({ "password": "wrong password" }), "wrong");
    let open = one(t("unlock", &[locked], json!({ "password": PW })));
    assert_eq!(pdf_pages(&open), 3);
    fails("unlock", &[open], json!({ "password": PW }), "isn't password-protected");
});

pending!(tools, protect_zip_aes256_then_unlock, {
    need_engines!("7z");
    let d = CaseDir::new("protect-zip");
    let file = text_file(d.path(), "a.txt");
    let z = one(t("protect", &[file], json!({ "mode": "zip", "password": PW })));
    assert_eq!(ext_lower(&z), "zip");
    archive_ok(&z, Some(PW));
    assert!(!seven_zip_test(&z, Some("not the password")), "7z t accepted a wrong password");
    assert!(!seven_zip_test(&z, None), "7z t passed without a password");
    fails("unlock", &[z.clone()], json!({ "password": "nope" }), "wrong");
    let dir = one(t("unlock", &[z], json!({ "password": PW })));
    let got = files_under(&dir).into_iter().find(|f| name(f) == "a.txt").expect("unlocked archive lost a.txt");
    assert!(std::fs::read_to_string(got).unwrap().contains(TEXT_MARK));
});

pending!(tools, protect_7z_encrypted_names, {
    need_engines!("7z");
    let d = CaseDir::new("protect-7z");
    let arc = one(t("protect", &[folder(d.path(), "Folder")], json!({ "mode": "7z", "password": PW })));
    archive_ok(&arc, Some(PW));
    assert!(!seven_zip_test(&arc, None), "7z t passed without a password");
    let out = std::process::Command::new(engine("7z").unwrap()).args(["l", "-p"]).arg(&arc).output().unwrap();
    assert!(!out.status.success(), "names are listable without the password");
});

pending!(tools, protect_pdf_non_ascii_password, {
    let d = CaseDir::new("protect-pdf-utf");
    let pw = "Grüße-日本-ß ключ";
    let locked = one(t("protect", &[pdf(d.path(), "doc.pdf", 2)], json!({ "mode": "pdf", "password": pw })));
    assert!(String::from_utf8_lossy(&std::fs::read(&locked).unwrap()).contains("/Encrypt"));
    assert_eq!(pdf_pages(&one(t("unlock", &[locked], json!({ "password": pw })))), 2);
});

pending!(tools, protect_7z_non_ascii_password, {
    need_engines!("7z");
    let d = CaseDir::new("protect-7z-utf");
    let pw = "Grüße-日本";
    let arc = one(t("protect", &[text_file(d.path(), "a.txt")], json!({ "mode": "7z", "password": pw })));
    let dir = one(t("unlock", &[arc], json!({ "password": pw })));
    assert!(files_under(&dir).iter().any(|f| name(f) == "a.txt"), "unlocked archive lost a.txt");
});

pending!(tools, protect_zip_two_items_with_same_name_fail_clearly, {
    let d = CaseDir::new("protect-clash");
    let a = text_file(&sub(&d, &["a"]), "note.txt");
    let b = text_file(&sub(&d, &["b"]), "note.txt");
    std::fs::write(&a, "a".repeat(4000)).unwrap();
    std::fs::write(&b, "b".repeat(4000)).unwrap();
    fails("protect", &[a.clone(), b.clone()], json!({ "mode": "zip", "password": "pw" }), "Two of these items are named \"note.txt\"");
    fails("compress", &[a, b], json!({}), "Two items are named \"note.txt\"");
    assert!(!d.files().iter().any(|f| ext_lower(f) == "zip"), "a ZIP was left behind: {:?}", d.files());
});

pending!(tools, protect_pdf_batch_already_protected_leaves_no_partial_results, {
    let d = CaseDir::new("protect-batch");
    let a = pdf(d.path(), "a.pdf", 1);
    let b = pdf(d.path(), "b.pdf", 1);
    let locked = one(t("protect", &[b], json!({ "mode": "pdf", "password": "first" })));
    fails("protect", &[a, locked], json!({ "mode": "pdf", "password": "second" }), "already password-protected");
    assert!(!d.join("a protected.pdf").exists(), "a protected.pdf was left behind: {:?}", d.files());
});

// ---------------------------------------------------------------- metadata and OCR

/// The app's own reading of a file's metadata fields (`meta:read`), from a window.
fn meta_fields(files: &[&Path]) -> Vec<Value> {
    let r = steps(files.iter().map(|f| invoke("meta:read", vec![json!(f.to_string_lossy())])).collect()).unwrap();
    r.into_iter()
        .zip(files)
        .map(|(s, f)| {
            assert!(s.message.is_none(), "{}: meta:read failed: {:?}", f.display(), s.message);
            // readMeta turns a read error into a note and empty fields: surface it.
            assert!(s.value["note"].is_null(), "{}: {}", f.display(), s.value["note"]);
            s.value["fields"].clone()
        })
        .collect()
}

pending!(tools, metadata_strip_jpg_exif, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("strip-jpg");
    let src = exif_rotated_jpg(d.path(), "r.jpg");
    assert!(std::fs::read(&src).unwrap().windows(4).any(|w| w == b"Exif"));
    let out = one(t("metadata", &[src], json!({ "action": "strip" })));
    assert!(name(&out).ends_with(" clean.jpg"), "{}", name(&out));
    assert!(!std::fs::read(&out).unwrap().windows(4).any(|w| w == b"Exif"), "EXIF still present");
    image_ok(&out, "jpg", None);
});

pending!(tools, metadata_strip_pdf_info, {
    let d = CaseDir::new("strip-pdf");
    let src = pdf(d.path(), "doc.pdf", 3);
    assert_eq!(meta_fields(&[&src])[0]["title"], json!("Orange fixture"), "fixture has no title");
    let out = one(t("metadata", &[src], json!({ "action": "strip" })));
    assert_eq!(pdf_pages(&out), 3);
    let title = meta_fields(&[&out])[0]["title"].clone();
    assert!(title.is_null() || title == json!(""), "title still {title}");
});

pending!(tools, metadata_strip_mp4_tags, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("strip-mp4");
    let src = media_fixture(d.path(), "mp4");
    let tagged = d.join("tagged.mp4");
    ffmpeg(&["-i", &src.to_string_lossy(), "-c", "copy", "-metadata", "title=Orange Secret", &tagged.to_string_lossy()]);
    assert_eq!(probe(&tagged).title.as_deref(), Some("Orange Secret"), "fixture has no title tag");
    let out = one(t("metadata", &[tagged], json!({ "action": "strip" })));
    let info = media(&out, Some("h264"), Some("aac"), Some(3.0), None);
    assert_eq!(info.title, None, "title tag still there");
});

pending!(tools, metadata_edit_mp3_title_and_pdf_title, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("meta-edit");
    let mp3 = media_fixture(d.path(), "mp3");
    let p = pdf(d.path(), "doc.pdf", 1);
    let outs = t("metadata", &[mp3.clone(), p.clone()], json!({ "action": "edit", "edits": { mp3.to_string_lossy(): { "title": "Edited tone" }, p.to_string_lossy(): { "title": "Edited PDF" } } }));
    assert_eq!(outs.len(), 2, "{outs:?}");
    let m = outs.iter().find(|o| ext_lower(o) == "mp3").unwrap();
    assert_eq!(probe(m).title.as_deref(), Some("Edited tone"), "mp3 title not changed");
    let q = outs.iter().find(|o| ext_lower(o) == "pdf").unwrap();
    assert_eq!(meta_fields(&[q])[0]["title"], json!("Edited PDF"), "pdf title not changed");
});

pending!(tools, metadata_same_named_files_from_different_folders_survive, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("meta-same");
    let ins: Vec<PathBuf> = ["a", "b", "c"].iter().map(|f| jpg_exif(&sub(&d, &[f]), "pic.jpg", 1200, 900)).collect();
    let outs = t("metadata", &ins, json!({ "action": "strip" }));
    unique3(&outs);
    for o in &outs {
        assert!(!std::fs::read(o).unwrap().windows(4).any(|w| w == b"Exif"), "{} still has EXIF", name(o));
    }
});

pending!(tools, crop_image_same_named_from_different_folders_survive, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("crop-same");
    let ins: Vec<PathBuf> = ["a", "b", "c"].iter().map(|f| png(&sub(&d, &[f]), "photo.png", 1600, 1200)).collect();
    let outs = t("cropImage", &ins, json!({ "rotate": 0, "flipH": false, "flipV": false, "spec": crop_spec(0.5, 0.5), "out": null }));
    unique3(&outs);
    for o in &outs {
        image_ok(o, "png", Some((800, 600)));
    }
});

pending!(tools, compress_audio_same_named_from_different_folders_survive, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("compress-same");
    let ins: Vec<PathBuf> = ["a", "b", "c"].iter().map(|f| wav(&sub(&d, &[f]), "song.wav", 20.0, 44100, 2)).collect();
    let outs = t("compress", &ins, json!({ "audio": { "kbps": 96 } }));
    unique3(&outs);
    for o in &outs {
        media(o, None, Some("aac"), Some(20.0), None);
    }
});

pending!(tools, metadata_date_taken_reads_back_after_an_edit, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("meta-date");
    let src = jpg(d.path(), "p.jpg", 64, 48);
    let out = one(t("metadata", &[src.clone()], json!({ "action": "edit", "edits": { src.to_string_lossy(): { "dateTaken": "2024-05-06T07:08" } } })));
    assert_eq!(meta_fields(&[&out])[0]["dateTaken"], json!("2024-05-06T07:08:00"));
});

pending!(tools, metadata_webp_location_is_written_and_tiff_edits_are_refused, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("meta-webp");
    let w = webp(d.path(), "p.webp", 64, 48);
    let out = one(t("metadata", &[w.clone()], json!({ "action": "edit", "edits": { w.to_string_lossy(): { "gps": "-33.8688, 151.2093" } } })));
    assert_eq!(meta_fields(&[&out])[0]["gps"], json!("-33.868800, 151.209300"));
    let tif = d.join("p.tiff");
    let st = std::process::Command::new(engine("imagemagick/magick").unwrap()).arg(&w).arg(&tif).env("MAGICK_HOME", engine("imagemagick/magick").unwrap().parent().unwrap()).status().unwrap();
    assert!(st.success() && tif.exists());
    fails("metadata", &[tif.clone()], json!({ "action": "edit", "edits": { tif.to_string_lossy(): { "make": "Acme" } } }), "can't edit metadata in TIFF");
});

pending!(tools, ocr_image_to_txt, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("ocr-txt");
    let Some(img) = text_scan(d.path(), "scan.png") else { return skip("ImageMagick could not render the scan") };
    let out = one(t("ocr", &[img], json!({ "output": "txt", "langs": ["eng"], "combine": false })));
    let s = text_has(&out, &[]).to_uppercase();
    assert!(s.contains("ORANGE") && s.contains("TEST"), "recognised {s:?}");
});

pending!(tools, ocr_image_to_searchable_pdf, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("ocr-pdf");
    let Some(img) = text_scan(d.path(), "scan.png") else { return skip("ImageMagick could not render the scan") };
    let out = one(t("ocr", &[img], json!({ "output": "pdf", "langs": ["eng"], "combine": false })));
    assert_eq!(pdf_pages(&out), 1);
    // The text layer reads back through the converters' PDF -> TXT.
    let txt = one(convert(&out, "txt", d.path()).unwrap_or_else(|e| panic!("pdf -> txt: {e}")));
    assert!(text_has(&txt, &[]).to_uppercase().contains("ORANGE"), "no recognised text in the PDF's text layer");
});

pending!(tools, ocr_scanned_pdf_to_md, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("ocr-md");
    let Some(img) = text_scan(d.path(), "scan.png") else { return skip("ImageMagick could not render the scan") };
    let scan_pdf = one(convert(&img, "pdf", d.path()).unwrap_or_else(|e| panic!("png -> pdf: {e}")));
    let out = one(t("ocr", &[scan_pdf], json!({ "output": "md", "langs": ["eng"], "combine": false })));
    assert_eq!(ext_lower(&out), "md");
    assert!(text_has(&out, &[]).to_uppercase().contains("ORANGE"));
});

// ---------------------------------------------------------------- regressions (cases-tools.ts)

pending!(tools, normalize_audio_without_audio_fails_before_writing, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("normalize-noaudio");
    let voice = wav(d.path(), "voice.wav", 3.0, 44100, 2);
    let silent = d.join("mute.mp4");
    ffmpeg(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", &silent.to_string_lossy()]);
    fails("normalizeAudio", &[voice, silent], json!({}), "has no audio");
    assert!(exists_named(&d, "normalized").is_empty(), "left behind: {:?}", exists_named(&d, "normalized"));
});

pending!(tools, video_frames_time_past_end_is_skipped, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("frames-past-end");
    let src = media_fixture(d.path(), "mp4");
    let outs = t("videoFrames", &[src.clone()], json!({ "times": [1.0, 30.0] }));
    let files = files_of(&outs);
    assert!(files.len() == 1 && files[0].exists() && ext_lower(&files[0]) == "png", "{files:?}");
    fails("videoFrames", &[src], json!({ "times": [30.0] }), "past the end");
});

pending!(tools, join_videos_with_different_rotation_are_not_stream_copied, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("join-rotation");
    let plain = media_fixture(d.path(), "mp4");
    let rotated = d.join("rotated.mp4");
    ffmpeg(&["-display_rotation", "90", "-i", &plain.to_string_lossy(), "-c", "copy", &rotated.to_string_lossy()]); // shows as 240x320
    let portrait = d.join("portrait.mp4");
    ffmpeg(&["-f", "lavfi", "-i", "testsrc2=s=240x320:r=25:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2:sample_rate=48000", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", &portrait.to_string_lossy()]);
    let out = one(t("joinVideos", &[rotated, portrait], json!({})));
    // Copying would keep clip 1's rotation for both, showing the portrait clip sideways.
    let p = media(&out, Some("h264"), None, Some(5.0), None);
    assert_eq!((p.width, p.height), (240, 320), "{p:?}");
});

pending!(tools, join_audio_96k_flac_to_mp3_is_resampled, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("join-96k");
    let hi = d.join("hi.flac");
    ffmpeg(&["-f", "lavfi", "-i", "sine=f=440:d=2:sample_rate=96000", "-ac", "2", &hi.to_string_lossy()]);
    let lo = wav(d.path(), "lo.wav", 2.0, 44100, 2);
    let out = one(t("joinAudio", &[hi, lo], json!({ "format": "mp3", "crossfade": 0 })));
    let p = media(&out, None, Some("mp3"), Some(4.0), None);
    assert_eq!(p.sample_rate, 48000, "sample rate {}", p.sample_rate);
});

pending!(tools, trim_audio_silence_removal_on_pure_silence_fails_clearly, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("trim-silence");
    let src = media_fixture(d.path(), "silence");
    fails("trimAudio", &[src], json!({ "start": 0, "end": 2, "trimSilence": true, "threshold": -50 }), "all silence");
    assert!(exists_named(&d, "trimmed").is_empty(), "an empty result was left behind");
});

pending!(tools, cancelled_ffmpeg_run_leaves_no_half_written_file, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("cancel");
    let src = d.join("long.mp4");
    ffmpeg(&["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=20", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", &src.to_string_lossy()]);
    // Cancelled as the HUD's Cancel does, 700 ms into a slow-motion encode.
    let r = toolapp::steps(vec![toolapp::run_cancelled("speedVideo", &[src], json!({ "speed": 0.25 }), 700)]).unwrap();
    assert_eq!(r[0].state, "cancelled", "{:?}", r[0]);
    assert!(exists_named(&d, "0.25x").is_empty(), "left behind: {:?}", exists_named(&d, "0.25x"));
});

pending!(tools, ffmpeg_errors_name_the_cause_not_terminating_thread, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("ffmpeg-error");
    let src = media_fixture(d.path(), "mp4");
    let e = fails("redactVideo", &[src], json!({ "boxes": [{ "x": 5, "y": 5, "w": 2, "h": 2, "start": 0, "end": 9, "style": "blur" }] }), "");
    assert!(!e.contains("Terminating thread") && !e.to_lowercase().contains("return code"), "message: {e}");
});

pending!(tools, damaged_archive_gives_a_clear_error, {
    need_engines!("7z");
    let d = CaseDir::new("damaged-zip");
    let z = zip(d.path(), "broken.zip");
    let b = std::fs::read(&z).unwrap();
    std::fs::write(&z, &b[..b.len() / 2]).unwrap();
    let before = d.files();
    let e = toolapp::tool("extractArchive", &[z], json!({})).unwrap_err();
    assert!(!e.trim().is_empty() && !e.contains("exit code"), "unclear error: {e}");
    let l = e.to_lowercase();
    assert!(l.contains("damaged") || l.contains("not a supported") || l.contains("archive"), "error does not say what is wrong: {e}");
    assert_eq!(d.files(), before, "left behind: {:?}", d.files());
});

// ---------------------------------------------------------------- awkward paths (Ghostscript expands %, FFmpeg image2 too)

/// A folder and file name with non-ASCII, spaces, `&` and `%`.
fn awkward(d: &CaseDir, folder_name: &str) -> PathBuf {
    let p = d.join(folder_name);
    std::fs::create_dir_all(&p).unwrap();
    p
}

pending!(tools, percent_in_path_compress_pdf_uses_ghostscript, {
    need_engines!("gs/bin/gswin64c");
    let d = CaseDir::new("pct-compress");
    let dir = awkward(&d, "100% done");
    let src = pdf_photo(&dir, "50% off.pdf");
    let out = one(t("compress", &[src.clone()], json!({ "pdf": { "level": "ebook" } })));
    assert_eq!(pdf_pages(&out), 1);
    assert!(size_of(&out) < size_of(&src) / 2, "only {}% of the original: Ghostscript did not run", 100 * size_of(&out) / size_of(&src));
});

pending!(tools, percent_in_path_protect_then_unlock_pdf, {
    let d = CaseDir::new("pct-protect");
    let dir = awkward(&d, "100% done");
    let locked = one(t("protect", &[pdf(&dir, "50% off.pdf", 2)], json!({ "mode": "pdf", "password": PW })));
    assert_eq!(pdf_pages(&one(t("unlock", &[locked], json!({ "password": PW })))), 2);
});

pending!(tools, percent_in_path_video_frames_one_and_two, {
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("pct-frames");
    let dir = awkward(&d, "100% done");
    let src = media_fixture(&dir, "mp4");
    let single = files_of(&t("videoFrames", &[src.clone()], json!({ "times": [1.0] })));
    assert_eq!(single.len(), 1);
    image_ok(&single[0], "png", Some((320, 240)));
    assert_eq!(files_of(&t("videoFrames", &[src], json!({ "times": [0.5, 2.0] }))).len(), 2);
});

pending!(tools, unicode_path_compress_pdf_and_protect_unlock, {
    need_engines!("gs/bin/gswin64c");
    let d = CaseDir::new("unicode");
    let dir = awkward(&d, "Ünïcödé 日本 & co");
    let src = pdf_photo(&dir, "Résumé 日本.pdf");
    let out = one(t("compress", &[src.clone()], json!({ "pdf": { "level": "ebook" } })));
    assert_eq!(pdf_pages(&out), 1);
    assert!(size_of(&out) < size_of(&src) / 2, "Ghostscript did not run");
    let locked = one(t("protect", &[pdf(&dir, "Résumé 日本 2.pdf", 2)], json!({ "mode": "pdf", "password": PW })));
    assert_eq!(pdf_pages(&one(t("unlock", &[locked], json!({ "password": PW })))), 2);
});

pending!(tools, unicode_path_ocr_scanned_pdf_to_txt, {
    need_engines!("imagemagick/magick", "gs/bin/gswin64c");
    let d = CaseDir::new("unicode-ocr");
    let dir = awkward(&d, "100% Ünï 日本");
    let Some(img) = text_scan(&dir, "scan 50% off.png") else { return skip("ImageMagick could not render the scan") };
    let scan = one(convert(&img, "pdf", &dir).unwrap_or_else(|e| panic!("png -> pdf: {e}")));
    let out = one(t("ocr", &[scan], json!({ "output": "txt", "langs": ["eng"], "combine": false })));
    assert!(text_has(&out, &[]).to_uppercase().contains("ORANGE"));
});

// ---------------------------------------------------------------- the tool windows themselves

pending!(tools, wheel_choice_opens_the_compress_window_and_zips_a_folder, {
    need_engines!("7z");
    // The Tools wheel's `tool:compress` on a folder (the 1.x self-test "folder-to-zip", for real): the
    // window opens, its Compress button is pressed, the ZIP is valid. Unlike most tools, Compress keeps
    // its window open to show the result ("Done", and its button becomes "Show in folder").
    let d = CaseDir::new("wheel-folder");
    let f = folder(d.path(), "Holiday photos");
    let script = format!("{CLICK_PRIMARY} await until(() => $('.status')?.textContent === 'Done', 120000); return $('.footer .btn.primary').textContent;");
    let r = toolapp::wheel("tool:compress", &[f], &script, 1, Duration::from_secs(120)).unwrap();
    assert!(r.page_errors.is_empty(), "page errors: {:?}", r.page_errors);
    assert_eq!(r.result, json!("Show in folder"));
    assert_eq!(r.jobs.len(), 1);
    assert_eq!(r.jobs[0].state, "done", "{:?}", r.jobs[0].message);
    let zip_out = one(r.jobs[0].outputs.clone());
    assert_eq!(name(&zip_out), "Holiday photos.zip");
    verify_conversion("folder", "zip", &[zip_out.clone()]);
    archive_ok(&zip_out, None);
});

pending!(tools, wheel_choice_opens_the_crop_window_and_crops, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("wheel-crop");
    let src = jpg(d.path(), "photo.jpg", 640, 480);
    let r = toolapp::wheel("tool:cropImage", &[src], CLICK_PRIMARY, 1, Duration::from_secs(120)).unwrap();
    assert!(r.page_errors.is_empty(), "page errors: {:?}", r.page_errors);
    assert_eq!(r.jobs[0].state, "done", "{:?}", r.jobs[0].message);
    image_ok(&one(r.jobs[0].outputs.clone()), "jpg", Some((640, 480)));
    assert!(r.closed, "the window did not close after its job");
});

pending!(tools, ctrl_enter_runs_the_tool_and_escape_closes_the_window, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("keys");
    let src = png(d.path(), "pic.png", 320, 240);
    // Ctrl+Enter is the primary action's shortcut, as in 1.x.
    let r = toolapp::page(
        "cropImage",
        &[src.clone()],
        "const b = await until(() => $('.footer .btn.primary')); await wait(500); await until(() => !b.disabled, 30000); document.body.focus(); key('Enter', { ctrlKey: true });",
        1,
        Duration::from_secs(120),
    )
    .unwrap();
    assert_eq!(r.jobs[0].state, "done", "{:?}", r.jobs[0].message);
    assert!(r.closed, "the window did not close after its job");
    // Escape closes a window that has done nothing.
    let e = toolapp::page("cropImage", &[src], "await until(() => $('.footer .btn.primary')); await wait(500); key('Escape'); await wait(1500);", 0, Duration::from_secs(60)).unwrap();
    assert!(e.closed, "Escape did not close the window");
    assert!(e.jobs.is_empty());
});

pending!(tools, a_saved_preset_runs_its_tool_without_a_window, {
    need_engines!("imagemagick/magick");
    let d = CaseDir::new("preset");
    let src = jpg(d.path(), "photo.jpg", 640, 480);
    let options = json!({ "rotate": 0, "flipH": false, "flipV": false, "spec": crop_spec(0.5, 0.5), "out": null });
    let saved = steps(vec![invoke("presets:save", vec![json!({ "name": "Half", "tool": "cropImage", "options": options, "paths": [src.to_string_lossy()], "kinds": ["image"] })])]).unwrap();
    let id = saved[0].value["id"].as_str().unwrap_or_else(|| panic!("no preset id in {:?}", saved[0])).to_string();
    let r = toolapp::wheel(&format!("preset:{id}"), &[src], "", 1, Duration::from_secs(120)).unwrap();
    assert_eq!(r.jobs[0].state, "done", "{:?}", r.jobs[0].message);
    image_ok(&one(r.jobs[0].outputs.clone()), "jpg", Some((320, 240)));
    assert!(r.closed, "the preset's window did not close");
});

/// The tool ids of the catalog and a fixture each can open on.
fn open_cases(d: &CaseDir) -> Vec<(&'static str, Vec<PathBuf>, &'static [&'static str])> {
    let img = |n: &str| jpg(d.path(), n, 640, 480);
    let clip = || media_fixture(d.path(), "mp4");
    let tone = || media_fixture(d.path(), "mp3");
    let mut v: Vec<(&'static str, Vec<PathBuf>, &'static [&'static str])> = vec![];
    for id in ["editImage", "annotateImage", "frameImage", "cropImage", "redactImage"] {
        v.push((id, vec![img(&format!("{id}.jpg"))], &["imagemagick/magick"]));
    }
    v.push(("createPdf", vec![img("p1.jpg"), img("p2.jpg")], &["imagemagick/magick"]));
    v.push(("createCollage", vec![img("c1.jpg"), img("c2.jpg"), img("c3.jpg")], &["imagemagick/magick"]));
    for id in ["trimVideo", "cropVideo", "speedVideo", "videoFrames", "splitVideo", "redactVideo"] {
        v.push((id, vec![clip()], &["ffmpeg", "ffprobe"]));
    }
    v.push(("joinVideos", vec![clip(), media_fixture(d.path(), "mp4b")], &["ffmpeg", "ffprobe"]));
    v.push(("normalizeAudio", vec![tone()], &["ffmpeg", "ffprobe"]));
    for id in ["audioToVideo", "trimAudio", "audioChannels", "bleepAudio"] {
        v.push((id, vec![tone()], &["ffmpeg", "ffprobe"]));
    }
    v.push(("joinAudio", vec![tone(), media_fixture(d.path(), "mp3b")], &["ffmpeg", "ffprobe"]));
    v.push(("mergePdf", vec![pdf(d.path(), "m1.pdf", 2), pdf(d.path(), "m2.pdf", 1)], &[]));
    v.push(("organizePdf", vec![pdf(d.path(), "o.pdf", 3)], &[]));
    v.push(("splitPdf", vec![pdf(d.path(), "s.pdf", 3)], &[]));
    v.push(("compress", vec![img("compress.jpg")], &[]));
    v.push(("metadata", vec![img("meta.jpg")], &[]));
    v.push(("ocr", vec![img("ocr.jpg")], &[]));
    v.push(("removeBg", vec![img("bg.jpg")], &[]));
    v.push(("upscale", vec![img("up.jpg")], &[]));
    v.push(("rename", vec![text_file(d.path(), "r1.txt"), text_file(d.path(), "r2.txt")], &[]));
    v.push(("protect", vec![pdf(d.path(), "pw.pdf", 1)], &[]));
    v.push(("unlock", vec![pdf(d.path(), "ul.pdf", 1)], &[]));
    v.push(("subtitles", vec![tone()], &["ffmpeg", "ffprobe"]));
    v
}

pending!(tools, every_tool_window_opens_and_builds_its_page, {
    // 32 pages (extractArchive has none: it runs from the wheel). Fixtures that need an engine
    // are made only when it is there; the others still open.
    let d = CaseDir::new("open-all");
    let have_ffmpeg = engine("ffmpeg").is_some() && engine("ffprobe").is_some();
    let have_magick = engine("imagemagick/magick").is_some();
    if !have_magick {
        skip("ImageMagick is not available: image tools cannot open");
    }
    if !have_ffmpeg {
        skip("FFmpeg is not available: audio and video tools cannot open");
    }
    let cases: Vec<_> = open_cases_checked(&d, have_ffmpeg);
    let script = "await until(() => $('.footer .btn.primary') || $('.empty-state')); await wait(700); return { h1: $('.titlebar h1')?.textContent || '', primary: $('.footer .btn.primary')?.textContent || '', caption: !!$('.caption-buttons'), broken: document.body.innerText.includes('Something went wrong') ? document.body.innerText.slice(0, 200) : null };";
    let failures = std::sync::Mutex::new(Vec::<String>::new());
    std::thread::scope(|s| {
        for chunk in cases.chunks(cases.len().div_ceil(4).max(1)) {
            let failures = &failures;
            s.spawn(move || {
                for (id, inputs) in chunk {
                    let outcome = toolapp::page(id, inputs, script, 0, Duration::from_secs(90));
                    let msg = match outcome {
                        Err(e) => Some(format!("{id}: {e}")),
                        Ok(r) if !r.page_errors.is_empty() => Some(format!("{id}: page errors {:?}", r.page_errors)),
                        Ok(r) if r.result["broken"].is_string() => Some(format!("{id}: {}", r.result["broken"])),
                        Ok(r) if r.result["h1"].as_str().unwrap_or("").is_empty() || r.result["caption"] != json!(true) || r.result["primary"].as_str().unwrap_or("").is_empty() => Some(format!("{id}: incomplete page {}", r.result)),
                        Ok(_) => None,
                    };
                    if let Some(m) = msg {
                        failures.lock().unwrap().push(m);
                    }
                }
            });
        }
    });
    let f = failures.into_inner().unwrap();
    assert!(f.is_empty(), "{} of {} windows failed:\n{}", f.len(), cases.len(), f.join("\n"));
});

/// `open_cases` without the cases whose fixtures need an engine that is missing.
fn open_cases_checked(d: &CaseDir, have_ffmpeg: bool) -> Vec<(&'static str, Vec<PathBuf>)> {
    if !have_ffmpeg {
        // Media fixtures can't be made: open the document and image tools only.
        let img = |n: &str| jpg(d.path(), n, 640, 480);
        let mut v: Vec<(&'static str, Vec<PathBuf>)> = vec![];
        for id in ["editImage", "annotateImage", "frameImage", "cropImage", "redactImage", "compress", "metadata", "ocr", "removeBg", "upscale"] {
            v.push((id, vec![img(&format!("{id}.jpg"))]));
        }
        v.push(("mergePdf", vec![pdf(d.path(), "m1.pdf", 2), pdf(d.path(), "m2.pdf", 1)]));
        v.push(("organizePdf", vec![pdf(d.path(), "o.pdf", 3)]));
        v.push(("splitPdf", vec![pdf(d.path(), "s.pdf", 3)]));
        v.push(("protect", vec![pdf(d.path(), "pw.pdf", 1)]));
        v.push(("unlock", vec![pdf(d.path(), "ul.pdf", 1)]));
        v.push(("rename", vec![text_file(d.path(), "r1.txt"), text_file(d.path(), "r2.txt")]));
        return v;
    }
    open_cases(d).into_iter().map(|(id, inputs, _)| (id, inputs)).collect()
}

// ---------------------------------------------------------------- AI tools (models download; ORANGE_TEST_AI=1)

pending!(tools, ai_remove_background_rmbg, {
    need_ai!();
    let d = CaseDir::new("ai-bg");
    let out = one(t("removeBg", &[jpg(d.path(), "photo.jpg", 320, 240)], json!({ "format": "png" })));
    image_ok(&out, "png", None);
});

pending!(tools, ai_upscale_2x_photo, {
    need_ai!();
    let d = CaseDir::new("ai-up");
    let out = one(t("upscale", &[png(d.path(), "small.png", 160, 120)], json!({ "model": "photo", "scale": 2 })));
    image_ok(&out, "png", Some((320, 240)));
});

pending!(tools, ai_subtitles_from_speech_whisper_fast, {
    need_ai!();
    need_engines!("ffmpeg", "ffprobe");
    let d = CaseDir::new("ai-subs");
    let Some(speech) = speech_wav(d.path(), "speech.wav", "Hello and welcome to Orange. This is a test of the subtitle tool.") else { return skip("Windows speech synthesis is not available") };
    let out = one(t("subtitles", &[speech], json!({ "model": "fast", "language": "en", "output": "srt" })));
    let s = text_has(&out, &["-->"]).to_lowercase();
    assert!(s.contains("orange") || s.contains("welcome"), "transcript: {s}");
});
